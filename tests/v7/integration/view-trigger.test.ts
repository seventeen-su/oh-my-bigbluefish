import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { DynamicService } from '../../../packages/v7/src/app/dynamic.js'
import type { Attribute, WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity-access.js'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import { deriveTriggers, decodeRegexTriggerKey, encodeRegexTriggerKey } from '../../../packages/v7/src/domain/validation.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'

const clock: Clock = { now: () => new Date(FIXED_NOW), iso: () => FIXED_NOW }

/** 只有数据层的文本 SQL 参与本套用例；向量通道用不可用替身，避免依赖 ONNX 模型文件。 */
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

interface ViewSnapshot {
  title: string | null
  attrs: Record<string, unknown>
  search_text: string
  snippet: string
  chars: string[]
}

interface TriggerRow {
  kind: string
  key: string
}

/** 不存在的合法记忆 id：格式能过 isId，但库里没有这条实体。 */
const MISSING_MEMORY_ID = 'mem_00000000-0000-4000-8000-000000000000'

function attributeOf(attributes: readonly Attribute[], name: string): Attribute | undefined {
  return attributes.find(attribute => attribute.name === name)
}

describe('动态视图派生与触发键（真实 PostgreSQL）', () => {
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

  async function writeMemory(input: WriteEntityInput): Promise<string> {
    const written = await db.write(normalized(input), derived(input))
    return written.entity.id
  }

  async function refreshDynamic(entityId: string): Promise<void> {
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock,
    })
    await dynamic.refreshById(entityId, { force: true })
  }

  async function viewOf(entityId: string): Promise<ViewSnapshot> {
    const result = await db.db.query<ViewSnapshot>(
      'select title, attrs, search_text, snippet, chars from omb.entity_view where entity_id = $1',
      [entityId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error(`缺少视图行：${entityId}`)
    return row
  }

  async function triggerRowsOf(entityId: string): Promise<TriggerRow[]> {
    const result = await db.db.query<TriggerRow>(
      'select kind, key from omb.trigger_key where entity_id = $1 order by kind asc, key asc',
      [entityId],
    )
    return result.rows
  }

  async function attributeRowsOf(entityId: string): Promise<Array<{ name: string; value_kind: string; value: unknown; cached_value: unknown }>> {
    const result = await db.db.query<{ name: string; value_kind: string; value: unknown; cached_value: unknown }>(
      `select name, value_kind, value, cached_value from omb.attribute
       where entity_id = $1 order by ordinal asc, name asc`,
      [entityId],
    )
    return result.rows
  }

  it('给定动态 ref 刷新出缓存值当读取视图则缓存文本进入 search_text、snippet、chars 且可全文与单字命中', async () => {
    const targetId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '目标标题' },
    })
    const sourceInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '引用者',
        mirror: { $dynamic: { kind: 'ref', entityId: targetId, attr: 'title' } },
      },
    }
    const sourceId = await writeMemory(sourceInput)
    await refreshDynamic(sourceId)

    const loaded = await db.get(sourceId)
    expect(loaded === undefined ? undefined : attributeValue(loaded, 'mirror')).toBe('目标标题')

    const view = await viewOf(sourceId)
    expect(view.attrs['mirror']).toBe('目标标题')
    // search_text 是 tokenize 后的空格分隔词；bigram「目标」与单字「标」都必须来自缓存值。
    expect(view.search_text).toContain('目标')
    expect(view.search_text).toContain('标')
    expect(view.snippet).toContain('目标标题')
    expect(view.chars).toContain('标')

    const fulltext = await db.fulltext({ query: '目标标题', tokens: tokenize('目标标题'), limit: 10 })
    expect(fulltext.map(hit => hit.entityId)).toContain(sourceId)

    const single = await db.singleChar({ query: '标', tokens: tokenize('标'), limit: 10 })
    expect(single.map(hit => hit.entityId)).toContain(sourceId)
  })

  it('给定动态缓存值当 patch 其它属性则视图仍从属性行派生并与缓存值一致', async () => {
    const targetId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '目标标题' },
    })
    const sourceInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '引用者',
        body: '初始正文',
        mirror: { $dynamic: { kind: 'ref', entityId: targetId, attr: 'title' } },
      },
    }
    const sourceId = await writeMemory(sourceInput)
    await refreshDynamic(sourceId)

    const nextInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '引用者改',
        body: '补丁正文',
        mirror: { $dynamic: { kind: 'ref', entityId: targetId, attr: 'title' } },
      },
    }
    await db.patch(normalized({ ...nextInput, id: sourceId }), { id: sourceId, expectedRevision: 1 }, derived({ ...nextInput, id: sourceId }))

    // 属性行保留缓存值（preserveDynamicCaches），视图必须与属性行一致，而不是退回无缓存的内存入参。
    const attributeRows = await attributeRowsOf(sourceId)
    const mirrorRow = attributeRows.find(row => row.name === 'mirror')
    expect(mirrorRow?.cached_value).toBe('目标标题')

    const view = await viewOf(sourceId)
    expect(view.title).toBe('引用者改')
    expect(view.attrs['mirror']).toBe('目标标题')
    expect(view.search_text).toContain('目标')
    expect(view.snippet).toContain('目标标题')
    expect(view.chars).toContain('标')
  })

  it('给定动态刷新失败当写 last_error 则保留旧缓存且视图文本仍有旧值', async () => {
    const targetId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '目标标题' },
    })
    const sourceInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '引用者',
        mirror: { $dynamic: { kind: 'ref', entityId: targetId, attr: 'title' } },
      },
    }
    const sourceId = await writeMemory(sourceInput)
    await refreshDynamic(sourceId)

    const loaded = await db.get(sourceId)
    const mirror = attributeOf(loaded?.attributes ?? [], 'mirror')
    if (mirror === undefined) throw new Error('缺少 mirror 属性')
    await db.setAttributeCache(sourceId, 'mirror', mirror.ordinal, undefined, FIXED_NOW, 'refresh boom')

    const failed = await db.get(sourceId)
    const failedMirror = attributeOf(failed?.attributes ?? [], 'mirror')
    expect(failedMirror?.value.kind).toBe('dynamic')
    expect(failedMirror?.value.kind === 'dynamic' ? failedMirror.value.cachedValue : undefined).toBe('目标标题')
    expect(failedMirror?.value.kind === 'dynamic' ? failedMirror.value.lastError : undefined).toBe('refresh boom')

    const view = await viewOf(sourceId)
    expect(view.attrs['mirror']).toBe('目标标题')
    expect(view.search_text).toContain('目标')
  })

  it('给定 patch 事务中途失败当回滚则视图、属性行与触发键都没有脏行', async () => {
    const memberId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '链成员' },
    })
    const chainInput: WriteEntityInput = {
      kind: 'chain',
      scope: { kind: 'global' },
      title: '原链标题',
      group: [memberId],
    }
    const chain = await db.write(normalized(chainInput), derived(chainInput))
    const beforeView = await viewOf(chain.entity.id)
    const beforeAttributes = await attributeRowsOf(chain.entity.id)
    const beforeTriggers = await triggerRowsOf(chain.entity.id)

    const badInput: WriteEntityInput = {
      kind: 'chain',
      scope: { kind: 'global' },
      title: '脏标题',
      group: [memberId, MISSING_MEMORY_ID],
    }
    await expect(
      db.patch(normalized({ ...badInput, id: chain.entity.id }), { id: chain.entity.id, expectedRevision: 1 }, derived({ ...badInput, id: chain.entity.id })),
    ).rejects.toThrow(/思维链成员不存在/)

    expect(await viewOf(chain.entity.id)).toEqual(beforeView)
    expect(await attributeRowsOf(chain.entity.id)).toEqual(beforeAttributes)
    expect(await triggerRowsOf(chain.entity.id)).toEqual(beforeTriggers)
  })

  it('给定 write 事务失败当组成员不存在则实体、属性、视图与触发键都不留脏行', async () => {
    const failedId = 'ch_00000000-0000-4000-8000-000000000001'
    const input: WriteEntityInput = {
      id: failedId,
      kind: 'chain',
      scope: { kind: 'global' },
      title: '失败链',
      group: [MISSING_MEMORY_ID],
    }
    await expect(db.write(normalized(input), derived(input))).rejects.toThrow(/思维链成员不存在/)

    for (const table of ['entity', 'attribute', 'entity_view', 'trigger_key'] as const) {
      const result = await db.db.query<{ count: string }>(
        `select count(*)::text as count from omb.${table} where ${table === 'entity' ? 'id' : 'entity_id'} = $1`,
        [failedId],
      )
      expect(result.rows[0]?.count, `${table} 不应留下脏行`).toBe('0')
    }
  })

  it('给定动态 regex 触发键当带 i flags 则落库并可被 trigger 通道大小写不敏感命中，entity 键同时落库', async () => {
    const targetId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '被引用目标' },
    })
    const regexId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '部署检查失败记录',
        marker: {
          $dynamic: {
            kind: 'regex',
            source: '^deploy_check$',
            flags: 'i',
            input: { kind: 'literal', value: 'DEPLOY_CHECK' },
          },
        },
      },
    })
    const refId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '引用实体的记忆',
        linked: { $dynamic: { kind: 'ref', entityId: targetId } },
      },
    })

    const regexKeys = (await triggerRowsOf(regexId)).filter(row => row.kind === 'regex').map(row => row.key)
    expect(regexKeys).toHaveLength(1)
    expect(regexKeys[0]).toContain('deploy_check')

    // 无缓存值也必须在写入时派生 entity 触发键（deriveReferences 的目标实体）。
    const refEntityKeys = await db.db.query<{ entity_id: string }>(
      "select t.entity_id from omb.trigger_key t where t.kind = 'entity' and t.key = $1",
      [targetId],
    )
    expect(refEntityKeys.rows.length).toBeGreaterThan(0)

    // entity 键走精确匹配分支（(kind,key) 索引等值探针），不需要 regexText。
    const exact = await db.triggers({ keys: [targetId], limit: 10 })
    expect(exact.find(row => row.entityId === refId)?.rawScore).toBe(1)
    // 重复 key 不能把权重求和两次（去重后仍是单条权重）。
    const duplicated = await db.triggers({ keys: [targetId, targetId], limit: 10 })
    expect(duplicated.find(row => row.entityId === refId)?.rawScore).toBe(1)

    // match 只可能来自 flags=i：无 flags 时 '^deploy_check$' 不会匹配大写查询。
    const hit = await db.triggers({ keys: [], regexText: 'DEPLOY_CHECK', limit: 10 })
    expect(hit.map(row => row.entityId)).toContain(regexId)
    const miss = await db.triggers({ keys: [], regexText: 'DEPLOY_CHECK_OTHER', limit: 10 })
    expect(miss.map(row => row.entityId)).not.toContain(regexId)
  })

  it('给定查询没有路径/标识符/错误码当 regex 触发文本命中则 trigger 通道仍执行并召回', async () => {
    const regexId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '服务报错处理记录',
        marker: {
          $dynamic: {
            kind: 'regex',
            source: '报错|挂了',
            input: { kind: 'literal', value: '报错' },
          },
        },
      },
    })

    const engine = new RecallEngine({ store: db, embedder: new NoVectorEmbedder(), clock })
    const result = await engine.recall({ query: '服务报错了，请看看', now: FIXED_NOW })

    expect(result.channels.find(channel => channel.channel === 'trigger')?.status).toBe('ok')
    expect(result.hits.map(hit => hit.entityId)).toContain(regexId)
  })

  it('给定长正文尾部单字当 patch 重建视图后单字回退仍命中（用 search_text 复核，不退回 snippet）', async () => {
    const prefix = '部署手册补充说明：每一步都需要回滚验证，并记录耗时。'.repeat(12)
    const body = `${prefix}熔断阈值是两百毫秒。`
    const memoryId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '长正文记忆', body },
    })
    const nextInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '长正文记忆已更新', body },
    }
    await db.patch(normalized({ ...nextInput, id: memoryId }), { id: memoryId, expectedRevision: 1 }, derived({ ...nextInput, id: memoryId }))

    const view = await viewOf(memoryId)
    // 先证明用例踩在 240 字 snippet 边界之外：尾部字不在 snippet，但在 chars 候选集合里。
    expect(view.snippet).not.toContain('阈')
    expect(view.chars).toContain('阈')
    expect(view.search_text).toContain('阈')

    const hits = await db.singleChar({ query: '阈', tokens: tokenize('阈'), limit: 5 })
    const hit = hits.find(row => row.entityId === memoryId)
    expect(hit).toBeDefined()
    // 1.0 说明连续子串来自 search_text（snippet 复核在旧实现里会直接漏掉该行）。
    expect(hit?.rawScore).toBe(1)
  })
})

