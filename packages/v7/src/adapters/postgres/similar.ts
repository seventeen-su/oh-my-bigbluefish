import type { Attribute, Category, EntityKind, StateStatus } from '../../domain/entity.js'
import { tokenize } from '../../domain/text.js'
import type { SimilarAttribute, SimilarEntity } from '../../ports/store.js'
import { asNumber, type PostgresDb } from './db.js'

/**
 * 写后相似建议（有界索引查询）。
 *
 * 语义（ADR-0013）：
 * - 候选窗口：`entity_view.search_tsv @@ to_tsquery(...)` 命中（GIN 索引 `entity_view_search_tsv`），
 *   单条 SQL 内 `limit SIMILAR_CANDIDATE_LIMIT` 收成有界窗口；窗口内的判定仍是旧的精确谓词
 *   （「至少 2 个长度 ≥2 的 token 交集」），不把窗口外的行算进来，也不伪造分数。
 * - 结果：活跃候选按 snippet 相似度取前 `SIMILAR_ENTITY_LIMIT`，归档候选从**同一窗口**取前
 *   `SIMILAR_ARCHIVED_LIMIT`（活跃候选占满窗口时归档候选可能为空，这是有界近似的固有代价）。
 * - 窗口外的相似行可能不被发现——写入不被相似查询拖慢（预算 p95 ≤50ms），省略而不是伪造。
 * - 本模块只读；写事务内不调用（writer 不 import 本模块）。
 */

/** 候选窗口行数上限：决定一次相似查询最多评分多少行，而不是返回多少行。 */
export const SIMILAR_CANDIDATE_LIMIT = 200
/** 活跃相似记忆返回上限。 */
export const SIMILAR_ENTITY_LIMIT = 8
/** 归档相似候选返回上限。 */
export const SIMILAR_ARCHIVED_LIMIT = 3
/** 相似属性名返回上限。 */
export const SIMILAR_ATTRIBUTE_LIMIT = 10
/** 相似查询词上限：与调用方 tokenize 的 64 词上限一致。 */
export const SIMILAR_QUERY_TOKEN_LIMIT = 64
/** 单个查询词长度上限：超长无分隔 blob 不塞进 tsquery。 */
const SIMILAR_QUERY_TOKEN_MAX_LENGTH = 256
/** 相似度打分使用的正文片段长度（snippet 相似度只在短文本上有意义）。 */
const SIMILAR_SEARCH_TEXT_MAX = 240
/** tsquery 词面白名单：分词器只会产出字母/数字/CJK，这里再兜一层语法安全。 */
const TSQUERY_TOKEN = /^[\p{L}\p{N}]+$/u

export interface SimilarInput {
  readonly entityId: string
  readonly kind: EntityKind
  readonly attributes: readonly Attribute[]
  readonly title: string | null
}

export interface SimilarQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

export interface SimilarResult {
  readonly similarAttributes: readonly SimilarAttribute[]
  readonly similarEntities: readonly SimilarEntity[]
  readonly archivedMatches: readonly SimilarEntity[]
}

interface CandidateRow {
  entity_id: string
  kind: EntityKind
  category: Category | null
  scope: 'global' | 'project'
  project_key: string
  title: string | null
  status: StateStatus | null
  archived_at: Date | string | null
  similarity: number | string | null
  position: number | string
}

/** 必填属性不参与相似判定：它们的值（事实/fact、进行中）不区分实体。 */
function optionalAttributes(attributes: readonly Attribute[]): Attribute[] {
  return attributes.filter(attribute => !attribute.required)
}

/** 可选属性拼成相似查询正文；`title` 只在正文为空时兜底（与旧实现等价）。 */
function searchTextOf(attributes: readonly Attribute[], title: string | null): string {
  const text = optionalAttributes(attributes)
    .map(attribute => attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue)
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .map(value => typeof value === 'string' ? value : JSON.stringify(value))
    .join('\n')
  return text.slice(0, SIMILAR_SEARCH_TEXT_MAX) || title || ''
}

/** 只从可选属性取查询词；共享至少两个长度 ≥2 的 token 才算相似。 */
function queryTokensOf(attributes: readonly Attribute[]): string[] {
  const text = optionalAttributes(attributes)
    .map(attribute => attribute.value.kind === 'static' ? attribute.value.value : attribute.value.cachedValue)
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .map(value => typeof value === 'string' ? value : JSON.stringify(value))
    .join('\n')
  return tokenize(text, SIMILAR_QUERY_TOKEN_LIMIT)
    .filter(token => token.length >= 2 && token.length <= SIMILAR_QUERY_TOKEN_MAX_LENGTH && TSQUERY_TOKEN.test(token))
}

