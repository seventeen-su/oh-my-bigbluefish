/**
 * 一键清空**推断型**条目。
 *
 * 关键约束：显式条目在结构上免疫——`dropDeduced` 只按 `provenance` 过滤，
 * 没有"连显式一起清"的选项。用户可编辑的显式声明不该被一次推断清理顺带删除。
 *
 * `clearDeduced` 绝不抛异常：存储层的失败会以可读错误返回。
 */
import type { ProfileEntry } from './entries.js'

export interface ClearResult {
  readonly ok: boolean
  readonly removed: number
  /** 可读的失败原因；成功时为 null。 */
  readonly error: string | null
}

/** 纯函数：只保留显式声明。 */
export function dropDeduced(entries: readonly ProfileEntry[]): readonly ProfileEntry[] {
  return entries.filter(entry => entry.provenance !== 'inferred')
}

/** 纯函数：数出会被清掉的条数（供预览与上报）。 */
export function countDeduced(entries: readonly ProfileEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.provenance === 'inferred') count += 1
  }
  return count
}

/**
 * 只需 `load`/`save` 两个能力——`ProfileStorage` 结构上满足它，
 * 测试里也可以只给一个假对象。
 */
export interface DeducedClearTarget {
  readonly load: () => Promise<{ readonly entries: readonly ProfileEntry[]; readonly error: string | null }>
  readonly save: (entries: readonly ProfileEntry[]) => Promise<{ readonly ok: boolean; readonly error: string | null }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 清空全部推断型条目；显式条目不动。**绝不抛异常。** */
export async function clearDeduced(target: DeducedClearTarget): Promise<ClearResult> {
  try {
    const loaded = await target.load()
    const removed = countDeduced(loaded.entries)
    if (removed === 0) {
      return { ok: loaded.error === null, removed: 0, error: loaded.error }
    }
    const saved = await target.save(dropDeduced(loaded.entries))
    const errors = [loaded.error, saved.error].filter((error): error is string => error !== null)
    return {
      ok: saved.ok && loaded.error === null,
      removed,
      error: errors.length > 0 ? errors.join('；') : null,
    }
  } catch (error) {
    return { ok: false, removed: 0, error: `清空推断条目失败：${messageOf(error)}` }
  }
}
