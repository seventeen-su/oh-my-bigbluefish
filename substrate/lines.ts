// layer 0：lines 按线加载机制（P1a，D1 裁决：版本化目录 + 提交级运行时快照，架构 §11.1）。
// 三线承载版本化认知对象（policy/processes 等）：运行时按当前版本线从 versions.git 解析 commit →
// 物化到 <presetRoot>/workspace/.omb/lines/<line>/<commit>/（不可变快照目录）→ 构造运行时快照 → 加载。
// initial = 永久不可变 tag；stable = refs/heads/stable；latest = trusted head 指针
// （refs/heads/trusted-latest——R1 起缺失即 fail-loud：旧种子由启动 ensureThreeLineLayout 自动重建，
// 不再回退 main）。切换 = 改指针（原子写），下一请求读新快照；
// **禁止原地 checkout/worktree/archive 改写运行目录**（Windows git/icacls 锁竞态）。
// 只 import node: 内置与 substrate 内文件（CONVENTIONS §4：substrate 不得 import 任何上层）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_BIN, VALID_LINES, runGit, type VersionLayout, type VersionLine } from './snapshot.js';

export { isVersionLine, VALID_LINES, type VersionLayout, type VersionLine } from './snapshot.js';

/** 三线 → 线指针引用（D1 裁决：latest = trusted head 指针，≠ main HEAD；initial = 永久不可变 tag） */
export const LINE_POINTER_REFS: Record<VersionLine, string> = {
  initial: 'refs/tags/initial',
  stable: 'refs/heads/stable',
  latest: 'refs/heads/trusted-latest',
};

/** 瞬态锁错误（Windows 文件锁/杀软竞态）：短退避有限次重试（与 snapshot.ts runGit 同款风格）；非锁错误/超次 → 直接抛错 */
const LOCK_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_RETRY_COUNT = 3;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 在 bare 上运行 git 并返回原始字节（git show 内容保真：不经 utf8 解码/trim，写出的文件字节与 blob 完全一致）。
 *  瞬态锁重试与 runGit 同款；非 0 退出抛错并带 stderr。 */
