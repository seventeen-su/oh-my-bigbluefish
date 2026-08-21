// T0.3 行为测试：版本加载器 loadVersion（三线版本：initial/stable/latest）。
// 真实 git 操作（禁 mock）：独立临时 fixture（mkdtemp 完整复现三线布局）上做破坏性断言，
// 对真实布局只做只读冒烟。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadVersion, type VersionLine, type VersionSnapshot } from '../../substrate/snapshot.js';
import {
  buildLayoutFixture,
  runGit,
  runIcacls,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** 把 fixture 布局映射为 loader 的 VersionLayout（initial 物化目录放进 fixture 根内，随 teardown 清理） */
function layoutFor(fx: LayoutFixture) {
  return {
    bareRepo: fx.bare,
    stableWorktree: fx.stable,
    latestWorktree: fx.latest,
    initialBase: path.join(fx.root, 'initial-materialized'),
  };
}

/** 读取 tree_root 下 manifest.json 的 line 字段 */
function manifestLine(treeRoot: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(treeRoot, 'manifest.json'), 'utf8')) as {
    line?: string;
  };
  return manifest.line ?? '';
}

describe('loadVersion 三模式加载（独立临时 fixture）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('三种模式（initial/stable/latest）各自加载：tree_root 存在、git_revision 为 40 位 hex 且可解析到 commit', async () => {
    fx = buildLayoutFixture();
    const lines: VersionLine[] = ['initial', 'stable', 'latest'];
    for (const line of lines) {
      const snap: VersionSnapshot = await loadVersion(line, layoutFor(fx));
      // tree_root 存在
      expect(fs.existsSync(snap.tree_root), `line=${line} tree_root 存在`).toBe(true);
      // git_revision 为完整 commit hash
      expect(snap.git_revision, `line=${line} 40 位 hex`).toMatch(/^[0-9a-f]{40}$/);
      // git_revision 可解析到 commit（rev-parse --verify <rev>^{commit} 成功且不变）
      const verify = runGit(['rev-parse', '--verify', `${snap.git_revision}^{commit}`], {
        cwd: fx.bare,
      });
      expect(verify).toBe(snap.git_revision);
    }
  });

  it('版本内容正确：manifest.json 的 line 字段与模式一致（stable/latest 真实分叉）', async () => {
    fx = buildLayoutFixture();
    // fixture 布局：stable 分支 = initial 基线（line=initial）；main 已推进（line=latest）
    const cases: Array<[VersionLine, string]> = [
      ['initial', 'initial'],
      ['stable', 'initial'],
      ['latest', 'latest'],
    ];
    for (const [line, expected] of cases) {
      const snap = await loadVersion(line, layoutFor(fx));
      expect(manifestLine(snap.tree_root), `line=${line} 内容`).toBe(expected);
    }
    // 真实分叉已验证：stable 与 latest 的 tree_root 不同目录、git_revision 不同
    const stable = await loadVersion('stable', layoutFor(fx));
    const latest = await loadVersion('latest', layoutFor(fx));
    expect(stable.git_revision).not.toBe(latest.git_revision);
  });

  it('未知模式 fail-loud：loadVersion("gamma") 抛错且消息含合法值', async () => {
    fx = buildLayoutFixture();
    await expect(loadVersion('gamma' as VersionLine, layoutFor(fx))).rejects.toThrow(
      /initial \| stable \| latest/,
    );
  });

  it('引用缺失 fail-loud：删掉 refs/heads/stable 后加载 stable 抛错', async () => {
    fx = buildLayoutFixture();
    runGit(['update-ref', '-d', 'refs/heads/stable'], { cwd: fx.bare });
    await expect(loadVersion('stable', layoutFor(fx))).rejects.toThrow(/refs\/heads\/stable/);
  });

  it('initial 内容锚定 initial tag：stable 分支推进后 initial 仍读到 initial 基线', async () => {
    fx = buildLayoutFixture();
    // 1. 移除 stable worktree（先还原 ACL 才能删），解除 stable 分支的 checkout 锁
    runIcacls([fx.stable, '/reset', '/T', '/C']);
    runGit(['worktree', 'remove', fx.stable, '--force'], { cwd: fx.bare });
    // 2. 在 bare 上直接为 stable 分支造一个分叉提交（manifest line=stable-advanced）
    const seed = path.join(fx.root, '_seed-stable-adv');
    fs.mkdirSync(seed);
    fs.writeFileSync(
      path.join(seed, 'manifest.json'),
      JSON.stringify({ name: 'omb-v2', version: '0.1.0', line: 'stable-advanced', components: {} }, null, 2),
    );
    fs.writeFileSync(path.join(seed, 'README.md'), 'stable advanced\n');
    runGit(['add', '.'], { gitDir: fx.bare, workTree: seed });
    const tree = runGit(['write-tree'], { gitDir: fx.bare, workTree: seed });
    const advanced = runGit(
      ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit-tree', tree, '-p', fx.initialHash, '-m', 'stable advanced'],
      { gitDir: fx.bare },
    );
    runGit(['update-ref', 'refs/heads/stable', advanced], { cwd: fx.bare });
    // 3. stable 分支已分叉（引用解析为新提交）……
    const stableCommit = runGit(['rev-parse', '--verify', 'refs/heads/stable^{commit}'], {
      cwd: fx.bare,
    });
    expect(stableCommit).toBe(advanced);
    // 4. ……但 initial 仍加载 initial tag 的内容
    const snap = await loadVersion('initial', layoutFor(fx));
    expect(snap.git_revision).toBe(fx.initialHash);
    expect(manifestLine(snap.tree_root)).toBe('initial');
  });
});