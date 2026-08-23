// layer 1：Component registration 事务（架构 §11.3 四类事务之一——注册集 + disposer 集，幂等键 manifest_id，
// 恢复 = 批量 dispose；施工计划 §11.3 缺失项补全）。
// 语义：
// - register（open 态）：注册条目（activate/disposer）；重复 manifest_id → fail-loud（幂等键唯一）；
// - commit：按注册序激活全部；任一激活失败 → 已注册**全部** dispose（批量回滚，不留半激活状态）→ failed 态
//   + rethrow；成功 → committed 态（重复 commit no-op，激活器不再被调）；
// - 重试幂等：failed 态可再次 commit（从零重新激活；成功后 disposer 不再被调；失败 dispose 幂等——
//   每个 manifest_id 的 disposer 至多调用一次，disposed 集追踪）；
// - disposeAll：任意状态可调（open/committed/failed），批量释放，幂等（每条目 disposer 至多一次）；
//   disposeAll 后 commit → fail-loud（已释放不可再激活）。
// P2：组件注册表（ComponentRegistry，T8.19 自 components/registry.ts 移入——runtime 装配（层 2）持有
// 组件注册表，而层 DAG 禁 runtime → components（tests/m0/dag-lint.test.ts 钉住）→ 实现落本层（层 1，
// 与事务同文件）；components/registry.ts 保留 ABI 出口（既有导入路径不变）。P2 新增：
// - ComponentManifest 补 events/capabilities 字段（实现规格 §8.1 最小对齐；其余字段注释声明）；
// - create() 结果补 health（§8.1 lifecycle.onHealthCheck 语义）→ healthCheck() 失败打 suspicious
//   降级不卸载（§主14.6/设计 §8.2）；周期心跳入口（装配期 + healthCheckComponents）。
// layer 1（supervisor/）：仅 import node: 内置（本模块无依赖）。
export interface ComponentRegistration {
  /** 幂等键（§11.3 Component registration 事务） */
  manifest_id: string;
  /** 激活（可失败——抛错触发批量回滚；可缺省 = 无副作用激活） */
  activate?: () => void | Promise<void>;
  /** 释放（回滚/批量释放时调用；可缺省） */
  disposer?: () => void | Promise<void>;
}

type TxnState = 'open' | 'committed' | 'failed' | 'disposed';

export class ComponentRegistrationTransaction {
  private readonly entries: ComponentRegistration[] = [];
  /** 已 dispose 的 manifest_id（幂等键追踪：disposer 至多一次） */
  private readonly disposed = new Set<string>();
  private state: TxnState = 'open';

  /** 注册（open 态）；重复 manifest_id → fail-loud */
  register(entry: ComponentRegistration): void {
    if (this.state !== 'open') {
      throw new Error(`component-registry.register: 事务已 ${this.state}，不可再注册`);
    }
    if (typeof entry?.manifest_id !== 'string' || entry.manifest_id.length === 0) {
      throw new Error('component-registry.register: manifest_id 必须为非空字符串');
    }
    if (this.entries.some((e) => e.manifest_id === entry.manifest_id)) {
      throw new Error(`component-registry.register: 重复 manifest_id（幂等键唯一）: ${entry.manifest_id}`);
    }
    this.entries.push({ ...entry });
  }

  /** 激活全部（注册序）；中途失败 → 全部 dispose 回滚 + failed 态 + rethrow */
  async commit(): Promise<void> {
    if (this.state === 'committed') {
      return; // 幂等：已提交 no-op（激活器不再被调）
    }
    if (this.state === 'disposed') {
      throw new Error('component-registry.commit: 事务已 disposeAll（已释放不可再激活）');
    }
    try {
      for (const e of this.entries) {
        if (e.activate !== undefined) {
          await e.activate();
        }
      }
      this.state = 'committed';
    } catch (err) {
      await this.disposeAll(); // 批量回滚：已注册全部 dispose（幂等）
      this.state = 'failed';
      throw err;
    }
  }

  /** 批量释放（任意状态可调；幂等——每 manifest_id 的 disposer 至多一次） */
  async disposeAll(): Promise<void> {
    for (const e of this.entries) {
      if (this.disposed.has(e.manifest_id)) {
        continue; // 幂等键追踪：不重复 dispose
      }
      this.disposed.add(e.manifest_id);
      if (e.disposer !== undefined) {
        await e.disposer();
      }
    }
    this.state = 'disposed';
  }

  /** 当前状态（测试/诊断） */
  get currentState(): TxnState {
    return this.state;
  }
}

// ---- P2：组件注册表 ABI（T8.19；manifest/inject/effect/disposer/health 契约） ----

