/**
 * 稳定项目身份的运行时回归（真实 PostgreSQL）：
 * 旧 `scope.projectKey`（路径）与新的稳定 `projectId` 必须落在同一个作用域里。
 *
 * 这里验证三件真实消费者：
 * 1. `omb.project_identity.legacy_keys` 让旧行被新 projectId 命中（检索/看板读）；
 * 2. `STATE_DERIVE_SQL` 的写模型回退同样按别名匹配（投影未追上时不丢数据）；
 * 3. `projectRootOf` 给后台动态文件属性提供 path-guard 根——projectId 本身不是路径。
 */
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBoardReader } from '../../../packages/v7/src/adapters/postgres/projection.js'
import { DynamicService } from '../../../packages/v7/src/app/dynamic.js'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import type { ProjectIdentity } from '../../../packages/v7/src/domain/project-identity.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
/** 迁移前的 projectKey：git root 路径（旧解析器写进 scope 的就是它）。 */
const LEGACY_PROJECT_KEY = 'D:/legacy/omb-workspace'
const PROJECT_ID = 'git-remote:example.invalid/team/aliased-project'
const DYNAMIC_PROJECT_ID = 'git-remote:example.invalid/team/dynamic-project'
const UNREGISTERED_PROJECT_ID = 'git-remote:example.invalid/team/unregistered'

function identityOf(overrides: Partial<ProjectIdentity> & Pick<ProjectIdentity, 'projectId' | 'workspaceId'>): ProjectIdentity {
  return {
    source: 'git-remote',
    projectRoot: REPO_ROOT,
    workspaceRoot: REPO_ROOT,
    legacyProjectKeys: [],
    ...(overrides.projectId.startsWith('git-remote:') ? { repositoryId: overrides.projectId } : {}),
    ...overrides,
  }
}

async function writeEntity(db: ReturnType<typeof store>, input: WriteEntityInput): Promise<string> {
  const result = await db.write(normalized(input), derived(input))
  return result.entity.id
}

