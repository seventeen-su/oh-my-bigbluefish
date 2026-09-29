/**
 * 内核生命周期测试：**disposer 的归属与异步闭合**。
 *
 * 原实现的两个缺陷（已由下面的用例钉住）：
 * ① `mount()` 返回的 disposer 直接交给宿主，**不进内核的注销集合**——
 *    宿主若忘了调（或只调了内核的 `dispose`），模块永远不会卸载；
 * ② `dispose()` 对每个 disposer 执行 `void disposer()`——**返回 Promise 的不被等待**，
 *    于是 `dispose()` 返回后卸载未必完成（"注销完成了"是假的）。
 *
 * 并守住 H-1：disposer 抛错/reject 一律隔离，绝不上抛，且不得阻止其余 disposer。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Kernel, ModuleRegistration } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'

function mod(
  id: string,
  requires: readonly string[] = [],
  apply: (kernel: Kernel, config: unknown) => void | (() => void | Promise<void>) = () => {},
): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '1.0.0',
      requires,
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: 'test' }),
    },
    apply,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

describe('disposer 归属：mount() 也进内核的注销集合', () => {
  it('handle.dispose() 会调用 mount 返回的 disposer（宿主没调也不会漏）', () => {
    const h = createKernel()
    let calls = 0
    h.mount(mod('m', [], () => () => { calls += 1 }))
    h.dispose()
    expect(calls).toBe(1)
  })

  it('start() 与 mount() 的 disposer 在同一份集合里，按注册逆序执行', () => {
    const h = createKernel()
    const order: string[] = []
    h.start([mod('s', [], () => () => { order.push('start') })])
    h.mount(mod('m', [], () => () => { order.push('mount') }))
    h.dispose()
    expect(order).toEqual(['mount', 'start'])
  })

  it('apply 没返回函数时不登记空 disposer（无副作用）', () => {
    const h = createKernel()
    expect(() => {
      h.mount(mod('m', [], () => {}))
      h.dispose()
    }).not.toThrow()
  })
})

describe('异步闭合：disposeAsync 等待全部 disposer', () => {
  it('返回 Promise 的 disposer 被**等待**（await 之后副作用已完成）', async () => {
    const h = createKernel()
    let finished = false
    h.mount(mod('m', [], () => () => delay(10).then(() => { finished = true })))
    const pending = h.disposeAsync()
    expect(finished, '不应在 disposer 完成前就 resolve').toBe(false)
    await pending
    expect(finished).toBe(true)
  })

  it('多个异步 disposer 全部完成后 disposeAsync 才 resolve', async () => {
    const h = createKernel()
    const done: string[] = []
    h.mount(mod('slow', [], () => async () => { await delay(20); done.push('slow') }))
    h.mount(mod('fast', [], () => async () => { await delay(5); done.push('fast') }))
    await h.disposeAsync()
    expect(done.sort()).toEqual(['fast', 'slow'])
  })

  it('同步 dispose() 不等待（限制如实写进类型与注释），但执行仍会开始', async () => {
    const h = createKernel()
    let finished = false
    h.mount(mod('m', [], () => async () => { await delay(10); finished = true }))
    h.dispose()
    expect(finished, '同步路径**不保证**异步 disposer 已完成').toBe(false)
    await delay(30)
    expect(finished, '不等待不等于不执行——disposer 仍会跑完').toBe(true)
  })

  it('dispose() 之后再用 disposeAsync() 会补等尚未完成的 disposer', async () => {
    const h = createKernel()
    let finished = false
    h.mount(mod('m', [], () => async () => { await delay(10); finished = true }))
    h.dispose()
    expect(finished).toBe(false)
    await h.disposeAsync()
    expect(finished).toBe(true)
  })
})

describe('幂等：内核与宿主不会双重释放', () => {
  it('宿主先调 mount 的 disposer，内核再 dispose → 只调用一次', () => {
    const h = createKernel()
    const disposer = vi.fn()
    const hostDisposer = h.mount(mod('m', [], () => disposer))
    hostDisposer()
    h.dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })

  it('dispose() 重复调用 → 只调用一次', () => {
    const h = createKernel()
    const disposer = vi.fn()
    h.mount(mod('m', [], () => disposer))
    h.dispose()
    h.dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })

  it('disposeAsync() 先执行，宿主迟到的 disposer 调用不重复释放', async () => {
    const h = createKernel()
    const disposer = vi.fn()
    const hostDisposer = h.mount(mod('m', [], () => disposer))
    await h.disposeAsync()
    hostDisposer()
    expect(disposer).toHaveBeenCalledTimes(1)
  })

  it('dispose() 与 disposeAsync() 混用也只释放一次', async () => {
    const h = createKernel()
    const disposer = vi.fn()
    h.mount(mod('m', [], () => disposer))
    h.dispose()
    await h.disposeAsync()
    h.dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })
})

describe('H-1 不回退：单个 disposer 失败不连坐', () => {
  it('同步抛错 + 异步 reject 都不阻止其余 disposer，且都记日志', async () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const order: string[] = []
    h.mount(mod('a', [], () => () => { order.push('a'); throw new Error('sync boom') }))
    h.mount(mod('b', [], () => () => Promise.reject(new Error('async boom'))))
    h.mount(mod('c', [], () => () => { order.push('c') }))
    await expect(h.disposeAsync()).resolves.toBeUndefined()
    expect(order).toEqual(['c', 'a'])
    expect(warn).toHaveBeenCalled()
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain('sync boom')
    expect(logged).toContain('async boom')
  })

  it('dispose() 遇到抛错的 disposer 也不抛（宿主同步路径）', () => {
    const h = createKernel()
    h.mount(mod('a', [], () => () => { throw new Error('dispose boom') }))
    expect(() => h.dispose()).not.toThrow()
  })
})
