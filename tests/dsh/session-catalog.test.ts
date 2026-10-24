/**
 * 会话目录端口测试（v4.18.0）。
 *
 * 这一层的存在理由：宿主会话服务是**四个独立服务**（持久化 / 活会话 / 标题 / 归档），
 * 任一缺失都可能让「项目」页把"我看不到"读成"没有会话"。所以每个用例都同时断言
 * **可用性**与**原因**，而不是只断言"返回了数组"。
 *
 * 另外钉住三条真实形状：
 * - `sessionPersistence.list()` 是 **Promise**，元素是 `{ header }`；
 * - `sessions.list()` 是**同步**数组，元素是带 `.header` 的对象（标题投影要对象本身）；
 * - `workspaceRegistry.archivedSessionIds` 是 getter，不是方法。
 */
import { describe, expect, it } from 'vitest'
import { installSessionCatalog } from '../../dsh/session-catalog.js'
import type { HostContextLike } from '../../dsh/host.js'

/** 假宿主 ctx：`get` 只认已注册的服务，其余返回 undefined（与真宿主同语义）。 */
function fakeCtx(
  services: Record<string, unknown> = {},
  options: { throwing?: readonly string[] } = {},
): HostContextLike {
  const throwing = new Set(options.throwing ?? [])
  return {
    get: (name: string) => {
      if (throwing.has(name)) throw new Error(`Guard 拒绝：${name} 未 inject`)
      return services[name]
    },
  }
}

/** 造一个会话头；`agentPreset` 省略时模拟旧日志（字段不存在）。
 *
 * `origin: 'subagent'` 是 DSH 0.2.1-rc.3 之后"子代理子会话"的唯一判据；
 * `parentSession` 单独出现**不算**子会话（普通 fork 历史上可能残留父 id）。 */
function header(
  id: string,
  cwd: string,
  createdAt: number,
  agentPreset?: string,
  origin?: 'subagent',
  parentSession?: string,
): Record<string, unknown> {
  return {
    id,
    cwd,
    createdAt,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(origin === undefined ? {} : { origin }),
    ...(parentSession === undefined ? {} : { parentSession }),
  }
}

/** 持久化服务替身：`list()` 返回 Promise（与宿主实现同形）。 */
function persistence(rows: readonly unknown[]): unknown {
  return { list: () => Promise.resolve(rows) }
}

/** 活会话替身：`list()` 同步返回数组。 */
function sessions(items: readonly unknown[]): unknown {
  return { list: () => items }
}

