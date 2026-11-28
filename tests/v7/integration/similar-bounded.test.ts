import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  findSimilar,
  similarCandidateQuery,
  SIMILAR_ARCHIVED_LIMIT,
  SIMILAR_CANDIDATE_LIMIT,
  SIMILAR_ENTITY_LIMIT,
} from '../../../packages/v7/src/adapters/postgres/similar.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 写后相似建议的有界语义（ADR-0013 / PLAN Phase 1 Task 8）：
 * - 不再对 entity_view 做无界相似扫描：候选是 `search_tsv` 命中的有界窗口，
 *   窗口内仍按旧的精确谓词（≥2 个长度≥2 的 token 交集）判定；
 * - 返回条数有上限，归档候选单独限条，自身永远排除；
 * - 无可选文本时不拼空 tsquery、不抛错，直接返回空建议。
 */

const SIMILAR_BODY = '批量 相似 候选 记忆正文'
const CANDIDATES = 220

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Rows'?: number
  Plans?: PlanNode[]
}

function walkPlan(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node)
  for (const child of node.Plans ?? []) walkPlan(child, visit)
}

function memory(title: string, body: string): WriteEntityInput {
  return { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title, body } }
}

describe('写后相似建议（有界候选窗口，真实 PostgreSQL）', () => {
  let db: ReturnType<typeof store>

  beforeAll(async () => {
    await prepareDatabase()
    db = store()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await resetDatabase()
    await db.close()
  })

  /** 用真实写入路径造候选：search_text/entity_view 都由 store.write 派生。 */
  async function seedCandidates(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const input = memory(`相似候选 ${index}`, `${SIMILAR_BODY} ${index}`)
      await db.write(normalized(input), derived(input))
    }
  }

  it('给定只有单字可选文本当构造相似查询则返回 undefined（不拼空 tsquery）', () => {
    const input = normalized(memory('雨', '雨'))
    const query = similarCandidateQuery({
      entityId: input.id,
      kind: 'memory',
      attributes: input.attributes,
      title: null,
    })
    expect(query).toBeUndefined()
  })

  it('给定 220 条候选项当构造相似查询则计划走 tsvector GIN 且只触碰有界窗口', async () => {
    await seedCandidates(CANDIDATES)
    const probe = normalized(memory('相似候选 探测', `${SIMILAR_BODY} 探测`))
    const query = similarCandidateQuery({
      entityId: probe.id,
      kind: 'memory',
      attributes: probe.attributes,
      title: null,
    })
    expect(query).toBeDefined()
    if (query === undefined) return

    const plans = await db.db.transaction(async client => {
      await client.query('set local enable_seqscan = off')
      const result = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
        `explain (analyze, format json) ${query.text}`,
        [...query.values],
      )
      return result.rows[0]?.['QUERY PLAN'] ?? []
    })
    const nodes: PlanNode[] = []
    for (const plan of plans) walkPlan(plan.Plan, node => nodes.push(node))

    const entityViewScans = nodes.filter(node => node['Relation Name'] === 'entity_view' && node['Node Type'].includes('Scan'))
    expect(entityViewScans.length).toBeGreaterThan(0)
    // 窗口上限：无论命中多少行，扫描节点最多只交出 CANDIDATE_LIMIT 行。
    for (const node of entityViewScans) {
      expect(node['Actual Rows'] ?? 0).toBeLessThanOrEqual(SIMILAR_CANDIDATE_LIMIT)
    }
    // 强制关掉 seqscan 后必须能走 search_tsv 的 GIN 索引（没有全表扫描兜底）。
    expect(nodes.some(node => node['Index Name'] === 'entity_view_search_tsv')).toBe(true)
    expect(nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'entity_view')).toBe(false)

    const similar = await findSimilar(db.db, {
      entityId: probe.id,
      kind: 'memory',
      attributes: probe.attributes,
      title: null,
    })
    expect(similar.similarEntities).toHaveLength(SIMILAR_ENTITY_LIMIT)
    const ids = new Set(similar.similarEntities.map(item => item.id))
    expect(ids.size).toBe(SIMILAR_ENTITY_LIMIT)
    expect([...ids]).not.toContain(probe.id)
    expect(similar.archivedMatches).toEqual([])
    for (const item of similar.similarEntities) {
      expect(item.kind).toBe('memory')
      expect(item.archived).toBe(false)
      expect(item.score).toBeGreaterThanOrEqual(0)
      expect(item.score).toBeLessThanOrEqual(1)
    }
  })

  it('给定候选多于窗口当真实写入则只返回有界条数且都指向真实活跃实体', async () => {
    await seedCandidates(CANDIDATES)
    const input = memory('相似候选 写入', `${SIMILAR_BODY} 写入`)
    const written = await db.write(normalized(input), derived(input))
    expect(written.similarEntities).toHaveLength(SIMILAR_ENTITY_LIMIT)
    expect(written.similarEntities.every(item => item.id !== written.entity.id)).toBe(true)
    const ids = written.similarEntities.map(item => item.id)
    const rows = await db.db.query<{ id: string; archived_at: string | null }>(
      'select id, archived_at from omb.entity where id = any($1::text[])',
      [ids],
    )
    expect(rows.rows).toHaveLength(new Set(ids).size)
    expect(rows.rows.every(row => row.archived_at === null)).toBe(true)
  })

  it('给定归档的相似记忆当写入则归档候选单独限条且分数固定为 1', async () => {
    const archivedInput = memory('相似候选 归档', `${SIMILAR_BODY} 归档`)
    const archived = await db.write(normalized(archivedInput), derived(archivedInput))
    await db.archive(archived.entity.id, '测试归档', 'test')

    const input = memory('相似候选 新写', `${SIMILAR_BODY} 新写`)
    const written = await db.write(normalized(input), derived(input))
    expect(written.similarEntities.some(item => item.id === archived.entity.id)).toBe(false)
    expect(written.archivedMatches.length).toBeLessThanOrEqual(SIMILAR_ARCHIVED_LIMIT)
    expect(written.archivedMatches).toHaveLength(1)
    const match = written.archivedMatches[0]!
    expect(match.id).toBe(archived.entity.id)
    expect(match.archived).toBe(true)
    expect(match.score).toBe(1)
    expect(match.reason).toBe('archived-similar')
  })

  it('给定唯一相似实体是自身当查询则排除自身且只返回相似属性名', async () => {
    const input = memory('自身排除', `${SIMILAR_BODY} 自身`)
    const written = await db.write(normalized(input), derived(input))
    const similar = await findSimilar(db.db, {
      entityId: written.entity.id,
      kind: 'memory',
      attributes: written.entity.attributes,
      title: null,
    })
    expect(similar.similarEntities).toEqual([])
    expect(similar.archivedMatches).toEqual([])
    expect(similar.similarAttributes.map(item => item.name)).toEqual(expect.arrayContaining(['title', 'body']))
    const title = similar.similarAttributes.find(item => item.name === 'title')
    expect(title?.usageCount).toBe(1)
    expect(title?.similarity).toBe(1)
  })

  it('给定 attr_registry alias 当相似属性查询则以 canonical 名返回', async () => {
    const input = memory('别名相似', `${SIMILAR_BODY} 别名`)
    const written = await db.write(normalized(input), derived(input))
    await db.db.query("update omb.attr_registry set aliases = array['project_name'] where name = 'title'")
    const similar = await findSimilar(db.db, {
      entityId: written.entity.id,
      kind: 'memory',
      attributes: [
        ...written.entity.attributes,
        {
          name: 'project_name',
          ordinal: 99,
          value: { kind: 'static' as const, value: '别名属性' },
          required: false,
          source: 'test',
        },
      ],
      title: null,
    })
    expect(similar.similarAttributes).toContainEqual(
      expect.objectContaining({ name: 'title', similarity: 1 }),
    )
  })
  it('给定单字正文当真实写入则相似实体为空数组而不是报错（无 tsquery）', async () => {
    const input = memory('雨', '雨')
    const written = await db.write(normalized(input), derived(input))
    expect(written.similarEntities).toEqual([])
    expect(written.archivedMatches).toEqual([])
    // 相似属性名来自 attr_registry 的同名匹配（本次写入自己注册的 title/body），不是实体相似。
    expect(written.similarAttributes.map(item => item.name).sort()).toEqual(['body', 'title'])
  })
})
