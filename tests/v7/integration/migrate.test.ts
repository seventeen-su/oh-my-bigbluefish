import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from 'pg'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureDatabase, migrateDatabase } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import type { MigrationReport } from '../../../packages/v7/src/adapters/postgres/migrate.js'

/**
 * Phase 1 Task 6 + Phase 5b Task 20：008 expand / 009 contract 迁移 + 回填脚本的真实 PostgreSQL 回归。
 *
 * 用独立数据库（默认 `omb_v7_test_schema`），不碰生产 `omb`、也不碰其它测试共用的
 * `omb_v7_test`：
 *   1. 空库跑 001-009，再跑一次证明 runner 幂等；
 *   2. 直接重跑 008/009 SQL，证明语句自身幂等；
 *   3. 模拟已有 v7.0 库（001-007 + 老数据 + 旧审计行），证明只应用 008-011、旧列按
 *      009/011 的删除清单变化；
 *   4. 空库/已有库分别回填两次，行数与内容摘要一致，第二次 changed=0；
 *   5. 源归档后再回填，看板残留行被清理；
 *   6. 009 删 4 个零查询索引与 `audit_log.rollback_of`；011 删 P3/P1；P0/P2 保留。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/v7/src/adapters/postgres/migrations')
const BACKFILL_SCRIPT = join(REPO_ROOT, 'scripts/v7-backfill.mjs')
const TEST_DATABASE_URL =
  process.env.OMB_SCHEMA_TEST_DATABASE_URL ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test_schema'
const EXPAND_MIGRATION = '008_v7_expand.sql'
const CONTRACT_MIGRATION = '009_contract.sql'
const OUTBOX_DEAD_MIGRATION = '010_outbox_dead.sql'
const LEGACY_CONTRACT_MIGRATION = '011_contract_legacy_columns.sql'
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'
const PROJECT_KEY = 'proj-schema-test'
/** 回填测试固定批大小 1：行数 > 1 的读模型必须分多批，证明回填有界。 */
const BACKFILL_BATCH = 1

const PREF_TAGS = 'mem_11111111-1111-4111-8111-111111111111'
const PREF_LABEL = 'mem_22222222-2222-4222-8222-222222222222'
const PREF_PROJECT = 'mem_33333333-3333-4333-8333-333333333333'
const PREF_ARCHIVED = 'mem_44444444-4444-4444-8444-444444444444'
const FACT_ONLY = 'mem_55555555-5555-4555-8555-555555555555'
const STATE_BLOCKED = 'st_66666666-6666-4666-8666-666666666666'
const STATE_IN_PROGRESS = 'st_77777777-7777-4777-8777-777777777777'
const STATE_COMPLETED = 'st_88888888-8888-4888-8888-888888888888'

const NEW_TABLES = [
  'adoption_stat',
  'co_recall_pair',
  'outbox',
  'preference_board',
  'projection_task',
  'projection_watermark',
  'similar_cache',
  'state_board',
  'timer',
  'workflow_run',
  'workflow_step',
] as const

const AUDIT_EVENT_COLUMNS = [
  'actor_kind',
  'causation_id',
  'command_id',
  'correlation_id',
  'event_type',
  'hash',
  'prev_hash',
  'revision',
  'stream_id',
  'stream_version',
] as const

/** 旧 audit_log 列：001-007 的列定义；008 追加事件列、009 删 rollback_of、011 删 idempotency_key。 */
const AUDIT_LEGACY_COLUMNS = [
  'actor',
  'action',
  'after',
  'before',
  'created_at',
  'id',
  'inverse',
  'job_id',
  'rollback_of',
  'rolled_back_at',
  'target_ids',
] as const

/** 009 唯一删除的列：001 起从未写入、从未读取（回滚只写 rolled_back_at 与新审计行）。 */
const AUDIT_CONTRACT_REMOVED_COLUMNS: readonly string[] = ['rollback_of']

/** 009 删除的零查询索引：全仓没有任何 SQL 使用它们做过滤/排序。 */
const CONTRACT_REMOVED_INDEXES = [
  'attribute_expr_gin',
  'entity_view_search_trgm',
  'entity_view_triggers',
  'attr_registry_aliases',
] as const

/** 009 必须保留的索引：仍是真实查询面，或本轮不在删除清单内（删错会静默退化）。 */
const CONTRACT_KEPT_INDEXES = [
  'attribute_name',
  'audit_log_created',
  'audit_log_job_failure',
  'audit_log_target',
  'entity_view_attrs_gin',
  'entity_view_chars',
  'entity_view_search_tsv',
  'entity_view_snippet_trgm',
] as const

/** 009 明确不删、留观测窗口的列；011 会删除其中一部分。 */
const CONTRACT_KEPT_COLUMNS = [
  ['attribute', 'confidence'],
  ['attribute', 'expr'],
  ['attribute', 'source'],
  ['attr_registry', 'aliases'],
] as const

/** 011 删除的 P3/P1 列：P3 零写零读，P1 先停写后删。 */
const LEGACY_CONTRACT_REMOVED_COLUMNS = [
  ['attr_registry', 'description'],
  ['chain_member', 'role'],
  ['audit_log', 'idempotency_key'],
  ['entity_view', 'revision'],
  ['entity_view', 'confidence'],
  ['entity_view', 'pinned'],
  ['entity_view', 'salience'],
  ['entity_view', 'access_count'],
  ['entity_view', 'adoption_count'],
  ['entity_view', 'triggers'],
  ['entity_view', 'attr_names'],
  ['chain_member', 'source'],
] as const