function runGitBytes(layout: VersionLayout, args: string[]): Buffer {
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      return execFileSync(layout.gitBin ?? GIT_BIN, args, {
        cwd: layout.bareRepo,
        encoding: 'buffer',
        windowsHide: true,
      }) as Buffer;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break; // 非文件锁错误（git 逻辑错误/未知）→ 不重试，立即报错
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

/** 文件写出（Windows 瞬态锁：EPERM/EBUSY/EACCES 短退避重试，与 git 调用同款；幂等语义） */
function writeFileRetry(file: string, data: Buffer | string): void {
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break;
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 快照根：<presetRoot>/workspace/.omb/lines（layout.bareRepo 的父目录即 preset 根 / 测试 fixture 根） */
function linesBase(layout: VersionLayout): string {
  return path.join(path.dirname(layout.bareRepo), 'workspace', '.omb', 'lines');
}

/** 某版本线目录（linesBase/<line>） */
function lineDir(layout: VersionLayout, line: VersionLine): string {
  return path.join(linesBase(layout), line);
}

/** 指针文件路径（lines/<line>/pointer，内容 = 当前生效 commit） */
function pointerPath(layout: VersionLayout, line: VersionLine): string {
  return path.join(lineDir(layout, line), 'pointer');
}

/**
 * 解析版本线指针 → 完整 commit hash（40 位 hex）。
 * - initial：tag 缺失/不可解析 → 抛错（fail-loud，initial 为永久基线不可回退）；
 * - stable：分支缺失 → 抛错；
 * - latest：trusted-latest 缺失/不可解析 → fail-loud（R1：不再回退 main——旧种子/未重建时
 *   由启动 ensureThreeLineLayout 自动迁移重建，或手动 pnpm init-three-line；消息含重建指引）。
 */
export function resolveLineCommit(layout: VersionLayout, line: VersionLine): string {
  const ref = LINE_POINTER_REFS[line];
  if (ref === undefined) {
    throw new Error(`未知版本线 "${String(line)}"：合法值为 ${VALID_LINES.join(' | ')}`);
  }
  try {
    return runGit(layout, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch (err) {
    const guidance =
      line === 'latest'
        ? '（旧种子/未重建——启动时 ensureThreeLineLayout 自动重建；或手动 pnpm init-three-line）'
        : '';
    throw new Error(
      `版本线 "${line}" 引用缺失或不可解析（${ref}）：请检查 versions.git（${layout.bareRepo}）${guidance}`,
      { cause: err },
    );
  }
}

/**
 * 把 commit 物化展开到 <presetRoot>/workspace/.omb/lines/<line>/<commit>/（不可变快照目录）。
 * **禁止 worktree/checkout/archive**（锁竞态，D1 裁决）：只读 git 枚举逐文件写出——
 * `git ls-tree -r --name-only <commit>`（-z 原始路径，不经 quoting）→ 逐文件 `git show <commit>:<path>`
 * （原始字节）写相对路径（含子目录 mkdir）。已存在同 commit 目录 → 直接复用（幂等：同 commit 内容
 * 不可变，目录即内容）。返回快照目录路径。
 *
 * **原子性（审查修复）**：逐文件写不是原子的——进程被杀、ENOSPC、git 中途失败都会留下**半棵树**，
 * 而"目录存在即复用"会把这半棵树当成完整快照永久使用：装配侧只看到"版本线 X 快照缺少
 * kernel/policy/processes"并回退仓库默认，真因（物化残缺）永远不会浮出，且每次启动都这样。
 * 故改为**写到暂存目录 → 全部写完 → rename 就位**：目标目录一旦存在，其内容必然完整。
 * 目标已存在（并发赢家）→ 丢弃自己的暂存目录并复用；残留的陈旧暂存目录先清理（幂等重试）。
 */
export function materializeLineSnapshot(layout: VersionLayout, line: VersionLine, commit: string): string {
  const dir = path.join(linesBase(layout), line, commit);
  if (fs.existsSync(dir)) {
    return dir; // 幂等复用（同 commit 内容不可变 + 只有 rename 才会让它出现，故内容必然完整）
  }
  const staging = path.join(linesBase(layout), line, `.staging-${commit}-${process.pid}-${Date.now().toString(36)}`);
  // 上一次中断可能留下同名暂存目录（pid/时间戳不同则不会撞名；撞上就清掉重来）
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // 清理失败不致命：rename 目标若已存在会走"并发赢家"分支
  }
  const names = runGit(layout, ['ls-tree', '-r', '--name-only', '-z', commit])
    .split('\0')
    .filter((n) => n.length > 0);
  for (const name of names) {
    const target = path.join(staging, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileRetry(target, runGitBytes(layout, ['show', `${commit}:${name}`]));
  }
  try {
    fs.renameSync(staging, dir);
  } catch (err) {
    // 并发赢家已把完整快照就位 → 丢弃自己的暂存目录并复用它（内容同 commit，等价）
    if (fs.existsSync(dir)) {
      fs.rmSync(staging, { recursive: true, force: true });
      return dir;
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

/** 当前线指针（lines/<line>/pointer 内容 = commit）；无指针文件 → null */
export function currentLineCommit(layout: VersionLayout, line: VersionLine): string | null {
  try {
    const content = fs.readFileSync(pointerPath(layout, line), 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null; // 指针缺失/不可读 → 无当前指针（未切换过）
  }
}

/** 原子写线指针：tmp 文件 + rename（覆盖已存在目标；瞬态锁重试）。切换即改指针，下一请求读新快照。 */
export function switchLinePointer(layout: VersionLayout, line: VersionLine, commit: string): void {
  const dir = lineDir(layout, line);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.pointer-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileRetry(tmp, `${commit}\n`);
  let last: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      fs.renameSync(tmp, pointerPath(layout, line));
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !LOCK_RETRYABLE.has(code)) {
        break;
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        sleepMs(50 * (attempt + 1));
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true }); // rename 失败 → 清理临时文件（失败忽略）
  } catch {
    // 清理失败 → 临时残留（.pointer-*.tmp），下次原子写覆盖同名随机名，无害
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * 确保版本线快照就绪：解析线指针 commit → 物化到 lines/<line>/<commit>/ → 写指针
 * （内容与当前指针不同时原子写）→ 返回 { commit, dir }。
 */
export function ensureLineSnapshot(layout: VersionLayout, line: VersionLine): { commit: string; dir: string } {
  const commit = resolveLineCommit(layout, line);
  const dir = materializeLineSnapshot(layout, line, commit);
  if (currentLineCommit(layout, line) !== commit) {
    switchLinePointer(layout, line, commit);
  }
  return { commit, dir };
}
