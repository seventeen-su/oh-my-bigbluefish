/**
 * 管理侧边栏数据面（v4.15.0）：只读、有界、状态/作用域/类型过滤。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryScope } from '../../../kernel/abi/index.js'
import { openMemoryStore, asConfirmStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { createUiService } from '../../../modules/memory/ui.js'
import { fixedClock, tempWorkspace, testPort } from './helpers.js'
import { makeRecord } from '../retrieval/fakes.js'

const NOW = 1_700_000_000_000

interface Fixture {
  readonly user: SqliteMemoryStore
  readonly project: SqliteMemoryStore
  readonly service: ReturnType<typeof createUiService>
  put(scope: MemoryScope, record: MemoryRecord): Promise<void>
  close(): Promise<void>
}

function fixture(): Fixture {
  const ws = tempWorkspace('omb-ui-')
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const user = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const project = openMemoryStore({
    scope: 'project',
    dbPath: join(ws.dir, 'proj', '.omb', 'memory', 'session.db'),
    port,
    logger,
    clock,
  })
  const service = createUiService({
    stores: {
      status: () => ({
        ready: true,
        detail: '测试库',
        openProjects: ['/work/demo'],
        maxOpenProjects: 8,
      }),
      snapshot: () => ({
        user: { stores: [{ scope: 'user', store: user }] },
        projects: [{ projectScope: '/work/demo', stores: [{ scope: 'project', store: project }] }],
      }),
    },
  })
  return {
    user,
    project,
    service,
    async put(scope, record) {
      await (scope === 'user' ? user : project).put(record)
    },
    async close() {
      await user.close()
      await project.close()
      ws.cleanup()
    },
  }
}

function recordOf(overrides: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return makeRecord({
    observedAt: NOW - 1_000,
    sourceRef: 'test:ui',
    ...overrides,
  })
}

describe('createUiService', () => {
  it('概览：库状态、活跃/候选计数', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'u1', scope: 'user', kind: 'semantic', assertedBy: 'user', text: '偏好 pnpm' }))
    await f.put('user', recordOf({ id: 'u2', scope: 'user', kind: 'semantic', assertedBy: 'model', text: '推断的偏好' }))
    await f.put('project', recordOf({ id: 'p1', scope: 'project', kind: 'procedural', assertedBy: 'user', text: '构建用 pnpm build' }))
    const overview = await f.service.overview()
    expect(overview.ready).toBe(true)
    expect(overview.openProjects).toEqual(['/work/demo'])
    expect(overview.totalActive).toBe(3)
    expect(overview.totalCandidates).toBe(1)
    expect(overview.stores).toHaveLength(2)
    await f.close()
  })

  it('列表：作用域/状态/类型过滤 + 全文搜索', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'u1', scope: 'user', kind: 'semantic', text: '端口 8080 是网关' }))
    await f.put('user', recordOf({
      id: 'u2',
      scope: 'user',
      kind: 'semantic',
      text: '旧结论：端口 9090',
      validTo: NOW - 500,
    }))
    await f.put('user', recordOf({
      id: 'u3',
      scope: 'user',
      kind: 'episodic',
      text: '昨天修了端口冲突',
    }))
    await f.put('project', recordOf({ id: 'p1', scope: 'project', kind: 'semantic', text: '项目端口 8080' }))

    const active = await f.service.list({ scope: 'all', status: 'active' })
    expect(active.items.map(item => item.id).sort()).toEqual(['p1', 'u1', 'u3'])

    const stale = await f.service.list({ scope: 'user', status: 'stale' })
    expect(stale.items.map(item => item.id)).toEqual(['u2'])

    const semantic = await f.service.list({ scope: 'all', status: 'active', kind: 'semantic' })
    expect(semantic.items.map(item => item.id).sort()).toEqual(['p1', 'u1'])

    const searched = await f.service.list({ scope: 'all', status: 'active', q: '端口' })
    expect(searched.items.map(item => item.id).sort()).toEqual(['p1', 'u1', 'u3'])

    const projectOnly = await f.service.list({ scope: 'project', status: 'active' })
    expect(projectOnly.items.map(item => item.id)).toEqual(['p1'])
    expect(projectOnly.items[0]?.projectScope).toBe('/work/demo')
    await f.close()
  })

  it('候选：只含模型推断的 semantic/procedural 活跃条目', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'c1', scope: 'user', kind: 'semantic', assertedBy: 'model', text: '推断结论' }))
    await f.put('user', recordOf({ id: 'c2', scope: 'user', kind: 'episodic', assertedBy: 'model', text: '推断事件' }))
    await f.put('user', recordOf({ id: 'c3', scope: 'user', kind: 'semantic', assertedBy: 'user', text: '用户确认' }))
    const candidates = await f.service.candidates(10)
    expect(candidates.items.map(item => item.id)).toEqual(['c1'])
    await f.close()
  })

  it('详情：正文 + 确认审计 + 共享实体键的相关条目', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'r1', scope: 'user', kind: 'semantic', text: 'pnpm test 覆盖 src/config/app.ts 的端口 8080' }))
    await f.put('user', recordOf({ id: 'r2', scope: 'user', kind: 'semantic', text: 'pnpm test 检查 src/config/app.ts 的端口 8080' }))
    const api = asConfirmStore(f.user)
    expect(api).toBeDefined()
    await api?.recordConfirm({ memoryId: 'r1', action: 'confirm', sessionId: 's1', at: NOW })

    const detail = await f.service.detail('r1')
    expect(detail).toBeDefined()
    expect(detail?.record.id).toBe('r1')
    expect(detail?.record.text).toContain('8080')
    expect(detail?.auditAvailable).toBe(true)
    expect(detail?.audit[0]).toMatchObject({ action: 'confirm', sessionId: 's1' })
    expect(detail?.related.map(item => item.record.id)).toContain('r2')
    expect(await f.service.detail('missing')).toBeUndefined()
    await f.close()
  })
})
