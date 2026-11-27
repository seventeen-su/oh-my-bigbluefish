import type {
  Attribute,
  Entity,
  EntityKind,
  PatchEntityInput,
  StateStatus,
  StateVersion,
} from '../../domain/entity.js'
import { titleOf } from '../../domain/entity-access.js'
import { OmbFailure, internal } from '../../domain/errors.js'
import type { JsonValue } from '../../domain/json.js'
import type { Expansion } from '../../domain/link.js'
import { decodeRegexTriggerKey, type NormalizedWrite } from '../../domain/validation.js'
import { defaultRegexService } from '../../security/regex.js'
import { REGEX_TIMEOUT_MS } from '../../security/regex-limits.js'
import type { RegexCandidate } from '../../security/regex-types.js'
import type {
  DerivedWrite,
  LinkResult,
  PatchResult,
  ReadOptions,
  Store,
  WriteResult,
} from '../../ports/store.js'
import type {
  ArtifactInput,
  ArtifactRecord,
  AuditRecord,
  RecallEventInput,
  ResidentTraceInput,
  RollbackResult,
} from '../../ports/observability.js'
import type {
  ChannelHit,
  EntitySummary,
  StateBoardSpec,
  TextSearchSpec,
  TimeSearchSpec,
  TriggerSearchSpec,
  VectorSearchSpec,
} from '../../ports/search.js'
import { systemCommandMeta } from '../../app/commands/index.js'
import { iso, PostgresDb } from './db.js'
import { mapEntity, type EntityRow, type ViewRow } from './rows.js'
import { findSimilar } from './similar.js'
import { AttributeWriter } from './writer.js'
import { mapPgError } from './writer-support.js'
import { selectAttributes } from './writer-tables.js'

/** 单次全文检索最多拼多少个 OR 词：长工具输出 tokenize 后动辄上百词，全量会撑大 tsquery。 */
export const FULLTEXT_MAX_QUERY_TERMS = 48

/**
 * 全文精排的候选窗上限：粗筛（ts_rank，线性成本）保留这么多条，再在其上做
 * ts_rank_cd 精排。实测 10 万命中时粗筛 39ms、500 条精排 <1ms；
 * 该窗口是通道上限（≤100）的 5 倍以上，且与「全量 ts_rank_cd」的前 N 名一致。
 */
export const FULLTEXT_PREFILTER_MAX = 500
/** 候选窗下限：小 limit 时也留足余量，避免粗筛/精排的排序分歧截断前 N。 */
export const FULLTEXT_PREFILTER_MIN = 200
/** 候选窗相对单次查询 limit 的倍数。 */
export const FULLTEXT_PREFILTER_FACTOR = 10

/** 全文粗筛候选窗：max(下限, limit×倍数) 并封顶，保证有界且随 limit 放大。 */
export function fulltextPrefilterCandidates(limit: number): number {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  return Math.min(FULLTEXT_PREFILTER_MAX, Math.max(FULLTEXT_PREFILTER_MIN, safeLimit * FULLTEXT_PREFILTER_FACTOR))
}

/**
 * 精排使用 ts_rank_cd 的查询词上限：与改造前一致（≤8 词保留邻近度，>8 词用线性 ts_rank）。
 * 两阶段只改成本，不改出分口径，否则门控下限（按 ts_rank_cd 量纲标定）会被悄悄改写。
 */
export const FULLTEXT_FINE_TS_RANK_CD_MAX_TERMS = 8

/**
 * 每次召回最多加载多少个 regex 触发键候选。正则只在应用层执行，
 * 候选必须按 kind 索引收窄并有确定序上限，不能退化成无界全表扫描。
 */
export const TRIGGER_REGEX_CANDIDATE_LIMIT = 500

/** tsquery 词面白名单：元字符（& | ! ( ) : * < > ' \）与空白一律丢弃，避免语法错误。 */
const TSQUERY_TERM = /^[\p{L}\p{N}][\p{L}\p{N}_.\-/]*$/u
/** 单词长度上限：sha/uuid/base64 片段仍保留，超长无分隔 blob 不塞进 tsquery 撑大查询。 */
const TSQUERY_TERM_MAX_LENGTH = 256

/**
 * 词形优先级：路径 > 错误码/带数字标识符 > 英文长词 > CJK bigram > 单字。
 * 只在超过上限时用于挑保留哪 48 个词；最终输出顺序始终是原 token 顺序。
 */
function fulltextTermPriority(term: string): number {
  const latin = /[A-Za-z]/.test(term)
  const digit = /\d/.test(term)
  let priority = term.length >= 2 ? 1 : 0
  if (latin && term.length >= 3) priority += 2
  if (latin && digit) priority += 4
  if (/[\\/]/.test(term)) priority += 8
  return priority
}

