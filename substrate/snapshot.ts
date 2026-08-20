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

/** git 可执行文件完整路径（沙箱拦截 PATH 解析，CONVENTIONS §2） */
export const GIT_BIN = 'D:\\Git\\cmd\\git.exe';

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

/** 三线 → 引用 */
const LINE_REFS: Record<VersionLine, string> = {
  initial: 'refs/tags/initial',
  stable: 'refs/heads/stable',
  latest: 'refs/heads/main',
};

/** 进程内 initial 物化目录缓存（每 bare 一次；避免重复 worktree add 与内容漂移） */
const materializedInitial = new Map<string, string>();

/** preset 根（本文件在 <preset>/substrate/ → 上一级即 preset 根） */
function presetRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** 默认布局：相对本模块位置解析真实 preset/omb-v2 三线布局 */
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

/** 在 bare 上运行 git（cwd=bare）；非 0 退出抛错并带 stderr */
function runGit(layout: VersionLayout, args: string[]): string {
  try {
    const stdout = execFileSync(layout.gitBin ?? GIT_BIN, args, {
      cwd: layout.bareRepo,
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
