// layer 0：确定性写能力 SID 派生（照抄 DSH sandbox-windows-acl/src/workspace-sid.ts 的算法）。
// S-1-4-x-y（subauthorities 30-bit）：SID 的威力只由命名它的 ACE 定义（SID 字符串本身不是秘密）；
// 同一写目录集合在跨会话/跨进程派生同一个 SID，使 ACE 物化一次后重复授权 O(1)。
import { createHash } from 'node:crypto'

/** sha256 摘要的低 64 位 → 两个 30-bit subauthority（[1, 2^30-1]） */
function twoSubAuthorities(digest: Buffer): [number, number] {
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return [first, second]
}

/**
 * 派生写目录集合的写 SID（S-1-4-x-y）：输入为规范化（realpath）后的绝对路径，
 * 排序后以 '\n' 连接做哈希输入——同一集合派生同一 SID。ACL 层把该 SID 的全权 ACE
 * 物化到每个 writableDir，受限令牌的 restricting 列表携带该 SID，写能力即覆盖
 * writableDirs 精确集合（不含任何祖先/后代目录）。
 */
export function workspaceWriteSid(writableDirs: readonly string[]): string {
  const digest = createHash('sha256').update([...writableDirs].sort().join('\n'), 'utf8').digest()
  const [first, second] = twoSubAuthorities(digest)
  return `S-1-4-${first}-${second}`
}

/**
 * 派生私有临时目录的写 SID（S-1-4-x-y-1）：随机目录路径即能力身份；固定第三 subauthority
 * 与双 subauthority 的 workspace SID 域分离。
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const [first, second] = twoSubAuthorities(digest)
  return `S-1-4-${first}-${second}-1`
}
