// layer 0：启动与完整性校验（架构 §3 ① boot.ts / §11.4 损坏恢复）。
// M0 出口"stable 损坏自动回退"从原语（rollbackTo 手动调用）升级为启动自动检测：
//   bootStable()：loadVersion('stable')（引用可解析 + 内容可读校验）失败 → 自动沿 stable 历史
//   （git rev-list --first-parent）找最后一个完好 revision（git 对象级校验 <rev>:manifest.json 可读，
//   与 worktree 状态无关——ref 完好但 worktree 损坏时同样检出并回退到该 revision 触发 worktree 恢复）
//   → rollbackTo 自动回退（update-ref 原子切换 + worktree checkout 恢复）→ 告警记录
//   （内存 warnings + 可选 warningLog 文件追加，§11.4"stable 损坏 → 回退上一快照"）。
//   全历史均损坏 / initial（tag 无分支可回退）→ ok:false + no_recovery 告警（不抛错，调用方决策）。
// T8.23 决策（明确降级语义）：worktree 同步用 worktreePolicy:'best-effort'——真实布局 stable/latest
//   有 ACL 只读，checkout 同步失败是常态而非异常；ref 切换成功即回退生效，worktree 降级状态
//   （worktree_status/worktree_error）进入 rollback_performed 告警供调用方决策（不静默）。
// 只 import node: 内置与 substrate 内文件（CONVENTIONS §4：substrate 不得 import 任何上层）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LINE_REFS, GIT_BIN, defaultLayout, loadVersion, type VersionLayout, type VersionLine } from './snapshot.js';
import { rollbackTo, type RollbackResult } from './rollback.js';

export { defaultLayout };

export interface BootOptions {
  /** 布局覆盖（测试注入 fixture；缺省真实 preset 布局） */
  layout?: VersionLayout;
  /** 启动校验的版本线（缺省 stable） */
  line?: VersionLine;
  /** 可选：告警追加写文件（每条一行 `[ts] kind: detail`） */
  warningLog?: string;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
}

export interface BootWarning {
  kind: 'stable_damaged' | 'rollback_performed' | 'no_recovery';
  detail: string;
}

export interface BootResult {
  /** 最终是否可用（回退后仍不可加载 / 无恢复路径 → false） */
  ok: boolean;
  line: VersionLine;
  /** 生效 git_revision（回退后为完好 revision；失败时空串） */
  git_revision: string;
  tree_root: string;
  /** 告警记录（§11.4：损坏检测 / 自动回退 / 无恢复路径） */
  warnings: BootWarning[];
  /** 自动回退详情（未回退 → undefined） */
  rollback?: RollbackResult;
}

/** 瞬态锁错误（Windows 文件锁/杀软竞态）：短退避有限次重试；非锁错误/超次 → 直接抛错 */
const LOCK_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_RETRY_COUNT = 3;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 在 bare 上运行 git（cwd=bare）；非 0 退出抛错并带 stderr（与 snapshot.ts 同款） */
function runGit(layout: VersionLayout, args: string[], gitBin?: string): string {
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const stdout = execFileSync(gitBin ?? GIT_BIN, args, {
        cwd: layout.bareRepo,
        encoding: 'utf8',
        windowsHide: true,
      });
      return stdout.trimEnd();
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break; // 非文件锁错误 → 不重试
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1));
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

/** 对象级完整性校验：<rev>:manifest.json 在 git 树中可读（与 worktree 状态无关） */
function manifestExists(layout: VersionLayout, rev: string, gitBin?: string): boolean {
  try {
    runGit(layout, ['cat-file', '-e', `${rev}:manifest.json`], gitBin);
    return true;
  } catch {
    return false;
  }
}

