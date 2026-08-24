// P1a 行为测试：lines 按线加载机制（substrate/lines.ts，D1 裁决：版本化目录 + 提交级快照）。
// 真实 git 操作（禁 mock）：独立临时 fixture（升级后的 buildLayoutFixture——种子含 kernel/policy +
// kernel/processes 快照 + trusted-latest 分支）上做全部断言，绝不触碰真实布局。
// 覆盖：三线指针解析 / latest 缺失 fail-loud（R1：不再回退 main）/ initial fail-loud / 物化（字节保真 + 幂等 +
// 不同 commit 不同目录）/ 指针（原子写 + 读回 + ensure 幂等）/ 种子升级断言（fixture 与 ensureThreeLineLayout 等价）/
// 装配注入（createCognitiveRuntime 按线注入 lines 目录 + 缺失回退仓库默认 + 显式目录优先）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureThreeLineLayout } from '../../substrate/bootstrap.js';
import {
  LINE_POINTER_REFS,
  currentLineCommit,
  ensureLineSnapshot,
  materializeLineSnapshot,
  resolveLineCommit,
  switchLinePointer,
  type VersionLayout,
  type VersionLine,
} from '../../substrate/lines.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import {
  GIT,
  buildLayoutFixture,
  runGit,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** preset 根（tests/m0/ → ../../）——仓库默认 policy/processes 目录断言用 */
const PRESET_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_POLICY_DIR = path.join(PRESET_ROOT, 'kernel', 'policy');
const REPO_PROCESSES_DIR = path.join(PRESET_ROOT, 'kernel', 'processes');

/** 把 fixture 布局映射为 lines 的 VersionLayout（快照根 = <fx.root>/workspace/.omb/lines，随 teardown 清理） */
function layoutFor(fx: LayoutFixture): VersionLayout {
  return {
    bareRepo: fx.bare,
    stableWorktree: fx.stable,
    latestWorktree: fx.latest,
  };
}

/** 快照目录（与 lines.ts linesBase 推导一致） */
function snapshotDir(fx: LayoutFixture, line: VersionLine, commit: string): string {
  return path.join(fx.root, 'workspace', '.omb', 'lines', line, commit);
}

/** git 对象原始字节（<commit>:<path> blob，内容保真） */
function gitBlobBytes(bare: string, commit: string, treePath: string): Buffer {
  return execFileSync(GIT, ['show', `${commit}:${treePath}`], {
    cwd: bare,
    encoding: 'buffer',
    windowsHide: true,
  }) as Buffer;
}

/** CRLF → LF 归一化（种子字节与 repo 源比较时消除行尾环境差异；autocrlf 环境无关） */
function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 读 manifest.json 的 line 字段 */
function manifestLine(dir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { line?: string };
  return manifest.line ?? '';
}

describe('resolveLineCommit：三线指针解析（升级后 fixture）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('LINE_POINTER_REFS：initial=tag、stable=stable、latest=trusted-latest（D1 裁决）', () => {
    expect(LINE_POINTER_REFS).toEqual({
      initial: 'refs/tags/initial',
      stable: 'refs/heads/stable',
      latest: 'refs/heads/trusted-latest',
    });
  });

  it('三线各自解析：initial=tag、stable=stable 分支、latest=trusted-latest 分支（与真实引用一致）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    // fixture：stable 分支 = initial 基线；trusted-latest = latest 基线
    expect(resolveLineCommit(lay, 'initial')).toBe(fx.initialHash);
    expect(resolveLineCommit(lay, 'stable')).toBe(fx.initialHash);
    expect(resolveLineCommit(lay, 'latest')).toBe(fx.latestHash);
    // 与真实引用 rev-parse 一致
    expect(resolveLineCommit(lay, 'initial')).toBe(
      runGit(['rev-parse', '--verify', 'refs/tags/initial^{commit}'], { cwd: fx.bare }),
    );
    expect(resolveLineCommit(lay, 'latest')).toBe(
      runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: fx.bare }),
    );
  });

  it('latest 缺失 fail-loud：删除 trusted-latest ref（main 仍存在）→ 抛错（R1 不再回退 main，消息含 ref 与重建指引）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    runGit(['update-ref', '-d', 'refs/heads/trusted-latest'], { cwd: fx.bare });
    expect(() => resolveLineCommit(lay, 'latest')).toThrow(/refs\/heads\/trusted-latest/);
    // main 仍可解析（未回退——latest 权威 = trusted-latest，缺失即 fail-loud）
    expect(() => resolveLineCommit(lay, 'latest')).toThrow(/init-three-line|自动重建/);
  });

  it('latest 与 main 均缺失：仍抛错（消息含 refs/heads/trusted-latest）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    runGit(['update-ref', '-d', 'refs/heads/trusted-latest'], { cwd: fx.bare });
    runGit(['update-ref', '-d', 'refs/heads/main'], { cwd: fx.bare });
    expect(() => resolveLineCommit(lay, 'latest')).toThrow(/refs\/heads\/trusted-latest/);
  });

  it('initial fail-loud：删除 initial tag → 抛错（消息含 refs/tags/initial；tag 无回退）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    runGit(['update-ref', '-d', 'refs/tags/initial'], { cwd: fx.bare });
    expect(() => resolveLineCommit(lay, 'initial')).toThrow(/refs\/tags\/initial/);
  });

  it('未知版本线 fail-loud：抛错且消息含合法值', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    expect(() => resolveLineCommit(lay, 'gamma' as VersionLine)).toThrow(/initial \| stable \| latest/);
  });
});

