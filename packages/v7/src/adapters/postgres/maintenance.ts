import type { Category, EntityKind, StateStatus } from '../../domain/entity.js'
import type { JsonValue } from '../../domain/json.js'
import { systemCommandMeta } from '../../app/commands/index.js'
import type {
  AttrAliasCandidate,
  BrokenReference,
  CoRecallPair,
  Forgettable,
  MaintenanceQueries,
  RecentEntity,
} from '../../ports/maintenance.js'
import { iso, PostgresDb } from './db.js'
import { AttributeWriter } from './writer.js'

interface RecentRow {
  entity_id: string
  kind: EntityKind
  category: Category | null
  status: StateStatus | null
  title: string | null
  snippet: string
  attrs: Record<string, unknown>
  origin: string
  confidence: number | null
  pinned: boolean
  salience: number
  adoption_count: number
  access_count: number
  updated_at: Date | string
}

export class PostgresMaintenance implements MaintenanceQueries {
  /** 属性改名的唯一写者；维护查询本身只读。 */
  private readonly writer: AttributeWriter

  constructor(private readonly db: PostgresDb) {
    this.writer = new AttributeWriter(db)
  }

  async staleDynamic(limit: number): Promise<string[]> {
    const rows = await this.db.query<{ entity_id: string }>(
      `select distinct a.entity_id
       from omb.attribute a
       join omb.entity e on e.id = a.entity_id
       where a.value_kind = 'dynamic' and e.archived_at is null
         and (a.cached_at is null
              or a.last_error is not null
              or a.cached_at + (coalesce(a.stale_after_ms, 300000) * interval '1 millisecond') <= now())
       limit $1`,
      [Math.max(1, Math.min(200, limit))],
    )
    return rows.rows.map(row => row.entity_id)
  }

  async missingEmbeddings(limit: number): Promise<string[]> {
    const rows = await this.db.query<{ entity_id: string }>(
      `select v.entity_id
       from omb.entity_view v
       left join omb.embedding e on e.entity_id = v.entity_id
       where v.archived_at is null and v.is_current and e.entity_id is null
       order by v.updated_at desc
       limit $1`,
      [Math.max(1, Math.min(200, limit))],
    )
    return rows.rows.map(row => row.entity_id)
  }

