/**
 * 提示注入**惰性装配**回归：这条链路曾经从未生效（是整条链路，不是某一段）。
 *
 * ## 真机症状（三条独立证据，都来自 `omb_status`）
 *
 * ① 状态面段落显示「常驻提示 0/120 字符（无贡献者）」
 * ② `omb-reasoning` 同时显示「常驻提示 104/120 字符」且「上次注入：尚无（还没有渲染过）」
 * ③ 代码：`wirePromptInjection` 把 `contributions` 解构成**一个被捕获的数组**，
 *    而 `dsh/plugin.ts` 在**内核行的 `apply` 里同步**传入
 *    `collectPromptContributions(handle.kernel)`。模块行都 `inject: ['omb:kernel']`，
 *    必须等内核把该服务发布出来才挂载——**不可能在那次同步 `apply` 中途挂上**
 *    → 那一刻收集到的必然是**空集**。
 *
 * 后果：推理模块的常驻提示、用户画像的冲突摘要、任何模块的 `context()` 易变段
 * **从未到达模型**；而所有健康面都是绿的、服务都注册了、工具都能调
 * （"所有健康面是绿的、能力都注册了，只是从未生效"）。
 *
 * ## 这不是新缺陷
 *
 * 工具面早已修过**同一个根因**（`dsh/plugin.ts` 的 `disposeToolResync`：一次性收集的
 * 结果是只有内核自带的 `omb_status` 进了工具面，其余 7 个工具**全部消失**，
 * 而健康面一切正常）。提示面从来没有得到同样的处理。
 *
 * ## 为什么现有测试一条都没红
 *
 * `tests/dsh/session.test.ts` 与 `tests/dsh/resident-budget.test.ts` **全部**是
 * 先建好模块、再接线（"装配时就位"）——那恰好是唯一能工作的那条路径。
 * 所以本文件是防它复发的**唯一护栏**：这里的模块**必须在 `wirePromptInjection`
 * 返回之后**才 `provide('prompt:<id>', …)`，与真机上宿主异步挂载模块行的顺序一致。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RESIDENT_BUDGET_STATUS_NAME,
  collectPromptContributions,
  residentHintReport,
  wirePromptInjection,
} from '../../dsh/session.js'
import { createKernel, type KernelHandle } from '../../kernel/index.js'
import { promptWiringOptions, testHostContext } from '../../dsh/plugin.js'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync } from '../../dsh/modules.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'
import { RESIDENT_HINT_MAX, SERVICES } from '../../kernel/abi/index.js'
import type { ModuleRegistration, PromptContribution, StatusRegistry } from '../../kernel/abi/index.js'

/** 迟到模块的常驻文案。字符数在断言里现算，避免测试自己钉一个会漂的数字。 */
const LATE_RESIDENT = '迟到的模块也必须到达模型'

/** 真机上推理模块的常驻提示实测占 104 字符（`modules/reasoning/methods.ts:152`）。 */
const REASONING_CHARS = 104

/**
 * 造一个只做一件事的模块登记项：provide 一个 `prompt:<name>` 贡献。
 *
 * `apply` **返回 provide 的 disposer**——真实模块都这么做；于是宿主卸下这一行时
 * 服务真的会消失，本文件才能测"卸下后账目要如实归零"（否则服务会留在表里）。
 */
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
    apply: (kernel) => kernel.provide(`prompt:${name}`, contribution),
  }
}

/**
 * 假的宿主 `systemPrompt`。
 *
 * `text()` 就是"宿主每轮装配上下文时取一次注入文本"那个入口——
 * 本文件所有断言都必须经过它，否则测的就不是真正注入给模型的那份文本。
 */
