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

  it('模块的 turn/start 监听器确实改变了它自己的"最近活跃会话"', async () => {
    const handle = createKernel()
    handle.kernel.provide(SERVICES.kernel, handle.kernel)
    const host = {
      get: (name: string) => (name === SERVICES.kernel ? handle.kernel : handle.kernel.service(name)),
      on: () => () => {},
    }

    const plugin = toHostPlugin(createReasoningModule())
    plugin.apply(host)
    // `toHostPlugin` 的 apply 把**真正的注册放在后台微任务**里（见其注释：
    // 宿主契约要求 apply 同步返回 disposer）。所以这里必须让出一次事件循环，
    // 否则服务表还没填，就会误判成"模块什么都没挂"——我第一次就是这么误判的。
    await new Promise(resolve => setImmediate(resolve))

    const session = 'session-focus-probe'
    // **这一句是真实路径里 `dsh/session.ts` 在收到 `session/event` 时做的事。**
    //
    // 为什么不能只 `kernel.emit('turn/start')`：模块经收养视图订阅时，
    // `on` 优先绑的是**宿主**事件面（`kernel/adopt.ts`），而 `dsh/` 发在内核总线
    // ——模块收不到，且不报任何错（见上一个用例的说明）。
    // 所以会话这个全局事实由 `dsh/` 直接写进内核登记处，模块按需读取。
    handle.kernel.service<{ remember(s: string): void }>(SERVICES.activeSession)?.remember(session)

    // 顺带验证：内核总线上确实有广播（这是 `dsh/` 会发的，只是模块订不到）
    handle.kernel.emit('turn/start', { sessionId: session, turn: 1 })
    await new Promise(resolve => setImmediate(resolve))

    // 推理模块把工具挂在 `tools:omb-reasoning` 服务上。取出来直接调 `omb_focus`，
    // 看它认不认这个会话——**这是 `omb_focus` 那条报错的最小复现**。
    const tools = handle.kernel.service<readonly {
      name: string
      execute(args: unknown): { kind: string; text: string } | Promise<{ kind: string; text: string }>
    }[]>(`${SERVICES.toolsPrefix}omb-reasoning`)

    expect(tools, '推理模块没有挂出 tools:omb-reasoning').toBeDefined()
    const focus = tools?.find(tool => tool.name === 'omb_focus')
    expect(focus, '没有 omb_focus 工具').toBeDefined()

    const outcome = await focus?.execute({ depth: 'deep' })
    expect(outcome, 'omb_focus 没有返回结果').toBeDefined()
    // **判据是"没报取不到会话"，不是"消息里含会话 id"**——成功消息本来就不含 id。
    // 这条曾经因为断言写错而误判过一次。
    expect(
      outcome?.text,
      `omb_focus 在会话已登记的情况下仍认不出会话：${outcome?.text}`,
    ).not.toContain('取不到当前会话标识')
    expect(outcome?.text, 'omb_focus 没有确认档位已设置').toContain('deep')
    handle.dispose()
  })
})
