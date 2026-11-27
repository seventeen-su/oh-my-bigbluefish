import pg from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  PROJECTION_NAMES,
  projectionOfBoard,
  type BoardItem,
  type BoardKind,
  type BoardQuery,
  type BoardReader,
  type ClaimedProjectionTask,
  type ProjectionClaimOptions,
  type ProjectionEnqueueInput,
  type ProjectionEnqueueResult,
  type ProjectionFailureInput,
  type ProjectionLag,
  type ProjectionName,
  type ProjectionOutcome,
  type ProjectionProjector,
  type ProjectionTask,
  type ProjectionTaskState,
  type ProjectionTaskStatus,
  type ProjectionTaskStore,
  type ProjectionTransaction,
  type ProjectionWakeSource,
  type ProjectionWatermark,
} from '../../app/projections/index.js'
import {
  attributeValue,
  isArchived,
  scopeOf,
  statusOf,
  type Entity,
  type EntityKind,
  type StateStatus,
} from '../../domain/entity.js'
import { iso, PostgresDb, type PostgresConfig } from './db.js'

/**
 * 投影队列 / 水位 / 看板读模型的 PostgreSQL 适配器（ARCHITECTURE-PLAN §4.4/§5.2/§5.3）。
 *
 * 全部 SQL 都按 008_v7_expand.sql 的约束写：
 * - claim 用 `FOR UPDATE SKIP LOCKED` + 租约（`available_at = now() + lease`），
 *   崩溃后到期即可被其它 worker 重领；due 部分索引只覆盖 pending/claimed。
 * - 读模型写入全部 `on conflict ... where ... is distinct from`，重复投影不改行（幂等）。
 * - 派生一律从 `omb.entity` + `omb.attribute` 现读：属性行是唯一真源，view 只提供
 *   同事务派生的展示摘要（`snippet`）。投影 worker 与超时回退用同一套 SQL，避免两处语义。
 * - 水位是“最近成功投影的源行 updated_at”的单调最大值；只在成功之后由 worker 推进。
 */

/** 队列唤醒通道：事务提交后投递，只负责叫醒，不承载队列语义。 */
export const PROJECTION_NOTIFY_CHANNEL = 'omb_projection'

// ---------------------------------------------------------------------------
// 已注册投影：writer 的入队判定
// ---------------------------------------------------------------------------

/** 已注册投影与它对应的看板；writer 的入队判定与 projector 工厂共用这一份清单。 */
interface RegisteredBoardProjection {
  readonly projection: ProjectionName
  readonly kind: BoardKind
}

/**
 * 已注册投影：本期只接 preference/state 两个看板读模型。
 * adoption_stat/co_recall_pair/similar_cache 在对应写入路径落地后再注册，避免空转任务。
 */
export const REGISTERED_PROJECTIONS: readonly RegisteredBoardProjection[] = [
  { projection: projectionOfBoard('preference'), kind: 'preference' },
  { projection: projectionOfBoard('state'), kind: 'state' },
]

const BOARD_STATUSES: readonly StateStatus[] = ['in_progress', 'blocked', 'waiting']
const PREFERENCE_TAG = '偏好'

/**
 * 改名会改变看板成员判定的属性：
 * `tags`/`标签` 决定偏好谓词，`status`/`title`/`time` 决定状态看板行与派生列。
 */
const BOARD_RELEVANT_ATTRIBUTES: ReadonlySet<string> = new Set(['tags', '标签', 'status', 'title', 'time'])

/**
 * 当前写模型状态需要哪些已注册投影。
 *
 * 谓词与 `PREFERENCE_DERIVE_SQL` / `STATE_DERIVE_SQL` 的 where 条件逐条对应：kind、
 * is_current、archived、scope、偏好标签、状态三类。两处语义必须一起改，否则 writer 的
 * 入队与 projector 的“离开看板就删除”会脱节，留下陈旧读模型行。
 *
 * `options.archived` 用于归档命令：调用方拿到的是已归档的 entity 行，但入队判定必须使用
 * 归档前的状态，才能把“删除读模型行”的任务交给 projector。
 */
