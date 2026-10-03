/**
 * C1 回归：常驻提示超预算**不得静默**。
 *
 * ## 这次踩的坑（为什么这个文件存在）
 *
 * `dsh/session.ts` 的 `residentHint` 一旦超限就 `slice(0, 120)` 了事：
 * 不报错、不告警、不改健康面。实测推理模块的常驻提示一条就占 **104/120**
 * （`modules/reasoning/methods.ts:152` 的变体选择当前选中 104 字符那条），
 * **只剩 16 字符余量**——将来任何模块（或现有模块改一句文案）多写几个字，
 * 就会悄悄吃掉排在它后面的模块的常驻提示，而被吃掉的模块毫无痕迹。
 * 症状是"某个能力莫名其妙不生效"，而所有模块健康面都是绿的。
 *
 * ## 这里钉住四件事
 *
 * ① **账目可读**：谁贡献了多少字符、合计多少、有没有被截、被截的是谁、丢了多少
 * ② **留声**：超限进 `kernel.logger`（warn），并进状态面（`omb_status` 的段落可见）
 * ③ **超限不使插件加载失败**：这是配置/文案问题，不是崩溃（与 H-1「disposer 绝不抛」同源）
 * ④ **旧契约不破**：`residentHint()` 仍返回裁到上限的字符串，且逐字节稳定
 *
 * 旧的断言只检查"返回值被截断"，于是它**永远通过**——这正是静默缺陷能活下来的原因。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RESIDENT_BUDGET_STATUS_NAME,
  collectPromptContributions,
  residentHint,
  residentHintReport,
  wirePromptInjection,
} from '../../dsh/session.js'
import { createKernel } from '../../kernel/index.js'
import { RESIDENT_HINT_MAX, SERVICES } from '../../kernel/abi/index.js'
import type { ModuleRegistration, PromptContribution, StatusRegistry } from '../../kernel/abi/index.js'

/** 推理模块当前占用的字符数（实测值：见文件头）。留作"余量很小"的活证据。 */
const REASONING_CHARS = 104

/** 两个模块各自写满：104 + 1（分隔符）+ 104 = 209 > 120，第二个必然被截。 */
const OVER: readonly PromptContribution[] = [
  { id: 'omb-reasoning', resident: 'x'.repeat(REASONING_CHARS) },
  { id: 'omb-context', resident: 'y'.repeat(REASONING_CHARS) },
]

/** 造一个只做一件事的模块登记项：provide 一个 `prompt:<id>` 贡献。 */
function promptModule(name: string, contribution: PromptContribution): ModuleRegistration<unknown> {
  return {
    manifest: {
      id: name,
      version: '1',
      requires: [],
      capabilities: [],
      configSchema: { parse: (input: unknown) => input },
      health: () => ({ state: 'ok', detail: '' }),
    },
    apply: (kernel) => { kernel.provide(`prompt:${name}`, contribution) },
  }
}

function fakeSystemPrompt(): {
  calls: unknown[]
  context: (entry: unknown) => unknown
  /** 宿主每轮装配上下文时取一次注入文本的那个入口。 */
  text: (ctx?: unknown) => string
} {
  const calls: unknown[] = []
  return {
    calls,
    context(entry: unknown) {
      calls.push(entry)
      return () => {}
    },
    text(ctx: unknown = {}) {
      const entry = calls.at(-1) as { text?: (c: unknown) => string } | undefined
      if (typeof entry?.text !== 'function') throw new Error('宿主没有拿到 text 回调——注入根本没注册')
      return entry.text(ctx)
    },
  }
}

