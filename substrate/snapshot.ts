// layer 0：版本加载器（三线版本 initial/stable/latest，架构 §11.1）。
// 只 import node: 内置（CONVENTIONS §4：substrate 不得 import 任何上层）。
//
// 设计决策（T0.3）：
// - 三线映射：initial → refs/tags/initial；stable → refs/heads/stable；latest → refs/heads/main
// - git_revision = 引用解析到的完整 commit hash（rev-parse <ref>^{commit}）
// - tree_root：stable/latest 用对应正式 worktree（只读）；initial 无专用 worktree，
//   把 initial tag 的 commit 物化为 detached worktree（进程内缓存，每 bare 一次），
//   保证 stable 分支推进后 initial 仍读到 initial tag 的内容（不随 stable 漂移）。
// - 未知模式 / 引用缺失 / 内容不可读 → fail-loud（抛错，消息含合法值）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** git 可执行文件解析（迁移可移植；优先级：GIT_BIN 环境变量 → Windows where.exe 发现 → PATH 'git'）。
 *  DSH 沙箱可能拦截 PATH 解析（CONVENTIONS §2）→ 部署可设 GIT_BIN 指向完整路径。 */
function resolveGitBin(): string {
  const env = process.env.GIT_BIN;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
      const first = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (first !== undefined) {
        return first;
      }
    } catch {
      // where.exe 发现失败（git 不在 PATH）→ 回退 PATH 'git'
    }
  }
  return 'git';
}

/** git 可执行文件完整路径（解析结果缓存；缺失时回退 PATH 'git'） */
export const GIT_BIN = resolveGitBin();

export type VersionLine = 'initial' | 'stable' | 'latest';

export const VALID_LINES: readonly VersionLine[] = ['initial', 'stable', 'latest'];

export interface VersionSnapshot {
  /** 该版本线内容所在目录（读 <tree_root>/manifest.json 即版本内容） */
  tree_root: string;
  /** 该版本线引用解析到的完整 commit hash（40 位 hex） */
  git_revision: string;
}

export interface VersionLayout {
  /** versions.git（bare repo）目录 */
  bareRepo: string;
  /** stable 正式 worktree 根（只读） */
  stableWorktree: string;
  /** latest 正式 worktree 根（main 分支，只读） */
  latestWorktree: string;
  /** initial 物化目录的父目录（缺省用系统临时目录；每 bare 建唯一子目录） */
  initialBase?: string;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
}

/** 三线 → 引用（boot.ts 等 substrate 内文件复用；refs/tags/initial、refs/heads/stable、refs/heads/main） */
export const LINE_REFS: Record<VersionLine, string> = {
  initial: 'refs/tags/initial',
  stable: 'refs/heads/stable',
  latest: 'refs/heads/main',
};

/** 进程内 initial 物化目录缓存（每 bare 一次；避免重复 worktree add 与内容漂移） */
const materializedInitial = new Map<string, string>();

/** preset 根（src 布局本文件在 <preset>/substrate/ → 上一级即 preset 根；编译布局 <preset>/lib/substrate/ 多一层 → 存在性回退）。
 *  导出供 substrate 内文件复用（bootstrap.ts 种子取 repo kernel/policy 源；P1a lines.ts 同款推导）。 */
export function presetRoot(): string {
  const candidate = fileURLToPath(new URL('..', import.meta.url));
  return fs.existsSync(path.join(candidate, 'kernel', 'policy')) ? candidate : path.dirname(candidate);
}

/** 默认布局：相对本模块位置解析真实三线布局 */
export function defaultLayout(): VersionLayout {
  const root = presetRoot();
  return {
    bareRepo: path.join(root, 'versions.git'),
    stableWorktree: path.join(root, 'stable'),
    latestWorktree: path.join(root, 'latest'),
  };
}

function isVersionLine(value: unknown): value is VersionLine {
  return value === 'initial' || value === 'stable' || value === 'latest';
}

/** 瞬态锁错误（Windows 文件锁/杀软竞态）：短退避有限次重试；非锁错误/超次 → 直接抛错 */
const LOCK_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_RETRY_COUNT = 3;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 在 bare 上运行 git（cwd=bare）；非 0 退出抛错并带 stderr。
 *  导出供 substrate 内文件复用（lines.ts 解析线指针/枚举树，P1a 同款瞬态锁重试）。 */
export function runGit(layout: VersionLayout, args: string[]): string {
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const stdout = execFileSync(layout.gitBin ?? GIT_BIN, args, {
        cwd: layout.bareRepo,
        encoding: 'utf8',
        windowsHide: true,
      });
      return stdout.trimEnd();
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break; // 非文件锁错误（git 逻辑错误/未知）→ 不重试，立即报错
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1)); // 短退避（50ms/100ms）
      }
    }
  }
  const e = last as { status?: number; stderr?: Buffer | string };
  const detail = e && e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
  const code = (last as NodeJS.ErrnoException).code;
  throw new Error(
    `git ${args.join(' ')} 失败 (exit=${(e as { status?: number }).status ?? '?'}${code === undefined ? '' : ` code=${code}`}): ${detail}`,
  );
}

