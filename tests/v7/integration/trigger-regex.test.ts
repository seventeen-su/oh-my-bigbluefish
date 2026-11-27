import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { Embedder } from '../../../packages/v7/src/ports/embedding.js'
import { runStageOne } from '../../../packages/v7/src/retrieval/channels.js'
import { DEFAULT_RETRIEVAL_CONFIG } from '../../../packages/v7/src/retrieval/config.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

const FIXED_NOW = '2026-11-22T00:00:00.000Z'

/** 触发通道只关心文本 SQL；向量通道用不可用替身，避免依赖 ONNX 模型文件。 */
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

/** 动态 regex 触发键：input 只用于写入校验，触发匹配走 regexText。 */
function regexAttribute(source: string, flags?: string) {
  return {
    $dynamic: {
      kind: 'regex' as const,
      source,
      ...(flags === undefined ? {} : { flags }),
      input: { kind: 'literal' as const, value: 'seed' },
    },
  }
}

describe('trigger 通道正则安全执行（真实 PostgreSQL）', () => {
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

  it('给定 flags i/m/s 的 regex 触发键当匹配则真实 PG 上命中且排序确定', async () => {
    const caseInsensitiveId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '大小写不敏感触发',
        marker: regexAttribute('deploy_ok', 'i'),
      },
    })
    const multilineId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '多行触发',
        marker: regexAttribute('^second line$', 'm'),
      },
    })
    const dotallId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: 'dotall 触发',
        marker: regexAttribute('first.second', 's'),
      },
    })

    const regexText = 'DEPLOY_OK\nsecond line\nfirst\nsecond'
    const first = await db.triggers({ keys: [], regexText, limit: 10 })
    const second = await db.triggers({ keys: [], regexText, limit: 10 })

    expect(first.map(hit => hit.entityId)).toEqual(
      expect.arrayContaining([caseInsensitiveId, multilineId, dotallId]),
    )
    // 同分时按 entityId 升序兜底：两次调用的顺序必须一致（不能依赖物理行序）。
    expect(second.map(hit => hit.entityId)).toEqual(first.map(hit => hit.entityId))
  })

  it('给定损坏的历史 regex 行当匹配则只跳过该行，正常正则仍命中且不抛宿主', async () => {
    const goodId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '正常正则触发', marker: regexAttribute('^good$', 'i') },
    })
    const corruptId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '损坏正则宿主' },
    })
    // 绕过写入校验模拟历史脏行：`(` 不是合法正则，QuickJS 编译应返回 invalid-source 而不是抛宿主。
    await db.db.query(
      "insert into omb.trigger_key (entity_id, kind, key, weight) values ($1, 'regex', '(', 1.2)",
      [corruptId],
    )

    const hits = await db.triggers({ keys: [], regexText: 'GOOD', limit: 10 })

    expect(hits.map(hit => hit.entityId)).toContain(goodId)
    expect(hits.map(hit => hit.entityId)).not.toContain(corruptId)
  })

  it('给定真实 ReDoS 正则当查询命中则 trigger 通道超时降级为字面键匹配且不拖垮其他通道', async () => {
    const pathId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '排查 /src/main.ts 崩溃' },
    })
    const redosId = await writeMemory({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '病态正则', marker: regexAttribute('(a+)+$') },
    })
    const query = `排查 /src/main.ts 崩溃 ${'a'.repeat(40)}b`

    // 直连 store：正则分支超时必须以 sandbox-timeout 显式上抛，供 channels 降级。
    await expect(
      db.triggers({ keys: ['/src/main.ts'], regexText: query, limit: 10 }),
    ).rejects.toMatchObject({ error: { code: 'sandbox-timeout' } })

    const outcome = await runStageOne(
      { store: db, embedder: new NoVectorEmbedder() },
      {
        request: { query, now: FIXED_NOW },
        config: DEFAULT_RETRIEVAL_CONFIG,
        scenario: DEFAULT_RETRIEVAL_CONFIG.scenarios['tool-error'],
        now: FIXED_NOW,
      },
    )

    // 超时记入 channel error，但 trigger 通道本身仍成功返回字面键命中。
    expect(outcome.errors.find(error => error.channel === 'trigger')?.code).toBe('sandbox-timeout')
    const triggerReport = outcome.reports.find(report => report.channel === 'trigger')
    expect(triggerReport?.status).toBe('ok')
    expect(triggerReport?.reason).toContain('降级')
    const triggerHits = outcome.hitsByChannel.get('trigger') ?? []
    expect(triggerHits.map(hit => hit.entityId)).toContain(pathId)
    expect(triggerHits.map(hit => hit.entityId)).not.toContain(redosId)

    // 其他通道不被 trigger 的超时连坐（向量不可用是明确 unavailable，不是 failed）。
    const fulltextReport = outcome.reports.find(report => report.channel === 'fulltext')
    expect(fulltextReport?.status).not.toBe('failed')
    expect(outcome.errors.filter(error => error.channel !== 'trigger')).toEqual([])
  })
})
