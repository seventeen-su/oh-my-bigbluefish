/**
 * 进程内快照落盘的安全规则（v4.5.3）。
 *
 * 这里**不真的写 V8 快照**（数 GB、同步暂停事件循环，单测不该付这个代价）；
 * 只验证两件会直接影响用户的事：
 * ① 写前检查给出可读的磁盘结论（测不到时写"未测量"，不冒充 0）；
 * ② 保留策略只删更早的 `.heapsnapshot`，不碰其他文件。
 */
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HEAP_SNAPSHOT_KEEP,
  HEAP_SNAPSHOT_PRIVACY_NOTE,
  freeBytesOf,
  prepareHeapSnapshot,
  pruneHeapSnapshots,
} from '../../dsh/heap-snapshot.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'omb-heap-'))
}

describe('heap snapshot 落盘规则', () => {
  it('写前检查：目录可建，剩余空间给出可读结论（测不到则明确说未测量）', () => {
    const dir = tempDir()
    const prepared = prepareHeapSnapshot(dir)
    expect(prepared.ok).toBe(true)
    expect(existsSync(prepared.dir)).toBe(true)
    expect(prepared.space.detail.length).toBeGreaterThan(0)
    // 不把"未测量"伪装成 0
    if (prepared.space.freeBytes === null) expect(prepared.space.detail).toContain('未测量')
    else expect(prepared.space.freeBytes).toBeGreaterThan(0)
  })

  it('freeBytesOf：不存在的路径返回 null，不抛', () => {
    expect(freeBytesOf(join(tempDir(), 'does-not-exist'))).toBeNull()
  })

  it('保留策略：只保留最近 N 份 .heapsnapshot，其他文件不动', () => {
    const dir = tempDir()
    for (let index = 0; index < HEAP_SNAPSHOT_KEEP + 2; index += 1) {
      const file = join(dir, `Heap.20260101.0000${index}.${1000 + index}.0.001.heapsnapshot`)
      writeFileSync(file, 'x')
    }
    writeFileSync(join(dir, 'keep.txt'), 'not a snapshot')
    const result = pruneHeapSnapshots(dir)
    expect(result.error).toBeNull()
    expect(result.removed).toBe(2)
    const names = readdirSync(dir).sort()
    expect(names.filter(name => name.endsWith('.heapsnapshot'))).toHaveLength(HEAP_SNAPSHOT_KEEP)
    expect(names).toContain('keep.txt')
  })

  it('隐私提示把快照定义为敏感诊断材料，而不是普通日志', () => {
    expect(HEAP_SNAPSHOT_PRIVACY_NOTE).toContain('敏感诊断材料')
    expect(HEAP_SNAPSHOT_PRIVACY_NOTE).toContain('不要提交')
  })
})
