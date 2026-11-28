import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import {
  auditChainHash,
  type AuditChainEntry,
} from '../../../packages/v7/src/adapters/postgres/writer-audit.js'
import type { HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { createToolDefinitions } from '../../../packages/v7/src/adapters/dsh/tools.js'
import { RememberService } from '../../../packages/v7/src/app/remember.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { RecallService } from '../../../packages/v7/src/app/recall.js'
import { auditTenantOf } from '../../../packages/v7/src/domain/audit.js'
import type { Entity } from '../../../packages/v7/src/domain/entity.js'
import { OmbFailure } from '../../../packages/v7/src/domain/errors.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import { createToolRuntime } from '../../../plugin/v7/tool-runtime.js'
import { TEST_DATABASE_URL } from './helpers.js'

/**
 * 审计 actor/source 与越权收紧的真实 PostgreSQL 证据（OMB 7.2.4）。
 *
 * 用例直接驱动**真实工具运行时 + 真实 Store/AttributeWriter**，不使用 mock 写路径：
 * - 工具参数里的 `origin=user` 被覆盖，写入审计只认宿主派生的 actor/source；
 * - 跨项目 update/archive/rollback/replay 被拒绝，数据不变，拒绝事实进 `action='denied'` 审计；
 * - 回滚同时受工具层预检与适配器层（writer-rollback）校验，两层都拒绝跨租户；
 * - 同项目不同 session 仍可共同维护记忆（租户是项目，不是会话）；
 * - 跨项目审计列表不可见，越权拒绝计数可见；
 * - 所有新写入（含拒绝审计/回滚审计）仍串在 7.1.18 的 hash chain 上。
 */

const FIXED_NOW = '2026-11-29T00:00:00.000Z'
const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

const CONTEXTS = new Map<string, {
  sessionId: string
  projectKey: string
  projectIdentity: {
    projectId: string
    workspaceId: string
    source: 'workspace'
    projectRoot: string
    workspaceRoot: string
    legacyProjectKeys: string[]
  }
}>([
  ['session-a', {
    sessionId: 'session-a',
    projectKey: PROJECT_A,
    projectIdentity: {
      projectId: PROJECT_A,
      workspaceId: 'ws-a',
      source: 'workspace',
      projectRoot: 'D:/ws-a',
      workspaceRoot: 'D:/ws-a',
      legacyProjectKeys: ['D:/ws-a-old'],
    },
  }],
  ['session-a2', {
    sessionId: 'session-a2',
    projectKey: PROJECT_A,
    projectIdentity: {
      projectId: PROJECT_A,
      workspaceId: 'ws-a2',
      source: 'workspace',
      projectRoot: 'D:/ws-a2',
      workspaceRoot: 'D:/ws-a2',
      legacyProjectKeys: [],
    },
  }],
  ['session-b', {
    sessionId: 'session-b',
    projectKey: PROJECT_B,
    projectIdentity: {
      projectId: PROJECT_B,
      workspaceId: 'ws-b',
      source: 'workspace',
      projectRoot: 'D:/ws-b',
      workspaceRoot: 'D:/ws-b',
      legacyProjectKeys: [],
    },
  }],
])

function execFor(session: string): unknown {
  return {
    agent: { session: { id: session, header: { cwd: session === 'session-b' ? 'D:/ws-b' : 'D:/ws-a' } } },
    callId: `call-${randomUUID()}`,
  }
}

interface ChainRow {
  id: string
  actor: string
  action: string
  target_ids: string[]
  before: unknown
  after: unknown
  inverse: unknown
  job_id: string | null
  command_id: string | null
  stream_id: string | null
  stream_version: string | null
  event_type: string | null
  revision: string | null
  correlation_id: string | null
  causation_id: string | null
  actor_kind: string | null
  source: string | null
  prev_hash: string | null
  hash: string | null
}

function entryOf(row: ChainRow): AuditChainEntry {
  return {
    actor: row.actor,
    action: row.action,
    targetIds: row.target_ids,
    jobId: row.job_id,
    commandId: row.command_id,
    streamId: row.stream_id,
    streamVersion: row.stream_version === null ? null : Number(row.stream_version),
    eventType: row.event_type,
    revision: row.revision === null ? null : Number(row.revision),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actorKind: row.actor_kind,
    ...(row.before === null ? {} : { before: row.before as AuditChainEntry['before'] }),
    ...(row.after === null ? {} : { after: row.after as AuditChainEntry['after'] }),
    ...(row.inverse === null ? {} : { inverse: row.inverse as AuditChainEntry['inverse'] }),
  }
}

function verifyChain(rows: readonly ChainRow[]): string | undefined {
  let previous: string | null = null
  for (const row of rows) {
    if (row.hash === null) return `missing-hash:${row.id}`
    if (row.prev_hash !== previous) return `prev-hash:${row.id}`
    if (auditChainHash(previous, entryOf(row)) !== row.hash) return `hash:${row.id}`
    previous = row.hash
  }
  return undefined
}

const tools = new Map<string, HostToolDefinition>()

function tool(name: string): HostToolDefinition {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`缺少工具：${name}`)
  return definition
}

