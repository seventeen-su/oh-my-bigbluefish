/**
 * 画像落盘测试：**经 omb-memory 的服务**（`stores.forSession/forProject` → `StoreSet`），
 * 不自己开数据库。
 *
 * 关键断言：
 * ① 路由正确（显式 → 用户库；intent / 推断 → 项目库）
 * ② 能力轴**结构性拒绝落盘**（D4）
 * ③ `sourceRef` 用 ABI 保留前缀（离线整合据此跳过）
 * ④ 取库失败/缺库/写入失败都返回可读错误，绝不抛
 * ⑤ 内容未变不重复写
 */
import { describe, expect, it } from 'vitest'
import { SCOPE_BY_KIND, RESERVED_SOURCE_PREFIX } from '../../../kernel/abi/index.js'
import type { ProfileEntry } from '../../../modules/profile/entries.js'
import {
  PROFILE_DOC_ID_PREFIX,
  ProfileStorage,
  profileDocId,
  profileSourceRef,
  scopeOfEntry,
} from '../../../modules/profile/storage.js'
import { FakeStores, fakeClock } from './fakes.js'

const silent = { debug: () => {}, info: () => {}, warn: () => {} }

function entry(partial: Partial<ProfileEntry> & { value: string }): ProfileEntry {
  return { axis: 'stable', key: 'k', provenance: 'declared', evidence: [], updated: 1, ...partial }
}

function storageWith(stores: unknown): ProfileStorage {
  return new ProfileStorage({ stores: stores as never, clock: fakeClock(), logger: silent })
}

describe('scopeOfEntry：位置即权威', () => {
  it('显式陈述落跨项目库；intent 与推断落项目库', () => {
    expect(scopeOfEntry(entry({ value: 'v' }))).toBe('user')
    expect(scopeOfEntry(entry({ axis: 'collaboration', value: 'v' }))).toBe('user')
    expect(scopeOfEntry(entry({ axis: 'intent', value: 'v' }))).toBe('project')
    expect(scopeOfEntry(entry({ value: 'v', provenance: 'inferred' }))).toBe('project')
  })

  it('kind/scope 映射与 ABI 的 SCOPE_BY_KIND 一致（否则会出现"自称 scope 与实际库不符"）', () => {
    expect(SCOPE_BY_KIND[ProfileStorage.KIND_BY_SCOPE.user]).toBe('user')
    expect(SCOPE_BY_KIND[ProfileStorage.KIND_BY_SCOPE.project]).toBe('project')
  })
})

describe('文档 id 与 sourceRef', () => {
  it('id 确定性且每 scope 唯一', () => {
    expect(profileDocId('user')).toBe(`${PROFILE_DOC_ID_PREFIX}/user`)
    expect(profileDocId('project')).not.toBe(profileDocId('user'))
  })

  it('sourceRef 带 ABI 保留前缀（离线整合据此跳过画像文档）', () => {
    expect(profileSourceRef('user').startsWith(RESERVED_SOURCE_PREFIX)).toBe(true)
    expect(profileSourceRef('user')).toBe(`${RESERVED_SOURCE_PREFIX}${PROFILE_DOC_ID_PREFIX}/user`)
  })
})