export function boardProjectionsFor(
  entity: Entity,
  options: { readonly archived?: boolean } = {},
): readonly ProjectionName[] {
  const archived = options.archived ?? isArchived(entity)
  if (!entity.isCurrent || archived) return []
  const projections: ProjectionName[] = []
  const scope = scopeOf(entity)
  if (entity.kind === 'memory' && scope.kind === 'global' && hasPreferenceTag(entity)) {
    projections.push(projectionOfBoard('preference'))
  }
  const status = statusOf(entity)
  if (
    entity.kind === 'state'
    && scope.kind === 'project'
    && scope.projectKey.trim().length > 0
    && status !== undefined
    && BOARD_STATUSES.includes(status)
  ) {
    projections.push(projectionOfBoard('state'))
  }
  return projections
}

/**
 * 改名后必须重新判定的投影。
 *
 * 与 {@link boardProjectionsFor} 不同，这里**不**看改名后的谓词：改名可能把实体移出看板，
 * 而写前状态已无法从属性行完整还原，所以受影响的 memory/state 一律重新入队，让 projector
 * 幂等地重建或删除读模型行；与看板无关的属性改名返回空数组（不产生无意义任务）。
 */
export function boardProjectionsForRename(
  from: string,
  to: string,
  kind: EntityKind,
): readonly ProjectionName[] {
  if (!BOARD_RELEVANT_ATTRIBUTES.has(from) && !BOARD_RELEVANT_ATTRIBUTES.has(to)) return []
  if (kind === 'memory') return [projectionOfBoard('preference')]
  if (kind === 'state') return [projectionOfBoard('state')]
  return []
}

/** 与 PREFERENCE_DERIVE_SQL 一致：`tags` 数组含“偏好”，或 `标签` 字符串等于“偏好”。 */
function hasPreferenceTag(entity: Entity): boolean {
  const tags = attributeValue(entity, 'tags')
  if (Array.isArray(tags) && tags.includes(PREFERENCE_TAG)) return true
  return attributeValue(entity, '标签') === PREFERENCE_TAG
}

const MAX_BOARD_LIMIT = 100
const MAX_ERROR_LENGTH = 4_000

/** 适配器内部的最小执行器：Pool、PoolClient 与 PostgresDb 都满足。 */
export interface ProjectionQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

interface ClaimRow extends QueryResultRow {
  entity_id: string
  projection: string
  revision: string | number
  attempts: number
  available_at: Date | string
}

interface EnqueueRow extends QueryResultRow {
  revision: string | number
  status: string
}

interface TaskRow extends QueryResultRow {
  status: string
  revision: string | number
}

interface WatermarkRow extends QueryResultRow {
  projection: string
  watermark: string
  updated_at: Date | string
  watermark_age_ms?: string | number | null
}

interface LagRow extends QueryResultRow {
  projection: string
  pending: number
  claimed: number
  dead: number
  due: number
  oldest_due_age_ms: string | number | null
}

interface DeriveRow extends QueryResultRow {
  entity_id: string
  title: string | null
  summary: string | null
  salience: number | null
  status: string | null
  project_key: string | null
  event_time: Date | string | null
  revision: string | number
  updated_at: Date | string
}

interface BoardRow extends QueryResultRow {
  entity_id: string
  title: string | null
  summary?: string | null
  salience?: number | null
  status?: string | null
  project_key?: string | null
  event_time?: Date | string | null
  revision: string | number
  updated_at: Date | string
}

interface SourceRow extends QueryResultRow {
  source_updated_at: Date | string | null
}

// ---------------------------------------------------------------------------
// 队列 SQL（导出以便 EXPLAIN 诊断与测试断言 due 索引被使用）
// ---------------------------------------------------------------------------

/** 同一 (entity_id, projection) 只保留一行；只有更新的 revision 才重置任务。 */
export const PROJECTION_ENQUEUE_SQL = `
insert into omb.projection_task (entity_id, projection, revision, status, attempts, available_at, claimed_at, last_error)
values ($1, $2, $3, 'pending', 0, coalesce($4::timestamptz, now()), null, null)
on conflict (entity_id, projection) do update
   set revision = excluded.revision,
       status = 'pending',
       attempts = 0,
       available_at = excluded.available_at,
       claimed_at = null,
       last_error = null
 where omb.projection_task.revision < excluded.revision
returning revision::bigint as revision, status
`

