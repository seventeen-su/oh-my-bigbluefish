// 桌面通知桥测试（已知问题《待实现：与 dsh-desktop-notify 的兼容》）：
//   ① 接口契约：ctx.get('desktopNotify') 形状不合法 → 不接线（静默，不假装可用）
//   ② 门控语义：always 走 pushAlways（绕过聚焦门控）、普通走 push；返回值如实记录
//   ③ 节流与去重：同 kind 窗口内只发一次、内容相同不重复发、会话内总量上限
//   ④ 未安装零痕迹：无服务 → 全静默且**不记降级**（宿主没装插件不是故障）
//   ⑤ 载荷净化：空标题视为无效（与对方 normalizeNotifyItem 同口径）
//   ⑥ 白名单：不在 NOTIFY_KINDS 的事件不会成为通知（本模块没有"通用 notify"出口——见 notify.ts 说明）
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFY_POLICY,
  isDesktopNotifyLike,
  NotifyBridge,
  NOTIFY_KINDS,
  type NotifyItem,
} from '../../runtime/notify.js';

/** 假宿主通知面（记录收到的载荷；可模拟只暴露一个方法/抛错） */
function fakeService(): { service: { push(i: NotifyItem): boolean; pushAlways(i: NotifyItem): boolean }; pushed: NotifyItem[]; always: NotifyItem[] } {
  const pushed: NotifyItem[] = [];
  const always: NotifyItem[] = [];
  return {
    pushed,
    always,
    service: {
      push: (i: NotifyItem) => {
        pushed.push(i);
        return true;
      },
      pushAlways: (i: NotifyItem) => {
        always.push(i);
        return true;
      },
    },
  };
}

describe('① 契约：服务形状判定', () => {
  it('缺少 push/pushAlways → 不视为可用通知面', () => {
    expect(isDesktopNotifyLike(null)).toBe(false);
    expect(isDesktopNotifyLike(undefined)).toBe(false);
    expect(isDesktopNotifyLike({})).toBe(false);
    expect(isDesktopNotifyLike({ push: 'not-a-function' })).toBe(false);
    expect(isDesktopNotifyLike({ push: () => true })).toBe(true);
    expect(isDesktopNotifyLike({ pushAlways: () => true })).toBe(true);
  });

  it('无服务 → available=false 且 notify 返回 false（不抛）', () => {
    const bridge = new NotifyBridge({ service: null });
    expect(bridge.available).toBe(false);
    expect(bridge.notifyKernelNotLoaded('测试原因')).toBe(false);
    expect(bridge.attempts()[0]).toMatchObject({ kind: 'kernel-not-loaded', sent: false, skipped: 'no-service' });
  });

  it('enabled=false → 显式关停（即使服务存在也不发）', () => {
    const { service, always } = fakeService();
    const bridge = new NotifyBridge({ service, policy: { enabled: false } });
    expect(bridge.available).toBe(false);
    expect(bridge.notifyKernelNotLoaded('测试原因')).toBe(false);
    expect(always).toHaveLength(0);
    expect(bridge.attempts()[0]!.skipped).toBe('disabled');
  });
});

describe('② 门控语义：always 与聚焦门控', () => {
  it('内核未加载走 pushAlways（绕过聚焦门控——内核没起来时"没人看着面板"是常态）', () => {
    const { service, pushed, always } = fakeService();
    const bridge = new NotifyBridge({ service });
    expect(bridge.notifyKernelNotLoaded('宿主版本契约不符')).toBe(true);
    expect(always).toHaveLength(1);
    expect(pushed).toHaveLength(0);
    expect(always[0]).toMatchObject({ title: 'OMB 认知层未启用', urgency: 'critical' });
    expect(always[0]!.message).toContain('宿主版本契约不符');
    expect(bridge.attempts()[0]).toMatchObject({ sent: true, always: true, accepted: true });
  });

  it('普通通知走 push（尊重宿主聚焦门控）', () => {
    const { service, pushed, always } = fakeService();
    const bridge = new NotifyBridge({ service });
    expect(bridge.notifyPromotionRollback('候选 c1 线上退化')).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(always).toHaveLength(0);
    expect(bridge.attempts()[0]!.always).toBe(false);
  });

  it('宿主推送面抛错 → 不阻塞调用方（记审计，返回 false）', () => {
    const bridge = new NotifyBridge({
      service: {
        push: () => {
          throw new Error('host notify broke');
        },
      },
    });
    expect(bridge.notifyPromotionRollback('x')).toBe(false);
    expect(bridge.attempts()[0]).toMatchObject({ sent: false, skipped: 'no-service' });
  });
});

