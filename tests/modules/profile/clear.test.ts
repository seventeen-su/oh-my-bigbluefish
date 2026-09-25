/**
 * 一键清空推断型条目。
 *
 * 核心不变量：**显式条目在结构上免疫**——没有"连显式一起清"的选项。
 * 另外：一切失败返回可读错误，绝不抛。
 */
import { describe, expect, it } from 'vitest'
import type { ProfileEntry } from '../../../modules/profile/entries.js'
import { clearDeduced, countDeduced, dropDeduced } from '../../../modules/profile/clear.js'
import { ProfileStorage } from '../../../modules/profile/storage.js'
import { FakeStores, fakeClock } from './fakes.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {} }

function entry(partial: Partial<ProfileEntry> & { value: string }): ProfileEntry {
  return { axis: 'stable', key: 'k', provenance: 'declared', evidence: [], updated: 1, ...partial }
}

describe('dropDeduced / countDeduced（纯函数）', () => {
  it('只保留显式；计数只数推断', () => {
    const entries = [
      entry({ value: 'a' }),
      entry({ key: 'i', value: 'b', provenance: 'inferred' }),
      entry({ axis: 'capability', key: 'c', value: 'c', provenance: 'inferred' }),
    ]
    expect(dropDeduced(entries).map(e => e.value)).toEqual(['a'])
    expect(countDeduced(entries)).toBe(2)
  })
})

describe('clearDeduced', () => {
  it('删推断、留显式，并如实返回删除条数', async () => {
    const stores = new FakeStores()
    const storage = new ProfileStorage({
      stores,
      clock: fakeClock(),
      logger: silent,
    })
    await storage.save([
      entry({ value: '显式的' }),
      entry({ key: 'i1', value: '推断一', provenance: 'inferred' }),
      entry({ key: 'i2', value: '推断二', provenance: 'inferred' }),
    ])

    const result = await clearDeduced(storage)
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(2)

    const loaded = await storage.load()
    expect(loaded.entries.map(e => e.value)).toEqual(['显式的'])
  })

  it('没有推断条目时不写存储（removed=0，零额外写入）', async () => {
    const stores = new FakeStores()
    const storage = new ProfileStorage({ stores, clock: fakeClock(), logger: silent })
    await storage.save([entry({ value: '显式的' })])
    const before = stores.puts
    const result = await clearDeduced(storage)
    expect(result.removed).toBe(0)
    expect(stores.puts).toBe(before)
  })

  it('load 报错时如实返回 ok=false 与原因，不抛', async () => {
    const result = await clearDeduced({
      load: async () => ({ entries: [], error: '库已关闭' }),
      save: async () => ({ ok: true, error: null }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('库已关闭')
  })

  it('save 失败时把原因带出来，不抛', async () => {
    const result = await clearDeduced({
      load: async () => ({ entries: [entry({ value: 'x', provenance: 'inferred' })], error: null }),
      save: async () => ({ ok: false, error: '磁盘只读' }),
    })
    expect(result.ok).toBe(false)
    expect(result.removed).toBe(1)
    expect(result.error).toContain('磁盘只读')
  })

  it('目标对象直接抛异常也不外传', async () => {
    const result = await clearDeduced({
      load: async () => {
        throw new Error('炸了')
      },
      save: async () => ({ ok: true, error: null }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('炸了')
  })
})
