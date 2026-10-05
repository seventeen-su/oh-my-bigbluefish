/**
 * 宿主独有事件**没订上宿主事件面**时，必须变成**可见降级**。
 *
 * ## 这条判据针对的缺陷
 *
 * `HOST_ONLY_EVENTS`（`session/event`、`tool/call` …）只发在**宿主**事件面；
 * 而 `kernel/adopt.ts` 的 `on()` 在宿主侧失败时会**静默回落内核总线**——
 * 于是订阅"成功"、事件永不到来、健康面全绿。这正是本项目最难排查的失败形态
 * （"订阅注册成功、事件永远不来"已经踩过两次）。
 *
 * 所以这里钉三件事：
 * ① 没订上 → 至少一次 `logger.warn`，且点名事件；
 * ② 该模块**之后**的每一次 `report()` 都带上这条事实，并把 `ok` 降为 `degraded`
 *    （粘性：模块自报 ok 不能把它盖掉）；
 * ③ **反向断言**：宿主正常订上时不产生任何降级，内核总线事件也不该被误报
 *    （不能把真告警一起打开成噪音）。
 */
import { describe, expect, it } from 'vitest'
import { adoptContext } from '../../kernel/adopt.js'
import type { KernelCore } from '../../kernel/adopt.js'
import type { ContextPressure, FocusDepth, Kernel, ModuleHealth } from '../../kernel/abi/index.js'

/**
 * 订一个**宿主独有**事件名。
 *
 * `Kernel['on']` 的类型参数是 `keyof ModuleEvents`，而宿主独有事件（`session/event`、
 * `tools/result`…）**不在那个联合里**——它们只发在宿主事件面，运行时接受任意字符串。
 * 所以这里做一次显式放宽，并在注释里说明为什么**不得不**放宽：
 * 这条路径本来就没有类型面的入口（也正因如此，它静默失效过）。
 */
function hostOn(kernel: Kernel, event: string): () => void {
  const loose = kernel.on as unknown as (name: string, fn: () => void) => () => void
  return loose(event, () => {})
}

function fakeCore(): { core: KernelCore; warns: string[] } {
  const warns: string[] = []
  const core: KernelCore = {
    services: {
      get: () => undefined,
      names: () => [],
      provide: () => () => {},
    },
    on: () => () => {},
    emit: () => {},
    budget: () => undefined,
    pressure: () => ({}) as ContextPressure,
    focus: () => 'standard',
    setFocus: (_session: string, _depth: FocusDepth, _reason: string) => {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warns.push(message),
    },
    clock: { now: () => 0 },
  }
  return { core, warns }
}

describe('宿主独有事件订不上时不再静默', () => {
  it('宿主 on 返回非函数 → warn 一次 + 该模块健康上报粘性降级（点名事件）', () => {
    const { core, warns } = fakeCore()
    const reported: ModuleHealth[] = []
    // 宿主 ctx 的 on 返回 undefined = "没订上"（真宿主在 Guard 拒绝/无该服务时就是这样）
    const kernel = adoptContext({ on: () => undefined }, core, health => reported.push(health))

    expect(typeof hostOn(kernel, 'session/event')).toBe('function')
    expect(warns.some(message => message.includes('session/event'))).toBe(true)
    expect(warns.some(message => message.includes('回落'))).toBe(true)

    // 模块随后自报"一切正常"——**不能**把降级盖掉
    kernel.report({ state: 'ok', detail: '工具面与提示注入都在位' })
    const last = reported.at(-1)
    expect(last?.state).toBe('degraded')
    expect(last?.detail).toContain('宿主事件面订阅失败')
    expect(last?.detail).toContain('session/event')
    expect(last?.detail).toContain('工具面与提示注入都在位') // 原有 detail 不被吞掉
  })

  it('宿主 on 抛错 → 同样留声，且异常不逃出 on()', () => {
    const { core, warns } = fakeCore()
    const reported: ModuleHealth[] = []
    const kernel = adoptContext(
      {
        on: () => {
          throw new Error('cannot get property "on" without inject')
        },
      },
      core,
      health => reported.push(health),
    )

    expect(() => hostOn(kernel, 'tools/result')).not.toThrow()
    expect(warns.some(message => message.includes('tools/result'))).toBe(true)
    kernel.report({ state: 'ok', detail: 'x' })
    expect(reported.at(-1)?.state).toBe('degraded')
  })

  it('同一事件重复订阅只记一次（不许在事件总线上刷屏）', () => {
    const { core, warns } = fakeCore()
    const kernel = adoptContext({ on: () => undefined }, core, () => {})
    hostOn(kernel, 'session/event')
    hostOn(kernel, 'session/event')
    hostOn(kernel, 'session/event')
    const hits = warns.filter(message => message.includes('session/event'))
    expect(hits).toHaveLength(1)
  })

  it('反向断言：宿主订得上时不得降级（真告警不能被打开成噪音）', () => {
    const { core, warns } = fakeCore()
    const reported: ModuleHealth[] = []
    const kernel = adoptContext({ on: () => () => {} }, core, health => reported.push(health))

    hostOn(kernel, 'session/event')
    expect(warns).toHaveLength(0)
    kernel.report({ state: 'ok', detail: '一切正常' })
    expect(reported.at(-1)?.state).toBe('ok')
    expect(reported.at(-1)?.detail).toBe('一切正常')
  })

  it('反向断言：内核总线事件（非宿主独有）即使宿主订不上也不报降级', () => {
    const { core, warns } = fakeCore()
    const reported: ModuleHealth[] = []
    const kernel = adoptContext({ on: () => undefined }, core, health => reported.push(health))

    hostOn(kernel, 'turn/start') // 内核总线事件：宿主侧本来就不该订
    expect(warns).toHaveLength(0)
    kernel.report({ state: 'ok', detail: '一切正常' })
    expect(reported.at(-1)?.state).toBe('ok')
  })
})
