#!/usr/bin/env node
/**
 * OMB v7.x Phase 1 回填：outbox/投影时代的初始读模型。
 *
 * 只做四件事（全部可重复执行，重复跑不会改内容）：
 *   1. 从 `entity_view` 回填 `preference_board` / `state_board`；
 *   2. 从 `recall_event` 回填 `adoption_stat` / `co_recall_pair`（无事件则保持空）；
 *   3. 清理源已归档/不再符合条件的看板残留行；
 *   4. 写入 `projection_watermark` 初始水位（空库用 epoch，避免 worker 把“未初始化”当全量）。
 *
 * 纪律（对应 PLAN Task 6 / ARCHITECTURE-PLAN §4.4）：
 * * 有界：所有读取按 `entity_id` keyset + `limit` 分页，每页单独事务提交；
 *   不持有跨表长事务，不 `LOCK TABLE`，不做全表写锁。
 * * 可重复：写入用 upsert + `IS DISTINCT FROM` 守卫，第二遍 `changed=0`；
 *   归档/取消归档以“源是否存在”为准清理，不残留旧看板行。
 * * 不轮询：没有 setInterval/setTimeout，只有有限批次的顺序循环。
 *
 * 用法：
 *   node scripts/v7-backfill.mjs [--url=postgres://...] [--batch=500]
 *   OMB_DATABASE_URL=... OMB_BACKFILL_BATCH=500 node scripts/v7-backfill.mjs
 * 输出：stdout 一行 JSON 统计（供测试/运维比对）；进度与错误写 stderr。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const DEFAULT_DATABASE_URL = 'postgres://omb:omb@127.0.0.1:5432/omb'
const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 5_000
/** 空库初始水位：固定 epoch，保证空库两次回填摘要一致。 */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

/** T0 偏好 = 全局记忆中 `tags` 含“偏好”或 `标签=偏好`（与 store.preferenceSummaries 同义）。 */
const PREFERENCE_PREDICATE = `(v.attrs @> '{"tags":["偏好"]}'::jsonb or v.attrs->>'标签' = '偏好')`

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`回填批大小必须是正整数，收到：${String(value)}`)
  }
  return Math.min(parsed, MAX_BATCH_SIZE)
}

function parseArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined || !argument.startsWith('--')) continue
    const body = argument.slice(2)
    const separator = body.indexOf('=')
    if (separator >= 0) {
      options.set(body.slice(0, separator), body.slice(separator + 1))
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options.set(body, next)
      index += 1
    } else {
      options.set(body, '')
    }
  }
  return options
}

async function assertSchemaReady(client) {
  const result = await client.query(
    `select 1 from information_schema.tables
      where table_schema = 'omb' and table_name = 'projection_watermark'`,
  )
  if (result.rowCount === 0) {
    throw new Error('缺少 omb.projection_watermark：请先执行 pnpm v7:db:setup 应用 008_v7_expand.sql')
  }
}

/**
 * 通用 keyset 分页：每页一个新事务，`applyPage` 返回实际写入/更新行数。
 * 游标始终是最后一行的 `entity_id`，页面按 `entity_id asc` 排序。
 */
async function runBatches(client, { fetchPage, applyPage, batchSize }) {
  let after = ''
  const stats = { fetched: 0, changed: 0, batches: 0 }
  for (;;) {
    const rows = await fetchPage(client, after, batchSize)
    if (rows.length === 0) break
    await client.query('begin')
    let changed = 0
    try {
      changed = await applyPage(client, rows)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    }
    stats.fetched += rows.length
    stats.changed += changed
    stats.batches += 1
    after = rows[rows.length - 1].entity_id
    if (rows.length < batchSize) break
  }
  return stats
}

// ---------------------------------------------------------------------------
// preference_board
// ---------------------------------------------------------------------------
async function fetchPreferencePage(client, after, limit) {
  const result = await client.query(
    `select v.entity_id, v.scope, v.title, v.snippet as summary, e.salience, e.revision, v.updated_at
       from omb.entity_view v
       join omb.entity e on e.id = v.entity_id
      where v.kind = 'memory' and v.scope = 'global'
        and v.archived_at is null and v.is_current
        and ${PREFERENCE_PREDICATE}
        and v.entity_id > $1
      order by v.entity_id
      limit $2`,
    [after, limit],
  )
  return result.rows
}

async function applyPreferenceBoard(client, rows) {
  const result = await client.query(
    `insert into omb.preference_board as pb
       (entity_id, scope, title, summary, salience, revision, updated_at)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::real[], $6::bigint[], $7::timestamptz[]
     )
     on conflict (entity_id) do update
        set scope = excluded.scope,
            title = excluded.title,
            summary = excluded.summary,
            salience = excluded.salience,
            revision = excluded.revision,
            updated_at = excluded.updated_at
      where (pb.scope, pb.title, pb.summary, pb.salience, pb.revision, pb.updated_at)
        is distinct from
            (excluded.scope, excluded.title, excluded.summary, excluded.salience,
             excluded.revision, excluded.updated_at)`,
    [
      rows.map(row => row.entity_id),
      rows.map(row => row.scope),
      rows.map(row => row.title ?? null),
      rows.map(row => row.summary ?? null),
      rows.map(row => row.salience),
      rows.map(row => String(row.revision)),
      rows.map(row => row.updated_at),
    ],
  )
  return result.rowCount ?? 0
}