describe('residentHintReport：超预算必须成为可读事实', () => {
  it('超限时点名被截的模块与丢掉的字符数（不再是一刀切掉尾巴）', () => {
    const report = residentHintReport(OVER)

    expect(report.truncated).toBe(true)
    expect(report.limit).toBe(RESIDENT_HINT_MAX)
    expect(report.used).toBe(RESIDENT_HINT_MAX)
    expect(report.total).toBe(REASONING_CHARS + 1 + REASONING_CHARS)

    // 逐项账目：谁给了多少、实际进去多少
    expect(report.entries).toEqual([
      { id: 'omb-reasoning', chars: REASONING_CHARS, kept: REASONING_CHARS, truncated: false },
      { id: 'omb-context', chars: REASONING_CHARS, kept: 15, truncated: true },
    ])
    expect(report.clipped.map(e => e.id)).toEqual(['omb-context'])

    // **报告必须可读**：含被截的模块名与字符数（89 = 104 - 15）
    expect(report.report).toContain('omb-context')
    expect(report.report).toContain('89/104')
    expect(report.report).toContain('209')
    expect(report.report).toContain('120')

    // 截断行为本身保留：文本仍恰好是前 120 个字符（逐字节可预测）
    expect(report.text).toBe(`${'x'.repeat(REASONING_CHARS)}\n${'y'.repeat(REASONING_CHARS)}`.slice(0, RESIDENT_HINT_MAX))
  })

  it('整条被吃掉的模块也在账上（kept=0），不许从报告里消失', () => {
    const report = residentHintReport([
      { id: 'omb-first', resident: 'a'.repeat(RESIDENT_HINT_MAX + 10) },
      { id: 'omb-second', resident: 'b'.repeat(10) },
    ])

    expect(report.entries[1]).toEqual({ id: 'omb-second', chars: 10, kept: 0, truncated: true })
    expect(report.clipped.map(e => e.id)).toEqual(['omb-first', 'omb-second'])
    // 被整条吃掉的那个模块必须被点名——它自己不会知道，只有这里能告诉运维
    expect(report.report).toContain('omb-second')
  })

  it('未超限也如实记账（谁给了多少、还剩多少余量）——风险要在爆掉之前就看得见', () => {
    const report = residentHintReport([
      { id: 'omb-reasoning', resident: 'x'.repeat(REASONING_CHARS) },
      { id: 'omb-profile', resident: '常驻' },
    ])

    expect(report.truncated).toBe(false)
    expect(report.used).toBe(REASONING_CHARS + 1 + 2)
    expect(report.clipped).toEqual([])
    expect(report.entries.map(e => [e.id, e.chars, e.kept])).toEqual([
      ['omb-reasoning', REASONING_CHARS, REASONING_CHARS],
      ['omb-profile', 2, 2],
    ])
    expect(report.report).toContain('未截断')
    expect(report.report).toContain('余量 13')
    expect(report.report).toContain('omb-reasoning 104/104')
  })

  it('逐字节稳定：同一输入两次的文本与报告逐字相同（前缀缓存硬要求）', () => {
    const a = residentHintReport(OVER)
    const b = residentHintReport([
      { id: 'omb-reasoning', resident: 'x'.repeat(REASONING_CHARS) },
      { id: 'omb-context', resident: 'y'.repeat(REASONING_CHARS) },
    ])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 报告里不得混入时钟/计数一类会跨轮变化的东西
    expect(a.report).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/)
  })

  it('匿名贡献也进账（模块没写 id 时按序号点名，不许因为没署名就消失）', () => {
    const report = residentHintReport([{ resident: 'x'.repeat(10) }, { resident: 'y'.repeat(200) }])

    expect(report.entries.map(e => e.chars)).toEqual([10, 200])
    expect(report.entries[0]!.id.length).toBeGreaterThan(0)
    expect(report.entries[0]!.id).not.toBe(report.entries[1]!.id)
    expect(report.report).toContain(report.entries[1]!.id)
  })

  it('截断点落在代理对中间时不留下半个字符（孤立代理会让提示文本非法）', () => {
    const report = residentHintReport([
      { id: 'omb-emoji', resident: `${'x'.repeat(RESIDENT_HINT_MAX - 1)}😀` },
    ])

    expect(report.truncated).toBe(true)
    expect(report.used).toBe(RESIDENT_HINT_MAX - 1)
    expect(/[\uD800-\uDBFF]$/.test(report.text)).toBe(false)
    // 账目与文本必须是同一份事实：kept 之和不可能超过实际用掉的字符数
    expect(report.entries[0]!.kept).toBe(report.used)
  })

  it('上限可传入（便于测试与将来把预算做成可配），非有限值退回内核上限', () => {
    expect(residentHintReport([{ id: 'a', resident: 'abcde' }], 3)).toMatchObject({
      text: 'abc',
      limit: 3,
      used: 3,
      truncated: true,
      entries: [{ id: 'a', chars: 5, kept: 3, truncated: true }],
    })
    // Number.NaN 不该把常驻提示清空（模块层同样这么兜底：methods.ts:153）
    expect(residentHintReport([{ id: 'a', resident: 'abc' }], Number.NaN).limit).toBe(RESIDENT_HINT_MAX)
  })
})

