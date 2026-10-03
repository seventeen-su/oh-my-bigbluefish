/**
 * `dsh-desktop-notify` **2.0.0 协议**（对外 API 基线 `1.0.0`）的对接测试。
 *
 * 为什么单开一个文件：这一组断言全部来自对方 2.0.0 的 `src/api.ts`，逐条都能指到出处，
 * 与"桥自己的节流/去重"是两回事。三条关键事实：
 *
 * 1. `push` 与 `notify` 是**同一个 `deliver()`**（门控完全相同），只有返回不同——
 *    所以"优先用 `notify`"**不改变门控语义**，只是把 `false` 变成可读原因；
 * 2. `pushAlways` 才是**绕过聚焦门控**的那一个，因此它排最后；
 * 3. `capabilities` 是协议指定的能力探测入口，协议明说"不要靠版本号猜"。
 *
 * 反向断言也在场：不声明 `capabilities` 的老实现必须照样能用——
 * 探测是**增强**，不是新的门槛。
 */
import { describe, expect, it, vi } from 'vitest'
import { NOTIFY_API_BASELINE, NotifyBridge, type NotifyPayload } from '../../../modules/notify/bridge.js'

const CLOCK = { now: () => 1_000 }

/** 造一条桥；`host` 就是 `ctx.get('desktopNotify')` 的产物。 */
function bridgeWith(host: unknown, warn = vi.fn()): { bridge: NotifyBridge; warn: ReturnType<typeof vi.fn> } {
  const bridge = new NotifyBridge({
    notify: undefined,
    clock: CLOCK,
    logger: { debug: vi.fn(), info: vi.fn(), warn },
    resolve: () => host,
  })
  return { bridge, warn }
}

describe('2.0.0 协议：方法与能力探测', () => {
  it('push 与 notify 同时存在时优先用 notify（门控相同，但只有它能给出原因）', () => {
    const calls: string[] = []
    const host = {
      push: () => { calls.push('push'); return true },
      notify: () => { calls.push('notify'); return { ok: true, queued: true, silenced: false, reason: '' } },
    }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(true)
    expect(calls).toEqual(['notify'])
  })

  it('capabilities 声明了但**不含** notify → 退回 push（能力清单用来排除，不用来否决）', () => {
    const calls: string[] = []
    const host = {
      capabilities: ['push'],
      push: () => { calls.push('push'); return true },
      notify: () => { calls.push('notify'); return { queued: true } },
    }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(true)
    expect(calls).toEqual(['push'])
  })

  it('capabilities 是空数组 → 视为"没声明"，不做排除', () => {
    const calls: string[] = []
    const host = { capabilities: [], push: () => { calls.push('push'); return true } }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(true)
    expect(calls).toEqual(['push'])
  })

  it('只有 pushAlways 时才用它（它绕过聚焦门控，所以排最后）', () => {
    const calls: string[] = []
    const host = { pushAlways: () => { calls.push('pushAlways'); return true } }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(true)
    expect(calls).toEqual(['pushAlways'])
  })
})

describe('2.0.0 协议：返回值里的原因', () => {
  it('notify 回带 reason: api-disabled → 状态面写出"设置页关掉了对外 API"而不是裸 false', () => {
    const host = { notify: () => ({ ok: false, queued: false, silenced: false, reason: 'api-disabled' }) }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(false)
    const status = bridge.status()
    expect(status.suppressed).toBe(1)
    expect(status.lastReason).toContain('api-disabled')
    expect(status.lastReason, '原因必须可读，而不是把内部代号直接甩给用户').toContain('设置页关掉了对外 API')
  })

  it('notify 回带 reason: duplicate → 原样转述对方的判断（不覆盖成我们自己的猜测）', () => {
    const host = { notify: () => ({ queued: false, reason: 'duplicate' }) }
    const { bridge } = bridgeWith(host)
    expect(bridge.push('k', '标题')).toBe(false)
    expect(bridge.status().lastReason).toContain('duplicate')
  })

  it('unsupportedVersion 只记日志、**不阻断**推送（协议明说高主版本不中断）', () => {
    const warn = vi.fn()
    const host = {
      apiVersion: '2.0.0',
      notify: () => ({ queued: true, apiVersion: '2.0.0', unsupportedVersion: true }),
    }
    const { bridge } = bridgeWith(host, warn)
    expect(bridge.push('k', '标题'), '对方不认我们的版本，但推送仍然成功').toBe(true)
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('不受支持')
  })

  it('push 只回 boolean 时不编造原因：如实说"返回 false"而不是假装知道为什么', () => {
    const { bridge } = bridgeWith({ push: () => false })
    expect(bridge.push('k', '标题')).toBe(false)
    const reason = bridge.status().lastReason ?? ''
    expect(reason).toContain('返回 false')
    expect(reason, '没有明细就不要声称知道原因').not.toContain('api-disabled')
  })
})

describe('2.0.0 协议：载荷', () => {
  it('声明 API 基线版本，且不声明任何超出基线的东西', () => {
    const sent: NotifyPayload[] = []
    const { bridge } = bridgeWith({ push: (p: NotifyPayload) => { sent.push(p); return true } })
    bridge.push('k', '标题', '正文')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.v).toBe(NOTIFY_API_BASELINE)
  })

  it('click 四态原样透传（点通知能跳到插件页 = "关掉的前置怎么恢复"的现场）', () => {
    const sent: NotifyPayload[] = []
    const { bridge } = bridgeWith({ push: (p: NotifyPayload) => { sent.push(p); return true } })
    bridge.push('k', '标题', undefined, 's1', 'normal', { type: 'page', page: 'plugins' })
    expect(sent[0]?.click).toEqual({ type: 'page', page: 'plugins' })
  })

  it('不给 click 时不塞这个字段（对方对未知字段宽容，但没有理由多发）', () => {
    const sent: NotifyPayload[] = []
    const { bridge } = bridgeWith({ push: (p: NotifyPayload) => { sent.push(p); return true } })
    bridge.push('k', '标题')
    expect(sent[0] === undefined ? true : 'click' in sent[0]).toBe(false)
  })
})

describe('2.0.0 协议：状态面自述', () => {
  it('报出对方的对外 API 版本；旧实现（没这个字段）如实说"未声明"', () => {
    const withVersion = bridgeWith({ apiVersion: '1.0.0', push: () => true })
    expect(withVersion.bridge.status().detail).toContain('对外 API 1.0.0')

    const withoutVersion = bridgeWith({ push: () => true })
    expect(withoutVersion.bridge.status().detail).toContain('未声明对外 API 版本')
  })

  it('通道名与实际会用的方法一致（旧实现另判一遍，改完会显示成"通道 push"）', () => {
    const { bridge } = bridgeWith({
      capabilities: ['notify', 'push', 'click.page'],
      push: () => true,
      notify: () => ({ queued: true }),
    })
    const detail = bridge.status().detail
    expect(detail, '实际走 notify，就不能显示成 push').toContain('通道 notify')
    expect(detail).toContain('对方能力：notify、push、click.page')
  })
})
