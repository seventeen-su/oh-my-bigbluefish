/**
 * 通知桥测试。
 *
 * 本轮的验收点：
 * ① `isDesktopNotifyLike` 的形状探测（含"声明了但类型不对"）
 * ② 未装通知服务 → **全静默**（push 返回 false、绝不抛），`status().detail` 可读
 * ③ 保留三条约束：同 kind 30 分钟、内容去重、单会话上限 10
 * ④ **零改码自动接上**：解析器后来能取到服务时，同一条桥立刻开始工作
 */
import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../../kernel/abi/index.js'
import {
  DEFAULT_NOTIFY_SESSION,
  isDesktopNotifyLike,
  NOTIFY_SESSION_LIMIT,
  NOTIFY_THROTTLE_MS,
  NotifyBridge,
} from '../../../modules/notify/bridge.js'

function logger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
}

function clock(start = 0): { now(): number; advance(ms: number): void } {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('isDesktopNotifyLike：形状探测不猜', () => {
  it('既无 push 也无 pushAlways → 否（数组必须排除：它自带 push）', () => {
    for (const bad of [undefined, null, 42, 'push', [], [1, 2], {}, { push: 1 }, { pushAlways: 'x' }, { push: 1, pushAlways: () => {} }]) {
      expect(isDesktopNotifyLike(bad)).toBe(false)
    }
  })

  it('有 push 或有 pushAlways（函数）→ 是', () => {
    expect(isDesktopNotifyLike({ push: () => {} })).toBe(true)
    expect(isDesktopNotifyLike({ pushAlways: () => {} })).toBe(true)
    expect(isDesktopNotifyLike({ push: () => {}, pushAlways: () => {} })).toBe(true)
  })

  it('类实例（原型上的方法）也认', () => {
    class Notifier {
      push(): void {}
    }
    expect(isDesktopNotifyLike(new Notifier())).toBe(true)
  })
})

describe('未安装：全静默降级', () => {
  it('push 返回 false、绝不抛，且说明写进 status().detail', () => {
    const bridge = new NotifyBridge({ notify: undefined, clock: clock(), logger: logger() })
    expect(() => bridge.push('any', '标题')).not.toThrow()
    expect(bridge.push('any', '标题')).toBe(false)

    const status = bridge.status()
    expect(status.available).toBe(false)
    expect(status.detail).toContain('宿主未安装 desktopNotify 服务')
    expect(status.detail).toContain('未安装 desktopNotify')
    expect(status.detail).toContain('静默降级')
    expect(status.suppressed).toBeGreaterThan(0)
    expect(status.lastReason).not.toBeNull()
  })

  it('形状不匹配时原因不同（不把"装错了"说成"没装"）', () => {
    const bridge = new NotifyBridge({ notify: { whatever: true } as never, clock: clock(), logger: logger() })
    expect(bridge.push('any', '标题')).toBe(false)
    expect(bridge.status().detail).toContain('形状不匹配')
  })

  it('解析器抛异常也不外传', () => {
    const bridge = new NotifyBridge({
      notify: undefined,
      clock: clock(),
      logger: logger(),
      resolve: () => {
        throw new Error('ctx.get 炸了')
      },
    })
    expect(() => bridge.push('any', '标题')).not.toThrow()
    expect(bridge.status().available).toBe(false)
  })
})

describe('已安装：节流、去重、上限', () => {
  it('正常发出一次；同 kind 30 分钟内不再发', () => {
    const sent: string[] = []
    const time = clock()
    const bridge = new NotifyBridge({
      notify: { push: (payload: { title: string }) => { sent.push(payload.title) } },
      clock: time,
      logger: logger(),
    })

    expect(bridge.push('k', '第一条')).toBe(true)
    expect(bridge.push('k', '第二条')).toBe(false)
    expect(sent).toEqual(['第一条'])

    time.advance(NOTIFY_THROTTLE_MS)
    expect(bridge.push('k', '第三条')).toBe(true)
    expect(sent).toEqual(['第一条', '第三条'])
  })

  it('同会话内相同内容只发一次；跨会话各自独立，resetSession 可重新放行', () => {
    const sent: string[] = []
    const time = clock()
    const bridge = new NotifyBridge({ notify: { push: (payload: { title: string }) => { sent.push(payload.title) } }, clock: time, logger: logger() })
    expect(bridge.push('k', '重复内容')).toBe(true)

    time.advance(NOTIFY_THROTTLE_MS * 2) // 同 kind 窗口早已过期
    expect(bridge.push('k', '重复内容')).toBe(false) // 仍被内容去重挡住
    expect(bridge.status().lastReason).toContain('内容重复')

    expect(bridge.push('k', '重复内容', undefined, 'session-2')).toBe(true) // 另一个会话独立
    expect(sent).toHaveLength(2)

    bridge.resetSession('session-2')
    time.advance(NOTIFY_THROTTLE_MS * 2)
    expect(bridge.push('k', '重复内容', undefined, 'session-2')).toBe(true)
  })

  it('单会话上限 10 条；另一个会话不受影响', () => {
    const sent: string[] = []
    const bridge = new NotifyBridge({ notify: { push: (payload: { title: string }) => { sent.push(payload.title) } }, clock: clock(), logger: logger() })
    for (let i = 0; i < NOTIFY_SESSION_LIMIT; i += 1) {
      expect(bridge.push(`kind-${i}`, `消息 ${i}`)).toBe(true)
    }
    expect(bridge.push('kind-extra', '第十一条')).toBe(false)
    expect(sent).toHaveLength(NOTIFY_SESSION_LIMIT)
    expect(bridge.push('kind-extra', '第十一条', undefined, 'session-2')).toBe(true)
    expect(bridge.status().lastReason).toContain('上限')

    bridge.resetSession(DEFAULT_NOTIFY_SESSION)
    // 换一个 kind：同 kind 的 30 分钟窗口是独立的约束，这里只验证会话计数被重置
    expect(bridge.push('kind-final', '第十一条')).toBe(true)
  })

  it('优先用 push；只有 pushAlways 时用它', () => {
    const pushed: string[] = []
    const always: string[] = []
    const withBoth = new NotifyBridge({
      notify: { push: (payload: { title: string }) => { pushed.push(payload.title) }, pushAlways: (payload: { title: string }) => { always.push(payload.title) } },
      clock: clock(),
      logger: logger(),
    })
    expect(withBoth.push('k', 'a')).toBe(true)
    expect(pushed).toEqual(['a'])
    expect(always).toEqual([])

    const onlyAlways = new NotifyBridge({
      notify: { pushAlways: (payload: { title: string }) => { always.push(payload.title) } },
      clock: clock(),
      logger: logger(),
    })
    expect(onlyAlways.push('k', 'b')).toBe(true)
    expect(always).toEqual(['b'])
    expect(onlyAlways.status().detail).toContain('pushAlways')
  })

  it('宿主推送抛异常 → 返回 false，不向上抛，原因可读', () => {
    const log = logger()
    const bridge = new NotifyBridge({
      notify: {
        push: () => {
          throw new Error('通知服务崩了')
        },
      },
      clock: clock(),
      logger: log,
    })
    expect(() => bridge.push('k', 'm')).not.toThrow()
    expect(bridge.push('k', 'm')).toBe(false)
    expect(log.warn).toHaveBeenCalled()
    expect(bridge.status().lastReason).toContain('通知服务崩了')
  })

  it('异步拒绝被吞掉（不产生未处理拒绝），但仍记为已发', async () => {
    const log = logger()
    const bridge = new NotifyBridge({
      notify: { push: () => Promise.reject(new Error('异步失败')) },
      clock: clock(),
      logger: log,
    })
    expect(bridge.push('k', 'm')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log.warn).toHaveBeenCalled()
    expect(bridge.status().sent).toBe(1)
  })
})

describe('零改码自动接上', () => {
  it('同一条桥：宿主服务后来才出现 → 下一次推送立刻开始工作', () => {
    // 用可变容器模拟宿主服务表：桥每次推送重新解析，因此不需要重建桥
    const hostSlot: { value: unknown } = { value: undefined }
    const sent: { title: string; urgency?: string }[] = []
    const bridge = new NotifyBridge({
      notify: undefined, // 建桥时还没有
      clock: clock(),
      logger: logger(),
      resolve: () => hostSlot.value,
    })

    expect(bridge.push('k', '装之前')).toBe(false)
    expect(bridge.status().available).toBe(false)

    // dsh-desktop-notify 更新后宿主能取到服务 → 桥无需改动、无需重启
    hostSlot.value = { push: (payload: { title: string; urgency?: string }) => { sent.push(payload) } }
    expect(bridge.status().available).toBe(true)
    expect(bridge.push('k', '装之后')).toBe(true)
    expect(sent).toEqual([{ title: '装之后', urgency: 'normal' }])
    expect(bridge.status().detail).toContain('已接上宿主 desktopNotify')
  })

  it('宿主服务消失（插件被卸下）→ 自动回到静默降级', () => {
    const hostSlot: { value: unknown } = { value: { push: () => {} } }
    const bridge = new NotifyBridge({
      notify: undefined,
      clock: clock(),
      logger: logger(),
      resolve: () => hostSlot.value,
    })
    expect(bridge.push('k', 'a')).toBe(true)
    hostSlot.value = undefined
    expect(bridge.push('k2', 'b')).toBe(false)
    expect(bridge.status().available).toBe(false)
  })

  it('配了解析器时以它为准，不回落到装载时的快照（避免状态面自相矛盾）', () => {
    // **这条来自一次真实自检报告**：同一次 `omb_status` 里，
    // 模块行说「宿主未安装 desktopNotify 服务」，组件自述却说
    // 「已接上宿主 desktopNotify（通道 push）」——两种说法相反。
    //
    // 成因是两个内核实例各有一个桥：工具那个实例的 `resolve` 取不到宿主服务
    // （宿主服务只发布给行实例），于是回落到**装载时快照**里的那份。
    //
    // `resolve` 的契约是"每次推送时重新解析"，它就是权威。回落到陈旧快照
    // 等于让状态面报一个已经不成立的好消息——**那比报"不可用"更坏**，
    // 因为它会让人以为通知在工作。
    const snapshotted = { push: () => {} }
    const bridge = new NotifyBridge({
      notify: snapshotted,
      clock: clock(),
      logger: logger(),
      resolve: () => undefined, // 解析器说：现在没有
    })
    const status = bridge.status()
    expect(status.available, '解析器说了算，不能靠装载时的快照报可用').toBe(false)
    expect(status.detail).toContain('未安装 desktopNotify')
    expect(bridge.push('k', '标题')).toBe(false)
  })

  it('没配解析器时才用装载时给的实例', () => {
    const bridge = new NotifyBridge({
      notify: { push: () => {} },
      clock: clock(),
      logger: logger(),
    })
    expect(bridge.status().available).toBe(true)
  })
})
