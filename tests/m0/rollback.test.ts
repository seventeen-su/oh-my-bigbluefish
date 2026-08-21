// T0.4 行为测试：版本回滚原语 rollbackTo（基于 Git revision 的原子切换 + fsync + worktree 尽力同步）。
// 真实 git/icacls 操作（禁 mock）：
//   - 独立临时 fixture（mkdtemp 完整复现三线布局）上做破坏性操作（回退/删文件）；
//   - 真实布局只做只读冒烟（绝不切换真实 stable 引用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rollbackTo } from '../../substrate/rollback.js';
import {
  applyReadOnlyAcl,
  buildLayoutFixture,
  runGit,
  runIcacls,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** preset 根（tests/m0/ → ../../） */
const PRESET_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_BARE = path.join(PRESET_ROOT, 'versions.git');

/** 解除 fixture stable worktree 的只读 ACL（回滚的 checkout 同步需要可写） */
function makeStableWritable(fx: LayoutFixture): void {
  runIcacls([fx.stable, '/reset', '/T', '/C']);
}

/** 读取 worktree 下 manifest.json 的 line 字段 */
function manifestLine(worktree: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(worktree, 'manifest.json'), 'utf8')) as {
    line?: string;
  };
  return manifest.line ?? '';
}

/** 解析 bare 上某分支当前 head（完整 commit hash） */
function headOf(fx: LayoutFixture, branch = 'stable'): string {
  return runGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: fx.bare });
}

/**
 * 在 stable 分支上造一个分叉推进提交（child of initialHash）并把 stable 指向它。
 * 返回新 commit hash（即测试中的 rev-A；initialHash 为可回退的上一 revision rev-B）。
 */
function advanceStable(fx: LayoutFixture, line: string): string {
  const seed = path.join(fx.root, `_seed-stable-${line}`);
  fs.mkdirSync(seed);
  fs.writeFileSync(
    path.join(seed, 'manifest.json'),
    JSON.stringify({ name: 'omb-v2', version: '0.1.0', line, components: {} }, null, 2),
  );
  fs.writeFileSync(path.join(seed, 'README.md'), `stable advanced: ${line}\n`);
  runGit(['add', '.'], { gitDir: fx.bare, workTree: seed });
  const tree = runGit(['write-tree'], { gitDir: fx.bare, workTree: seed });
  const commit = runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-p', fx.initialHash, '-m', `stable ${line}`],
    { gitDir: fx.bare },
  );
  runGit(['update-ref', 'refs/heads/stable', commit], { cwd: fx.bare });
  return commit;
}

describe('rollbackTo 版本回滚（独立临时 fixture）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('成功回退：stable 从 rev-A 切到 rev-B，返回 previous/new head 正确，引用指向 rev-B', () => {
    fx = buildLayoutFixture();
    const revA = advanceStable(fx, 'stable-advanced');
    const revB = fx.initialHash;
    // 前置：stable 在 rev-A
    expect(headOf(fx)).toBe(revA);

    const result = rollbackTo({ bareRepo: fx.bare, revision: revB });

    expect(result.previous_head).toBe(revA);
    expect(result.new_head).toBe(revB);
    expect(result.worktree_synced).toBe(true); // 未提供 worktree → 无需同步
    expect(headOf(fx)).toBe(revB);
  });

  it('损坏恢复：stable worktree 的 manifest.json 被删 → 回退上一 revision → head 回退且 worktree 文件恢复、内容正确', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    // 先把 worktree 同步到当前 stable（rev-A），模拟线上内容
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    expect(manifestLine(fx.stable)).toBe('stable-advanced');
    // 模拟损坏：删掉 manifest.json
    fs.rmSync(path.join(fx.stable, 'manifest.json'));

    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash, worktree: fx.stable });

    expect(result.new_head).toBe(fx.initialHash);
    expect(result.worktree_synced).toBe(true);
    expect(headOf(fx)).toBe(fx.initialHash);
    expect(fs.existsSync(path.join(fx.stable, 'manifest.json'))).toBe(true);
    expect(manifestLine(fx.stable)).toBe('initial');
  });

  it('未知 revision fail-loud：抛错且 head 不变', () => {
    fx = buildLayoutFixture();
    const revA = advanceStable(fx, 'stable-advanced');
    const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    expect(() => rollbackTo({ bareRepo: fx.bare, revision: bogus })).toThrow(/deadbeef/);
    expect(headOf(fx)).toBe(revA);
  });

  it('fsync：回退后引用文件（<bare>/refs/heads/stable）存在且内容 == revision', () => {
    fx = buildLayoutFixture();
    advanceStable(fx, 'stable-advanced');

    rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash });

    const refFile = path.join(fx.bare, 'refs', 'heads', 'stable');
    expect(fs.existsSync(refFile)).toBe(true);
    expect(fs.readFileSync(refFile, 'utf8').trim()).toBe(fx.initialHash);
  });

  it('worktree 同步失败不抛错：只读 ACL worktree 返回 worktree_synced:false，ref 仍已切换', () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const revA = advanceStable(fx, 'stable-advanced');
    // 先把 worktree 同步到 rev-A（模拟线上内容），再重新施加只读 ACL（模拟真实布局）
    runGit(['checkout', '--force', revA], { cwd: fx.stable });
    applyReadOnlyAcl(fx.stable);
    expect(manifestLine(fx.stable)).toBe('stable-advanced');

    // 回退到 rev-B：checkout 需把 worktree 内容从 rev-A 改写为 rev-B → 被只读 ACL 拒绝 → 不抛错，返回 worktree_synced:false
    const result = rollbackTo({ bareRepo: fx.bare, revision: fx.initialHash, worktree: fx.stable });

    expect(result.worktree_synced).toBe(false);
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx)).toBe(fx.initialHash);
  });

  it('branch 参数：切换非默认分支（main）', () => {
    fx = buildLayoutFixture();
    const latestHash = headOf(fx, 'main');
    expect(latestHash).not.toBe(fx.initialHash); // fixture 中 main 已推进，与 initial 分叉

    const result = rollbackTo({ bareRepo: fx.bare, branch: 'main', revision: fx.initialHash });

    expect(result.previous_head).toBe(latestHash);
    expect(result.new_head).toBe(fx.initialHash);
    expect(headOf(fx, 'main')).toBe(fx.initialHash);
  });
});

describe('真实布局只读冒烟（绝不切换真实 stable 引用）', () => {
  it('真实 versions.git 的 refs/heads/stable 存在且可解析为 commit（只读）', () => {
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: REAL_BARE });
    expect(refs).toContain('refs/heads/stable');
    const stableHead = runGit(['rev-parse', '--verify', 'refs/heads/stable^{commit}'], {
      cwd: REAL_BARE,
    });
    expect(stableHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('真实 stable worktree 内容可读（只读冒烟，不做任何切换）', () => {
    const stableWt = path.join(PRESET_ROOT, 'stable');
    expect(fs.existsSync(path.join(stableWt, 'manifest.json'))).toBe(true);
    expect(manifestLine(stableWt)).toBe('initial');
  });
});