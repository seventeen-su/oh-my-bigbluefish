// 专项行为测试：分享后自动初始化三线布局与只读 ACL（substrate/bootstrap.ts ensureThreeLineLayout）。
// 独立临时目录 fixture 注入 layout（绝不触碰真实布局）；真实 git/icacls（禁 mock，同 m0 约定）。
// 覆盖：缺失→完整初始化 / 健康→ok 幂等 / worktree 缺失→修复 / gitfile 旧机器残留→修复 /
//       ACL 丢失→重新施加 / git 不可用→degraded / 非空无 .git→degraded 且保留用户数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_INITIAL,
  MANIFEST_LATEST,
  applyReadOnlyAcl,
  resetReadOnly,
  runGit,
} from '../helpers/git.js';
import { ensureThreeLineLayout, type LayoutBootstrapResult } from '../../substrate/bootstrap.js';
import { loadVersion, type VersionLayout } from '../../substrate/snapshot.js';
// 只读机制是否真约束本进程（root + POSIX 权限位时不约束 → 相关断言跳过而非误判失败）
import { readOnlyEnforced } from '../helpers/sandbox-scripts.js';

/** 捕获写文件异常；返回 (error, code)。写成功则 error 为 null。 */
function captureWriteError(target: string): { error: NodeJS.ErrnoException | null; code: string | undefined } {
  try {
    fs.writeFileSync(target, 'probe');
    return { error: null, code: undefined };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { error: e, code: e.code };
  }
}

function makeLayout(root: string): VersionLayout {
  return {
    bareRepo: path.join(root, 'versions.git'),
    stableWorktree: path.join(root, 'stable'),
    latestWorktree: path.join(root, 'latest'),
  };
}

/** 释放只读 ACL（icacls /reset /T /C）→ 删除临时根（照抄 helpers teardownLayoutFixture 模式） */
function teardownRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  } catch {
    try {
      resetReadOnly(root);
    } catch {
      // 还原失败也继续尝试删除
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 断言目录写被拒（**平台无关**）：写拒绝码随通道而异（Windows ACL → EPERM/EACCES；
 * POSIX 权限位 → EACCES/EACCES；未知 → 一律不通过）。
 *
 * 真机暴露的环境差异（不是缺陷）：POSIX 权限位只读对 **root 无效**（`CAP_DAC_OVERRIDE`），
 * 而 Linux 容器里测试常以 root 跑 → 施加只读后仍能写。此时本函数**显式跳过**该断言（并断言
 * "机制确实不约束本进程"这一事实），而不是把正确行为判成失败。
 */
function assertReadOnly(dir: string): void {
  if (!readOnlyEnforced(dir)) {
    // 机制对本进程不生效（root 等）→ 跳过"写被拒"断言（该降级由平台提供者如实标注）
    return;
  }
  const { error, code } = captureWriteError(path.join(dir, 'probe.txt'));
  expect(error).not.toBeNull();
  expect(['EPERM', 'EACCES', 'EROFS']).toContain(code);
}

/**
 * 读取 worktree 的 manifest.json 并归一化比较：git checkout 在 Windows 默认 core.autocrlf
 * 会把 LF 归一为 CRLF（git-layout.test.ts 用 JSON.parse 规避）→ 这里 JSON.parse 后按
 * 2 空格缩进重新序列化（等价种子内容 MANIFEST_INITIAL/LATEST，行尾无关）。
 */
function readManifest(dir: string): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    name: string;
    version: string;
    line: string;
    components: unknown;
  };
  return JSON.stringify(parsed, null, 2);
}

/**
 * 构造旧种子（T0.2 旧布局形态，eval §17 真实旧种子：无 trusted-latest、基线树无 kernel/policy）：
 * bare init（-b main）→ initial 基线提交（manifest+README，无 kernel/）→ tag initial + stable 分支 →
 * main 推进一版（manifest line=latest，无 kernel/）→ stable/latest 正式 worktree + 只读 ACL。
 * 返回 { initialHash, latestHash }（断言备份数据保留用）。
 */
