// layer 1：演化事务封装（架构 §3 ② txn.ts / §11.3 Evolution 事务=git 事务，candidate_id 幂等，分支回退）。
// rollback.ts 目前仅切 head（update-ref 原子切换）；本模块把完整演化事务封装为：
//   建分支（begin）→ 提交（commit）→ 验证（verify，注入）→ 合入（mergeTo，fast-forward）/ 回退
//   （rollback：删事务分支 + worktree 回基）。
// 原子性：合入走 `git update-ref`（lock+rename，同 rollback.ts 语义）；非快进合入 fail-loud（不覆盖分歧目标）。
// layer 1（supervisor/）：仅 import node: 内置 + substrate（GIT_BIN 常量；supervisor 可 import substrate，CONVENTIONS §4）。
import { execFileSync } from 'node:child_process';
import { GIT_BIN } from '../substrate/snapshot.js';

export interface TxnIdentity {
  name: string;
  email: string;
}

export interface TxnOptions {
  /** versions.git（bare repo）目录 */
  bareRepo: string;
  /** 事务工作树（可写；事务改动在此） */
  worktree: string;
  /** 事务分支名（缺省 txn-<epoch>） */
  branch?: string;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
  /** 提交身份（缺省 OMB <omb@local>） */
  identity?: TxnIdentity;
}

export interface TxnCommitResult {
  commit_hash: string;
}

export interface TxnVerifyResult {
  ok: boolean;
  detail: string;
}

export interface TxnMergeResult {
  merged: boolean;
  /** 合入后 target 分支 head（= 事务提交 hash） */
  head: string;
}

export interface TxnRollbackResult {
  rolled_back: boolean;
  branch_deleted: boolean;
}

/**
 * 演化事务（§11.3 Evolution 事务=git 事务）：
 * begin 建事务分支（从 worktree 当前 HEAD）→ commit 提交 → verify 注入验证 →
 * 验证通过 mergeTo(target)（fast-forward 校验后 update-ref 合入）/ 验证失败 rollback（删分支 + worktree 回基）。
 * 状态机：begin 一次；未 begin 的 commit/mergeTo/rollback fail-loud；非快进合入 fail-loud。
 */
export class EvolutionTransaction {
  private readonly bareRepo: string;
  private readonly worktree: string;
  private readonly branch: string;
  private readonly gitBin: string;
  private readonly identity: TxnIdentity;
  private begun = false;
  private baseHead = '';

  constructor(opts: TxnOptions) {
    this.bareRepo = opts.bareRepo;
    this.worktree = opts.worktree;
    this.branch = opts.branch ?? `txn-${Date.now()}`;
    this.gitBin = opts.gitBin ?? GIT_BIN;
    this.identity = opts.identity ?? { name: 'OMB', email: 'omb@local' };
  }

  /** 建分支：记录基 head（worktree 当前 HEAD）→ checkout -b <branch> */
  async begin(): Promise<void> {
    if (this.begun) {
      throw new Error('EvolutionTransaction.begin: 事务已 begin（状态机：begin 仅一次）');
    }
    this.baseHead = this.git(this.worktree, ['rev-parse', 'HEAD']);
    this.git(this.worktree, ['checkout', '-b', this.branch]);
    this.begun = true;
  }

  /** 提交：add -A + commit（身份注入）；返回提交 hash */
  async commit(message: string): Promise<TxnCommitResult> {
    if (!this.begun) {
      throw new Error('EvolutionTransaction.commit: 事务未 begin（先 begin()）');
    }
    this.git(this.worktree, ['add', '-A']);
    this.git(this.worktree, [
      '-c', `user.name=${this.identity.name}`,
      '-c', `user.email=${this.identity.email}`,
      'commit', '-m', message,
    ]);
    return { commit_hash: this.git(this.worktree, ['rev-parse', 'HEAD']) };
  }

  /** 验证（注入）：调用方执行 schema/tsc/回放等验证，返回判定 */
  async verify(fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<TxnVerifyResult> {
    const r = await fn();
    return { ok: r.ok, detail: r.detail ?? (r.ok ? '验证通过' : '验证失败（未提供详情）') };
  }

  /** 合入：fast-forward 校验（target 是事务头祖先）→ update-ref 原子合入；非快进 fail-loud */
  async mergeTo(targetBranch: string): Promise<TxnMergeResult> {
    if (!this.begun) {
      throw new Error('EvolutionTransaction.mergeTo: 事务未 begin（先 begin()）');
    }
    const txnHead = this.git(this.bareRepo, ['rev-parse', '--verify', `refs/heads/${this.branch}^{commit}`]);
    try {
      this.git(this.bareRepo, ['merge-base', '--is-ancestor', `refs/heads/${targetBranch}`, txnHead]);
    } catch {
      throw new Error(
        `EvolutionTransaction.mergeTo: 非快进合入（refs/heads/${targetBranch} 与事务分支 ${this.branch} 已分叉，拒绝覆盖）`,
      );
    }
    this.git(this.bareRepo, ['update-ref', `refs/heads/${targetBranch}`, txnHead]);
    return { merged: true, head: txnHead };
  }

  /** 回退：worktree checkout 回基 head + 删除事务分支（分支不存在视为已删） */
  async rollback(): Promise<TxnRollbackResult> {
    if (!this.begun) {
      throw new Error('EvolutionTransaction.rollback: 事务未 begin（先 begin()）');
    }
    this.git(this.worktree, ['checkout', '--force', this.baseHead]);
    let branchDeleted = true;
    try {
      this.git(this.bareRepo, ['update-ref', '-d', `refs/heads/${this.branch}`]);
    } catch {
      branchDeleted = false; // 分支已不存在（幂等语义：不重复删除）
    }
    return { rolled_back: true, branch_deleted: branchDeleted };
  }

  /** 在指定目录上运行 git（cwd=目录）；非 0 退出抛错并带 stderr（同 substrate 风格） */
  private git(cwd: string, args: string[]): string {
    try {
      const stdout = execFileSync(this.gitBin, args, { cwd, encoding: 'utf8', windowsHide: true });
      return stdout.trimEnd();
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer | string };
      const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
      throw new Error(`git ${args.join(' ')} 失败 (exit=${e.status ?? '?'}): ${detail}`);
    }
  }
}