describe('residentHint：旧契约不破（返回值仍是裁到上限的字符串）', () => {
  it('与报告里的 text 是同一份事实（不可能各算一遍而漂移）', () => {
    const small: readonly PromptContribution[] = [{ id: 'a', resident: '甲' }, { id: 'b', resident: '乙' }]
    expect(residentHint(small)).toBe('甲\n乙')
    expect(residentHint(small)).toBe(residentHintReport(small).text)

    expect(residentHint(OVER).length).toBe(RESIDENT_HINT_MAX)
    expect(residentHint(OVER)).toBe(residentHintReport(OVER).text)
  })
})

describe('collectPromptContributions：贡献者标识由服务名兜底', () => {
  it('模块只要 provide 一个 prompt:<id>，署名自动到位（模块不用改，也不会忘记署名）', () => {
    const h = createKernel()
    h.start([promptModule('omb-x', { resident: '来自 x' })])
    expect(collectPromptContributions(h.kernel)).toEqual([{ resident: '来自 x', id: 'omb-x' }])
  })

  it('模块自报的 id 优先（服务名只是兜底）', () => {
    const h = createKernel()
    h.start([promptModule('omb-x', { id: '自定义署名', resident: '来自 x' })])
    expect(collectPromptContributions(h.kernel)).toEqual([{ id: '自定义署名', resident: '来自 x' }])
  })

  it('不篡改模块自己 provide 的那份对象（只包装返回值）', () => {
    const h = createKernel()
    const provided: PromptContribution = { resident: '来自 x' }
    h.start([promptModule('omb-x', provided)])
    collectPromptContributions(h.kernel)
    expect(provided.id).toBeUndefined()
    expect(h.kernel.service<PromptContribution>('prompt:omb-x')).toBe(provided)
  })
})

