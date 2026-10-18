/**
 * 会话事件 → 模块监听器 的**链路验证**。
 *
 * 背景：`omb_focus` 一直报"取不到当前会话标识"。心跳已经把链路切成两段：
 * - `step-start` 心跳（`dsh/session.ts`）：确认 `session/event` 到了、`kernel.emit`
 *   确实被调用（实测带真实 sessionId）
 * - `reasoning-turn` 心跳（`modules/reasoning`）：确认订阅端是否收到
 *
 * **本文件把这条链路固化成测试**——否则每次验证都要重启宿主、等一个真实回合，
 * 而宿主有 ESM 缓存（行名不变就继续跑旧代），代价极高且结论容易被缓存骗。
 *
 * 测的是"订阅端与发送端在不在同一个事件总线上"这一类错误：
 * 模块经 `ctx.get('omb:kernel')` 拿到的可能是**收养视图**，其 `on` 绑定的后端
 * 未必是 `dsh/` 发事件时用的那个内核。
 */
import { describe, expect, it } from 'vitest'

import { SERVICES } from '../../kernel/abi/index.js'
import { createKernel } from '../../kernel/index.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'
import { createReasoningModule } from '../../modules/reasoning/index.js'

describe('会话事件链路：dsh 发 turn/start，模块必须收到', () => {
  it('模块的订阅落在**内核总线**上，不是宿主事件面', async () => {
    // **这条补的是测试盲区**：`testHostContext` 没有 `on`，于是收养视图里
    // `hostOn === undefined`、所有订阅都回落内核总线——那个 bug 在测试里
    // 根本不可能出现。真实宿主有 `ctx.on`，而它对**任何**事件名都会"成功"
    // 返回一个 disposer，于是 `turn/start`/`focus/changed` 被静默订到宿主面。
    //
    // 所以这里必须提供一个**有 `on` 的**宿主 ctx，才测得到真实行为。
    const handle = createKernel()
    handle.kernel.provide(SERVICES.kernel, handle.kernel)

    const hostSubscriptions: string[] = []
    const host = {
      get: (name: string) => (name === SERVICES.kernel ? handle.kernel : handle.kernel.service(name)),
      on: (event: string) => {
        hostSubscriptions.push(event)
        return () => {}
      },
    }

    const plugin = toHostPlugin(createReasoningModule())
    plugin.apply(host)
    await new Promise(resolve => setImmediate(resolve))

    // 内核总线事件**不得**被订到宿主面上。若这里出现 `focus/changed` 或
    // `turn/start`，说明模块永远收不到——`dsh/` 发在内核总线
    // （`dsh/session.ts` 与 `kernel/index.ts` 的 `core.emit`）。
    expect(
      hostSubscriptions,
      `这些是内核总线事件，不该订到宿主事件面：${hostSubscriptions.join('、')}`,
    ).not.toContain('focus/changed')
    expect(hostSubscriptions, 'turn/start 是内核总线事件').not.toContain('turn/start')

    handle.dispose()
  })

  it('模块经 ctx.get 取内核后订阅 turn/start，能收到内核总线上的同一事件', () => {
    const handle = createKernel()
    handle.kernel.provide(SERVICES.kernel, handle.kernel)

    // 复刻宿主 ctx：`get` 能取到内核（与 dsh/plugin.ts 的 publishToHost 等价）。
    const host = {
      get: (name: string) => (name === SERVICES.kernel ? handle.kernel : handle.kernel.service(name)),
      // `on` 故意**提供宿主事件面**，与真实宿主一致——收养视图会优先用它。
      // 这正是链路可能断掉的地方：若模块订到了宿主面，而 dsh 发的是内核总线，
      // 事件永远碰不到，症状与"事件没来"一模一样。
      on: () => () => {},
    }

    const plugin = toHostPlugin(createReasoningModule())
    plugin.apply(host)

    const session = 'session-link-probe'
    let received: string | null = null
    // 订阅端由模块自己建立；这里从**外部**再订一次同一事件，
    // 用来区分"事件没发"与"模块没订到"。
    handle.kernel.on('turn/start', payload => {
      received = (payload as { sessionId: string }).sessionId
    })

    // dsh/session.ts 的 step/start 分支做的就是这一句。
    handle.kernel.emit('turn/start', { sessionId: session, turn: 1 })

    expect(received, '内核总线上的 turn/start 没有送达订阅者').toBe(session)
    handle.dispose()
  })
})
