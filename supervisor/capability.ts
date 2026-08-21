// layer 1：能力注册表（架构 §3 ② capability.ts / §8.1 Capability Broker 契约面 / T6a.2 注册面聚合）。
// 注册/发现/冲突检测：
// - 注册：重复 id fail-loud；同层（authority_scope）同名 → 冲突 fail-loud（平台硬边界"同层同名注册"，
//   T6a.2 CapabilityBroker.assertHardBoundaries 同款语义——同层同名 = 冲突，异层同名 = 分级基础允许）；
// - 发现：按 name/scope 过滤（Broker 候选收集的注册面聚合输入）；
// - 注销：未知 id fail-loud。
// 层 DAG：supervisor 不 import kernel 运行时实现（仅 kernel/schemas 契约例外）——本模块自包含
// 最小结构形状（CapabilityLike），调用方（Broker 装配/插件装配）把真实 CapabilityContract 绑定为
// 结构子类型即可注册（kernel/capability-abi.ts 的 CapabilityContract 结构上满足）。
export interface CapabilityLike {
  /** 能力 id（capability:<uuid>） */
  id: string;
  /** 能力名（Broker 按 name 匹配 intent 节点） */
  name: string;
  /** 层（§8.1 authority_scope 与 §4.1 owner 对齐：kernel|system|user|community） */
  authority_scope: string;
  /** 可靠性（§8.1：high|medium|low；可缺省） */
  reliability?: string;
}

/** 发现过滤（name/scope 全可选；省略 = 不过滤该维） */
export interface DiscoverFilter {
  name?: string;
  scope?: string;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityLike>();

  /** 注册：重复 id / 同层同名冲突 → fail-loud（冲突检测，§8.1） */
  register(cap: CapabilityLike): void {
    if (typeof cap?.id !== 'string' || cap.id.length === 0 || typeof cap?.name !== 'string' || cap.name.length === 0) {
      throw new Error('capability.register: id/name 必须为非空字符串');
    }
    if (this.entries.has(cap.id)) {
      throw new Error(`capability.register: 重复 id: ${cap.id}`);
    }
    for (const existing of this.entries.values()) {
      if (existing.name === cap.name && existing.authority_scope === cap.authority_scope) {
        throw new Error(
          `capability.register: 同层同名冲突（authority_scope=${cap.authority_scope}, name=${cap.name}）: ${existing.id} vs ${cap.id}`,
        );
      }
    }
    this.entries.set(cap.id, { ...cap });
  }

  /** 注销：未知 id fail-loud */
  unregister(id: string): void {
    if (!this.entries.delete(id)) {
      throw new Error(`capability.unregister: 未知 id: ${id}`);
    }
  }

  /** 发现：按 name/scope 过滤（全可选）；返回拷贝（调用方改动不影响注册表） */
  discover(filter: DiscoverFilter = {}): CapabilityLike[] {
    return [...this.entries.values()].filter(
      (c) =>
        (filter.name === undefined || c.name === filter.name) &&
        (filter.scope === undefined || c.authority_scope === filter.scope),
    );
  }

  /** 全量清单（拷贝） */
  list(): CapabilityLike[] {
    return [...this.entries.values()].map((c) => ({ ...c }));
  }

  /** 注册数 */
  count(): number {
    return this.entries.size;
  }
}