describe('materializeLineSnapshot：物化展开（只读 git 枚举逐文件写出）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('展开内容与线提交一致：manifest/README + kernel/policy + kernel/processes 齐全，字节保真（物化文件 === git blob）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const dir = materializeLineSnapshot(lay, 'stable', fx.initialHash);
    // 目录结构
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    for (const f of ['budget.yaml', 'context.yaml', 'governor.yaml']) {
      expect(fs.existsSync(path.join(dir, 'kernel', 'policy', f)), `kernel/policy/${f}`).toBe(true);
    }
    for (const f of ['hypothesize-test.yaml', 'retrieve-verify.yaml']) {
      expect(fs.existsSync(path.join(dir, 'kernel', 'processes', f)), `kernel/processes/${f}`).toBe(true);
    }
    // 字节保真：物化文件 === 对应 git blob（git show 原始字节，无 trim/编码损伤）
    for (const f of ['budget.yaml', 'context.yaml', 'governor.yaml']) {
      expect(fs.readFileSync(path.join(dir, 'kernel', 'policy', f))).toEqual(
        gitBlobBytes(fx.bare, fx.initialHash, `kernel/policy/${f}`),
      );
    }
    for (const f of ['hypothesize-test.yaml', 'retrieve-verify.yaml']) {
      expect(fs.readFileSync(path.join(dir, 'kernel', 'processes', f))).toEqual(
        gitBlobBytes(fx.bare, fx.initialHash, `kernel/processes/${f}`),
      );
    }
    // 语义等价：与 repo 种子源一致（CRLF 归一化比较——autocrlf 环境无关）
    expect(normalizeLf(fs.readFileSync(path.join(dir, 'kernel', 'policy', 'budget.yaml'), 'utf8'))).toBe(
      normalizeLf(fs.readFileSync(path.join(REPO_POLICY_DIR, 'budget.yaml'), 'utf8')),
    );
    // manifest 内容与线一致（stable = initial 基线）
    expect(manifestLine(dir)).toBe('initial');
  });

  it('幂等：同 commit 二次调用返回同一路径（目录即内容，复用不重写）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const dir1 = materializeLineSnapshot(lay, 'stable', fx.initialHash);
    const dir2 = materializeLineSnapshot(lay, 'stable', fx.initialHash);
    expect(dir2).toBe(dir1);
    expect(fs.existsSync(dir1)).toBe(true);
  });

  it('不同 commit → 不同目录（stable=initial 基线 vs latest=latest 基线，内容按线分化）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const stableDir = materializeLineSnapshot(lay, 'stable', fx.initialHash);
    const latestDir = materializeLineSnapshot(lay, 'latest', fx.latestHash);
    expect(latestDir).not.toBe(stableDir);
    expect(manifestLine(stableDir)).toBe('initial');
    expect(manifestLine(latestDir)).toBe('latest');
    // latest 快照同样含 policy/processes
    expect(fs.existsSync(path.join(latestDir, 'kernel', 'policy', 'governor.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(latestDir, 'kernel', 'processes', 'retrieve-verify.yaml'))).toBe(true);
  });
});