/**
 * `$1` projection、`$2` 批大小、`$3` 租约毫秒。
 * CTE 的 `FOR UPDATE SKIP LOCKED` 是并发安全的唯一依据：第二个 worker 跳过被锁住的行，
 * 既不阻塞也不会重复领取；`available_at` 同时是租约到期时间，崩溃后自动可重领。
 */
export const PROJECTION_CLAIM_SQL = `
with due as (
  select entity_id, projection
    from omb.projection_task
   where projection = $1
     and status in ('pending', 'claimed')
     and available_at <= now()
   order by available_at, entity_id
   for update skip locked
   limit $2
)
update omb.projection_task target
   set status = 'claimed',
       claimed_at = now(),
       available_at = now() + ($3::int * interval '1 millisecond')
  from due
 where target.entity_id = due.entity_id
   and target.projection = due.projection
returning target.entity_id, target.projection, target.revision::bigint as revision,
          target.attempts, target.available_at
`

const PROJECTION_COMPLETE_SQL = `
update omb.projection_task
   set status = 'done', claimed_at = null, last_error = null
 where entity_id = $1 and projection = $2 and status = 'claimed' and attempts = $3
`

const PROJECTION_FAIL_SQL = `
update omb.projection_task
   set attempts = attempts + 1,
       status = $3,
       available_at = coalesce($4::timestamptz, available_at),
       claimed_at = null,
       last_error = $5
 where entity_id = $1 and projection = $2 and status = 'claimed' and attempts = $6
`

const PROJECTION_RELEASE_SQL = `
update omb.projection_task
   set status = 'pending', claimed_at = null, available_at = now()
 where entity_id = $1 and projection = $2 and status = 'claimed' and attempts = $3
`

/** 水位单调：只有比旧值新才写入；`::timestamptz` 保证 epoch/ISO 两种历史格式都能比较。 */
const PROJECTION_WATERMARK_ADVANCE_SQL = `
insert into omb.projection_watermark as pw (projection, watermark, updated_at)
values ($1, $2, now())
on conflict (projection) do update
   set watermark = excluded.watermark, updated_at = now()
 where pw.watermark::timestamptz < excluded.watermark::timestamptz
`

const PROJECTION_WATERMARKS_SQL = `
select projection, watermark, updated_at,
       (extract(epoch from (now() - watermark::timestamptz)) * 1000)::bigint as watermark_age_ms
  from omb.projection_watermark
`

const PROJECTION_LAG_SQL = `
select projection,
       count(*) filter (where status = 'pending')::int as pending,
       count(*) filter (where status = 'claimed')::int as claimed,
       count(*) filter (where status = 'dead')::int as dead,
       count(*) filter (where status in ('pending', 'claimed') and available_at <= now())::int as due,
       coalesce(
         (extract(
           epoch from (now() - min(available_at) filter (
             where status in ('pending', 'claimed') and available_at <= now()
           ))
         ) * 1000)::bigint,
         0
       ) as oldest_due_age_ms
  from omb.projection_task
 group by projection
`

const PROJECTION_TASK_STATE_SQL = `
select status, revision::bigint as revision
  from omb.projection_task
 where entity_id = $1 and projection = $2
`

// ---------------------------------------------------------------------------
// 看板读模型 SQL
// ---------------------------------------------------------------------------

export const PREFERENCE_BOARD_READ_SQL = `
select entity_id, title, summary, salience::real as salience, revision::bigint as revision, updated_at
  from omb.preference_board
 where scope = $1
 order by salience desc, updated_at desc, entity_id asc
 limit $2
`

export const STATE_BOARD_READ_SQL = `
select entity_id, title, status, project_key, event_time, revision::bigint as revision, updated_at
  from omb.state_board
 where project_key = $1
 order by (case status when 'in_progress' then 0 when 'blocked' then 1 else 2 end),
          event_time desc nulls last, entity_id asc
 limit $2
`

/**
 * 从写模型派生偏好看板行。
 *
 * 谓词与 `scripts/v7-backfill.mjs` 的 T0 语义一致：全局记忆且 `tags` 含“偏好”或
 * `标签=偏好`；`title` 取属性行，`summary` 用同事务派生的 `entity_view.snippet`（只做展示）。
 */