function fakeSystemPrompt(): {
  readonly calls: readonly unknown[]
  context(entry: unknown): unknown
  text(ctx?: unknown): string
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

/** 取状态面里常驻预算那一行（其它段落不属于本测试的比较范围）。 */
function budgetReportLine(handle: KernelHandle): string {
  return handle.status().find(line => line.startsWith('常驻提示')) ?? '（状态面里没有常驻预算这一行）'
}

describe('提示注入：模块晚于接线挂载（惰性贡献集合）', () => {
  it('核心：wirePromptInjection 返回之后才 provide 的模块，注入文本与状态面都看得到', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()

    // 真实调用点的形状（`dsh/plugin.ts`）：传**提供者**，每次渲染重新扫服务表
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    // 接线那一刻：模块行还没挂上（内核 apply 是同步的，模块行由宿主异步挂载）。
    // 这不是"测试没准备好"，这就是真机当时的情形——缺陷正藏在这里。
    expect(sp.text({})).toBe('')

    // 宿主稍后挂载模块行（本行就是"那次同步 apply 之后"）
    h.start([promptModule('omb-late', { resident: LATE_RESIDENT })])

    // ① 注入给模型的那段文本里必须**出现**这个模块的 resident
    const injected = sp.text({})
    expect(injected).toContain(LATE_RESIDENT)

    // ② 状态面段落里也必须出现它，且字符数与注入文本**一致**
    //    （不是 0/120，不是"无贡献者"——那正是真机上两个面互相矛盾的那个 0）
    const status = h.status().join('\n')
    expect(status).toContain(`常驻提示 ${injected.length}/${RESIDENT_HINT_MAX} 字符`)
    expect(status).toContain(`omb-late ${LATE_RESIDENT.length}/${LATE_RESIDENT.length}`)
    expect(status).not.toContain('无贡献者')

    dispose()
  })

  it('真机症状：后挂载的 104 字符模块把状态面从 0/120 改成 104/120，不再与注入文本矛盾', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    // ① 装配那一刻确实是空的——如实说"无贡献者"是对的，错的是**一直**这么说
    expect(budgetReportLine(h)).toContain('无贡献者')

    h.start([promptModule('omb-reasoning', { resident: 'x'.repeat(REASONING_CHARS) })])

    // ② 现在注入里有 104 字符，状态面必须跟着改口
    expect(sp.text({})).toBe('x'.repeat(REASONING_CHARS))
    const line = budgetReportLine(h)
    expect(line).toContain(`常驻提示 ${REASONING_CHARS}/${RESIDENT_HINT_MAX} 字符`)
    expect(line).toContain(`omb-reasoning ${REASONING_CHARS}/${REASONING_CHARS}`)
    expect(line).not.toContain('无贡献者')

    dispose()
  })

  it('迟到的 context() 易变段同样到达模型（易变集合也必须实时解析）', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })
    expect(sp.text({})).toBe('')

    h.start([promptModule('omb-late-context', {
      resident: '常驻段',
      context: input => `易变段(${input.sessionId || '无会话'})`,
    })])

    const injected = sp.text({})
    expect(injected).toContain('常驻段')
    expect(injected).toContain('易变段(')

    dispose()
  })

  it('模块被卸下后常驻提示随之消失（热插拔两个方向都要如实）', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    // 走真实宿主路径（`mount`）：返回的 disposer 就是"宿主关掉这一行"
    const unmount = h.mount(promptModule('omb-late', { resident: LATE_RESIDENT }))
    expect(sp.text({})).toBe(LATE_RESIDENT)
    expect(budgetReportLine(h)).toContain('omb-late')

    unmount()
    expect(sp.text({})).toBe('')
    expect(budgetReportLine(h)).toContain('无贡献者')

    dispose()
  })

  it('机器可读指标同样是实时账目（metrics 与注入文本一致，不是装配时快照）', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })
    const registry = h.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    const section = registry?.list().find(c => c.name === RESIDENT_BUDGET_STATUS_NAME)

    // 装配那一刻：0 个贡献者（当时的事实，不是缺陷）
    expect(section?.metrics?.()).toMatchObject({ residentChars: 0, residentContributors: 0 })

    h.start([promptModule('omb-late', { resident: LATE_RESIDENT })])

    const injected = sp.text({})
    expect(section?.metrics?.()).toMatchObject({
      residentChars: injected.length,
      residentLimit: RESIDENT_HINT_MAX,
      residentContributors: 1,
      residentTruncated: 0,
    })

    dispose()
  })
})