describe('指针：lines/<line>/pointer（原子写 tmp+rename）', () => {
  let fx: LayoutFixture;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
  });

  it('ensureLineSnapshot：解析 → 物化 → 写指针；currentLineCommit 读回；指针文件内容 = commit', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    // 初始无指针
    expect(currentLineCommit(lay, 'stable')).toBeNull();
    const snap = ensureLineSnapshot(lay, 'stable');
    expect(snap.commit).toBe(fx.initialHash);
    expect(snap.dir).toBe(snapshotDir(fx, 'stable', fx.initialHash));
    expect(currentLineCommit(lay, 'stable')).toBe(fx.initialHash);
    // 指针文件内容（lines/<line>/pointer）
    expect(fs.readFileSync(path.join(fx.root, 'workspace', '.omb', 'lines', 'stable', 'pointer'), 'utf8').trim()).toBe(
      fx.initialHash,
    );
  });

  it('switchLinePointer 原子生效：切换到另一 commit → currentLineCommit 读回新值；ensureLineSnapshot 按线重新对账指针', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    ensureLineSnapshot(lay, 'stable');
    // 手动切换指针（原子写生效：读回新值）
    switchLinePointer(lay, 'stable', fx.latestHash);
    expect(currentLineCommit(lay, 'stable')).toBe(fx.latestHash);
    // ensureLineSnapshot 重新解析线指针 commit（stable = initial 基线）→ 指针对账回线真实 commit（不保留手动值）
    const snap = ensureLineSnapshot(lay, 'stable');
    expect(snap.commit).toBe(fx.initialHash);
    expect(currentLineCommit(lay, 'stable')).toBe(fx.initialHash);
    // 指针已与线 commit 一致 → 再次 ensure 幂等（commit/目录不变）
    const snap2 = ensureLineSnapshot(lay, 'stable');
    expect(snap2.commit).toBe(fx.initialHash);
    expect(currentLineCommit(lay, 'stable')).toBe(fx.initialHash);
  });

  it('各线指针独立：initial/stable/latest 各自指向本线 commit', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    ensureLineSnapshot(lay, 'initial');
    ensureLineSnapshot(lay, 'latest');
    expect(currentLineCommit(lay, 'initial')).toBe(fx.initialHash);
    expect(currentLineCommit(lay, 'latest')).toBe(fx.latestHash);
    // 无指针的线 → null
    expect(currentLineCommit(lay, 'stable')).toBeNull();
  });
});

describe('种子升级（P1a）：fixture 与 ensureThreeLineLayout 等价', () => {
  let fx: LayoutFixture;
  let root: string;

  afterEach(() => {
    if (fx) {
      teardownLayoutFixture(fx);
    }
    if (root !== undefined) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // 清理失败忽略
      }
    }
  });

  it('fixture：trusted-latest 分支存在且指向 latest 基线提交（D1 裁决初始值）', () => {
    fx = buildLayoutFixture();
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: fx.bare });
    expect(refs).toContain('refs/heads/trusted-latest');
    expect(runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: fx.bare })).toBe(
      fx.latestHash,
    );
  });

  it('fixture：initial/latest 基线提交树含 kernel/policy + kernel/processes（出厂基线 = repo 快照）', () => {
    fx = buildLayoutFixture();
    for (const commit of [fx.initialHash, fx.latestHash]) {
      const tree = runGit(['ls-tree', '-r', '--name-only', commit], { cwd: fx.bare });
      for (const p of [
        'kernel/policy/budget.yaml',
        'kernel/policy/context.yaml',
        'kernel/policy/governor.yaml',
        'kernel/processes/hypothesize-test.yaml',
        'kernel/processes/retrieve-verify.yaml',
      ]) {
        expect(tree, `commit ${commit.slice(0, 8)} 应含 ${p}`).toContain(p);
      }
    }
  });

  it('ensureThreeLineLayout 初始化：trusted-latest 分支 + 基线提交含 kernel 对象 + worktree 含 policy/processes（与 fixture 等价）', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-lines-bootstrap-'));
    const layout: VersionLayout = {
      bareRepo: path.join(root, 'versions.git'),
      stableWorktree: path.join(root, 'stable'),
      latestWorktree: path.join(root, 'latest'),
    };
    expect(ensureThreeLineLayout(layout).status).toBe('initialized');
    // trusted-latest 存在且 = main head
    const refs = runGit(['for-each-ref', '--format=%(refname)'], { cwd: layout.bareRepo });
    expect(refs).toContain('refs/heads/trusted-latest');
    const trusted = runGit(['rev-parse', '--verify', 'refs/heads/trusted-latest^{commit}'], { cwd: layout.bareRepo });
    const main = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: layout.bareRepo });
    expect(trusted).toBe(main);
    // 基线提交树含 kernel 对象
    const tree = runGit(['ls-tree', '-r', '--name-only', main], { cwd: layout.bareRepo });
    expect(tree).toContain('kernel/policy/budget.yaml');
    expect(tree).toContain('kernel/processes/hypothesize-test.yaml');
    // 正式 worktree（stable = initial 基线 checkout）含 policy/processes
    expect(fs.existsSync(path.join(layout.stableWorktree, 'kernel', 'policy', 'budget.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(layout.stableWorktree, 'kernel', 'processes', 'retrieve-verify.yaml'))).toBe(true);
  });
});

