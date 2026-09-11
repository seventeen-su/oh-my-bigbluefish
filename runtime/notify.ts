// layer 2（runtime/）：桌面通知桥（已知问题《待实现：与 dsh-desktop-notify 的兼容》）。
//
// 目标：宿主安装了 `dsh-desktop-notify` 时，OMB 通过它的推送管线发通知（例如"内核未加载"这类
// 需要主人知道的事）；未安装 → 全静默（零开销、零降级噪声）。
//
// 对方接口（本机 /D:/Program/dsh-desktop-notify v1.3.12，lib/api.js —— 已核实形状）：
//   - 服务名：`ctx.get('desktopNotify')`（对方 `ctx.provide('desktopNotify', …)` 暴露）；
//   - `push(item)`：走**聚焦门控**（正在看的那个会话会被静默），返回 boolean；
//   - `pushAlways(item)`：**绕过**聚焦门控，始终弹，返回 boolean；
//   - 载荷 `{ title, message?, urgency?, sessionId? }`：title 必填（空 → false），title 截断 160、
//     message 截断 400，urgency ∈ { low, normal, critical }（非法归一 normal），sessionId 可传
//     会话对象/id/数组（会话级门控）。
//
// **什么算值得打扰用户**（本模块的核心纪律，不是"有什么事件就发什么"）：
//   通知的价值在于稀缺。故这里定义的是"允许打扰"的**极窄集合**，每条都满足：
//   ① 用户此刻不知道就会持续受害（内核未加载/安全状态、宿主契约变化、晋升失败被回退）；
//   ② 不是高频事件（演化/候选/维护任务的常态波动一律不发）；
//   ③ 有去重与节流（同 kind 在窗口内只发一次；内容相同不重复发）。
//   —— 换句话说：**默认沉默**，只有"主人该知道的事"才出声。
//
// 三条纪律：
//   ① 永不阻塞宿主：全部推送 best-effort（异常吞掉并降级记录），不 await 宿主面之外的东西；
//   ② 永不成为噪音源：按 kind 节流 + 内容去重 + 会话内总量上限（见 NotifyPolicy）；
//   ③ 未安装桌面通知时零痕迹：不记录降级（宿主没装插件不是我们的故障）。
import { createHash } from 'node:crypto';

/** 宿主 desktopNotify 服务的最小结构面（对方 lib/api.js createNotifyApi 产物） */
export interface DesktopNotifyLike {
  push?(item: NotifyItem): unknown;
  pushAlways?(item: NotifyItem): unknown;
}

/** 通知载荷（对方契约：title 必填；message/urgency/sessionId 可选） */
export interface NotifyItem {
  title: string;
  message?: string;
  urgency?: 'low' | 'normal' | 'critical';
  sessionId?: string;
}

/**
 * 允许打扰的事件种类（**白名单**——不在表内的一律不发）。
 * 命名与「用户会怎么理解这件事」对齐，不用内部术语。
 */
export const NOTIFY_KINDS = [
  /** 内核未加载/进入安全状态（宿主升级、契约不符、恢复根不可读）——OMB 整体不工作，主人必须知道 */
  'kernel-not-loaded',
  /** 启动自动回退（恢复根损坏 → 回退到上一稳定版本）——数据安全相关，需要知道 */
  'startup-rollback',
  /** 晋升到 stable 失败且对象被回退（error 池归档）——"修好的东西又退回去了"，需要知道 */
  'promotion-rollback',
  /** 债务堆积到 critical 档（保护性自锁生效，演化被硬限拦住）——需要主人介入 */
  'debt-critical',
  /** 组件健康检查发现异常（组件被标记 suspicious）——能力面受损，需要知道 */
  'component-unhealthy',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** 通知策略（节流与总量；数据化初值，可按部署调整） */
export interface NotifyPolicy {
  /** 同一 kind 的最小间隔（ms；缺省 30 分钟——"同类问题别连着弹"） */
  perKindIntervalMs: number;
  /** 单次会话生命周期内的总推送上限（缺省 5——硬上限，防意外刷屏） */
  maxPerSession: number;
  /** 全局开关（缺省 true；宿主未装 desktopNotify 时无效果） */
  enabled: boolean;
}

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  perKindIntervalMs: 30 * 60 * 1000,
  maxPerSession: 5,
  enabled: true,
};

