// layer 3：组件注册表（架构 §11.3 Component registration 事务 + 施工计划 T8.19——components/ 从 .gitkeep
// 到首个机制组件，组件化闭环验证）。
//
// ABI（brief 已定）：manifest（声明）/ inject（注入依赖）/ effect（激活后能力）/ disposer（清理）——
// - ComponentManifest：组件声明（manifest_id 幂等键 + name/version/description + 注入声明 inject +
//   提供效果 provides）；组件 = 遵循 T8.6 注册事务语义的可挂载单元。
// - ComponentDefinition：定义 = manifest + create(deps) 工厂（装配者注入依赖 → 产出 activate/effect/disposer）。
// - ComponentRegistry：注册集（register 多条）→ activate（批量 commit，任一激活失败 → 已注册全部 dispose
//   回滚 + 不暴露任何 effect）→ get（仅激活后可取）→ disposeAll（批量释放，幂等）。
//   语义全部复用 supervisor/component-registry.ts（T8.6）：幂等键唯一、批量回滚、dispose 幂等、
//   failed 态可重试 commit。
// layer 3（components/）：import 目标层 ≤ 3（supervisor(1) 经 DAG 放行，CONVENTIONS §4）。
import { ComponentRegistrationTransaction } from '../supervisor/component-registry.js';

// ---- ABI ----

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
}

/** 组件定义：manifest + create 工厂（注入依赖 → 激活/效果/清理；激活失败 → 事务批量回滚） */
export interface ComponentDefinition<TDeps extends object, TEffect> {
  manifest: ComponentManifest;
  create(deps: TDeps): {
    activate?: () => void | Promise<void>;
    effect: TEffect;
    disposer?: () => void | Promise<void>;
  };
}

// ---- 注册表（装配点：register → activate → get；T8.6 事务语义） ----

/**
 * 组件注册表：注册集 + 批量激活 + 批量释放。
 * - register：open 态注册（create 工厂即时产出 activate/effect/disposer）；重复 manifest_id → fail-loud；
 * - activate：commit 全部激活（注册序）；任一激活失败 → 已注册全部 dispose 回滚 + fail-loud，
 *   且不暴露任何 effect（get 恒 null，不留半激活态）；失败后可修复重试（T8.6 failed 态重试语义）；
 * - get：仅激活且未释放的组件返回 effect；否则 null；
 * - disposeAll：批量释放（幂等——每 manifest_id 的 disposer 至多一次，T8.6 幂等键追踪）；
 *   disposeAll 后 get 恒 null，组件 effect 调用由组件自身 fail-loud（disposer 关闭句柄）。
 */
export class ComponentRegistry {
  private readonly txn = new ComponentRegistrationTransaction();
  private readonly created = new Map<string, { effect: unknown; disposer?: () => void | Promise<void> }>();
  private readonly activated = new Set<string>();
  private readonly disposed = new Set<string>();
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
    this.created.set(def.manifest.manifest_id, { effect: created.effect, disposer: created.disposer });
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
  }

  /** 已注册组件数（诊断/测试） */
  get size(): number {
    return this.created.size;
  }
}