function buildLegacySeed(root: string, layout: VersionLayout): { initialHash: string; latestHash: string } {
  const bare = layout.bareRepo;
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  runGit(['init', '--bare', '-b', 'main', bare]);
  const seedInitial = path.join(root, '_seed-legacy-initial');
  fs.mkdirSync(seedInitial);
  fs.writeFileSync(path.join(seedInitial, 'manifest.json'), MANIFEST_INITIAL);
  fs.writeFileSync(path.join(seedInitial, 'README.md'), 'OMB v2 版本树引导基线（initial）。\n');
  runGit(['add', '.'], { gitDir: bare, workTree: seedInitial });
  runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'initial baseline'],
    { gitDir: bare, workTree: seedInitial },
  );
  const initialHash = runGit(['rev-parse', 'HEAD'], { cwd: bare });
  runGit(['tag', 'initial'], { cwd: bare });
  runGit(['branch', 'stable'], { cwd: bare });
  const seedLatest = path.join(root, '_seed-legacy-latest');
  fs.mkdirSync(seedLatest);
  fs.writeFileSync(path.join(seedLatest, 'manifest.json'), MANIFEST_LATEST);
  fs.writeFileSync(path.join(seedLatest, 'README.md'), 'OMB v2 latest 基线（main 分支）。\n');
  runGit(['add', '.'], { gitDir: bare, workTree: seedLatest });
  runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'latest baseline'],
    { gitDir: bare, workTree: seedLatest },
  );
  const latestHash = runGit(['rev-parse', 'HEAD'], { cwd: bare });
  runGit(['worktree', 'add', layout.stableWorktree, 'stable'], { cwd: bare });
  runGit(['worktree', 'add', layout.latestWorktree, 'main'], { cwd: bare });
  applyReadOnlyAcl(layout.stableWorktree);
  applyReadOnlyAcl(layout.latestWorktree);
  return { initialHash, latestHash };
}

