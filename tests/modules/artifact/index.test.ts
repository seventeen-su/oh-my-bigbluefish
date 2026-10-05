/**
 * 制品索引逻辑测试。
 *
 * 核心断言（旧实现的两个缺陷必须不被复制）：
 * ① **最近 ≠ 相关**：有 query 时按相关性排序，无相关结果返回空，不拿最近顶替
 * ② **上限为 3**：索引再大，一次最多 3 条（索引不是清单）
 * ③ 一条 `record` 的单一入口（不从事件推导）
 */
import { describe, expect, it } from 'vitest'
import type { Logger } from '../../../kernel/abi/index.js'
import { ARTIFACT_TOP_MAX, ArtifactIndex, clampTopLimit, isArtifactKind } from '../../../modules/artifact/index.js'
import type { ArtifactPrivacyPort } from '../../../modules/artifact/index.js'

describe('record：同路径 upsert', () => {
  it('同路径不产生重复条目，且更新 at/hash', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'src/a.ts', kind: 'file', at: 1 })
    index.record({ path: 'src/a.ts', contentHash: 'abc', at: 5 })
    expect(index.size()).toBe(1)
    const entry = index.list()[0]
    expect(entry).toMatchObject({ path: 'src/a.ts', kind: 'file', contentHash: 'abc', at: 5 })
  })

  it('空路径被忽略（不臆造条目）', () => {
    const index = new ArtifactIndex()
    expect(index.record({ path: '   ', at: 1 })).toBeUndefined()
    expect(index.size()).toBe(0)
  })

  it('kind 默认 unknown；未观察到的内容哈希是空串（不拿路径哈希冒充）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'x', at: 1 })
    expect(index.list()[0]).toMatchObject({ kind: 'unknown', contentHash: '' })
  })

  it('非法 kind 不写入（保持原值）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'x', kind: 'file', at: 1 })
    const kept = index.record({ path: 'x', kind: 'garbage', at: 2 })
    expect(kept?.kind).toBe('file')
    expect(isArtifactKind('garbage')).toBe(false)
    expect(isArtifactKind('dir')).toBe(true)
  })

  it('超出 maxEntries 时按 at 淘汰最旧（索引有界）', () => {
    const index = new ArtifactIndex({ maxEntries: 2 })
    index.record({ path: 'old', at: 1 })
    index.record({ path: 'mid', at: 2 })
    index.record({ path: 'new', at: 3 })
    expect(index.size()).toBe(2)
    expect(index.list().map(e => e.path)).toEqual(['new', 'mid'])
  })
})

describe('topFor：相关性优先，上限 3', () => {
  it('有 query 时：最近的无关制品不会被塞进来（最近 ≠ 相关）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'src/parser.ts', at: 1 })
    index.record({ path: 'docs/notes.md', at: 100 })
    expect(index.topFor('parser').map(e => e.path)).toEqual(['src/parser.ts'])
    expect(index.topFor('does-not-exist')).toEqual([])
  })

  it('不把"看起来沾边"当命中：notes 里含 not 不算匹配 not', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'docs/notes.md', at: 1 })
    expect(index.topFor('not')).toEqual([])
    expect(index.topFor('notes').map(e => e.path)).toEqual(['docs/notes.md'])
  })

  it('无 query 时按最近排序（调用方明确要"最近"）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'a', at: 1 })
    index.record({ path: 'b', at: 9 })
    expect(index.topFor().map(e => e.path)).toEqual(['b', 'a'])
  })

  it('一次最多 3 条：默认 3、显式大值被夹住、0 被夹到 1', () => {
    const index = new ArtifactIndex()
    for (let i = 0; i < 10; i += 1) index.record({ path: `src/f${i}.ts`, at: i })
    expect(index.topFor('src').length).toBe(ARTIFACT_TOP_MAX)
    expect(index.topFor('src', 99).length).toBe(ARTIFACT_TOP_MAX)
    expect(index.topFor('src', 0).length).toBe(1)
    expect(index.topFor('src', 2).length).toBe(2)
    expect(clampTopLimit(Number.NaN)).toBe(ARTIFACT_TOP_MAX)
    expect(clampTopLimit(undefined)).toBe(ARTIFACT_TOP_MAX)
  })

  it('同名文件优先于"路径里恰好包含"的文件', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'src/deep/nested/util.ts', at: 1 })
    index.record({ path: 'util.ts', at: 2 })
    expect(index.topFor('util.ts')[0]?.path).toBe('util.ts')
  })

  it('多词查询按词命中数排序', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'src/vector.ts', at: 1 })
    index.record({ path: 'src/vector-store.ts', at: 2 })
    expect(index.topFor('vector store')[0]?.path).toBe('src/vector-store.ts')
  })

  it('Windows 路径两种分隔符都能命中', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'D:\\proj\\src\\a.ts', at: 1 })
    expect(index.topFor('a.ts').map(e => e.path)).toEqual(['D:\\proj\\src\\a.ts'])
    expect(index.topFor('D:/proj/src').map(e => e.path)).toEqual(['D:\\proj\\src\\a.ts'])
  })

  it('CJK 单字也能命中（与 CJK 检索同一教训：不要要求最小词长）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'docs/设计稿.md', at: 1 })
    expect(index.topFor('设').map(e => e.path)).toEqual(['docs/设计稿.md'])
  })

  it('结果稳定：同分按 at 降序、再按路径字典序', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'b/x.ts', at: 5 })
    index.record({ path: 'a/x.ts', at: 5 })
    expect(index.topFor('x.ts').map(e => e.path)).toEqual(['a/x.ts', 'b/x.ts'])
  })
})

