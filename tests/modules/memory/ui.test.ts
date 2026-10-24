/**
 * 管理侧边栏数据面（v4.15.0）：只读、有界、状态/作用域/类型过滤。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControllerAdminPort, ControllerAdminState, MemoryRecord, MemoryScope } from '../../../kernel/abi/index.js'
import { openMemoryStore, asConfirmStore, asRecordScanner, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { createConfirmAction } from '../../../modules/memory/confirm.js'
import { createUiService } from '../../../modules/memory/ui.js'
import type { PrivacyAdminPort, UiPrivacyView } from '../../../modules/memory/privacy/contract.js'
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

/**
 * v4.18 手动写入用的服务：有当前会话 + `forSession`（出口过隐私闸门），
 * 快照库也给出同样的两个库（无会话路径用）。
 */
function writableFor(f: Fixture): ReturnType<typeof createUiService> {
  const clock = fixedClock()
  const stores = [
    { scope: 'user' as const, store: f.user },
    { scope: 'project' as const, store: f.project },
  ]
  return createUiService({
    stores: {
      status: () => ({ ready: true, detail: '测试库', openProjects: ['/work/demo'], maxOpenProjects: 8 }),
      snapshot: () => ({
        user: { stores: [{ scope: 'user', store: f.user }] },
        projects: [{ projectScope: '/work/demo', stores }],
      }),
      forSession: async () => ({
        projectScope: '/work/demo',
        stores,
        store: (scope: MemoryScope) => (scope === 'user' ? f.user : f.project),
      }),
    },
    currentSession: () => 's1',
    clock,
  })
}

