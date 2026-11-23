import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FULLTEXT_MAX_QUERY_TERMS, fulltextQueryTerms } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

/** 召回质量只关心文本 SQL；向量通道用不可用替身，避免依赖 ONNX 模型文件。 */
class NoVectorEmbedder implements Embedder {
  readonly model = 'no-vector'
  readonly dims = 512

  async available(): Promise<boolean> {
    return false
  }

  async embed(): Promise<number[][]> {
    throw new Error('向量不可用时不应调用 embed')
  }
}

describe('T1 全文查询词边界（纯函数）', () => {
  it('给定超过上限的词当裁剪则保留路径/错误码/长词并保持确定性', () => {
    const singles = Array.from({ length: 50 }, (_, index) => String.fromCharCode(0x4e00 + index))
    const tokens = [...singles, 'src/main.ts', 'TS2304', 'econnreset']

    const terms = fulltextQueryTerms(tokens)

    expect(terms).toHaveLength(FULLTEXT_MAX_QUERY_TERMS)
    // 后置出现的信号词必须挤掉前面的普通单字，否则超限裁剪会丢掉路径/错误码。
    expect(terms).toContain('src/main.ts')
    expect(terms).toContain('TS2304')
    expect(terms).toContain('econnreset')
    expect(fulltextQueryTerms(tokens)).toEqual(terms)
  })

  it('给定重复与 tsquery 元字符词当筛选则去重并丢弃危险词', () => {
    const terms = fulltextQueryTerms(['猫', '猫', '狗', '&', '|', '!', '(', ')', ':*', '猫 & 狗', "a'b", ''])

    expect(terms).toEqual(['猫', '狗'])
  })

  it('给定超长无分隔词当筛选则丢弃而不撑大 tsquery，长哈希片段仍保留', () => {
    const sha256 = 'a'.repeat(64)
    const blob = 'a'.repeat(300)

    const terms = fulltextQueryTerms([blob, sha256, '部署'])

    expect(terms).toEqual([sha256, '部署'])
  })
})