describe('save：路由与记录字段', () => {
  it('显式条目只写用户库，且记录字段可核对', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    const result = await storage.save([entry({ value: '简洁' })])

    expect(result.ok).toBe(true)
    expect(result.documentsWritten).toBe(1)
    expect(stores.user.putCalls).toHaveLength(1)
    expect(stores.project.putCalls).toHaveLength(0)

    const record = stores.user.putCalls[0]
    expect(record?.id).toBe(profileDocId('user'))
    expect(record?.scope).toBe('user')
    expect(record?.kind).toBe('semantic')
    expect(record?.sourceRef).toBe(profileSourceRef('user'))
    expect(record?.assertedBy).toBe('user') // 有显式陈述 → 用户断言
    expect(record?.validTo).toBeNull()
    expect(record?.supersededBy).toBeNull()
    expect(record?.project).toBeNull() // 用户库不带项目
    expect(record?.contentHash).toHaveLength(8)
  })

  it('intent 与推断条目都落项目库，且项目来源被标注', async () => {
    const stores = new FakeStores()
    stores.projectScope = 'D:/proj/alpha'
    const storage = storageWith(stores)
    const result = await storage.save([
      entry({ axis: 'intent', value: '正在重构', key: 'goal' }),
      entry({ value: '偏好中文', provenance: 'inferred' }),
    ])

    expect(result.documentsWritten).toBe(1)
    expect(stores.project.putCalls).toHaveLength(1)
    expect(stores.user.putCalls).toHaveLength(0)
    expect(stores.project.putCalls[0]?.project).toBe('D:/proj/alpha')
    // 文档里含一条显式陈述（intent 轴同样可由用户显式声明）→ 断言来源记为用户
    expect(stores.project.putCalls[0]?.assertedBy).toBe('user')
  })

  it('只有推断条目的文档 → 断言来源记为模型（可核对，不用标量置信度）', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    await storage.save([entry({ value: '偏好中文', provenance: 'inferred' })])
    expect(stores.project.putCalls[0]?.assertedBy).toBe('model')
    expect(stores.user.putCalls).toHaveLength(0)
  })

  it('内容未变的文档不重复写（避免无意义写入与 WAL 增长）', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    await storage.save([entry({ value: '简洁' })])
    const again = await storage.save([entry({ value: '简洁' })])
    expect(again.documentsWritten).toBe(0)
    expect(stores.puts).toBe(1)
    expect(again.ok).toBe(true)
  })

  it('条目被清空后写入空文档（旧内容必须消失）', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    await storage.save([entry({ value: '简洁' })])
    const cleared = await storage.save([])
    expect(cleared.documentsWritten).toBe(1)
    expect(stores.puts).toBe(2)
  })

  it('能力轴被结构性拒绝：只有能力条目时一次写入都没有', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    const result = await storage.save([
      entry({ axis: 'capability', value: '中文母语', provenance: 'inferred' }),
      entry({ axis: 'capability', key: 'other', value: 'x', provenance: 'inferred' }),
    ])
    expect(result.capabilitySkipped).toBe(2)
    expect(result.documentsWritten).toBe(0)
    expect(stores.puts).toBe(0)
    expect(result.ok).toBe(true)
  })

  it('能力条目与普通条目混在一起时，能力条目照样不落盘', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    const result = await storage.save([
      entry({ value: '简洁' }),
      entry({ axis: 'capability', value: '高级', provenance: 'inferred' }),
    ])
    expect(result.capabilitySkipped).toBe(1)
    expect(stores.puts).toBe(1)
    expect(stores.user.putCalls[0]?.text).not.toContain('高级')
  })
})

describe('取库：会话 → cwd → 套件（异步、可能未就绪）', () => {
  it('无会话信息时用空会话 id 取库（记忆侧降级为仅用户库），并如实记录原因', async () => {
    const stores = new FakeStores()
    stores.userOnly = true
    const storage = storageWith(stores)
    await storage.load()
    expect(stores.sessionCalls).toEqual([''])
    expect(storage.availability().ok).toBe(false)
    expect(storage.availability().detail).toContain('缺少 project 库')
    expect(storage.availability().detail).toContain('cwd')
  })

  it('setSession 后按会话取库；显式 setProject 时按 cwd 取库', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)

    storage.setSession('s1')
    await storage.load()
    expect(stores.sessionCalls).toEqual(['s1'])

    storage.setProject('D:/proj/x')
    await storage.load()
    expect(stores.projectCalls).toEqual(['D:/proj/x'])
    expect(stores.projectCalls).toHaveLength(1)
  })

  it('只有用户库时，项目条目写入失败但用户条目照写（不静默）', async () => {
    const stores = new FakeStores()
    stores.userOnly = true
    const storage = storageWith(stores)
    const result = await storage.save([
      entry({ value: '简洁' }),
      entry({ axis: 'intent', key: 'goal', value: '重构' }),
    ])
    expect(stores.user.putCalls).toHaveLength(1)
    expect(stores.project.putCalls).toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('project 库不可用')
  })
})