describe('installSessionCatalog', () => {
  it('合并持久化与活会话：活会话补标题与 live，归档来自 getter，排序为未归档优先且 createdAt 降序', async () => {
    const sessionB = { id: 'b', header: header('b', 'D:/b', 2_000, 'omb') }
    const sessionD = { id: 'd', header: header('d', 'D:/d', 4_000, 'standard') }
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([
        { header: header('a', 'D:/a', 1_000, 'omb') }, // 已归档
        { header: header('b', 'D:/b', 2_000, 'omb') }, // 也有活会话
        { header: header('c', 'D:/c', 3_000) }, // 旧日志：没有 agentPreset
      ]),
      sessions: sessions([sessionB, sessionD]),
      sessionTitle: {
        get: (session: unknown) => (session === sessionB ? { title: 'B 的标题' } : session === sessionD ? { title: 'D 的标题' } : undefined),
      },
      workspaceRegistry: { archivedSessionIds: ['a'] },
    }))

    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.reason).toBeUndefined()
    expect(listing.items.map(item => item.id)).toEqual(['d', 'c', 'b', 'a'])

    const byId = new Map(listing.items.map(item => [item.id, item]))
    expect(byId.get('d')).toMatchObject({ title: 'D 的标题', live: true, archived: false, agentPreset: 'standard' })
    expect(byId.get('c')).toMatchObject({ title: null, live: false, archived: false, agentPreset: null })
    expect(byId.get('b')).toMatchObject({ title: 'B 的标题', live: true, archived: false })
    expect(byId.get('a')).toMatchObject({ archived: true, live: false, title: null })
    expect(Object.isFrozen(listing.items)).toBe(true)
    catalog.dispose()
  })

  it('本进程内新建、尚未落盘的活会话也进目录（否则「项目」页会漏掉活会话）', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([]),
      sessions: sessions([{ id: 'fresh', header: header('fresh', 'D:/fresh', 5_000, 'omb') }]),
    }))
    const listing = await catalog.port.list()
    expect(listing.items.map(item => item.id)).toEqual(['fresh'])
    expect(listing.items[0]).toMatchObject({ live: true, title: null })
    catalog.dispose()
  })

  it('parentId：只有 origin=subagent 才认父；持久化/活会话都读，缺省 null，合并时补缺', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([
        { header: header('child', 'D:/c', 1, 'omb', 'subagent', 'parent-a') },
        { header: header('top', 'D:/t', 2, 'omb') },
        // 持久化头缺 parentSession，活会话头有 → 合并时补上
        { header: header('merged', 'D:/m', 3, 'omb') },
      ]),
      sessions: sessions([
        { id: 'merged', header: header('merged', 'D:/m', 3, 'omb', 'subagent', 'parent-b') },
        { id: 'livechild', header: header('livechild', 'D:/l', 4, 'omb', 'subagent', 'parent-c') },
      ]),
    }))
    const listing = await catalog.port.list()
    const byId = new Map(listing.items.map(item => [item.id, item]))
    expect(byId.get('child')).toMatchObject({ parentId: 'parent-a' })
    expect(byId.get('top')).toMatchObject({ parentId: null })
    expect(byId.get('merged')).toMatchObject({ parentId: 'parent-b' })
    expect(byId.get('livechild')).toMatchObject({ parentId: 'parent-c' })
    catalog.dispose()
  })

  it('rc.3 语义：普通 fork 残留 parentSession 但无 origin → 不算子会话（不被误标/缩进）', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([
        // 历史日志里的普通 fork：宿主当时也写 parentSession
        { header: header('fork-old', 'D:/f', 1, 'omb', undefined, 'source-old') },
        // 历史子代理会话：同样没有 origin —— 宿主自己的规则也不再把它当子会话
        { header: header('sub-old', 'D:/s', 2, 'omb', undefined, 'parent-old') },
      ]),
      sessions: sessions([
        { id: 'fork-live', header: header('fork-live', 'D:/lf', 3, 'omb', undefined, 'source-live') },
      ]),
    }))
    const listing = await catalog.port.list()
    const byId = new Map(listing.items.map(item => [item.id, item]))
    expect(byId.get('fork-old')).toMatchObject({ parentId: null })
    expect(byId.get('sub-old')).toMatchObject({ parentId: null })
    expect(byId.get('fork-live')).toMatchObject({ parentId: null })
    catalog.dispose()
  })

  it('上限 200：按排序保留最新的一批', async () => {
    const rows = Array.from({ length: 250 }, (_unused, index) => ({
      header: header(`s${String(index).padStart(3, '0')}`, `D:/p${String(index)}`, index + 1, 'omb'),
    }))
    const catalog = installSessionCatalog(fakeCtx({ sessionPersistence: persistence(rows) }))
    const listing = await catalog.port.list()
    expect(listing.items).toHaveLength(200)
    expect(listing.items[0]?.id).toBe('s249')
    expect(listing.items.at(-1)?.id).toBe('s050')
    catalog.dispose()
  })

  it('只有 sessions（没有持久化）：可用，但原因必须写明“仅活会话”', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessions: sessions([
        { id: 'x', header: header('x', 'D:/x', 10, 'omb') },
        { id: 'y', header: header('y', 'D:/y', 20, 'omb') },
      ]),
    }))
    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.reason).toContain('仅活会话')
    expect(listing.items.map(item => item.id)).toEqual(['y', 'x'])
    catalog.dispose()
  })

  it('只有持久化（没有 sessions）：可用，但原因必须写明“仅持久化会话”', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([{ header: header('a', 'D:/a', 1, 'omb') }]),
    }))
    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.reason).toContain('仅持久化')
    expect(listing.items.map(item => item.id)).toEqual(['a'])
    catalog.dispose()
  })

  it('两个服务都缺：不可用 + 原因 + 空列表（不冒充“没有会话”）', async () => {
    const catalog = installSessionCatalog(fakeCtx())
    const listing = await catalog.port.list()
    expect(listing).toMatchObject({ available: false, items: [] })
    expect(listing.reason).toContain('sessionPersistence/sessions 都缺失')
    catalog.dispose()
  })

  it('服务读取被 Guard 拒绝：不可用，但 list() 绝不抛', async () => {
    const catalog = installSessionCatalog(fakeCtx({}, {
      throwing: ['sessionPersistence', 'sessions', 'sessionTitle', 'workspaceRegistry'],
    }))
    await expect(catalog.port.list()).resolves.toMatchObject({ available: false, items: [] })
    catalog.dispose()
  })

  it('sessions 以工厂函数形态发布时也能解析', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessions: () => sessions([{ id: 'z', header: header('z', 'D:/z', 7, 'omb') }]),
    }))
    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.items.map(item => item.id)).toEqual(['z'])
    catalog.dispose()
  })

  it('标题服务抛错只让标题为 null，不影响条目', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessions: sessions([{ id: 'x', header: header('x', 'D:/x', 1, 'omb') }]),
      sessionTitle: { get: () => { throw new Error('投影未就绪') } },
    }))
    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.items[0]).toMatchObject({ id: 'x', title: null })
    catalog.dispose()
  })

  it('持久化 list() 抛错时退化为“没有这一路数据”而不是异常', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: { list: () => { throw new Error('磁盘不可读') } },
      sessions: sessions([{ id: 'only-live', header: header('only-live', 'D:/l', 3, 'omb') }]),
    }))
    const listing = await catalog.port.list()
    expect(listing.available).toBe(true)
    expect(listing.items.map(item => item.id)).toEqual(['only-live'])
    catalog.dispose()
  })

  it('dispose 后如实报告已卸载（幂等）', async () => {
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: persistence([{ header: header('a', 'D:/a', 1, 'omb') }]),
    }))
    catalog.dispose()
    catalog.dispose()
    const listing = await catalog.port.list()
    expect(listing).toMatchObject({ available: false, items: [] })
    expect(listing.reason).toContain('已卸载')
  })
})

