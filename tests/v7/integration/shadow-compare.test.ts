import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { migrateDatabase } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { databaseNameOf, isDisposableDatabaseName } from '../../../packages/v7/src/security/trust.js'
import type { RecallHit, RecallResult } from '../../../packages/v7/src/retrieval/types.js'
import {
  DEFAULT_SHADOW_PROJECT_KEY,
  assessRetrievalShadow,
  buildShadowReport,
  compareBoardShadow,
  compareRecallResults,
  drainProjections,
  formatHumanSummary,
  openShadowTarget,
  resetShadowDatabase,
  runRetrievalShadow,
  runShadowCompare,
  seedShadowFixtures,
  shadowQuerySpecs,
  summarizeShadow,
  type BoardShadowSection,
  type QueryShadowSection,
  type RetrievalShadowSection,
  type ShadowDatabaseInfo,
} from '../../../scripts/v7-shadow-compare.js'

/**
 * shadow compare 的真实 PG 证据（Task 9 双写/影子比对）。
 *
 * 覆盖两条比对：
 * 1. 写模型（entity/attribute 现算）vs 投影读模型（preference_board/state_board）：
 *    一致/未投影/空库/字段漂移/残留行各自有明确结论，空库与未投影绝不伪报一致。
 * 2. 检索重放：`recall` 与 `recallFromPlan(JSON 往返后的计划)` 的命中/融合分/通道必须一致，
 *    差异即 FAIL；不足 10 条查询或全部零命中都算 inconclusive。
 *
 * 使用独立可抛弃库（env 可覆盖），不碰 omb_v7_test / 生产库。
 */
const DATABASE_URL = process.env.OMB_SHADOW_TEST_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_shadow'
const E2E_DATABASE_URL = process.env.OMB_SHADOW_E2E_DATABASE_URL
  ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_shadow_e2e'
const PROJECT_KEY = DEFAULT_SHADOW_PROJECT_KEY

// 两个库名都含 test 段（可抛弃）；显式声明破坏性用途，生产库名即使有 flag 也会被拒。
for (const url of [DATABASE_URL, E2E_DATABASE_URL]) {
  const name = databaseNameOf(url)
  if (name !== undefined && isDisposableDatabaseName(name)) process.env.OMB_ALLOW_DESTRUCTIVE ??= '1'
}

function boardSection(overrides: Partial<BoardShadowSection> = {}): BoardShadowSection {
  return {
    board: 'preference',
    projection: 'preference_board',
    scope: 'global',
    verdict: 'consistent',
    reasons: [],
    writeModelCount: 1,
    readModelCount: 1,
    compared: 1,
    unprojectedCount: 0,
    divergentCount: 0,
    fallback: { needed: false },
    freshness: { unprojected: 0 },
    diffs: [],
    ...overrides,
  }
}

function querySection(overrides: Partial<QueryShadowSection> = {}): QueryShadowSection {
  return {
    name: 'q',
    query: 'q',
    recallHits: 1,
    replayHits: 1,
    channels: ['fulltext'],
    differences: [],
    ...overrides,
  }
}

function retrievalSection(overrides: Partial<RetrievalShadowSection> = {}): RetrievalShadowSection {
  return {
    verdict: 'consistent',
    reasons: [],
    queryCount: 12,
    queriesWithHits: 12,
    totalHits: 12,
    channels: ['fulltext'],
    queries: [],
    differences: [],
    ...overrides,
  }
}

function databaseInfo(overrides: Partial<ShadowDatabaseInfo> = {}): ShadowDatabaseInfo {
  return { name: 'omb_v7_test_shadow', disposable: true, readOnly: false, mode: 'all', ...overrides }
}

interface MutableHit {
  entityId: string
  fusedScore: number
  score: number
  channels: string[]
}

function mutableHits(result: RecallResult): MutableHit[] {
  return (result.hits as unknown as MutableHit[])
}

/** 只有一条命中的结果副本被改坏；用来验证比较器真的在看融合分/通道，而不是只看条数。 */
function withTamperedHit(result: RecallResult, mutate: (hit: MutableHit) => void): RecallResult {
  const clone = structuredClone(result) as unknown as RecallResult
  const hits = mutableHits(clone)
  const hit = hits[0]
  if (hit === undefined) throw new Error('夹具查询必须至少有一条命中')
  mutate(hit)
  return clone
}

