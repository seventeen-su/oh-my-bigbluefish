/**
 * 3.7-M2：召回输出的成本与语义。
 *
 * 三条判据：
 * ① 缺省 `snippet`：每条正文 ≤240 字符、5 条整次 ≤1,600 字符（旧行为实测 3,877）；
 * ② `detail:'full'` 仍是逐字全文（旧行为保留一个版本，也是回归对照）；
 * ③ `mode:'always'` 能穿透 pressure-tight；跳过检索与"零命中"的文案必须不同。
 */
import { describe, expect, it } from 'vitest'
import { RECALL_TOOL, SNIPPET_CHARS_PER_ITEM, createMemoryTools } from '../../../modules/memory/recall.js'
import type { MemoryRecord } from '../../../kernel/abi/index.js'
import { clockAt, fakeStore, hits, makeRecord, tagged } from '../retrieval/fakes.js'

const CLOCK = clockAt(1_700_000_000_000)

function toolOf(deps: Parameters<typeof createMemoryTools>[0]) {
  const tool = createMemoryTools(deps).find(candidate => candidate.name === RECALL_TOOL)
  if (tool === undefined) throw new Error('缺少 omb_recall')
  return tool
}

/** 5 条长条目：正文 700 字符（旧行为下这 5 条合计 >3.5K 字符）。 */
function longRecords(): readonly MemoryRecord[] {
  return Array.from({ length: 5 }, (_, index) =>
    makeRecord({
      id: `m${index}`,
      text: `结论${index}：` + '端口固定为 8080，改动前先核对配置。'.repeat(40),
      sourceRef: `session:s${index}#turn-2`,
    }),
  )
}

function longStore() {
  const records = longRecords()
  return fakeStore({
    scope: 'user',
    records,
    search: () => hits(records.map(record => record.id), 100),
  })
}

describe('omb_recall 输出：snippet（缺省）', () => {
  it('5 条整次 ≤1600 字符、每条正文 ≤240 字符，header 保留 sourceRef/通道', async () => {
    const store = longStore()
    const tool = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK, ports: () => ({ clock: CLOCK }) })
    const outcome = (await tool.execute({ query: '端口 配置', limit: 5 })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    // 验收口径是"整次工具输出 ≤1,600"（渲染预算 1,500 + 归属未知说明 ~90）；
    // 调用不带 call 上下文时工具会追加归属说明，所以这里按 1,600 断言。
    expect(outcome.text.length, `snippet 输出 ${outcome.text.length} 字符`).toBeLessThanOrEqual(1600)

    const bodyLines = outcome.text.split('\n').filter(line => line.startsWith('  '))
    expect(bodyLines).toHaveLength(5)
    for (const line of bodyLines) {
      expect(line.length - 2).toBeLessThanOrEqual(SNIPPET_CHARS_PER_ITEM)
      expect(line).toContain('…') // 长文本被截断必须可见
    }
    expect(outcome.text).toContain('sourceRef=session:s0#turn-2')
    expect(outcome.text).toContain('通道 lexical#1')
    expect(outcome.text).toContain('snippet 模式')
  })

  it('短文本不截断（snippet 只截正文，不改变短条目的可读性）', async () => {
    const record = makeRecord({ id: 'short', text: '项目用 pnpm 而不是 npm', sourceRef: 'session:s1#turn:9' })
    const store = fakeStore({ scope: 'user', records: [record], search: () => hits(['short'], 100) })
    const tool = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK })
    const outcome = (await tool.execute({ query: 'pnpm' })) as { text: string }
    expect(outcome.text).toContain('项目用 pnpm 而不是 npm')
    expect(outcome.text).not.toContain('…')
  })

  it('detail:"full" 回到逐字全文（旧行为）；配置 defaultDetail:"full" 同样生效', async () => {
    const store = longStore()
    const record = longRecords()[0] as MemoryRecord
    const snippetTool = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK })
    const snippet = (await snippetTool.execute({ query: '端口', limit: 1 })) as { text: string }
    const viaArg = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK })
    const fullArg = (await viaArg.execute({ query: '端口', limit: 1, detail: 'full' })) as { text: string }
    expect(fullArg.text).toContain(record.text)
    expect(fullArg.text.length).toBeGreaterThan(snippet.text.length)

    const viaConfig = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK, defaultDetail: 'full' })
    const fullConfig = (await viaConfig.execute({ query: '端口', limit: 1 })) as { text: string }
    expect(fullConfig.text).toContain(record.text)
  })
})

describe('omb_recall 门控：跳过 vs 零命中（3.7-M2）', () => {
  it('pressure-tight + auto：明确说"未检索/没查库"，且零 I/O', async () => {
    const store = fakeStore({ scope: 'user', records: longRecords(), search: () => hits(['m0'], 100) })
    const tool = toolOf({
      resolveStores: () => [tagged(store)],
      clock: CLOCK,
      pressureBand: () => 'tight',
    })
    const outcome = (await tool.execute({ query: '端口' })) as { kind: string; text: string }
    expect(outcome.kind).toBe('text')
    expect(outcome.text).toContain('pressure-tight')
    expect(outcome.text).toContain('本次未检索')
    expect(outcome.text).toContain('不是"没有相关记忆"')
    expect(outcome.text).toContain('mode:"always"')
    expect(store.calls.searchLexical).toBe(0)
  })

  it('pressure-tight + mode:"always"：绕过软门控并正常注入', async () => {
    const store = longStore()
    const tool = toolOf({
      resolveStores: () => [tagged(store)],
      clock: CLOCK,
      pressureBand: () => 'tight',
    })
    const outcome = (await tool.execute({ query: '端口', limit: 2, mode: 'always' })) as { text: string }
    expect(store.calls.searchLexical).toBe(1)
    expect(outcome.text).toContain('注入')
    expect(outcome.text).not.toContain('本次未检索')
  })

  it('真的零命中仍是"未检索到相关记忆"（不是"跳过"），并要求不要编造', async () => {
    const store = fakeStore({ scope: 'user', records: longRecords(), search: () => [] })
    const tool = toolOf({ resolveStores: () => [tagged(store)], clock: CLOCK })
    const outcome = (await tool.execute({ query: '完全无关的词' })) as { text: string }
    expect(outcome.text).toContain('未检索到相关记忆')
    expect(outcome.text).toContain('零命中')
    expect(outcome.text).toContain('不要编造')
    expect(outcome.text).not.toContain('本次未检索')
  })
})
