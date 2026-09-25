/**
 * 「被推翻的结论，后续会话能立刻看出」——端到端（真实 SQLite + 真实检索/图遍历代码路径）。
 *
 * 这条链路要同时成立两件事，缺一个都算没修好：
 * ① **不误导**：已被取代的条目不再作为有效结论注入召回（`validTo` 非空即被排除）
 * ② **不静默**：那条历史痕迹没有被抹掉——召回回执点名它的 id 并说明"已被推翻"，
 *    `omb_relate` 能看到 `⚠️已被取代` 与 `supersedes` 边
 *
 * 为什么不用 mock：`supersededSkippedIds`、`validTo` 过滤、边方向都只有在真实
 * SQLite（含 FTS 触发器与 edge 表）上跑过一遍才算证据。
 */
import { describe, expect, it } from 'vitest'
import type { TaggedStore, ToolDefinition, ToolOutcome } from '../../../kernel/abi/index.js'
import { renderRelate, walkGraph } from '../../../modules/memory/graph.js'
import { renderRecall } from '../../../modules/memory/recall.js'
import { createRememberTool, type MemoryWriteDeps } from '../../../modules/memory/remember.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import type { RetrieveResult } from '../../../modules/memory/retrieve.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import {
  capturingLogger,
  fixedClock,
  makeRecord,
  tempWorkspace,
  testPort,
  type TempWorkspace,
} from './helpers.js'

interface SupersedeFixture {
  readonly tool: ToolDefinition
  readonly store: SqliteMemoryStore
  readonly tagged: readonly TaggedStore[]
  /** 检索端口：内核时钟 + 纯词法（无向量/图通道——本用例只验词法主路径）。 */
  readonly ports: { readonly clock: { now(): number } }
  close(): Promise<void>
}

function fixture(): SupersedeFixture {
  const ws: TempWorkspace = tempWorkspace('omb-supersede-')
  const logger = capturingLogger()
  const clock = fixedClock()
  const port = testPort(ws.dir)
  const store = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const deps: MemoryWriteDeps = {
    resolveStore: async (scope): Promise<SqliteMemoryStore | undefined> =>
      scope === 'user' ? store : undefined,
    clock,
    currentSession: () => 'selftest-session',
    currentTurn: () => 1,
    onWritten: () => {},
    onAbstained: () => {},
  }
  return {
    tool: createRememberTool(deps),
    store,
    tagged: [{ scope: 'user', store }],
    ports: { clock },
    async close(): Promise<void> {
      await store.close()
      ws.cleanup()
    },
  }
}

async function run(tool: ToolDefinition, args: unknown): Promise<ToolOutcome> {
  return await tool.execute(args)
}

/** 唯一一条含该关键词的 id（FTS 真实命中，不写死 id 生成规则）。 */
async function idOf(store: SqliteMemoryStore, query: string): Promise<string> {
  const hits = await store.searchLexical({ text: query, scope: 'user', limit: 5 })
  expect(hits.length, `关键词「${query}」应当只命中一条`).toBe(1)
  return hits[0]?.id ?? ''
}