describe('shadow compare 汇总与退出码（纯函数）', () => {
  it('给定看板出现差异当汇总则 verdict=divergent 且退出码 1', () => {
    const divergent = boardSection({
      verdict: 'divergent',
      divergentCount: 1,
      compared: 2,
      diffs: [{ entityId: 'mem_x', kind: 'field-drift', cause: 'divergent' }],
    })

    const summary = summarizeShadow({ boards: [divergent] })

    expect(summary.verdict).toBe('divergent')
    expect(summary.exitCode).toBe(1)
    expect(summary.reasons.join(' ')).toContain('preference')
  })

  it('给定全部一致当汇总则退出码 0；给定 inconclusive 当汇总则退出码 1', () => {
    expect(summarizeShadow({ boards: [boardSection()], retrieval: retrievalSection() })).toMatchObject({
      verdict: 'consistent',
      exitCode: 0,
    })
    expect(summarizeShadow({
      boards: [boardSection({ verdict: 'inconclusive', reasons: ['empty-write-model'] })],
    })).toMatchObject({ verdict: 'inconclusive', exitCode: 1 })
  })

  it('给定报告当格式化则人读摘要含结论/各段结果/退出码，JSON 可无损往返', () => {
    const report = buildShadowReport({
      database: databaseInfo(),
      projectKey: PROJECT_KEY,
      boards: [
        boardSection(),
        boardSection({
          board: 'state',
          projection: 'state_board',
          scope: `project:${PROJECT_KEY}`,
          verdict: 'divergent',
          divergentCount: 1,
          diffs: [{ entityId: 'st_x', kind: 'field-drift', cause: 'divergent' }],
        }),
      ],
      retrieval: retrievalSection(),
    })

    const text = formatHumanSummary(report)

    expect(report.exitCode).toBe(1)
    expect(text).toContain('FAIL (exit 1)')
    expect(text).toContain('state_board')
    expect(text).toContain('st_x')
    expect(text).toContain('检索重放')
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('给定检索重放不足 10 条查询当评估则 inconclusive 且原因写明查询数', () => {
    const queries = Array.from({ length: 9 }, (_, index) => querySection({ name: `q${index}` }))

    const section = assessRetrievalShadow(queries)

    expect(section.verdict).toBe('inconclusive')
    expect(section.queryCount).toBe(9)
    expect(section.reasons.join(' ')).toContain('too-few-queries')
  })

  it('给定全部查询零命中当评估则 inconclusive，不伪报重放一致', () => {
    const queries = Array.from({ length: 12 }, (_, index) => querySection({
      name: `q${index}`,
      recallHits: 0,
      replayHits: 0,
    }))

    const section = assessRetrievalShadow(queries)

    expect(section.verdict).toBe('inconclusive')
    expect(section.totalHits).toBe(0)
    expect(section.reasons.join(' ')).toContain('no-hits')
  })

  it('给定两次重放命中融合分不同当比对则 divergent 字段是 fused-score', () => {
    const hits = [{
      entityId: 'mem_a',
      kind: 'memory',
      snippet: 'A',
      scope: { kind: 'global' },
      updatedAt: '2026-11-28T00:00:00.000Z',
      score: 0.5,
      fusedScore: 0.25,
      why: [],
      channels: ['fulltext'],
      rawScores: { fulltext: 0.5 },
      chainSiblings: [],
      historyCount: 0,
    }, {
      entityId: 'mem_b',
      kind: 'memory',
      snippet: 'B',
      scope: { kind: 'global' },
      updatedAt: '2026-11-28T00:00:00.000Z',
      score: 0.4,
      fusedScore: 0.2,
      why: [],
      channels: ['fulltext'],
      rawScores: { fulltext: 0.4 },
      chainSiblings: [],
      historyCount: 0,
    }] satisfies RecallHit[]
    const direct: RecallResult = {
      traceId: 'trc_direct',
      configVersion: 'v7-retrieval-1',
      scenario: 'manual',
      query: 'needle',
      hits,
      channels: [{ channel: 'fulltext', status: 'ok', hitCount: 2 }],
      channelErrors: [],
      expansion: { seeds: 2, expanded: 0, chains: 0 },
      warnings: [],
    }
    const replayed = structuredClone(direct) as unknown as RecallResult
    const replayedHits = replayed.hits as unknown as MutableHit[]
    replayedHits[0]!.fusedScore = 0.99

    const section = compareRecallResults('q1', 'needle', direct, replayed)

    expect(section.differences).toContainEqual(expect.objectContaining({
      kind: 'fused-score',
      entityId: 'mem_a',
      recall: 0.25,
      replay: 0.99,
    }))
    // 融合分差异本身不该被放大成条数差异。
    expect(section.differences.some(difference => difference.kind === 'hit-count')).toBe(false)
  })

  it('给定两次重放命中通道集合不同当比对则 divergent 字段是 channels', () => {
    const direct: RecallResult = {
      traceId: 'trc_direct',
      configVersion: 'v7-retrieval-1',
      scenario: 'manual',
      query: 'needle',
      hits: [{
        entityId: 'mem_a',
        kind: 'memory',
        snippet: 'A',
        scope: { kind: 'global' },
        updatedAt: '2026-11-28T00:00:00.000Z',
        score: 0.5,
        fusedScore: 0.25,
        why: [],
        channels: ['fulltext', 'vector'],
        rawScores: { fulltext: 0.5, vector: 0.8 },
        chainSiblings: [],
        historyCount: 0,
      }],
      channels: [
        { channel: 'fulltext', status: 'ok', hitCount: 1 },
        { channel: 'vector', status: 'ok', hitCount: 1 },
      ],
      channelErrors: [],
      expansion: { seeds: 1, expanded: 0, chains: 0 },
      warnings: [],
    }
    const replayed = structuredClone(direct) as unknown as {
      hits: { channels: string[] }[]
      channels: { channel: string; status: string; hitCount: number }[]
    } & RecallResult
    replayed.hits[0]!.channels = ['fulltext']
    replayed.channels[1] = { channel: 'vector', status: 'failed', hitCount: 0 }

    const section = compareRecallResults('q2', 'needle', direct, replayed as unknown as RecallResult)

    expect(section.differences).toContainEqual(expect.objectContaining({ kind: 'channels', entityId: 'mem_a' }))
    expect(section.differences).toContainEqual(expect.objectContaining({ kind: 'channel-report', channel: 'vector' }))
    expect(section.differences.some(difference => difference.kind === 'hit-count')).toBe(false)
  })
})

describe('看板 shadow compare（真实 PostgreSQL）', () => {
  let target: ReturnType<typeof openShadowTarget>

  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    target = openShadowTarget(DATABASE_URL)
  })

  beforeEach(async () => {
    await resetShadowDatabase(target)
  })

  afterAll(async () => {
    await resetShadowDatabase(target)
    await target.close()
  })

  it('给定写模型已全部投影当比对偏好看板则一致且无差异', async () => {
    await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
    await drainProjections(target)

    const section = await compareBoardShadow(target.boards, {
      kind: 'preference',
      scope: { kind: 'global' },
      limit: 100,
    })

    expect(section.verdict).toBe('consistent')
    expect(section.writeModelCount).toBe(3)
    expect(section.readModelCount).toBe(3)
    expect(section.compared).toBe(3)
    expect(section.diffs).toEqual([])
    expect(section.reasons).toEqual([])
    expect(section.fallback).toEqual({ needed: false })
  })

  it('给定写模型有行但尚未投影当比对偏好看板则 inconclusive 并列出 pending 任务，不伪报一致', async () => {
    await seedShadowFixtures(target, { projectKey: PROJECT_KEY })

    const section = await compareBoardShadow(target.boards, {
      kind: 'preference',
      scope: { kind: 'global' },
      limit: 100,
    })

    expect(section.verdict).toBe('inconclusive')
    expect(section.writeModelCount).toBe(3)
    expect(section.readModelCount).toBe(0)
    expect(section.diffs).toHaveLength(3)
    expect(section.diffs.every(diff => diff.kind === 'missing-in-read-model')).toBe(true)
    expect(section.diffs.every(diff => diff.cause === 'unprojected')).toBe(true)
    expect(section.diffs.every(diff => diff.projectionTask?.status === 'pending')).toBe(true)
    expect(section.reasons.join(' ')).toContain('unprojected')
    expect(section.fallback).toEqual({ needed: true, reason: 'read-model-empty' })
  })

  it('给定空库当比对两块看板则 inconclusive 且原因是写模型为空', async () => {
    const preference = await compareBoardShadow(target.boards, {
      kind: 'preference',
      scope: { kind: 'global' },
      limit: 100,
    })
    const state = await compareBoardShadow(target.boards, {
      kind: 'state',
      scope: { kind: 'project', projectKey: PROJECT_KEY },
      limit: 100,
    })

    for (const section of [preference, state]) {
      expect(section.verdict).toBe('inconclusive')
      expect(section.writeModelCount).toBe(0)
      expect(section.readModelCount).toBe(0)
      expect(section.reasons.join(' ')).toContain('empty-write-model')
      // 空库没有走读模型回退：不能把它说成 read-model-empty。
      expect(section.fallback.needed).toBe(false)
    }
  })

  it('给定读模型标题被改坏当比对偏好看板则 divergent 并给出两侧值', async () => {
    const seeded = await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
    await drainProjections(target)
    const preference = seeded.preferences[0]
    if (preference === undefined) throw new Error('偏好夹具缺失')
    await target.db.query(
      "update omb.preference_board set title = '被改坏的标题' where entity_id = $1",
      [preference.id],
    )

    const section = await compareBoardShadow(target.boards, {
      kind: 'preference',
      scope: { kind: 'global' },
      limit: 100,
    })

    expect(section.verdict).toBe('divergent')
    const diff = section.diffs.find(item => item.entityId === preference.id)
    expect(diff).toMatchObject({ kind: 'field-drift', cause: 'divergent' })
    expect(diff?.fields).toContainEqual({
      field: 'title',
      writeModel: preference.title,
      readModel: '被改坏的标题',
    })
  })

  it('给定读模型状态与写模型漂移当比对状态看板则 divergent 且字段是 status', async () => {
    const seeded = await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
    await drainProjections(target)
    const state = seeded.states[0]
    if (state === undefined) throw new Error('状态夹具缺失')
    await target.db.query(
      "update omb.state_board set status = 'waiting' where entity_id = $1",
      [state.id],
    )

    const section = await compareBoardShadow(target.boards, {
      kind: 'state',
      scope: { kind: 'project', projectKey: PROJECT_KEY },
      limit: 100,
    })

    expect(section.verdict).toBe('divergent')
    const diff = section.diffs.find(item => item.entityId === state.id)
    expect(diff).toMatchObject({ kind: 'field-drift', cause: 'divergent' })
    expect(diff?.fields).toContainEqual({
      field: 'status',
      writeModel: state.status,
      readModel: 'waiting',
    })
  })

  it('给定读模型残留写模型已无的行当比对则 divergent 且标 extra', async () => {
    const seeded = await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
    await drainProjections(target)
    const plain = seeded.retrieval['plain-memory']
    if (plain === undefined) throw new Error('普通记忆夹具缺失')
    await target.db.query(
      `insert into omb.preference_board (entity_id, scope, title, summary, salience, revision, updated_at)
       values ($1, 'global', '残留行', '残留', 0.5, 1, now())`,
      [plain],
    )

    const section = await compareBoardShadow(target.boards, {
      kind: 'preference',
      scope: { kind: 'global' },
      limit: 100,
    })

    expect(section.verdict).toBe('divergent')
    expect(section.diffs.find(item => item.entityId === plain)).toMatchObject({
      kind: 'extra-in-read-model',
      cause: 'divergent',
    })
  })

  it('给定状态看板已投影当比对则一致且状态/项目键/事件时间逐字段相等', async () => {
    await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
    await drainProjections(target)

    const section = await compareBoardShadow(target.boards, {
      kind: 'state',
      scope: { kind: 'project', projectKey: PROJECT_KEY },
      limit: 100,
    })

    expect(section.verdict).toBe('consistent')
    expect(section.writeModelCount).toBe(3)
    expect(section.readModelCount).toBe(3)
    expect(section.compared).toBe(3)
    expect(section.diffs).toEqual([])
  })
})