describe('SessionCatalogPort.title（v4.21.0 历史会话真实标题）', () => {
  function readHandle(events: unknown, control: { closed?: boolean; readThrows?: boolean } = {}): unknown {
    return {
      read: () => {
        if (control.readThrows === true) throw new Error('事件日志损坏')
        return Promise.resolve(events)
      },
      close: () => {
        control.closed = true
      },
    }
  }

  it('取最后一个 session/title 事件；读完关闭句柄；第二次走缓存不再 open', async () => {
    let opened = 0
    const control: { closed?: boolean } = {}
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: (id: string, mode: string) => {
          opened += 1
          expect(id).toBe('hist')
          expect(mode).toBe('read')
          return readHandle([
            { type: 'session/title', data: { title: '旧标题' } },
            { type: 'message', data: { title: '不是标题事件' } },
            { type: 'session/title', data: { title: '最后标题' } },
            { type: 'session/title', data: { title: '   ' } },
          ], control)
        },
      },
    }))
    await expect(catalog.port.title('  hist  ')).resolves.toBe('最后标题')
    expect(control.closed).toBe(true)
    // 缓存命中（含 null 也缓存）：第二次不再 open
    await expect(catalog.port.title('hist')).resolves.toBe('最后标题')
    expect(opened).toBe(1)
    catalog.dispose()
  })

  it('没有标题事件/事件形状不符 → null，并缓存 null 不反复 open', async () => {
    let opened = 0
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: () => {
          opened += 1
          return readHandle([{ type: 'session/title', data: { title: 42 } }, null, 'bad'])
        },
      },
    }))
    await expect(catalog.port.title('none')).resolves.toBeNull()
    await expect(catalog.port.title('none')).resolves.toBeNull()
    expect(opened).toBe(1)
    catalog.dispose()
  })

  it('open 抛错 → null（绝不抛），失败也缓存', async () => {
    let opened = 0
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: () => {
          opened += 1
          throw new Error('会话文件被占用')
        },
      },
    }))
    await expect(catalog.port.title('broken')).resolves.toBeNull()
    await expect(catalog.port.title('broken')).resolves.toBeNull()
    expect(opened).toBe(1)
    catalog.dispose()
  })

  it('read() 抛错 → null，句柄仍然关闭', async () => {
    const control: { closed?: boolean; readThrows?: boolean } = { readThrows: true }
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: () => readHandle('ignored', control),
      },
    }))
    await expect(catalog.port.title('read-broken')).resolves.toBeNull()
    expect(control.closed).toBe(true)
    catalog.dispose()
  })

  it('活会话优先 sessionTitle；活会话没标题时回退持久化历史标题', async () => {
    let opened = 0
    const live = { id: 'live', header: header('live', 'D:/live', 1, 'omb') }
    const catalog = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: () => {
          opened += 1
          return readHandle([{ type: 'session/title', data: { title: '历史标题' } }])
        },
      },
      sessions: sessions([live]),
      sessionTitle: { get: (session: unknown) => (session === live ? { title: '活标题' } : undefined) },
    }))
    await expect(catalog.port.title('live')).resolves.toBe('活标题')
    expect(opened).toBe(0)

    // 同一目录实例里再加一个没有活标题的 id：走持久化回退
    const fallback = installSessionCatalog(fakeCtx({
      sessionPersistence: {
        list: async () => [],
        open: () => {
          opened += 1
          return readHandle([{ type: 'session/title', data: { title: '历史标题' } }])
        },
      },
      sessions: sessions([live]),
      sessionTitle: { get: () => ({ title: null }) },
    }))
    await expect(fallback.port.title('live')).resolves.toBe('历史标题')
    expect(opened).toBeGreaterThanOrEqual(1)
    catalog.dispose()
    fallback.dispose()
  })

  it('unavailable 服务/卸载后 → null，不抛', async () => {
    const catalog = installSessionCatalog(fakeCtx({}, {
      throwing: ['sessionPersistence', 'sessions', 'sessionTitle'],
    }))
    await expect(catalog.port.title('x')).resolves.toBeNull()
    catalog.dispose()
    await expect(catalog.port.title('x')).resolves.toBeNull()
  })
})
