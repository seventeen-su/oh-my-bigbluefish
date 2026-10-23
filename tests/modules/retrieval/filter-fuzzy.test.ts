/**
 * 检索过滤与模糊回退（v4.10.0）：状态 / 标签 / 子串回退。
 *
 * 用**真实 SQLite**（FTS5、json_each、LIKE 都在 SQL 里），确保过滤不是 JS 事后裁剪。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { retrieve } from '../../../modules/memory/retrieve.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import {
  capturingLogger,
  fixedClock,
  makeRecord,
  tempWorkspace,
  testPort,
  type TempWorkspace,
} from '../memory/helpers.js'
import { clockAt, tagged } from './fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

interface Fixture {
  readonly store: SqliteMemoryStore
  cleanup(): Promise<void>
}

function fixture(): Fixture {
  const ws: TempWorkspace = tempWorkspace()
  const store = openMemoryStore({
    scope: 'user',
    dbPath: join(ws.dir, 'user.db'),
    port: testPort(ws.dir),
    logger: capturingLogger(),
    clock: fixedClock(),
  })
  return {
    store,
    async cleanup() {
      await store.close()
      ws.cleanup()
    },
  }
}

describe('检索状态/标签过滤（v4.10.0）', () => {
  it('默认只看活跃；status=all 才把失效/被取代的条目纳入', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'live', text: '项目结论 用 Postgres', observedAt: 3 }))
    await f.store.put(makeRecord({ id: 'old', text: '项目结论 用 MySQL', observedAt: 2, validTo: 10 }))
    await f.store.put(makeRecord({ id: 'gone', text: '项目结论 用 SQLite', observedAt: 1, supersededBy: 'live' }))

    const active = await retrieve([tagged(f.store)], { text: '项目结论', limit: 10 }, { clock: CLOCK })
    expect(active.items.map(item => item.id)).toEqual(['live'])

    const all = await retrieve([tagged(f.store)], { text: '项目结论', limit: 10, status: 'all' }, { clock: CLOCK })
    expect(all.items.map(item => item.id).sort()).toEqual(['gone', 'live', 'old'])
    await f.cleanup()
  })

  it('标签过滤是 AND，且过滤后仍走通道状态/标签下推', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'a', text: '部署结论 用 docker', tags: ['deploy', 'infra'] }))
    await f.store.put(makeRecord({ id: 'b', text: '部署结论 用 docker', tags: ['deploy'] }))
    await f.store.put(makeRecord({ id: 'c', text: '部署结论 用 docker' }))

    const onlyDeploy = await retrieve([tagged(f.store)], { text: '部署结论', limit: 10, tags: ['deploy'] }, { clock: CLOCK })
    expect(onlyDeploy.items.map(item => item.id).sort()).toEqual(['a', 'b'])

    const both = await retrieve([tagged(f.store)], { text: '部署结论', limit: 10, tags: ['deploy', 'infra'] }, { clock: CLOCK })
    expect(both.items.map(item => item.id)).toEqual(['a'])
    await f.cleanup()
  })
})

describe('模糊回退（v4.10.0）', () => {
  it('词法 0 命中时用子串回退，条目标注 fuzzy 通道与信号', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'path', text: '超长路径 src/config/server.ts 里放着端口' }))
    // `config/serve` 在 FTS 里被拆成 config + serve 短语，命不中 server；LIKE 能按子串命中
    const result = await retrieve([tagged(f.store)], { text: 'config/serve', limit: 10 }, { clock: CLOCK })
    const item = result.items.find(entry => entry.id === 'path')
    expect(item).toBeDefined()
    expect(item?.channels).toContain('fuzzy')
    expect(item?.signals.fuzzy).toBeDefined()
    expect(result.stats.channelsUsed).toContain('fuzzy')
    await f.cleanup()
  })

  it('fuzzy=false 时不做回退（严格词法，回归对照）', async () => {
    const f = fixture()
    await f.store.put(makeRecord({ id: 'path', text: '超长路径 src/config/server.ts 里放着端口' }))
    const result = await retrieve([tagged(f.store)], { text: 'config/serve', limit: 10, fuzzy: false }, { clock: CLOCK })
    expect(result.items).toEqual([])
    expect(result.stats.channelsUsed).not.toContain('fuzzy')
    await f.cleanup()
  })
})