describe('检索重放 shadow（真实 PostgreSQL）', () => {
  let target: ReturnType<typeof openShadowTarget>

  beforeAll(async () => {
    await migrateDatabase(DATABASE_URL)
    target = openShadowTarget(DATABASE_URL)
  })

  beforeEach(async () => {
    await resetShadowDatabase(target)
    await seedShadowFixtures(target, { projectKey: PROJECT_KEY })
  })

  afterAll(async () => {
    await resetShadowDatabase(target)
    await target.close()
  })

  it('给定 12 条查询当 recall 与计划 JSON 重放则命中/融合分/通道全部一致', async () => {
    const section = await runRetrievalShadow(target.engine, shadowQuerySpecs(PROJECT_KEY))

    expect(section.queryCount).toBe(12)
    expect(section.verdict).toBe('consistent')
    expect(section.differences).toEqual([])
    expect(section.queries.every(query => query.differences.length === 0)).toBe(true)
    expect(section.queriesWithHits).toBeGreaterThanOrEqual(10)
    // 重放必须真的覆盖到多条通道，否则“一致”只证明了空结果一致。
    expect(section.channels).toEqual(expect.arrayContaining([
      'fulltext',
      'vector',
      'state_board',
      'single_char',
      'trigger',
      'links',
    ]))
  })

  it('给定真实命中的融合分被改坏当比对则 divergent 且差异字段是 fused-score', async () => {
    const spec = shadowQuerySpecs(PROJECT_KEY).find(item => item.name === 'vector-exact')
    if (spec === undefined) throw new Error('vector-exact 查询夹具缺失')
    const direct = await target.engine.recall(spec.request)
    expect(direct.hits.length).toBeGreaterThan(0)
    const replayed = withTamperedHit(direct, hit => {
      hit.fusedScore += 0.5
    })

    const section = compareRecallResults(spec.name, spec.request.query, direct, replayed)

    expect(section.differences).toContainEqual(expect.objectContaining({
      kind: 'fused-score',
      entityId: direct.hits[0]?.entityId,
    }))
    expect(section.differences.some(difference => difference.kind === 'hit-count')).toBe(false)
  })

  it('给定真实命中的通道被改坏当比对则 divergent 且差异字段是 channels', async () => {
    const spec = shadowQuerySpecs(PROJECT_KEY).find(item => item.name === 'state-board')
    if (spec === undefined) throw new Error('state-board 查询夹具缺失')
    const direct = await target.engine.recall(spec.request)
    expect(direct.hits.length).toBeGreaterThan(0)
    const replayed = withTamperedHit(direct, hit => {
      hit.channels = []
    })

    const section = compareRecallResults(spec.name, spec.request.query, direct, replayed)

    expect(section.differences).toContainEqual(expect.objectContaining({
      kind: 'channels',
      entityId: direct.hits[0]?.entityId,
    }))
    expect(section.differences.some(difference => difference.kind === 'hit-count')).toBe(false)
  })
})

