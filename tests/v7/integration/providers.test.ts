import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HASH_DIMS, HASH_MODEL, HashEmbedder, hashEmbed } from '../../../packages/v7/src/adapters/embedding/hash.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import type { Store } from '../../../packages/v7/src/ports/store.js'
import { runStageOnePlan } from '../../../packages/v7/src/retrieval/channels.js'
import {
  compileRetrievalPlan,
  parseRetrievalPlan,
  type RetrievalPlan,
} from '../../../packages/v7/src/retrieval/compiler.js'
import { DEFAULT_RETRIEVAL_CONFIG } from '../../../packages/v7/src/retrieval/config.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { createStageOneProviders, runProviderSet } from '../../../packages/v7/src/retrieval/providers/index.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'
const ANCHOR = Date.parse(FIXED_NOW)
const WINDOW = { from: '2026-11-15T00:00:00.000Z', to: FIXED_NOW }

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

/** 文本/SQL 类 provider 用不可用向量替身，避免依赖 ONNX 模型文件。 */
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

const noVector = new NoVectorEmbedder()

function planFor(request: Parameters<typeof compileRetrievalPlan>[0]): RetrievalPlan {
  return compileRetrievalPlan(request, {
    config: DEFAULT_RETRIEVAL_CONFIG,
    now: FIXED_NOW,
    executionAnchorMs: ANCHOR,
  })
}

function providersOf(channel: string) {
  return createStageOneProviders().filter(provider => provider.channel === channel)
}

/** 让某个 store 方法恒失败，用来验证 provider 失败隔离（其余方法仍走真实 PG）。 */
function failingStore(base: Store, channel: keyof Store): Store {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === channel) {
        return async (): Promise<never> => {
          throw new Error(`${String(channel)} channel down`)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** deadline 过期时任何存储查询都算失败：用会抛错的 Proxy 证明“没有发 SQL”。 */
function forbiddenStore(base: Store): Store {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      return (): never => {
        throw new Error(`deadline 过期不应查询 ${String(property)}`)
      }
    },
  })
}