async function recentRecords(store: SqliteMemoryStore, limit = 20): Promise<readonly MemoryRecord[]> {
  return await asRecordScanner(store)?.listRecentRecords({ limit }) ?? []
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

    // v4.18 分页：offset 取下一页，truncated 表示还有更多；两页不重复、合起来是全部
    const page1 = await f.service.list({ scope: 'all', status: 'active', limit: 2, offset: 0 })
    const page2 = await f.service.list({ scope: 'all', status: 'active', limit: 2, offset: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.truncated).toBe(true)
    expect(page2.items.length).toBeGreaterThanOrEqual(1)
    const ids = [...page1.items, ...page2.items].map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(['p1', 'u1', 'u3'])
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

  it('候选：先按判据过滤再截断（v4.16.0，排在后面的候选不会被漏掉）', async () => {
    const f = fixture()
    // 55 条更新的已确认条目，把候选挤到 50 名之外
    for (let index = 0; index < 55; index += 1) {
      await f.put('user', recordOf({
        id: `u-${index}`,
        scope: 'user',
        kind: 'semantic',
        assertedBy: 'user',
        text: `已确认条目 ${index}`,
        observedAt: NOW - index,
      }))
    }
    await f.put('user', recordOf({
      id: 'candidate-old',
      scope: 'user',
      kind: 'semantic',
      assertedBy: 'model',
      text: '更早的候选结论',
      observedAt: NOW - 10_000,
    }))
    const result = await f.service.candidates(5)
    expect(result.items.map(item => item.id)).toContain('candidate-old')
    expect(result.total).toBe(1)
    await f.close()
  })

  it('概览：扫描受限时如实标记（不把最近 500 行当成全量）', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'x1', scope: 'user', kind: 'semantic', text: '一条' }))
    const overview = await f.service.overview()
    expect(overview.stores.every(store => store.scanLimited === false)).toBe(true)
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

  // ── 会话隐私页（v4.17）────────────────────────────────────────────
  const minimalStores = {
    status: () => ({ ready: false, detail: '测试未接线', openProjects: [], maxOpenProjects: 8 }),
    snapshot: () => ({ user: undefined, projects: [] }),
  }

  function privacyView(overrides: Partial<UiPrivacyView> = {}): UiPrivacyView {
    return {
      available: true,
      baseline: { mode: 'normal', origin: 'default', detail: '该会话没有隐私设置（默认 normal）' },
      current: null,
      sessions: [],
      restricted: null,
      durable: {
        path: '/tmp/session-modes.json',
        ok: true,
        detail: '状态文件可读写',
        savedAt: NOW,
      },
      commands: {
        privacy: '/omb-privacy',
        clean: '/omb-privacy-clean',
        state: '已注册（宿主返回 function）',
      },
      stats: {
        decisions: 3,
        readDenials: 1,
        writeDenials: 1,
        unattributedWriteDenials: 0,
        lastDeniedSession: 's1',
        lastDeniedReason: 'sealed',
      },
      ...overrides,
    }
  }

  it('隐私设置：privacy() 正常透传当前会话；未接线与异常降级为完整形状', async () => {
    const wired = createUiService({
      stores: minimalStores,
      privacy: {
        current: () => 's1',
        admin: {
          view: currentSessionId => privacyView({
            current: currentSessionId === null
              ? null
              : {
                  sessionId: currentSessionId,
                  mode: 'sealed',
                  origin: 'command',
                  inheritedFrom: null,
                  detail: '本会话由命令显式设置为 sealed',
                  parentSessionId: null,
                },
          }),
          setMode: () => ({ ok: true, text: 'ok' }),
          clear: () => ({ ok: true, text: 'ok' }),
          clearInactive: () => ({ ok: true, text: 'ok' }),
          trust: () => ({ ok: true, text: 'ok' }),
          modeOf: () => ({ mode: 'normal', origin: 'default', inheritedFrom: null }),
        },
      },
    })
    const view = await wired.privacy()
    expect(view.available).toBe(true)
    expect(view.current).toMatchObject({ sessionId: 's1', mode: 'sealed', origin: 'command' })
    expect(view.commands).toMatchObject({ privacy: '/omb-privacy', clean: '/omb-privacy-clean' })
    expect(view.stats.decisions).toBe(3)

    // 未接线：不省略任何字段，文案说清原因
    const absent = await createUiService({ stores: minimalStores }).privacy()
    expect(absent).toMatchObject({
      available: false,
      current: null,
      sessions: [],
      restricted: null,
      durable: { path: null, ok: false, detail: '未知', savedAt: null },
      commands: { privacy: '/omb-privacy', clean: '/omb-privacy-clean', state: '未接线' },
      stats: { decisions: 0, readDenials: 0, writeDenials: 0, unattributedWriteDenials: 0, lastDeniedSession: null, lastDeniedReason: null },
    })
    expect(absent.reason).toContain('未接线')

    // 内部异常 → 降级，不抛
    const broken = createUiService({
      stores: minimalStores,
      privacy: {
        current: () => 's1',
        admin: {
          view: () => {
            throw new Error('状态文件坏了')
          },
          setMode: () => ({ ok: true, text: 'ok' }),
          clear: () => ({ ok: true, text: 'ok' }),
          clearInactive: () => ({ ok: true, text: 'ok' }),
          trust: () => ({ ok: true, text: 'ok' }),
          modeOf: () => ({ mode: 'normal', origin: 'default', inheritedFrom: null }),
        },
      },
    })
    const degraded = await broken.privacy()
    expect(degraded.available).toBe(false)
    expect(degraded.reason).toContain('已隔离')
    expect(degraded.reason).toContain('状态文件坏了')

    // current() 自己抛错也走同一条降级路径
    const brokenCurrent = createUiService({
      stores: minimalStores,
      privacy: {
        current: () => {
          throw new Error('没有活跃会话')
        },
        admin: {
          view: () => privacyView(),
          setMode: () => ({ ok: true, text: 'ok' }),
          clear: () => ({ ok: true, text: 'ok' }),
          clearInactive: () => ({ ok: true, text: 'ok' }),
          trust: () => ({ ok: true, text: 'ok' }),
          modeOf: () => ({ mode: 'normal', origin: 'default', inheritedFrom: null }),
        },
      },
    })
    expect((await brokenCurrent.privacy()).available).toBe(false)
  })

  it('隐私设置：privacyAct 四动作透传、非法参数拒绝、admin 抛错隔离', async () => {
    const calls: string[] = []
    const admin: PrivacyAdminPort = {
      view: () => privacyView(),
      setMode: (sessionId, mode) => {
        calls.push(`set:${sessionId}:${mode}`)
        return { ok: true, text: `已设置 ${sessionId}=${mode}` }
      },
      clear: sessionId => {
        calls.push(`clear:${sessionId}`)
        return { ok: true, text: `已清除 ${sessionId}` }
      },
      clearInactive: () => {
        calls.push('clear-inactive')
        return { ok: true, text: '已清理已结束会话' }
      },
      trust: () => {
        calls.push('trust')
        return { ok: true, text: '已解除 fail-closed' }
      },
      modeOf: () => ({ mode: 'normal', origin: 'default', inheritedFrom: null }),
    }
    const service = createUiService({ stores: minimalStores, privacy: { current: () => 's1', admin } })

    expect(await service.privacyAct({ action: 'set', sessionId: 's1', mode: 'sealed' })).toMatchObject({ ok: true })
    expect(await service.privacyAct({ action: 'clear', sessionId: 's2' })).toMatchObject({ ok: true })
    expect(await service.privacyAct({ action: 'clear-inactive' })).toMatchObject({ ok: true })
    expect(await service.privacyAct({ action: 'trust' })).toMatchObject({ ok: true })
    expect(calls).toEqual(['set:s1:sealed', 'clear:s2', 'clear-inactive', 'trust'])

    // 非法参数：一律 {ok:false, text 以「未执行」开头}，且不触碰 admin
    const before = calls.length
    expect(await service.privacyAct({ action: 'nope' as never })).toMatchObject({ ok: false })
    expect((await service.privacyAct({ action: 'set', sessionId: 's1' })).text).toContain('mode')
    expect((await service.privacyAct({ action: 'set', sessionId: 's1', mode: 'deep' as never })).ok).toBe(false)
    expect((await service.privacyAct({ action: 'set', sessionId: '', mode: 'normal' })).text).toContain('sessionId')
    expect((await service.privacyAct({ action: 'clear' })).text).toContain('sessionId')
    // 超长 id（可能是误贴了别的东西）：拒绝写进状态文件，也不触碰 admin
    expect((await service.privacyAct({ action: 'set', sessionId: 'x'.repeat(201), mode: 'sealed' })).text).toContain('超过')
    expect((await service.privacyAct({ action: 'clear', sessionId: 'x'.repeat(201) })).text).toContain('超过')
    expect(calls.length).toBe(before)

    // 未接线：如实拒绝
    const absent = createUiService({ stores: minimalStores })
    expect((await absent.privacyAct({ action: 'trust' })).text).toContain('未接线')

    // admin 抛错 → 隔离成 {ok:false}，不冒泡
    const broken = createUiService({
      stores: minimalStores,
      privacy: {
        current: () => 's1',
        admin: {
          ...admin,
          setMode: () => {
            throw new Error('持久化失败')
          },
        },
      },
    })
    const isolated = await broken.privacyAct({ action: 'set', sessionId: 's1', mode: 'sealed' })
    expect(isolated.ok).toBe(false)
    expect(isolated.text).toContain('已隔离')
    expect(isolated.text).toContain('持久化失败')
  })

  // ── v4.18 手动增删改标记 / 项目页 / 个人画像 ─────────────────────
  it('手动新建：用户库/项目库、字段与隐私归属；非法参数与缺会话拒绝（v4.18）', async () => {
    const f = fixture()
    const service = writableFor(f)

    const created = await service.createMemory({
      scope: 'user', kind: 'semantic', text: '  用户手动写入的偏好  ', tags: ['ui', '手动', 'ui'],
    })
    expect(created.ok).toBe(true)
    expect(created.text).toContain('已新建记忆')
    const userRecord = (await recentRecords(f.user)).find(record => record.text === '用户手动写入的偏好')
    expect(userRecord).toBeDefined()
    expect(userRecord).toMatchObject({
      scope: 'user', kind: 'semantic', assertedBy: 'user', sourceRef: 'ui:manual',
      validTo: null, supersededBy: null, useCount: 0, project: null,
    })
    expect(userRecord?.tags).toEqual(['ui', '手动'])
    expect(userRecord?.contentHash).toBeTruthy()

    const projectCreated = await service.createMemory({ scope: 'project', kind: 'procedural', text: '项目手动写入' })
    expect(projectCreated.ok).toBe(true)
    const projectRecord = (await recentRecords(f.project)).find(record => record.text === '项目手动写入')
    expect(projectRecord).toMatchObject({ scope: 'project', project: '/work/demo' })

    // 项目作用域必须有当前会话
    const noSession = createUiService({ stores: minimalStores, clock: fixedClock() })
    const rejected = await noSession.createMemory({ scope: 'project', kind: 'semantic', text: '没有会话' })
    expect(rejected.ok).toBe(false)
    expect(rejected.text).toContain('项目作用域需要当前会话')

    expect((await service.createMemory({ scope: 'user', kind: 'semantic', text: '   ' })).ok).toBe(false)
    expect((await service.createMemory({ scope: 'user', kind: 'semantic', text: 'x'.repeat(4001) })).ok).toBe(false)
    expect((await service.createMemory({ scope: 'user', kind: 'semantic', text: '标签太多', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).ok).toBe(false)
    expect((await service.createMemory({ scope: 'user', kind: 'semantic', text: '标签太长', tags: ['x'.repeat(25)] })).ok).toBe(false)
    await f.close()
  })

  it('手动编辑：保留 id/observedAt/sourceRef/assertedBy/useCount；文本变则重算 contentHash；非活跃拒绝', async () => {
    const f = fixture()
    const service = writableFor(f)
    const created = await service.createMemory({ scope: 'user', kind: 'semantic', text: '旧正文' })
    expect(created.ok).toBe(true)
    const before = (await recentRecords(f.user)).find(record => record.text === '旧正文')
    expect(before).toBeDefined()
    const id = before!.id

    const updated = await service.updateMemory({ id, text: '新正文', kind: 'procedural', tags: ['编辑'] })
    expect(updated.ok).toBe(true)
    const after = await f.user.get(id)
    expect(after).toMatchObject({
      id, text: '新正文', kind: 'procedural', observedAt: before!.observedAt,
      sourceRef: 'ui:manual', assertedBy: 'user', useCount: 0, project: null,
    })
    expect(after?.tags).toEqual(['编辑'])
    expect(after?.contentHash).not.toBe(before!.contentHash)

    await f.put('user', recordOf({ id: 'u-stale', scope: 'user', kind: 'semantic', text: '失效条目', validTo: NOW - 1 }))
    expect((await service.updateMemory({ id: 'u-stale', text: '改不动' })).ok).toBe(false)
    await f.close()
  })

  it('手动删除：真删后查回不存在；store 不支持 forget 时如实拒绝', async () => {
    const f = fixture()
    const service = writableFor(f)
    await f.put('user', recordOf({ id: 'd1', scope: 'user', kind: 'semantic', text: '要删的条目' }))
    const deleted = await service.deleteMemory('d1')
    expect(deleted.ok).toBe(true)
    expect(deleted.text).toContain('已删除')
    expect(await f.user.get('d1')).toBeUndefined()
    expect((await service.deleteMemory('d1')).ok).toBe(false)

    // 结构化探测：store 没有 forget → 拒绝，不改任何数据
    const record = recordOf({ id: 'no-forget', scope: 'user', kind: 'semantic', text: '不能删' })
    const fakeStore = {
      scope: 'user' as const,
      get: async (id: string) => (id === record.id ? record : undefined),
      put: async () => {},
      getMany: async () => [record],
      forget: undefined as unknown as (ids: readonly string[]) => Promise<number>,
    }
    const noForget = createUiService({
      stores: {
        status: () => ({ ready: true, detail: 'fake', openProjects: [], maxOpenProjects: 8 }),
        snapshot: () => ({ user: { stores: [{ scope: 'user', store: fakeStore as never }] }, projects: [] }),
      },
      currentSession: () => 's1',
      clock: fixedClock(),
    })
    const refused = await noForget.deleteMemory('no-forget')
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('forget')
    await f.close()
  })

  it('手动标记：obsolete 写 validTo、revive 清 validTo、被取代不可复活；confirm 复用 deps.confirm', async () => {
    const f = fixture()
    const service = writableFor(f)
    await f.put('user', recordOf({ id: 'ob1', scope: 'user', kind: 'semantic', text: '待失效条目' }))
    const obsolete = await service.markMemory('ob1', 'obsolete')
    expect(obsolete.ok).toBe(true)
    const marked = await f.user.get('ob1')
    expect(marked?.validTo).not.toBeNull()
    expect(marked?.supersededBy).toBeNull()

    const revived = await service.markMemory('ob1', 'revive')
    expect(revived.ok).toBe(true)
    expect((await f.user.get('ob1'))?.validTo).toBeNull()

    await f.put('user', recordOf({
      id: 'sup1', scope: 'user', kind: 'semantic', text: '已被取代', validTo: NOW - 1, supersededBy: 'other',
    }))
    const reviveSuperseded = await service.markMemory('sup1', 'revive')
    expect(reviveSuperseded.ok).toBe(false)
    expect(reviveSuperseded.text).toContain('取代')

    const calls: string[] = []
    const confirmService = createUiService({
      stores: minimalStores,
      currentSession: () => 's1',
      confirm: async input => {
        calls.push(`${input.action}:${input.id}:${String(input.sessionId)}`)
        return { ok: true, text: '已确认' }
      },
      clock: fixedClock(),
    })
    expect((await confirmService.markMemory('c1', 'confirm')).ok).toBe(true)
    expect(calls).toEqual(['confirm:c1:s1'])
    expect((await confirmService.markMemory('c1', 'nope' as never)).ok).toBe(false)
    await f.close()
  })

  it('list 支持 status=candidate（active + model + semantic/procedural）', async () => {
    const f = fixture()
    await f.put('user', recordOf({ id: 'c-sem', scope: 'user', kind: 'semantic', assertedBy: 'model', text: '候选语义' }))
    await f.put('user', recordOf({ id: 'c-pro', scope: 'user', kind: 'procedural', assertedBy: 'model', text: '候选过程' }))
    await f.put('user', recordOf({ id: 'c-epi', scope: 'user', kind: 'episodic', assertedBy: 'model', text: '事件不算候选' }))
    await f.put('user', recordOf({ id: 'c-user', scope: 'user', kind: 'semantic', assertedBy: 'user', text: '用户确认过' }))
    await f.put('user', recordOf({
      id: 'c-old', scope: 'user', kind: 'semantic', assertedBy: 'model', text: '已失效候选', validTo: NOW - 1,
    }))
    const candidates = await f.service.list({ scope: 'user', status: 'candidate' })
    expect(candidates.items.map(item => item.id).sort()).toEqual(['c-pro', 'c-sem'])
    await f.close()
  })

  it('sessions：只列 agentPreset=omb；归档保留；active/depth/root/privacy 按内核服务；目录不可用如实降级', async () => {
    const sessionCatalog = {
      list: async () => ({
        available: true,
        items: [
          { id: 's1', title: '会话一', cwd: '/work/demo/sub', createdAt: 3, agentPreset: 'omb', archived: false, live: true, parentId: 'parent-1' },
          { id: 's2', title: null, cwd: '/work/old', createdAt: 2, agentPreset: 'omb', archived: true, live: false, parentId: null },
          { id: 's3', title: '别家', cwd: '/x', createdAt: 1, agentPreset: 'standard', archived: false, live: true },
        ],
      }),
    }
    const admin: PrivacyAdminPort = {
      view: () => privacyView(),
      setMode: () => ({ ok: true, text: 'ok' }),
      clear: () => ({ ok: true, text: 'ok' }),
      clearInactive: () => ({ ok: true, text: 'ok' }),
      trust: () => ({ ok: true, text: 'ok' }),
      modeOf: (sessionId: string) => sessionId === 's1'
        ? { mode: 'sealed', origin: 'command', inheritedFrom: null }
        : { mode: 'normal', origin: 'default', inheritedFrom: null },
    }
    const service = createUiService({
      stores: minimalStores,
      sessionCatalog: sessionCatalog as never,
      sessionRuntime: { list: () => [{ sessionId: 's1', observations: 2 }, { sessionId: 's2', observations: 0 }] },
      rootOf: cwd => (cwd.startsWith('/work') ? '/work/demo' : null),
      focusOf: sessionId => (sessionId === 's1' ? 'deep' : null),
      privacy: { current: () => 's1', admin },
      clock: fixedClock(),
    })
    const listing = await service.sessions()
    expect(listing.available).toBe(true)
    expect(listing.items.map(item => item.id)).toEqual(['s1', 's2'])
    expect(listing.items[0]).toMatchObject({
      title: '会话一', cwd: '/work/demo/sub', root: '/work/demo', preset: 'omb',
      archived: false, active: true, depth: 'deep', createdAt: 3, parentId: 'parent-1',
      privacy: { mode: 'sealed', origin: 'command', inheritedFrom: null },
    })
    expect(listing.items[1]).toMatchObject({ id: 's2', archived: true, active: false, parentId: null })

    const unavailable = await createUiService({ stores: minimalStores }).sessions()
    expect(unavailable.available).toBe(false)
    expect(unavailable.items).toEqual([])
    expect(unavailable.reason).toContain('未接线')
  })

  it('personal：正常透传；未接线降级为完整形状', async () => {
    const personal = {
      available: true,
      status: {
        available: true, detail: '显式 1 条', declared: 1, inferred: 0, conflicts: 0, capabilityAxis: 'off' as const,
      },
      entries: [{ axis: 'stable', axisLabel: '稳定偏好', key: 'pkg', value: 'pnpm', provenance: 'declared' as const, evidence: ['s1'], updated: NOW }],
      conflicts: [],
      text: '· 稳定偏好「pkg」= pnpm',
    }
    const wired = createUiService({ stores: minimalStores, personal: async () => personal, clock: fixedClock() })
    expect(await wired.personal()).toEqual(personal)

    const absent = await createUiService({ stores: minimalStores }).personal()
    expect(absent.available).toBe(false)
    expect(absent.entries).toEqual([])
    expect(absent.conflicts).toEqual([])
    expect(absent.text).toBe('')
    expect(absent.reason).toContain('未接线')
  })

  it('profile(sessionId)：按会话透传；未接线如实拒绝', async () => {
    const service = createUiService({
      stores: minimalStores,
      profileForSession: async sessionId => ({ available: true, root: `/root/${sessionId}` }),
      clock: fixedClock(),
    })
    expect(await service.profile('s9')).toMatchObject({ available: true, root: '/root/s9' })
    const absent = await createUiService({ stores: minimalStores }).profile('s9')
    expect(absent.available).toBe(false)
    expect(absent.reason).toContain('未接线')
  })

  // ── v4.19.0：控制器手动编辑 / 个人画像写入 ─────────────────────────
  function controllerState(): ControllerAdminState {
    return {
      phase: 'mixed',
      tasks: [{ text: '别改测试', at: NOW, expiresAt: NOW + 60_000 }],
      candidates: [{ id: 'c1', text: '项目统一 pnpm', kind: 'semantic', scope: 'project', at: NOW, reason: 'intent:stable-decision' }],
      lastEventAt: NOW,
    }
  }

  it('controller()：正常映射任务/候选/阶段；缺端口/缺会话/异常都降级为完整形状', async () => {
    const admin: ControllerAdminPort = {
      state: () => controllerState(),
      edit: () => controllerState(),
    }
    const service = createUiService({
      stores: minimalStores,
      controllerAdmin: admin,
      currentSession: () => 's1',
      clock: fixedClock(),
    })
    const view = await service.controller()
    expect(view).toMatchObject({
      available: true,
      sessionId: 's1',
      phase: 'mixed',
      lastEventAt: NOW,
      tasks: [{ text: '别改测试', at: NOW, expiresAt: NOW + 60_000 }],
      candidates: [{ id: 'c1', text: '项目统一 pnpm', kind: 'semantic', scope: 'project' }],
    })
    expect((await service.controller('s2')).sessionId).toBe('s2')

    const absent = await createUiService({ stores: minimalStores }).controller('s1')
    expect(absent).toMatchObject({ available: false, tasks: [], candidates: [] })
    expect(absent.reason).toContain('未接线')

    const noSession = await createUiService({ stores: minimalStores, controllerAdmin: admin }).controller()
    expect(noSession.available).toBe(false)
    expect(noSession.reason).toContain('无会话归属')

    const broken = createUiService({
      stores: minimalStores,
      currentSession: () => 's1',
      controllerAdmin: {
        state: () => {
          throw new Error('控制器坏了')
        },
        edit: () => controllerState(),
      },
    })
    const degraded = await broken.controller()
    expect(degraded.available).toBe(false)
    expect(degraded.reason).toContain('已隔离')
  })

  it('controllerAct()：五动作透传、参数校验、admin 抛错隔离、无改动如实回执', async () => {
    const calls: { sessionId: string; kind: string; text?: string }[] = []
    const admin: ControllerAdminPort = {
      state: () => ({ phase: 'idle', tasks: [], candidates: [], lastEventAt: null }),
      edit: (sessionId, edit) => {
        calls.push({ sessionId, kind: edit.kind, ...(('text' in edit) ? { text: edit.text } : {}) })
        const tasks = edit.kind === 'add-task'
          ? [{ text: edit.text, at: NOW, expiresAt: NOW + 60_000 }]
          : []
        return { phase: tasks.length > 0 ? 'tracking-tasks' : 'idle', tasks, candidates: [], lastEventAt: null }
      },
    }
    const service = createUiService({
      stores: minimalStores,
      controllerAdmin: admin,
      currentSession: () => 's1',
      clock: fixedClock(),
    })
    const added = await service.controllerAct({ action: 'add-task', sessionId: 's1', text: '别改测试' })
    expect(added.ok).toBe(true)
    expect(added.text).toContain('已更新会话 s1')
    expect(await service.controllerAct({ action: 'remove-task', sessionId: 's1', text: '别改测试' })).toMatchObject({ ok: true })
    expect(await service.controllerAct({ action: 'clear-tasks', sessionId: 's1' })).toMatchObject({ ok: true })
    expect(await service.controllerAct({ action: 'remove-candidate', sessionId: 's1', text: 'x' })).toMatchObject({ ok: true })
    expect(await service.controllerAct({ action: 'clear-candidates', sessionId: 's1' })).toMatchObject({ ok: true })
    expect(calls.map(call => call.kind)).toEqual(['add-task', 'remove-task', 'clear-tasks', 'remove-candidate', 'clear-candidates'])

    // 非法参数：一律未执行且不触碰 admin
    const before = calls.length
    expect((await service.controllerAct({ action: 'nope' as never, sessionId: 's1' })).ok).toBe(false)
    expect((await service.controllerAct({ action: 'add-task', text: 'x' })).text).toContain('sessionId')
    expect((await service.controllerAct({ action: 'add-task', sessionId: 'x'.repeat(201), text: 'x' })).ok).toBe(false)
    expect((await service.controllerAct({ action: 'add-task', sessionId: 's1' })).text).toContain('text')
    expect((await service.controllerAct({ action: 'add-task', sessionId: 's1', text: 'x'.repeat(201) })).ok).toBe(false)
    expect(calls.length).toBe(before)
    expect((await createUiService({ stores: minimalStores }).controllerAct({ action: 'clear-tasks', sessionId: 's1' })).text).toContain('未接线')

    // 无改动：ok=true，但文案说"未变"（不假装改成功）
    const noop = await service.controllerAct({ action: 'clear-tasks', sessionId: 's1' })
    expect(noop.ok).toBe(true)
    expect(noop.text).toContain('未变')

    const broken = createUiService({
      stores: minimalStores,
      controllerAdmin: {
        ...admin,
        edit: () => {
          throw new Error('写失败')
        },
      },
    })
    const isolated = await broken.controllerAct({ action: 'clear-tasks', sessionId: 's1' })
    expect(isolated.ok).toBe(false)
    expect(isolated.text).toContain('已隔离')
  })

  it('personalAct()：declare/retract 透传；能力轴与非法参数拒绝；provider 抛出/拒绝如实返回', async () => {
    const edits: unknown[] = []
    const service = createUiService({
      stores: minimalStores,
      clock: fixedClock(),
      personalEdit: async input => {
        edits.push(input)
        return { ok: true, text: input.action === 'declare' ? '已写入个人画像。' : '已删除该槽位。' }
      },
    })
    expect(await service.personalAct({ action: 'declare', axis: 'stable', key: 'pkg', value: 'pnpm', evidence: ['s1'] }))
      .toMatchObject({ ok: true, text: '已写入个人画像。' })
    expect(await service.personalAct({ action: 'retract', axis: 'stable', key: 'pkg' }))
      .toMatchObject({ ok: true, text: '已删除该槽位。' })
    expect(edits).toHaveLength(2)

    const before = edits.length
    expect((await service.personalAct({ action: 'declare', axis: 'capability', key: 'x', value: 'y' })).ok).toBe(false)
    expect((await service.personalAct({ action: 'declare', axis: 'nope', key: 'x', value: 'y' })).ok).toBe(false)
    expect((await service.personalAct({ action: 'declare', axis: 'stable', key: '  ', value: 'y' })).ok).toBe(false)
    expect((await service.personalAct({ action: 'declare', axis: 'stable', key: 'k', value: ' ' })).ok).toBe(false)
    expect((await service.personalAct({ action: 'declare', axis: 'stable', key: 'k', value: 'x'.repeat(2001) })).ok).toBe(false)
    expect((await service.personalAct({ action: 'declare', axis: 'stable', key: 'k', value: 'v', evidence: 'bad' as never })).ok).toBe(false)
    expect((await service.personalAct({ action: 'nope', axis: 'stable', key: 'k' } as never)).ok).toBe(false)
    expect(edits.length).toBe(before)

    expect((await createUiService({ stores: minimalStores }).personalAct({ action: 'retract', axis: 'stable', key: 'k' })).text).toContain('未接线')

    const broken = createUiService({
      stores: minimalStores,
      personalEdit: () => {
        throw new Error('画像写失败')
      },
    })
    const isolated = await broken.personalAct({ action: 'retract', axis: 'stable', key: 'k' })
    expect(isolated.ok).toBe(false)
    expect(isolated.text).toContain('已隔离')

    const refused = createUiService({
      stores: minimalStores,
      personalEdit: () => ({ ok: false, text: '未写入：槽位不存在' }),
    })
    expect(await refused.personalAct({ action: 'retract', axis: 'stable', key: 'k' }))
      .toMatchObject({ ok: false, text: '未写入：槽位不存在' })
  })

  // ── v4.20.0：所有状态机聚合 / 反馈 / 推理深度 ─────────────────────
  function machinesService(options: { readonly withAdmin?: boolean; readonly withCatalog?: boolean } = {}) {
    const calls: string[] = []
    const catalog = {
      list: async () => ({
        available: true,
        items: [
          { id: 's1', title: '一', cwd: '/work/a/sub', createdAt: 1, agentPreset: 'omb', archived: false, live: true },
          { id: 's2', title: '二', cwd: '/work/a/sub2', createdAt: 2, agentPreset: 'omb', archived: false, live: true },
          { id: 's3', title: '三', cwd: '/work/b', createdAt: 3, agentPreset: 'omb', archived: false, live: true },
          { id: 's4', title: '归档', cwd: '/work/a/old', createdAt: 4, agentPreset: 'omb', archived: true, live: false },
          { id: 's5', title: '封存', cwd: '/work/a/secret', createdAt: 5, agentPreset: 'omb', archived: false, live: true },
        ],
      }),
    }
    const admin: ControllerAdminPort = {
      state: sessionId => {
        calls.push(sessionId)
        if (sessionId === 's2') {
          return {
            phase: 'mixed',
            tasks: [{ text: '别改测试', at: NOW, expiresAt: NOW + 60_000 }],
            candidates: [{ id: 'c1', text: '项目统一 pnpm', kind: 'procedural', scope: 'project', at: NOW, reason: 'intent' }],
            lastEventAt: NOW,
          }
        }
        if (sessionId === 's3') {
          return { phase: 'tracking-tasks', tasks: [{ text: '临时', at: NOW, expiresAt: NOW + 1 }], candidates: [], lastEventAt: NOW - 1 }
        }
        return { phase: 'idle', tasks: [], candidates: [], lastEventAt: null }
      },
      edit: () => ({ phase: 'idle', tasks: [], candidates: [], lastEventAt: null }),
    }
    const service = createUiService({
      stores: minimalStores,
      currentSession: () => 's1',
      ...(options.withCatalog === false ? {} : { sessionCatalog: catalog as never }),
      sessionRuntime: { list: () => [{ sessionId: 's1', observations: 2 }] },
      rootOf: cwd => (cwd.startsWith('/work/a') ? '/work/a' : '/work/b'),
      focusOf: () => 'standard',
      ...(options.withAdmin === false ? {} : { controllerAdmin: admin }),
      privacy: {
        current: () => 's1',
        admin: {
          view: () => privacyView(),
          setMode: () => ({ ok: true, text: 'ok' }),
          clear: () => ({ ok: true, text: 'ok' }),
          clearInactive: () => ({ ok: true, text: 'ok' }),
          trust: () => ({ ok: true, text: 'ok' }),
          modeOf: sessionId => ({
            mode: sessionId === 's5' ? 'sealed' : 'normal',
            origin: 'default',
            inheritedFrom: null,
          }),
        },
      },
      clock: fixedClock(),
    })
    return { service, calls }
  }

  it('machines()：按 root 分组、组内 createdAt 降序；sealed/归档不读状态；未接线降级', async () => {
    const { service, calls } = machinesService()
    const view = await service.machines()
    expect(view.available).toBe(true)
    expect(view.groups.map(group => group.root)).toEqual(['/work/a', '/work/b'])
    const groupA = view.groups[0]!
    expect(groupA.sessions.map(session => session.id)).toEqual(['s5', 's4', 's2', 's1'])
    const sealed = groupA.sessions.find(session => session.id === 's5')!
    expect(sealed).toMatchObject({ archived: false, phase: 'unknown', tasks: [], candidates: [], privacy: 'sealed', lastEventAt: null })
    const archived = groupA.sessions.find(session => session.id === 's4')!
    expect(archived).toMatchObject({ archived: true, phase: 'unknown', tasks: [], candidates: [] })
    const mixed = groupA.sessions.find(session => session.id === 's2')!
    expect(mixed).toMatchObject({
      phase: 'mixed',
      tasks: [{ text: '别改测试', expiresAt: NOW + 60_000 }],
      candidates: [{ id: 'c1', text: '项目统一 pnpm', kind: 'procedural' }],
      lastEventAt: NOW,
      privacy: 'normal',
    })
    expect(view.groups[1]?.sessions[0]).toMatchObject({ id: 's3', phase: 'tracking-tasks' })
    // sealed 与归档不读状态：只读了 s1/s2/s3
    expect(calls.sort()).toEqual(['s1', 's2', 's3'])

    const noAdmin = await machinesService({ withAdmin: false }).service.machines()
    expect(noAdmin).toMatchObject({ available: false, groups: [] })
    expect(noAdmin.reason).toContain('未接线')
    const noCatalog = await machinesService({ withCatalog: false }).service.machines()
    expect(noCatalog).toMatchObject({ available: false, groups: [] })
    expect(noCatalog.reason).toContain('未接线')
  })

  it('feedbackAct()：动作白名单、id 校验、provider 透传与异常隔离', async () => {
    const calls: string[] = []
    const service = createUiService({
      stores: minimalStores,
      feedbackRun: async (id, action) => {
        calls.push(`${id}:${action}`)
        return { ok: action !== 'wrong', text: `${action} 回执` }
      },
      clock: fixedClock(),
    })
    expect(await service.feedbackAct({ id: ' m1 ', action: 'useful' })).toMatchObject({ ok: true, text: 'useful 回执' })
    expect(await service.feedbackAct({ id: 'm2', action: 'wrong' })).toMatchObject({ ok: false })
    expect(calls).toEqual(['m1:useful', 'm2:wrong'])
    expect((await service.feedbackAct({ id: '', action: 'useful' })).ok).toBe(false)
    expect((await service.feedbackAct({ id: 'm1', action: 'nope' as never })).ok).toBe(false)
    expect((await service.feedbackAct({ id: 'x'.repeat(201), action: 'useful' })).ok).toBe(false)
    expect((await createUiService({ stores: minimalStores }).feedbackAct({ id: 'm1', action: 'useful' })).text).toContain('未接线')
    const broken = createUiService({
      stores: minimalStores,
      feedbackRun: async () => {
        throw new Error('账本坏了')
      },
    })
    const isolated = await broken.feedbackAct({ id: 'm1', action: 'useful' })
    expect(isolated.ok).toBe(false)
    expect(isolated.text).toContain('已隔离')
  })

  it('depthAct()：合法深度/显式会话、缺省当前会话、非法与未接线拒绝、setter 异常隔离', async () => {
    const calls: string[] = []
    const service = createUiService({
      stores: minimalStores,
      currentSession: () => 's1',
      setDepth: (sessionId, depth) => {
        calls.push(`${sessionId}:${depth}`)
      },
      clock: fixedClock(),
    })
    expect(await service.depthAct({ sessionId: 's9', depth: 'quick' })).toMatchObject({ ok: true })
    expect(await service.depthAct({ depth: 'standard' })).toMatchObject({ ok: true })
    expect(calls).toEqual(['s9:quick', 's1:standard'])
    expect((await service.depthAct({ depth: 'max' as never })).ok).toBe(false)
    expect((await service.depthAct({ sessionId: 'x'.repeat(201), depth: 'deep' })).ok).toBe(false)
    const noSession = createUiService({ stores: minimalStores, setDepth: () => {} })
    expect((await noSession.depthAct({ depth: 'deep' })).ok).toBe(false)
    expect((await createUiService({ stores: minimalStores, currentSession: () => 's1' }).depthAct({ depth: 'deep' })).text)
      .toContain('未接线')
    const broken = createUiService({
      stores: minimalStores,
      currentSession: () => 's1',
      setDepth: () => {
        throw new Error('focus 坏了')
      },
    })
    const isolated = await broken.depthAct({ depth: 'deep' })
    expect(isolated.ok).toBe(false)
    expect(isolated.text).toContain('已隔离')
  })

  // ── v4.21.0：历史会话真实标题 ─────────────────────────────────────
  it('sessionTitle()：trim/长度校验、端口透传、未接线与异常都回退 null', async () => {
    const calls: string[] = []
    const catalog = {
      list: async () => ({ available: true, items: [] }),
      title: async (id: string) => {
        calls.push(id)
        return id === 'known' ? '真标题' : null
      },
    }
    const service = createUiService({ stores: minimalStores, sessionCatalog: catalog as never, clock: fixedClock() })
    await expect(service.sessionTitle('  known  ')).resolves.toEqual({ title: '真标题' })
    await expect(service.sessionTitle('')).resolves.toEqual({ title: null })
    await expect(service.sessionTitle('x'.repeat(201))).resolves.toEqual({ title: null })
    expect(calls).toEqual(['known'])

    const absent = await createUiService({ stores: minimalStores }).sessionTitle('known')
    expect(absent.title).toBeNull()
    const broken = createUiService({
      stores: minimalStores,
      sessionCatalog: {
        list: async () => ({ available: true, items: [] }),
        title: async () => {
          throw new Error('会话文件坏了')
        },
      } as never,
    })
    expect((await broken.sessionTitle('known')).title).toBeNull()
  })
})
