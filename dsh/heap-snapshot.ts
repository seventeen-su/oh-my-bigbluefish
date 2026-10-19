/**
 * 进程内 V8 heap snapshot 的**安全落盘**（v4.5.3）。
 *
 * 为什么单独一层：`/omb-heap snapshot` 与 `omb_status({ snapshot: true })`
 * 都会同步写数 GB 的文件。此前两处各自 `mkdirSync + writeHeapSnapshot`：
 * 没有磁盘空间检查、没有保留上限、也没有"快照含敏感内容"的提示。
 * 两处复制同一段代码必然会漂移（一处补了、另一处没补），所以集中在这里。
 *
 * 这里的检查**不改变快照内容**：它只回答"能不能写、写完之后留几份"。
 * 真正的取证语义（repro / early 两种模式）在 `scripts/heap-snapshot.ps1`，
 * 两者不可混用（early 降低了堆上限，数据不等价于原始故障）。
 */
import { mkdirSync, readdirSync, statSync, statfsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeHeapSnapshot as writeV8HeapSnapshot } from 'node:v8'

/** 默认保留最近几份快照（更早的自动删除，避免静默占满磁盘）。 */
export const HEAP_SNAPSHOT_KEEP = 3
/** 写快照前要求的最小可用空间（单份快照可能接近 2.5GB，留出重建/复制余量）。 */
export const HEAP_SNAPSHOT_MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024
/** 快照目录（相对 cwd；`.omb/` 已在 .gitignore 中）。 */
export const HEAP_SNAPSHOT_RELATIVE_DIR = '.omb/heap'

/**
 * 隐私提示：**快照不是普通日志**。
 *
 * V8 heap snapshot 会包含字符串字面量、提示词、会话内容、路径与令牌片段。
 * 它必须被当作敏感诊断材料：不随仓库提交、不贴到公开 issue、共享前先脱敏。
 */
export const HEAP_SNAPSHOT_PRIVACY_NOTE =
  '快照含提示词、会话内容、路径等敏感字符串，属**敏感诊断材料**：不要提交到仓库、不要公开分享；'
  + '如需共享，先在隔离副本中脱敏。'

export interface HeapSnapshotSpace {
  /** 可用字节；`null` = 当前环境无法测量（不冒充 0）。 */
  readonly freeBytes: number | null
  readonly ok: boolean
  readonly detail: string
}

export interface HeapSnapshotPrepare {
  readonly ok: boolean
  readonly dir: string
  readonly space: HeapSnapshotSpace
  readonly detail: string
}

export interface HeapSnapshotResult {
  readonly ok: boolean
  readonly file: string | null
  readonly detail: string
  /** 写入成功后按保留策略删除的旧快照数。 */
  readonly pruned: number
}

export function heapSnapshotDir(cwd: string = process.cwd()): string {
  return join(cwd, ...HEAP_SNAPSHOT_RELATIVE_DIR.split('/'))
}

