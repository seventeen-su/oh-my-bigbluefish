/**
 * 管理侧边栏数据面（v4.15.0）：只读、有界、状态/作用域/类型过滤。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryScope } from '../../../kernel/abi/index.js'
import { openMemoryStore, asConfirmStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { createConfirmAction } from '../../../modules/memory/confirm.js'
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
    confirm: createConfirmAction({
      clock,
      resolveStores: () => [
        { scope: 'user', store: user },
        { scope: 'project', store: project },
      ],
      logger,
    }),
    clock,
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

  it('用户动作：确认候选/撤销确认（与 /omb-confirm 同一实现，v4.15.1）', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'cand', scope: 'user', kind: 'semantic', assertedBy: 'model', text: '候选结论：端口 8080' }))
    expect((await f.user.get('cand'))?.assertedBy).toBe('model')

    const confirmed = await f.service.act('cand', 'confirm')
    expect(confirmed.ok).toBe(true)
    expect(confirmed.text).toContain('已确认')
    expect((await f.user.get('cand'))?.assertedBy).toBe('user')

    const undone = await f.service.act('cand', 'undo')
    expect(undone.ok).toBe(true)
    expect((await f.user.get('cand'))?.assertedBy).toBe('model')

    // 已确认条目不能再确认（如实拒绝，不改库）
    await f.put('user', recordOf({ id: 'not-cand', scope: 'user', kind: 'semantic', assertedBy: 'user', text: '用户已确认' }))
    const refused = await f.service.act('not-cand', 'confirm')
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('未确认')

    expect((await f.service.act('', 'confirm')).ok).toBe(false)
    expect((await f.service.act('cand', 'nope' as never)).ok).toBe(false)
    await f.close()
  })

  it('确认功能未启用：act 如实拒绝（不假装成功）', async () => {
    const service = createUiService({
      stores: { status: () => ({ ready: false, detail: '未接线', openProjects: [], maxOpenProjects: 8 }), snapshot: () => ({ user: undefined, projects: [] }) },
    })
    const result = await service.act('x', 'confirm')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('未启用')
  })

  it('运行时读数与项目画像：缺省如实降级，接线后返回接线数据（v4.15.2）', async () => {
    const minimal = {
      status: () => ({ ready: false, detail: '测试未接线', openProjects: [], maxOpenProjects: 8 }),
      snapshot: () => ({ user: undefined, projects: [] }),
    }
    const base = createUiService({ stores: minimal })
    const runtime = await base.runtime()
    expect(runtime.version).toMatch(/^4\./)
    expect(runtime.stores).toMatchObject({ ready: false })
    const profile = await base.profile()
    expect(profile.available).toBe(false)
    expect(profile.reason).toContain('未接线')

    const wired = createUiService({
      stores: minimal,
      runtime: async () => ({
        privacy: { allowRead: true, allowWrite: false, reason: '测试 sealed' },
        controller: { mode: 'execute', events: 1, persist: 1, persisted: 1, verifyFailed: 0, failures: {}, duplicateActions: 0 },
        situation: { state: 'active', turn: 3, workspace: { root: '/work/demo', switches: 2, previousRoot: '/work/old', since: NOW } },
      }),
      profile: async () => ({ available: true, root: '/work/demo', branch: 'main' }),
    })
    const wiredRuntime = await wired.runtime()
    expect(wiredRuntime.privacy).toMatchObject({ allowWrite: false })
    expect(wiredRuntime.controller).toMatchObject({ mode: 'execute', persisted: 1 })
    expect(wiredRuntime.situation).toMatchObject({ state: 'active' })
    expect(wiredRuntime.situation?.workspace?.switches).toBe(2)
    expect((await wired.profile()).root).toBe('/work/demo')
  })

  it('手动冲突裁决：related 建边 / supersede 标旧条目（非破坏，v4.15.3）', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'n1', scope: 'user', kind: 'semantic', text: '新结论：端口 8080' }))
    await f.put('user', recordOf({ id: 'o1', scope: 'user', kind: 'semantic', text: '旧结论：端口 9090' }))
    await f.put('project', recordOf({ id: 'p1', scope: 'project', kind: 'semantic', text: '项目端口 8080' }))

    const related = await f.service.resolve({ action: 'relate', fromId: 'n1', toId: 'o1' })
    expect(related.ok).toBe(true)
    const walk = await f.user.walkGraph({ fromId: 'n1', depth: 1, types: ['related'] })
    expect(walk.nodes.map(node => node.id)).toContain('o1')

    const superseded = await f.service.resolve({ action: 'supersede', fromId: 'n1', toId: 'o1' })
    expect(superseded.ok).toBe(true)
    expect(superseded.text).toContain('取代')
    const older = await f.user.get('o1')
    expect(older?.supersededBy).toBe('n1')
    expect(older?.validTo).not.toBeNull()
    // 正文与来源不变（非破坏）
    expect(older?.text).toBe('旧结论：端口 9090')
    const supersedeWalk = await f.user.walkGraph({ fromId: 'n1', depth: 1, types: ['supersedes'] })
    expect(supersedeWalk.nodes.map(node => node.id)).toContain('o1')

    // 已被取代的不能再被取代 / 不能指向自己 / 不跨作用域
    const again = await f.service.resolve({ action: 'supersede', fromId: 'n1', toId: 'o1' })
    expect(again.ok).toBe(false)
    expect((await f.service.resolve({ action: 'relate', fromId: 'n1', toId: 'n1' })).ok).toBe(false)
    const cross = await f.service.resolve({ action: 'relate', fromId: 'n1', toId: 'p1' })
    expect(cross.ok).toBe(false)
    expect(cross.text).toContain('作用域')
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