const PREFERENCE_DERIVE_SQL = `
select e.id as entity_id,
       case when jsonb_typeof(t.value) = 'string' then t.value #>> '{}' end as title,
       v.snippet as summary,
       e.salience::real as salience,
       null::text as status,
       null::text as project_key,
       null::timestamptz as event_time,
       e.revision::bigint as revision,
       e.updated_at as updated_at
  from omb.entity e
  join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'scope'
     order by a.ordinal limit 1
  ) sc on true
  left join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'title'
     order by a.ordinal limit 1
  ) t on true
  left join omb.entity_view v on v.entity_id = e.id
 where e.kind = 'memory'
   and e.archived_at is null and e.is_current
   and sc.value->>'kind' = 'global'
   and (
     exists (
       select 1 from omb.attribute tg
        where tg.entity_id = e.id and tg.name = 'tags'
          and tg.value @> '["偏好"]'::jsonb
     )
     or exists (
       select 1 from omb.attribute tg
        where tg.entity_id = e.id and tg.name = '标签'
          and jsonb_typeof(tg.value) = 'string' and tg.value #>> '{}' = '偏好'
     )
   )`

const PREFERENCE_DERIVE_ORDER = `
 order by e.salience desc, e.updated_at desc, e.id asc`

/**
 * 从写模型派生状态看板行：项目内、未归档、当前版本、状态属于看板关注的三类。
 * `time` 属性缺省/非法时不进看板查询（时间列可空，但排序用 nulls last）。
 */
const STATE_DERIVE_SQL = `
select e.id as entity_id,
       case when jsonb_typeof(t.value) = 'string' then t.value #>> '{}' end as title,
       null::text as summary,
       null::real as salience,
       case when jsonb_typeof(st.value) = 'string' then st.value #>> '{}' end as status,
       sc.value->>'projectKey' as project_key,
       case
         when jsonb_typeof(tm.value) = 'string' and (tm.value #>> '{}') ~ '^\\d{4}-'
           then (tm.value #>> '{}')::timestamptz
         else null
       end as event_time,
       e.revision::bigint as revision,
       e.updated_at as updated_at
  from omb.entity e
  join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'scope'
     order by a.ordinal limit 1
  ) sc on true
  left join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'title'
     order by a.ordinal limit 1
  ) t on true
  left join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'status'
     order by a.ordinal limit 1
  ) st on true
  left join lateral (
    select a.value from omb.attribute a
     where a.entity_id = e.id and a.name = 'time'
     order by a.ordinal limit 1
  ) tm on true
 where e.kind = 'state'
   and e.archived_at is null and e.is_current
   and sc.value->>'kind' = 'project'
   and coalesce(sc.value->>'projectKey', '') <> ''
   and (case when jsonb_typeof(st.value) = 'string' then st.value #>> '{}' end)
       in ('in_progress', 'blocked', 'waiting')`

const STATE_DERIVE_ORDER = `
 order by (case
            when (st.value #>> '{}') = 'in_progress' then 0
            when (st.value #>> '{}') = 'blocked' then 1
            else 2
          end),
          (case when jsonb_typeof(tm.value) = 'string' then (tm.value #>> '{}')::timestamptz end) desc nulls last,
          e.id asc`

const PREFERENCE_BOARD_UPSERT_SQL = `
insert into omb.preference_board as pb (entity_id, scope, title, summary, salience, revision, updated_at)
values ($1, $2, $3, $4, $5, $6, $7)
on conflict (entity_id) do update
   set scope = excluded.scope,
       title = excluded.title,
       summary = excluded.summary,
       salience = excluded.salience,
       revision = excluded.revision,
       updated_at = excluded.updated_at
 where (pb.scope, pb.title, pb.summary, pb.salience, pb.revision, pb.updated_at)
   is distinct from
       (excluded.scope, excluded.title, excluded.summary, excluded.salience, excluded.revision, excluded.updated_at)
`

const STATE_BOARD_UPSERT_SQL = `
insert into omb.state_board as sb (entity_id, project_key, title, status, event_time, revision, updated_at)
values ($1, $2, $3, $4, $5, $6, $7)
on conflict (entity_id) do update
   set project_key = excluded.project_key,
       title = excluded.title,
       status = excluded.status,
       event_time = excluded.event_time,
       revision = excluded.revision,
       updated_at = excluded.updated_at
 where (sb.project_key, sb.title, sb.status, sb.event_time, sb.revision, sb.updated_at)
   is distinct from
       (excluded.project_key, excluded.title, excluded.status, excluded.event_time, excluded.revision, excluded.updated_at)
`