/** 组件清单（manifest：声明注入与提供；inject/provides 为装配者与调用方的契约面） */
export interface ComponentManifest {
  /** 幂等键（T8.6 事务语义：注册集唯一） */
  manifest_id: string;
  name: string;
  version: string;
  description?: string;
  /** 注入声明：组件依赖的运行时服务键（装配者按此提供 deps） */
  inject: readonly string[];
  /** 提供效果：激活后对外暴露的能力名（如 'memory.retrieve'） */
  provides: readonly string[];
  /** P2：事件契约（实现规格 §8.1 events：subscribe/publish；组件无事件 → 空数组显式声明） */
  events?: { subscribe?: readonly string[]; publish?: readonly string[] };
  /** P2：能力契约（能力名清单——装配期登记进能力注册表 supervisor/capability.ts，§8.1 capabilities） */
  capabilities?: readonly string[];
  // 实现规格 §8.1 其余字段（contract_schema/evolution_gate/code_budget/side_effect_budget/
  // dependency_budget/semantic_authority/required_services/lifecycle/effect_decls）：registry 当前不强制
  // 执行，机制落地按需最小补齐（P2 以注释声明，不虚构语义——字段进入 ABI 即须有执行语义）。
}

/** 健康检查结果（create() health 返回值；boolean 或 { ok, detail? }） */
export type ComponentHealthCheck = boolean | { ok: boolean; detail?: string };

/** 组件定义：manifest + create 工厂（注入依赖 → 激活/效果/清理/健康；激活失败 → 事务批量回滚） */
export interface ComponentDefinition<TDeps extends object, TEffect> {
  manifest: ComponentManifest;
  create(deps: TDeps): {
    activate?: () => void | Promise<void>;
    effect: TEffect;
    disposer?: () => void | Promise<void>;
    /** P2：健康检查（§8.1 lifecycle.onHealthCheck——装配期/周期心跳；失败 → 组件打 suspicious 降级不卸载） */
    health?: () => ComponentHealthCheck | Promise<ComponentHealthCheck>;
  };
}

/** 组件状态（statusOf/list 用；suspicious = health 失败但未卸载——降级不卸载，§主14.6） */
export type ComponentStatus = 'registered' | 'active' | 'suspicious' | 'disposed';

/** 单组件健康检查结果（healthCheck 报告项） */
export interface ComponentHealthResult {
  ok: boolean;
  detail: string;
  checked_at: number;
}

/** 清单项（诊断/状态摘要：kern_status components 段数据源） */
export interface ComponentListEntry {
  manifest_id: string;
  status: ComponentStatus;
  /** 最近一次 health check 结果（未检查 → null） */
  healthy: boolean | null;
  health_detail: string | null;
}

interface CreatedEntry {
  effect: unknown;
  disposer?: () => void | Promise<void>;
  health?: () => ComponentHealthCheck | Promise<ComponentHealthCheck>;
}

/**
 * 组件注册表（T8.19；装配点：register → activate → get → disposeAll；P2 补 health/suspicious）：
 * - register：open 态注册（create 工厂即时产出 activate/effect/disposer/health）；重复 manifest_id → fail-loud；
 * - activate：commit 全部激活（注册序）；任一激活失败 → 已注册全部 dispose 回滚 + fail-loud，
 *   且不暴露任何 effect（get 恒 null，不留半激活态）；失败后可修复重试（T8.6 failed 态重试语义）；
 * - get：仅激活且未释放的组件返回 effect；否则 null；
 * - healthCheck：对每个已激活未释放且有 health 的组件执行——失败 → 打 suspicious（降级不卸载，
 *   get 仍可取）；成功 → 清除 suspicious（周期心跳恢复语义）；不抛（逐组件降级记录）；
 * - disposeAll：批量释放（幂等——每 manifest_id 的 disposer 至多一次，T8.6 幂等键追踪）；
 *   disposeAll 后 get 恒 null，suspicious/health 记录清零。
 * 激活顺序 = 注册顺序（inject 为装配者提供依赖的契约面——无自动依赖图解析；多组件拓扑由装配者按
 * manifest.inject 编排注册序，P2 单组件无图）。
 */
export class ComponentRegistry {
  private readonly txn = new ComponentRegistrationTransaction();
  private readonly created = new Map<string, CreatedEntry>();
  private readonly manifestById = new Map<string, ComponentManifest>();
  private readonly activated = new Set<string>();
  private readonly disposed = new Set<string>();
  private readonly healthRecords = new Map<string, ComponentHealthResult>();
  private readonly suspiciousIds = new Set<string>();
  private committed = false;