describe('T1 检索召回质量（真实 PostgreSQL）', () => {
  let db: PostgresStore

  beforeAll(async () => {
    await prepareDatabase()
    db = store()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await db?.close()
    await resetDatabase()
  })

  async function writeMemory(input: WriteEntityInput): Promise<string> {
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  it('给定长自然语言查询当全文检索则命中正确实体而不是零命中', async () => {
    const targetId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '生产部署回滚与连接池排障记录',
        body: '上一次生产部署回滚时数据库连接池被占满，日志里出现 ECONNRESET，根因是连接泄漏；处理方式是重启连接池、增加重试并延长超时。',
      },
    })
    await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '季度部署审批流程', body: '部署申请需要两名负责人审批，回滚窗口另行通知。' },
    })
    await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '连接池参数笔记', body: '连接池最大连接数与空闲连接回收时间。' },
    })

    const query = '帮我回忆上次生产部署回滚的时候，数据库连接池被打满、日志出现 ECONNRESET 报错，我们当时怎么处理连接泄漏、重试和超时的？'
    const tokens = tokenize(query)
    // 长查询的 tokenizer 输出远多于单次查询上限，必须被裁剪后仍能召回。
    expect(tokens.length).toBeGreaterThan(48)

    const hits = await db.fulltext({ query, tokens, limit: 10 })

    expect(hits.map(hit => hit.entityId)).toContain(targetId)
    expect(hits[0]?.entityId).toBe(targetId)
    expect(hits[0]?.rawScore ?? 0).toBeGreaterThan(0)
  })

  it('给定长正文里只出现在末尾的单字当单字回退则命中', async () => {
    // 240 字 snippet 之外的尾部字符：RET-01 里用 snippet 复核时必然漏召回。
    const prefix = '部署手册补充说明：每一步都需要回滚验证，并记录耗时。'.repeat(12)
    const body = `${prefix}熔断阈值是两百毫秒。`
    const tailId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '长正文记忆', body },
    })

    const view = await db.db.query<{ snippet: string; chars: string[] }>(
      'select snippet, chars from omb.entity_view where entity_id = $1',
      [tailId],
    )
    // 先证明用例真的踩在截断边界上：字符不在 snippet，但在 chars 里。
    expect(view.rows[0]?.snippet).not.toContain('阈')
    expect(view.rows[0]?.chars).toContain('阈')

    const hits = await db.singleChar({ query: '阈', tokens: tokenize('阈'), limit: 5 })

    expect(hits.map(hit => hit.entityId)).toContain(tailId)
  })

  it('给定两个字在正文中间隔出现当单字回退则连续子串的 raw 更高且排在前面', async () => {
    const contiguousId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '猫狗行为观察' },
    })
    const scatteredId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '猫和狗的日常' },
    })

    const hits = await db.singleChar({ query: '猫狗', tokens: tokenize('猫狗'), limit: 10 })
    const contiguous = hits.find(hit => hit.entityId === contiguousId)
    const scattered = hits.find(hit => hit.entityId === scatteredId)

    expect(contiguous).toBeDefined()
    expect(scattered).toBeDefined()
    expect(contiguous?.rawScore ?? 0).toBeGreaterThan(scattered?.rawScore ?? 0)
    expect(hits[0]?.entityId).toBe(contiguousId)
  })

  it('给定省略 scope 当引擎召回则全局与项目记忆都命中', async () => {
    const globalId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '部署回滚手册全局版', body: '部署回滚步骤与检查项。' },
    })
    const projectId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: 'D:/repo' },
      attrs: { title: '部署回滚手册项目版', body: '部署回滚步骤与检查项。' },
    })

    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
    const result = await engine.recall({ query: '部署回滚手册', now: FIXED_NOW })

    expect(result.hits.map(hit => hit.entityId)).toEqual(expect.arrayContaining([globalId, projectId]))
  })

  it('给定显式 project/global 当引擎召回则作用域过滤不退化', async () => {
    const globalId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '部署回滚手册全局版', body: '部署回滚步骤与检查项。' },
    })
    const projectId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: 'D:/repo' },
      attrs: { title: '部署回滚手册项目版', body: '部署回滚步骤与检查项。' },
    })

    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
    const project = await engine.recall({ query: '部署回滚手册', now: FIXED_NOW, scope: 'project', projectKey: 'D:/repo' })
    const global = await engine.recall({ query: '部署回滚手册', now: FIXED_NOW, scope: 'global' })

    expect(project.hits.map(hit => hit.entityId)).toEqual([projectId])
    expect(global.hits.map(hit => hit.entityId)).toEqual([globalId])
  })

  it('给定 64 个查询词当全文检索则裁剪后结果与顺序稳定', async () => {
    const tokens = Array.from({ length: 64 }, (_, index) => `kw${index + 1}`)
    const firstId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '关键词集合甲', body: tokens.slice(0, 10).join(' ') },
    })
    const secondId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '关键词集合乙', body: tokens.slice(10, 20).join(' ') },
    })

    const first = await db.fulltext({ query: tokens.join(' '), tokens, limit: 10 })
    const second = await db.fulltext({ query: tokens.join(' '), tokens, limit: 10 })

    expect(first.map(hit => hit.entityId).sort()).toEqual([firstId, secondId].sort())
    expect(first.map(hit => hit.entityId)).toEqual(second.map(hit => hit.entityId))
  })

  it('给定含 tsquery 元字符的词当全文检索则跳过危险词且不抛语法错误', async () => {
    const id = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '检索安全测试' },
    })

    const tokens = ['检索', '&', '|', '!', '(', ')', ':*', '猫 & 狗', "a'b", '检索']
    const hits = await db.fulltext({ query: '检索 &|!()', tokens, limit: 5 })

    expect(hits.map(hit => hit.entityId)).toEqual([id])
  })

  it('给定只有标点与元字符的查询当引擎召回则全文通道跳过并给出原因', async () => {
    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })

    const result = await engine.recall({ query: '&|!()', now: FIXED_NOW })

    const fulltext = result.channels.find(report => report.channel === 'fulltext')
    expect(fulltext?.status).toBe('skipped')
    expect(fulltext?.reason ?? '').toContain('没有全文词')
    expect(result.hits).toHaveLength(0)
  })
})