describe('装配注入：createCognitiveRuntime 按线加载（P1a）', () => {
  let fx: LayoutFixture;
  let tmpRoot: string;
  const runtimes: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const rt of runtimes) {
      await rt.close().catch(() => undefined);
    }
    runtimes.length = 0;
    if (fx) {
      teardownLayoutFixture(fx);
    }
    if (tmpRoot !== undefined) {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function makeRoot(): string {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-lines-asm-'));
    return tmpRoot;
  }

  it('线快照含 kernel/policy + kernel/processes → policyDir/processesDir 注入线快照路径，lineSnapshot 就绪', async () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const runtime = createCognitiveRuntime({ root: makeRoot(), line: 'stable', layout: lay });
    runtimes.push(runtime);
    // 注入断言
    expect(runtime.lineSnapshot).toEqual({
      line: 'stable',
      commit: fx.initialHash,
      dir: snapshotDir(fx, 'stable', fx.initialHash),
    });
    expect(runtime.lineDegraded).toBeNull();
    expect(runtime.policyDir).toBe(path.join(snapshotDir(fx, 'stable', fx.initialHash), 'kernel', 'policy'));
    expect(runtime.processesDir).toBe(path.join(snapshotDir(fx, 'stable', fx.initialHash), 'kernel', 'processes'));
    // 运行时实际从线快照加载（内容 = repo 种子，可加载可决策）
    const { policy, processes } = await runtime.ready();
    expect(processes.length).toBe(2);
    expect(policy.budget.depth).toBe(8);
    expect(policy.governor.rules.length).toBeGreaterThan(0);
  });

  it('lines 不可用（stable 引用缺失）→ 回退仓库默认目录 + lineDegraded 记录（装配不崩）', async () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    runGit(['update-ref', '-d', 'refs/heads/stable'], { cwd: fx.bare });
    const runtime = createCognitiveRuntime({ root: makeRoot(), line: 'stable', layout: lay });
    runtimes.push(runtime);
    expect(runtime.lineSnapshot).toBeNull();
    expect(runtime.lineDegraded).not.toBeNull();
    expect(runtime.lineDegraded ?? '').toContain('stable');
    expect(runtime.policyDir).toBe(REPO_POLICY_DIR);
    expect(runtime.processesDir).toBe(REPO_PROCESSES_DIR);
    // 回退后运行时仍可用（仓库默认 policy/processes 加载）
    const { policy, processes } = await runtime.ready();
    expect(processes.length).toBe(2);
    expect(policy.budget).toBeDefined();
  });

  it('线快照缺少 kernel/policy（旧布局种子）→ 回退仓库默认 + 降级原因指向缺失目录（不崩）', async () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const dir = materializeLineSnapshot(lay, 'stable', fx.initialHash);
    // 破坏快照：删除 kernel/（lines 为普通可写目录，物化后无 ACL）
    fs.rmSync(path.join(dir, 'kernel'), { recursive: true, force: true });
    // 同 commit 已物化 → 幂等复用（不重写）→ 缺 policy → 回退
    const runtime = createCognitiveRuntime({ root: makeRoot(), line: 'stable', layout: lay });
    runtimes.push(runtime);
    expect(runtime.lineSnapshot).toBeNull();
    expect(runtime.lineDegraded ?? '').toContain('kernel/policy');
    expect(runtime.policyDir).toBe(REPO_POLICY_DIR);
    expect(runtime.processesDir).toBe(REPO_PROCESSES_DIR);
  });

  it('显式 policyDir/processesDir → 显式目录优先，不走按线加载（测试/兼容注入）', async () => {
    fx = buildLayoutFixture();
    const customPolicy = path.join(fx.root, 'custom-policy');
    const customProcesses = path.join(fx.root, 'custom-processes');
    fs.mkdirSync(customPolicy, { recursive: true });
    fs.mkdirSync(customProcesses, { recursive: true });
    const runtime = createCognitiveRuntime({
      root: makeRoot(),
      line: 'stable',
      policyDir: customPolicy,
      processesDir: customProcesses,
    });
    runtimes.push(runtime);
    expect(runtime.lineSnapshot).toBeNull();
    expect(runtime.lineDegraded).toBeNull();
    expect(runtime.policyDir).toBe(customPolicy);
    expect(runtime.processesDir).toBe(customProcesses);
  });

  it('非法 line 配置 → 回退 stable（守卫式接入）', async () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const runtime = createCognitiveRuntime({ root: makeRoot(), line: 'gamma' as VersionLine, layout: lay });
    runtimes.push(runtime);
    expect(runtime.lineSnapshot).toEqual({
      line: 'stable',
      commit: fx.initialHash,
      dir: snapshotDir(fx, 'stable', fx.initialHash),
    });
  });
});
