/**
 * 能力轴会话内存的**有界性**（S3-f）。
 *
 * 审计 C6：`#bySession` 每会话有 20 条上限，但**会话数没有上限**；
 * `clearSession()` 全仓零生产调用方（宿主不给模块发会话结束事件）→
 * 长跑宿主上这张表随历史会话数单调增长。
 *
 * 修复前：`sessionCount()` 会随观察过的会话数一直涨（40 个会话 → 40），
 * 且最早的会话永远还在。修复后：LRU 上界 32，淘汰**最久未活动**的那一个。
 */
import { describe, expect, it } from 'vitest'
import { CAPABILITY_ENTRIES_PER_SESSION, CAPABILITY_SESSION_MAX, CapabilityMemory } from '../../../modules/profile/capability.js'
import { fakeClock } from './fakes.js'

const memory = (maxSessions?: number): CapabilityMemory =>
  new CapabilityMemory({ clock: fakeClock(), ...(maxSessions === undefined ? {} : { maxSessions }) })

describe('CapabilityMemory：会话表有 LRU 上界（S3-f）', () => {
  it('观察 40 个会话后表内 ≤ 32，且淘汰的是最久未活动的那些', () => {
    const store = memory()
    for (let index = 1; index <= 40; index += 1) {
      store.observe(`s${index}`, { key: 'k', value: `v${index}` })
    }
    expect(store.sessionCount()).toBe(CAPABILITY_SESSION_MAX)
    expect(store.evictedSessions()).toBe(40 - CAPABILITY_SESSION_MAX)
    expect(store.sessionMax()).toBe(CAPABILITY_SESSION_MAX)
    // 最早的 8 个（最久未活动）已被淘汰：再查询表现为"未观察过"（空数组）
    expect(store.list('s1')).toEqual([])
    expect(store.list('s8')).toEqual([])
    expect(store.list('s9')).toHaveLength(1)
    expect(store.list('s40')).toHaveLength(1)
  })

  it('淘汰按最久未活动而不是最早插入：刚被观察过的老会话不会被新会话挤掉', () => {
    const store = memory(3)
    store.observe('a', { key: 'k', value: '1' })
    store.observe('b', { key: 'k', value: '2' })
    store.observe('c', { key: 'k', value: '3' })
    store.observe('a', { key: 'k2', value: '4' }) // a 重新活动
    store.observe('d', { key: 'k', value: '5' }) // 该淘汰的是 b

    expect(store.sessionCount()).toBe(3)
    expect(store.list('a')).toHaveLength(2)
    expect(store.list('d')).toHaveLength(1)
    expect(store.list('b')).toEqual([])
  })

  it('重复观察也算活动（LRU 推进），但内容引用不变（同一引用契约保留）', () => {
    const store = memory(2)
    store.observe('a', { key: 'k', value: '1' })
    store.observe('b', { key: 'k', value: '2' })
    const first = store.list('a')
    expect(store.observe('a', { key: 'k', value: '1' })).toBe(first)
    store.observe('c', { key: 'k', value: '3' }) // a 刚活动过 → 淘汰 b

    expect(store.list('b')).toEqual([])
    expect(store.list('a')).toBe(first)
  })

  it('单会话条目上限仍然是 20（会话上界不改变每会话上界）', () => {
    const store = memory()
    for (let index = 1; index <= CAPABILITY_ENTRIES_PER_SESSION + 5; index += 1) {
      store.observe('s1', { key: `k${index}`, value: `v${index}` })
    }
    expect(store.list('s1')).toHaveLength(CAPABILITY_ENTRIES_PER_SESSION)
    expect(store.entryCount()).toBe(CAPABILITY_ENTRIES_PER_SESSION)
  })

  it('clearSession / clearAll 同时释放 LRU 名额（不留幽灵占位）', () => {
    const store = memory(2)
    store.observe('a', { key: 'k', value: '1' })
    store.observe('b', { key: 'k', value: '2' })
    store.clearSession('a')
    store.observe('c', { key: 'k', value: '3' })

    expect(store.sessionCount()).toBe(2)
    expect(store.evictedSessions()).toBe(0) // a 的名额被真正释放 → 无需淘汰
    expect(store.list('b')).toHaveLength(1)
    expect(store.list('c')).toHaveLength(1)

    store.clearAll()
    expect(store.sessionCount()).toBe(0)
    expect(store.entryCount()).toBe(0)
  })
})
