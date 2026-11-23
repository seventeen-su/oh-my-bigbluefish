import path from 'node:path'

/**
 * 把 `candidate` 解析到 `root` 之下，并做词法前缀校验。
 *
 * - 相对路径按 root 解析；绝对路径必须落在 root 内。
 * - `..` 穿越、跨盘符、NUL 字节一律返回 undefined（调用方转成 invalid-input）。
 * - 只做词法校验：符号链接指向根外的情况必须由 `DynamicContext.readFile` 的实现
 *   用 realpath 再校验一次（端口契约写在 ports/dynamic.ts）。
 */
export function resolveInsideRoot(root: string, candidate: string): string | undefined {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.includes('\0')) return undefined
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, trimmed)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '') return resolved
  if (path.isAbsolute(relative)) return undefined
  const segments = relative.split(path.sep)
  if (segments[0] === '..') return undefined
  return resolved
}

/** 仅做判定，不抛错；供测试与调用方在解析前检查。 */
export function isInsideRoot(root: string, candidate: string): boolean {
  return resolveInsideRoot(root, candidate) !== undefined
}