describe('提示注入：新旧签名行为一致（数组 = 已固定的集合，提供者 = 每次现算）', () => {
  /** 同一份集合、同一份文案，两条签名各接一次线，然后比较注入文本与账目。 */
  function wireBoth(contribution: PromptContribution): {
    readonly arrayText: string
    readonly providerText: string
    readonly arrayLine: string
    readonly providerLine: string
    dispose(): void
  } {
    const withArray = createKernel()
    withArray.start([promptModule('omb-same', contribution)])
    const spArray = fakeSystemPrompt()
    const disposeArray = wirePromptInjection({
      kernel: withArray.kernel,
      // 旧签名：直接给数组（现有调用方与测试都这么用）
      contributions: collectPromptContributions(withArray.kernel),
      systemPrompt: spArray,
      clock: withArray.kernel.clock,
    })

    const withProvider = createKernel()
    withProvider.start([promptModule('omb-same', contribution)])
    const spProvider = fakeSystemPrompt()
    const disposeProvider = wirePromptInjection({
      kernel: withProvider.kernel,
      // 新签名：提供者（`dsh/plugin.ts` 的真实调用形状）
      contributions: () => collectPromptContributions(withProvider.kernel),
      systemPrompt: spProvider,
      clock: withProvider.kernel.clock,
    })

    return {
      arrayText: spArray.text({}),
      providerText: spProvider.text({}),
      arrayLine: budgetReportLine(withArray),
      providerLine: budgetReportLine(withProvider),
      dispose: () => { disposeArray(); disposeProvider() },
    }
  }

  it('装配时就位：数组签名与提供者签名给出逐字相同的注入文本与账目', () => {
    const both = wireBoth({ resident: LATE_RESIDENT })

    expect(both.providerText).toBe(both.arrayText)
    expect(both.providerText).toBe(LATE_RESIDENT)
    expect(both.providerLine).toBe(both.arrayLine)
    expect(both.providerLine).toContain(`omb-same ${LATE_RESIDENT.length}/${LATE_RESIDENT.length}`)

    both.dispose()
  })

  it('空集合：两条签名都注入空文本、状态面都说"无贡献者"', () => {
    const both = wireBoth({})

    expect(both.arrayText).toBe('')
    expect(both.providerText).toBe('')
    expect(both.arrayLine).toContain('无贡献者')
    expect(both.providerLine).toContain('无贡献者')

    both.dispose()
  })

  it('dispose 后状态面段落注销（提供者路径同样不留残留），且 disposer 幂等', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })
    h.start([promptModule('omb-late', { resident: LATE_RESIDENT })])

    expect(h.statusNames()).toContain(RESIDENT_BUDGET_STATUS_NAME)
    dispose()
    expect(h.statusNames()).not.toContain(RESIDENT_BUDGET_STATUS_NAME)
    expect(() => dispose()).not.toThrow()
  })

  it('跨轮渲染逐字节稳定（惰性求值不得引入时间戳/计数，否则整段前缀缓存失效）', () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => collectPromptContributions(h.kernel),
      systemPrompt: sp,
      clock: h.kernel.clock,
    })
    h.start([promptModule('omb-late', { resident: LATE_RESIDENT })])

    const first = sp.text({})
    for (let round = 0; round < 5; round += 1) expect(sp.text({})).toBe(first)
    // 常驻文本进的是模型可见的缓存前缀：不得混入时钟/计数器
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/)

    dispose()
  })
})