const PREFERENCE_BOARD_DELETE_SQL = 'delete from omb.preference_board where entity_id = $1'
const STATE_BOARD_DELETE_SQL = 'delete from omb.state_board where entity_id = $1'

const PREFERENCE_BOARD_ROW_SQL = `
select entity_id, title, summary, salience::real as salience, revision::bigint as revision, updated_at
  from omb.preference_board
 where entity_id = $1
`

const STATE_BOARD_ROW_SQL = `
select entity_id, title, status, project_key, event_time, revision::bigint as revision, updated_at
  from omb.state_board
 where entity_id = $1
`

/** 源行时间：entity.updated_at 与属性行 updated_at 的最大值（动态缓存重建只动属性行）。 */
const SOURCE_UPDATED_AT_SQL = `
select greatest(e.updated_at, coalesce(max(a.updated_at), e.updated_at)) as source_updated_at
  from omb.entity e
  left join omb.attribute a on a.entity_id = e.id
 where e.id = $1
 group by e.id, e.updated_at
`

// ---------------------------------------------------------------------------
// 投影队列 + 水位
// ---------------------------------------------------------------------------

export class PostgresProjectionTaskStore implements ProjectionTaskStore {
  constructor(private readonly db: PostgresDb) {}

  async enqueue(input: ProjectionEnqueueInput, tx?: ProjectionTransaction): Promise<ProjectionEnqueueResult> {
    const executor = executorFor(tx, this.db)
    const inserted = await executor.query<EnqueueRow>(PROJECTION_ENQUEUE_SQL, [
      input.entityId,
      input.projection,
      input.revision,
      input.availableAt === undefined ? null : input.availableAt.toISOString(),
    ])
    const row = inserted.rows[0]
    if (row !== undefined) {
      await notifyProjection(executor, input.projection)
      return {
        entityId: input.entityId,
        projection: input.projection,
        revision: Number(row.revision),
        status: asTaskStatus(row.status),
        changed: true,
      }
    }
    // 同一 revision 已存在：命令幂等重放不产生新工作，也不重复唤醒。
    const existing = await executor.query<TaskRow>(PROJECTION_TASK_STATE_SQL, [input.entityId, input.projection])
    const current = existing.rows[0]
    if (current === undefined) {
      throw new Error(`projection enqueue 未插入也未找到已存在行：${input.entityId}/${input.projection}`)
    }
    return {
      entityId: input.entityId,
      projection: input.projection,
      revision: Number(current.revision),
      status: asTaskStatus(current.status),
      changed: false,
    }
  }

  async claim(options: ProjectionClaimOptions): Promise<readonly ClaimedProjectionTask[]> {
    const rows = await this.db.query<ClaimRow>(PROJECTION_CLAIM_SQL, [
      options.projection,
      clampInt(options.limit, 1, 500),
      clampInt(options.leaseMs, 1, 3_600_000),
    ])
    return rows.rows.map(row => ({
      entityId: row.entity_id,
      projection: asProjection(row.projection),
      revision: Number(row.revision),
      attempts: row.attempts,
      availableAt: iso(row.available_at) as string,
    }))
  }

  async complete(task: ClaimedProjectionTask): Promise<boolean> {
    const result = await this.db.query(PROJECTION_COMPLETE_SQL, [task.entityId, task.projection, task.attempts])
    if (result.rowCount !== 1) return false
    // 读侧可能正在等 token：完成时补一次 NOTIFY，让等待者立刻复查而不是等 deadline。
    await notifyProjection(this.db, task.projection)
    return true
  }

  async fail(input: ProjectionFailureInput): Promise<boolean> {
    const result = await this.db.query(PROJECTION_FAIL_SQL, [
      input.task.entityId,
      input.task.projection,
      input.dead === true ? 'dead' : 'pending',
      input.retryAt === undefined ? null : input.retryAt.toISOString(),
      errorText(input.error),
      input.task.attempts,
    ])
    return result.rowCount === 1
  }

  async release(task: ClaimedProjectionTask): Promise<boolean> {
    const result = await this.db.query(PROJECTION_RELEASE_SQL, [task.entityId, task.projection, task.attempts])
    return result.rowCount === 1
  }