describe('项目身份注册表与旧 projectKey 兼容匹配（真实 PostgreSQL）', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await resetDatabase()
  })

  it('给定旧 projectKey 的记忆当登记身份后用新 projectId 检索则命中', async () => {
    const db = store()
    const id = await writeEntity(db, {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: LEGACY_PROJECT_KEY },
      attrs: { title: '别名迁移探针', body: '旧 projectKey 写下的记忆' },
    })
    const spec = { query: '别名迁移探针', tokens: tokenize('别名迁移探针'), limit: 10 }

    const before = await db.fulltext({ ...spec, scope: 'project', projectKey: PROJECT_ID })
    expect(before.map(hit => hit.entityId)).not.toContain(id)

    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:aaaaaaaaaaaaaaaa',
      legacyProjectKeys: [LEGACY_PROJECT_KEY],
    }))

    const after = await db.fulltext({ ...spec, scope: 'project', projectKey: PROJECT_ID })
    expect(after.map(hit => hit.entityId)).toContain(id)
    await db.close()
  })

  it('给定同一工作区登记两次当旧键不同则 legacy_keys 取并集且只保留一行', async () => {
    const db = store()
    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:uniontest',
      legacyProjectKeys: ['D:/old/a'],
    }))
    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:uniontest',
      branchId: 'next-branch',
      legacyProjectKeys: ['D:/old/b'],
    }))

    const rows = await db.db.query<{ branch_id: string | null; legacy_keys: string[] }>(
      `select branch_id, legacy_keys from omb.project_identity where workspace_id = $1`,
      ['workspace:uniontest'],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.legacy_keys).toEqual(['D:/old/a', 'D:/old/b'])
    expect(rows.rows[0]?.branch_id).toBe('next-branch')
    await db.close()
  })

  it('给定同一项目两个工作区当取路径锚点则返回最近登记的工作区根', async () => {
    const db = store()
    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:first',
      projectRoot: 'D:/first-workspace',
    }))
    // 让“最近”与插入顺序无关：把第一条固定成更早的时间。
    await db.db.query(
      `update omb.project_identity set last_seen_at = now() - interval '1 hour' where workspace_id = $1`,
      ['workspace:first'],
    )
    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:second',
      projectRoot: 'D:/second-workspace',
    }))

    expect(await db.projectRootOf(PROJECT_ID)).toBe('D:/second-workspace')
    await db.close()
  })

  it('给定旧 projectKey 的状态机当用新 projectId 读看板则读模型与写模型回退都命中', async () => {
    const db = store()
    const id = await writeEntity(db, {
      kind: 'state',
      scope: { kind: 'project', projectKey: LEGACY_PROJECT_KEY },
      title: '别名迁移中的状态',
      status: 'blocked',
      time: '2026-11-29T00:00:00.000Z',
    })
    // 模拟迁移前的投影结果：读模型行仍带旧 projectKey。
    await db.db.query(
      `insert into omb.state_board (entity_id, project_key, title, status, event_time, revision, updated_at)
       values ($1,$2,$3,$4,$5,$6,now())`,
      [id, LEGACY_PROJECT_KEY, '别名迁移中的状态', 'blocked', '2026-11-29T00:00:00.000Z', 1],
    )
    const boards = createBoardReader(db.db)
    const query = { kind: 'state' as const, scope: { kind: 'project' as const, projectKey: PROJECT_ID }, limit: 10 }

    expect((await boards.readBoard(query)).map(item => item.entityId)).not.toContain(id)
    expect((await boards.deriveFromWriteModel(query)).map(item => item.entityId)).not.toContain(id)

    await db.recordProjectIdentity(identityOf({
      projectId: PROJECT_ID,
      workspaceId: 'workspace:bbbbbbbbbbbbbbbb',
      legacyProjectKeys: [LEGACY_PROJECT_KEY],
    }))

    expect((await boards.readBoard(query)).map(item => item.entityId)).toContain(id)
    expect((await boards.deriveFromWriteModel(query)).map(item => item.entityId)).toContain(id)
    // 旧键本身仍可读（迁移前的调用方/测试不受影响）。
    expect((await boards.readBoard({ ...query, scope: { kind: 'project', projectKey: LEGACY_PROJECT_KEY } }))
      .map(item => item.entityId)).toContain(id)
    await db.close()
  })

  it('给定注册表锚点当后台刷新文件动态值则用工作区路径而不是 projectId 作 path-guard 根', async () => {
    const db = store()
    const id = await writeEntity(db, {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: DYNAMIC_PROJECT_ID },
      attrs: {
        title: '文件动态值',
        note: {
          $dynamic: {
            kind: 'file',
            path: 'docs/v7/REQUIREMENTS.md',
            extract: { kind: 'text' },
          },
        },
      },
    })
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: { now: () => new Date(), iso: () => new Date().toISOString() },
      readFile: path => readFile(path, 'utf8'),
    })
    const root = await realpath(REPO_ROOT)
    await db.recordProjectIdentity(identityOf({
      projectId: DYNAMIC_PROJECT_ID,
      workspaceId: 'workspace:cccccccccccccccc',
      projectRoot: root,
      workspaceRoot: root,
    }))

    const refreshed = await dynamic.refreshById(id)

    const note = refreshed === undefined ? undefined : attributeValue(refreshed, 'note')
    expect(typeof note).toBe('string')
    expect(note).toContain('v7 需求原文')
    await db.close()
  })

  it('给定没有任何锚点当后台刷新文件动态值则拒绝读取（projectId 不是路径）', async () => {
    const db = store()
    const id = await writeEntity(db, {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: UNREGISTERED_PROJECT_ID },
      attrs: {
        title: '无锚点文件动态值',
        note: { $dynamic: { kind: 'file', path: 'docs/v7/REQUIREMENTS.md', extract: { kind: 'text' } } },
      },
    })
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: { now: () => new Date(), iso: () => new Date().toISOString() },
      readFile: path => readFile(path, 'utf8'),
    })

    const refreshed = await dynamic.refreshById(id)

    expect(refreshed === undefined ? undefined : attributeValue(refreshed, 'note')).toBeUndefined()
    await db.close()
  })
})
