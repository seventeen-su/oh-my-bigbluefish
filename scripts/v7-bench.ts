#!/usr/bin/env node
/**
 * OMB v7 检索/写入基准。
 *
 * 默认在独立库 omb_v7_bench 造 10 万记忆 + 1 万链接 + 10 万向量，再用真实
 * PostgresStore + RecallEngine 跑检索和写入。可用环境变量缩小夹具调试：
 *   OMB_BENCH_ENTITIES=1000 OMB_BENCH_LINKS=100 OMB_BENCH_ITERATIONS=10
 * 复用已造好的夹具：OMB_BENCH_REUSE=1
 *
 * 只有达到 SPEC 的 10 万/1 万夹具时才判定 p95 预算，避免小夹具假通过。
 */
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import type { WriteEntityInput } from '../packages/v7/src/domain/entity.js'
import { newId } from '../packages/v7/src/domain/ids.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../packages/v7/src/domain/validation.js'
import { systemCommandMeta } from '../packages/v7/src/app/commands/index.js'
import { HashEmbedder } from '../packages/v7/src/adapters/embedding/hash.js'
import { migrateDatabase, truncateAll } from '../packages/v7/src/adapters/postgres/migrate.js'
import { databaseNameOf, isDisposableDatabaseName } from '../packages/v7/src/security/trust.js'
import { PostgresDb } from '../packages/v7/src/adapters/postgres/db.js'
import { PostgresStore } from '../packages/v7/src/adapters/postgres/store.js'
import { AttributeWriter } from '../packages/v7/src/adapters/postgres/writer.js'
import { RecallEngine } from '../packages/v7/src/retrieval/engine.js'
import type { Clock } from '../packages/v7/src/ports/clock.js'
import type { Store } from '../packages/v7/src/ports/store.js'

const URL = process.env.OMB_BENCH_DATABASE_URL ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_bench'
// 显式声明破坏性用途（truncateAll 守卫，ADR-0010）：只有库名命中 test/bench 段才允许；
// 生产库名（如 omb）即使设置了该 flag 也会在连接前被拒绝。
const benchDatabaseName = databaseNameOf(URL)
if (benchDatabaseName !== undefined && isDisposableDatabaseName(benchDatabaseName)) {
  process.env.OMB_ALLOW_DESTRUCTIVE ??= '1'
}
const ENTITIES = positiveInt(process.env.OMB_BENCH_ENTITIES, 100_000)
const LINKS = positiveInt(process.env.OMB_BENCH_LINKS, 10_000)
const ITERATIONS = positiveInt(process.env.OMB_BENCH_ITERATIONS, 100)
const WRITES = positiveInt(process.env.OMB_BENCH_WRITES, 200)
const REUSE = process.env.OMB_BENCH_REUSE === '1'
/** 逐 store 方法的耗时诊断（默认关闭，不影响 p95 判定）。 */
const DIAG = process.env.OMB_BENCH_DIAG === '1'
const FULL_SCALE = ENTITIES >= 100_000 && LINKS >= 10_000
const STAGE_ONE_BUDGET_MS = 150
const TOTAL_BUDGET_MS = 300
/** ADR-0013：写事务本体 p95 ≤20ms；含写后相似建议 p95 ≤50ms（100k/10k 夹具）。 */
const WRITE_TXN_BUDGET_MS = 20
const WRITE_BUDGET_MS = 50
const FIXED_NOW = '2026-11-23T00:00:00.000Z'

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`环境变量必须是正整数：${raw}`)
  return parsed
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
}

function format(value: number): string {
  return value.toFixed(2)
}

/**
 * 逐通道诊断：把 Store 读方法包一层计时，用来定位阶段一 p95 落在哪个查询上。
 * 只记录方法名与耗时，不改变任何查询语义；`OMB_BENCH_DIAG=1` 才启用。
 */
const DIAG_METHODS = [
  'triggers',
  'fulltext',
  'singleChar',
  'vector',
  'time',
  'stateBoard',
  'summaries',
  'get',
  'expand',
  'recordRecall',
  'markAccessed',
] as const

function instrumentStore(store: Store, sink: (method: string, ms: number) => void): Store {
  const tracked = new Set<string>(DIAG_METHODS)
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof property !== 'string' || typeof value !== 'function' || !tracked.has(property)) {
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(receiver) : value
      }
      const method = value as (...args: unknown[]) => unknown
      return (...args: unknown[]): unknown => {
        const started = performance.now()
        return Promise.resolve(method.apply(target, args)).finally(() => {
          sink(property, performance.now() - started)
        })
      }
    },
  })
}

function reportDiagnostics(samples: ReadonlyMap<string, number[]>): void {
  for (const method of DIAG_METHODS) {
    const values = samples.get(method)
    if (values === undefined || values.length === 0) continue
    console.log(
      `[bench][diag] store.${method} calls=${values.length} p50=${format(percentile(values, 0.5))}ms p95=${format(percentile(values, 0.95))}ms max=${format(Math.max(...values))}ms`,
    )
  }
}