async function prunePreferenceBoard(client) {
  const result = await client.query(
    `delete from omb.preference_board pb
      where not exists (
        select 1
          from omb.entity_view v
         where v.entity_id = pb.entity_id
           and v.kind = 'memory' and v.scope = 'global'
           and v.archived_at is null and v.is_current
           and ${PREFERENCE_PREDICATE}
      )`,
  )
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// state_board
// ---------------------------------------------------------------------------
async function fetchStatePage(client, after, limit) {
  const result = await client.query(
    `select v.entity_id, v.project_key, v.title, v.status, v.event_time, e.revision, v.updated_at
       from omb.entity_view v
       join omb.entity e on e.id = v.entity_id
      where v.kind = 'state' and v.scope = 'project'
        and v.archived_at is null and v.is_current
        and v.status in ('in_progress', 'blocked', 'waiting')
        and v.entity_id > $1
      order by v.entity_id
      limit $2`,
    [after, limit],
  )
  return result.rows
}

async function applyStateBoard(client, rows) {
  const result = await client.query(
    `insert into omb.state_board as sb
       (entity_id, project_key, title, status, event_time, revision, updated_at)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::bigint[], $7::timestamptz[]
     )
     on conflict (entity_id) do update
        set project_key = excluded.project_key,
            title = excluded.title,
            status = excluded.status,
            event_time = excluded.event_time,
            revision = excluded.revision,
            updated_at = excluded.updated_at
      where (sb.project_key, sb.title, sb.status, sb.event_time, sb.revision, sb.updated_at)
        is distinct from
            (excluded.project_key, excluded.title, excluded.status, excluded.event_time,
             excluded.revision, excluded.updated_at)`,
    [
      rows.map(row => row.entity_id),
      rows.map(row => row.project_key),
      rows.map(row => row.title ?? null),
      rows.map(row => row.status),
      rows.map(row => row.event_time ?? null),
      rows.map(row => String(row.revision)),
      rows.map(row => row.updated_at),
    ],
  )
  return result.rowCount ?? 0
}

async function pruneStateBoard(client) {
  const result = await client.query(
    `delete from omb.state_board sb
      where not exists (
        select 1
          from omb.entity_view v
         where v.entity_id = sb.entity_id
           and v.kind = 'state' and v.scope = 'project'
           and v.archived_at is null and v.is_current
           and v.status in ('in_progress', 'blocked', 'waiting')
      )`,
  )
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// adoption_stat（计数按 distinct trace，避免一个 trace 多通道/多排名行放大）
// ---------------------------------------------------------------------------
async function fetchAdoptionPage(client, after, limit) {
  const result = await client.query(
    `select entity_id,
            count(distinct trace_id) filter (where injected)::int as injected,
            count(distinct trace_id) filter (where adopted_at is not null)::int as adopted,
            max(adopted_at) as last_adopted_at,
            greatest(max(created_at), max(injected_at), max(adopted_at)) as updated_at
       from omb.recall_event
      where entity_id > $1
      group by entity_id
      order by entity_id
      limit $2`,
    [after, limit],
  )
  return result.rows
}

async function applyAdoptionStat(client, rows) {
  const result = await client.query(
    `insert into omb.adoption_stat as a (entity_id, injected, adopted, last_adopted_at, updated_at)
     select * from unnest($1::text[], $2::int[], $3::int[], $4::timestamptz[], $5::timestamptz[])
     on conflict (entity_id) do update
        set injected = excluded.injected,
            adopted = excluded.adopted,
            last_adopted_at = excluded.last_adopted_at,
            updated_at = excluded.updated_at
      where (a.injected, a.adopted, a.last_adopted_at, a.updated_at)
        is distinct from
            (excluded.injected, excluded.adopted, excluded.last_adopted_at, excluded.updated_at)`,
    [
      rows.map(row => row.entity_id),
      rows.map(row => row.injected),
      rows.map(row => row.adopted),
      rows.map(row => row.last_adopted_at ?? null),
      rows.map(row => row.updated_at),
    ],
  )
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// co_recall_pair：以 left_id 为游标，一条 left 的完整共召回集合一次算全。
// 重复跑时同一 pair 用重算值覆盖（`traces` 不累加），因此结果与运行次数无关。
// ---------------------------------------------------------------------------
async function fetchCoRecallPage(client, after, limit) {
  const result = await client.query(
    `select distinct entity_id
       from omb.recall_event
      where entity_id > $1
      order by entity_id
      limit $2`,
    [after, limit],
  )
  return result.rows
}

async function applyCoRecallPair(client, rows) {
  const leftIds = rows.map(row => row.entity_id)
  const result = await client.query(
    `with pairs as (
       select a.entity_id as left_id,
              b.entity_id as right_id,
              count(distinct a.trace_id)::int as traces,
              max(greatest(a.created_at, b.created_at)) as last_seen_at
         from omb.recall_event a
         join omb.recall_event b
           on b.trace_id = a.trace_id and b.entity_id > a.entity_id
        where a.entity_id = any($1::text[])
        group by a.entity_id, b.entity_id
     )
     insert into omb.co_recall_pair as p (left_id, right_id, traces, last_seen_at)
     select left_id, right_id, traces, last_seen_at from pairs
     on conflict (left_id, right_id) do update
        set traces = excluded.traces,
            last_seen_at = greatest(p.last_seen_at, excluded.last_seen_at)
      where (p.traces, p.last_seen_at)
        is distinct from (excluded.traces, greatest(p.last_seen_at, excluded.last_seen_at))`,
    [leftIds],
  )
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// 水位
// ---------------------------------------------------------------------------
async function scalarTimestamp(client, sql) {
  const result = await client.query(sql)
  const value = result.rows[0]?.ts
  if (value === null || value === undefined) return EPOCH_ISO
  return new Date(value).toISOString()
}

async function sourceWatermarks(client) {
  const entity = await scalarTimestamp(client, 'select max(updated_at) as ts from omb.entity')
  const recall = await scalarTimestamp(client, 'select max(created_at) as ts from omb.recall_event')
  return { entity, recall }
}

async function writeWatermark(client, projection, watermark) {
  const result = await client.query(
    `insert into omb.projection_watermark (projection, watermark, updated_at)
     values ($1, $2, now())
     on conflict (projection) do update
        set watermark = excluded.watermark, updated_at = now()
      where omb.projection_watermark.watermark is distinct from excluded.watermark`,
    [projection, watermark],
  )
  return result.rowCount ?? 0
}

/**
 * 回填主入口。可被测试直接调用（传入自己的连接串/批大小），也可由 CLI 执行。
 * 返回稳定形状的统计：每项 `changed` 在数据未变时第二次运行应为 0。
 */
export async function backfill(options = {}) {
  const connectionString = options.connectionString ?? process.env.OMB_DATABASE_URL ?? DEFAULT_DATABASE_URL
  const batchSize = normalizeBatchSize(
    options.batchSize ?? process.env.OMB_BACKFILL_BATCH ?? DEFAULT_BATCH_SIZE,
  )
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: 'omb-v7-backfill',
  })
  await client.connect()
  try {
    await assertSchemaReady(client)

    const preference = await runBatches(client, {
      fetchPage: fetchPreferencePage,
      applyPage: applyPreferenceBoard,
      batchSize,
    })
    const preferencePruned = await prunePreferenceBoard(client)

    const state = await runBatches(client, {
      fetchPage: fetchStatePage,
      applyPage: applyStateBoard,
      batchSize,
    })
    const statePruned = await pruneStateBoard(client)

    const adoption = await runBatches(client, {
      fetchPage: fetchAdoptionPage,
      applyPage: applyAdoptionStat,
      batchSize,
    })

    const coRecall = await runBatches(client, {
      fetchPage: fetchCoRecallPage,
      applyPage: applyCoRecallPair,
      batchSize,
    })

    // 数据写完后才推进水位：中途崩溃时水位仍停在旧值，重跑会继续覆盖（不丢数据）。
    const watermarks = await sourceWatermarks(client)
    const watermarkValues = {
      preference_board: watermarks.entity,
      state_board: watermarks.entity,
      adoption_stat: watermarks.recall,
      co_recall_pair: watermarks.recall,
      // similar_cache 由写后异步任务维护；回填只建立水位，不生成候选。
      similar_cache: watermarks.entity,
    }
    const watermarkChanges = {}
    for (const [projection, watermark] of Object.entries(watermarkValues)) {
      watermarkChanges[projection] = await writeWatermark(client, projection, watermark)
    }

    const totalChanged =
      preference.changed +
      preferencePruned +
      state.changed +
      statePruned +
      adoption.changed +
      coRecall.changed +
      Object.values(watermarkChanges).reduce((sum, value) => sum + value, 0)

    return {
      batchSize,
      projections: {
        preference_board: { ...preference, pruned: preferencePruned },
        state_board: { ...state, pruned: statePruned },
        adoption_stat: adoption,
        co_recall_pair: coRecall,
      },
      watermarks: { values: watermarkValues, changed: watermarkChanges },
      totalChanged,
    }
  } finally {
    await client.end().catch(() => {})
  }
}

const USAGE = `用法：node scripts/v7-backfill.mjs [--url=<postgres 连接串>] [--batch=<正整数>]
环境变量：OMB_DATABASE_URL、OMB_BACKFILL_BATCH
输出：stdout 一行 JSON 统计`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.has('help')) {
    process.stderr.write(`${USAGE}\n`)
    return
  }
  const stats = await backfill({
    connectionString: options.get('url') ?? process.env.OMB_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    batchSize: options.get('batch') ?? process.env.OMB_BACKFILL_BATCH ?? DEFAULT_BATCH_SIZE,
  })
  process.stdout.write(`${JSON.stringify(stats)}\n`)
}

function isMainModule() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMainModule()) {
  main().catch(error => {
    process.stderr.write(`[v7:backfill] 失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
