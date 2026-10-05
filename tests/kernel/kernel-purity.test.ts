/**
 * 内核纯度护栏的**元测试**：代码里的判据、文档里写的判据，必须是同一件事。
 *
 * 由来（真实缺陷，不是假想）：`eslint.config.mjs` 的注释与 `meta.docs.description`
 * 曾声称"文件名与标识符均检查""≤350 行"，而实现**只查文件名**；
 * `docs/omb-v3-refactor-plan.md` 又把"内核 ≤350 行硬上限 + 静态断言"写进风险登记表
 * （R7 的缓解措施），而 `kernel/index.ts` 到 723 行时 `pnpm verify` 依然全绿。
 * 读文档的人会以为这件事有人在守，于是不再复核——**护栏看不见它就等于没有护栏**。
 *
 * 所以本测试钉三样东西（任何一样漂了都会失败）：
 *   ① 行数上限的数字：代码常量 == 文档里印出来的数字
 *   ② 行数豁免名单：代码常量里的每一条都在文档里点名
 *   ③ 行为：真的跑一次 eslint，确认标识符判据与行数判据都会响、干净文件不误报
 *
 * 为什么用 `--stdin --stdin-filename` 而不是临时改 `kernel/` 下的真文件：
 * 判据要能随时重跑。往内核里写一个探针文件再删掉，会把"跑测试"变成"改工作树"。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const configSource = readFileSync(join(root, 'eslint.config.mjs'), 'utf8')
const planDoc = readFileSync(join(root, 'docs', 'omb-v3-refactor-plan.md'), 'utf8')

/**
 * 从配置源码里取导出的常量。
 *
 * 为什么不 `import`：`eslint.config.mjs` 在 TS 侧没有声明文件，`import` 会让
 * `tsc --noEmit` 报 TS7016（找不到声明）；而它是唯一真源，复制一份到测试里
 * 正是本测试要防的事。读源码文本是这里代价最低且不会说谎的做法。
 */
function exportedStringList(name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]`).exec(configSource)?.[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map(match => match[1] as string)
}

const budget = Number(/export const KERNEL_LINE_BUDGET = (\d+)/.exec(configSource)?.[1])
const lineExempt = exportedStringList('KERNEL_LINE_BUDGET_EXEMPT')

/** 把一段源码按指定名字喂给 eslint（不落盘），返回 JSON 报文。 */
function lintAs(filename: string, source: string) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--stdin', '--stdin-filename', filename, '--format', 'json'],
    { cwd: root, input: source, encoding: 'utf8' },
  )
  const report = JSON.parse(result.stdout || '[]') as Array<{
    messages: Array<{ ruleId?: string; message: string; line: number; column: number }>
  }>
  return { status: result.status, messages: report[0]?.messages ?? [] }
}

describe('内核纯度护栏：代码与文档是同一件事', () => {
  it('行数上限的数字在 eslint 常量与 refactor-plan 文档里一致', () => {
    expect(budget, 'eslint.config.mjs 里没有再导出 KERNEL_LINE_BUDGET').toBeGreaterThan(0)
    expect(
      planDoc,
      `docs/omb-v3-refactor-plan.md 必须写下同一个上限「≤${budget} 行」——`
      + '文档里的数字与 eslint 实现不一致时，读文档的人会以为有一条不存在的护栏',
    ).toContain(`≤${budget} 行`)
  })

  it('行数豁免名单逐条写进了文档（豁免必须说得出理由，不能只活在代码里）', () => {
    expect(lineExempt.length, 'KERNEL_LINE_BUDGET_EXEMPT 为空：要么真的没有豁免，要么常量被改名了').toBeGreaterThan(0)
    for (const entry of lineExempt) {
      expect(
        planDoc,
        `eslint 豁免了 kernel/${entry}，但文档里没有点名它——豁免名单与文档必须逐字一致`,
      ).toContain(`kernel/${entry}`)
    }
  })

  it('R7 那条风险缓解指向真实存在的规则 id', () => {
    expect(planDoc).toContain('omb/kernel-purity')
  })
})

describe('内核纯度护栏：判据真的会响', () => {
  it('内核里出现业务词汇标识符 → 报错，带词汇与位置（当前实现只查文件名时这条会失败）', () => {
    const { status, messages } = lintAs('kernel/status.ts', 'export const memoryProbe = 1\n')
    expect(status, '标识符里的业务词汇没有被拦下——护栏只剩文件名一条判据').toBe(1)
    const hit = messages.find(message => message.ruleId === 'omb/kernel-purity')
    expect(hit, `期望 omb/kernel-purity 报错，实际报文：${JSON.stringify(messages)}`).toBeDefined()
    expect(hit?.message).toContain('"memory"')
    expect(hit?.message).toContain('memoryProbe')
    // 位置：报告得指出在哪一行哪一列，否则修的人还得自己找
    expect(hit?.line).toBe(1)
    expect(hit?.column).toBe(14)
  })

  it('超过行数上限的文件被报错，且报文里写出实际行数', () => {
    const source = `${'// filler\n'.repeat(400)}export const nothing = 1\n`
    const { status, messages } = lintAs('kernel/probe-budget.ts', source)
    expect(status).toBe(1)
    const hit = messages.find(message => message.ruleId === 'omb/kernel-purity')
    // 401 = 400 行填充 + 最后一行 `export`；报文里的行数必须是**实际**行数，不能是个约数
    expect(hit?.message).toContain('401 行')
    expect(hit?.message).toContain(String(budget))
  })

  it('反向断言：干净的内核文件照常通过（不许把护栏开成噪音）', () => {
    expect(lintAs('kernel/status.ts', 'export const turnCount = 1\n').status).toBe(0)
  })

  it('反向断言：豁免名单内的文件不报行数（kernel/index.ts 现实就是 700+ 行）', () => {
    const source = readFileSync(join(root, 'kernel', 'index.ts'), 'utf8')
    expect(source.split('\n').length).toBeGreaterThan(budget)
    const { status, messages } = lintAs('kernel/index.ts', source)
    expect(
      messages.filter(message => message.message.includes('超出代码预算')),
      'kernel/index.ts 在 KERNEL_LINE_BUDGET_EXEMPT 里，不该报行数',
    ).toEqual([])
    expect(status).toBe(0)
  })
}, 30_000)