/** 沿 <ref> 历史（--first-parent）找最后一个 manifest.json 可读的 revision；全坏 → null */
function findLastGoodRevision(layout: VersionLayout, ref: string, gitBin?: string): string | null {
  let revs: string[];
  try {
    revs = runGit(layout, ['rev-list', '--first-parent', ref], gitBin)
      .split(/\s+/)
      .filter((s) => s.length > 0);
  } catch {
    return null; // 引用不可枚举 → 无恢复路径
  }
  for (const rev of revs) {
    if (manifestExists(layout, rev, gitBin)) {
      return rev;
    }
  }
  return null;
}

/** 告警追加写（可选 warningLog；每条一行 `[ts] kind: detail`） */
function appendWarning(file: string, w: BootWarning): void {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${w.kind}: ${w.detail}\n`, 'utf8');
}

/**
 * 启动完整性校验（自动回退检测，架构 §11.4）：
 * 1. loadVersion(<line>) 成功 → 直接返回（无告警）；
 * 2. 失败 → stable_damaged 告警 → 沿历史找最后完好 revision：
 *    - 找到 → rollbackTo 自动回退（worktree checkout 尽力恢复内容）→ rollback_performed 告警
 *      → 重新 loadVersion 确认可用；
 *    - 找不到 / line=initial（tag 无分支可回退）→ no_recovery 告警 → ok:false（不抛错）。
 */
export async function bootStable(opts: BootOptions = {}): Promise<BootResult> {
  const line = opts.line ?? 'stable';
  const lay = opts.layout ?? defaultLayout();
  const warnings: BootWarning[] = [];
  const warn = (w: BootWarning): void => {
    warnings.push(w);
    if (opts.warningLog !== undefined) {
      appendWarning(opts.warningLog, w);
    }
  };

  try {
    const snap = await loadVersion(line, lay);
    return { ok: true, line, git_revision: snap.git_revision, tree_root: snap.tree_root, warnings };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warn({ kind: 'stable_damaged', detail: `版本线 ${line} 启动校验失败: ${detail}` });
  }

  // 自动回退：stable/latest 为分支（可 update-ref 切换）；initial 是 tag → 无分支可回退。
  // R1：latest 的分支引用 = trusted-latest（trusted head 指针，不再回退 main）
  const branch = line === 'stable' ? 'stable' : line === 'latest' ? 'trusted-latest' : null;
  if (branch === null) {
    warn({ kind: 'no_recovery', detail: `版本线 ${line} 为 tag（initial），无分支引用可自动回退` });
    return { ok: false, line, git_revision: '', tree_root: '', warnings };
  }

  const ref = LINE_REFS[line];
  const good = findLastGoodRevision(lay, ref, opts.gitBin);
  if (good === null) {
    warn({
      kind: 'no_recovery',
      detail: `版本线 ${line}（${ref}）全历史均无完好 revision（manifest.json 不可读），无法自动回退`,
    });
    return { ok: false, line, git_revision: '', tree_root: '', warnings };
  }

  const worktree = line === 'stable' ? lay.stableWorktree : lay.latestWorktree;
  const rollback = rollbackTo({
    bareRepo: lay.bareRepo,
    revision: good,
    branch,
    worktree,
    gitBin: opts.gitBin,
    // T8.23 决策：真实布局 stable/latest ACL 只读 → 明确降级语义（ref 切换成功即回退生效，
    // worktree 未同步进入告警；strict 会导致真实布局回退永远失败，不采用）
    worktreePolicy: 'best-effort',
  });
  warn({
    kind: 'rollback_performed',
    detail: `版本线 ${line} 已自动回退 ${rollback.previous_head.slice(0, 8)} → ${rollback.new_head.slice(0, 8)}（worktree 同步${
      rollback.worktree_status === 'synced'
        ? '成功'
        : rollback.worktree_status === 'skipped'
          ? '未提供（无需同步）'
          : `降级：${rollback.worktree_error ?? '未知原因'}`
    }）`,
  });

  const snap = await loadVersion(line, lay); // 回退后应可加载；仍失败 → fail（回退到完好 revision 后不可达）
  return { ok: true, line, git_revision: snap.git_revision, tree_root: snap.tree_root, warnings, rollback };
}
