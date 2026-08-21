// T8.6 行为测试：Component registration 事务（supervisor/component-registry.ts，架构 §11.3 四类事务之一缺失）。
// 事务模型：注册集 + disposer 集 | 幂等键 manifest_id | 恢复 = 批量 dispose。
// 验收（brief）：注册集原子性（中途失败 → 已注册全部 dispose）；重试幂等。
import { describe, expect, it } from 'vitest';
import { ComponentRegistrationTransaction } from '../../supervisor/component-registry.js';

describe('T8.6 组件注册事务（注册集原子性 + 批量 dispose 回滚）', () => {
  it('注册集原子性：激活中途失败（A,B ok；C 激活抛错）→ commit 拒绝 → 已注册 A/B/C 全部 dispose（幂等键追踪）', async () => {
    const txn = new ComponentRegistrationTransaction();
    const disposed: string[] = [];
    const activated: string[] = [];
    txn.register({ manifest_id: 'm-A', activate: () => activated.push('A'), disposer: () => disposed.push('A') });
    txn.register({ manifest_id: 'm-B', activate: () => activated.push('B'), disposer: () => disposed.push('B') });
    txn.register({
      manifest_id: 'm-C',
      activate: () => {
        activated.push('C');
        throw new Error('C 激活失败');
      },
      disposer: () => disposed.push('C'),
    });

    await expect(txn.commit()).rejects.toThrow(/C 激活失败/);
    // 已注册全部 dispose（原子性：不留下半激活状态）
    expect(disposed.sort()).toEqual(['A', 'B', 'C']);
    expect(activated.sort()).toEqual(['A', 'B', 'C']);
  });

  it('dispose 幂等：失败后重复 disposeAll → 每个 disposer 至多一次；成功路径 disposeAll 亦幂等', async () => {
    const txn = new ComponentRegistrationTransaction();
    let aDispose = 0;
    txn.register({
      manifest_id: 'm-A',
      activate: () => {
        throw new Error('fail');
      },
      disposer: () => {
        aDispose += 1;
      },
    });
    await expect(txn.commit()).rejects.toThrow();

    await txn.disposeAll();
    await txn.disposeAll(); // 幂等
    expect(aDispose).toBe(1);

    // 成功路径事务 disposeAll 幂等
    const ok = new ComponentRegistrationTransaction();
    let bDispose = 0;
    ok.register({ manifest_id: 'm-B', disposer: () => (bDispose += 1) });
    await ok.commit();
    await ok.disposeAll();
    await ok.disposeAll();
    expect(bDispose).toBe(1);
  });

  it('重试幂等：失败后修复激活器再 commit → 成功（全激活、无残留 dispose 调用）', async () => {
    const txn = new ComponentRegistrationTransaction();
    let cFail = true;
    const disposed: string[] = [];
    txn.register({ manifest_id: 'm-A', activate: () => undefined, disposer: () => disposed.push('A') });
    txn.register({
      manifest_id: 'm-B',
      activate: () => {
        if (cFail) {
          cFail = false;
          throw new Error('B 首次激活失败');
        }
      },
      disposer: () => disposed.push('B'),
    });

    await expect(txn.commit()).rejects.toThrow();
    expect(disposed.sort()).toEqual(['A', 'B']); // 首次失败 → 全部 dispose

    await txn.commit(); // 重试（B 激活器已修复）→ 成功
    expect(disposed.sort()).toEqual(['A', 'B']); // 无新增 dispose（幂等键追踪，不重复调用）
  });

  it('重复 manifest_id 注册 → fail-loud（幂等键唯一）', () => {
    const txn = new ComponentRegistrationTransaction();
    txn.register({ manifest_id: 'm-X' });
    expect(() => txn.register({ manifest_id: 'm-X' })).toThrow(/重复|manifest_id/);
  });

  it('commit 成功后重复 commit → no-op（激活器不再被调）；disposeAll 后 commit → fail-loud', async () => {
    const txn = new ComponentRegistrationTransaction();
    let activations = 0;
    txn.register({ manifest_id: 'm-A', activate: () => (activations += 1) });

    await txn.commit();
    await txn.commit(); // 幂等 no-op
    expect(activations).toBe(1);

    await txn.disposeAll();
    await expect(txn.commit()).rejects.toThrow(/dispose|已释放/);
  });

  it('未 commit 直接 disposeAll → 已注册全部 dispose（open 态释放安全）', async () => {
    const txn = new ComponentRegistrationTransaction();
    const disposed: string[] = [];
    txn.register({ manifest_id: 'm-A', disposer: () => disposed.push('A') });
    txn.register({ manifest_id: 'm-B', disposer: () => disposed.push('B') });

    await txn.disposeAll();
    expect(disposed.sort()).toEqual(['A', 'B']);
  });
});
