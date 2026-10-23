/**
 * 活动日志（v4.11.0）：有界环形、累计计数、只列发生过的事件。
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DETAIL_MAX,
  ACTIVITY_LOG_MAX,
  createActivityLog,
  renderActivityNote,
} from '../../../modules/memory/activity.js'

describe('活动日志', () => {
  it('环形有界：只留最近 N 条，但累计计数保留', () => {
    const log = createActivityLog(3)
    for (let index = 0; index < 5; index += 1) {
      log.note({ kind: 'write', detail: `m${index}`, at: 100 + index })
    }
    expect(log.recent()).toHaveLength(3)
    expect(log.recent().map(entry => entry.detail)).toEqual(['m4', 'm3', 'm2'])
    expect(log.summary().total).toBe(5)
    expect(log.summary().byKind.write).toBe(5)
  })

  it('detail 截断、错误单独累计、lastAt 取最大', () => {
    const log = createActivityLog()
    log.note({ kind: 'write', detail: 'ok', at: 100 })
    log.note({ kind: 'error', detail: 'x'.repeat(ACTIVITY_DETAIL_MAX + 50), at: 200 })
    const [recentError] = log.recent()
    expect(recentError?.detail.length).toBe(ACTIVITY_DETAIL_MAX + 1)
    expect(recentError?.detail.endsWith('…')).toBe(true)
    expect(log.summary()).toMatchObject({ total: 2, errors: 1, lastAt: 200 })
  })

  it('非法容量回落到默认上限（不静默变成 0 条）', () => {
    const log = createActivityLog(Number.NaN)
    log.note({ kind: 'retrieve', detail: 'r', at: 1 })
    expect(log.recent()).toHaveLength(1)
    expect(ACTIVITY_LOG_MAX).toBe(200)
  })
})

describe('活动读数渲染', () => {
  it('没有活动 / 未接线：一个字都不写', () => {
    expect(renderActivityNote(undefined)).toBe('')
    const empty = createActivityLog().summary()
    expect(renderActivityNote(empty)).toBe('')
  })

  it('只列发生过的事件类别；错误单列且不省', () => {
    const log = createActivityLog()
    log.note({ kind: 'write', detail: 'a', at: 1 })
    log.note({ kind: 'dedupe', detail: 'b', at: 2 })
    log.note({ kind: 'error', detail: 'c', at: 3 })
    const note = renderActivityNote(log.summary())
    expect(note).toContain('写入 1')
    expect(note).toContain('去重 1')
    expect(note).not.toContain('升级')
    expect(note).toContain('错误')
  })
})
