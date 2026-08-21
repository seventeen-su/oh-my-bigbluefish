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