  async advanceWatermark(projection: ProjectionName, watermark: string): Promise<boolean> {
    const normalized = normalizeWatermark(watermark)
    const result = await this.db.query(PROJECTION_WATERMARK_ADVANCE_SQL, [projection, normalized])
    return result.rowCount === 1
  }

  async watermark(projection: ProjectionName): Promise<ProjectionWatermark | undefined> {
    const all = await this.watermarks()
    return all.find(item => item.projection === projection)
  }

  async watermarks(): Promise<readonly ProjectionWatermark[]> {
    const rows = await this.db.query<WatermarkRow>(PROJECTION_WATERMARKS_SQL)
    const result: ProjectionWatermark[] = []
    for (const row of rows.rows) {
      const projection = knownProjection(row.projection)
      // 未知投影（后续阶段新增的读模型）不混进本阶段的 5 个枚举，也不让 lag 抛错。
      if (projection === undefined) continue
      result.push({ projection, watermark: row.watermark, updatedAt: iso(row.updated_at) as string })
    }
    return result
  }

  async lag(): Promise<readonly ProjectionLag[]> {
    const [tasks, watermarks] = await Promise.all([
      this.db.query<LagRow>(PROJECTION_LAG_SQL),
      this.db.query<WatermarkRow>(PROJECTION_WATERMARKS_SQL),
    ])
    const taskRows = new Map(tasks.rows.map(row => [row.projection, row]))
    const watermarkRows = new Map(watermarks.rows.map(row => [row.projection, row]))
    return PROJECTION_NAMES.map(projection => {
      const task = taskRows.get(projection)
      const watermark = watermarkRows.get(projection)
      return {
        projection,
        pending: task?.pending ?? 0,
        claimed: task?.claimed ?? 0,
        dead: task?.dead ?? 0,
        due: task?.due ?? 0,
        oldestDueAgeMs: Math.max(0, Number(task?.oldest_due_age_ms ?? 0)),
        ...(watermark === undefined
          ? {}
          : {
              watermark: watermark.watermark,
              watermarkAgeMs: Math.max(0, Number(watermark.watermark_age_ms ?? 0)),
              updatedAt: iso(watermark.updated_at) as string,
            }),
      }
    })
  }

  async taskState(entityId: string, projection: ProjectionName): Promise<ProjectionTaskState | undefined> {
    const result = await this.db.query<TaskRow>(PROJECTION_TASK_STATE_SQL, [entityId, projection])
    const row = result.rows[0]
    if (row === undefined) return undefined
    return { status: asTaskStatus(row.status), revision: Number(row.revision) }
  }
}

/**
 * 在给定执行器（通常是 writer 的事务客户端）上发 NOTIFY。
 * 事务提交时 PostgreSQL 才投递；回滚则提示消失。
 */
export async function notifyProjection(executor: ProjectionQueryExecutor, projection: ProjectionName): Promise<void> {
  await executor.query('select pg_notify($1, $2)', [PROJECTION_NOTIFY_CHANNEL, projection])
}

/** NOTIFY 监听器（LISTEN 需要专用连接）；只负责唤醒，漏通知时读调用方按 deadline 回退。 */
export class PostgresProjectionNotifier implements ProjectionWakeSource {
  private client: pg.Client | undefined
  private connecting: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()
  private closed = false

  constructor(private readonly config: PostgresConfig) {}

  /** 等待 LISTEN 真正注册完成；测试与需要确定性时序的调用方使用。 */
  async ready(): Promise<void> {
    await this.listen()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    void this.listen().catch(() => {
      // 连接失败不阻塞 worker/读路径；NOTIFY 只是提示，deadline/下一次 tick 会兜底。
    })
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    const client = this.client
    this.client = undefined
    if (client !== undefined) await client.end().catch(() => {})
  }

  private listen(): Promise<void> {
    if (this.client !== undefined) return Promise.resolve()
    if (this.connecting !== undefined) return this.connecting
    if (this.closed) return Promise.reject(new Error('projection notifier 已关闭'))
    const connecting = this.open()
    this.connecting = connecting
    void connecting
      .catch(() => {})
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined
      })
    return connecting
  }

  private async open(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 5_000,
      application_name: 'omb-v7-projection',
    })
    client.on('notification', message => {
      if (message.channel !== PROJECTION_NOTIFY_CHANNEL) return
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch {
          // 单个监听器异常不能影响其它监听器，也不能把错误抛进 pg 的事件循环。
        }
      }
    })
    client.on('error', () => {
      if (this.client === client) this.client = undefined
      void client.end().catch(() => {})
    })
    try {
      await client.connect()
      await client.query(`listen ${PROJECTION_NOTIFY_CHANNEL}`)
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    if (this.closed) {
      await client.end().catch(() => {})
      throw new Error('projection notifier 已关闭')
    }
    this.client = client
  }
}