/** 当前卷可用字节。测量失败返回 null（调用方必须显示"未测量"，不能显示 0）。 */
export function freeBytesOf(path: string): number | null {
  try {
    const stats = statfsSync(path)
    const available = Number(stats.bavail)
    const blockSize = Number(stats.bsize)
    if (!Number.isFinite(available) || !Number.isFinite(blockSize)) return null
    return available * blockSize
  } catch {
    return null
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/**
 * 写前检查：目录可建 + 剩余空间够（或明确说明"未测量"）。
 *
 * 空间不足直接拒绝——写到一半耗尽磁盘会让宿主进程更难恢复，
 * 而且快照本身也可能被截断成无法分析的半成品。
 */
export function prepareHeapSnapshot(cwd: string = process.cwd()): HeapSnapshotPrepare {
  const dir = heapSnapshotDir(cwd)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      dir,
      space: { freeBytes: null, ok: false, detail: '目录创建失败，未测量剩余空间' },
      detail: `快照目录不可用：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const freeBytes = freeBytesOf(dir)
  if (freeBytes === null) {
    return {
      ok: true,
      dir,
      space: { freeBytes: null, ok: true, detail: '剩余空间未测量（当前环境不支持 statfs）' },
      detail: '剩余空间未测量；写入可能因磁盘耗尽失败',
    }
  }
  if (freeBytes < HEAP_SNAPSHOT_MIN_FREE_BYTES) {
    return {
      ok: false,
      dir,
      space: {
        freeBytes,
        ok: false,
        detail: `可用 ${mb(freeBytes)}，低于最低要求 ${mb(HEAP_SNAPSHOT_MIN_FREE_BYTES)}`,
      },
      detail: `磁盘空间不足：可用 ${mb(freeBytes)} < ${mb(HEAP_SNAPSHOT_MIN_FREE_BYTES)}；拒绝写快照`,
    }
  }
  return {
    ok: true,
    dir,
    space: {
      freeBytes,
      ok: true,
      detail: `可用 ${mb(freeBytes)}（最低要求 ${mb(HEAP_SNAPSHOT_MIN_FREE_BYTES)}）`,
    },
    detail: `磁盘空间足够（可用 ${mb(freeBytes)}）`,
  }
}

/**
 * 保留最近 `keep` 份快照，删除更早的。
 *
 * 只删本目录下扩展名为 `.heapsnapshot` 的普通文件；删除失败**不抛**，
 * 返回实际删除数与失败说明——清理失败本身必须可见，否则磁盘会被静默占满。
 */
export function pruneHeapSnapshots(
  dir: string,
  keep: number = HEAP_SNAPSHOT_KEEP,
): { removed: number; error: string | null } {
  try {
    const entries = readdirSync(dir)
      .filter(name => name.endsWith('.heapsnapshot'))
      .map(name => {
        const path = join(dir, name)
        try {
          const stats = statSync(path)
          return stats.isFile() ? { path, mtime: stats.mtimeMs } : undefined
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { path: string; mtime: number } => entry !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
    let removed = 0
    for (const entry of entries.slice(Math.max(0, keep))) {
      try {
        unlinkSync(entry.path)
        removed += 1
      } catch {
        // 单个文件删不掉不影响其余文件；这里不中断，也不把"删了别的"说成成功
      }
    }
    return { removed, error: null }
  } catch (error) {
    return { removed: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 同步写一份快照并执行保留策略。调用方负责把 `detail` 原样展示给用户。
 *
 * **会暂停事件循环**：这是 V8 快照的固有代价，只在用户显式取证时调用。
 */
export function writeHeapSnapshotSafely(cwd: string = process.cwd()): HeapSnapshotResult {
  const prepared = prepareHeapSnapshot(cwd)
  if (!prepared.ok) return { ok: false, file: null, detail: prepared.detail, pruned: 0 }
  const file = join(prepared.dir, `${Date.now()}-${process.pid}.heapsnapshot`)
  try {
    writeV8HeapSnapshot(file)
  } catch (error) {
    return {
      ok: false,
      file: null,
      detail: `写快照失败：${error instanceof Error ? error.message : String(error)}`,
      pruned: 0,
    }
  }
  const pruned = pruneHeapSnapshots(prepared.dir)
  const pruneNote = pruned.removed > 0
    ? `；已按保留策略删除 ${pruned.removed} 份更早快照（保留最近 ${HEAP_SNAPSHOT_KEEP} 份）`
    : ''
  const pruneError = pruned.error === null ? '' : `；旧快照清理失败：${pruned.error}`
  const after = freeBytesOf(prepared.dir)
  const spaceNote = after === null ? '；写后剩余空间未测量' : `；写后剩余空间 ${mb(after)}`
  return {
    ok: true,
    file,
    detail: `${prepared.detail}${spaceNote}${pruneNote}${pruneError}`,
    pruned: pruned.removed,
  }
}