/** 一次推送尝试的结果（审计面可读——"为什么不弹"必须能回答） */
export interface NotifyAttempt {
  kind: NotifyKind;
  at: number;
  /** 是否真的调用了宿主推送面 */
  sent: boolean;
  /** 未发送原因（sent=false 时）：'disabled' | 'throttled' | 'duplicate' | 'capped' | 'no-service' | 'invalid' */
  skipped?: 'disabled' | 'throttled' | 'duplicate' | 'capped' | 'no-service' | 'invalid';
  /** 宿主推送面返回值（sent=true 时；false 表示载荷无效或门控静默） */
  accepted?: boolean;
  /** 是否绕过聚焦门控（pushAlways） */
  always?: boolean;
}

/** 通知桥（装配面构造；进程内状态：节流窗口 + 去重键 + 计数） */
export class NotifyBridge {
  private readonly service: DesktopNotifyLike | null;
  private readonly policy: NotifyPolicy;
  private readonly now: () => number;
  private readonly lastByKind = new Map<NotifyKind, number>();
  private readonly sentDigests = new Set<string>();
  private sentCount = 0;
  private readonly log: NotifyAttempt[] = [];

  constructor(opts: { service?: DesktopNotifyLike | null; policy?: Partial<NotifyPolicy>; now?: () => number } = {}) {
    this.service = opts.service ?? null;
    this.policy = { ...DEFAULT_NOTIFY_POLICY, ...(opts.policy ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  /** 宿主通知面是否可用（未安装 → false；调用方据此决定是否走本模块） */
  get available(): boolean {
    const s = this.service;
    return (
      this.policy.enabled &&
      s !== null &&
      s !== undefined &&
      (typeof s.push === 'function' || typeof s.pushAlways === 'function')
    );
  }

  /** 推送审计（本进程内全部尝试；回答"为什么没弹/弹了什么"） */
  attempts(): NotifyAttempt[] {
    return [...this.log];
  }

  /**
   * 推送一条通知（**唯一入口**；全部节流/去重/上限都在这里）。
   * `always=true` → 走 `pushAlways`（绕过聚焦门控；只用于"必须现在知道"的事件，
   * 如内核未加载——此时没人看着 OMB 的面板）。
   *
   * 返回是否真的调用了宿主推送面（不是"用户看到了"——门控静默是宿主侧语义）。
   */
  notify(kind: NotifyKind, item: Omit<NotifyItem, 'urgency'> & { urgency?: NotifyItem['urgency'] }, opts: { always?: boolean } = {}): boolean {
    const at = this.now();
    const record = (r: Omit<NotifyAttempt, 'kind' | 'at'>): boolean => {
      this.log.push({ kind, at, ...r });
      return r.sent;
    };
    if (!this.policy.enabled) {
      return record({ sent: false, skipped: 'disabled' });
    }
    if (!this.available) {
      return record({ sent: false, skipped: 'no-service' });
    }
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      return record({ sent: false, skipped: 'invalid' });
    }
    if (this.sentCount >= this.policy.maxPerSession) {
      return record({ sent: false, skipped: 'capped' });
    }
    // 去重先于节流（判定顺序即审计措辞的精度）：内容相同 → 明确报 'duplicate'，
    // 而不是被时间窗口先吞成含糊的 'throttled'——回答"为什么没弹"时前者有用得多。
    const digest = createHash('sha256')
      .update(`${kind}\u0000${item.title}\u0000${item.message ?? ''}`, 'utf8')
      .digest('hex');
    if (this.sentDigests.has(digest)) {
      return record({ sent: false, skipped: 'duplicate' });
    }
    const last = this.lastByKind.get(kind);
    if (last !== undefined && at - last < this.policy.perKindIntervalMs) {
      return record({ sent: false, skipped: 'throttled' });
    }
    const payload: NotifyItem = {
      title: item.title,
      ...(item.message !== undefined ? { message: item.message } : {}),
      ...(item.urgency !== undefined ? { urgency: item.urgency } : {}),
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
    };
    const always = opts.always === true;
    let accepted: unknown;
    try {
      const fn = always ? this.service!.pushAlways : (this.service!.push ?? this.service!.pushAlways);
      if (typeof fn !== 'function') {
        // 只暴露了其中一个方法 → 按可用者降级（对方两个方法都在，这里只是形状容错）
        const fallback = this.service!.push ?? this.service!.pushAlways;
        if (typeof fallback !== 'function') {
          return record({ sent: false, skipped: 'no-service' });
        }
        accepted = fallback.call(this.service, payload);
      } else {
        accepted = fn.call(this.service, payload);
      }
    } catch {
      // 推送面抛错（对方版本变化等）→ 不阻塞调用方；记一条 sent=false 的审计（原因归一为 no-service）
      return record({ sent: false, skipped: 'no-service' });
    }
    this.lastByKind.set(kind, at);
    this.sentDigests.add(digest);
    this.sentCount += 1;
    return record({ sent: true, accepted: accepted !== false, always });
  }

  /**
   * 便捷方法：把"值得打扰"的事实翻成一条通知（标题/urgency 由 kind 决定——调用方只提供细节）。
   * 措辞纪律：说清"发生了什么 + 会有什么后果 + 主人可以做什么"，不用内部术语。
   */
  notifyKernelNotLoaded(reason: string, opts: { sessionId?: string } = {}): boolean {
    return this.notify(
      'kernel-not-loaded',
      {
        title: 'OMB 认知层未启用',
        message: `原因：${reason}。认知层未介入，对话与工具照常；修复后重启宿主即可恢复。`,
        urgency: 'critical',
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      },
      { always: true }, // 内核没起来时"没人看着 OMB 的会话"是常态 → 绕过聚焦门控
    );
  }

  /** 启动自动回退（恢复根损坏 → 回到上一稳定版本） */
  notifyStartupRollback(detail: string, opts: { sessionId?: string } = {}): boolean {
    return this.notify('startup-rollback', {
      title: 'OMB 启动自动回退',
      message: `${detail}。已回到上一稳定版本运行，数据未丢失。`,
      urgency: 'normal',
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
  }

  /** 晋升被回退（候选进入 error 归档） */
  notifyPromotionRollback(detail: string, opts: { sessionId?: string } = {}): boolean {
    return this.notify('promotion-rollback', {
      title: 'OMB 演化晋升已回退',
      message: `${detail}。候选已归档为负样本，当前线回到上一稳定版本。`,
      urgency: 'normal',
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
  }

  /** 债务堆积到 critical（保护性自锁生效——演化被硬限拦住，需要主人介入） */
  notifyDebtCritical(total: number, limit: number, opts: { sessionId?: string } = {}): boolean {
    return this.notify('debt-critical', {
      title: 'OMB 维护债务达 critical',
      message: `债务合计 ${total} ≥ 阈值 ${limit}：演化与晋升已被保护性拦住，需要在状态面查看债务来源并处理。`,
      urgency: 'critical',
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
  }

  /** 组件健康异常（能力面受损） */
  notifyComponentUnhealthy(detail: string, opts: { sessionId?: string } = {}): boolean {
    return this.notify('component-unhealthy', {
      title: 'OMB 组件健康异常',
      message: `${detail}。相关能力已降级，其余功能照常。`,
      urgency: 'normal',
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
  }
}

/** 判别宿主服务是否具备可用通知面（装配期守卫：形状不对 → 不接线，静默降级） */
export function isDesktopNotifyLike(v: unknown): v is DesktopNotifyLike {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const s = v as { push?: unknown; pushAlways?: unknown };
  return typeof s.push === 'function' || typeof s.pushAlways === 'function';
}