describe('③ 节流、去重与总量上限（默认沉默是第一纪律）', () => {
  it('同 kind 在窗口内只发一次（第二次 throttled）', () => {
    const { service, pushed } = fakeService();
    let now = 1_000_000;
    const bridge = new NotifyBridge({ service, now: () => now });
    expect(bridge.notifyDebtCritical(120, 100)).toBe(true);
    expect(bridge.notifyDebtCritical(130, 100)).toBe(false);
    expect(bridge.attempts()[1]!.skipped).toBe('throttled');
    expect(pushed).toHaveLength(1);
    // 窗口过后可再发
    now += DEFAULT_NOTIFY_POLICY.perKindIntervalMs + 1;
    expect(bridge.notifyDebtCritical(140, 100)).toBe(true);
    expect(pushed).toHaveLength(2);
  });

  it('内容完全相同不重复发（去重键 = kind+title+message）', () => {
    const { service, always } = fakeService();
    const bridge = new NotifyBridge({ service, policy: { perKindIntervalMs: 0 } });
    expect(bridge.notifyKernelNotLoaded('同一原因')).toBe(true);
    expect(bridge.notifyKernelNotLoaded('同一原因')).toBe(false);
    expect(bridge.attempts()[1]!.skipped).toBe('duplicate');
    expect(always).toHaveLength(1);
    // 原因不同（内容不同）→ 仍会发（去重不误伤真实新信息）
    expect(bridge.notifyKernelNotLoaded('另一原因')).toBe(true);
    expect(always).toHaveLength(2);
  });

  it('会话内总量上限：超过上限后不再发（capped）', () => {
    const { service, always } = fakeService();
    const bridge = new NotifyBridge({
      service,
      policy: { perKindIntervalMs: 0, maxPerSession: 2 },
    });
    expect(bridge.notifyKernelNotLoaded('r1')).toBe(true);
    expect(bridge.notifyStartupRollback('r2')).toBe(true);
    expect(bridge.notifyDebtCritical(200, 100)).toBe(false);
    expect(bridge.attempts()[2]!.skipped).toBe('capped');
    expect(always).toHaveLength(1);
  });

  it('载荷净化：空标题视为无效（与对方 normalizeNotifyItem 同口径）', () => {
    const { service } = fakeService();
    const bridge = new NotifyBridge({ service });
    expect(bridge.notify('kernel-not-loaded', { title: '   ' })).toBe(false);
    expect(bridge.attempts()[0]!.skipped).toBe('invalid');
  });
});

describe('④ 事件白名单与审计面', () => {
  it('通知种类是固定白名单（不提供"任意事件都能弹"的通用出口）', () => {
    expect([...NOTIFY_KINDS]).toEqual([
      'kernel-not-loaded',
      'startup-rollback',
      'promotion-rollback',
      'debt-critical',
      'component-unhealthy',
    ]);
  });

  it('审计面逐条可读：发了什么/为什么没发（回答"为什么没弹"）', () => {
    const { service } = fakeService();
    let now = 0;
    const bridge = new NotifyBridge({ service, now: () => now });
    bridge.notifyComponentUnhealthy('memory-retrieval 健康检查失败');
    now += 1;
    bridge.notifyComponentUnhealthy('memory-retrieval 健康检查失败'); // 内容相同 → duplicate
    expect(bridge.attempts()).toHaveLength(2);
    expect(bridge.attempts()[0]).toMatchObject({ kind: 'component-unhealthy', sent: true });
    expect(bridge.attempts()[1]).toMatchObject({ kind: 'component-unhealthy', sent: false, skipped: 'duplicate' });
  });

  it('各专用方法的文案含"发生了什么 + 后果/可做什么"（不 leak 内部术语当标题）', () => {
    const { service, pushed, always } = fakeService();
    const bridge = new NotifyBridge({ service });
    bridge.notifyStartupRollback('恢复根校验未过');
    bridge.notifyComponentUnhealthy('组件 X 健康失败');
    const all = [...pushed, ...always];
    for (const item of all) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.message ?? '').toMatch(/。|：/); // 有完整句子（说清后果），不是干巴巴的内部术语
    }
  });
});