describe('shadow compare 端到端（独立可抛弃库）', () => {
  it('给定可抛弃库当运行完整比对则两块看板与 12 条检索重放一致、退出码 0、JSON 落盘', async () => {
    const jsonPath = join(tmpdir(), `omb-shadow-${randomUUID()}.json`)
    try {
      const report = await runShadowCompare({
        databaseUrl: E2E_DATABASE_URL,
        projectKey: PROJECT_KEY,
        jsonPath,
      })

      expect(report.database.disposable).toBe(true)
      expect(report.database.readOnly).toBe(false)
      expect(report.boards.map(item => item.board)).toEqual(['preference', 'state'])
      expect(report.boards.every(item => item.verdict === 'consistent')).toBe(true)
      expect(report.retrieval?.verdict).toBe('consistent')
      expect(report.retrieval?.queryCount).toBe(12)
      expect(report.verdict).toBe('consistent')
      expect(report.exitCode).toBe(0)

      const written = JSON.parse(await readFile(jsonPath, 'utf8')) as { schema: string; exitCode: number }
      expect(written.schema).toBe('omb.shadow-compare/1')
      expect(written.exitCode).toBe(0)
    } finally {
      await unlink(jsonPath).catch(() => undefined)
    }
  })

  it('给定生产库名但未声明只读当运行则拒绝连库并以退出码 1 报告原因', async () => {
    const report = await runShadowCompare({
      databaseUrl: 'postgres://omb:omb@127.0.0.1:1/omb_prod_guard',
    })

    expect(report.exitCode).toBe(1)
    expect(report.verdict).toBe('inconclusive')
    expect(report.reasons.join(' ')).toContain('database-not-disposable')
  })

  it('给定只读模式当运行则两块看板仍比对一致、检索重放明确跳过且不写业务表', async () => {
    await runShadowCompare({ databaseUrl: E2E_DATABASE_URL, projectKey: PROJECT_KEY })
    await migrateDatabase(E2E_DATABASE_URL)
    const counter = new PostgresDb({ connectionString: E2E_DATABASE_URL, max: 1 })
    const countRows = async (): Promise<Record<string, number>> => {
      const result = await counter.query<Record<string, number>>(
        `select
           (select count(*) from omb.entity)::int as entity,
           (select count(*) from omb.attribute)::int as attribute,
           (select count(*) from omb.recall_event)::int as recall_event,
           (select count(*) from omb.preference_board)::int as preference_board,
           (select count(*) from omb.state_board)::int as state_board,
           (select count(*) from omb.projection_task)::int as projection_task`,
      )
      return result.rows[0] as Record<string, number>
    }

    try {
      const before = await countRows()

      const report = await runShadowCompare({
        databaseUrl: E2E_DATABASE_URL,
        projectKey: PROJECT_KEY,
        readOnly: true,
      })

      expect(await countRows()).toEqual(before)
      expect(report.database.readOnly).toBe(true)
      expect(report.boards.every(item => item.verdict === 'consistent')).toBe(true)
      expect(report.retrieval?.skipped).toBe('read-only')
      expect(report.exitCode).toBe(0)
    } finally {
      await counter.close()
    }
  })
})
