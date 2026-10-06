/**
 * `omb_files` 工具测试。
 *
 * 硬约束：
 * ① 参数解析与执行体**绝不抛异常**（非法输入降级，不中断回合）
 * ② 返回**只有索引条目**（路径/类型/时间），**没有内容**
 * ③ 服务/索引异常 → error 分支的可读文本
 */
import { describe, expect, it, vi } from 'vitest'
import { ArtifactIndex } from '../../../modules/artifact/index.js'
import type { ArtifactEntry, ArtifactPrivacyPort } from '../../../modules/artifact/index.js'
import {
  createFilesTool,
  FILES_TOOL_NAME,
  formatFilesResult,
  formatUtc,
  parseFilesInput,
} from '../../../modules/artifact/tools.js'

function indexWith(entries: readonly { path: string; at: number }[]): ArtifactIndex {
  const index = new ArtifactIndex()
  for (const entry of entries) index.record({ path: entry.path, kind: 'file', at: entry.at })
  return index
}

describe('parseFilesInput：非法输入不抛', () => {
  it('各种垃圾输入都降级为空筛选', () => {
    for (const bad of [null, undefined, 42, 'query', [], true, () => {}]) {
      expect(() => parseFilesInput(bad)).not.toThrow()
      expect(parseFilesInput(bad)).toEqual({})
    }
    expect(parseFilesInput({ query: 12, limit: 'x' })).toEqual({})
    expect(parseFilesInput({ query: '  a  ', limit: 2 })).toEqual({ query: 'a', limit: 2 })
    expect(parseFilesInput({ query: '' })).toEqual({})
    expect(parseFilesInput({ limit: Number.NaN })).toEqual({})
  })
})

describe('formatUtc：不用 Date 的纯算术格式化（模块层禁直接取时间）', () => {
  it('已知时间戳格式稳定', () => {
    expect(formatUtc(1_000)).toBe('1970-01-01 00:00Z')
    expect(formatUtc(1_700_000_000_000)).toBe('2023-11-14 22:13Z')
    expect(formatUtc(1_000_000_000_000)).toBe('2001-09-09 01:46Z')
  })

  it('0 是"未观察到时间"的哨兵，非法时间降级为可读文案', () => {
    expect(formatUtc(0)).toBe('时间未知')
    expect(formatUtc(Number.NaN)).toBe('时间未知')
    expect(formatUtc(-1)).toBe('时间未知')
  })
})

describe('formatFilesResult：只有索引，没有内容', () => {
  const entries: readonly ArtifactEntry[] = [
    { path: 'src/a.ts', kind: 'file', contentHash: 'deadbeef', at: 1_700_000_000_000 },
  ]

  it('包含路径与类型，且**不含内容哈希/文件正文**', () => {
    const text = formatFilesResult(entries)
    expect(text).toContain('src/a.ts')
    expect(text).toContain('file')
    expect(text).not.toContain('deadbeef') // 内容哈希不是内容，但也没必要占位
    expect(text).toContain('内容请用读取类工具按需取')
  })

  it('空结果分两种说法：无筛选 vs 无匹配（并说明"最近 ≠ 相关"）', () => {
    expect(formatFilesResult([], undefined)).toContain('索引为空')
    expect(formatFilesResult([], 'nope')).toContain('最近 ≠ 相关')
  })
})

describe('createFilesTool', () => {
  it('名称与描述面向模型，参数 schema 解析不抛', async () => {
    const tool = createFilesTool({ index: indexWith([{ path: 'src/a.ts', at: 1 }]) })
    expect(tool.name).toBe(FILES_TOOL_NAME)
    expect(tool.description).toContain('不含内容')
    expect(() => tool.parameters.parse(null)).not.toThrow()
    expect(() => tool.parameters.parse({ query: { nested: true } })).not.toThrow()
  })

  it('参数带 jsonSchema（模型看不到 zod；缺失会让工具"存在但无从填写"）', () => {
    const tool = createFilesTool({ index: indexWith([{ path: 'src/a.ts', at: 1 }]) })
    const jsonSchema = (tool.parameters as { jsonSchema?: Record<string, unknown> }).jsonSchema
    expect(jsonSchema).toBeDefined()
    expect(jsonSchema?.['type']).toBe('object')
    const properties = jsonSchema?.['properties'] as Record<string, { type?: string; maximum?: number }>
    expect(properties['query']?.type).toBe('string')
    expect(properties['limit']?.type).toBe('integer')
    expect(properties['limit']?.maximum).toBe(3) // 与运行期夹取上限一致，声明不漂
  })

  it('正常执行返回索引文本', async () => {
    const tool = createFilesTool({ index: indexWith([{ path: 'src/a.ts', at: 1 }]) })
    const outcome = await tool.execute({ query: 'a.ts' })
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') expect(outcome.text).toContain('src/a.ts')
  })

  it('执行体对垃圾参数绝不抛异常', async () => {
    const tool = createFilesTool({ index: indexWith([{ path: 'src/a.ts', at: 1 }]) })
    for (const bad of [null, undefined, 42, 'x', [], { query: {}, limit: {} }]) {
      const outcome = await tool.execute(bad)
      expect(outcome.kind).toBe('text')
    }
  })

  it('索引内部异常 → error 分支的可读文本（不抛）', async () => {
    const broken = {
      topFor: vi.fn(() => {
        throw new Error('索引坏了')
      }),
    } as unknown as ArtifactIndex
    const tool = createFilesTool({ index: broken })
    const outcome = await tool.execute({})
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.text).toContain('索引坏了')
  })
})

