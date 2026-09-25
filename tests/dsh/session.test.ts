/**
 * 会话侧集成测试。
 *
 * 重点钉住两条硬约束：
 * ① **常驻提示跨轮逐字节稳定**——它进入系统提示的稳定前缀，
 *    任何波动都会让其后整段前缀缓存失效（规划 §6.5）
 * ② **单个模块的渲染/回收失败被隔离**——不得让整份注入或整次开关失败
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_ORDER,
  SessionTable,
  collectPromptContributions,
  extractText,
  fingerprint,
  renderContext,
  residentHint,
  wirePromptInjection,
} from '../../dsh/session.js'
import { createKernel } from '../../kernel/index.js'
import { RESIDENT_HINT_MAX } from '../../kernel/abi/index.js'
import type { PromptContribution } from '../../kernel/abi/index.js'

describe('residentHint：稳定性与上限', () => {
  it('合并多个模块的常驻提示', () => {
    expect(residentHint([{ resident: '甲' }, { resident: '乙' }])).toBe('甲\n乙')
  })

  it('跳过缺失与空白', () => {
    expect(residentHint([{}, { resident: '  ' }, { resident: '丙' }])).toBe('丙')
  })

  it('裁到 RESIDENT_HINT_MAX', () => {
    const long = 'x'.repeat(RESIDENT_HINT_MAX + 50)
    expect(residentHint([{ resident: long }]).length).toBe(RESIDENT_HINT_MAX)
  })

  it('相同输入 → 逐字节相同（前缀缓存的硬要求）', () => {
    const contributions: readonly PromptContribution[] = [{ resident: '先判断这个问题值多少思考' }]
    const a = residentHint(contributions)
    const b = residentHint(contributions)
    expect(a).toBe(b)
    // 不含量随时间变化的成分
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{10,}/)
  })
})

describe('renderContext：失败隔离', () => {
  const input = { sessionId: 's1', depth: 'standard', band: 'relaxed' } as const

  it('合并多个模块的动态段', () => {
    const out = renderContext([{ context: () => '甲' }, { context: () => '乙' }], input)
    expect(out).toBe('甲\n\n乙')
  })

  it('单个模块抛异常不影响其余（否则一个坏模块会让整份注入失败）', () => {
    const out = renderContext([
      { context: () => { throw new Error('boom') } },
      { context: () => '好的那个' },
    ], input)
    expect(out).toBe('好的那个')
  })

  it('空段被跳过', () => {
    expect(renderContext([{ context: () => '   ' }], input)).toBe('')
  })

  it('把档位与压力传给模块（这是思维链层与上下文层的接口）', () => {
    let seen: unknown
    renderContext([{ context: (i) => { seen = i; return '' } }], { sessionId: 's2', depth: 'deep', band: 'tight' })
    expect(seen).toEqual({ sessionId: 's2', depth: 'deep', band: 'tight' })
  })
})

describe('collectPromptContributions：按前缀发现服务', () => {
  it('不硬编码服务名——加模块只需它 provide 一个 prompt:* ', () => {
    const h = createKernel()
    h.start([{
      manifest: {
        id: 'x', version: '1', requires: [], capabilities: [],
        configSchema: { parse: (i: unknown) => i },
        health: () => ({ state: 'ok', detail: '' }),
      },
      apply: (k) => { k.provide('prompt:x', { resident: '来自 x' }) },
    }])
    expect(collectPromptContributions(h.kernel)).toEqual([{ resident: '来自 x' }])
  })

  it('非 prompt: 前缀的服务不被收集', () => {
    const h = createKernel()
    h.start([{
      manifest: {
        id: 'x', version: '1', requires: [], capabilities: [],
        configSchema: { parse: (i: unknown) => i },
        health: () => ({ state: 'ok', detail: '' }),
      },
      apply: (k) => { k.provide('stores', { resident: '不该被收' }) },
    }])
    expect(collectPromptContributions(h.kernel)).toEqual([])
  })
})

describe('wirePromptInjection', () => {
  const contributions: readonly PromptContribution[] = [{ resident: '常驻', context: () => '动态' }]

  function fakeSystemPrompt(): { calls: unknown[]; context: (e: unknown) => unknown } {
    const calls: unknown[] = []
    return {
      calls,
      context(entry: unknown) {
        calls.push(entry)
        return () => {}
      },
    }
  }

  it('同步注册一次，order 落在宿主内置段之后', () => {
    const sp = fakeSystemPrompt()
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel, contributions, systemPrompt: sp, clock: h.kernel.clock,
    })
    expect(sp.calls).toHaveLength(1)
    const entry = sp.calls[0] as { name: string; order: number; text: (c: unknown) => string }
    expect(entry.name).toBe('omb:cognitive')
    expect(entry.order).toBe(CONTEXT_ORDER)
    expect(entry.order).toBeGreaterThan(120) // 宿主内置 context 最大 120
    dispose()
  })

  it('注册的 text 函数能渲染出常驻 + 动态', () => {
    const sp = fakeSystemPrompt()
    const h = createKernel()
    wirePromptInjection({ kernel: h.kernel, contributions, systemPrompt: sp, clock: h.kernel.clock })
    const entry = sp.calls[0] as { text: (c: unknown) => string }
    expect(entry.text({})).toBe('常驻\n\n动态')
  })

  it('宿主没有 systemPrompt → 不抛，返回可用的 disposer，并留下降级记录', () => {
    const h = createKernel()
    const warn = vi.fn()
    h.start([{
      manifest: {
        id: 'x', version: '1', requires: [], capabilities: [],
        configSchema: { parse: (i: unknown) => i },
        health: () => ({ state: 'ok', detail: '' }),
      },
      apply: () => {},
    }])
    const kernelWithLogger = { ...h.kernel, logger: { debug() {}, info() {}, warn } }
    const dispose = wirePromptInjection({
      kernel: kernelWithLogger, contributions, systemPrompt: undefined, clock: h.kernel.clock,
    })
    expect(() => dispose()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it('宿主 context() 抛异常 → 不抛，返回可用的 disposer', () => {
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions,
      systemPrompt: { context: () => { throw new Error('宿主拒绝') } },
      clock: h.kernel.clock,
    })
    expect(() => dispose()).not.toThrow()
  })

  it('disposer 幂等且绝不抛', () => {
    const h = createKernel()
    const dispose = wirePromptInjection({
      kernel: h.kernel,
      contributions,
      systemPrompt: { context: () => () => { throw new Error('回收失败') } },
      clock: h.kernel.clock,
    })
    expect(() => { dispose(); dispose() }).not.toThrow()
  })
})

describe('SessionTable', () => {
  it('记住与取回 cwd；输出排序稳定', () => {
    const t = new SessionTable()
    t.remember('b', '/p/b')
    t.remember('a', '/p/a')
    expect(t.cwdOf('a')).toBe('/p/a')
    expect(t.cwdOf('missing')).toBeUndefined()
    expect(t.sessions()).toEqual(['a', 'b'])
    t.forget('a')
    expect(t.sessions()).toEqual(['b'])
  })
})

describe('fingerprint 与 extractText', () => {
  it('指纹稳定且短（跨进程确定，便于重放）', () => {
    expect(fingerprint('a', 'b')).toBe(fingerprint('a', 'b'))
    expect(fingerprint('a', 'b')).not.toBe(fingerprint('a', 'c'))
    expect(fingerprint('a', 'b')).toHaveLength(16)
  })

  it('分隔符防止字段拼接歧义', () => {
    expect(fingerprint('ab', '')).not.toBe(fingerprint('a', 'b'))
  })

  it('从字符串、content 数组、任意对象里抽文本', () => {
    expect(extractText('直接')).toBe('直接')
    expect(extractText({ content: [{ text: '甲' }, { text: '乙' }] })).toBe('甲\n乙')
    expect(extractText({ a: 1 })).toBe('{"a":1}')
    expect(extractText(undefined)).toBe('""')
  })
})
