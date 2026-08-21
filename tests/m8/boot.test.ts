// T8.1 行为测试：恢复根启动与完整性校验（substrate/boot.ts，架构 §3 ① / §11.4 损坏恢复）。
// M0 出口"stable 损坏自动回退"从原语（rollbackTo 手动调用）升级为启动自动检测：
//   启动时 loadVersion('stable') 失败（引用损坏/内容不可读）→ 自动沿 stable 历史找最后一个
//   完好 revision（git 对象级校验 manifest.json 可读）→ rollbackTo 自动回退 → 告警记录。
// 真实 git 操作（禁 mock）：独立临时 fixture 上做破坏性操作，绝不触碰真实布局。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootStable } from '../../substrate/boot.js';
import { loadVersion } from '../../substrate/snapshot.js';
import {
  buildLayoutFixture,
  runGit,
  runIcacls,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** 解除 fixture stable worktree 的只读 ACL（checkout 同步需要可写） */
function makeStableWritable(fx: LayoutFixture): void {
  runIcacls([fx.stable, '/reset', '/T', '/C']);
}

/** 解析 bare 上某分支当前 head */
function headOf(fx: LayoutFixture, branch = 'stable'): string {
  return runGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: fx.bare });
}

/**
 * 在 stable 上造一个"损坏提交"（树中无 manifest.json——引用可解析但内容不可读）
 * 并把 stable 指向它；worktree 同步到该损坏提交（模拟线上损坏状态）。
 * 返回损坏 commit hash。
 */
function advanceStableBroken(fx: LayoutFixture): string {
  const seed = path.join(fx.root, '_seed-broken');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'broken commit without manifest\n');
  runGit(['add', '.'], { gitDir: fx.bare, workTree: seed });
  const tree = runGit(['write-tree'], { gitDir: fx.bare, workTree: seed });
  const commit = runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-p', fx.initialHash, '-m', 'broken stable'],
    { gitDir: fx.bare },
  );
  runGit(['update-ref', 'refs/heads/stable', commit], { cwd: fx.bare });
  // worktree 同步到损坏提交：manifest.json 从 worktree 消失（内容不可读）
  runGit(['checkout', '--force', commit], { cwd: fx.stable });
  return commit;
}

describe('bootStable 启动完整性校验（独立临时 fixture）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('健康启动：stable 完好 → ok、无告警、git_revision 为当前 stable head、内容可读', async () => {
    fx = buildLayoutFixture();
    const result = await bootStable({
      layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
    });

    expect(result.ok).toBe(true);
    expect(result.line).toBe('stable');
    expect(result.git_revision).toBe(fx.initialHash);
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(result.tree_root, 'manifest.json'))).toBe(true);
  });

  it('e2e 验收：启动时 stable 引用指向损坏提交（树无 manifest.json）→ 自动回退上一完好 revision 并告警', async () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    const broken = advanceStableBroken(fx);
    expect(headOf(fx)).toBe(broken);
    // 前置确认：损坏状态下 loadVersion 确实失败（内容不可读）
    await expect(
      loadVersion('stable', { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest }),
    ).rejects.toThrow(/不可读|manifest/);

    const result = await bootStable({
      layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
    });

    // 自动回退：stable head 回到 initialHash（最后一个完好 revision）
    expect(result.ok).toBe(true);
    expect(result.git_revision).toBe(fx.initialHash);
    expect(headOf(fx)).toBe(fx.initialHash);
    expect(result.rollback).toBeDefined();
    expect(result.rollback!.previous_head).toBe(broken);
    expect(result.rollback!.new_head).toBe(fx.initialHash);
    // worktree 已同步恢复：manifest.json 重新存在且内容正确
    expect(result.rollback!.worktree_synced).toBe(true);
    expect(fs.existsSync(path.join(fx.stable, 'manifest.json'))).toBe(true);
    // 告警记录：至少一条损坏检测告警 + 回退告警
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.kind === 'stable_damaged')).toBe(true);
    expect(result.warnings.some((w) => w.kind === 'rollback_performed')).toBe(true);
  });

  it('启动后 stable 内容可加载（loadVersion 恢复正常）', async () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    advanceStableBroken(fx);

    const result = await bootStable({
      layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
    });
    expect(result.ok).toBe(true);

    const snap = await loadVersion('stable', {
      bareRepo: fx.bare,
      stableWorktree: fx.stable,
      latestWorktree: fx.latest,
    });
    expect(snap.git_revision).toBe(fx.initialHash);
  });

  it('warningLog 文件：提供路径 → 告警内容追加写入（文件存在且含回退信息）', async () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    advanceStableBroken(fx);
    const logFile = path.join(fx.root, 'boot-warnings.log');

    const result = await bootStable({
      layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
      warningLog: logFile,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('stable');
    expect(content).toContain('回退');
  });
});

describe('bootStable 无恢复路径（独立构造损坏裸仓库）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('全历史均损坏（唯一提交无 manifest.json）→ ok:false + no_recovery，不抛错', async () => {
    fx = buildLayoutFixture();
    makeStableWritable(fx);
    // 构造一个"只有损坏提交"的裸仓库：新建 bare，单提交（README only），stable 指向它
    const root2 = path.join(fx.root, 'all-broken');
    const bare = path.join(root2, 'versions.git');
    const stableWt = path.join(root2, 'stable');
    const latestWt = path.join(root2, 'latest');
    fs.mkdirSync(bare, { recursive: true });
    runGit(['init', '--bare', '-b', 'main', bare]);
    const seed = path.join(root2, '_seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'README.md'), 'no manifest anywhere\n');
    runGit(['add', '.'], { gitDir: bare, workTree: seed });
    const tree = runGit(['write-tree'], { gitDir: bare, workTree: seed });
    const commit = runGit(
      ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-m', 'broken only'],
      { gitDir: bare },
    );
    runGit(['branch', 'main', commit], { cwd: bare });
    runGit(['branch', 'stable', commit], { cwd: bare });
    runGit(['worktree', 'add', stableWt, 'stable'], { cwd: bare });
    runGit(['worktree', 'add', latestWt, 'main'], { cwd: bare });
    runGit(['checkout', '--force', commit], { cwd: stableWt });

    const result = await bootStable({
      layout: { bareRepo: bare, stableWorktree: stableWt, latestWorktree: latestWt },
    });

    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.kind === 'no_recovery')).toBe(true);
    expect(result.rollback).toBeUndefined();
  });
});