// ---------------------------------------------------------------------------
// 看板投影（preference_board / state_board）
// ---------------------------------------------------------------------------

class PostgresBoardProjector implements ProjectionProjector {
  readonly projection: ProjectionName

  constructor(
    private readonly db: PostgresDb,
    readonly kind: BoardKind,
  ) {
    this.projection = projectionOfBoard(kind)
  }

  /**
   * 单个实体的幂等投影：源行仍在看板条件内就 upsert（内容不变则不写），
   * 否则删除读模型行（归档/取消归档/状态离开三类/取消偏好都不会残留）。
   */
  async project(task: ProjectionTask): Promise<ProjectionOutcome> {
    return this.db.transaction(async client => {
      const source = await client.query<SourceRow>(SOURCE_UPDATED_AT_SQL, [task.entityId])
      const derivation = boardDerivationSql(this.kind, { entityId: task.entityId })
      const rows = await client.query<DeriveRow>(derivation.text, derivation.values)
      const row = rows.rows[0]
      if (row === undefined) {
        await client.query(
          this.kind === 'preference' ? PREFERENCE_BOARD_DELETE_SQL : STATE_BOARD_DELETE_SQL,
          [task.entityId],
        )
      } else if (this.kind === 'preference') {
        await client.query(PREFERENCE_BOARD_UPSERT_SQL, [
          row.entity_id,
          'global',
          row.title,
          row.summary,
          Number(row.salience ?? 0.5),
          Number(row.revision),
          row.updated_at,
        ])
      } else {
        await client.query(STATE_BOARD_UPSERT_SQL, [
          row.entity_id,
          row.project_key,
          row.title,
          row.status,
          row.event_time,
          Number(row.revision),
          row.updated_at,
        ])
      }
      const sourceUpdatedAt = iso(source.rows[0]?.source_updated_at)
      return sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }
    })
  }
}

/** preference/state 两个真实投影；顺序取 `REGISTERED_PROJECTIONS`，便于 worker 批量 claim 的测试断言。 */
export function createBoardProjectors(db: PostgresDb): readonly ProjectionProjector[] {
  return REGISTERED_PROJECTIONS.map(item => new PostgresBoardProjector(db, item.kind))
}

class PostgresBoardReader implements BoardReader {
  constructor(private readonly db: PostgresDb) {}

  async readBoard(query: BoardQuery): Promise<readonly BoardItem[]> {
    const limit = clampInt(query.limit, 1, MAX_BOARD_LIMIT)
    if (query.kind === 'preference') {
      // 偏好看板按 T0 语义只存全局偏好；项目 scope 查询必然为空。
      if (query.scope.kind !== 'global') return []
      const rows = await this.db.query<BoardRow>(PREFERENCE_BOARD_READ_SQL, ['global', limit])
      return rows.rows.map(row => this.preferenceItem(row))
    }
    if (query.scope.kind !== 'project') return []
    const rows = await this.db.query<BoardRow>(STATE_BOARD_READ_SQL, [query.scope.projectKey, limit])
    return rows.rows.map(row => this.stateItem(row))
  }

  async readBoardRow(kind: BoardKind, entityId: string): Promise<BoardItem | undefined> {
    const row = await this.db.query<BoardRow>(
      kind === 'preference' ? PREFERENCE_BOARD_ROW_SQL : STATE_BOARD_ROW_SQL,
      [entityId],
    )
    const first = row.rows[0]
    if (first === undefined) return undefined
    return kind === 'preference' ? this.preferenceItem(first) : this.stateItem(first)
  }

