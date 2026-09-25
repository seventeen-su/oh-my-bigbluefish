/**
 * 对**真实用户库**执行一次推翻标注 —— 默认关闭，只在显式开启时跑。
 *
 * ```powershell
 * $env:OMB_MARK_REAL_DB='1'; npx vitest run tests/modules/memory/real-db-supersede.test.ts
 * ```
 *
 * 为什么要有这个文件（而不是手改库文件）：
 * ① 数据层的那次标注必须走**生产写入路径**（`omb_remember` + `supersedes`），
 *    否则"机制能表达被推翻"只是纸面声明；
 * ② 走代码路径才同时验证了三件事：旧条目 `validTo`/`supersededBy` 被写上、
 *    `supersedes` 边建成、召回回执开始报告"已被推翻"；
 * ③ 真实库是**用户的长期记忆**，所以默认绝不碰它：只有显式 `OMB_MARK_REAL_DB=1`
 *    才会执行，且**幂等**（已经标过就只做只读验证，不重复写入）。
 *
 * 库路径：`$DSH_HOME/.omb/memory/knowledge.db`（可用 `OMB_DSH_HOME` / `OMB_REAL_DB` 覆盖）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryStore, StorageHostPort, TaggedStore, ToolDefinition, ToolOutcome } from '../../../kernel/abi/index.js'
import { renderRelate, walkGraph } from '../../../modules/memory/graph.js'
import { renderRecall } from '../../../modules/memory/recall.js'
import { createRememberTool } from '../../../modules/memory/remember.js'
import { retrieve } from '../../../modules/memory/retrieve.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { capturingLogger, nodeSqlite } from './helpers.js'

const ENABLED = process.env['OMB_MARK_REAL_DB'] === '1'

/** 上一轮自检留下的过时结论（多项声明已被实测推翻）。 */
const TARGET_ID = 'mem_muhf5wal_2_34336271'

/** 幂等标记：更正条目里带这个串，重跑时不再写第二条。 */
const CORRECTION_MARKER = 'OMB-SELFTEST-CORRECTION-V1'

const CORRECTION_TEXT =
  `更正（${CORRECTION_MARKER}，本轮实测复核）：旧结论 ${TARGET_ID} 的多项声明已被实测推翻——` +
  `①「项目库尚未就绪」不成立：项目库 .omb/memory/session.db 已就绪并可写入（schema v1、含记录、` +
  `embedding meta=hash-bow-256/256/rev1）；②「无任何可用工具能读取 build-generation.json」不成立：` +
  `该文件可直接读取，当前内容为 outDir=lib-gen/g44、generation=44（旧结论里的"第 37 代"已过时）；` +
  `③「omb_focus 连续 3 次失败」本轮**未核对**（本轮执行环境的工具面里没有 omb_focus）——` +
  `该项不要当成已推翻，需要单独复测。旧条目已标为 superseded（validTo + supersededBy + supersedes 边）：` +
  `它是历史痕迹，不是当前结论。`

function realPaths(): { readonly dbPath: string; readonly port: StorageHostPort } {
  const dshHome = process.env['OMB_DSH_HOME'] ?? join(homedir(), '.dsh')
  const dbPath = process.env['OMB_REAL_DB'] ?? join(dshHome, '.omb', 'memory', 'knowledge.db')
  return {
    dbPath,
    port: {
      userDbPath: dbPath,
      createDirs: false,
      openDatabase: (path: string) => nodeSqlite(path),
    },
  }
}

