// OMB v2 Capability Broker 策略/排序纯逻辑（架构 §8.2；layer 2 runtime/，无副作用，供 broker.ts 复用）。
// 分级阶梯：coexist → prefer（隐式偏好学习）→ wrap（AdapterAPI）→ deweight → shadow → takeover（末级）。
// 排序机制即数据：LEVEL_PRIORITY 定义分级优先级；同级稳定排序保注册序。
import type { CapabilityProvider, CapabilityResult } from '../kernel/capability-abi.js';

export type TakeoverLevel = 'coexist' | 'prefer' | 'wrap' | 'deweight' | 'shadow' | 'takeover';

/** AdapterAPI（§8.2）：wrap 级前置/后置转换 */
export interface AdapterAPI {
  before?: (input: unknown) => unknown;
  after?: (result: CapabilityResult) => CapabilityResult;
}

export interface BrokerPolicyLevel {
  provider_id: string;
  level: TakeoverLevel;
  /** deweight：权重（低者排后）；默认 1 */
  weight?: number;
  /** shadow：被 shadow 的目标 provider_id（M6a 最小：登记元数据，行为同普通 shadow 级） */
  shadow_of?: string;
  /** wrap：AdapterAPI 包装 */
  adapter?: AdapterAPI;
  /** patch：数据驱动禁用/覆盖（软接管同款机制，策略级复用） */
  patch?: { disable?: string[]; override?: Record<string, unknown> };
}

export interface BrokerPolicy {
  levels: BrokerPolicyLevel[];
}

// ---- 分级路由优先级（机制即数据；同级稳定排序保注册序） ----

const LEVEL_PRIORITY: Record<TakeoverLevel, number> = {
  takeover: 0, // 软接管替代者最优先
  prefer: 1, // 优先路由
  wrap: 2, // 包装增强
  coexist: 2, // 共存（与 wrap 同级，注册序）
  deweight: 3, // 降权
  shadow: 4, // shadow 不入主链
};

/** 生效分级：接管 shadow → 'takeover'；策略声明 → 该级；缺省 → coexist */
export function levelOf(providerId: string, policy: BrokerPolicy, takeoverShadowIds: ReadonlySet<string>): TakeoverLevel {
  if (takeoverShadowIds.has(providerId)) {
    return 'takeover';
  }
  return policy.levels.find((l) => l.provider_id === providerId)?.level ?? 'coexist';
}

export function weightOf(providerId: string, policy: BrokerPolicy): number {
  return policy.levels.find((l) => l.provider_id === providerId)?.weight ?? 1;
}

/** 分级排序：优先级升序；prefer 内命中降序；deweight 内权重降序；同级稳定（注册序） */
export function rankCandidates(
  cands: CapabilityProvider[],
  policy: BrokerPolicy,
  hits: ReadonlyMap<string, number>,
  takeoverShadowIds: ReadonlySet<string>,
): CapabilityProvider[] {
  return [...cands].sort((a, b) => {
    const la = levelOf(a.manifest.id, policy, takeoverShadowIds);
    const lb = levelOf(b.manifest.id, policy, takeoverShadowIds);
    const pa = LEVEL_PRIORITY[la]!;
    const pb = LEVEL_PRIORITY[lb]!;
    if (pa !== pb) {
      return pa - pb;
    }
    if (la === 'prefer') {
      return (hits.get(b.manifest.id) ?? 0) - (hits.get(a.manifest.id) ?? 0);
    }
    if (la === 'deweight') {
      return weightOf(b.manifest.id, policy) - weightOf(a.manifest.id, policy);
    }
    return 0; // 稳定排序 → 注册序
  });
}