  async recent(limit: number): Promise<RecentEntity[]> {
    const rows = await this.db.query<RecentRow>(
      `select v.entity_id, v.kind, v.category, v.status, v.title, v.snippet, v.attrs,
              e.origin, e.confidence, e.pinned, e.salience, e.adoption_count, e.access_count, v.updated_at
       from omb.entity_view v
       join omb.entity e on e.id = v.entity_id
       where v.archived_at is null and v.is_current
       order by v.updated_at desc
       limit $1`,
      [Math.max(1, Math.min(200, limit))],
    )
    return rows.rows.map(row => ({
      id: row.entity_id,
      kind: row.kind,
      ...(row.category !== null ? { category: row.category } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
      ...(row.title !== null ? { title: row.title } : {}),
      snippet: row.snippet,
      attrs: row.attrs as Record<string, JsonValue>,
      origin: row.origin,
      ...(row.confidence !== null ? { confidence: row.confidence } : {}),
      pinned: row.pinned,
      salience: row.salience,
      adoptionCount: row.adoption_count,
      accessCount: row.access_count,
      updatedAt: iso(row.updated_at) as string,
    }))
  }

  async coRecallPairs(limit: number): Promise<CoRecallPair[]> {
    const rows = await this.db.query<{ a: string; b: string; count: string }>(
      `select a.entity_id as a, b.entity_id as b, count(*)::text as count
       from omb.recall_event a
       join omb.recall_event b
         on a.trace_id = b.trace_id and a.entity_id < b.entity_id
       join omb.entity_view av on av.entity_id = a.entity_id and av.archived_at is null and av.is_current
       join omb.entity_view bv on bv.entity_id = b.entity_id and bv.archived_at is null and bv.is_current
       where a.adopted_at is not null and b.adopted_at is not null
         and av.kind in ('memory', 'state', 'state_version')
         and bv.kind in ('memory', 'state', 'state_version')
       group by a.entity_id, b.entity_id
       order by count(*) desc
       limit $1`,
      [Math.max(1, Math.min(200, limit))],
    )
    return rows.rows.map(row => ({ a: row.a, b: row.b, count: Number(row.count) }))
  }

  async forgettable(limit: number, threshold: number): Promise<Forgettable[]> {
    const rows = await this.db.query<{
      entity_id: string
      salience: number
      category: Category | null
      pinned: boolean
      updated_at: Date | string
      revision: string
    }>(
      `select v.entity_id,
              (0.45 * exp(-extract(epoch from (now() - v.updated_at)) / 86400.0 / 30.0)
               + 0.20 * least(1.0, e.adoption_count::float / greatest(1, e.access_count))
               + 0.15 * coalesce(e.confidence, 0.5)
               + 0.10 * (case v.category when 'fact' then 0.9 when 'clue' then 0.6 else 0.3 end)
               + 0.10 * (case v.kind when 'state' then 0.8 else 0.5 end)) as salience,
              v.category, e.pinned, v.updated_at, e.revision
       from omb.entity_view v
       join omb.entity e on e.id = v.entity_id
       where v.kind = 'memory' and v.archived_at is null and v.is_current and e.pinned = false
         and not (v.attrs @> '{"tags":["偏好"]}'::jsonb)
         and coalesce(v.attrs->>'标签', '') <> '偏好'
         and (0.45 * exp(-extract(epoch from (now() - v.updated_at)) / 86400.0 / 30.0)
              + 0.20 * least(1.0, e.adoption_count::float / greatest(1, e.access_count))
              + 0.15 * coalesce(e.confidence, 0.5)
              + 0.10 * (case v.category when 'fact' then 0.9 when 'clue' then 0.6 else 0.3 end)
              + 0.10 * (case v.kind when 'state' then 0.8 else 0.5 end)) < $1
       order by salience asc
       limit $2`,
      [threshold, Math.max(1, Math.min(200, limit))],
    )
    return rows.rows.map(row => ({
      id: row.entity_id,
      salience: row.salience,
      ...(row.category !== null ? { category: row.category } : {}),
      pinned: row.pinned,
      updatedAt: iso(row.updated_at) as string,
      revision: Number(row.revision),
    }))
  }

  async attrAliasCandidates(limit: number): Promise<AttrAliasCandidate[]> {
    const rows = await this.db.query<{
      name: string
      alias: string
      similarity: number
      usage: number
    }>(
      `select a.name, b.name as alias, similarity(a.name, b.name) as similarity,
              greatest(a.usage_count, b.usage_count) as usage
       from omb.attr_registry a
       join omb.attr_registry b on a.name < b.name
       where similarity(a.name, b.name) >= 0.5
         and a.name not in ('id','category','scope','title','status','time','group')
         and b.name not in ('id','category','scope','title','status','time','group')
       order by similarity desc, usage desc
       limit $1`,
      [Math.max(1, Math.min(100, limit))],
    )
    return rows.rows.map(row => ({
      name: row.name,
      alias: row.alias,
      similarity: row.similarity,
      usage: row.usage,
    }))
  }

  async brokenReferences(limit: number): Promise<BrokenReference[]> {
    const rows = await this.db.query<{
      source_entity_id: string
      source_attr_name: string
      source_ordinal: number
      target_entity_id: string
      target_attr_name: string
      kind: string
    }>(
      `select r.source_entity_id, r.source_attr_name, r.source_ordinal,
              r.target_entity_id, r.target_attr_name, r.kind
       from omb.reference r
       join omb.entity target on target.id = r.target_entity_id
       where r.target_attr_name <> '' and not exists (
               select 1 from omb.attribute a
               where a.entity_id = r.target_entity_id and a.name = r.target_attr_name
             )
       limit $1`,
      [Math.max(1, Math.min(500, limit))],
    )
    return rows.rows.map(row => ({
      sourceId: row.source_entity_id,
      sourceAttr: row.source_attr_name,
      sourceOrdinal: row.source_ordinal,
      targetId: row.target_entity_id,
      targetAttr: row.target_attr_name,
      kind: row.kind,
    }))
  }

  async conflictSuppressed(a: string, b: string): Promise<boolean> {
    const [left, right] = a < b ? [a, b] : [b, a]
    // check:ignore-next-line sec-sql-concat -- 值走 $1；模板只拼 pair_key 参数值，不是 SQL 片段
    const rows = await this.db.query('select 1 from omb.conflict_suppression where pair_key = $1', [`${left}|${right}`])
    return rows.rowCount !== 0
  }

  /**
   * 属性名归并（后台 attr-alias 任务的入口）。
   *
   * 不再直写属性表/视图：交给 `AttributeWriter` 的 RenameAttribute 单事务，
   * 同一事务内完成属性行、attr_registry、reference、受影响实体的 view/触发键、
   * 审计（action 沿用历史标签 `attr-alias`）与 outbox 追加；失败整体回滚。
   * 返回受影响实体 id（顺序与 writer 的确定性排序一致）。
   */
  async renameAttribute(from: string, to: string): Promise<string[]> {
    if (from === to || from.trim().length === 0 || to.trim().length === 0) return []
    // 必填属性改名会直接破坏 entity_view 的列语义；即使相似度命中也不允许。
    const required = new Set(['id', 'category', 'scope', 'title', 'status', 'time', 'group'])
    if (required.has(from) || required.has(to)) return []
    const outcome = await this.writer.execute(
      { type: 'RenameAttribute', from, to, reason: 'attr-alias', auditAction: 'attr-alias' },
      systemCommandMeta('job:attr-alias', 'job:attr-alias'),
    )
    return [...(outcome.entityIds ?? [])]
  }
}