/**
 * S3-c：`omb_files` 的"索引为空"必须区分**两种空**。
 *
 * 修复前的形态：无论什么原因，空索引一律回答"本会话还没有观察到任何制品"。
 * 存在被拒写入时，那是**错误暗示**——真因是隐私闸门禁止写入，索引停更
 * （用户设过一次 sealed 就会这样，且连累全部会话的归属未知写入）。
 */
describe('omb_files：两种空与本会话无关的三件事（S3-c）', () => {
  /** 隐私替身：归属未知禁写（存在受限会话），`sealed` 的会话连读也禁。 */
  const privacyPort = (sealed: readonly string[]): ArtifactPrivacyPort => ({
    decide: sessionId =>
      sealed.includes(sessionId)
        ? { allowRead: false, allowWrite: false, readReason: `${sessionId} 已 sealed：禁止读取`, writeReason: `${sessionId} 已 sealed：禁止写入` }
        : { allowRead: true, allowWrite: true, readReason: '', writeReason: '' },
    decideUnattributed: () => ({
      allowRead: false,
      allowWrite: false,
      readReason: '归属未知且存在受限会话：拒绝读取',
      writeReason: '归属未知且存在受限会话：禁止写入',
    }),
    restricted: () => true,
  })

  it('真没观察到 → 原话照旧（不提隐私，不制造恐慌）', async () => {
    const tool = createFilesTool({ index: new ArtifactIndex() })
    const outcome = await tool.execute({})
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') {
      expect(outcome.text).toContain('索引为空')
      expect(outcome.text).toContain('还没有观察到任何制品')
      expect(outcome.text).not.toContain('隐私')
    }
  })

  it('写入被拒导致停更 → 空结果点名隐私模式、拒绝次数与最近原因', async () => {
    const index = new ArtifactIndex({ privacy: () => privacyPort(['s1']) })
    // 归属未知的写入被拒（真实形态：dsh/hooks 拿不到会话、或存在受限会话）
    expect(() => index.record({ path: 'src/a.ts', kind: 'file', at: 1 })).toThrow()
    const tool = createFilesTool({ index })
    // 读的是不受限的会话 s2：读放行，于是能走到"空索引"这条文案
    const outcome = await tool.execute({}, { sessionId: 's2', attribution: 'session' })
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') {
      expect(outcome.text).toContain('索引为空')
      expect(outcome.text).toContain('不是')
      expect(outcome.text).toContain('1 次写入被隐私闸门拒绝')
      expect(outcome.text).toContain('禁止写入')
      expect(outcome.text).toContain('/omb-privacy')
    }
  })

  it('查询没匹配 ≠ 空索引 ≠ 被拒停更：三种说法互不冒充', async () => {
    const index = new ArtifactIndex({ privacy: () => privacyPort(['s1']) })
    const tool = createFilesTool({ index })
    const outcome = await tool.execute({ query: 'nope' }, { sessionId: 's2', attribution: 'session' })
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') {
      expect(outcome.text).toContain('最近 ≠ 相关')
      expect(outcome.text).not.toContain('隐私闸门拒绝')
    }
  })

  it('类型列真的有内容：kind=file / dir 直接渲染（不再恒为 unknown）', () => {
    const index = new ArtifactIndex()
    index.record({ path: 'src/a.ts', kind: 'file', at: 1_700_000_000_000 })
    index.record({ path: 'D:/proj/src', kind: 'dir', at: 1_700_000_000_000 })
    const text = formatFilesResult(index.topFor())
    expect(text).toContain('src/a.ts（file，')
    expect(text).toContain('D:/proj/src（dir，')
    expect(text).not.toContain('（unknown，')
  })
})
