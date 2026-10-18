/**
 * 3.7 Wave 2 / R9 C1+C2：效用账本（`memory_utility` / `memory_feedback` / `memory_meta`）与隐式使用匹配。
 *
 * 判据：
 * ① 曝光 = `markUsed`（既有语义）；`getMany` 把 utility 以**非枚举**属性挂上（不破坏 toEqual）；
 * ② `recordUsed` 只对已存在的记忆记账（孤儿 id 不建行）；
 * ③ 反馈归档/复活 与 `valid_to` 的联动（只清反馈来源的归档）；
 * ④ 审计日志只增不改；⑤ used_tool 匹配（实体键 ≥2 或单个长路径）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import { createUsageTracker } from '../../../modules/memory/feedback.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { fixedClock, tempWorkspace, testPort, type TempWorkspace } from './helpers.js'

const NOW = 1_700_000_000_000

interface Fixture {
  readonly store: SqliteMemoryStore
  cleanup(): Promise<void>
}

function fixture(): Fixture {
  const ws: TempWorkspace = tempWorkspace('omb-utility-')
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const store = openMemoryStore({ scope: 'user', dbPath: join(ws.dir, 'identity', 'knowledge.db'), port, logger, clock })
  return {
    store,
    async cleanup(): Promise<void> {
      await store.close()
      ws.cleanup()
    },
  }
}

function record(id: string, text = '端口固定为 8080'): MemoryRecord {
  return {
    id,
    scope: 'user',
    kind: 'semantic',
    text,
    contentHash: `hash-${id}`,
    sourceRef: `session:s1#${id}`,
    assertedBy: 'user',
    observedAt: NOW - 1000,
    validTo: null,
    supersededBy: null,
    lastUsedAt: NOW - 1000,
    useCount: 0,
    project: null,
  }
}

describe('效用账本（真实 SQLite）', () => {
  it('markUsed → 曝光 +1；getMany 挂非枚举 utility（原字段不变）', async () => {
    const f = fixture()
    await f.store.put(record('m1'))
    await f.store.markUsed(['m1'], NOW)
    const [row] = await f.store.utilityStats(['m1'])
    expect(row).toMatchObject({ memoryId: 'm1', exposed: 1, used: 0 })

    const fetched = await f.store.getMany(['m1'])
    const item = fetched[0] as MemoryRecord & { utility?: number }
    expect(item.utility).toBeGreaterThan(0)
    expect(item.utility).toBeLessThan(0.2 + 1e-9) // 曝光一次没人用 → 低于基率
    expect(Object.keys(item)).not.toContain('utility') // 非枚举：不污染 toEqual/序列化
    expect(item.text).toBe('端口固定为 8080')
    await f.cleanup()
  })

  it('recordUsed：已存在记忆 used+1、utility 上升；孤儿 id 不建账本行', async () => {
    const f = fixture()
    await f.store.put(record('m1'))
    await f.store.markUsed(['m1'], NOW)
    const before = ((await f.store.get('m1')) as MemoryRecord & { utility?: number }).utility ?? 0
    expect(await f.store.recordUsed(['m1'], NOW)).toBe(1)
    const after = ((await f.store.get('m1')) as MemoryRecord & { utility?: number }).utility ?? 0
    expect(after).toBeGreaterThan(before)
    expect(await f.store.recordUsed(['no-such-id'], NOW)).toBe(0)
    expect(await f.store.utilityStats(['no-such-id'])).toHaveLength(0)
    const totals = await f.store.utilityTotals()
    expect(totals).toEqual({ exposed: 1, used: 1 })
    await f.cleanup()
  })

  it('反馈归档/复活联动 valid_to；审计日志只增不改；meta 可持久化', async () => {
    const f = fixture()
    await f.store.put(record('m1'))
    const archived = await f.store.recordFeedback({ memoryId: 'm1', action: 'stale', sessionId: 'sA', at: NOW })
    expect(archived.change).toBe('stale-archived')
    expect((await f.store.get('m1'))?.validTo).toBe(NOW)
    expect(await f.store.recordFeedback({ memoryId: 'm1', action: 'stale', sessionId: 'sA', at: NOW + 1 })).toMatchObject({
      change: 'stale-recorded',
    })

    const logBefore = await f.store.feedbackLog('m1', 10)
    expect(logBefore.length).toBeGreaterThanOrEqual(2)

    const revived = await f.store.recordFeedback({ memoryId: 'm1', action: 'useful', sessionId: 'sA', at: NOW + 2 })
    expect(revived.change).toBe('revive')
    expect(revived.revived).toBe(true)
    expect((await f.store.get('m1'))?.validTo).toBeNull()
    const logAfter = await f.store.feedbackLog('m1', 10)
    expect(logAfter.length).toBeGreaterThan(logBefore.length) // 只增

    await f.store.setUtilityMeta('lexical.floor.q', '0.55')
    expect(await f.store.utilityMeta('lexical.floor.q')).toBe('0.55')
    await f.cleanup()
  })

  it('反馈不复活"被其它记忆取代"的条目（superseded_by 优先）', async () => {
    const f = fixture()
    await f.store.put({ ...record('old'), validTo: NOW - 5, supersededBy: 'new' })
    const result = await f.store.recordFeedback({ memoryId: 'old', action: 'useful', sessionId: 'sA', at: NOW })
    expect(result.change).toBe('useful')
    expect(result.revived).toBe(false)
    expect((await f.store.get('old'))?.validTo).toBe(NOW - 5)
    await f.cleanup()
  })
})

describe('used_tool 隐式使用匹配（R9 C1）', () => {
  it('共享 ≥2 实体键 → 命中；无关调用不命中', () => {
    const tracker = createUsageTracker()
    tracker.noteExposure(
      's1',
      [{ id: 'm1', text: '改 modules/memory/store.ts 与 tests/modules/memory/store.test.ts，跑 pnpm test' }],
      NOW,
    )
    expect(tracker.matchToolCall('s1', 'pwsh', '{"command":"pnpm test tests/modules/memory/store.test.ts"}')).toEqual(['m1'])
    expect(tracker.matchToolCall('s1', 'read', '{"path":"README.md"}')).toEqual([])
    expect(tracker.stats()).toEqual({ exposed: 1, used: 1 })
  })

  it('单个足够长的路径键也算命中（短名不算）', () => {
    const tracker = createUsageTracker()
    tracker.noteExposure('s1', [{ id: 'm2', text: '结论写在 modules/memory/feedback.ts 里' }], NOW)
    // 同路径 → 命中
    expect(tracker.matchToolCall('s1', 'read', 'modules/memory/feedback.ts')).toEqual(['m2'])

    const short = createUsageTracker()
    short.noteExposure('s1', [{ id: 'm3', text: '端口在 src/a.ts 里' }], NOW)
    expect(short.matchToolCall('s1', 'read', 'src/a.ts')).toEqual([]) // 路径太短，不单独作证据
  })

  it('曝光窗口有界（30 条），且不会跨会话匹配', () => {
    const tracker = createUsageTracker()
    tracker.noteExposure('s1', [{ id: 'm1', text: 'modules/memory/store.ts 与 tests/a.test.ts' }], NOW)
    expect(tracker.matchToolCall('s2', 'edit', 'modules/memory/store.ts tests/a.test.ts')).toEqual([])
    for (let index = 0; index < 40; index += 1) {
      tracker.noteExposure('s1', [{ id: `f${index}`, text: `filler-${index}.ts other/file.ts` }], NOW)
    }
    expect(tracker.stats().exposed).toBe(41)
    // 最早的 m1 已被挤出窗口
    expect(tracker.matchToolCall('s1', 'edit', 'modules/memory/store.ts tests/a.test.ts')).toEqual([])
    tracker.forget('s1')
    expect(tracker.matchToolCall('s1', 'edit', 'modules/memory/store.ts')).toEqual([])
  })
})