describe('单一入口：没有事件推导', () => {
  it('索引不暴露 observe/fromEvent 之类的方法（Lead 裁决：dsh 侧喂路径）', () => {
    const index = new ArtifactIndex()
    const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(index))
    expect(prototype).not.toContain('observe')
    expect(prototype).not.toContain('fromEvent')
    expect(prototype).not.toContain('inject')
    expect(prototype).not.toContain('contribute')
  })

  it('clear 之后索引为空', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'a', at: 1 })
    index.clear()
    expect(index.size()).toBe(0)
    expect(index.topFor()).toEqual([])
  })
})

/**
 * S3-c：**写入被隐私闸门拒绝时必须留声**。
 *
 * 修复前的形态（审计 C3）：`record` 抛可读错误 → `dsh/hooks.ts` 的订阅回调吞掉
 * → 索引静默停更，`omb_files` 与状态面却都写"本会话还没有观察到任何制品"
 * （错误暗示），唯一线索在另一个模块（privacy）的计数里。
 *
 * 现在索引自己记住：拒绝**次数** + **最近原因**。`0` 与 `null` 是真实读数
 * （本实例从构造起一直在数），不是"未测量"。
 */
describe('写入被拒：留声（S3-c）', () => {
  /** 隐私替身：只实现判定面（结构契约），`deny` 里的会话禁写，其余放行。 */
  const privacyDenying = (deny: readonly string[]): ArtifactPrivacyPort => ({
    decide: sessionId =>
      deny.includes(sessionId)
        ? { allowRead: false, allowWrite: false, readReason: `${sessionId} 已 sealed：禁止读取`, writeReason: `${sessionId} 已 sealed：禁止写入` }
        : { allowRead: true, allowWrite: true, readReason: '', writeReason: '' },
    decideUnattributed: () => ({
      allowRead: true,
      allowWrite: false,
      readReason: '',
      writeReason: '归属未知且存在受限会话：禁止写入',
    }),
    restricted: () => true,
  })

  const capturingLogger = (): { logger: Logger; warns: string[] } => {
    const warns: string[] = []
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warns.push(message)
      },
    }
    return { logger, warns }
  }

  it('拒绝时抛可读错误、计数递增、最近原因可读；放行的会话照常写入（反向断言）', () => {
    const { logger, warns } = capturingLogger()
    const index = new ArtifactIndex({ privacy: () => privacyDenying(['s1']), logger })
    expect(index.writeRejection()).toEqual({ count: 0, lastReason: null })

    expect(() => index.record({ path: 'src/a.ts', kind: 'file', at: 1 }, 's1')).toThrow(/sealed/)
    expect(index.size()).toBe(0)
    expect(index.rejectedWrites()).toBe(1)
    expect(index.lastWriteRejection()).toContain('禁止写入')

    // 归属未知（拿不到会话）同样按最严处理，并留声
    expect(() => index.record({ path: 'src/b.ts', kind: 'file', at: 2 })).toThrow(/归属未知/)
    expect(index.rejectedWrites()).toBe(2)
    expect(index.lastWriteRejection()).toContain('归属未知')

    // **第一次拒绝必须写日志**（否则这个降级最初就是静默的）；
    // 同类失败随后只计数，不逐条刷屏（否则每次工具调用都 warn）
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('写入被隐私闸门拒绝')

    // 反向断言：放行的会话说写就写，拒绝计数不变
    expect(index.record({ path: 'src/c.ts', kind: 'file', at: 3 }, 's2')?.path).toBe('src/c.ts')
    expect(index.size()).toBe(1)
    expect(index.rejectedWrites()).toBe(2)
  })

  it('clear 清条目但**不清拒绝计数**（拒绝是"发生过什么"，不是"现在有什么"）', () => {
    const index = new ArtifactIndex({ privacy: () => privacyDenying(['s1']) })
    expect(() => index.record({ path: 'a', at: 1 }, 's1')).toThrow()
    index.clear()
    expect(index.size()).toBe(0)
    expect(index.rejectedWrites()).toBe(1)
    expect(index.lastWriteRejection()).not.toBeNull()
  })

  it('没有隐私端口 = 不受限：拒绝计数恒为 0，且不写任何日志', () => {
    const { logger, warns } = capturingLogger()
    const index = new ArtifactIndex({ logger })
    index.record({ path: 'a', kind: 'file', at: 1 }, 'anything')
    expect(index.writeRejection()).toEqual({ count: 0, lastReason: null })
    expect(warns).toEqual([])
  })
})