describe('ensureThreeLineLayout（独立临时 fixture）', () => {
  let root: string;

  afterEach(() => {
    if (root !== undefined) {
      teardownRoot(root);
    }
  });

  it('缺失布局 → 完整初始化：bare+四引用+双 worktree manifest+候选 worktree+只读 ACL', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-init-'));
    const layout = makeLayout(root);
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('initialized');
    // versions.git 存在且含 bare 结构
    expect(fs.existsSync(path.join(layout.bareRepo, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(layout.bareRepo, 'objects'))).toBe(true);
    expect(fs.existsSync(path.join(layout.bareRepo, 'refs'))).toBe(true);
    // 四引用可解析（真实 git；P1a 种子升级新增 trusted-latest = latest 基线）
    for (const ref of ['refs/tags/initial', 'refs/heads/stable', 'refs/heads/main', 'refs/heads/trusted-latest']) {
      const hash = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: layout.bareRepo });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    }
    // trusted-latest 初始 = latest 基线（main head，D1 裁决）
    const trusted = runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: layout.bareRepo });
    const main = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: layout.bareRepo });
    expect(trusted).toBe(main);
    // stable/latest manifest 内容与种子一致（JSON 归一化比较，git autocrlf 行尾无关）
    expect(readManifest(layout.stableWorktree)).toBe(MANIFEST_INITIAL);
    expect(readManifest(layout.latestWorktree)).toBe(MANIFEST_LATEST);
    // P1a 种子升级：正式 worktree 含 kernel/policy + kernel/processes（出厂基线 = repo 快照）
    expect(fs.existsSync(path.join(layout.stableWorktree, 'kernel', 'policy', 'budget.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(layout.stableWorktree, 'kernel', 'processes', 'hypothesize-test.yaml'))).toBe(true);
    // 候选 worktree（0000-bootstrap）存在且是 git worktree
    const candidate = path.join(root, 'workspace', '.omb', '.evolution', 'candidates', '0000-bootstrap');
    expect(fs.existsSync(path.join(candidate, '.git'))).toBe(true);
    // 正式 worktree 写被拒（真实 ACL）
    assertReadOnly(layout.stableWorktree);
    assertReadOnly(layout.latestWorktree);
    // 两线已分叉（stable..main diff 非空）
    const diff = runGit(['diff', '--stat', 'stable..main'], { cwd: layout.bareRepo });
    expect(diff.length).toBeGreaterThan(0);
    // 超时放宽（P1a 种子升级后初始化更重——worktree 含 kernel/policy+processes、icacls 递归更多条目；
    // 全量套件并行时 git/fs 竞争，5s 缺省超时可能不足；与 tests/m8/share-upgrade.test.ts 同款模式）
  }, 30_000);

  it('健康布局 → ok 且幂等（重复调用零副作用）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-healthy-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    const r2 = ensureThreeLineLayout(layout);
    expect(r2.status).toBe('ok');
    const r3 = ensureThreeLineLayout(layout);
    expect(r3.status).toBe('ok');
    // 健康调用不产生新结构：候选 worktree 仍唯一
    const candidates = fs.readdirSync(path.join(root, 'workspace', '.omb', '.evolution', 'candidates'));
    expect(candidates).toEqual(['0000-bootstrap']);
  }, 30_000);

  it('worktree 缺失 → 修复重建（stable 内容恢复为 initial 基线 + 只读 ACL 重新施加）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-missing-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    // 删除 stable worktree（先释放 ACL 才能删）
    resetReadOnly(layout.stableWorktree);
    fs.rmSync(layout.stableWorktree, { recursive: true, force: true });
    expect(fs.existsSync(layout.stableWorktree)).toBe(false);
    // 修复重建
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    expect(readManifest(layout.stableWorktree)).toBe(MANIFEST_INITIAL);
    assertReadOnly(layout.stableWorktree);
  }, 30_000);

  it('gitfile 指向不存在路径（旧机器路径残留）→ 修复后可 loadVersion', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-gitfile-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    // 构造旧机器残留：释放 ACL → 清空 stable 内容（含 kernel/，P1a 种子升级后 worktree 含 policy/processes；
    // 保留 .git 指针）→ 删注册项 → gitfile 指向不存在 gitdir。注意：git 创建的 .git 带 Hidden 属性，
    // Node writeFileSync（O_TRUNC）对其 EPERM（libuv 已知行为）→ 先删除再重建指针文件（rm 不受 Hidden 影响）。
    resetReadOnly(layout.stableWorktree);
    fs.rmSync(path.join(layout.stableWorktree, 'manifest.json'));
    fs.rmSync(path.join(layout.stableWorktree, 'README.md'));
    fs.rmSync(path.join(layout.stableWorktree, 'kernel'), { recursive: true, force: true });
    fs.rmSync(path.join(layout.bareRepo, 'worktrees', 'stable'), { recursive: true, force: true });
    const gitfile = path.join(layout.stableWorktree, '.git');
    fs.rmSync(gitfile);
    fs.writeFileSync(gitfile, 'gitdir: C:/nonexistent/versions.git/worktrees/stable\n');
    // 修复
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    // 修复后 stable 版本线可加载（内容 = initial 基线）
    const snap = await loadVersion('stable', layout);
    expect(readManifest(snap.tree_root)).toBe(MANIFEST_INITIAL);
    assertReadOnly(layout.stableWorktree);
  }, 30_000);

  it('ACL 丢失（目录可写）→ 重新施加后写被拒', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-acl-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    // 模拟 ACL 丢失：/reset 恢复继承 ACL（目录重新可写）
    resetReadOnly(layout.stableWorktree);
    resetReadOnly(layout.latestWorktree);
    expect(captureWriteError(path.join(layout.stableWorktree, 'probe.txt')).error).toBeNull(); // 确认 ACL 确实丢失
    // 修复 → 重新施加只读 ACL
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    assertReadOnly(layout.stableWorktree);
    assertReadOnly(layout.latestWorktree);
  }, 30_000);

  it('全空 bare（存在但无提交）→ 按种子流程补基线（repaired）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-empty-'));
    const layout = makeLayout(root);
    // 先建一个无提交的 bare（不指定 -b，HEAD 可能指向非 main）
    fs.mkdirSync(layout.bareRepo, { recursive: true });
    runGit(['init', '--bare', layout.bareRepo]);
    expect(fs.existsSync(path.join(layout.bareRepo, 'HEAD'))).toBe(true);
    // 补基线修复
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    for (const ref of ['refs/tags/initial', 'refs/heads/stable', 'refs/heads/main', 'refs/heads/trusted-latest']) {
      const hash = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: layout.bareRepo });
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(readManifest(layout.stableWorktree)).toBe(MANIFEST_INITIAL);
    expect(readManifest(layout.latestWorktree)).toBe(MANIFEST_LATEST);
    assertReadOnly(layout.stableWorktree);
  }, 30_000);

  it('旧种子（无 trusted-latest，R1 判定 a）→ 自动迁移重建：备份目录存在 + 新种子完整（trusted-latest=新 main head、基线含 kernel/policy）+ 旧快照清理 + 幂等', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-legacy-'));
    const layout = makeLayout(root);
    const old = buildLegacySeed(root, layout);
    // 预置旧快照目录（模拟旧 commit 物化残留——重建后失效应清理）
    const oldSnapshot = path.join(root, 'workspace', '.omb', 'lines', 'latest', old.latestHash);
    fs.mkdirSync(oldSnapshot, { recursive: true });
    fs.writeFileSync(path.join(oldSnapshot, 'manifest.json'), '{}');
    // ensure → 自动迁移重建
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    expect(r.detail).toContain('旧种子已自动迁移重建');
    // 备份目录存在（versions.git.legacy-<ts>，数据保留：旧 main/stable/initial 仍可解析）
    const backups = fs.readdirSync(root).filter((n) => n.startsWith('versions.git.legacy-'));
    expect(backups).toHaveLength(1);
    const legacyBare = path.join(root, backups[0]!);
    expect(runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: legacyBare })).toBe(old.latestHash);
    expect(runGit(['rev-parse', '--verify', 'refs/heads/stable^{commit}'], { cwd: legacyBare })).toBe(old.initialHash);
    // 新种子完整：trusted-latest 存在且 = 新 main head；基线含 kernel/policy（P1a 种子特征）
    for (const ref of ['refs/tags/initial', 'refs/heads/stable', 'refs/heads/main', 'refs/heads/trusted-latest']) {
      expect(runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: layout.bareRepo })).toMatch(/^[0-9a-f]{40}$/);
    }
    const trusted = runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: layout.bareRepo });
    const main = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: layout.bareRepo });
    expect(trusted).toBe(main);
    const tree = runGit(['ls-tree', '-r', '--name-only', main], { cwd: layout.bareRepo });
    expect(tree).toContain('kernel/policy/budget.yaml');
    expect(tree).toContain('kernel/processes/hypothesize-test.yaml');
    // 正式 worktree 重建：含 policy/processes + 只读 ACL
    expect(fs.existsSync(path.join(layout.stableWorktree, 'kernel', 'policy', 'budget.yaml'))).toBe(true);
    assertReadOnly(layout.stableWorktree);
    // 旧快照目录已清理（重建后旧 commit 快照失效）
    expect(fs.existsSync(oldSnapshot)).toBe(false);
    // 幂等：二次调用不再迁移（状态 ok、无新备份）
    const r2 = ensureThreeLineLayout(layout);
    expect(r2.status).toBe('ok');
    expect(fs.readdirSync(root).filter((n) => n.startsWith('versions.git.legacy-'))).toHaveLength(1);
  }, 30_000);

  it('旧种子（stable 基线树缺 kernel/policy，R1 判定 b——即使有 trusted-latest）→ 自动迁移重建', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-legacy-b-'));
    const layout = makeLayout(root);
    buildLegacySeed(root, layout);
    // 混合形态：有 trusted-latest 但 stable 基线树无 kernel/policy → 判定 (b) 触发迁移
    runGit(['branch', 'trusted-latest', 'refs/heads/main'], { cwd: layout.bareRepo });
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('repaired');
    expect(r.detail).toContain('旧种子已自动迁移重建');
    // 备份 + 新种子 trusted-latest = 新 main head
    expect(fs.readdirSync(root).filter((n) => n.startsWith('versions.git.legacy-'))).toHaveLength(1);
    const trusted = runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: layout.bareRepo });
    const main = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: layout.bareRepo });
    expect(trusted).toBe(main);
    const tree = runGit(['ls-tree', '-r', '--name-only', main], { cwd: layout.bareRepo });
    expect(tree).toContain('kernel/policy/budget.yaml');
  }, 30_000);

  it('新种子 → 不迁移（trusted-latest + policy 齐备 → 正常初始化，零 legacy 备份）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-nomigrate-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    expect(fs.readdirSync(root).filter((n) => n.startsWith('versions.git.legacy-'))).toHaveLength(0);
  }, 30_000);

  it('git 不可用（layout.gitBin 指向不存在 exe）→ degraded 不 throw', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-nogit-'));
    const layout: VersionLayout = {
      ...makeLayout(root),
      gitBin: path.join(root, 'no-git.exe'),
    };
    let r: LayoutBootstrapResult | undefined;
    expect(() => {
      r = ensureThreeLineLayout(layout);
    }).not.toThrow();
    expect(r?.status).toBe('degraded');
    expect((r?.detail ?? '').length).toBeGreaterThan(0);
  });

  it('非空无 .git 的 worktree 目录 → degraded 且内容未被删除', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-bootstrap-data-'));
    const layout = makeLayout(root);
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    // 构造：释放 ACL → 删除 .git 指针 → 留下用户内容
    resetReadOnly(layout.stableWorktree);
    fs.rmSync(path.join(layout.stableWorktree, '.git'));
    fs.writeFileSync(path.join(layout.stableWorktree, 'user-data.txt'), 'keep me');
    const r = ensureThreeLineLayout(layout);
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('stable');
    // 用户数据未被删除
    expect(fs.readFileSync(path.join(layout.stableWorktree, 'user-data.txt'), 'utf8')).toBe('keep me');
    expect(readManifest(layout.stableWorktree)).toBe(MANIFEST_INITIAL);
  }, 30_000);
});