describe('deriveTriggers（纯函数）', () => {
  function dynamicAttribute(name: string, spec: Attribute['value']): Attribute {
    return { name, ordinal: 3, value: spec, required: false, source: 'model' }
  }

  it('给定无缓存值的动态 regex 属性当派生触发键则落 regex 键（不再因 value===undefined 提前跳过）', () => {
    const attributes: Attribute[] = [
      dynamicAttribute('marker', {
        kind: 'dynamic',
        spec: { kind: 'regex', source: '^deploy_check$', flags: 'i', input: { kind: 'literal', value: 'DEPLOY_CHECK' } },
      }),
    ]

    const triggers = deriveTriggers(attributes)

    const regexTriggers = triggers.filter(trigger => trigger.kind === 'regex')
    expect(regexTriggers).toHaveLength(1)
    const regexTrigger = regexTriggers[0]
    expect(regexTrigger === undefined ? undefined : decodeRegexTriggerKey(regexTrigger.key)).toEqual({
      source: '^deploy_check$',
      flags: 'i',
    })
  })

  it('给定没有 flags 的正则当编解码则保持 source 原样（兼容旧行）', () => {
    expect(encodeRegexTriggerKey('^legacy$')).toBe('^legacy$')
    expect(decodeRegexTriggerKey('^legacy$')).toEqual({ source: '^legacy$' })
    expect(decodeRegexTriggerKey(encodeRegexTriggerKey('^a/b$', 'im'))).toEqual({ source: '^a/b$', flags: 'im' })
  })

  it('给定动态 ref/template/code 属性当派生触发键则目标实体都落 entity 键', () => {
    const refTarget = 'mem_11111111-1111-4111-8111-111111111111'
    const templateTarget = 'mem_22222222-2222-4222-8222-222222222222'
    const codeTarget = 'mem_33333333-3333-4333-8333-333333333333'
    const attributes: Attribute[] = [
      dynamicAttribute('linked', { kind: 'dynamic', spec: { kind: 'ref', entityId: refTarget } }),
      dynamicAttribute('listed', {
        kind: 'dynamic',
        spec: { kind: 'template', template: '{{a}}', refs: [{ entityId: templateTarget, attr: 'title', as: 'a' }] },
      }),
      dynamicAttribute('computed', {
        kind: 'dynamic',
        spec: { kind: 'code', source: `ref('${codeTarget}')` },
      }),
    ]

    const entityKeys = deriveTriggers(attributes).filter(trigger => trigger.kind === 'entity').map(trigger => trigger.key)

    expect(entityKeys).toEqual(expect.arrayContaining([refTarget, templateTarget, codeTarget]))
  })
})
