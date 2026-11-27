import { readFile } from 'node:fs/promises'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { DynamicService } from '../../../packages/v7/src/app/dynamic.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import {
  handleAttrAlias,
  handleCluePromote,
  handleConflict,
  handleDedupe,
  handleExtract,
  handleForget,
  handleLinkSuggest,
  handleReferenceRot,
  handleRefresh,
} from '../../../packages/v7/src/jobs/consolidate.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'

describe('background consolidation', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  async function deps(): Promise<{ db: ReturnType<typeof store>; deps: ConsolidationDeps }> {
    const db = store()
    return {
      db,
      deps: {
        store: db,
        queries: new PostgresMaintenance(db.db),
        updateService: new UpdateService({ store: db }),
        clock: { now: () => new Date(), iso: () => new Date().toISOString() },
      },
    }
  }

  async function write(db: ReturnType<typeof store>, input: WriteEntityInput) {
    return db.write(normalized(input), derived(input))
  }

  it('后台 refresh 用实体 projectKey 解析文件动态值', async () => {
    const { db, deps: context } = await deps()
    const entity = await write(db, {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: PROJECT },
      attrs: {
        title: '文件动态值',
        note: { $dynamic: { kind: 'file' as const, path: 'docs/v7/REQUIREMENTS.md', extract: { kind: 'text' as const } } },      },
    })
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: { now: () => new Date(), iso: () => new Date().toISOString() },
      readFile: path => readFile(path, 'utf8'),
    })
    const result = await handleRefresh({ ...context, dynamic })
    expect(result.refreshed).toBeGreaterThan(0)
    const loaded = await db.get(entity.entity.id)
    const note = loaded === undefined ? undefined : attributeValue(loaded, 'note')
    expect(typeof note).toBe('string')
    expect(note).toContain('v7 需求原文')
    await db.close()
  })

  it('从 goal 事件抽取状态机并标记 artifact 已处理', async () => {
    const { db, deps: context } = await deps()
    await db.recordArtifact({
      id: 'art_goal_1',
      kind: 'goal/change',
      content: JSON.stringify({ cwd: PROJECT, goal: { objective: '完成 v7 存储重构' } }),
      metadata: { cwd: PROJECT },
    })
    const result = await handleExtract(context)
    expect(result.written).toBe(1)
    const entities = await db.db.query<{ kind: string; title: string }>('select kind, title from omb.entity_view')
    expect(entities.rows[0]?.kind).toBe('state')
    expect(entities.rows[0]?.title).toContain('完成 v7 存储重构')
    const processed = await db.db.query<{ processed_at: string | null }>('select processed_at from omb.artifact where id = $1', ['art_goal_1'])
    expect(processed.rows[0]?.processed_at).toBeTruthy()
    await db.close()
  })

  it('抽取优先使用事件 metadata 的 git-root projectKey，而不是 payload 子目录 cwd', async () => {
    const { db, deps: context } = await deps()
    await db.recordArtifact({
      id: 'art_goal_subdir',
      kind: 'goal/change',
      content: JSON.stringify({ cwd: `${PROJECT}\\packages`, goal: { id: 'goal-subdir', objective: '子目录目标' } }),
      metadata: { cwd: `${PROJECT}\\packages`, projectKey: PROJECT },
    })
    await handleExtract(context)
    const view = await db.db.query<{ project_key: string }>(
      `select project_key from omb.entity_view where kind = 'state' and title like '%子目录目标%'`,
    )
    expect(view.rows[0]?.project_key).toBe(PROJECT)
    await db.close()
  })

  it('同一 goalId 的后续 artifact 收敛到同一个状态机', async () => {
    const { db, deps: context } = await deps()
    for (const [id, objective] of [['art_goal_a', '目标 A'], ['art_goal_b', '目标 B']] as const) {
      await db.recordArtifact({
        id, kind: 'goal/change',
        content: JSON.stringify({ cwd: PROJECT, goal: { id: 'goal-1', objective } }),
        metadata: { cwd: PROJECT },
      })
      await handleExtract(context)
    }
    const rows = await db.db.query<{ count: string; title: string }>(
      `select count(*)::text as count, max(v.title) as title
       from omb.entity_view v
       join omb.attribute a on a.entity_id = v.entity_id and a.name = 'goalId'
       where v.kind = 'state' and v.archived_at is null`,
    )
    expect(rows.rows[0]?.count).toBe('1')
    expect(rows.rows[0]?.title).toContain('目标 B')
    await db.close()
  })

  it('extract 写入后对相似实体补 related_to 链接', async () => {
    const { db, deps: context } = await deps()
    await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'project', projectKey: PROJECT },
      attrs: { title: 'v7 存储重构', body: 'PostgreSQL 单库属性化重构' },
    })
    await db.recordArtifact({
      id: 'art_report_link', kind: 'subagent/end',
      content: JSON.stringify({ cwd: PROJECT, lastAssistantMessage: 'v7 存储重构 已完成存储层' }),
      metadata: { cwd: PROJECT },
    })
    await handleExtract(context)
    const links = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.link where relation = 'related_to' and source = 'job' and archived_at is null`,
    )
    expect(Number(links.rows[0]?.count ?? 0)).toBeGreaterThan(0)
    await db.close()
  })

  it('抽取候选与至少两个相似记忆自动成组，且重复抽取不重复建组', async () => {
    const { db, deps: context } = await deps()
    const first = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'project', projectKey: PROJECT },
      attrs: { title: 'v7 存储重构进展', body: '已完成存储层与迁移脚本' },
    })
    const second = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'project', projectKey: PROJECT },
      attrs: { title: 'v7 存储重构进展记录', body: '已完成存储层与迁移脚本' },
    })
    await db.recordArtifact({
      id: 'art_report_group', kind: 'subagent/end',
      content: JSON.stringify({ cwd: PROJECT, lastAssistantMessage: 'v7 存储重构进展：已完成存储层与迁移脚本' }),
      metadata: { cwd: PROJECT },
    })

    const firstRun = await handleExtract(context)
    expect(firstRun.written).toBe(1)
    expect(firstRun.grouped).toBe(1)
    const chains = await db.db.query<{ entity_id: string; group_value: string[]; title: string | null; origin: string }>(
      `select v.entity_id, a.value as group_value, v.title, e.origin
       from omb.entity e
       join omb.entity_view v on v.entity_id = e.id
       join omb.attribute a on a.entity_id = e.id and a.name = 'group'
       where e.kind = 'chain' and v.archived_at is null`,
    )
    expect(chains.rows).toHaveLength(1)
    const group = chains.rows[0]?.group_value ?? []
    expect(group).toHaveLength(3)
    expect(group).toEqual(expect.arrayContaining([first.entity.id, second.entity.id]))
    expect(chains.rows[0]?.origin).toBe('job')
    expect(chains.rows[0]?.title).toMatch(/^自动分组：/)
    expect((chains.rows[0]?.title ?? '').length).toBeLessThanOrEqual(120)
    const audit = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.audit_log
       where action = 'write' and target_ids @> array[$1]::text[]`,
      [chains.rows[0]?.entity_id],
    )
    expect(Number(audit.rows[0]?.count ?? 0)).toBe(1)

    const secondRun = await handleExtract(context)
    expect(secondRun.grouped).toBe(0)
    const chainCount = await db.db.query<{ count: string }>("select count(*)::text as count from omb.entity where kind = 'chain'")
    expect(chainCount.rows[0]?.count).toBe('1')
    await db.close()
  })

  it('状态机候选更新后与新增相似状态成组，且之后不重复建组', async () => {
    const { db, deps: context } = await deps()
    const artifact = (id: string) => ({
      id, kind: 'goal/change',
      content: JSON.stringify({ cwd: PROJECT, goal: { id: 'goal-auto-group', objective: '完成 v7 存储重构' } }),
      metadata: { cwd: PROJECT },
    })
    await db.recordArtifact(artifact('art_goal_group_a'))
    const first = await handleExtract(context)
    expect(first.written).toBe(1)
    // 只有一个候选状态机，没有相似成员，不建组。
    expect(first.grouped).toBe(0)

    for (const suffix of ['甲', '乙']) {
      await write(db, {
        kind: 'state', scope: { kind: 'project', projectKey: PROJECT },
        title: '目标：完成 v7 存储重构', status: 'in_progress', time: '2026-11-20T00:00:00.000Z',
        attrs: { body: `完成 v7 存储重构（${suffix}）` },
      })
    }
    await db.recordArtifact(artifact('art_goal_group_b'))
    const second = await handleExtract(context)
    expect(second.written).toBe(1)
    expect(second.grouped).toBe(1)
    const state = await db.db.query<{ revision: string }>(
      `select e.revision from omb.entity e
       join omb.attribute a on a.entity_id = e.id and a.name = 'goalId'
       where e.kind = 'state' and a.value = $1::jsonb`,
      [JSON.stringify('goal-auto-group')],
    )
    expect(Number(state.rows[0]?.revision)).toBe(2)
    const chains = await db.db.query<{ group_value: string[] }>(
      `select a.value as group_value from omb.entity e
       join omb.attribute a on a.entity_id = e.id
       where e.kind = 'chain' and a.name = 'group'`,
    )
    expect(chains.rows).toHaveLength(1)
    expect(chains.rows[0]?.group_value).toHaveLength(3)

    await db.recordArtifact(artifact('art_goal_group_c'))
    const third = await handleExtract(context)
    expect(third.written).toBe(1)
    expect(third.grouped).toBe(0)
    const chainCount = await db.db.query<{ count: string }>("select count(*)::text as count from omb.entity where kind = 'chain'")
    expect(chainCount.rows[0]?.count).toBe('1')
    await db.close()
  })

  it('相似记忆合并：保留 canonical、归档 duplicate、写 merged_from', async () => {
    const { db, deps: context } = await deps()
    const first = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'Postgres 配置', body: '连接串与迁移说明' },
    })
    const second = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'Postgres 配置', body: '连接串与迁移说明' },
    })
    const result = await handleDedupe(context)
    expect(result.merged).toBeGreaterThan(0)
    const active = await db.db.query<{ entity_id: string }>('select entity_id from omb.entity_view where archived_at is null and kind = $1', ['memory'])
    expect(active.rows).toHaveLength(1)
    const links = await db.db.query<{ relation: string }>('select relation from omb.link')
    expect(links.rows.map(row => row.relation)).toEqual(expect.arrayContaining(['merged_from', 'merged_into']))
    expect([first.entity.id, second.entity.id]).toContain(active.rows[0]?.entity_id)
    await db.close()
  })

  it('冲突检测写双向 possible_conflict，且手工取消后不再标记', async () => {
    const { db, deps: context } = await deps()
    const a = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '部署端口', body: '服务端口是 8080', port: '8080' },
    })
    const b = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '部署端口', body: '服务端口是 9090', port: '9090' },
    })
    const first = await handleConflict(context)
    expect(first.linked).toBeGreaterThan(0)
    const link = await db.db.query<{ id: string }>('select id from omb.link where relation = $1 limit 1', ['possible_conflict'])
    await db.unlink(link.rows[0]?.id as string, 'test')
    const second = await handleConflict(context)
    expect(second.linked).toBe(0)
    expect([a.entity.id, b.entity.id]).toHaveLength(2)
    await db.close()
  })

  it('线索满足证据阈值后转为事实', async () => {
    const { db, deps: context } = await deps()
    const single = await write(db, {
      kind: 'memory', category: 'clue', scope: { kind: 'global' },
      attrs: { title: '单会话线索', body: '同一会话重复三次', evidence: ['session:a', 'session:a', 'session:a'] },
    })
    expect((await handleCluePromote(context)).promoted).toBe(0)
    expect(attributeValue((await db.get(single.entity.id))!, 'category')).toBe('clue')

    const clue = await write(db, {
      kind: 'memory', category: 'clue', scope: { kind: 'global' },
      attrs: { title: '候选结论', body: '可能是这样', evidence: ['session:a', 'session:b'] },
    })
    const result = await handleCluePromote(context)
    expect(result.promoted).toBe(1)
    const loaded = await db.get(clue.entity.id)
    expect(attributeValue(loaded!, 'category')).toBe('fact')
    await db.close()
  })

  it('遗忘任务归档低显著度条目', async () => {
    const { db, deps: context } = await deps()
    const old = await write(db, {
      kind: 'memory', category: 'event', scope: { kind: 'global' },
      attrs: { title: '很久以前的日志', body: '无关紧要' },
    })
    await db.db.query("update omb.entity set updated_at = now() - interval '365 days' where id = $1", [old.entity.id])
    await db.db.query("update omb.entity_view set updated_at = now() - interval '365 days', confidence = 0 where entity_id = $1", [old.entity.id])
    const state = await write(db, {
      kind: 'state', scope: { kind: 'global' }, title: '进行中的状态', status: 'in_progress',
      time: '2026-01-01T00:00:00.000Z', attrs: { body: '不能被遗忘任务自动归档' },
    })
    const chain = await write(db, {
      kind: 'chain', scope: { kind: 'global' }, title: '组', group: [old.entity.id],
    })
    for (const id of [state.entity.id, chain.entity.id]) {
      await db.db.query("update omb.entity set updated_at = now() - interval '365 days' where id = $1", [id])
      await db.db.query("update omb.entity_view set updated_at = now() - interval '365 days', confidence = 0 where entity_id = $1", [id])
    }
    const result = await handleForget(context)
    expect(result.archived).toBe(1)
    expect(await db.get(old.entity.id)).toBeUndefined()
    expect(await db.get(state.entity.id)).toBeDefined()
    expect(await db.get(chain.entity.id)).toBeDefined()
    await db.close()
  })

  it('归档目标的引用不被标记为腐化；只有属性不存在才标记', async () => {
    const { db, deps: context } = await deps()
    const target = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '目标' },
    })
    const source = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '引用者', mirror: { $dynamic: { kind: 'ref', entityId: target.entity.id, attr: 'title' } } },
    })
    await db.archive(target.entity.id, 'test', 'test')
    expect((await handleReferenceRot(context)).marked).toBe(0)
    const loaded = await db.get(source.entity.id, { includeArchived: true })
    const mirror = loaded?.attributes.find(item => item.name === 'mirror')
    expect(mirror?.value.kind).toBe('dynamic')
    if (mirror?.value.kind === 'dynamic') expect(mirror.value.lastError).toBeUndefined()

    const missing = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '缺属性引用', mirror: { $dynamic: { kind: 'ref', entityId: target.entity.id, attr: 'missing' } } },
    })
    const result = await handleReferenceRot(context)
    expect(result.marked).toBeGreaterThan(0)
    const broken = await db.get(missing.entity.id, { includeArchived: true })
    const brokenMirror = broken?.attributes.find(item => item.name === 'mirror')
    expect(brokenMirror?.value.kind).toBe('dynamic')
    if (brokenMirror?.value.kind === 'dynamic') expect(brokenMirror.value.lastError).toContain('reference-rot')
    await db.close()
  })

  it('共同召回连通子图自动成组，且重复运行不重复建组', async () => {
    const { db, deps: context } = await deps()
    const ids: string[] = []
    for (const title of ['共同一', '共同二', '共同三']) {
      const entity = await write(db, {
        kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title },
      })
      ids.push(entity.entity.id)
    }
    for (const trace of ['trc_co_1', 'trc_co_2']) {
      await db.recordRecall(ids.map((entityId, index) => ({
        traceId: trace, sessionId: 'session-co', entityId, channel: 'fulltext', rank: index + 1, injected: true,
      })))
      for (const id of ids) await db.markAdopted(trace, id, 'text')
    }
    const first = await handleLinkSuggest(context)
    expect(first.linked).toBeGreaterThan(0)
    expect(first.grouped).toBe(1)
    const chain = await db.db.query<{ group_value: string[] }>(
      `select a.value as group_value from omb.entity e join omb.attribute a on a.entity_id = e.id
       where e.kind = 'chain' and a.name = 'group'`,
    )
    expect(chain.rows[0]?.group_value).toHaveLength(3)
    expect((await handleLinkSuggest(context)).grouped).toBe(0)
    await db.close()
  })

  it('共同召回包含思维链时不把链写入成员组或链间链接', async () => {
    const { db, deps: context } = await deps()
    const ids: string[] = []
    for (const title of ['链外记忆一', '链外记忆二']) {
      const entity = await write(db, {
        kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title },
      })
      ids.push(entity.entity.id)
    }
    const chain = await write(db, {
      kind: 'chain', scope: { kind: 'global' }, title: '共同召回容器', group: ids,
    })
    const recalled = [chain.entity.id, ...ids]
    for (const trace of ['trc_chain_co_1', 'trc_chain_co_2']) {
      await db.recordRecall(recalled.map((entityId, index) => ({
        traceId: trace, sessionId: 'session-chain-co', entityId, channel: 'fulltext', rank: index + 1, injected: true,
      })))
      for (const id of recalled) await db.markAdopted(trace, id, 'text')
    }

    const result = await handleLinkSuggest(context)
    expect(result.grouped).toBe(0)
    const chainMembers = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.chain_member cm
       join omb.entity e on e.id = cm.member_id where e.kind = 'chain'`,
    )
    expect(Number(chainMembers.rows[0]?.count)).toBe(0)
    const chainLinks = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.link
       where from_id = $1 or to_id = $1`,
      [chain.entity.id],
    )
    expect(Number(chainLinks.rows[0]?.count)).toBe(0)
    await db.close()
  })

  it('statusRule 动态值刷新后自动推进状态并按新状态归档', async () => {
    const { db, deps: base } = await deps()
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: base.clock,
    })
    const context: ConsolidationDeps = { ...base, dynamic }
    const state = await write(db, {
      kind: 'state', scope: { kind: 'global' }, title: '动态状态', status: 'in_progress',
      time: '2026-11-22T00:00:00.000Z',
      attrs: {
        body: '由 statusRule 自动推进',
        statusRule: { $dynamic: { kind: 'regex', source: 'completed', input: { kind: 'literal', value: 'completed' } } },
      },
    })
    const result = await handleRefresh(context)
    expect(result.statusUpdated).toBe(1)
    const loaded = await db.get(state.entity.id, { includeArchived: true })
    expect(attributeValue(loaded!, 'status')).toBe('completed')
    expect(loaded?.archivedAt).toBeDefined()
    await db.close()
  })

  it('attr-alias 审计可回滚到合并前的属性行', async () => {
    const { db, deps: context } = await deps()
    const entity = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '可回滚归并', topic: 'alpha', topics: 'beta' },
    })
    await context.queries.renameAttribute('topic', 'topics')
    const audit = await db.db.query<{ id: string }>(
      "select id::text from omb.audit_log where action = 'attr-alias' order by id desc limit 1",
    )
    await db.rollback(Number(audit.rows[0]?.id), 'test')
    const loaded = await db.get(entity.entity.id)
    expect(attributeValue(loaded!, 'topic')).toBe('alpha')
    expect(attributeValue(loaded!, 'topics')).toBe('beta')
    await db.close()
  })

  it('必填属性名不能被 attr-alias 归并', async () => {
    const db = store()
    const entity = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '必填属性保护', topic: 'alpha' },
    })
    await expect(new PostgresMaintenance(db.db).renameAttribute('title', 'titel')).resolves.toEqual([])
    const names = await db.db.query<{ name: string }>(
      'select name from omb.attribute where entity_id = $1 order by name',
      [entity.entity.id],
    )
    expect(names.rows.map(row => row.name)).toContain('title')
    expect(names.rows.map(row => row.name)).not.toContain('titel')
    await db.close()
  })

  it('属性名归并后重建视图', async () => {
    const { db, deps: context } = await deps()
    const entity = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '属性归并', topic: 'alpha' },
    })
    const other = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '属性归并二', topics: 'beta' },
    })
    const result = await handleAttrAlias(context)
    expect(result.renamed).toBeGreaterThan(0)
    const view = await db.db.query<{ attrs: Record<string, unknown> }>('select attrs from omb.entity_view where entity_id = $1', [entity.entity.id])
    expect(view.rows[0]?.attrs).toHaveProperty('topics')
    const audit = await db.db.query<{ count: string }>(
      "select count(*)::text as count from omb.audit_log where action = 'attr-alias'",
    )
    expect(Number(audit.rows[0]?.count ?? 0)).toBeGreaterThan(0)
    expect([entity.entity.id, other.entity.id]).toHaveLength(2)
    await db.close()
  })
})