/** 把 initial tag 的 commit 物化为 detached worktree（进程内缓存，只物化一次） */
function materializeInitialTree(layout: VersionLayout, commit: string): string {
  const cached = materializedInitial.get(layout.bareRepo);
  if (cached !== undefined && fs.existsSync(cached)) {
    return cached;
  }
  const base = layout.initialBase ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'initial-'));
  runGit(layout, ['worktree', 'add', '--detach', dir, commit]);
  materializedInitial.set(layout.bareRepo, dir);
  return dir;
}

/**
 * 清理跨进程残留的 initial 物化 worktree（%TEMP%\initial-*）。
 * 每次进程启动调用（本进程 materializedInitial 尚为空 → 不会误删本进程物化）：
 * 注册表（<bare>/worktrees/initial-*）的 gitdir 指向系统临时目录即视为上一进程残留 →
 * 删除目录 + 注册项 + worktree prune。返回清理数量（0 = 无残留）。
 */
export function cleanupStaleInitialWorktrees(layout: VersionLayout = defaultLayout()): number {
  const regDir = path.join(layout.bareRepo, 'worktrees');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(regDir);
  } catch {
    return 0; // 注册表不存在 → 无残留
  }
  const tmpForms: string[] = [path.resolve(os.tmpdir()).toLowerCase()];
  try {
    tmpForms.push(path.resolve(fs.realpathSync(os.tmpdir())).toLowerCase());
  } catch {
    // tmpdir realpath 失败 → 仅原始形式比对
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('initial-')) {
      continue;
    }
    const gitdirFile = path.join(regDir, name, 'gitdir');
    let target = '';
    try {
      target = fs.readFileSync(gitdirFile, 'utf8').trim();
    } catch {
      continue; // 注册项不完整 → 留给 worktree prune
    }
    const targetNorm = path.resolve(path.dirname(target)).toLowerCase();
    // 系统临时目录判定：git 存长路径、os.tmpdir() 可能报短路径（Windows 8.3）且 realpath 不归一 →
    // 注册名 initial-* + 路径含 <temp>\initial- 即视为系统临时物化；自定义 initialBase 不匹配
    const isTemp = tmpForms.some((t) => targetNorm.startsWith(t))
      || targetNorm.includes('\\temp\\initial-');
    if (!isTemp) {
      continue; // 非系统临时目录物化（如自定义 initialBase）→ 不动
    }
    const wd = path.dirname(target); // <tmp>/initial-XXXX/.git → 物化目录
    try {
      if (fs.existsSync(wd)) {
        fs.rmSync(wd, { recursive: true, force: true });
      }
    } catch {
      // 删除失败（锁等）→ 保留注册项，留给后续 prune
    }
    try {
      fs.rmSync(path.join(regDir, name), { recursive: true, force: true });
    } catch {
      // 注册项删除失败 → 保留（prune 兜底）
    }
    removed += 1;
  }
  if (removed > 0) {
    try {
      runGit(layout, ['worktree', 'prune']);
    } catch {
      // prune 失败不致命（目录/注册项已尽力清理）
    }
  }
  return removed;
}

/** 本进程已物化的 initial 目录（插件退出清理用；避免跨进程残留累积） */
export function materializedInitialPaths(): string[] {
  return [...materializedInitial.values()];
}

/** 本进程物化清理：删目录 + prune + 清缓存（插件生命周期关闭时调用；幂等） */
export function disposeMaterializedInitial(layout: VersionLayout = defaultLayout()): void {
  for (const dir of materializedInitialPaths()) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // 删除失败 → 留给下次启动的 cleanupStaleInitialWorktrees
    }
  }
  materializedInitial.clear();
  try {
    runGit(layout, ['worktree', 'prune']);
  } catch {
    // prune 失败不致命
  }
}

/**
 * 加载指定版本线：返回 { tree_root, git_revision }。
 * 前置完整性校验：引用存在且可解析为 commit + tree_root/manifest.json 可读；任一失败 fail-loud。
 * @param line 版本线（initial | stable | latest）
 * @param layout 布局覆盖（测试注入 fixture；缺省用真实 preset 布局）
 */
export async function loadVersion(line: VersionLine, layout?: VersionLayout): Promise<VersionSnapshot> {
  const lay = layout ?? defaultLayout();
  const ref = LINE_REFS[line];
  if (ref === undefined) {
    throw new Error(`未知版本线 "${String(line)}"：合法值为 ${VALID_LINES.join(' | ')}`);
  }
  let commit: string;
  try {
    commit = runGit(lay, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch (err) {
    throw new Error(
      `版本线 "${line}" 引用缺失或不可解析（${ref}）：请检查 versions.git（${lay.bareRepo}）`,
      { cause: err },
    );
  }
  let treeRoot: string;
  if (line === 'stable') {
    treeRoot = lay.stableWorktree;
  } else if (line === 'latest') {
    treeRoot = lay.latestWorktree;
  } else {
    treeRoot = materializeInitialTree(lay, commit);
  }
  const manifestPath = path.join(treeRoot, 'manifest.json');
  if (!fs.existsSync(treeRoot) || !fs.existsSync(manifestPath)) {
    throw new Error(`版本线 "${line}" 内容不可读（${manifestPath} 缺失或不可访问）`);
  }
  return { tree_root: treeRoot, git_revision: commit };
}

export { isVersionLine };