describe('被推翻的结论：后续会话看得见', () => {
  const oldText =
    'OMB 自检结论（旧）：omb_focus 连续 3 次失败；项目库尚未就绪。KEYWORD-OLD ONLY-OLD-MARKER'
  const correctionText =
    '更正（实测，见 tools/selftest.md）：KEYWORD-OLD 的多项声明已被推翻——omb_focus 可用、' +
    '项目库已就绪；旧条目已标为 superseded，后续会话不应把 KEYWORD-CORRECTION 之前的结论当有效结论。'

  /** 写入旧结论 → 写入更正并声明取代 → 返回两者的 id。 */
  async function markOverturned(fx: SupersedeFixture): Promise<{ oldId: string; newId: string }> {
    const written = await run(fx.tool, {
      text: oldText,
      kind: 'semantic',
      sourceRef: 'execution:omb-v3-selftest',
    })
    expect(written.kind).toBe('text')
    const oldId = await idOf(fx.store, 'KEYWORD-OLD')

    const corrected = await run(fx.tool, {
      text: correctionText,
      kind: 'semantic',
      sourceRef: 'execution:omb-v3-selftest-rerun',
      supersedes: [oldId],
    })
    expect(corrected.text).toContain('推翻标注：1 条旧记忆已标为"被本条取代"')
    const newId = await idOf(fx.store, 'KEYWORD-CORRECTION')
    return { oldId, newId }
  }

  it('召回：旧结论不再注入，回执点名它"已被推翻"并给出可追的 id', async () => {
    const fx = fixture()
    const { oldId, newId } = await markOverturned(fx)

    const result = await retrieve(fx.tagged, { text: 'omb_focus 连续 3 次失败', limit: 5 }, fx.ports)
    expect(result.gate.retrieve).toBe(true)

    // ① 不误导：被取代的那条不在注入列表里
    expect(result.items.map(item => item.id)).not.toContain(oldId)
    // ② 不静默：计数 + id 都在，且注入了说清"已被推翻"的更正条目
    expect(result.stats.supersededSkipped).toBe(1)
    expect(result.stats.supersededSkippedIds).toEqual([oldId])
    expect(result.note).toContain('已被取代')
    expect(result.items.map(item => item.id)).toContain(newId)

    const rendered = renderRecall(result)
    expect(rendered).toContain(`⚠️ 另有 1 条相关记忆**已被推翻**、未作为有效结论注入：${oldId}`)
    expect(rendered).toContain('omb_relate')
    expect(rendered).toContain(correctionText) // 更正内容逐字可见
    await fx.close()
  })

  it('omb_relate：顺着 supersedes 边能看到旧条目与"已被取代（supersededBy=…）"', async () => {
    const fx = fixture()
    const { oldId, newId } = await markOverturned(fx)

    const outcome = await walkGraph(fx.tagged, { id: oldId, depth: 1, types: ['supersedes'] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect([...outcome.result.nodes.map(node => node.id)].sort()).toEqual([newId, oldId].sort())
    expect(outcome.result.edges.map(edge => `${edge.fromId}->${edge.toId}:${edge.type}`)).toEqual([
      `${newId}->${oldId}:supersedes`,
    ])

    const rendered = renderRelate(outcome.result)
    expect(rendered).toContain(`⚠️已被取代（supersededBy=${newId}，不再是有效结论）`)
    expect(rendered).toContain(oldText) // 历史痕迹逐字可见
    expect(rendered).toContain(`supersedes: ${newId} → ${oldId}`)
    await fx.close()
  })

  it('零命中也要说清"有过结论、已被推翻"（不是"从来没有过"）', async () => {
    const fx = fixture()
    const { oldId } = await markOverturned(fx)

    // 只匹配旧条目的唯一标记（更正条目里没有它）→ 有效记忆零命中
    const result = await retrieve(fx.tagged, { text: 'ONLY-OLD-MARKER', limit: 5 }, fx.ports)
    expect(result.items).toHaveLength(0)
    expect(result.note).toContain('零命中')
    expect(result.note).toContain('已被取代')
    expect(result.stats.supersededSkippedIds).toEqual([oldId])
    expect(renderRecall(result)).toContain(oldId)
    await fx.close()
  })

  it('半成品（只设了 supersededBy、validTo 为空）：不注入，但探测如实报告它已被推翻', async () => {
    const fx = fixture()
    // 这是"标注中途失败"可能留下的形状（supersededBy 写上了、validTo 没写上）。
    // 真实实现的通道在 SQL 层就排除了 superseded_by 非空的行，所以它不会进注入列表；
    // 但"这里曾经有一条已被推翻的结论"必须仍然说得出来——否则就是静默抹掉历史。
    await fx.store.put(
      makeRecord({
        id: 'mem_half_done',
        scope: 'user',
        text: '半成品结论：端口是 8080。HALFDONE',
        supersededBy: 'mem_replacement',
        validTo: null,
      }),
    )

    const result = await retrieve(fx.tagged, { text: 'HALFDONE', limit: 5 }, fx.ports)
    expect(result.items.map(item => item.id)).not.toContain('mem_half_done')
    expect(result.stats.supersededSkipped).toBe(1)
    expect(result.stats.supersededSkippedIds).toEqual(['mem_half_done'])
    const rendered = renderRecall(result)
    expect(rendered).toContain('mem_half_done')
    expect(rendered).toContain('已被推翻')
    await fx.close()
  })

  it('未被取代的条目不带任何"失效"标注（标注不是默认噪音）', async () => {
    const fx = fixture()
    await run(fx.tool, {
      text: '当前有效结论：端口是 9090。STILL-VALID',
      kind: 'semantic',
      sourceRef: 'execution:rerun',
    })
    const result = await retrieve(fx.tagged, { text: 'STILL-VALID', limit: 5 }, fx.ports)
    const rendered = renderRecall(result)
    expect(rendered).toContain('STILL-VALID')
    expect(rendered).not.toContain('已被')
    expect(rendered).not.toContain('已失效')
    await fx.close()
  })

  it('渲染层兜底：条目自身带"已被取代"标记时，逐条输出必须写明它不是有效结论', () => {
    // 生产路径上这种行进不了注入列表（通道在 SQL 层就排除了），但渲染层不该假设上游永远干净：
    // 模型看到的正是 renderRecall 的输出，所以这里直接喂一个带标记的条目，把"漏进来的情况"钉住。
    const result: RetrieveResult = {
      items: [
        {
          rank: 0,
          id: 'mem_stale',
          text: '旧结论：端口是 8080。',
          sourceRef: 'execution:old',
          observedAt: 1,
          scope: 'user',
          kind: 'semantic',
          assertedBy: 'model',
          project: null,
          validTo: 2,
          supersededBy: 'mem_live',
          score: 1,
          channels: ['lexical'],
          ranks: [{ channel: 'lexical', scope: 'user', rank: 1 }],
        },
      ],
      gate: { retrieve: true, reason: 'ok', detail: '门控通过' },
      degraded: [],
      stats: {
        storesQueried: 1,
        channelsUsed: ['lexical'],
        candidatesFused: 1,
        candidatesCapped: 1,
        dropped: 0,
        reservedSkipped: 0,
        expiredSkipped: 1,
        supersededSkipped: 1,
        supersededSkippedIds: ['mem_stale'],
        perStore: [{ scope: 'user', candidates: 1, selected: 1 }],
        rrfK: 60,
        reranked: false,
      },
      now: 3,
      note: '已查询 1 个库、1 个通道，注入 1 条（逐字 + 溯源）',
    }
    const rendered = renderRecall(result)
    expect(rendered).toContain('⚠️已被 mem_live 取代（本条不是有效结论）')
    // 同一个 id 既在注入列表里、又被报成"已推翻"是矛盾的，但渲染层只负责如实标注，不隐藏信息
    expect(rendered).toContain('⚠️ 另有 1 条相关记忆**已被推翻**')
  })
})