/**
 * 把 tokenizer 输出收敛成有界 OR 查询词：去重、过滤 tsquery 元字符与超长词，
 * 超过 48 个时优先保留路径/错误码/标识符/长词，最后按原顺序返回（确定性）。
 * SQL 仍用参数化 `to_tsquery('simple', $1)`，词面白名单只防语法错误，不是注入防线。
 */
export function fulltextQueryTerms(tokens: readonly string[]): string[] {
  const seen = new Set<string>()
  const candidates: { term: string; index: number; priority: number }[] = []
  tokens.forEach((raw, index) => {
    const term = raw.trim()
    if (term.length === 0 || term.length > TSQUERY_TERM_MAX_LENGTH) return
    if (!TSQUERY_TERM.test(term)) return
    if (seen.has(term)) return
    seen.add(term)
    candidates.push({ term, index, priority: fulltextTermPriority(term) })
  })
  const selected = candidates
    .sort((left, right) => right.priority - left.priority
      || right.term.length - left.term.length
      || left.index - right.index)
    .slice(0, FULLTEXT_MAX_QUERY_TERMS)
  return selected.sort((left, right) => left.index - right.index).map(item => item.term)
}

export class PostgresStore implements Store {
  readonly db: PostgresDb
  /** 唯一写入口：所有业务表写入都经 AttributeWriter（读路径仍在本类）。 */
  private readonly writer: AttributeWriter
  /** 正则触发匹配统一走 QuickJS 安全服务（ReDoS 防线），本类不直接执行用户正则。 */
  private readonly regex = defaultRegexService

  constructor(connectionString: string) {
    this.db = new PostgresDb({ connectionString })
    this.writer = new AttributeWriter(this.db)
  }