  /** 注册组件（open 态）；重复 manifest_id / 已激活后注册 → fail-loud */
  register<TDeps extends object, TEffect>(
    def: ComponentDefinition<TDeps, TEffect>,
    deps: TDeps,
  ): void {
    if (this.committed) {
      throw new Error(`component-registry.register: 注册表已激活（committed），不可再注册: ${def.manifest.manifest_id}`);
    }
    if (this.created.has(def.manifest.manifest_id)) {
      throw new Error(`component-registry.register: 重复 manifest_id（幂等键唯一）: ${def.manifest.manifest_id}`);
    }
    if (typeof def?.manifest?.manifest_id !== 'string' || def.manifest.manifest_id.length === 0) {
      throw new Error('component-registry.register: manifest_id 必须为非空字符串');
    }
    const created = def.create(deps);
    if (created.effect === undefined) {
      throw new Error(`component-registry.register: 组件 ${def.manifest.manifest_id} 缺 effect（create 必须产出效果）`);
    }
    this.created.set(def.manifest.manifest_id, {
      effect: created.effect,
      disposer: created.disposer,
      health: created.health,
    });
    this.manifestById.set(def.manifest.manifest_id, def.manifest);
    this.txn.register({
      manifest_id: def.manifest.manifest_id,
      activate: created.activate,
      disposer: created.disposer,
    });
  }

  /** 批量激活（注册序）；任一失败 → 全部 dispose 回滚 + rethrow（不暴露任何 effect） */
  async activate(): Promise<void> {
    try {
      await this.txn.commit();
    } catch (err) {
      this.activated.clear(); // 回滚：不暴露任何 effect（无半激活态）
      throw err;
    }
    for (const id of this.created.keys()) {
      if (!this.disposed.has(id)) {
        this.activated.add(id);
      }
    }
    this.committed = true;
  }

  /** 取已激活组件 effect（未激活/已释放/未知 id → null） */
  get<TEffect>(manifestId: string): TEffect | null {
    if (!this.activated.has(manifestId) || this.disposed.has(manifestId)) {
      return null;
    }
    const c = this.created.get(manifestId);
    return c ? (c.effect as TEffect) : null;
  }

  /** 批量释放（任意状态可调；幂等——每 manifest_id disposer 至多一次，T8.6 幂等键追踪） */
  async disposeAll(): Promise<void> {
    await this.txn.disposeAll();
    for (const id of this.created.keys()) {
      this.disposed.add(id);
    }
    this.activated.clear();
    this.healthRecords.clear();
    this.suspiciousIds.clear();
  }

  /** 已注册组件数（诊断/测试） */
  get size(): number {
    return this.created.size;
  }

  /** 已注册组件 manifest（能力登记/装配遍历用；拷贝） */
  manifests(): readonly ComponentManifest[] {
    return [...this.manifestById.values()];
  }

  /**
   * P2：健康检查（装配期 + 周期心跳，§8.1 onHealthCheck）——对每个已激活未释放且有 health 的组件执行；
   * 失败 → 打 suspicious（降级不卸载——get 仍可取 effect）；成功 → 清除 suspicious（心跳恢复）；
   * 组件自身异常 → 视为失败并记录（不抛——逐组件降级）。返回逐组件健康报告（含本次 checked_at）。
   */
  async healthCheck(): Promise<Record<string, ComponentHealthResult>> {
    for (const [id, c] of this.created) {
      if (!this.activated.has(id) || this.disposed.has(id)) {
        continue;
      }
      if (typeof c.health !== 'function') {
        continue;
      }
      const checked_at = Date.now();
      let ok = false;
      let detail = 'health check failed';
      try {
        const r = await c.health();
        if (typeof r === 'boolean') {
          ok = r;
          detail = r ? 'ok' : 'health check failed';
        } else {
          ok = r.ok;
          detail = r.detail ?? (r.ok ? 'ok' : 'health check failed');
        }
      } catch (err) {
        ok = false;
        detail = err instanceof Error ? err.message : String(err);
      }
      this.healthRecords.set(id, { ok, detail, checked_at });
      if (ok) {
        this.suspiciousIds.delete(id);
      } else {
        this.suspiciousIds.add(id);
      }
    }
    return Object.fromEntries(this.healthRecords);
  }

  /** suspicious 组件清单（health 失败但未卸载——降级不卸载语义） */
  suspicious(): string[] {
    return [...this.suspiciousIds];
  }

  /** 组件状态（'registered'|'active'|'suspicious'|'disposed'；未知 id → null） */
  statusOf(manifestId: string): ComponentStatus | null {
    if (this.disposed.has(manifestId)) {
      return 'disposed';
    }
    if (this.suspiciousIds.has(manifestId)) {
      return 'suspicious';
    }
    if (this.activated.has(manifestId)) {
      return 'active';
    }
    if (this.created.has(manifestId)) {
      return 'registered';
    }
    return null;
  }

  /** 清单（诊断/状态摘要——kern_status components 段数据源；拷贝） */
  list(): ComponentListEntry[] {
    return [...this.created.keys()].map((id) => {
      const h = this.healthRecords.get(id);
      return {
        manifest_id: id,
        status: this.statusOf(id) ?? 'registered',
        healthy: h ? h.ok : null,
        health_detail: h ? h.detail : null,
      };
    });
  }
}