describe('调用点接线：真实调用点（dsh/plugin.ts）必须传提供者', () => {
  /**
   * 这条护栏盯的是**接线处本身**：`promptWiringOptions` 若改回
   * `contributions: collectPromptContributions(handle.kernel)`（一次性收集的数组），
   * 上面所有"模块晚于接线挂载"的测试**照样会绿**（它们自己传的提供者），
   * 而真机上整条链路又会无声地失效。所以必须钉住真实调用点交出来的形状。
   */
  it('给出的 contributions 是提供者，且能看见接线之后才挂上的模块', () => {
    const h = createKernel()
    const options = promptWiringOptions({ handle: h, ctx: testHostContext(h), clock: h.kernel.clock })

    // ① 必须是函数：数组形态在这个位置等价于"装配时的空集"，整条链路从未生效
    expect(typeof options.contributions).toBe('function')

    // ② 它必须真的问"此刻"的服务表：接线之后挂上的模块要被收集到
    h.start([promptModule('omb-late', { resident: LATE_RESIDENT })])
    const source = options.contributions
    const collected = typeof source === 'function' ? source() : source
    expect(collected).toEqual([{ id: 'omb-late', resident: LATE_RESIDENT }])

    // ③ 用这份选项接线：注入文本里确实有它（把 ①② 接到真实链路上）
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({ ...options, systemPrompt: sp })
    expect(sp.text({})).toContain(LATE_RESIDENT)

    dispose()
  })

  /**
   * 端到端：**真实模块清单** + 与真机相同的装配顺序（先接线、后挂模块行）。
   *
   * 这条是本次缺陷最直接的复现：真机症状正是"状态面 0/120（无贡献者）"
   * 与"omb-reasoning 104/120"同时出现。修复前，下面第一条断言
   * （注入文本里含推理模块的常驻提示）就不可能成立。
   */
  it('端到端（真实模块清单）：推理模块的常驻提示真的进了注入文本，状态面也如实记账', async () => {
    const h = createKernel()
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      ...promptWiringOptions({ handle: h, ctx: testHostContext(h), clock: h.kernel.clock }),
      systemPrompt: sp,
    })

    // 与真机同序：接线这一刻同步跑完，模块行（宿主异步挂载）还没到——集合为空
    expect(sp.text({})).toBe('')
    expect(budgetReportLine(h)).toContain('无贡献者')

    // 宿主随后把真实模块行逐个挂上（与 `tests/dsh/assembly.smoke.test.ts` 同一条路径）。
    // `toHostPlugin().apply()` 是**异步**挂载的（它先 await 内核就绪，再 mount）——
    // 这正是本次缺陷的前提：模块不可能在同步 apply 中途挂上。
    h.kernel.provide(SERVICES.kernel, h.kernel)
    const loaded = loadModulesSync(MODULE_ENTRIES)
    const host = testHostContext(h)
    for (const registration of loaded.modules) toHostPlugin(registration).apply(host)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    const reasoning = collectPromptContributions(h.kernel).find(c => c.id === 'omb-reasoning')
    expect(reasoning?.resident, '真实清单里推理模块必须提供常驻提示').toBeTruthy()
    const hint = reasoning?.resident?.trim() ?? ''

    // ① 到达模型（修复前这里是空的——整条提示链路从未生效）
    const injected = sp.text({})
    expect(injected).toContain(hint)

    // ② 状态面不再是那个冻结的 0，也不再与模块自述矛盾
    const line = budgetReportLine(h)
    expect(line).toContain('omb-reasoning')
    expect(line).not.toContain('无贡献者')
    expect(line).not.toContain('常驻提示 0/')

    // ③ 状态面报的数字 = **此刻**集合算出来的账目，且注入文本正是以那段常驻文本开头
    const expected = residentHintReport(collectPromptContributions(h.kernel))
    expect(line).toContain(`常驻提示 ${expected.used}/${expected.limit} 字符`)
    expect(injected.startsWith(expected.text)).toBe(true)

    dispose()
  })
})

describe('提示注入：诊断路径本身绝不成为新的失败源', () => {
  it('提供者抛异常：注入不炸（按空集合处理），并留一条可读告警', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => { throw new Error('扫服务表时炸了') },
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    expect(() => sp.text({})).not.toThrow()
    expect(sp.text({})).toBe('')
    expect(budgetReportLine(h)).toContain('无贡献者')
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('扫服务表时炸了')

    dispose()
  })

  it('模块给了形状不对的贡献（resident 不是字符串）：宿主渲染路径不炸，退回空账目并留声', () => {
    const warn = vi.fn()
    const h = createKernel({ logger: { debug() {}, info() {}, warn } })
    const sp = fakeSystemPrompt()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions: () => [{ id: 'omb-garbage', resident: 42 } as unknown as PromptContribution],
      systemPrompt: sp,
      clock: h.kernel.clock,
    })

    // 惰性化把"记账"挪进了宿主的每轮渲染路径：这里抛出去会打断会话的上下文装配，
    // 所以脏数据必须在本层被挡住（退回空账目 + 一条可读留声），而不是往上冒。
    expect(() => sp.text({})).not.toThrow()
    expect(sp.text({})).toBe('')
    expect(budgetReportLine(h)).toContain('无贡献者')
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('提示贡献')

    dispose()
  })
})