/**
 * 单条候选窗口查询：GIN 命中 + 有界窗口 + 窗口内精确 token 交集 + 分区排名。
 *
 * 返回 `undefined` 表示没有可用查询词（无可选属性文本），调用方直接返回空建议；
 * 不能把空查询词拼成 `to_tsquery('')`（会抛语法错误）。
 */
export function similarCandidateQuery(input: SimilarInput): SimilarQuery | undefined {
  const tokens = queryTokensOf(input.attributes)
  if (tokens.length === 0) return undefined
  const search = searchTextOf(input.attributes, input.title)
  const minShared = Math.min(2, tokens.length)
  return {
    text: `
      with candidates as materialized (
        select v.entity_id, v.kind, v.category, v.scope, v.project_key, v.title, v.status,
               v.archived_at, v.updated_at, v.snippet, v.search_text
        from omb.entity_view v
        where v.entity_id <> $1
          and v.kind = $2
          and v.search_tsv @@ to_tsquery('simple', $3)
        limit $4
      ),
      matched as materialized (
        select c.*
        from candidates c
        where (
          select count(*)
          from unnest(string_to_array(c.search_text, ' ')) as token(value)
          where token.value = any($6::text[])
        ) >= $7
      ),
      ranked as (
        select m.entity_id, m.kind, m.category, m.scope, m.project_key, m.title, m.status,
               m.archived_at,
               similarity(m.snippet, $5) as similarity,
               row_number() over (
                 partition by (m.archived_at is not null)
                 order by similarity(m.snippet, $5) desc, m.updated_at desc, m.entity_id asc
               ) as position
        from matched m
      )
      select entity_id, kind, category, scope, project_key, title, status, archived_at,
             similarity::float8 as similarity, position::int as position
      from ranked
      where (archived_at is null and position <= $8)
         or (archived_at is not null and position <= $9)
      order by (archived_at is not null) asc, position asc
    `,
    values: [
      input.entityId,
      input.kind,
      tokens.join(' | '),
      SIMILAR_CANDIDATE_LIMIT,
      search,
      tokens,
      minShared,
      SIMILAR_ENTITY_LIMIT,
      SIMILAR_ARCHIVED_LIMIT,
    ],
  }
}

function toSimilar(row: CandidateRow): SimilarEntity {
  const similarity = asNumber(row.similarity) ?? 0
  return {
    id: row.entity_id,
    kind: row.kind,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.category !== null ? { category: row.category } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    scope: row.scope === 'global' ? { kind: 'global' } : { kind: 'project', projectKey: row.project_key },
    archived: row.archived_at !== null,
    score: row.archived_at !== null ? 1 : similarity,
    reason: row.archived_at !== null ? 'archived-similar' : 'text-or-attribute-overlap',
  }
}

function similarAttributesQuery(names: readonly string[]): SimilarQuery {
  return {
    text: `
      select r.name, r.usage_count,
             max(greatest(
               similarity(r.name, q.name),
               case when q.name = any(r.aliases) then 1.0 else 0.0 end
             )) as similarity
      from omb.attr_registry r
      cross join unnest($1::text[]) as q(name)
      where similarity(r.name, q.name) >= 0.35 or q.name = any(r.aliases)
      group by r.name, r.usage_count
      order by similarity desc, r.usage_count desc
      limit ${SIMILAR_ATTRIBUTE_LIMIT}
    `,
    values: [names],
  }
}

/**
 * 读一组相似建议：相似属性名 + 活跃相似实体 + 归档候选。
 *
 * `queryable` 是池连接：写事务已提交后才调用（`PostgresStore.write`），
 * 事务内不做相似查询；单次最多 2 条语句、无 N+1。
 */
export async function findSimilar(queryable: { query: PostgresDb['query'] }, input: SimilarInput): Promise<SimilarResult> {
  const attributeNames = optionalAttributes(input.attributes).map(attribute => attribute.name)
  const attributesQuery = attributeNames.length > 0 ? similarAttributesQuery(attributeNames) : undefined
  const similarAttributes = attributesQuery === undefined
    ? []
    : (await queryable.query<{ name: string; usage_count: number; similarity: number }>(
      attributesQuery.text,
      attributesQuery.values,
    )).rows.map(row => ({
      name: row.name,
      usageCount: Number(row.usage_count),
      similarity: Number(row.similarity),
    }))

  const candidateQuery = similarCandidateQuery(input)
  if (candidateQuery === undefined) {
    return { similarAttributes, similarEntities: [], archivedMatches: [] }
  }
  const rows = (await queryable.query<CandidateRow>(candidateQuery.text, candidateQuery.values)).rows
  const similarEntities: SimilarEntity[] = []
  const archivedMatches: SimilarEntity[] = []
  for (const row of rows) {
    if (row.archived_at === null) similarEntities.push(toSimilar(row))
    else archivedMatches.push(toSimilar(row))
  }
  return { similarAttributes, similarEntities, archivedMatches }
}
