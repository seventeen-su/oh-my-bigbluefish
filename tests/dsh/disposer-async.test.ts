/**
 * 宿主 disposer 的**异步收尾契约**。
 *
 * ## 为什么要这条
 *
 * 内核的 `dispose()` 是同步的：它逐个调用模块 disposer，但**不等待**返回 Promise
 * 的那些。而模块收尾几乎都是异步的（关 SQLite 句柄、flush 向量队列）。
 * 所以同步 `dispose()` 返回时，"卸载完成"这句话并不成立。
 *
 * **内核行是唯一知道全部模块收尾何时结束的地方**，它有责任把这个事实交出去。
 * 于是 `dsh/plugin.ts` 返回的 disposer 带一个 `.async()`：宿主愿意等就等。
 *
 * ## 为什么不自接把返回的函数写成 `async`
 *
 * 宿主可能**同步调用** disposer 并丢掉返回值。`async` 函数同步调用时函数体照样
 * 跑到第一个 await，但**返回值没有地方 await**——"卸载完成"依然不成立，
 * 而且签名变化会让宿主拿到一个它没期待的 Promise。所以保留同步签名，
 * 把异步收尾作为**函数属性**挂上去。
 *
 * ## 这条测试盯的是什么
 *
 * 不是"dispose 被调用了"，而是：**`.async()` 返回时异步 disposer 真的已经完成**。
 * 用延迟 resolve 的 disposer 构造——若实现里少了 `await`，断言必失败。
 */
import { describe, expect, it } from 'vitest'

import { createKernel } from '../../kernel/index.js'
import type { ModuleRegistration } from '../../kernel/abi/index.js'

/** 一个最小模块：apply 返回一个记录调用的异步 disposer。 */
function slowModule(id: string, log: string[], delayMs: number): ModuleRegistration<unknown> {
  return {
    manifest: {
      id,
      version: '0.0.0',
      requires: [],
      capabilities: [],
      configSchema: { parse: () => ({}) },
      tools: [],
    },
    apply: () => async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      log.push(`disposed:${id}`)
    },
  } as unknown as ModuleRegistration<unknown>
}

describe('内核注销：异步 disposer 必须被等待', () => {
  it('disposeAsync() 返回时，延迟的异步 disposer 已经跑完', async () => {
    const log: string[] = []
    const handle = createKernel()
    handle.start([slowModule('m-slow', log, 30)], undefined, undefined)

    // 同步 dispose() 只**发起**注销，不等 Promise
    handle.dispose()
    expect(log, '同步路径不保证异步完成（这是它被写明的限制）').toEqual([])

    // disposeAsync() 明确定义为可在 dispose() 之后补等
    await handle.disposeAsync()
    expect(log, 'await 之后副作用必须已完成').toEqual(['disposed:m-slow'])
  })

  it('disposeAsync() 单独调用也能等待完成', async () => {
    const log: string[] = []
    const handle = createKernel()
    handle.start([slowModule('m2', log, 20)], undefined, undefined)

    await handle.disposeAsync()
    expect(log).toEqual(['disposed:m2'])
  })

  it('单个 disposer reject 不阻止其余，也不让 disposeAsync 抛出（H-1）', async () => {
    const log: string[] = []
    const handle = createKernel()
    handle.start(
      [
        {
          manifest: {
            id: 'm-bad',
            version: '0.0.0',
            requires: [],
            capabilities: [],
            configSchema: { parse: () => ({}) },
            tools: [],
          },
          apply: () => async () => {
            throw new Error('故意失败')
          },
        } as unknown as ModuleRegistration<unknown>,
        slowModule('m-good', log, 5),
      ],
      undefined,
      undefined,
    )

    await expect(handle.disposeAsync()).resolves.toBeUndefined()
    expect(log, '坏的那个不能阻止好的那个完成').toEqual(['disposed:m-good'])
  })

  it('重复调用不会重复释放（幂等）', async () => {
    const log: string[] = []
    const handle = createKernel()
    handle.start([slowModule('m-once', log, 5)], undefined, undefined)

    handle.dispose()
    await handle.disposeAsync()
    await handle.disposeAsync()
    expect(log, '同一个 disposer 只能被释放一次').toEqual(['disposed:m-once'])
  })
})