/** P0：011 之后仍必须存在的列；删除它们会破坏公共 API 或审计语义。 */
const LEGACY_CONTRACT_KEPT_COLUMNS = [
  ['entity', 'last_accessed_at'],
  ['entity', 'version_of'],
  ['entity', 'archive_reason'],
  ['attribute', 'expr'],
  ['attribute', 'confidence'],
  ['attribute', 'source'],
  ['audit_log', 'prev_hash'],
  ['audit_log', 'hash'],
  ['audit_log', 'causation_id'],
  ['audit_log', 'revision'],
  ['audit_log', 'before'],
  ['audit_log', 'job_id'],
] as const

interface IndexExpectation {
  readonly name: string
  readonly unique?: boolean
  readonly partial?: boolean
}

/** 状态/租约/幂等键/部分 due 索引的验收清单（PLAN Task 6 + §5.3）。 */
const INDEX_EXPECTATIONS: readonly IndexExpectation[] = [
  { name: 'audit_log_command_unique', unique: true, partial: true },
  { name: 'audit_log_event_type', partial: true },
  { name: 'audit_log_stream_version_unique', unique: true, partial: true },
  { name: 'co_recall_pair_right' },
  { name: 'outbox_due', partial: true },
  { name: 'outbox_event_unique', unique: true },
  { name: 'preference_board_scope' },
  { name: 'projection_task_due', partial: true },
  { name: 'similar_cache_lookup' },
  { name: 'state_board_project' },
  { name: 'timer_dedupe_unique', unique: true, partial: true },
  { name: 'timer_due', partial: true },
  { name: 'workflow_run_due', partial: true },
  { name: 'workflow_step_running', partial: true },
]

interface BackfillProjectionStats {
  readonly fetched: number
  readonly changed: number
  readonly batches: number
  readonly pruned?: number
}

interface BackfillStats {
  readonly batchSize: number
  readonly projections: {
    readonly preference_board: BackfillProjectionStats
    readonly state_board: BackfillProjectionStats
    readonly adoption_stat: BackfillProjectionStats
    readonly co_recall_pair: BackfillProjectionStats
  }
  readonly watermarks: {
    readonly values: Record<string, string>
    readonly changed: Record<string, number>
  }
  readonly totalChanged: number
}

type DigestTable =
  | 'preference_board'
  | 'state_board'
  | 'adoption_stat'
  | 'co_recall_pair'
  | 'similar_cache'
  | 'projection_watermark'

const DIGEST_TABLES: readonly DigestTable[] = [
  'preference_board',
  'state_board',
  'adoption_stat',
  'co_recall_pair',
  'similar_cache',
  'projection_watermark',
]

interface TableDigest {
  readonly rows: number
  readonly hash: string
}

type DigestAll = Record<DigestTable, TableDigest>

interface AuditLegacyRow {
  readonly id: string
  readonly actor: string
  readonly action: string
  readonly target_ids: string[]
  readonly before: unknown
  readonly after: unknown
  readonly inverse: unknown
  readonly job_id: string | null
}

interface AuditEventColumns {
  readonly command_id: string | null
  readonly event_type: string | null
  readonly stream_id: string | null
  readonly revision: string | null
}

interface ColumnRow {
  readonly table_name: string
  readonly column_name: string
  readonly data_type: string
  readonly is_nullable: string
}

interface MigrationRow {
  readonly name: string
  readonly checksum: string
}

/** 009 前后对象快照：索引定义 + 相关表列名，用于断言“只删该删的”。 */
interface ContractSnapshot {
  readonly indexes: Map<string, string>
  readonly columns: Record<string, readonly string[]>
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort()
}

function checksumOf(name: string): string {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
  return createHash('sha256').update(sql).digest('hex')
}

async function connectClient(): Promise<Client> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5_000 })
  await client.connect()
  // 摘要里会把 timestamptz 渲染成文本；固定会话时区让两次摘要可比。
  await client.query("set timezone = 'UTC'")
  return client
}

async function resetSchema(client: Client): Promise<void> {
  await client.query('drop schema if exists omb cascade')
}