if (!ENABLED) {
  it('真实库标注默认关闭（只有 OMB_MARK_REAL_DB=1 才写用户的长期记忆）', () => {
    expect(ENABLED).toBe(false)
  })
} else {
  describe(`真实用户库：把 ${TARGET_ID} 标为已推翻`, () => {
    it('走生产写入路径标注，并验证后续会话能从 omb_recall / omb_relate 看出已被推翻', async () => {
      const { dbPath, port } = realPaths()
      const logger = capturingLogger()
      const clock = { now: (): number => Date.now() }
      const store: SqliteMemoryStore = openMemoryStore({ scope: 'user', dbPath, port, logger, clock })
      const tool: ToolDefinition = createRememberTool({
        resolveStore: async (scope): Promise<MemoryStore | undefined> => (scope === 'user' ? store : undefined),
        clock,
        onWritten: () => {},
        onAbstained: () => {},
      })
      const tagged: readonly TaggedStore[] = [{ scope: 'user', store }]

      try {
        const before = await store.get(TARGET_ID)
        expect(before, `真实库里找不到 ${TARGET_ID}（${dbPath}）`).toBeDefined()
        expect(before?.text.length).toBeGreaterThan(0)
        const beforeText = before?.text ?? ''

        let newId = before?.supersededBy ?? ''
        if (before?.supersededBy !== null && before?.supersededBy !== undefined) {
          console.log(`[real-db] ${TARGET_ID} 已被 ${before.supersededBy} 标注过：本次只做只读验证（幂等）`)
        } else {
          const existing = await store.searchLexical({ text: CORRECTION_MARKER, scope: 'user', limit: 5 })
          if (existing.length > 0) {
            // 更正条目在，但旧条目没被标上（上次中途失败）→ 再标一次，不重复写正文
            newId = existing[0]?.id ?? ''
            console.log(`[real-db] 更正条目已存在（${newId}），本次只补标注与边`)
            const outcome: ToolOutcome = await tool.execute({
              text: CORRECTION_TEXT,
              kind: 'semantic',
              sourceRef: 'execution:omb-v3-selftest-rerun#mark-supersede',
              supersedes: [TARGET_ID],
            })
            console.log(`[real-db] 补标注回执：\n${outcome.text}`)
          } else {
            const outcome: ToolOutcome = await tool.execute({
              text: CORRECTION_TEXT,
              kind: 'semantic',
              sourceRef: 'execution:omb-v3-selftest-rerun#mark-supersede',
              supersedes: [TARGET_ID],
            })
            console.log(`[real-db] 写入回执：\n${outcome.text}`)
            expect(outcome.kind).toBe('text')
            expect(outcome.text).toContain('推翻标注：1 条旧记忆已标为"被本条取代"')
            const fresh = await store.searchLexical({ text: CORRECTION_MARKER, scope: 'user', limit: 5 })
            expect(fresh.length).toBe(1)
            newId = fresh[0]?.id ?? ''
          }
        }
        expect(newId.length).toBeGreaterThan(0)

        // ── 只读验证 ①：库里那条记录确实被标为已推翻，且正文逐字未改（非破坏性）
        const after = await store.get(TARGET_ID)
        expect(after?.supersededBy).toBe(newId)
        expect(after?.validTo).not.toBeNull()
        expect(after?.text).toBe(beforeText)

        // ── 只读验证 ②：supersedes 边在库里（newer → older）
        const walk = await walkGraph(tagged, { id: TARGET_ID, depth: 1, types: ['supersedes'] })
        expect(walk.ok).toBe(true)
        if (walk.ok) {
          console.log(`[real-db] omb_relate 输出：\n${renderRelate(walk.result)}`)
          expect(walk.result.edges.map(edge => `${edge.fromId}->${edge.toId}:${edge.type}`)).toContain(
            `${newId}->${TARGET_ID}:supersedes`,
          )
          expect(renderRelate(walk.result)).toContain('⚠️已被取代')
        }

        // ── 只读验证 ③：**后续会话调 omb_recall 时看到的东西**
        const result = await retrieve(tagged, { text: 'omb_focus 连续 3 次失败', limit: 5 }, { clock })
        const rendered = renderRecall(result)
        console.log(`[real-db] omb_recall 输出：\n${rendered}`)
        expect(result.items.map(item => item.id)).not.toContain(TARGET_ID)
        expect(result.stats.supersededSkippedIds).toContain(TARGET_ID)
        expect(rendered).toContain('已被推翻')
        expect(rendered).toContain(TARGET_ID)
      } finally {
        await store.close()
      }
    })
  })
}