describe('wirePromptInjection：超限留声，但不让插件加载失败', () => {
  it('超限：warn 里能读到被截的模块与字符数，且注入照常注册（配置问题不是崩溃）', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const sp = fakeSystemPrompt()

    const dispose = wirePromptInjection({
      kernel: h.kernel, contributions: OVER, systemPrompt: sp, clock: h.kernel.clock,
    })

    // ① 不因超预算放弃注入：宿主那边照常注册一次
    expect(sp.calls).toHaveLength(1)
    // ② 留声：可读报告进了日志
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain('omb-context')
    expect(logged).toContain('89/104')
    expect(() => dispose()).not.toThrow()
  })

  it('超限：状态面点名被截的模块与字符数（omb_status 看得到）', () => {
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel, contributions: OVER, systemPrompt: fakeSystemPrompt(), clock: h.kernel.clock,
    })

    expect(h.statusNames()).toContain(RESIDENT_BUDGET_STATUS_NAME)
    const text = h.status().join('\n')
    expect(text).toContain('omb-context')
    expect(text).toContain('89/104')
    expect(text).toContain('超限')

    dispose()
    expect(h.statusNames()).not.toContain(RESIDENT_BUDGET_STATUS_NAME)
  })

  it('状态面同时给出机器可读指标（截断与否 / 被截条数 / 上限）', () => {
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel, contributions: OVER, systemPrompt: fakeSystemPrompt(), clock: h.kernel.clock,
    })

    const registry = h.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    const section = registry?.list().find(c => c.name === RESIDENT_BUDGET_STATUS_NAME)
    expect(section?.metrics?.()).toMatchObject({
      residentChars: RESIDENT_HINT_MAX,
      residentLimit: RESIDENT_HINT_MAX,
      residentTotal: 209,
      residentTruncated: 1,
      residentClipped: 1,
      residentContributors: 2,
    })

    dispose()
  })

  it('未超限：不告警（告警是稀缺资源），但账目仍在状态面', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: [{ id: 'omb-reasoning', resident: 'x'.repeat(REASONING_CHARS) }],
      systemPrompt: fakeSystemPrompt(),
      clock: h.kernel.clock,
    })

    expect(warn).not.toHaveBeenCalled()
    const text = h.status().join('\n')
    expect(text).toContain(RESIDENT_BUDGET_STATUS_NAME)
    expect(text).toContain('未截断')
    // 余量 16 —— 这正是"下一个人再写长一点就会吃掉别人"的预警数字
    expect(text).toContain('余量 16')

    dispose()
  })

  it('宿主 systemPrompt 不可用：账目与"未接入"的原因仍然可读（注入没生效也必须能看出来）', () => {
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel, contributions: OVER, systemPrompt: undefined, clock: h.kernel.clock,
    })

    const text = h.status().join('\n')
    expect(text).toContain(RESIDENT_BUDGET_STATUS_NAME)
    expect(text).toContain('未接入')
    expect(() => { dispose(); dispose() }).not.toThrow()
  })

  it('端到端：两个模块的常驻提示装不下时，状态面点名被吃掉的那个（而不是悄悄吃掉）', () => {
    const h = createKernel()
    // 服务名排序稳定（`kernel/services.ts:33`），因此 aaa 在前、zzz 被截是确定的
    h.start([
      promptModule('omb-aaa', { resident: 'x'.repeat(REASONING_CHARS) }),
      promptModule('omb-zzz', { resident: 'y'.repeat(REASONING_CHARS) }),
    ])
    const contributions = collectPromptContributions(h.kernel)
    // 归属来自服务名：模块自己一个字都不用改
    expect(contributions.map(c => c.id)).toEqual(['omb-aaa', 'omb-zzz'])

    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions,
      systemPrompt: fakeSystemPrompt(),
      clock: h.kernel.clock,
    })

    const entry = h.status().join('\n')
    expect(entry).toContain('超限')
    expect(entry).toContain('omb-aaa 104/104')
    expect(entry).toContain('omb-zzz 15/104')

    dispose()
  })

  /**
   * 账目从"装配时算一次"改成"每次渲染现算"（模块行由宿主**异步**挂载，
   * 装配那一刻集合必然是空的——这正是整条提示链路曾经从未生效的根因）之后，
   * 新的风险是**刷屏**：若不去重，一个超限配置会在每一轮装配、每次 `omb_status`
   * 里各 warn 一次。告警是稀缺资源，刷屏等于没有告警——真正的新问题会被淹没。
   *
   * 契约：**同一份报告只 warn 一次，内容变了再报**。
   */
  it('超限只 warn 一次：同一份超限跨多次渲染不刷屏', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const sp = fakeSystemPrompt()
    const over = (): unknown[][] =>
      warn.mock.calls.filter(call => String(call[0]).includes('超预算'))

    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => OVER,
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    // 宿主每轮装配都要取一次注入文本；运维可能反复打开状态面
    sp.text({}); sp.text({}); sp.text({})
    h.status(); h.status()

    expect(over()).toHaveLength(1)
    expect(String(over()[0]?.[0])).toContain('omb-context')
    dispose()
  })

  it('超限内容变了再报：去重按报告内容，不是"报过一次就永远闭嘴"', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const sp = fakeSystemPrompt()
    const over = (): unknown[][] =>
      warn.mock.calls.filter(call => String(call[0]).includes('超预算'))
    let current: readonly PromptContribution[] = OVER

    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => current,
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    sp.text({})
    expect(over()).toHaveLength(1)

    // 又多了一个模块被挤出去：账目变了，必须再报一次——否则"变了"这件事没人知道
    current = [...OVER, { id: 'omb-third', resident: 'z'.repeat(10) }]
    sp.text({})

    expect(over()).toHaveLength(2)
    expect(String(over()[1]?.[0])).toContain('omb-third')
    dispose()
  })
})
