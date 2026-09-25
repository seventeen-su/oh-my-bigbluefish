/**
 * 通知桥的**接线验证**：宿主 `desktopNotify` 服务必须真的被接到内核服务表上。
 *
 * ## 这条线曾经是断的（实测：通知一条都发不出去）
 *
 * `modules/notify` 的 `resolve` 只问内核服务表，而 `dsh/` **从来没有把宿主服务
 * 放进那张表**。于是 `resolve()` 永远返回 undefined，通知全部静默，
 * 状态面还报"未安装"。
 *
 * **佐证**：`dsh-path-guard` 的 `src/notify.js` 用 `ctx.get('desktopNotify')`
 * 直接取宿主服务，确实能投递；而 `dsh-desktop-notify` 的实现是
 * `ctx.provide('desktopNotify', …)`（`lib/index.js:445`）——服务在宿主容器里。
 *
 * ## 判据
 *
 * 不是"模块能挂载"，而是：**给一个宿主服务、放行一次推送，宿主真的被调用了**。
 */
import { describe, expect, it } from 'vitest'

import { NotifyBridge } from '../../modules/notify/bridge.js'

describe('通知桥接线：宿主服务必须被取到并真的调用', () => {
  it('以宿主对象为 this 调用宿主方法（摘出来的方法引用会 Illegal invocation）', () => {
    // 复刻 `dsh/plugin.ts` 里 forward() 的语义。
    const host = {
      calls: [] as string[],
      push(this: { calls: string[] }, payload: { title: string }): boolean {
        // 依赖 this：摘出来直接调会抛
        this.calls.push(payload.title)
        return true
      },
    }

    const forward = (payload: unknown): unknown => {
      const method = host.push
      return (method as (this: unknown, p: unknown) => unknown).call(host, payload)
    }

    const bridge = new NotifyBridge({
      notify: undefined,
      clock: { now: () => 1 },
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      // resolve 每次重新问 -> 与 dsh 侧"每次读都重新问宿主"同一机制
      resolve: () => ({ push: forward }),
    })

    expect(bridge.push('k', '标题', '正文')).toBe(true)
    expect(host.calls, '宿主方法必须真的被调用，且 this 正确').toEqual(['标题'])
  })

  it('宿主服务缺席时静默降级，不抛（H-3）', () => {
    const bridge = new NotifyBridge({
      notify: undefined,
      clock: { now: () => 1 },
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      resolve: () => undefined,
    })
    expect(bridge.push('k', '标题')).toBe(false)
    expect(bridge.status().available).toBe(false)
  })

  it('宿主服务后出现 → 下一次推送立刻可用（零改码自动接上）', () => {
    // path-guard 注释里那条 "enabling the plugin mid-session starts working
    // immediately" 的同一机制：resolve 每次重新求值。
    // 用可变容器模拟宿主服务表：`resolve` 每次读它，因此"后装上"能立刻生效。
    const slot: { value: { push(p: unknown): boolean } | undefined } = { value: undefined }
    const sent: string[] = []
    const bridge = new NotifyBridge({
      notify: undefined,
      clock: { now: () => 1 },
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      resolve: () => slot.value,
    })
    expect(bridge.push('k1', '第一次')).toBe(false)

    slot.value = { push: (p: unknown) => { sent.push((p as { title: string }).title); return true } }
    expect(bridge.push('k2', '第二次')).toBe(true)
    expect(sent).toEqual(['第二次'])
  })
})
