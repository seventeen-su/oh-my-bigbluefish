/**
 * 「会话→cwd」与「已打开项目库」在**同一次 `omb_status` 里只出现一次**。
 *
 * ## 这条测试针对的实测缺陷
 *
 * 同一次 `omb_status`：
 * ```
 * 模块段（omb-memory 那行）：项目库 0/16 已打开；本模块会话→cwd 登记 0 条
 * 存储段（## 存储）        ：项目库 1/16 已打开：D:\…；内核会话→cwd 登记 1 条
 * ```
 * 三次调用都一样——不是抖动。根因是**同一份事实存了两遍 + 报了两遍**：
 * 内核健康面保存的是模块**最近一次上报的快照**（`kernel/health.ts`），
 * 而「存储」段读的是实时状态。这一版把三件事都收敛掉了：
 * ① 会话 → cwd 只存在内核 `ActiveSessionTable`（`SERVICES.activeSession`）
 * ② 记忆模块不再自己存：`forSession`/`peek` 按需读唯一来源
 * ③ 两个数字只在「存储」段报，模块行只报自有事实并指向它
 *
 * 装法照 `tests/dsh/assembly.smoke.test.ts`：**真内核 + 真模块清单 + testHostContext**，
 * 并且会话事件走**真的 `wireSessionEvents`**（不是直接往表里塞值），
 * 这样"宿主观测 → 唯一来源 → 模块开库 → 状态面"整条链都在测试里。
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync } from '../../dsh/modules.js'
import { testHostContext } from '../../dsh/plugin.js'
import { wireSessionEvents } from '../../dsh/session.js'
import { renderStatus } from '../../dsh/status-tool.js'
import { STORAGE_HOST_SERVICE } from '../../modules/memory/index.js'
import { projectIdentity } from '../../modules/memory/paths.js'
import type { MemoryStoresService } from '../../modules/memory/store.js'
import type { ActiveSessionTable } from '../../kernel/activeSession.js'
import { capturingLogger, tempWorkspace, testPort, type TempWorkspace } from '../modules/memory/helpers.js'

/** 出现次数（判据是"只能出现一次"，所以要数，不能只看包含）。 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

interface Assembly {
  readonly text: string
  readonly handle: ReturnType<typeof createKernel>
  readonly sessions: ActiveSessionTable
  readonly service: MemoryStoresService
  /** 触发一次真实的宿主会话事件（走 `wireSessionEvents`）。 */
  emitSession(sessionId: string, cwd: string | undefined): void
  dispose(): void
}

/**
 * 等一个断言成立（有界轮询）。
 *
 * 用途：模块的**首次健康上报**是异步的（`service.start().then(() => kernel.report(…))`，
 * 开库本来就要等宿主 sqlite）。在那之前内核健康面给的是"已挂载但未自报健康"占位行，
 * 直接拿它断言模块行内容会因为时序而随机失败。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return predicate()
}

/** 模块行文本（模块自报的健康 = `omb_status` 的「模块」段那一行）。 */
function moduleRowOf(handle: ReturnType<typeof createKernel>): string {
  return handle.health()['omb-memory']?.detail ?? ''
}

/**
 * 装配（照 `tests/dsh/assembly.smoke.test.ts` 的装法）。
 *
 * **必须 `await`**：`toHostPlugin(...).apply()` 的挂载在后台微任务里完成
 * （`kernel/hostEntry.ts` 的注释解释了为什么不能同步挂载），
 * 一次 `await` 让那些微任务先跑完，之后服务表才是完整的。
 */
async function assemble(ws: TempWorkspace): Promise<Assembly> {
  const handle = createKernel({ logger: capturingLogger() })
  // 真实路径里由内核行把内核发布到宿主服务表；存储端口由 `dsh/stores.ts` 提供。
  handle.kernel.provide(SERVICES.kernel, handle.kernel)
  handle.kernel.provide(STORAGE_HOST_SERVICE, testPort(ws.dir))

  const loaded = loadModulesSync(MODULE_ENTRIES)
  expect(loaded.failures, `模块入口未装配：${JSON.stringify(loaded.failures)}`).toEqual([])
  const host = testHostContext(handle)
  for (const registration of loaded.modules) {
    toHostPlugin(registration).apply(host)
  }
  await Promise.resolve()

  // 宿主事件面替身：只为 `session/event` 留一个可手动触发的订阅者
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const ctx = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
  }
  const disposeEvents = wireSessionEvents({ ctx: ctx as never, kernel: handle.kernel })

  const sessions = handle.kernel.service<ActiveSessionTable>(SERVICES.activeSession)
  const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
  if (sessions === undefined || service === undefined) {
    throw new Error(
      `装配缺失：会话登记处=${String(sessions !== undefined)}，存储服务=${String(service !== undefined)}；`
      + `已注册服务：${handle.kernel.services().join('、')}`,
    )
  }

  return {
    text: renderStatus({ handle }),
    handle,
    sessions,
    service,
    emitSession: (sessionId, cwd) => {
      const listener = listeners.get('session/event')
      if (listener === undefined) throw new Error('wireSessionEvents 没有订阅 session/event')
      const session = cwd === undefined ? { id: sessionId } : { id: sessionId, header: { cwd } }
      listener(session, { type: 'step/start', data: { step: 1 } })
    },
    dispose: () => {
      disposeEvents()
      handle.dispose()
    },
  }
}