  async deriveFromWriteModel(query: BoardQuery & { readonly entityId?: string }): Promise<readonly BoardItem[]> {
    if (query.kind === 'preference' && query.scope.kind !== 'global') return []
    if (query.kind === 'state' && query.scope.kind !== 'project') return []
    const derivation = boardDerivationSql(query.kind, {
      limit: query.limit,
      ...(query.entityId !== undefined ? { entityId: query.entityId } : {}),
      ...(query.kind === 'state' && query.scope.kind === 'project' ? { projectKey: query.scope.projectKey } : {}),
    })
    const rows = await this.db.query<DeriveRow>(derivation.text, derivation.values)
    return rows.rows.map(row => (query.kind === 'preference' ? this.preferenceItem(row) : this.stateItem(row)))
  }

  private preferenceItem(row: DeriveRow | BoardRow): BoardItem {
    return {
      entityId: row.entity_id,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.summary === undefined || row.summary === null ? {} : { summary: row.summary }),
      ...(row.salience === undefined || row.salience === null ? {} : { salience: Number(row.salience) }),
      revision: Number(row.revision),
      updatedAt: iso(row.updated_at) as string,
    }
  }

  private stateItem(row: DeriveRow | BoardRow): BoardItem {
    const status = typeof row.status === 'string' ? (row.status as StateStatus) : undefined
    const eventTime = iso(row.event_time)
    return {
      entityId: row.entity_id,
      ...(row.title === null || row.title === undefined ? {} : { title: row.title }),
      ...(status === undefined ? {} : { status }),
      ...(row.project_key === null || row.project_key === undefined ? {} : { projectKey: row.project_key }),
      ...(eventTime === undefined ? {} : { eventTime }),
      revision: Number(row.revision),
      updatedAt: iso(row.updated_at) as string,
    }
  }
}

/** 看板读模型读取器；`boardDerivationSql` 同时服务投影 worker 与超时回退。 */
export function createBoardReader(db: PostgresDb): BoardReader {
  return new PostgresBoardReader(db)
}

/**
 * 生成从 `entity/attribute` 派生看板行的 SQL。
 *
 * 过滤器是三个可选条件（entityId / projectKey / limit），全部参数化；
 * `scope` 过滤由调用方按看板语义先判空，避免拼出非法 SQL。
 */
export function boardDerivationSql(
  kind: BoardKind,
  filter: { readonly entityId?: string; readonly projectKey?: string; readonly limit?: number },
): { text: string; values: unknown[] } {
  const values: unknown[] = []
  const clauses: string[] = []
  if (filter.entityId !== undefined) {
    values.push(filter.entityId)
    clauses.push(`e.id = $${values.length}`)
  }
  if (kind === 'state' && filter.projectKey !== undefined) {
    values.push(filter.projectKey)
    clauses.push(`sc.value->>'projectKey' = $${values.length}`)
  }
  let text = kind === 'preference' ? PREFERENCE_DERIVE_SQL : STATE_DERIVE_SQL
  if (clauses.length > 0) text += `\n   and ${clauses.join('\n   and ')}`
  text += kind === 'preference' ? PREFERENCE_DERIVE_ORDER : STATE_DERIVE_ORDER
  if (filter.limit !== undefined) {
    values.push(clampInt(filter.limit, 1, MAX_BOARD_LIMIT))
    text += `\n limit $${values.length}`
  }
  return { text, values }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function executorFor(tx: ProjectionTransaction | undefined, db: PostgresDb): ProjectionQueryExecutor {
  if (tx === undefined || tx === null) return db
  if (typeof tx === 'object' && typeof (tx as { query?: unknown }).query === 'function') {
    return tx as ProjectionQueryExecutor
  }
  throw new Error('projection.enqueue 的事务句柄必须提供 query()')
}

function asTaskStatus(value: string): ProjectionTaskStatus {
  if (value === 'pending' || value === 'claimed' || value === 'done' || value === 'dead') return value
  throw new Error(`未知 projection_task.status：${value}`)
}

function asProjection(value: string): ProjectionName {
  const known = knownProjection(value)
  if (known === undefined) throw new Error(`未知 projection：${value}`)
  return known
}

function knownProjection(value: string): ProjectionName | undefined {
  return PROJECTION_NAMES.find(name => name === value)
}

/** 水位统一成 ISO-8601 UTC：`::timestamptz` 比较与 epoch 历史值都能工作。 */
function normalizeWatermark(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`投影水位不是合法时间：${value}`)
  return new Date(parsed).toISOString()
}

function errorText(value: string): string {
  const text = value.trim().length > 0 ? value : 'unknown error'
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
