import { lstat } from 'node:fs/promises'
import { fail, invalid } from '../../domain/errors.js'
import { resolveInsideRoot } from './path-guard.js'

/**
 * file 动态值的路径闸门（Phase 4 Task 18）。
 *
 * 威胁模型：`FileSpec.path` 来自用户属性，可能用 `..`、绝对路径、UNC、Windows 设备路径、
 * 保留设备名或符号链接把读取引到项目根之外（例如 `\\server\share`、`\\.\PhysicalDrive0`、
 * `CON`、根外的 symlink）。所有读取都必须先过这里，再经 realpath 与 stat 复核。
 *
 * 不变量：
 * - 词法阶段：拒绝 NUL、UNC、设备路径、盘符相对路径、Windows 保留设备名与 `..` 越界；
 *   只接受落在 `projectRoot` 内的路径。
 * - 解析后阶段：realpath 结果必须仍在根内（防符号链接逃逸）；根外目标直接拒绝。
 * - stat 预检：只读普通文件；符号链接（未经验证）、目录、设备/FIFO 一律拒绝；
 *   文件大小超过上限时**在读取前**失败，不把大文件整体读进内存。
 * - 事后再按实际字符串字节数复核一次上限，防止 stat 与读取之间的竞态。
 */

/** 文件属性默认读取上限；与 domain 的单属性 256KB 上限对齐。 */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024

/** fs.Stats 的最小子集；测试可注入同名结构。 */
export interface FileStatLike {
  readonly size: number
  isFile(): boolean
  isSymbolicLink(): boolean
}

export type FileStat = (path: string) => Promise<FileStatLike>

/** Windows 保留设备名（含带扩展名与尾随空格/点的写法）。 */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/**
 * 把 `candidate` 解析成 `projectRoot` 内的绝对路径；任何越界/设备/UNC 写法都抛
 * `invalid-input`（错误码与旧 path-guard 行为一致，只是判定更严）。
 */
export function resolveFilePath(root: string, candidate: string): string {
  if (typeof candidate !== 'string') throw fail(invalid('文件路径必须是字符串'))
  const trimmed = candidate.trim()
  if (trimmed.length === 0) throw fail(invalid('文件路径不能为空'))
  if (trimmed.includes('\0')) throw fail(invalid('文件路径包含 NUL 字节，已拒绝'))
  if (/^[\\/]{2}/u.test(trimmed)) {
    if (/^[\\/]{2}[.?][\\/]/u.test(trimmed)) throw fail(invalid(`拒绝 Windows 设备路径：${candidate}`))
    throw fail(invalid(`拒绝 UNC 网络路径：${candidate}`))
  }
  if (/^[A-Za-z]:(?![\\/])/u.test(trimmed)) throw fail(invalid(`拒绝盘符相对路径：${candidate}`))
  for (const segment of trimmed.split(/[\\/]+/u)) {
    const cleaned = segment.replace(/[. ]+$/u, '')
    if (cleaned.length === 0) continue
    if (WINDOWS_RESERVED_NAME.test(cleaned)) throw fail(invalid(`拒绝 Windows 保留设备名：${candidate}`))
  }
  const resolved = resolveInsideRoot(root, trimmed)
  if (resolved === undefined) throw fail(invalid(`文件路径必须位于项目根内：${candidate}`))
  return resolved
}

/** realpath 之后的根内断言；越界说明符号链接逃逸。 */
export function assertInsideRoot(root: string, candidate: string): void {
  if (resolveInsideRoot(root, candidate) === undefined) {
    throw fail(invalid('文件符号链接越过项目根'))
  }
}

/**
 * stat 预检：普通文件、非符号链接、大小不超过上限。
 * `info` 应来自 lstat（不跟随符号链接），这样未验证的符号链接会在读取前被拒绝。
 */
export function assertRegularFile(displayPath: string, info: FileStatLike, maxBytes: number): void {
  if (info.isSymbolicLink()) {
    throw fail(invalid(`文件是符号链接，无法确认目标在项目根内，已拒绝：${displayPath}`))
  }
  if (!info.isFile()) {
    throw fail(invalid(`不是普通文件（目录/设备/FIFO 等），已拒绝：${displayPath}`))
  }
  if (info.size > maxBytes) {
    throw fail(invalid(`文件超过 ${maxBytes} 字节上限：${displayPath}（实际 ${info.size} 字节）`))
  }
}

/** 读取后的字节复核：stat 与实际读取之间文件可能变大。 */
export function assertTextWithinLimit(displayPath: string, text: string, maxBytes: number): void {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw fail(invalid(`文件超过 ${maxBytes} 字节上限：${displayPath}`))
  }
}

/** 默认 stat：lstat（不跟随 symlink），让符号链接在读取前被看见。 */
export async function defaultFileStat(filePath: string): Promise<FileStatLike> {
  return lstat(filePath)
}