  async close(): Promise<void> {
    await this.db.close()
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw mapPgError(error)
    }
  }

  async write(input: NormalizedWrite, _derived: DerivedWrite): Promise<WriteResult> {
    return this.run(async () => {
      const outcome = await this.writer.execute(
        { type: 'CreateEntity', input },
        systemCommandMeta(input.origin),
      )
      const entity = outcome.entity
      if (entity === undefined) throw new OmbFailure(internal('写入没有返回实体'))
      // 相似建议在写事务之外读（事务内禁止相似查询）；有界候选窗口见 similar.ts。
      const similar = await findSimilar(this.db, {
        entityId: entity.id,
        kind: input.kind,
        attributes: entity.attributes,
        title: titleOf(entity)?.trim() ?? null,
      })
      return { entity, ...similar }
    })
  }

  async patch(input: NormalizedWrite, patch: PatchEntityInput, _derived: DerivedWrite): Promise<PatchResult> {
    return this.run(async () => {
      const outcome = await this.writer.execute(
        { type: 'PatchEntity', input, patch },
        systemCommandMeta(input.origin),
      )
      const entity = outcome.entity
      if (entity === undefined) throw new OmbFailure(internal('更新没有返回实体'))
      return { entity, ...(outcome.history !== undefined ? { history: outcome.history } : {}) }
    })
  }

  async archive(id: string, reason: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.writer.execute({ type: 'ArchiveEntity', id, reason }, systemCommandMeta(actor))
    })
  }

  async unarchive(id: string, reason: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.writer.execute({ type: 'UnarchiveEntity', id, reason }, systemCommandMeta(actor))
    })
  }

  async link(input: {
    fromId: string
    toId: string
    relation: string
    directed?: boolean
    strength?: number
    source?: string
    origin?: string
    allowArchived?: boolean
  }): Promise<LinkResult> {
    return this.run(async () => {
      const outcome = await this.writer.execute(
        { type: 'Link', input },
        systemCommandMeta(input.origin ?? 'model'),
      )
      const link = outcome.link
      if (link === undefined) throw new OmbFailure(internal('链接写入没有返回链接'))
      return { link, created: outcome.linkCreated === true }
    })
  }

  async unlink(id: string, actor: string): Promise<void> {
    await this.run(async () => {
      await this.writer.execute({ type: 'Unlink', linkId: id }, systemCommandMeta(actor))
    })
  }

  async findByAttribute(name: string, value: JsonValue, kind?: EntityKind): Promise<string | undefined> {
    return this.run(async () => {
      const params: unknown[] = [name, JSON.stringify(value)]
      const kindClause = kind === undefined ? '' : `and e.kind = $3`
      if (kind !== undefined) params.push(kind)
      const rows = await this.db.query<{ id: string }>(
        `select e.id
         from omb.entity e
         join omb.attribute a on a.entity_id = e.id
         where e.archived_at is null and a.name = $1 and a.value = $2::jsonb ${kindClause}
         order by e.updated_at desc
         limit 1`,
        params,
      )
      return rows.rows[0]?.id
    })
  }

  async get(id: string, options: ReadOptions = {}): Promise<Entity | undefined> {
    return this.run(async () => {
      const entityResult = await this.db.query<EntityRow>('select * from omb.entity where id = $1', [id])
      const row = entityResult.rows[0]
      if (row === undefined) return undefined
      if (row.archived_at !== null && options.includeArchived !== true) return undefined
      const attributes = await selectAttributes(this.db, id)
      const historyCount = row.kind === 'state'
        ? Number((await this.db.query<{ count: string }>('select count(*)::text as count from omb.entity where version_of = $1', [id])).rows[0]?.count ?? 0)
        : 0
      return mapEntity(row, attributes, historyCount)
    })
  }

  async history(stateId: string, limit: number): Promise<StateVersion[]> {
    return this.run(async () => {
      const rows = await this.db.query<EntityRow>(
        'select * from omb.entity where version_of = $1 order by revision desc limit $2',
        [stateId, Math.max(1, Math.min(100, limit))],
      )
      return Promise.all(rows.rows.map(async row => {
        const attributes = await selectAttributes(this.db, row.id)
        return this.toStateVersion(row, stateId, attributes)
      }))
    })
  }

  private toStateVersion(row: EntityRow, stateId: string, attributes: readonly Attribute[]): StateVersion {
    const valueOf = (name: string): unknown => {
      const attribute = attributes.find(item => item.name === name)
      if (attribute === undefined) return undefined
      return attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue
    }
    return {
      id: row.id,
      stateId,
      revision: Number(row.revision),
      status: (valueOf('status') as StateStatus | undefined) ?? 'not_started',
      title: typeof valueOf('title') === 'string' ? valueOf('title') as string : '',
      time: typeof valueOf('time') === 'string' ? valueOf('time') as string : '',
      attributes,
      ...(iso(row.archived_at) !== undefined ? { archivedAt: iso(row.archived_at) as string } : {}),
      createdAt: iso(row.created_at) as string,
    }
  }

  async expand(seeds: readonly string[], hops: 1 | 2, options: { includeArchived?: boolean } = {}): Promise<Expansion[]> {
    if (seeds.length === 0) return []
    return this.run(async () => {
      const linkRows = await this.db.query<{
        entity_id: string
        hop: number
        score: number
        via_link_id: string
        from_id: string
        relation: string
      }>(
        `with recursive walk (id, hop, score, via_link_id, from_id, relation, path) as (
           select seed, 0, 1.0, null::text, null::text, null::text, array[seed]
           from unnest($1::text[]) as seed
           union all
           select n.next_id,
                  w.hop + 1,
                  w.score * (case when w.hop = 0 then 0.5 else 0.25 end),
                  l.id,
                  w.id,
                  l.relation,
                  w.path || n.next_id
           from walk w
           join omb.link l on l.archived_at is null
             and (l.from_id = w.id or (not l.directed and l.to_id = w.id))
           cross join lateral (
             select case when l.from_id = w.id then l.to_id else l.from_id end as next_id
           ) n
           where w.hop < $2 and not (n.next_id = any(w.path))
         )
         select id as entity_id, min(hop) as hop, max(score) as score,
                (array_agg(via_link_id order by score desc))[1] as via_link_id,
                (array_agg(from_id order by score desc))[1] as from_id,
                (array_agg(relation order by score desc))[1] as relation
         from walk
         where hop > 0
         group by id
         order by score desc
         limit 100`,
        [seeds, hops],
      )

      const chainRows = await this.db.query<{ chain_id: string; member_id: string; seed_id: string }>(
        `with target_chains as (
           select chain_id from omb.chain_member where member_id = any($1::text[])
           union
           select id from unnest($1::text[]) as id
         )
         select cm.chain_id, cm.member_id, cm.chain_id as seed_id
         from omb.chain_member cm
         join target_chains tc on tc.chain_id = cm.chain_id
         where not (cm.member_id = any($1::text[]))`,
        [seeds],
      )

      const byId = new Map<string, Expansion>()
      for (const row of linkRows.rows) {
        byId.set(row.entity_id, {
          entityId: row.entity_id,
          hop: Number(row.hop),
          score: Number(row.score),
          viaLinkId: row.via_link_id,
          fromId: row.from_id,
          relation: row.relation,
        })
      }
      for (const row of chainRows.rows) {
        const existing = byId.get(row.member_id)
        const score = 0.4
        if (existing === undefined || existing.score < score) {
          byId.set(row.member_id, {
            entityId: row.member_id,
            hop: 1,
            score,
            viaLinkId: `chain:${row.chain_id}`,
            fromId: row.seed_id,
            relation: 'chain',
            chainId: row.chain_id,
          })
        } else if (existing.chainId === undefined) {
          byId.set(row.member_id, { ...existing, chainId: row.chain_id })
        }
      }
      if (options.includeArchived !== true && byId.size > 0) {
        const ids = [...byId.keys()]
        const active = await this.db.query<{ entity_id: string }>(
          'select entity_id from omb.entity_view where entity_id = any($1::text[]) and archived_at is null',
          [ids],
        )
        const activeIds = new Set(active.rows.map(row => row.entity_id))
        for (const id of ids) if (!activeIds.has(id)) byId.delete(id)
      }
      return [...byId.values()].sort((left, right) => right.score - left.score)
    })
  }

  async summaries(ids: readonly string[]): Promise<EntitySummary[]> {
    if (ids.length === 0) return []
    return this.run(async () => {
      const rows = await this.db.query<ViewRow & { history_count: number }>(
        `select v.*, (select count(*)::int from omb.entity h where h.version_of = v.entity_id) as history_count
         from omb.entity_view v
         where v.entity_id = any($1::text[])`,
        [ids],
      )
      return rows.rows.map(row => ({
        id: row.entity_id,
        kind: row.kind,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.category !== null ? { category: row.category } : {}),
        ...(row.status !== null ? { status: row.status } : {}),
        scope: row.scope === 'global' ? { kind: 'global' as const } : { kind: 'project' as const, projectKey: row.project_key },
        snippet: row.snippet,
        archived: row.archived_at !== null,
        isCurrent: row.is_current,
        ...(row.event_time === null ? {} : { eventTime: iso(row.event_time) as string }),
        updatedAt: iso(row.updated_at) as string,
        historyCount: Number(row.history_count),
      }))
    })
  }

  async preferenceSummaries(limit: number): Promise<EntitySummary[]> {
    return this.run(async () => {
      const rows = await this.db.query<ViewRow & { history_count: number }>(
        `select v.*, 0 as history_count
         from omb.entity_view v
         join omb.entity e on e.id = v.entity_id
         where v.kind = 'memory' and v.scope = 'global'
           and v.archived_at is null and v.is_current
           and (v.attrs @> '{"tags":["偏好"]}'::jsonb or v.attrs->>'标签' = '偏好')
         order by e.salience desc, v.updated_at desc
         limit $1`,
        [Math.max(1, Math.min(20, limit))],
      )
      return rows.rows.map(row => ({
        id: row.entity_id,
        kind: row.kind,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.category !== null ? { category: row.category } : {}),
        ...(row.status !== null ? { status: row.status } : {}),
        scope: { kind: 'global' as const },
        snippet: row.snippet,
        archived: false,
        isCurrent: true,
        ...(row.event_time === null ? {} : { eventTime: iso(row.event_time) as string }),
        updatedAt: iso(row.updated_at) as string,
        historyCount: 0,
      }))
    })
  }

  async upsertEmbedding(entityId: string, model: string, dims: number, embedding: readonly number[]): Promise<void> {
    if (embedding.length !== 512) throw new OmbFailure(internal('向量维度必须是 512'))
    await this.run(async () => {
      // check:ignore-next-line sec-sql-concat -- 四个值全部是 $1..$4 参数，模板无外部片段
      await this.db.query(
        `insert into omb.embedding (entity_id, model, dims, embedding)
         values ($1,$2,$3,$4::vector)
         on conflict (entity_id) do update
           set model = excluded.model, dims = excluded.dims, embedding = excluded.embedding, updated_at = now()`,
        [entityId, model, dims, `[${embedding.join(',')}]`],
      )
    })
  }

  async deleteEmbedding(entityId: string): Promise<void> {
    await this.run(async () => {
      await this.db.query('delete from omb.embedding where entity_id = $1', [entityId])
    })
  }

  async setAttributeCache(
    entityId: string,
    name: string,
    ordinal: number,
    value: JsonValue | undefined,
    cachedAt: string,
    error?: string,
  ): Promise<void> {
    await this.run(() => this.writer.setAttributeCache(entityId, name, ordinal, value, cachedAt, error))
  }

  async rebuildView(id: string): Promise<void> {
    await this.run(() => this.writer.rebuildView(id))
  }

  async recordRecall(events: readonly RecallEventInput[]): Promise<void> {
    if (events.length === 0) return
    await this.run(async () => {
      for (const event of events) {
        await this.db.query(
          `insert into omb.recall_event (
             trace_id, session_id, turn_id, query, trigger, entity_id, channel, rank,
             raw_score, fused_score, injected, injected_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                     case when $11 then now() else null end)`,
          [
            event.traceId,
            event.sessionId ?? null,
            event.turnId ?? null,
            event.query ?? null,
            event.trigger ?? null,
            event.entityId,
            event.channel,
            event.rank,
            event.rawScore ?? null,
            event.fusedScore ?? null,
            event.injected,
          ],
        )
      }
    })
  }

  async recordResidentTrace(trace: ResidentTraceInput): Promise<void> {
    await this.run(async () => {
      await this.db.query(
        `insert into omb.resident_trace (
           trace_id, session_id, turn_id, budget_tokens, used_tokens, text, sections, dropped_sections
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[])
         on conflict (trace_id) do nothing`,
        [
          trace.traceId,
          trace.sessionId ?? null,
          trace.turnId ?? null,
          trace.budgetTokens,
          trace.usedTokens,
          trace.text,
          JSON.stringify(trace.sections),
          [...trace.droppedSections],
        ],
      )
    })
  }

  async markAccessed(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.run(async () => {
      // check:ignore-next-line sec-sql-concat -- id 列表走 $1::text[] 参数，模板无外部片段
      await this.db.query(
        `update omb.entity
         set access_count = access_count + 1, last_accessed_at = now()
         where id = any($1::text[])`,
        [ids],
      )
    })
  }

  async markAdopted(traceId: string, entityId: string, kind: string): Promise<void> {
    await this.run(async () => {
      await this.db.transaction(async client => {
        const updated = await client.query(
          `update omb.recall_event
           set adopted_at = now(), adoption_kind = $3
           where trace_id = $1 and entity_id = $2 and adopted_at is null`,
          [traceId, entityId, kind],
        )
        if (updated.rowCount !== null && updated.rowCount > 0) {
          // check:ignore-next-line sec-sql-concat -- entityId 走 $1 参数，模板是常量 SQL
          await client.query('update omb.entity set adoption_count = adoption_count + 1 where id = $1', [entityId])
        }
      })
    })
  }

  async recordArtifact(input: ArtifactInput): Promise<void> {
    await this.run(async () => {
      await this.db.query(
        `insert into omb.artifact (id, session_id, kind, content, source, metadata)
         values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (id) do nothing`,
        [
          input.id,
          input.sessionId ?? null,
          input.kind,
          input.content,
          input.source ?? 'dsh',
          input.metadata === undefined ? '{}' : JSON.stringify(input.metadata),
        ],
      )
    })
  }

  async listArtifacts(limit: number): Promise<ArtifactRecord[]> {
    return this.run(async () => {
      const rows = await this.db.query<{
        id: string
        session_id: string | null
        kind: string
        content: string
        source: string
        metadata: JsonValue
        created_at: Date | string
      }>(
        `select id, session_id, kind, content, source, metadata, created_at
         from omb.artifact where processed_at is null
         order by created_at asc limit $1`,
        [Math.max(1, Math.min(200, limit))],
      )
      return rows.rows.map(row => ({
        id: row.id,
        ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
        kind: row.kind,
        content: row.content,
        source: row.source,
        metadata: row.metadata,
        createdAt: iso(row.created_at) as string,
      }))
    })
  }

  async markArtifactProcessed(id: string): Promise<void> {
    await this.run(async () => {
      await this.db.query('update omb.artifact set processed_at = now() where id = $1', [id])
    })
  }

  async stats(): Promise<{
    memory: number
    state: number
    chain: number
    archived: number
    attrNames: readonly string[]
    categories: Record<'fact' | 'clue' | 'event', number>
    scopes: { global: number; project: number }
    recentStates: Array<{ id: string; title?: string; status: string }>
  }> {
    return this.run(async () => {
      const counts = await this.db.query<{ kind: string; count: string; archived: string }>(
        `select kind, count(*) filter (where archived_at is null)::text as count,
                count(*) filter (where archived_at is not null)::text as archived
         from omb.entity group by kind`,
      )
      const byKind = new Map(counts.rows.map(row => [row.kind, row]))
      const attrs = await this.db.query<{ name: string }>(
        'select name from omb.attr_registry order by usage_count desc, name asc limit 12',
      )
      const facets = await this.db.query<{ category: string | null; scope: string; count: string }>(
        `select category, scope, count(*)::text as count
         from omb.entity_view where archived_at is null group by category, scope`,
      )
      const categories = { fact: 0, clue: 0, event: 0 }
      const scopes = { global: 0, project: 0 }
      for (const row of facets.rows) {
        const count = Number(row.count)
        if (row.category === 'fact' || row.category === 'clue' || row.category === 'event') categories[row.category] += count
        if (row.scope === 'global') scopes.global += count
        else scopes.project += count
      }
      const states = await this.db.query<{ id: string; title: string | null; status: string }>(
        `select entity_id as id, title, status
         from omb.entity_view
         where kind = 'state' and archived_at is null and status is not null
         order by updated_at desc limit 3`,
      )
      return {
        memory: Number(byKind.get('memory')?.count ?? 0),
        state: Number(byKind.get('state')?.count ?? 0),
        chain: Number(byKind.get('chain')?.count ?? 0),
        archived: counts.rows.reduce((sum, row) => sum + Number(row.archived), 0),
        attrNames: attrs.rows.map(row => row.name),
        categories,
        scopes,
        recentStates: states.rows.map(row => ({
          id: row.id,
          ...(row.title !== null ? { title: row.title } : {}),
          status: row.status,
        })),
      }
    })
  }

  async listAudit(limit: number, targetId?: string): Promise<AuditRecord[]> {
    return this.run(async () => {
      const rows = await this.db.query<{
        id: string
        actor: string
        action: string
        target_ids: string[]
        inverse: JsonValue | null
        created_at: Date | string
        rolled_back_at: Date | string | null
      }>(
        `select id, actor, action, target_ids, inverse, created_at, rolled_back_at
         from omb.audit_log
         where ($2::text is null or $2 = any(target_ids))
         order by id desc limit $1`,
        [Math.max(1, Math.min(200, limit)), targetId ?? null],
      )
      return rows.rows.map(row => ({
        id: Number(row.id),
        actor: row.actor,
        action: row.action,
        targetIds: row.target_ids,
        ...(row.inverse !== null ? { inverse: row.inverse } : {}),
        createdAt: iso(row.created_at) as string,
        ...(iso(row.rolled_back_at) !== undefined ? { rolledBackAt: iso(row.rolled_back_at) as string } : {}),
      }))
    })
  }

  async rollback(auditId: number, actor: string): Promise<RollbackResult> {
    return this.run(() => this.writer.rollback(auditId, actor))
  }

  // 检索通道由本类的独立查询实现，避免把图/融合逻辑塞进 Store。
  async fulltext(spec: TextSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchFulltext(spec))
  }

  async triggers(spec: TriggerSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchTriggers(spec))
  }

  async singleChar(spec: TextSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchSingleChar(spec))
  }

  async vector(spec: VectorSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchVector(spec))
  }

  async time(spec: TimeSearchSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchTime(spec))
  }

  async stateBoard(spec: StateBoardSpec): Promise<ChannelHit[]> {
    return this.run(() => this.searchStateBoard(spec))
  }

  private scopeClause(spec: TextSearchSpec | VectorSearchSpec | TimeSearchSpec | StateBoardSpec | TriggerSearchSpec, params: unknown[]): string {
    const clauses: string[] = []
    if (spec.includeHistory !== true) clauses.push('v.is_current = true')
    if (spec.includeArchived !== true) clauses.push('v.archived_at is null')
    if (spec.kind !== undefined) {
      params.push(spec.kind)
      clauses.push(`v.kind = $${params.length}`)
    }
    if (spec.category !== undefined) {
      params.push(spec.category)
      clauses.push(`v.category = $${params.length}`)
    }
    if (spec.status !== undefined && spec.status.length > 0) {
      params.push(spec.status)
      clauses.push(`v.status = any($${params.length}::text[])`)
    }
    if (spec.scope === 'global') clauses.push(`v.scope = 'global'`)
    if (spec.scope === 'project') {
      clauses.push(`v.scope = 'project'`)
      if (spec.projectKey !== undefined) {
        params.push(spec.projectKey)
        clauses.push(`v.project_key = $${params.length}`)
      }
    }
    return clauses.length > 0 ? `and ${clauses.join(' and ')}` : ''
  }

  /**
   * 两阶段排序（ADR-0013 性能预算）：粗筛用线性成本的 `ts_rank` 取出有界候选窗，
   * 再在候选窗上用改造前同一个精排函数出分。
   *
   * 为什么必须两段：
   * - CJK 查询会被 tokenize 成单字 + bigram 的 OR 词表，单字在真实语料里几乎命中全表。
   *   10 万命中实测：ts_rank_cd 163ms / ts_rank 38ms（cover-density 成本随 OR 词数与命中
   *   文档数超线性增长，ts_rank 是线性的），单段 ts_rank_cd 无法在阶段一预算内完成。
   * - 出分口径不能换：ts_rank 会按 OR 词数摊薄（0.0608×命中词数/查询词数），长查询里只
   *   共享一个词的记忆会掉到 channelFloors.fulltext（0.02）以下被静默淘汰；ts_rank_cd 的
   *   覆盖密度按命中词累计（每词 0.1），门控/融合分/explain 都按这个量纲标定。
   * - 候选窗（`fulltextPrefilterCandidates`）远大于通道上限（≤100）与默认 limit，
   *   500 条的精排成本可忽略；10 万命中夹具上与「全量 ts_rank_cd」的前 50 名一致。
   */
  private async searchFulltext(spec: TextSearchSpec): Promise<ChannelHit[]> {
    // 全 AND（tokens.join(' & ')）会让长工具输出/自然语言几乎恒零命中（RET-02）：
    // 改成有界 OR，由 fulltextQueryTerms 负责去重、白名单与词数上限。
    const terms = fulltextQueryTerms(spec.tokens)
    if (terms.length === 0) return []
    const params: unknown[] = [terms.join(' | ')]
    const filter = this.scopeClause(spec, params)
    const limit = Math.max(1, Math.min(100, spec.limit))
    const prefilter = fulltextPrefilterCandidates(limit)
    params.push(prefilter)
    const prefilterParam = `$${params.length}`
    params.push(limit)
    // 精排函数与改造前一致（短查询 ts_rank_cd 保留邻近度、长查询 ts_rank 控成本），
    // 保证门控与融合分的量纲不变；粗筛恒用线性成本的 ts_rank。
    const fineRank = terms.length <= FULLTEXT_FINE_TS_RANK_CD_MAX_TERMS ? 'ts_rank_cd' : 'ts_rank'
    const sql =
      `select c.entity_id, ${fineRank}(c.search_tsv, q) as raw
       from (
         select v.entity_id, v.search_tsv, v.updated_at, ts_rank(v.search_tsv, q) as coarse
         from omb.entity_view v, to_tsquery('simple', $1) q
         where v.search_tsv @@ q ${filter}
         order by coarse desc, v.updated_at desc, v.entity_id asc
         limit ${prefilterParam}
       ) as c, to_tsquery('simple', $1) q
       order by raw desc, c.updated_at desc, c.entity_id asc
       limit $${params.length}`
    // 这条查询是全库扫描 + 排序：并行执行在 Windows/PG17 上会给 p95 带来 ~+75ms 的
    // worker 启动尾延迟（实测 p50 51ms/p95 127ms，串行 p50 75ms/p95 90ms）。阶段一预算
    // 按 p95 判定，所以固定串行执行，用事务级 `set local` 只影响本语句。
    const rows = await this.db.transaction(async client => {
      await client.query('set local max_parallel_workers_per_gather = 0')
      return client.query<{ entity_id: string; raw: number }>(sql, params)
    })
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'fulltext' }))
  }

  private async searchSingleChar(spec: TextSearchSpec): Promise<ChannelHit[]> {
    if (spec.query.trim().length === 0) return []
    const params: unknown[] = [spec.query.trim()]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(20, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      // datctype=C 的库里 similarity('中文','中') 恒为 0，不能拿它当 rawScore；
      // chars GIN 给出覆盖全文的候选（不再用 240 字 snippet 复核，否则尾部字符必漏，RET-01）；
      // search_text 是 tokenize 后以空格分隔的词，去空格近似原文，用于给连续子串更高 raw。
      `select v.entity_id,
              case when strpos(replace(v.search_text, ' ', ''), $1) > 0 then 1.0 else 0.5 end as raw
       from omb.entity_view v
       where v.chars @> string_to_array($1, NULL) ${filter}
       order by raw desc, v.updated_at desc, v.entity_id asc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'single_char' }))
  }

  private async searchVector(spec: VectorSearchSpec): Promise<ChannelHit[]> {
    if (spec.embedding.length !== 512) throw new OmbFailure(internal('向量维度必须是 512'))
    const params: unknown[] = [`[${spec.embedding.join(',')}]`]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(100, spec.limit)))
    return this.db.transaction(async client => {
      // pgvector 过滤在 HNSW 扫描之后发生；不开迭代扫描会静默少返回。
      await client.query("set local hnsw.iterative_scan = 'relaxed_order'")
      const rows = await client.query<{ entity_id: string; raw: number }>(
        `select v.entity_id, 1 - (e.embedding <=> $1::vector) as raw
         from omb.embedding e
         join omb.entity_view v on v.entity_id = e.entity_id
         where true ${filter}
         order by e.embedding <=> $1::vector
         limit $${params.length}`,
        params,
      )
      return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'vector' }))
    })
  }

  private async searchTime(spec: TimeSearchSpec): Promise<ChannelHit[]> {
    const params: unknown[] = [spec.from, spec.to, spec.now]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(100, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      `select v.entity_id,
              1.0 / (1.0 + greatest(0, extract(epoch from ($3::timestamptz - v.event_time)) / 86400.0 / 30.0)) as raw
       from omb.entity_view v
       where v.event_time >= $1::timestamptz and v.event_time <= $2::timestamptz ${filter}
       order by v.event_time desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'time' }))
  }

  private async searchStateBoard(spec: StateBoardSpec): Promise<ChannelHit[]> {
    const params: unknown[] = [spec.now]
    const filter = this.scopeClause(spec, params)
    params.push(Math.max(1, Math.min(50, spec.limit)))
    const rows = await this.db.query<{ entity_id: string; raw: number }>(
      `select v.entity_id,
              case v.status when 'blocked' then 1.0 when 'in_progress' then 0.9 when 'waiting' then 0.7 else 0.5 end
              + 0.1 / (1.0 + greatest(0, extract(epoch from ($1::timestamptz - v.event_time)) / 86400.0 / 30.0)) as raw
       from omb.entity_view v
       where v.kind = 'state' and v.status in ('in_progress','blocked','waiting') ${filter}
       order by raw desc, v.updated_at desc
       limit $${params.length}`,
      params,
    )
    return rows.rows.map((row, index) => ({ entityId: row.entity_id, rank: index + 1, rawScore: Number(row.raw), channel: 'state_board' }))
  }

  private async searchTriggers(spec: TriggerSearchSpec): Promise<ChannelHit[]> {
    const scores = new Map<string, number>()
    if (spec.keys.length > 0) {
      const params: unknown[] = [spec.keys]
      const filter = this.scopeClause(spec, params)
      // 不能写成 `where t.key = any($1)`：trigger_key 现有索引是 (kind, key)，
      // 没有 key 前导列时会退化成全表扫描。把候选键展开成 (kind,key) 等值探针后，
      // 走 trigger_key_lookup 索引；仍是单条参数化查询，无 N+1。
      const rows = await this.db.query<{ entity_id: string; raw: number }>(
        `select t.entity_id, sum(t.weight) as raw
         from (select distinct key from unnest($1::text[]) as input(key)) as cand
         cross join (values ('path'),('tool'),('error'),('entity'),('text')) as k(kind)
         join omb.trigger_key t on t.kind = k.kind and t.key = cand.key
         join omb.entity_view v on v.entity_id = t.entity_id
         where true ${filter}
         group by t.entity_id
         order by raw desc
         limit 50`,
        params,
      )
      for (const row of rows.rows) scores.set(row.entity_id, Math.max(scores.get(row.entity_id) ?? 0, Number(row.raw)))
    }
    if (spec.regexText !== undefined && spec.regexText.trim().length > 0) {
      const filterParams: unknown[] = []
      const filter = this.scopeClause(spec, filterParams)
      // 正则只在应用层执行（SPEC §7.1）；候选先按 trigger_key(kind,key) 索引收窄到 regex 类，
      // 并且只取 scope/kind 过滤后的实体。固定上限 + 确定序，避免无 order by 时按物理顺序静默截断。
      const rows = await this.db.query<{ entity_id: string; key: string; weight: number }>(
        `select t.entity_id, t.key, t.weight
         from omb.trigger_key t
         join omb.entity_view v on v.entity_id = t.entity_id
         where t.kind = 'regex' ${filter}
         order by t.entity_id asc, t.key asc
         limit ${TRIGGER_REGEX_CANDIDATE_LIMIT}`,
        filterParams,
      )
      if (rows.rows.length > 0) {
        // 用户正则一律在 QuickJS 沙箱执行：单条 50ms 上限 + 输入/源码/候选上限 + 并发上限。
        // 静态检查只做快速拒绝；超时说明存在病态正则，降级为“本通道只按字面触发键匹配”，
        // 由 channels 记录 channel error 并重试一次，不能因为一条正则丢掉路径/错误码等字面命中。
        const entries = rows.rows.map((row, index) => {
          const { source, flags } = decodeRegexTriggerKey(row.key)
          const candidate: RegexCandidate = {
            id: String(index),
            source,
            ...(flags === undefined ? {} : { flags }),
          }
          return { candidate, entityId: row.entity_id, weight: Number(row.weight) }
        })
        const outcome = await this.regex.match({
          input: spec.regexText,
          candidates: entries.map(entry => entry.candidate),
        })
        if (outcome.status === 'timeout') {
          throw new OmbFailure({
            code: 'sandbox-timeout',
            message: `正则触发匹配超过 ${REGEX_TIMEOUT_MS}ms CPU 上限，已降级为仅按字面触发键匹配`,
            retryable: false,
          })
        }
        if (outcome.status === 'ok') {
          for (const id of outcome.matchedIds) {
            const entry = entries[Number(id)]
            if (entry === undefined) continue
            scores.set(entry.entityId, Math.max(scores.get(entry.entityId) ?? 0, entry.weight * 1.2))
          }
        }
        // invalid-input/busy/engine-error：正则分支本次跳过，字面触发键结果照常返回。
      }
    }
    return [...scores.entries()]
      .sort((left, right) => right[1] - left[1]
        || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .slice(0, Math.max(1, Math.min(50, spec.limit)))
      .map(([entityId, raw], index) => ({ entityId, rank: index + 1, rawScore: raw, channel: 'trigger' }))
  }
}