async function seed(): Promise<void> {
  await migrateDatabase(URL)
  if (!REUSE) {
    await truncateAll(URL)
    const db = new PostgresDb({ connectionString: URL, statementTimeoutMs: 600_000, max: 2 })
    try {
      console.log(`[bench] 造夹具 entities=${ENTITIES} links=${LINKS}（首次可能较慢）`)
      await db.query(
        `insert into omb.entity (id, kind, revision, origin, salience, is_current)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'memory', 1, 'bench', 0.5, true
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attribute (entity_id, name, ordinal, value_kind, value, is_required, source)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'id', 0, 'static',
                to_jsonb('mem_bench_' || lpad(i::text, 6, '0')), true, 'bench'
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attribute (entity_id, name, ordinal, value_kind, value, is_required, source)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'scope', 0, 'static',
                '{"kind":"global"}'::jsonb, true, 'bench'
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attribute (entity_id, name, ordinal, value_kind, value, is_required, source)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'category', 0, 'static',
                to_jsonb('fact'::text), true, 'bench'
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attribute (entity_id, name, ordinal, value_kind, value, is_required, source)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'title', 0, 'static',
                to_jsonb('基准记忆 ' || i), false, 'bench'
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attribute (entity_id, name, ordinal, value_kind, value, is_required, source)
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'body', 0, 'static',
                to_jsonb('性能测试正文 ' || i), false, 'bench'
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.attr_registry (name, usage_count, first_seen, last_seen)
         values ('title', $1, now(), now()), ('body', $1, now(), now())
         on conflict (name) do update set usage_count = excluded.usage_count, last_seen = now()`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.entity_view (
           entity_id, kind, category, scope, project_key, title, status, event_time,
           attrs, search_text, snippet, chars, is_current, archived_at, updated_at
         )
         select 'mem_bench_' || lpad(i::text, 6, '0'), 'memory', 'fact', 'global', '',
                '基准记忆 ' || i, null, null,
                jsonb_build_object('title', '基准记忆 ' || i, 'body', '性能测试正文 ' || i),
                '基 基准 准 准记 记 记忆 忆 ' || i,
                '基准记忆 ' || i || ' 性能测试正文 ' || i,
                array['基', '准', '记', '忆', '性', '能', '测', '试'],
                true, null, now()
         from generate_series(1, $1) as i`,
        [ENTITIES],
      )
      await db.query(
        `insert into omb.link (id, from_id, to_id, relation, directed, strength, source, origin)
         select 'lnk_bench_' || lpad(i::text, 6, '0'),
                'mem_bench_' || lpad((i % $1 + 1)::text, 6, '0'),
                'mem_bench_' || lpad(((i * 7) % $1 + 1)::text, 6, '0'),
                'related_to', true, 0.5, 'bench', 'bench'
         from generate_series(1, $2) as i
         where (i % $1 + 1) <> ((i * 7) % $1 + 1)`,
        [ENTITIES, LINKS],
      )
      await db.query('drop index if exists omb.embedding_hnsw')
      await db.query(
        `insert into omb.embedding (entity_id, model, dims, embedding)
         select id, 'bench-hash-512', 512,
                array_fill(((i % 100)::double precision / 100.0), array[512])::vector(512)
         from (
           select id, row_number() over (order by id) as i
           from omb.entity where id like 'mem_bench_%'
         ) as rows`,
      )
      await db.query(
        `create index embedding_hnsw on omb.embedding using hnsw (embedding vector_cosine_ops)
         with (m = 16, ef_construction = 64)`,
      )
      await db.query('analyze omb.entity')
      await db.query('analyze omb.entity_view')
      await db.query('analyze omb.embedding')
      await db.query('analyze omb.link')
    } finally {
      await db.close()
    }
  }
}

function clock(): Clock {
  return { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }
}

async function main(): Promise<void> {
  await seed()
  const db = new PostgresDb({ connectionString: URL })
  const counts = await db.query<{ entities: string; links: string; embeddings: string }>(
    `select
       (select count(*)::text from omb.entity where id like 'mem_bench_%') as entities,
       (select count(*)::text from omb.link where id like 'lnk_bench_%') as links,
       (select count(*)::text from omb.embedding e join omb.entity n on n.id = e.entity_id where n.id like 'mem_bench_%') as embeddings`,
  )
  await db.close()
  const fixture = counts.rows[0]
  const actualEntities = Number(fixture?.entities ?? '0')
  const actualLinks = Number(fixture?.links ?? '0')
  const actualEmbeddings = Number(fixture?.embeddings ?? '0')
  console.log(`[bench] fixtures entities=${actualEntities} links=${actualLinks} embeddings=${actualEmbeddings}`)
  if (actualEntities < ENTITIES || actualLinks < LINKS) {
    throw new Error(`夹具不完整：期望 entities>=${ENTITIES} links>=${LINKS}`)
  }

  const store = new PostgresStore(URL)
  const writer = new AttributeWriter(store.db)
  const diagSamples = new Map<string, number[]>()
  const engineStore = DIAG
    ? instrumentStore(store, (method, ms) => {
      const values = diagSamples.get(method) ?? []
      values.push(ms)
      diagSamples.set(method, values)
    })
    : store
  const engine = new RecallEngine({ store: engineStore, embedder: new HashEmbedder(), clock: clock() })
  const query = '基准记忆 42'
  const recall = { query, scenario: 'manual' as const, scope: 'global' as const, limit: 10 }

  for (let i = 0; i < 10; i += 1) await engine.recall(recall)
  const stageOne: number[] = []
  const totals: number[] = []
  let hits = 0
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now()
    const result = await engine.recall(recall)
    const wall = performance.now() - started
    stageOne.push(result.timings?.stageOneMs ?? wall)
    totals.push(result.timings?.totalMs ?? wall)
    hits += result.hits.length
  }
  if (DIAG) reportDiagnostics(diagSamples)
  if (DIAG) console.log(`[bench][diag] stage1 series(ms)=${stageOne.map(value => value.toFixed(0)).join(',')}`)

  const normalized = normalizeWrite({
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title: '基准写入记忆', body: 'write probe' },
  })
  if (!normalized.ok) throw new Error(`基准写入输入非法：${JSON.stringify(normalized.errors)}`)
  const writeInput: WriteEntityInput = {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'global' },
    attrs: { title: '基准写入记忆', body: 'write probe' },
  }
  const buildWrite = (body: string): ReturnType<typeof normalizeWrite> => normalizeWrite({
    ...writeInput,
    id: newId('memory'),
    attrs: { ...writeInput.attrs, body },
  })
  // 写事务本体（不含相似建议）：ADR-0013 预算 p95 ≤20ms。
  const txnTimes: number[] = []
  for (let i = 0; i < WRITES; i += 1) {
    const value = buildWrite(`txn probe ${i}`)
    if (!value.ok) throw new Error(`基准写入输入非法：${JSON.stringify(value.errors)}`)
    const started = performance.now()
    await writer.execute({ type: 'CreateEntity', input: value.value }, systemCommandMeta('bench'))
    txnTimes.push(performance.now() - started)
  }
  // 旧 Store.write 入口（事务 + 写后相似建议）：包含有界索引相似查询的开销。
  const writeTimes: number[] = []
  for (let i = 0; i < WRITES; i += 1) {
    const value = buildWrite(`write probe ${i}`)
    if (!value.ok) throw new Error(`基准写入输入非法：${JSON.stringify(value.errors)}`)
    const derived = {
      searchText: deriveSearchText(value.value.attributes),
      triggers: deriveTriggers(value.value.attributes),
    }
    const started = performance.now()
    await store.write(value.value, derived)
    writeTimes.push(performance.now() - started)
  }

  const stageOneP50 = percentile(stageOne, 0.5)
  const stageOneP95 = percentile(stageOne, 0.95)
  const totalP50 = percentile(totals, 0.5)
  const totalP95 = percentile(totals, 0.95)
  const txnP50 = percentile(txnTimes, 0.5)
  const txnP95 = percentile(txnTimes, 0.95)
  const writeP50 = percentile(writeTimes, 0.5)
  const writeP95 = percentile(writeTimes, 0.95)

  console.log(`[bench] recall iterations=${ITERATIONS} hits=${hits} stage1 p50=${format(stageOneP50)}ms p95=${format(stageOneP95)}ms total p50=${format(totalP50)}ms p95=${format(totalP95)}ms`)
  console.log(`[bench] write-txn iterations=${WRITES} p50=${format(txnP50)}ms p95=${format(txnP95)}ms`)
  console.log(`[bench] write iterations=${WRITES} p50=${format(writeP50)}ms p95=${format(writeP95)}ms`)
  console.log(`[bench] budget stage1 p95<=${STAGE_ONE_BUDGET_MS}ms total p95<=${TOTAL_BUDGET_MS}ms writeTxn p95<=${WRITE_TXN_BUDGET_MS}ms write p95<=${WRITE_BUDGET_MS}ms fullScale=${FULL_SCALE}`)

  await store.close()
  const recallOverBudget = stageOneP95 > STAGE_ONE_BUDGET_MS || totalP95 > TOTAL_BUDGET_MS
  const writeOverBudget = txnP95 > WRITE_TXN_BUDGET_MS || writeP95 > WRITE_BUDGET_MS
  if (FULL_SCALE && (recallOverBudget || writeOverBudget)) {
    if (recallOverBudget) console.error('[bench] FAIL：检索 p95 超过 SPEC 第 11 节预算')
    if (writeOverBudget) console.error('[bench] FAIL：写入 p95 超过 ADR-0013 预算')
    process.exitCode = 1
    return
  }
  console.log('[bench] PASS')
}

main().catch(error => {
  console.error(`[bench] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