async function call(name: string, args: unknown, session: string): Promise<{ ok: boolean; text: string }> {
  return tool(name).execute(args, execFor(session))
}

async function okText(name: string, args: unknown, session: string): Promise<string> {
  const result = await call(name, args, session)
  if (!result.ok) throw new Error(`${name} 应成功，实际：${result.text}`)
  return result.text
}

function entityIdOf(text: string): string {
  const match = /(?:mem|st|ch)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u.exec(text)
  if (match === null) throw new Error(`工具结果里没有实体 id：${text}`)
  return match[0]
}

describe('审计 actor/source 与越权收紧（真实 PostgreSQL + 工具运行时）', () => {
  let store: PostgresStore

  beforeAll(async () => {
    await migrateDatabase(TEST_DATABASE_URL)
    store = new PostgresStore(TEST_DATABASE_URL)
    const runtime = createToolRuntime({
      requireReady: async () => undefined,
      rememberService: new RememberService({ store, clock }),
      updateService: new UpdateService({ store, clock }),
      // recall 与本组安全用例无关；用最小替身避免拉起检索/动态依赖。
      recallService: {
        recall: async () => ({ ok: true as const, value: 'recall-stub' }),
      } as unknown as RecallService,
      store,
      clock,
      status: async () => ({ ok: true as const, value: 'status-stub' }),
      resolveContext: async exec => {
        const session = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
        return session === undefined ? undefined : CONTEXTS.get(session) ?? undefined
      },
    })
    for (const definition of createToolDefinitions(runtime)) tools.set(definition.name, definition)  })

  beforeEach(async () => {
    await truncateAll(TEST_DATABASE_URL)
  })

  afterAll(async () => {
    await truncateAll(TEST_DATABASE_URL).catch(() => {})
    await store.close()
  })

  async function chainRows(): Promise<ChainRow[]> {
    const rows = await store.db.query<ChainRow>(
      `select id, actor, action, target_ids, before, after, inverse, job_id,
              command_id, stream_id, stream_version::text, event_type, revision::text,
              correlation_id, causation_id, actor_kind, source, prev_hash, hash
         from omb.audit_log order by id asc`,
    )
    return rows.rows.map(row => ({ ...row, id: String(row.id) }))
  }

  async function auditRowsWhere(action: string): Promise<ChainRow[]> {
    return (await chainRows()).filter(row => row.action === action)
  }

  async function entityOf(id: string): Promise<Entity | undefined> {
    return store.get(id, { includeArchived: true })
  }

  async function rememberProject(session: string, title: string): Promise<string> {
    const text = await okText('omb_remember', {
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title, body: `正文-${title}` },
    }, session)
    return entityIdOf(text)
  }

  it('给定工具参数伪造 origin 当创建记忆则 actor/source 由宿主派生、origin 被覆盖并记 denied 审计', async () => {
    const text = await okText('omb_remember', {
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      origin: 'user',
      attrs: { title: '伪造来源尝试', body: '工具参数不能冒充用户' },
    }, 'session-a')
    const id = entityIdOf(text)

    const entity = await entityOf(id)
    // 实体内容来源仍是 model（默认），不能被参数里的 user 改写。
    expect(entity?.origin).toBe('model')

    const writes = await auditRowsWhere('write')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      actor: 'assistant:session-a',
      actor_kind: 'assistant',
      source: 'tool:omb_remember',
    })
    const denied = await auditRowsWhere('denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({
      actor: 'assistant:session-a',
      actor_kind: 'assistant',
      source: 'tool:omb_remember',
    })
    expect(denied[0]?.after).toMatchObject({
      operation: 'remember',
      reason: 'forged-actor',
      claimed: 'user',
      tenantProjectKey: PROJECT_A,
    })
    expect(verifyChain(await chainRows())).toBeUndefined()
  })

  it('给定跨项目会话当 update/archive 他人项目实体则 forbidden 且目标不变，同项目另一会话仍可维护', async () => {
    const id = await rememberProject('session-a', '跨租户目标')

    // 跨项目 update：拒绝且不 bump revision。
    const deniedUpdate = await call('omb_update', {
      id,
      expectedRevision: 1,
      attrs: { title: 'B 越权覆盖' },
    }, 'session-b')
    expect(deniedUpdate.ok).toBe(false)
    expect(deniedUpdate.text).toContain('forbidden')
    expect(deniedUpdate.text).toContain('越权操作被拒绝')
    expect((await entityOf(id))?.revision).toBe(1)

    // 跨项目 archive：拒绝且不写 archived_at。
    const deniedArchive = await call('omb_admin', { action: 'archive', targetId: id, reason: '越权归档' }, 'session-b')
    expect(deniedArchive.ok).toBe(false)
    expect(deniedArchive.text).toContain('forbidden')
    expect((await entityOf(id))?.archivedAt).toBeUndefined()

    const denied = await auditRowsWhere('denied')
    expect(denied.length).toBeGreaterThanOrEqual(2)
    expect(denied.every(row => row.target_ids.includes(id))).toBe(true)
    expect(denied.map(row => row.after).map(after => (after as { operation?: string }).operation))
      .toEqual(expect.arrayContaining(['update', 'archive']))

    // 同一项目、不同 session：租户边界是 projectId，不是 session；共享知识仍可维护。
    const updated = await call('omb_update', {
      id,
      expectedRevision: 1,
      attrs: { title: '同项目另一会话更新' },
    }, 'session-a2')
    expect(updated.ok, updated.text).toBe(true)
    expect((await entityOf(id))?.revision).toBe(2)
    expect(verifyChain(await chainRows())).toBeUndefined()
  })

  it('给定跨项目会话当回滚他人项目审计则工具层与适配器层都拒绝；同项目回滚成功并写派生 actor/source', async () => {
    const id = await rememberProject('session-a', '回滚目标一')
    await okText('omb_update', {
      id,
      expectedRevision: 1,
      attrs: { title: '回滚目标二' },
    }, 'session-a')
    const patch = await store.db.query<{ id: string }>(
      "select id::text as id from omb.audit_log where action = 'patch' and stream_id = $1 order by id desc limit 1",
      [id],
    )
    const patchAuditId = Number(patch.rows[0]?.id)
    expect(Number.isSafeInteger(patchAuditId)).toBe(true)

    // 工具层：跨项目回滚被拒绝，原审计未标记 rolled_back_at，标题保持新值。
    const denied = await call('omb_admin', { action: 'rollback', auditId: patchAuditId }, 'session-b')
    expect(denied.ok).toBe(false)
    expect(denied.text).toContain('forbidden')
    const untouched = await store.db.query<{ rolled_back_at: Date | null }>(
      'select rolled_back_at from omb.audit_log where id = $1',
      [patchAuditId],
    )
    expect(untouched.rows[0]?.rolled_back_at).toBeNull()
    expect((await entityOf(id))?.attributes.find(attribute => attribute.name === 'title'))
      .toMatchObject({ value: { kind: 'static', value: '回滚目标二' } })

    // 适配器层：即使绕过工具，只要提供了 tenant，writer-rollback 也必须拒绝。
    const tenantB = auditTenantOf({ projectKey: PROJECT_B })
    const adapterDenied = await store.rollback(patchAuditId, 'assistant:session-b', {
      source: 'tool:omb_admin',
      ...(tenantB === undefined ? {} : { tenant: tenantB }),
    }).catch((error: unknown) => error)
    expect(adapterDenied).toBeInstanceOf(OmbFailure)
    expect((adapterDenied as OmbFailure).error.code).toBe('forbidden')
    expect((adapterDenied as OmbFailure).error.details).toMatchObject({ reason: 'cross-project' })

    // 同项目回滚：恢复旧属性，回滚审计记录派生 actor/source/kind。
    const rolled = await okText('omb_admin', { action: 'rollback', auditId: patchAuditId }, 'session-a2')
    expect(rolled).toContain('已回滚审计')
    expect((await entityOf(id))?.attributes.find(attribute => attribute.name === 'title'))
      .toMatchObject({ value: { kind: 'static', value: '回滚目标一' } })
    const rollbackRows = await auditRowsWhere('rollback')
    expect(rollbackRows).toHaveLength(1)
    expect(rollbackRows[0]).toMatchObject({
      actor: 'assistant:session-a2',
      actor_kind: 'assistant',
      source: 'tool:omb_admin',
    })
    // 同一条审计不能回滚两次：保留 7.1.18 的 rolled_back_at/CAS 语义。
    const again = await call('omb_admin', { action: 'rollback', auditId: patchAuditId }, 'session-a')
    expect(again.ok).toBe(false)
    expect(again.text).toContain('conflict')
    expect(again.text).toContain('已回滚')
    expect(verifyChain(await chainRows())).toBeUndefined()
  })

  it('给定跨项目审计当 admin audit 则列表不可见且拒绝计数只看本租户', async () => {
    await rememberProject('session-a', 'A 项目可见记忆')
    await rememberProject('session-b', 'B 项目不可见记忆')
    const aTarget = await rememberProject('session-a', 'A 项目被探测目标')
    const denied = await call('omb_admin', { action: 'archive', targetId: aTarget, reason: '越权探测' }, 'session-b')
    expect(denied.ok).toBe(false)

    const listA = await okText('omb_admin', { action: 'audit', limit: 50 }, 'session-a')
    const listB = await okText('omb_admin', { action: 'audit', limit: 50 }, 'session-b')
    expect(listA).toContain('by=assistant:session-a')
    expect(listA).not.toContain('by=assistant:session-b')
    expect(listA).toContain('越权拒绝累计 0 条')
    // B 的拒绝记录里 target 在 A 项目：工具输出只给拒绝事实，不带外项目 target id。
    expect(listB).toContain('denied')
    expect(listB).toContain('越权拒绝累计 1 条')
    expect(listB).not.toContain(aTarget)
    expect(verifyChain(await chainRows())).toBeUndefined()
  })

  it('给定链接/历史/重放当跨项目调用则拒绝；正常项目内路径保留且审计来源正确', async () => {
    const left = await rememberProject('session-a', '链接起点')
    const right = await rememberProject('session-a', '链接终点')

    const linked = await okText('omb_link', { from: left, to: right, relation: 'related_to' }, 'session-a')
    expect(linked).toContain('已建立链接')
    const linkAudits = await auditRowsWhere('link')
    expect(linkAudits[0]).toMatchObject({
      actor: 'assistant:session-a',
      actor_kind: 'assistant',
      source: 'tool:omb_link',
    })

    expect((await call('omb_history', { id: left }, 'session-b')).ok).toBe(false)
    expect((await call('omb_link', { from: left, to: right, relation: 'related_to' }, 'session-b')).ok).toBe(false)

    // 构造一条跨项目 dead outbox：payload 里的实体属于 B 项目，A 会话不得重放。
    const foreign = await rememberProject('session-b', 'B 项目重放目标')
    const foreignAuditId = await store.recordAudit({
      actor: 'assistant:session-b',
      actorKind: 'assistant',
      source: 'tool:omb_remember',
      action: 'write',
      targetIds: [foreign],
    })
    const outbox = await store.db.query<{ id: string }>(
      `insert into omb.outbox (event_id, topic, payload, status, attempts, last_error)
       values ($1, 'EntityCreated', $2::jsonb, 'dead', 1, 'probe') returning id::text as id`,
      [foreignAuditId, JSON.stringify({ entityId: foreign })],
    )
    const outboxId = Number(outbox.rows[0]?.id)
    const replay = await call('omb_admin', { action: 'replay', outboxId }, 'session-a')
    expect(replay.ok).toBe(false)
    expect(replay.text).toContain('forbidden')
    const stillDead = await store.db.query<{ status: string }>('select status from omb.outbox where id = $1', [outboxId])
    expect(stillDead.rows[0]?.status).toBe('dead')

    // 同项目重放仍可用：先确认 payload 实体可见，再真正重放。
    const own = await rememberProject('session-a', 'A 项目重放目标')
    const ownAuditId = await store.recordAudit({
      actor: 'assistant:session-a',
      actorKind: 'assistant',
      source: 'tool:omb_remember',
      action: 'write',
      targetIds: [own],
    })
    const ownOutbox = await store.db.query<{ id: string }>(
      `insert into omb.outbox (event_id, topic, payload, status, attempts, last_error)
       values ($1, 'EntityCreated', $2::jsonb, 'dead', 1, 'probe') returning id::text as id`,
      [ownAuditId, JSON.stringify({ entityId: own })],
    )
    // replay 成功前所有业务写/拒绝审计都仍在同一条 hash chain 上。
    expect(verifyChain(await chainRows())).toBeUndefined()
    const replayed = await call('omb_admin', { action: 'replay', outboxId: Number(ownOutbox.rows[0]?.id) }, 'session-a2')
    expect(replayed.ok, replayed.text).toBe(true)
    expect(replayed.text).toContain('已重放 1 行 dead')
    // 注意：7.1.18 的 outbox-replay 审计由 outbox.ts 直接 INSERT，本来就不在 hash chain 上；
    // 本任务不改 outbox 文件，成功 replay 之后不再做整链断言（拒绝路径的审计是链式的）。
  })
})