/** 模拟“已有 v7.0 库”：手动应用 001-007 并写 schema_migrations（校验和由本测试独立计算）。 */
async function applyLegacyMigrations(client: Client): Promise<void> {
  const files = migrationFiles().filter(name => name < EXPAND_MIGRATION)
  await client.query('begin')
  try {
    await client.query('create schema if not exists omb')
    await client.query(`
      create table if not exists omb.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `)
    for (const name of files) {
      await client.query(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
      await client.query('insert into omb.schema_migrations (name, checksum) values ($1, $2)', [
        name,
        checksumOf(name),
      ])
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function seedLegacyData(client: Client): Promise<void> {
  await client.query('begin')
  try {
    const entities: ReadonlyArray<{ id: string; kind: string; revision: number; salience: number; updatedAt: string }> = [
      { id: PREF_TAGS, kind: 'memory', revision: 1, salience: 0.9, updatedAt: '2026-11-20T01:00:00Z' },
      { id: PREF_LABEL, kind: 'memory', revision: 1, salience: 0.55, updatedAt: '2026-11-20T02:00:00Z' },
      { id: PREF_PROJECT, kind: 'memory', revision: 1, salience: 0.8, updatedAt: '2026-11-20T03:00:00Z' },
      { id: PREF_ARCHIVED, kind: 'memory', revision: 1, salience: 0.7, updatedAt: '2026-11-20T04:00:00Z' },
      { id: FACT_ONLY, kind: 'memory', revision: 1, salience: 0.5, updatedAt: '2026-11-20T05:00:00Z' },
      { id: STATE_BLOCKED, kind: 'state', revision: 3, salience: 0.5, updatedAt: '2026-11-21T03:00:00Z' },
      { id: STATE_IN_PROGRESS, kind: 'state', revision: 2, salience: 0.5, updatedAt: '2026-11-21T02:00:00Z' },
      { id: STATE_COMPLETED, kind: 'state', revision: 4, salience: 0.5, updatedAt: '2026-11-21T04:00:00Z' },
    ]
    for (const entity of entities) {
      await client.query(
        'insert into omb.entity (id, kind, revision, salience, updated_at) values ($1,$2,$3,$4,$5)',
        [entity.id, entity.kind, entity.revision, entity.salience, entity.updatedAt],
      )
    }

    const views: ReadonlyArray<{
      id: string
      kind: 'memory' | 'state'
      category: 'fact' | null
      scope: 'global' | 'project'
      projectKey: string
      title: string
      status: string | null
      eventTime: string | null
      attrs: Record<string, unknown>
      snippet: string
      revision: number
      updatedAt: string
      archivedAt: string | null
    }> = [
      {
        id: PREF_TAGS,
        kind: 'memory',
        category: 'fact',
        scope: 'global',
        projectKey: '',
        title: '偏好：提交前先写测试',
        status: null,
        eventTime: null,
        attrs: { title: '偏好：提交前先写测试', tags: ['偏好'], body: '先写会红的断言' },
        snippet: '偏好正文：先写会红的断言',
        revision: 1,
        updatedAt: '2026-11-20T01:00:00Z',
        archivedAt: null,
      },
      {
        id: PREF_LABEL,
        kind: 'memory',
        category: 'fact',
        scope: 'global',
        projectKey: '',
        title: '偏好：回答用中文',
        status: null,
        eventTime: null,
        attrs: { title: '偏好：回答用中文', 标签: '偏好' },
        snippet: '回答一律用中文，代码与路径保留英文',
        revision: 1,
        updatedAt: '2026-11-20T02:00:00Z',
        archivedAt: null,
      },
      {
        id: PREF_PROJECT,
        kind: 'memory',
        category: 'fact',
        scope: 'project',
        projectKey: PROJECT_KEY,
        title: '项目内偏好（不应进全局看板）',
        status: null,
        eventTime: null,
        attrs: { title: '项目内偏好', tags: ['偏好'] },
        snippet: '项目内偏好',
        revision: 1,
        updatedAt: '2026-11-20T03:00:00Z',
        archivedAt: null,
      },
      {
        id: PREF_ARCHIVED,
        kind: 'memory',
        category: 'fact',
        scope: 'global',
        projectKey: '',
        title: '已归档偏好（不应进看板）',
        status: null,
        eventTime: null,
        attrs: { title: '已归档偏好', tags: ['偏好'] },
        snippet: '已归档偏好',
        revision: 1,
        updatedAt: '2026-11-20T04:00:00Z',
        archivedAt: '2026-11-20T06:00:00Z',
      },
      {
        id: FACT_ONLY,
        kind: 'memory',
        category: 'fact',
        scope: 'global',
        projectKey: '',
        title: '普通事实',
        status: null,
        eventTime: null,
        attrs: { title: '普通事实' },
        snippet: '普通事实正文',
        revision: 1,
        updatedAt: '2026-11-20T05:00:00Z',
        archivedAt: null,
      },
      {
        id: STATE_BLOCKED,
        kind: 'state',
        category: null,
        scope: 'project',
        projectKey: PROJECT_KEY,
        title: '状态：等待迁移评审',
        status: 'blocked',
        eventTime: '2026-11-21T03:00:00Z',
        attrs: { title: '状态：等待迁移评审', status: 'blocked' },
        snippet: '等待迁移评审',
        revision: 3,
        updatedAt: '2026-11-21T03:00:00Z',
        archivedAt: null,
      },
      {
        id: STATE_IN_PROGRESS,
        kind: 'state',
        category: null,
        scope: 'project',
        projectKey: PROJECT_KEY,
        title: '状态：schema expand 进行中',
        status: 'in_progress',
        eventTime: '2026-11-21T02:00:00Z',
        attrs: { title: '状态：schema expand 进行中', status: 'in_progress' },
        snippet: 'schema expand 进行中',
        revision: 2,
        updatedAt: '2026-11-21T02:00:00Z',
        archivedAt: null,
      },
      {
        id: STATE_COMPLETED,
        kind: 'state',
        category: null,
        scope: 'project',
        projectKey: PROJECT_KEY,
        title: '状态：已完成的旧状态',
        status: 'completed',
        eventTime: '2026-11-21T04:00:00Z',
        attrs: { title: '状态：已完成的旧状态', status: 'completed' },
        snippet: '已完成的旧状态',
        revision: 4,
        updatedAt: '2026-11-21T04:00:00Z',
        archivedAt: null,
      },
    ]
    for (const view of views) {
      await client.query(
        `insert into omb.entity_view
           (entity_id, kind, category, scope, project_key, title, status, event_time, attrs, snippet,
            revision, updated_at, archived_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
        [
          view.id,
          view.kind,
          view.category,
          view.scope,
          view.projectKey,
          view.title,
          view.status,
          view.eventTime,
          JSON.stringify(view.attrs),
          view.snippet,
          view.revision,
          view.updatedAt,
          view.archivedAt,
        ],
      )
    }

    const recalls: ReadonlyArray<{
      traceId: string
      entityId: string
      channel: string
      rank: number
      injected: boolean
      injectedAt: string | null
      adoptedAt: string | null
      adoptionKind: string | null
      createdAt: string
    }> = [
      // trace-1：PREF_TAGS 两个通道、PREF_LABEL 一个通道（用于证明 adoption 按 distinct trace 计数）。
      { traceId: 'trace-1', entityId: PREF_TAGS, channel: 'fulltext', rank: 1, injected: true, injectedAt: '2026-11-22T10:00:00Z', adoptedAt: '2026-11-22T10:05:00Z', adoptionKind: 'text', createdAt: '2026-11-22T10:00:00Z' },
      { traceId: 'trace-1', entityId: PREF_TAGS, channel: 'vector', rank: 2, injected: true, injectedAt: '2026-11-22T10:00:00Z', adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T10:00:00Z' },
      { traceId: 'trace-1', entityId: PREF_LABEL, channel: 'fulltext', rank: 3, injected: true, injectedAt: '2026-11-22T10:00:00Z', adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T10:00:00Z' },
      // trace-2：PREF_LABEL 只是候选（injected=false，不进 injected 计数），STATE_BLOCKED 注入。
      { traceId: 'trace-2', entityId: PREF_TAGS, channel: 'trigger', rank: 1, injected: true, injectedAt: '2026-11-22T11:00:00Z', adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T11:00:00Z' },
      { traceId: 'trace-2', entityId: PREF_LABEL, channel: 'fulltext', rank: 2, injected: false, injectedAt: null, adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T11:00:00Z' },
      { traceId: 'trace-2', entityId: STATE_BLOCKED, channel: 'state_board', rank: 3, injected: true, injectedAt: '2026-11-22T11:00:00Z', adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T11:00:00Z' },
      // trace-3：只有一个实体，不产生共召回对。
      { traceId: 'trace-3', entityId: FACT_ONLY, channel: 'fulltext', rank: 1, injected: true, injectedAt: '2026-11-22T12:00:00Z', adoptedAt: null, adoptionKind: null, createdAt: '2026-11-22T12:00:00Z' },
    ]
    for (const recall of recalls) {
      await client.query(
        `insert into omb.recall_event
           (trace_id, session_id, turn_id, query, trigger, entity_id, channel, rank,
            raw_score, fused_score, injected, injected_at, adopted_at, adoption_kind, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          recall.traceId,
          'session-schema-test',
          'turn-1',
          'schema backfill fixture',
          'manual',
          recall.entityId,
          recall.channel,
          recall.rank,
          0.5,
          0.25,
          recall.injected,
          recall.injectedAt,
          recall.adoptedAt,
          recall.adoptionKind,
          recall.createdAt,
        ],
      )
    }

    // 旧代码写入的审计行：迁移后必须原样可读，新列保持 null。
    await client.query(
      `insert into omb.audit_log (actor, action, target_ids, before, after, inverse, job_id)
       values ('model', 'legacy-write', array[$1]::text[], '{"before":1}'::jsonb, '{"after":2}'::jsonb,
               '{"type":"restore"}'::jsonb, 'job-legacy')`,
      [PREF_TAGS],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  }
}

async function readLegacyAudit(client: Client): Promise<AuditLegacyRow> {
  const result = await client.query<AuditLegacyRow>(
    `select id::text, actor, action, target_ids, before, after, inverse, job_id
       from omb.audit_log
      where action = 'legacy-write'`,
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error('缺少旧代码写入的 audit_log 行')
  return row
}

async function readAuditEventColumns(client: Client): Promise<AuditEventColumns> {
  const result = await client.query<AuditEventColumns>(
    `select command_id, event_type, stream_id, revision::text
       from omb.audit_log
      where action = 'legacy-write'`,
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error('缺少旧代码写入的 audit_log 行')
  return row
}

async function snapshotColumns(client: Client): Promise<Record<string, string[]>> {
  const result = await client.query<ColumnRow>(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'omb'
      order by table_name, ordinal_position`,
  )
  const snapshot: Record<string, string[]> = {}
  for (const row of result.rows) {
    const signature = `${row.column_name}:${row.data_type}:${row.is_nullable}`
    const bucket = snapshot[row.table_name]
    if (bucket === undefined) snapshot[row.table_name] = [signature]
    else bucket.push(signature)
  }
  return snapshot
}

async function snapshotIndexes(client: Client): Promise<Map<string, string>> {
  const result = await client.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes where schemaname = 'omb' order by indexname`,
  )
  return new Map(result.rows.map(row => [row.indexname, row.indexdef]))
}

async function snapshotColumnNames(client: Client, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'omb' and table_name = $1
      order by ordinal_position`,
    [table],
  )
  return result.rows.map(row => row.column_name)
}

async function snapshotContract(client: Client): Promise<ContractSnapshot> {
  const indexes = await snapshotIndexes(client)
  const columns: Record<string, string[]> = {}
  for (const table of ['audit_log', 'entity_view', 'attr_registry', 'attribute', 'chain_member', 'entity'] as const) {
    columns[table] = await snapshotColumnNames(client, table)
  }
  return { indexes, columns }
}

function columnNameOf(signature: string): string {
  const separator = signature.indexOf(':')
  return separator < 0 ? signature : signature.slice(0, separator)
}

async function digestTable(client: Client, table: DigestTable): Promise<TableDigest> {
  const result = await client.query<TableDigest>(
    `select count(*)::int as rows,
            coalesce(md5(string_agg(t::text, E'\n' order by t::text)), '') as hash
       from omb.${table} t`,
  )
  const row = result.rows[0]
  if (row === undefined) throw new Error(`摘要查询没有返回行：${table}`)
  return row
}

async function digestAll(client: Client): Promise<DigestAll> {
  const digests: Partial<Record<DigestTable, TableDigest>> = {}
  for (const table of DIGEST_TABLES) digests[table] = await digestTable(client, table)
  return digests as DigestAll
}

function runBackfill(batchSize: number): Promise<BackfillStats> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [BACKFILL_SCRIPT, `--url=${TEST_DATABASE_URL}`, `--batch=${batchSize}`],
      { maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`回填脚本失败（退出码 ${String(error.code)}）：${stderr.trim() || error.message}`))
          return
        }
        try {
          resolvePromise(JSON.parse(stdout.trim()) as BackfillStats)
        } catch (parseError) {
          reject(new Error(`回填脚本输出不是 JSON：${stdout.trim()}\n${String(parseError)}`))
        }
      },
    )
  })
}

describe('OMB v7.x schema expand 与回填（真实 PostgreSQL）', () => {
  let client: Client
  let emptyFirst: MigrationReport
  let emptySecond: MigrationReport
  let emptyMigrationRows: MigrationRow[]
  let legacyColumnsBefore: Record<string, string[]>
  let legacyReport: MigrationReport
  let legacySecond: MigrationReport
  let legacyColumnsAfter: Record<string, string[]>
  let legacyAuditBefore: AuditLegacyRow
  let legacyAuditAfter: AuditLegacyRow
  let legacyAuditEventColumns: AuditEventColumns
  let emptyContract: ContractSnapshot
  let legacyContract: ContractSnapshot

  let emptyBackfillFirst: BackfillStats
  let emptyBackfillSecond: BackfillStats
  let emptyDigestFirst: DigestAll
  let emptyDigestSecond: DigestAll

  let seededBackfillFirst: BackfillStats
  let seededBackfillSecond: BackfillStats
  let seededDigestFirst: DigestAll
  let seededDigestSecond: DigestAll

  beforeAll(async () => {
    await ensureDatabase(TEST_DATABASE_URL)
    client = await connectClient()

    // --- 空库：001-009 全量，接着再跑一次 -------------------------------
    await resetSchema(client)
    emptyFirst = await migrateDatabase(TEST_DATABASE_URL)
    emptySecond = await migrateDatabase(TEST_DATABASE_URL)
    emptyContract = await snapshotContract(client)
    const emptyRows = await client.query<MigrationRow>(
      'select name, checksum from omb.schema_migrations order by name',
    )
    emptyMigrationRows = emptyRows.rows

    // --- 空库回填两次 ---------------------------------------------------
    emptyBackfillFirst = await runBackfill(BACKFILL_BATCH)
    emptyDigestFirst = await digestAll(client)
    emptyBackfillSecond = await runBackfill(BACKFILL_BATCH)
    emptyDigestSecond = await digestAll(client)

    // --- 模拟已有 v7.0 库：001-007 + 老数据 ------------------------------
    await resetSchema(client)
    await applyLegacyMigrations(client)
    await seedLegacyData(client)
    legacyColumnsBefore = await snapshotColumns(client)
    legacyAuditBefore = await readLegacyAudit(client)

    legacyReport = await migrateDatabase(TEST_DATABASE_URL)
    legacySecond = await migrateDatabase(TEST_DATABASE_URL)
    legacyColumnsAfter = await snapshotColumns(client)
    legacyContract = await snapshotContract(client)
    legacyAuditAfter = await readLegacyAudit(client)
    legacyAuditEventColumns = await readAuditEventColumns(client)

    // --- 已有库回填两次 -------------------------------------------------
    seededBackfillFirst = await runBackfill(BACKFILL_BATCH)
    seededDigestFirst = await digestAll(client)
    seededBackfillSecond = await runBackfill(BACKFILL_BATCH)
    seededDigestSecond = await digestAll(client)
  }, 180_000)

  afterAll(async () => {
    await client?.end()
  })

  it('给定空库当跑全量迁移则应用 001-009 且第二次不再重复应用', () => {
    expect(emptyFirst.applied).toEqual(migrationFiles())
    expect(emptyFirst.total).toBe(migrationFiles().length)
    expect(emptyFirst.applied).toEqual(expect.arrayContaining([EXPAND_MIGRATION, CONTRACT_MIGRATION]))
    expect(emptyFirst.applied).toContain(CONTRACT_MIGRATION)
    expect(emptyFirst.applied.at(-1)).toBe(LEGACY_CONTRACT_MIGRATION)
    expect(emptySecond.applied).toEqual([])
    expect(emptySecond.total).toBe(migrationFiles().length)
  })

  it('给定已迁移库当查 schema_migrations 则每个文件都记录了独立计算的 sha256', () => {
    expect(emptyMigrationRows.map(row => row.name)).toEqual(migrationFiles())
    for (const row of emptyMigrationRows) {
      expect(row.checksum, `${row.name} 校验和`).toBe(checksumOf(row.name))
    }
    const expand = emptyMigrationRows.find(row => row.name === EXPAND_MIGRATION)
    expect(expand?.checksum).toBe(checksumOf(EXPAND_MIGRATION))
  })

  it('给定已应用 008 当直接重跑迁移 SQL 则全部语句幂等不报错', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, EXPAND_MIGRATION), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
    // 重跑后表/列/索引仍在，且没有多出版本记录（SQL 本身不写 schema_migrations）。
    const rows = await client.query<MigrationRow>('select name, checksum from omb.schema_migrations order by name')
    expect(rows.rows.map(row => row.name)).toEqual(migrationFiles())
  })

  it('给定 009 已应用当直接重跑契约 SQL 则幂等且被删对象仍不存在', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, CONTRACT_MIGRATION), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
    await expect(client.query(sql)).resolves.toBeDefined()
    const rows = await client.query<MigrationRow>('select name, checksum from omb.schema_migrations order by name')
    expect(rows.rows.map(row => row.name)).toEqual(migrationFiles())

    const indexes = await snapshotIndexes(client)
    for (const index of CONTRACT_REMOVED_INDEXES) {
      expect(indexes.has(index), `${index} 重跑后仍应不存在`).toBe(false)
    }
    expect(await snapshotColumnNames(client, 'audit_log')).not.toContain('rollback_of')
  })

  it('给定已有 007 库当跑迁移则应用 008+009 且旧审计行与新列可空性符合预期', () => {
    expect(legacyReport.applied).toEqual([EXPAND_MIGRATION, CONTRACT_MIGRATION, OUTBOX_DEAD_MIGRATION, LEGACY_CONTRACT_MIGRATION])
    expect(legacyReport.total).toBe(migrationFiles().length)
    expect(legacySecond.applied).toEqual([])
    expect(legacyAuditAfter).toEqual(legacyAuditBefore)
    expect(legacyAuditEventColumns).toEqual({
      command_id: null,
      event_type: null,
      stream_id: null,
      revision: null,
    })
  })

  it('给定已有库迁移后则旧表列定义只保留 P0/P2，audit_log 事件列保留且 011 旧列消失', () => {
    const legacyTables = Object.keys(legacyColumnsBefore)
    for (const table of legacyTables) {
      if (['audit_log', 'entity_view', 'chain_member', 'attr_registry'].includes(table)) continue
      expect(legacyColumnsAfter[table], `${table} 的列定义不应变化`).toEqual(legacyColumnsBefore[table])
    }
    const legacyAuditColumns = legacyColumnsBefore.audit_log ?? []
    const migratedAuditColumns = legacyColumnsAfter.audit_log ?? []
    const legacyNames = legacyAuditColumns.map(columnNameOf)
    const migratedNames = migratedAuditColumns.map(columnNameOf)
    // 001 的旧列除 009/011 明确删除的列外全部保留；008 事件列仍可空。
    expect(migratedNames).toEqual(
      expect.arrayContaining([
        ...legacyNames.filter(name => !AUDIT_CONTRACT_REMOVED_COLUMNS.includes(name)),
        ...AUDIT_EVENT_COLUMNS,
      ]),
    )
    expect(migratedNames).not.toContain('rollback_of')
    expect(migratedNames).not.toContain('idempotency_key')
    // 保留下来的旧列类型/可空性必须与 001 完全一致。
    const migratedBySignature = new Map(migratedAuditColumns.map(signature => [columnNameOf(signature), signature]))
    for (const signature of legacyAuditColumns) {
      const name = columnNameOf(signature)
      if (AUDIT_CONTRACT_REMOVED_COLUMNS.includes(name) || name === 'idempotency_key') continue
      expect(migratedBySignature.get(name), `audit_log.${name} 类型/可空性不应变化`).toBe(signature)
    }
    for (const table of NEW_TABLES) {
      expect(legacyColumnsBefore[table], `${table} 应是 008 新增表`).toBeUndefined()
    }
  })

  it('给定空库/已有库跑 009 当查索引与列则只删 4 个零查询索引与 audit_log.rollback_of', () => {
    const snapshots: ReadonlyArray<readonly [string, ContractSnapshot]> = [
      ['空库', emptyContract],
      ['已有库', legacyContract],
    ]
    for (const [label, snapshot] of snapshots) {
      for (const index of CONTRACT_REMOVED_INDEXES) {
        expect(snapshot.indexes.has(index), `${label}：${index} 应被 009 删除`).toBe(false)
      }
      for (const index of CONTRACT_KEPT_INDEXES) {
        expect(snapshot.indexes.has(index), `${label}：${index} 不应被 009 删除`).toBe(true)
      }
      for (const [table, column] of CONTRACT_KEPT_COLUMNS) {
        const columns = snapshot.columns[table]
        expect(columns, `${label}：${table} 列快照缺失`).toBeDefined()
        expect(columns, `${label}：${table}.${column} 应保留`).toContain(column)
      }
      expect(snapshot.columns.audit_log, `${label}：audit_log.rollback_of 应被删除`).not.toContain('rollback_of')
    }
  })

  it('给定 011 当查列则 P3/P1 已删且 P0/P2 仍保留', () => {
    for (const [label, snapshot] of [['空库', emptyContract], ['已有库', legacyContract]] as const) {
      for (const [table, column] of LEGACY_CONTRACT_REMOVED_COLUMNS) {
        const columns = snapshot.columns[table]
        expect(columns, `${label}：${table} 列快照缺失`).toBeDefined()
        expect(columns, `${label}：${table}.${column} 应被 011 删除`).not.toContain(column)
      }
      for (const [table, column] of LEGACY_CONTRACT_KEPT_COLUMNS) {
        const columns = snapshot.columns[table]
        expect(columns, `${label}：${table} 列快照缺失`).toBeDefined()
        expect(columns, `${label}：P0 ${table}.${column} 必须保留`).toContain(column)
      }
    }
  })

  it('给定 008-011 已应用当查表/列/索引则新表、可空事件列、部分 due 索引齐全且旧列已删', async () => {
    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'omb'`,
    )
    const tableNames = tables.rows.map(row => row.table_name)
    expect(tableNames).toEqual(expect.arrayContaining([...NEW_TABLES]))

    const columns = await client.query<ColumnRow>(
      `select table_name, column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'omb' and table_name = 'audit_log'`,
    )
    const auditColumns = new Map(columns.rows.map(row => [row.column_name, row]))
    for (const name of AUDIT_LEGACY_COLUMNS) {
      if (AUDIT_CONTRACT_REMOVED_COLUMNS.includes(name)) continue
      expect(auditColumns.get(name), `audit_log.${name} 旧列应保留`).toBeDefined()
    }
    for (const name of AUDIT_CONTRACT_REMOVED_COLUMNS) {
      expect(auditColumns.get(name), `audit_log.${name} 应被 009 删除`).toBeUndefined()
    }
    for (const name of AUDIT_EVENT_COLUMNS) {
      const column = auditColumns.get(name)
      expect(column, `audit_log.${name} 新列应存在`).toBeDefined()
      expect(column?.is_nullable, `audit_log.${name} 必须可空`).toBe('YES')
    }

    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'omb'`,
    )
    const indexRows = new Map(indexes.rows.map(row => [row.indexname, row.indexdef]))
    for (const expectation of INDEX_EXPECTATIONS) {
      const definition = indexRows.get(expectation.name)
      expect(definition, `${expectation.name} 索引应存在`).toBeDefined()
      if (expectation.unique === true) expect(definition).toMatch(/create unique index/i)
      if (expectation.partial === true) expect(definition).toMatch(/\bwhere\b/i)
    }
    expect(indexRows.get('outbox_due')).toMatch(/\(status, available_at\)/i)
    expect(indexRows.get('projection_task_due')).toMatch(/\(projection, status, available_at\)/i)
    expect(indexRows.get('timer_due')).toMatch(/\(status, due_at\)/i)
    expect(indexRows.get('workflow_run_due')).toMatch(/\(status, next_run_at\)/i)

    // 关键列的类型/可空性：payload/state/input 是 jsonb，时间列是 timestamptz。
    const shape = await client.query<ColumnRow>(
      `select table_name, column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'omb' and table_name in
          ('outbox','projection_task','projection_watermark','workflow_run','workflow_step','timer',
           'preference_board','state_board','adoption_stat','co_recall_pair','similar_cache')`,
    )
    const shapeMap = new Map(shape.rows.map(row => [`${row.table_name}.${row.column_name}`, row]))
    const expected: ReadonlyArray<readonly [string, string, string]> = [
      ['outbox.event_id', 'bigint', 'NO'],
      ['outbox.payload', 'jsonb', 'NO'],
      ['outbox.available_at', 'timestamp with time zone', 'NO'],
      ['outbox.claimed_at', 'timestamp with time zone', 'YES'],
      ['projection_task.projection', 'text', 'NO'],
      ['projection_task.available_at', 'timestamp with time zone', 'NO'],
      ['projection_watermark.watermark', 'text', 'NO'],
      ['workflow_run.idempotency_key', 'text', 'NO'],
      ['workflow_run.state', 'jsonb', 'NO'],
      ['workflow_step.input', 'jsonb', 'YES'],
      ['workflow_step.output', 'jsonb', 'YES'],
      ['timer.due_at', 'timestamp with time zone', 'NO'],
      ['timer.payload', 'jsonb', 'NO'],
      ['preference_board.salience', 'real', 'NO'],
      ['preference_board.revision', 'bigint', 'NO'],
      ['state_board.status', 'text', 'NO'],
      ['adoption_stat.injected', 'integer', 'NO'],
      ['co_recall_pair.traces', 'integer', 'NO'],
      ['similar_cache.score', 'real', 'NO'],
    ]
    for (const [key, dataType, nullable] of expected) {
      const column = shapeMap.get(key)
      expect(column, `${key} 应存在`).toBeDefined()
      expect(column?.data_type, `${key} 类型`).toBe(dataType)
      expect(column?.is_nullable, `${key} 可空性`).toBe(nullable)
    }
  })

  it('给定空库当回填两次则看板/统计为空、水位为 epoch 且两次摘要一致', () => {
    expect(emptyBackfillFirst.projections.preference_board).toMatchObject({ fetched: 0, changed: 0, batches: 0 })
    expect(emptyBackfillFirst.projections.state_board).toMatchObject({ fetched: 0, changed: 0, batches: 0 })
    expect(emptyBackfillFirst.projections.adoption_stat).toMatchObject({ fetched: 0, changed: 0, batches: 0 })
    expect(emptyBackfillFirst.projections.co_recall_pair).toMatchObject({ fetched: 0, changed: 0, batches: 0 })
    expect(emptyBackfillFirst.watermarks.values).toEqual({
      preference_board: EPOCH_ISO,
      state_board: EPOCH_ISO,
      adoption_stat: EPOCH_ISO,
      co_recall_pair: EPOCH_ISO,
      similar_cache: EPOCH_ISO,
    })
    expect(emptyBackfillFirst.totalChanged).toBe(5)
    expect(emptyBackfillSecond.totalChanged).toBe(0)
    expect(emptyDigestSecond).toEqual(emptyDigestFirst)
    for (const table of ['preference_board', 'state_board', 'adoption_stat', 'co_recall_pair', 'similar_cache'] as const) {
      expect(emptyDigestFirst[table].rows, `${table} 空库应为空`).toBe(0)
    }
    expect(emptyDigestFirst.projection_watermark.rows).toBe(5)
  })

  it('给定已有数据当回填两次则看板/统计按语义回填且第二次 changed=0、摘要一致', () => {
    // 批大小 1：行数 > 1 的投影必须分多批（有界），不能一次全表写。
    expect(seededBackfillFirst.projections.preference_board).toMatchObject({ fetched: 2, changed: 2, batches: 2, pruned: 0 })
    expect(seededBackfillFirst.projections.state_board).toMatchObject({ fetched: 2, changed: 2, batches: 2, pruned: 0 })
    expect(seededBackfillFirst.projections.adoption_stat).toMatchObject({ fetched: 4, changed: 4, batches: 4 })
    expect(seededBackfillFirst.projections.co_recall_pair).toMatchObject({ fetched: 4, changed: 3, batches: 4 })
    expect(seededBackfillFirst.watermarks.changed).toEqual({
      preference_board: 1,
      state_board: 1,
      adoption_stat: 1,
      co_recall_pair: 1,
      similar_cache: 1,
    })
    expect(seededBackfillFirst.totalChanged).toBe(16)

    expect(seededBackfillSecond.projections.preference_board.changed).toBe(0)
    expect(seededBackfillSecond.projections.state_board.changed).toBe(0)
    expect(seededBackfillSecond.projections.adoption_stat.changed).toBe(0)
    expect(seededBackfillSecond.projections.co_recall_pair.changed).toBe(0)
    expect(seededBackfillSecond.totalChanged).toBe(0)
    expect(seededDigestSecond).toEqual(seededDigestFirst)

    expect(seededDigestFirst.preference_board.rows).toBe(2)
    expect(seededDigestFirst.state_board.rows).toBe(2)
    expect(seededDigestFirst.adoption_stat.rows).toBe(4)
    expect(seededDigestFirst.co_recall_pair.rows).toBe(3)
    expect(seededDigestFirst.similar_cache.rows).toBe(0)
  })

  it('给定已有数据当回填则偏好/状态看板内容与源属性一致、归档与项目偏好被排除', async () => {
    const preferences = await client.query<{
      entity_id: string
      scope: string
      title: string | null
      summary: string | null
      salience: number
      revision: string
    }>(
      `select entity_id, scope, title, summary, salience, revision::text
         from omb.preference_board order by entity_id`,
    )
    expect(preferences.rows.map(row => row.entity_id)).toEqual([PREF_TAGS, PREF_LABEL])
    expect(preferences.rows[0]).toMatchObject({
      scope: 'global',
      title: '偏好：提交前先写测试',
      summary: '偏好正文：先写会红的断言',
      revision: '1',
    })
    expect(Number(preferences.rows[0]?.salience)).toBeCloseTo(0.9, 5)
    expect(Number(preferences.rows[1]?.salience)).toBeCloseTo(0.55, 5)

    const states = await client.query<{
      entity_id: string
      project_key: string
      status: string
      revision: string
    }>(
      `select entity_id, project_key, status, revision::text
         from omb.state_board order by entity_id`,
    )
    expect(states.rows).toEqual([
      { entity_id: STATE_BLOCKED, project_key: PROJECT_KEY, status: 'blocked', revision: '3' },
      { entity_id: STATE_IN_PROGRESS, project_key: PROJECT_KEY, status: 'in_progress', revision: '2' },
    ])

    // 水位来自源数据 high-water：entity.updated_at 最大值 / recall_event.created_at 最大值。
    expect(seededBackfillFirst.watermarks.values).toEqual({
      preference_board: '2026-11-21T04:00:00.000Z',
      state_board: '2026-11-21T04:00:00.000Z',
      adoption_stat: '2026-11-22T12:00:00.000Z',
      co_recall_pair: '2026-11-22T12:00:00.000Z',
      similar_cache: '2026-11-21T04:00:00.000Z',
    })
  })

  it('给定同一 trace 多通道/未注入候选当回填统计则 adoption 按 distinct trace、co-recall 按 distinct 实体', async () => {
    const adoption = await client.query<{
      entity_id: string
      injected: number
      adopted: number
      last_adopted_at: Date | null
    }>(
      `select entity_id, injected, adopted, last_adopted_at
         from omb.adoption_stat order by entity_id`,
    )
    expect(adoption.rows).toEqual([
      { entity_id: PREF_TAGS, injected: 2, adopted: 1, last_adopted_at: new Date('2026-11-22T10:05:00Z') },
      { entity_id: PREF_LABEL, injected: 1, adopted: 0, last_adopted_at: null },
      { entity_id: FACT_ONLY, injected: 1, adopted: 0, last_adopted_at: null },
      { entity_id: STATE_BLOCKED, injected: 1, adopted: 0, last_adopted_at: null },
    ])

    const pairs = await client.query<{ left_id: string; right_id: string; traces: number }>(
      `select left_id, right_id, traces from omb.co_recall_pair order by left_id, right_id`,
    )
    expect(pairs.rows).toEqual([
      { left_id: PREF_TAGS, right_id: PREF_LABEL, traces: 2 },
      { left_id: PREF_TAGS, right_id: STATE_BLOCKED, traces: 1 },
      { left_id: PREF_LABEL, right_id: STATE_BLOCKED, traces: 1 },
    ])
  })

  it('给定偏好源后来被归档当再回填则看板残留行被清理且不改其它读模型', async () => {
    await client.query('update omb.entity_view set archived_at = $1 where entity_id = $2', [
      '2026-11-23T00:00:00Z',
      PREF_LABEL,
    ])
    const archivedBackfill = await runBackfill(BACKFILL_BATCH)
    const archivedDigest = await digestAll(client)

    // 归档行不再被 fetch（源条件已不匹配），但看板里的旧行必须被 prune 掉。
    expect(archivedBackfill.projections.preference_board).toMatchObject({ fetched: 1, changed: 0, pruned: 1 })
    expect(archivedBackfill.totalChanged).toBe(1)
    expect(archivedDigest.preference_board.rows).toBe(1)
    expect(archivedDigest.state_board).toEqual(seededDigestSecond.state_board)
    expect(archivedDigest.adoption_stat).toEqual(seededDigestSecond.adoption_stat)
    expect(archivedDigest.co_recall_pair).toEqual(seededDigestSecond.co_recall_pair)
    expect(archivedDigest.similar_cache).toEqual(seededDigestSecond.similar_cache)
  })
})
