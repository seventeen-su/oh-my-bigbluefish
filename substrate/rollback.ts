// layer 0：版本回滚原语（架构 §11.3 Activation 原子切换 / §11.4 损坏恢复）。
// 只 import node: 内置与 substrate 内文件（CONVENTIONS §4：substrate 不得 import 任何上层）。
//
// 设计（T0.4 brief）：
// - rollbackTo：基于 Git revision 的回退。原子性来自 `git update-ref`（内部 lock+rename），
//   切换后对引用文件 fsync（崩溃一致性，架构 §11.3 crash consistency）。
// - 引用文件路径用 `git rev-parse --git-path refs/heads/<branch>` 解析（相对 bare 根时拼回绝对路径）。
// - worktree 同步尽力而为：checkout --force 失败（如正式 worktree ACL 只读）时返回
//   worktree_synced:false 并告警，不抛错——ref 切换已成功，worktree 刷新是尽力而为。
// - fail-loud：分支缺失 / revision 不存在或不可解析 / update-ref 失败 → 抛错，不做部分切换。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_BIN } from './snapshot.js';

export interface RollbackOptions {
  /** versions.git（bare repo）目录 */
  bareRepo: string;
  /** 回退目标 revision（commit hash / 标签 / 分支名，须能解析为 commit） */
  revision: string;
  /** 要切换的分支（refs/heads/<branch>）；缺省 stable */
  branch?: string;
  /** 若提供：切换后把该 worktree 同步到目标 revision（尽力而为，失败不抛错） */
  worktree?: string;
  /** 切换后是否对引用文件 fsync（缺省 true） */
  fsync?: boolean;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
}

export interface RollbackResult {
  /** 切换前的 head（完整 commit hash） */
  previous_head: string;
  /** 切换后的 head（完整 commit hash，即 revision 解析结果） */
  new_head: string;
  /** worktree 同步结果：true=已同步或未提供；false=同步失败（ref 切换仍已成功） */
  worktree_synced: boolean;
}

/** 在指定目录上运行 git（cwd=目录）；非 0 退出抛错并带 stderr */
function runGit(cwd: string, args: string[], gitBin?: string): string {
  try {
    const stdout = execFileSync(gitBin ?? GIT_BIN, args, {
      cwd,
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

/** 引用文件路径：`git rev-parse --git-path`（相对 bare 根时拼回绝对路径） */
function refFilePath(bareRepo: string, ref: string, gitBin?: string): string {
  const gitPath = runGit(bareRepo, ['rev-parse', '--git-path', ref], gitBin);
  return path.isAbsolute(gitPath) ? gitPath : path.join(bareRepo, gitPath);
}

/** 对引用文件 fsync（open 'r+' → fsyncSync → close）；文件不存在（如 packed ref）则跳过 */
function fsyncRefFile(refPath: string): void {
  if (!fs.existsSync(refPath)) {
    return;
  }
  const fd = fs.openSync(refPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 版本回滚原语：把 refs/heads/<branch> 原子切换到 <revision>。
 * 步骤：读当前 head → 校验 revision 可解析为 commit（fail-loud）→
 *   update-ref 原子切换 → fsync 引用文件 → worktree checkout --force 尽力同步。
 * 唯一不抛错路径：worktree 同步失败（返回 worktree_synced:false）；其余 git 步骤失败均 fail-loud。
 */
export function rollbackTo(opts: RollbackOptions): RollbackResult {
  const branch = opts.branch ?? 'stable';
  const ref = `refs/heads/${branch}`;
  const doFsync = opts.fsync ?? true;

  let previousHead: string;
  try {
    previousHead = runGit(opts.bareRepo, ['rev-parse', '--verify', `${ref}^{commit}`], opts.gitBin);
  } catch (err) {
    throw new Error(`回滚目标分支 ${ref} 缺失或不可解析（${opts.bareRepo}）`, { cause: err });
  }

  let verified: string;
  try {
    verified = runGit(
      opts.bareRepo,
      ['rev-parse', '--verify', `${opts.revision}^{commit}`],
      opts.gitBin,
    );
  } catch (err) {
    throw new Error(
      `回滚目标 revision "${opts.revision}" 不存在或不是 commit（${opts.bareRepo}）`,
      { cause: err },
    );
  }

  // 原子切换（git update-ref 自带 lock+rename）
  runGit(opts.bareRepo, ['update-ref', ref, verified], opts.gitBin);

  if (doFsync) {
    fsyncRefFile(refFilePath(opts.bareRepo, ref, opts.gitBin));
  }

  let worktreeSynced = true;
  if (opts.worktree) {
    try {
      runGit(opts.worktree, ['checkout', '--force', verified], opts.gitBin);
    } catch (err) {
      worktreeSynced = false;
      console.warn(
        `[rollback] ref 已切换到 ${verified}，但 worktree（${opts.worktree}）同步失败（尽力而为）：${String((err as Error).message)}`,
      );
    }
  }

  return { previous_head: previousHead, new_head: verified, worktree_synced: worktreeSynced };
}