describe('会话→cwd 与已打开项目库：状态面只报一处，且读的是同一份事实', () => {
  it('没有会话时：两个数字各出现一次，都是 0（模块行不报第二份）', async () => {
    const ws = tempWorkspace('omb-cwd-source-')
    const asm = await assemble(ws)

    expect(countOf(asm.text, '已打开项目库')).toBe(1)
    expect(countOf(asm.text, '会话→cwd')).toBe(1)
    expect(asm.text).toContain('已打开项目库：0 个（上限 16）')
    expect(asm.text).toContain('会话→cwd 登记：0 条')

    // 模块行只报自有事实，并指向「存储」段——它进的是上报快照。
    // 首次上报是异步的（开库要等宿主 sqlite），所以这里等它落地再断言。
    await waitFor(() => moduleRowOf(asm.handle).includes('见「存储」段'))
    const moduleRow = moduleRowOf(asm.handle)
    expect(moduleRow).toContain('见「存储」段')
    expect(moduleRow).not.toMatch(/已打开项目库|会话→cwd|项目库 \d/)

    asm.dispose()
    ws.cleanup()
  })

  it('宿主观测到会话 cwd 后：存储段 1 个 / 1 条，模块段不出现任何数字', async () => {
    const ws = tempWorkspace('omb-cwd-source-')
    const asm = await assemble(ws)

    // **真的走一遍 dsh 的会话事件路径**：宿主事件 → 唯一来源
    asm.emitSession('s1', ws.dir)
    expect(asm.sessions.cwd('s1')).toBe(ws.dir)
    expect(asm.sessions.sessions()).toEqual(['s1'])

    // 模块按需从唯一来源解析出项目库并打开它（生产里由 turn/start 预热驱动）
    const set = await asm.service.forSession('s1')
    expect(set?.projectScope).toBe(projectIdentity(ws.dir))
    expect(asm.service.status().openProjects).toEqual([projectIdentity(ws.dir)])

    const text = renderStatus({ handle: asm.handle })
    expect(countOf(text, '已打开项目库')).toBe(1)
    expect(countOf(text, '会话→cwd')).toBe(1)
    expect(text).toContain('已打开项目库：1 个（上限 16）')
    expect(text).toContain('会话→cwd 登记：1 条')
    // 状态面给出的项目库路径就是刚才那一份（同一个 openProjects 口径）
    expect(text).toContain(projectIdentity(ws.dir))

    await waitFor(() => moduleRowOf(asm.handle).includes('记忆库就绪'))
    const moduleRow = moduleRowOf(asm.handle)
    expect(moduleRow).toContain('记忆库就绪')
    expect(moduleRow).not.toMatch(/已打开项目库|会话→cwd|项目库 \d/)

    // 评审片段：把装配后的**真实渲染**打进测试输出，便于人眼核对"数字只出现一次"
    console.log(`\n===== 装配后的 omb_status（真实渲染）=====\n${text}\n===== 片段结束 =====`)

    asm.dispose()
    ws.cleanup()
  })

  it('唯一来源一改，状态面立刻一致（没有第二份副本可以"落后一步"）', async () => {
    const ws = tempWorkspace('omb-cwd-source-')
    const asm = await assemble(ws)

    asm.emitSession('s1', ws.dir)
    await asm.service.forSession('s1')
    expect(renderStatus({ handle: asm.handle })).toContain('会话→cwd 登记：1 条')

    // 会话结束：来源忘掉它 → 状态面立刻报 0，**不会**残留"1 条"
    asm.sessions.forget('s1')
    const after = renderStatus({ handle: asm.handle })
    expect(countOf(after, '会话→cwd')).toBe(1)
    expect(after).toContain('会话→cwd 登记：0 条')
    expect(after).not.toContain('会话→cwd 登记：1 条')
    // 项目库是**另一个事实**（连接仍开着）：仍报 1 个，且也只报一次
    expect(countOf(after, '已打开项目库')).toBe(1)
    expect(after).toContain('已打开项目库：1 个（上限 16）')
    // 模块行同样没有残留数字
    expect(moduleRowOf(asm.handle)).not.toMatch(/会话→cwd|已打开项目库/)

    asm.dispose()
    ws.cleanup()
  })

  it('写入入口只剩一个：存储服务上不再有 rememberCwd（第二份存储的 API 已删除）', async () => {
    const ws = tempWorkspace('omb-cwd-source-')
    const asm = await assemble(ws)

    expect('rememberCwd' in (asm.service as unknown as Record<string, unknown>)).toBe(false)

    asm.dispose()
    ws.cleanup()
  })

  it('内核注销时清空唯一来源（重挂后不会按上一代的会话 cwd 开库）', async () => {
    const ws = tempWorkspace('omb-cwd-source-')
    const asm = await assemble(ws)

    asm.emitSession('s1', ws.dir)
    expect(asm.sessions.sessions()).toEqual(['s1'])

    asm.handle.dispose()
    expect(asm.sessions.sessions()).toEqual([])
    expect(asm.sessions.current()).toBeNull()
    expect(asm.sessions.cwd('s1')).toBeNull()

    ws.cleanup()
  })
})