describe('load / save：失败都返回可读错误，绝不抛', () => {
  it('没有 stores 服务 → 可读原因，且 load 返回空', async () => {
    const storage = storageWith(undefined)
    expect(storage.availability().ok).toBe(false)
    expect(storage.availability().detail).toContain('stores')
    const loaded = await storage.load()
    expect(loaded.entries).toEqual([])
    expect(loaded.error).toContain('stores 不可用')

    const saved = await storage.save([entry({ value: 'v' })])
    expect(saved.ok).toBe(false)
    expect(saved.error).toContain('stores 不可用')
  })

  it('服务存在但尚未完成首次取库 → 同步探测报"就绪但未探明"，不谎称知道库状态', () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    const availability = storage.availability()
    expect(availability.ok).toBe(true)
    expect(availability.detail).toContain('尚未完成')
  })

  it('服务存在但库未就绪（forSession 返回 undefined）→ 可读原因', async () => {
    const storage = storageWith({
      forSession: async () => undefined,
    })
    const loaded = await storage.load()
    expect(loaded.error).toContain('尚未就绪')
    expect(storage.availability().detail).toContain('尚未就绪')
  })

  it('forSession 抛异常 → 可读错误，不向上抛', async () => {
    const storage = storageWith({
      forSession: async () => {
        throw new Error('打不开')
      },
    })
    const loaded = await storage.load()
    expect(loaded.error).toContain('打不开')
    expect(loaded.entries).toEqual([])
  })

  it('put 抛异常 → ok=false 且原因可读，不向上抛', async () => {
    const stores = new FakeStores()
    stores.user.failPut = '磁盘只读'
    const storage = storageWith(stores)
    const result = await storage.save([entry({ value: 'v' })])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('磁盘只读')
  })

  it('get 抛异常 → load 报可读错误；save 也不抛', async () => {
    const stores = new FakeStores()
    stores.user.failGet = '库已关闭'
    const storage = storageWith(stores)
    const loaded = await storage.load()
    expect(loaded.error).toContain('库已关闭')

    const saved = await storage.save([entry({ value: 'v' })])
    expect(saved.ok).toBe(false)
    expect(saved.error).toContain('库已关闭')
  })

  it('损坏的文档 → 可读错误 + 不抛', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    await storage.save([entry({ value: 'v' })])
    const record = stores.user.records.get(profileDocId('user'))
    stores.user.records.set(profileDocId('user'), { ...record!, text: '{oops' })
    const loaded = await storage.load()
    expect(loaded.error).toContain('无法解析')
    expect(loaded.entries).toEqual([])
  })

  it('存读往返一致', async () => {
    const stores = new FakeStores()
    const storage = storageWith(stores)
    const entries = [entry({ value: '简洁' }), entry({ axis: 'intent', key: 'goal', value: '重构' })]
    await storage.save(entries)
    const loaded = await storage.load()
    expect(loaded.error).toBeNull()
    expect(loaded.entries).toHaveLength(2)
    expect(loaded.entries.map(e => e.value).sort()).toEqual(['简洁', '重构'].sort())
  })
})

describe('项目来源', () => {
  it('显式 setProject 覆盖 projectScope 并作为记录来源', async () => {
    const stores = new FakeStores()
    stores.projectScope = 'D:/from-stores'
    const storage = storageWith(stores)
    storage.setProject('D:/explicit')
    await storage.save([entry({ axis: 'intent', value: 'v' })])
    expect(stores.project.putCalls[0]?.project).toBe('D:/explicit')
  })

  it('解析 stores 抛异常时降级为"不可用"，不抛', async () => {
    const storage = storageWith(() => {
      throw new Error('解析失败')
    })
    expect(() => storage.availability()).not.toThrow()
    expect(storage.availability().ok).toBe(false)
    const loaded = await storage.load()
    expect(loaded.error).toContain('stores 不可用')
  })
})