describe('QueryCompiler + Providers（真实 PostgreSQL）', () => {
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

  async function writeMemory(attrs: { title: string; body?: string }, scope: 'global' | 'project' = 'global'): Promise<string> {
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: scope === 'global' ? { kind: 'global' } : { kind: 'project', projectKey: 'D:/repo' },
      attrs,
    }
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  async function writeState(title: string, time: string): Promise<string> {
    const input: WriteEntityInput = {
      kind: 'state',
      scope: { kind: 'global' },
      title,
      status: 'in_progress',
      time,
      attrs: { body: 'deploy runbook' },
    }
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  it('给定长自然语言查询当计划执行 fulltext provider 则命中目标实体，JSON 往返后重放结果一致', async () => {
    const targetId = await writeMemory({
      title: '生产部署回滚与连接池排障记录',
      body: '上一次生产部署回滚时数据库连接池被占满，日志里出现 ECONNRESET，根因是连接泄漏；处理方式是重启连接池、增加重试并延长超时。',
    })
    await writeMemory({ title: '季度部署审批流程', body: '部署申请需要两名负责人审批，回滚窗口另行通知。' })
    await writeMemory({ title: '连接池参数笔记', body: '连接池最大连接数与空闲连接回收时间。' })

    const query = '帮我回忆上次生产部署回滚的时候，数据库连接池被打满、日志出现 ECONNRESET 报错，我们当时怎么处理连接泄漏、重试和超时的？'
    const plan = planFor({ query })
    // 长查询的计划词表必须是有界的，且信号词（错误码）优先进入 tsquery。
    expect(plan.terms.length).toBeGreaterThan(0)
    expect(plan.terms.length).toBeLessThanOrEqual(plan.budget.terms)

    const first = await runProviderSet(providersOf('fulltext'), plan, { store: db, embedder: noVector }, { nowMs: ANCHOR })
    expect(first[0]?.status).toBe('ok')
    expect(first[0]?.hits.map(entry => entry.entityId)).toContain(targetId)
    expect(first[0]?.hits[0]?.entityId).toBe(targetId)

    const stored = JSON.parse(JSON.stringify(plan)) as unknown
    const parsed = parseRetrievalPlan(stored)
    const replayed = await runProviderSet(providersOf('fulltext'), parsed, { store: db, embedder: noVector }, { nowMs: ANCHOR })
    expect(replayed[0]?.hits.map(entry => entry.entityId)).toEqual(first[0]?.hits.map(entry => entry.entityId))
    expect(replayed[0]?.hits.map(entry => entry.rawScore)).toEqual(first[0]?.hits.map(entry => entry.rawScore))
  })

  it('给定长正文后部单字当 single_char provider 执行则命中（chars + search_text，不回退 snippet）', async () => {
    const prefix = '部署手册补充说明：每一步都需要回滚验证，并记录耗时。'.repeat(12)
    const tailId = await writeMemory({ title: '长正文记忆', body: `${prefix}熔断阈值是两百毫秒。` })

    const view = await db.db.query<{ snippet: string; chars: string[] }>(
      'select snippet, chars from omb.entity_view where entity_id = $1',
      [tailId],
    )
    // 先证明用例踩在截断边界上：字符不在 240 字 snippet 里，但 chars GIN 覆盖全文。
    expect(view.rows[0]?.snippet).not.toContain('阈')
    expect(view.rows[0]?.chars).toContain('阈')

    const plan = planFor({ query: '阈' })
    expect(plan.normalizedQuery).toBe('阈')
    const outcomes = await runProviderSet(providersOf('single_char'), plan, { store: db, embedder: noVector }, {
      nowMs: ANCHOR,
      previous: new Map(),
    })

    expect(outcomes[0]?.status).toBe('ok')
    expect(outcomes[0]?.hits.map(entry => entry.entityId)).toContain(tailId)
    // search_text 去空格后包含该字 → 连续子串原始分 1.0。
    expect(outcomes[0]?.hits[0]?.rawScore).toBe(1)
  })

  it('给定 scope=project 与 global 当计划执行 fulltext 则作用域过滤不退化', async () => {
    const globalId = await writeMemory({ title: '部署回滚手册全局版', body: '部署回滚步骤与检查项。' }, 'global')
    const projectId = await writeMemory({ title: '部署回滚手册项目版', body: '部署回滚步骤与检查项。' }, 'project')

    const projectPlan = planFor({ query: '部署回滚手册', scope: 'project', projectKey: 'D:/repo' })
    const globalPlan = planFor({ query: '部署回滚手册', scope: 'global' })

    const project = await runProviderSet(providersOf('fulltext'), projectPlan, { store: db, embedder: noVector }, { nowMs: ANCHOR })
    const global = await runProviderSet(providersOf('fulltext'), globalPlan, { store: db, embedder: noVector }, { nowMs: ANCHOR })

    expect(project[0]?.hits.map(entry => entry.entityId)).toEqual([projectId])
    expect(global[0]?.hits.map(entry => entry.entityId)).toEqual([globalId])
  })

  it('给定显式 timeWindow 当计划执行 time provider 则只返回窗内事件', async () => {
    const oldId = await writeState('deploy old', '2026-10-01T00:00:00.000Z')
    const newId = await writeState('deploy new', '2026-11-20T00:00:00.000Z')

    const plan = planFor({ query: 'deploy', timeWindow: WINDOW })
    expect(plan.time.lookback).toEqual(WINDOW)
    const outcomes = await runProviderSet(providersOf('time'), plan, { store: db, embedder: noVector }, { nowMs: ANCHOR })

    const ids = outcomes[0]?.hits.map(entry => entry.entityId) ?? []
    expect(ids).toContain(newId)
    expect(ids).not.toContain(oldId)
  })

  it('给定 time 通道断开当阶段一执行则它 failed、fulltext 真实命中仍保留', async () => {
    const targetId = await writeMemory({ title: '部署回滚手册', body: '部署回滚步骤与检查项。' })
    const plan = planFor({ query: '部署回滚' })

    const outcome = await runStageOnePlan({ store: failingStore(db, 'time'), embedder: noVector }, plan, {
      executionAnchorMs: ANCHOR,
    })

    const time = outcome.reports.find(report => report.channel === 'time')
    expect(time?.status).toBe('failed')
    expect(time?.reason).toContain('time channel down')
    expect(outcome.errors.find(error => error.channel === 'time')?.message).toContain('time channel down')

    // 失败隔离：fulltext 仍在真实 PG 上命中，single_char 因“全文已有命中”跳过。
    const fulltext = outcome.reports.find(report => report.channel === 'fulltext')
    expect(fulltext?.status).toBe('ok')
    expect((outcome.hitsByChannel.get('fulltext') ?? []).map(entry => entry.entityId)).toContain(targetId)
    expect(outcome.reports.find(report => report.channel === 'single_char')?.status).toBe('skipped')
  })

  it('给定计划 deadline 已过期当阶段一执行则六个通道都是 deadline 且不触发任何存储查询', async () => {
    const plan = compileRetrievalPlan({ query: 'deploy' }, {
      config: DEFAULT_RETRIEVAL_CONFIG,
      now: FIXED_NOW,
      executionAnchorMs: Date.parse('2020-01-01T00:00:00.000Z'),
    })

    const outcome = await runStageOnePlan({ store: forbiddenStore(db), embedder: noVector }, plan, {
      executionAnchorMs: ANCHOR,
    })

    expect(outcome.reports).toHaveLength(6)
    expect(outcome.reports.every(report => report.status === 'failed')).toBe(true)
    expect(outcome.reports.every(report => (report.reason ?? '').startsWith('deadline:'))).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(outcome.hitsByChannel.size).toBe(0)
    expect(outcome.warnings.some(warning => warning.includes('deadline'))).toBe(true)
  })

  it('给定全文命中当阶段一执行则 single_char 跳过，命中来自 fulltext 而非单字回退', async () => {
    const id = await writeMemory({ title: '单字回退门控记忆', body: '记忆内容。' })
    const plan = planFor({ query: '记忆' })

    const outcome = await runStageOnePlan({ store: db, embedder: noVector }, plan, { executionAnchorMs: ANCHOR })

    expect(outcome.reports.find(report => report.channel === 'fulltext')?.status).toBe('ok')
    const singleChar = outcome.reports.find(report => report.channel === 'single_char')
    expect(singleChar?.status).toBe('skipped')
    expect(singleChar?.reason).toContain('全文已有命中')
    expect((outcome.hitsByChannel.get('fulltext') ?? []).map(entry => entry.entityId)).toContain(id)
    expect(outcome.hitsByChannel.get('single_char')).toBeUndefined()
  })

  it('给定真实嵌入当 vector provider 执行则走 store.vector（iterative_scan）并命中', async () => {
    const embedder = new HashEmbedder()
    const text = '向量检索迭代扫描集成记忆'
    const id = await writeMemory({ title: text, body: text })
    await db.upsertEmbedding(id, HASH_MODEL, HASH_DIMS, hashEmbed(text, HASH_DIMS))

    const plan = planFor({ query: text })
    const outcomes = await runProviderSet(providersOf('vector'), plan, { store: db, embedder }, { nowMs: ANCHOR })

    expect(outcomes[0]?.status).toBe('ok')
    expect(outcomes[0]?.hits.map(entry => entry.entityId)).toEqual([id])
    // 同一文本的哈希向量余弦距离为 0：raw = 1 - distance ≈ 1。
    expect(outcomes[0]?.hits[0]?.rawScore ?? 0).toBeGreaterThan(0.99)
  })

  it('给定长查询只命中一个词当全文检索则原始分仍按 ts_rank_cd 量纲高于门控下限', async () => {
    // 全文检索是「粗筛 ts_rank + 精排 ts_rank_cd」两段式（性能预算 ADR-0013）：粗筛只收窄
    // 候选窗，出分口径必须仍是 ts_rank_cd。ts_rank 会按 OR 词数摊薄（0.0608×命中词数/查询
    // 词数），长查询里只共享一个词的记忆会掉到 channelFloors.fulltext（0.02）以下被静默淘汰；
    // ts_rank_cd 的覆盖密度按命中词数累计（每个词 0.1），不会。
    const id = await writeMemory({ title: 'alpha' })
    const tokens = tokenize('alpha bravo charlie delta echo foxtrot golf hotel')
    expect(tokens).toHaveLength(8)

    const reference = await db.db.query<{ raw: number; coarse: number }>(
      `select ts_rank_cd(v.search_tsv, q)::float8 as raw, ts_rank(v.search_tsv, q)::float8 as coarse
       from omb.entity_view v, to_tsquery('simple', $1) q
       where v.entity_id = $2`,
      [tokens.join(' | '), id],
    )
    const fineScore = Number(reference.rows[0]?.raw)
    const coarseScore = Number(reference.rows[0]?.coarse)
    // 先证明这条语料真的能把两种量纲区分开（否则断言无法锁定精排函数）。
    expect(fineScore).toBeGreaterThanOrEqual(DEFAULT_RETRIEVAL_CONFIG.channelFloors.fulltext)
    expect(coarseScore).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.channelFloors.fulltext)

    const hits = await db.fulltext({ query: tokens.join(' '), tokens, limit: 10 })

    const hit = hits.find(entry => entry.entityId === id)
    expect(hit).toBeDefined()
    expect(hit?.rawScore).toBeCloseTo(fineScore, 6)
    expect(hit?.rawScore ?? 0).toBeGreaterThanOrEqual(DEFAULT_RETRIEVAL_CONFIG.channelFloors.fulltext)
  })

  it('给定命中数超过粗筛候选窗当全文检索则仍返回满通道上限的命中而不截断', async () => {
    // 600 条命中 > 粗筛窗口；limit=100 时必须返回 100 条，否则说明粗筛窗口在静默少返回。
    await db.db.query(
      `insert into omb.entity (id, kind, revision, origin)
       select 'mem_window_' || lpad(i::text, 3, '0'), 'memory', 1, 'test' from generate_series(1, 600) as i`,
    )
    await db.db.query(
      `insert into omb.entity_view (
         entity_id, kind, category, scope, project_key, title, attrs, attr_names,
         search_text, snippet, chars, revision, updated_at
       )
       select 'mem_window_' || lpad(i::text, 3, '0'), 'memory', 'fact', 'global', '',
              'window ' || i, jsonb_build_object('title', 'window ' || i), array['title'],
              'window ' || i, 'window ' || i, array['w'], 1, now()
       from generate_series(1, 600) as i`,
    )

    const hits = await db.fulltext({ query: 'window', tokens: tokenize('window'), limit: 100 })

    expect(hits).toHaveLength(100)
    expect(hits.every(hit => hit.rawScore > 0)).toBe(true)
  })

  it('给定真实 PG 当引擎用计划 JSON 重放则命中/融合分/通道报告与 recall 一致', async () => {
    await writeMemory({ title: '部署回滚手册', body: '部署回滚步骤与检查项。' })
    const engine = new RecallEngine({ store: db, embedder: noVector, clock })

    const direct = await engine.recall({ query: '部署回滚手册', now: FIXED_NOW })
    const plan = engine.compilePlan({ query: '部署回滚手册', now: FIXED_NOW })
    const replayed = await engine.recallFromPlan(JSON.parse(JSON.stringify(plan)), { traceId: 'trc_replay' })

    expect(direct.hits.length).toBeGreaterThan(0)
    expect(replayed.traceId).toBe('trc_replay')
    expect(replayed.scenario).toBe(direct.scenario)
    expect(replayed.hits.map(entry => entry.entityId)).toEqual(direct.hits.map(entry => entry.entityId))
    expect(replayed.hits[0]?.fusedScore).toBeCloseTo(direct.hits[0]?.fusedScore ?? 0, 12)
    expect(replayed.channels).toEqual(direct.channels)
    expect(replayed.expansion).toEqual(direct.expansion)
  })
})
