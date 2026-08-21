// T8.5 行为测试：演化事务封装（supervisor/txn.ts）+ 能力注册表（supervisor/capability.ts）。
// 架构 §3 ② txn.ts/capability.ts（§3 清单缺失）+ §11.3 Evolution 事务=git 事务（candidate_id 幂等，
// 分支回退）+ §8.1 能力契约（同层同名冲突 fail-loud，T2.5 ABI + T6a.2 Broker 注册面聚合）。
// 真实 git 操作（禁 mock）：独立临时 fixture（buildLayoutFixture + 独立可写事务 worktree）。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionTransaction } from '../../supervisor/txn.js';
import { CapabilityRegistry } from '../../supervisor/capability.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

function headOf(fx: LayoutFixture, branch = 'stable'): string {
  return runGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: fx.bare });
}

describe('T8.5 演化事务（EvolutionTransaction：建分支 → 提交 → 验证 → 合入/回退）', () => {
  let fx: LayoutFixture;
  let txnWt: string;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  /** 独立可写事务 worktree（detached @ initialHash） */
  function setupTxnWorktree(): void {
    txnWt = path.join(fx.root, 'txn-wt');
    runGit(['worktree', 'add', '--detach', txnWt, fx.initialHash], { cwd: fx.bare });
  }

  it('成功路径：begin → 修改+提交 → verify ok → mergeTo(stable) → stable head 推进到事务提交', async () => {
    fx = buildLayoutFixture();
    setupTxnWorktree();
    const txn = new EvolutionTransaction({ bareRepo: fx.bare, worktree: txnWt, branch: 'txn-ok' });

    await txn.begin();
    fs.writeFileSync(path.join(txnWt, 'evolution.txt'), 'txn change\n');
    const { commit_hash } = await txn.commit('事务提交（验证通过）');
    expect(commit_hash).toMatch(/^[0-9a-f]{40}$/);

    const v = await txn.verify(async () => ({ ok: true, detail: 'schema/tsc 通过' }));
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('通过');

    const m = await txn.mergeTo('stable');
    expect(m.merged).toBe(true);
    expect(m.head).toBe(commit_hash);
    expect(headOf(fx)).toBe(commit_hash); // stable 已推进到事务提交
  });

  it('分支回退：verify 失败 → rollback → 事务分支删除、worktree 回到基、stable 不变', async () => {
    fx = buildLayoutFixture();
    setupTxnWorktree();
    const before = headOf(fx);
    const txn = new EvolutionTransaction({ bareRepo: fx.bare, worktree: txnWt, branch: 'txn-bad' });

    await txn.begin();
    fs.writeFileSync(path.join(txnWt, 'evolution.txt'), 'bad change\n');
    await txn.commit('事务提交（验证失败）');

    // 验证失败（模拟中途失败）
    const v = await txn.verify(async () => ({ ok: false, detail: '回放失败' }));
    expect(v.ok).toBe(false);

    const r = await txn.rollback();
    expect(r.rolled_back).toBe(true);
    expect(r.branch_deleted).toBe(true);
    // worktree 回到基（detached @ initialHash）
    expect(runGit(['rev-parse', 'HEAD'], { cwd: txnWt })).toBe(fx.initialHash);
    // 事务分支已删除
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: fx.bare });
    expect(refs).not.toContain('refs/heads/txn-bad');
    // stable 未受影响
    expect(headOf(fx)).toBe(before);
  });

  it('非快进合入 fail-loud：目标分支已分叉 → mergeTo 抛错，target 不变', async () => {
    fx = buildLayoutFixture();
    setupTxnWorktree();
    // 让 stable 前进一版（与事务基分叉）
    const seed = path.join(fx.root, '_seed-stable2');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'manifest.json'), JSON.stringify({ name: 'omb-v2', version: '0.2.0', line: 'stable2', components: {} }, null, 2));
    runGit(['add', '.'], { gitDir: fx.bare, workTree: seed });
    const tree = runGit(['write-tree'], { gitDir: fx.bare, workTree: seed });
    const stable2 = runGit(
      ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-p', fx.initialHash, '-m', 'stable advanced'],
      { gitDir: fx.bare },
    );
    runGit(['update-ref', 'refs/heads/stable', stable2], { cwd: fx.bare });

    const txn = new EvolutionTransaction({ bareRepo: fx.bare, worktree: txnWt, branch: 'txn-ff' });
    await txn.begin();
    fs.writeFileSync(path.join(txnWt, 'evolution.txt'), 'ff change\n');
    await txn.commit('事务提交（非快进场景）');

    await expect(txn.mergeTo('stable')).rejects.toThrow(/快进|fast-forward|非快进/);
    expect(headOf(fx)).toBe(stable2); // target 不变
  });

  it('重复 begin / 未 begin 先 commit → fail-loud（事务状态机）', async () => {
    fx = buildLayoutFixture();
    setupTxnWorktree();
    const txn = new EvolutionTransaction({ bareRepo: fx.bare, worktree: txnWt, branch: 'txn-state' });
    await expect(txn.commit('未 begin')).rejects.toThrow(/begin|事务/);
    await txn.begin();
    await expect(txn.begin()).rejects.toThrow(/begin|已/);
  });
});

describe('T8.5 能力注册表（CapabilityRegistry：注册/发现/冲突检测）', () => {
  it('注册/发现：register → list/discover 可查（name/scope 过滤）', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'capability:11111111-1111-4111-8111-111111111111', name: 'bash', authority_scope: 'kernel', reliability: 'high' });
    reg.register({ id: 'capability:22222222-2222-4222-8222-222222222222', name: 'fs', authority_scope: 'system', reliability: 'medium' });

    expect(reg.list()).toHaveLength(2);
    expect(reg.discover({ name: 'bash' })).toHaveLength(1);
    expect(reg.discover({ scope: 'system' }).map((c) => c.name)).toEqual(['fs']);
    expect(reg.discover({ name: 'nonexistent' })).toHaveLength(0);
  });

  it('冲突检测：同层（authority_scope）同名注册 → fail-loud；异层同名 → 允许（软接管分级基础）', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'capability:11111111-1111-4111-8111-111111111111', name: 'bash', authority_scope: 'kernel', reliability: 'high' });

    // 同层同名 → 冲突 fail-loud
    expect(() =>
      reg.register({ id: 'capability:33333333-3333-4333-8333-333333333333', name: 'bash', authority_scope: 'kernel', reliability: 'low' }),
    ).toThrow(/冲突|同名|kernel/);
    // 异层同名 → 允许（不同 authority_scope 是分级而非冲突）
    expect(() =>
      reg.register({ id: 'capability:44444444-4444-4444-8444-444444444444', name: 'bash', authority_scope: 'user', reliability: 'low' }),
    ).not.toThrow();
    expect(reg.list()).toHaveLength(2);
  });

  it('重复 id 注册 → fail-loud；unregister 后同名可再注册', () => {
    const reg = new CapabilityRegistry();
    const id = 'capability:55555555-5555-4555-8555-555555555555';
    reg.register({ id, name: 'tool', authority_scope: 'kernel', reliability: 'high' });
    expect(() => reg.register({ id, name: 'other', authority_scope: 'system', reliability: 'high' })).toThrow(/重复|id/);

    reg.unregister(id);
    expect(reg.list()).toHaveLength(0);
    reg.register({ id, name: 'tool', authority_scope: 'kernel', reliability: 'high' });
    expect(reg.list()).toHaveLength(1);
  });
});
