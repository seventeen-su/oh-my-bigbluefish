// T0.2 测试工具：真实 git / icacls 调用 + 三线布局 fixture 构造（测试专用，不进生产）。
// 禁 mock：全部走真实 git 可执行文件（完整路径）与真实 Windows ACL。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** git 完整路径（沙箱拦截 PATH 解析，必须用完整路径） */
export const GIT = 'D:\\Git\\cmd\\git.exe';

function icaclsPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
}

export interface GitRunOptions {
  cwd?: string;
  /** 等价 --git-dir=<value>（bare repo 操作） */
  gitDir?: string;
  /** 等价 --work-tree=<value>（bare repo 的一次性工作树） */
  workTree?: string;
}

/** 运行 git（完整路径），返回 stdout（去尾空白）；非 0 退出抛错并带 stderr。 */
export function runGit(args: string[], opts: GitRunOptions = {}): string {
  const fullArgs: string[] = [];
  if (opts.gitDir) {
    fullArgs.push(`--git-dir=${opts.gitDir}`);
  }
  if (opts.workTree) {
    fullArgs.push(`--work-tree=${opts.workTree}`);
  }
  fullArgs.push(...args);
  try {
    const stdout = execFileSync(GIT, fullArgs, {
      cwd: opts.cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`git ${args.join(' ')} 失败 (exit=${e.status ?? '?'}): ${detail}`);
  }
}

/** 运行 icacls（完整路径），返回 stdout（去尾空白）；非 0 退出抛错。 */
export function runIcacls(args: string[]): string {
  try {
    const stdout = execFileSync(icaclsPath(), args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    throw new Error(`icacls ${args.join(' ')} 失败 (exit=${e.status ?? '?'}): ${detail}`);
  }
}

/**
 * 目录级只读 ACL（Windows，实测结论，完整矩阵见 task-0.2-report.md）。
 *
 * brief 原命令 `icacls <dir> /deny "Everyone:(W,WD,AD,DC)" /T /C` 在 Windows 上实测不可用：
 *   - icacls 把 (W,WD,AD,DC) 归一化为泛型 W（存为 (W,DC)），且 deny ACE 会被注入
 *     SYNCHRONIZE；泛型 W 与 SYNCHRONIZE 都是打开目录/文件句柄所必需的 → 目录枚举
 *     （readdir）与子项打开被连带拒绝，icacls 自身 /T 递归也失败（`<dir>\*: Access is
 *     denied`）→ 子项根本没得到拒绝 → 既有文件仍可改/可删，"只读语义"不成立；
 *   - 若把 D 也放进 deny，icacls 存成 Delete+Synchronize → 连文件的读打开都被拒。
 *
 * 等效可实测方案（授权式只读，无 deny ACE、无 SYNCHRONIZE 副作用，一条命令）：
 *   icacls <dir> /inheritance:r /grant:r "Everyone:RX" /T /C
 *   —— 移除继承 ACE，全体仅授 RX（读+执行/遍历）；不再授予任何写/追加/删除/删子项
 *      权限。实测行为矩阵（node fs）：读✓ 枚举✓ 新建✗ 改既有✗ 追加✗ 删既有✗ 改名✗
 *      （写类操作均 EPERM/EACCES）。恢复可写：`icacls <dir> /reset /T /C`（所有者）。
 */
export function applyReadOnlyAcl(dir: string): void {
  runIcacls([dir, '/inheritance:r', '/grant:r', 'Everyone:RX', '/T', '/C']);
}

/** initial 基线 manifest（正式 stable/ 内容） */
export const MANIFEST_INITIAL = JSON.stringify(
  { name: 'omb-v2', version: '0.1.0', line: 'initial', components: {} },
  null,
  2,
);

/** latest 基线 manifest（main 分叉内容） */
export const MANIFEST_LATEST = JSON.stringify(
  { name: 'omb-v2', version: '0.1.0', line: 'latest', components: {} },
  null,
  2,
);

export interface LayoutFixture {
  root: string;
  bare: string;
  stable: string;
  latest: string;
  candidate: string;
  initialHash: string;
}

/**
 * 在独立临时目录完整复现 T0.2 三线布局（步骤 1-5）：
 *   1. git init --bare -b main versions.git
 *   2. 首个基线提交（manifest.json + README.md，inline 作者）→ tag initial + branch stable
 *   3. main 再推进一版（与 stable 分叉）
 *   4. stable/ latest/ 正式 worktree（先 add 后加只读 ACL denyWriteRecursive）
 *   5. workspace/.omb/.evolution/candidates/<id>/ 候选临时可写 worktree（--detach @ initial）
 * 不触碰真实布局（测试安全）。
 */
export function buildLayoutFixture(): LayoutFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-git-layout-'));
  const bare = path.join(root, 'versions.git');
  const stable = path.join(root, 'stable');
  const latest = path.join(root, 'latest');
  const evolution = path.join(root, 'workspace', '.omb', '.evolution');
  const candidate = path.join(evolution, 'candidates', '0000-bootstrap');

  // 1. bare repo（默认分支 main）
  runGit(['init', '--bare', '-b', 'main', bare]);

  // 2. 首个基线提交 + tag initial + stable 分支
  const seedInitial = path.join(root, '_seed-initial');
  fs.mkdirSync(seedInitial);
  fs.writeFileSync(path.join(seedInitial, 'manifest.json'), MANIFEST_INITIAL);
  fs.writeFileSync(path.join(seedInitial, 'README.md'), 'OMB v2 版本树引导基线（initial）。\n');
  const initialOpts: GitRunOptions = { gitDir: bare, workTree: seedInitial };
  runGit(['add', '.'], initialOpts);
  runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'initial baseline'],
    initialOpts,
  );
  const initialHash = runGit(['rev-parse', 'HEAD'], { cwd: bare });
  runGit(['tag', 'initial'], { cwd: bare });
  runGit(['branch', 'stable'], { cwd: bare });

  // 3. main 推进一版（与 stable 分叉，保证 git diff stable..main 非空）
  const seedLatest = path.join(root, '_seed-latest');
  fs.mkdirSync(seedLatest);
  fs.writeFileSync(path.join(seedLatest, 'manifest.json'), MANIFEST_LATEST);
  fs.writeFileSync(path.join(seedLatest, 'README.md'), 'OMB v2 latest 基线（main 分支）。\n');
  const latestOpts: GitRunOptions = { gitDir: bare, workTree: seedLatest };
  runGit(['add', '.'], latestOpts);
  runGit(
    ['-c', 'user.name=OMB', '-c', 'user.email=omb@local', 'commit', '-m', 'latest baseline'],
    latestOpts,
  );

  // 4. 正式 worktree：先 add（此时需可写），后加只读 ACL
  runGit(['worktree', 'add', stable, 'stable'], { cwd: bare });
  runGit(['worktree', 'add', latest, 'main'], { cwd: bare });
  applyReadOnlyAcl(stable);
  applyReadOnlyAcl(latest);

  // 5. 候选临时可写 worktree（detach @ initial）+ .evolution/README.md
  fs.mkdirSync(path.join(evolution, 'candidates'), { recursive: true });
  fs.writeFileSync(
    path.join(evolution, 'README.md'),
    '.evolution = AI 演化工作区（候选临时可写工作树在 candidates/<id>/，正式 stable/latest 只读）。\n',
  );
  runGit(['worktree', 'add', '--detach', candidate, initialHash], { cwd: bare });

  return { root, bare, stable, latest, candidate, initialHash };
}

/** 清理 fixture：先 rmSync；若被 ACL 挡住，先 icacls /reset 还原默认 ACL 再删。 */
export function teardownLayoutFixture(fx: LayoutFixture): void {
  try {
    fs.rmSync(fx.root, { recursive: true, force: true });
    return;
  } catch {
    // 只读 ACL 可能挡住递归删除 → 还原 ACL 后重试
    try {
      runIcacls([fx.root, '/reset', '/T', '/C']);
    } catch {
      // 还原失败也继续尝试删除
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
}