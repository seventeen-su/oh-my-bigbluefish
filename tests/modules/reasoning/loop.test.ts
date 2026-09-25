/**
 * 循环与空转检测（规划 §4.5）：四类信号**各有正反例**。
 *
 * 纯函数测试，零 mock、零 I/O。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOOP_THRESHOLDS,
  DEFAULT_WINDOW_SIZE,
  LOOP_HINT_MAX,
  type TurnFingerprint,
  appendFingerprint,
  detectLoop,
  renderLoopSignal,
} from '../../../modules/reasoning/loop.js'

const fp = (action: string, evidence: string, at = 0): TurnFingerprint => ({
  actionHash: action,
  evidenceHash: evidence,
  at,
})

/** 四类信号各造一个成立的最小窗口。 */
const POSITIVE: Readonly<Record<string, readonly TurnFingerprint[]>> = {
  'repeat-action': [fp('A', 'e1'), fp('A', 'e1')],
  'no-new-evidence': [fp('A', 'e'), fp('B', 'e'), fp('C', 'e')],
  oscillation: [fp('A', 'e1'), fp('B', 'e2'), fp('A', 'e3'), fp('B', 'e4')],
  stalled: [fp('A', 'e'), fp('B', 'e'), fp('A', 'e'), fp('C', 'e'), fp('A', 'e')],
}

describe('detectLoop：四类信号的正例', () => {
  for (const [kind, window] of Object.entries(POSITIVE)) {
    it(`${kind} 会被检出`, () => {
      const signal = detectLoop(window)
      expect(signal?.kind).toBe(kind)
      expect(signal?.detail.length ?? 0).toBeGreaterThan(0)
      expect(signal?.hint.length ?? 0).toBeGreaterThan(0)
      expect(signal?.hint.length ?? 0).toBeLessThanOrEqual(LOOP_HINT_MAX)
    })
  }

  it('repeat-action：连续两步同动作+参数 → "这一步刚做过"', () => {
    const signal = detectLoop([fp('read:a.ts', 'h1'), fp('read:a.ts', 'h1')])
    expect(signal?.kind).toBe('repeat-action')
    expect(signal?.hint).toContain('刚做过')
  })

  it('no-new-evidence：连续 3 轮证据不变', () => {
    const signal = detectLoop([fp('A', 'same'), fp('B', 'same'), fp('C', 'same')])
    expect(signal?.kind).toBe('no-new-evidence')
    expect(signal?.detail).toContain('连续 3 轮')
    expect(signal?.hint).toContain('换个方向')
  })

  it('oscillation：A→B→A→B → 需要第三个选项', () => {
    const signal = detectLoop([fp('A', 'e1'), fp('B', 'e2'), fp('A', 'e3'), fp('B', 'e4')])
    expect(signal?.kind).toBe('oscillation')
    expect(signal?.hint).toContain('第三个选项')
  })

  it('stalled：同一动作非相邻地重复 3 次且无进展', () => {
    const signal = detectLoop([fp('A', 'e'), fp('B', 'e'), fp('A', 'e'), fp('C', 'e'), fp('A', 'e')])
    expect(signal?.kind).toBe('stalled')
    expect(signal?.hint).toContain('理解一致')
  })
})

describe('detectLoop：四类信号的反例', () => {
  it('空窗口 / 单条 / 少于判定所需，都不报信号', () => {
    expect(detectLoop([])).toBeNull()
    expect(detectLoop([fp('A', 'e')])).toBeNull()
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e2')])).toBeNull()
  })

  it('repeat-action 反例：动作不同（证据是否相同都不算）', () => {
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e1')])).toBeNull()
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e2')])).toBeNull()
  })

  it('repeat-action 反例：空动作哈希不算"重复动作"', () => {
    expect(detectLoop([fp('', 'e'), fp('', 'e')])?.kind).not.toBe('repeat-action')
  })

  it('no-new-evidence 反例：证据每轮都在更新', () => {
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e2'), fp('C', 'e3')])).toBeNull()
  })

  it('no-new-evidence 反例：轮数不足（2 轮 < 阈值 3）', () => {
    expect(detectLoop([fp('A', 'same'), fp('B', 'same')])).toBeNull()
  })

  it('oscillation 反例：A→B→C 不构成来回；A→B→C→D 也不是', () => {
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e2'), fp('C', 'e3')])?.kind).not.toBe('oscillation')
    expect(detectLoop([fp('A', 'e1'), fp('B', 'e2'), fp('C', 'e3'), fp('D', 'e4')])).toBeNull()
  })

  it('oscillation 反例：A→A→A→A 归 repeat-action，不归 oscillation', () => {
    const signal = detectLoop([fp('A', 'e1'), fp('A', 'e2'), fp('A', 'e3'), fp('A', 'e4')])
    expect(signal?.kind).toBe('repeat-action')
  })

  it('stalled 反例：同一动作重复 3 次但证据在更新（有进展）', () => {
    const window = [fp('A', 'e1'), fp('B', 'e2'), fp('A', 'e3'), fp('C', 'e4'), fp('A', 'e5')]
    expect(detectLoop(window)).toBeNull()
  })

  it('stalled 反例：只重复 2 次', () => {
    const window = [fp('A', 'e'), fp('B', 'e'), fp('A', 'e'), fp('C', 'e')]
    expect(detectLoop(window)?.kind ?? null).not.toBe('stalled')
  })
})

describe('detectLoop：优先级与阈值', () => {
  it('优先级：repeat-action 先于 stalled / no-new-evidence', () => {
    const signal = detectLoop([fp('A', 'same'), fp('A', 'same'), fp('A', 'same')])
    expect(signal?.kind).toBe('repeat-action')
  })

  it('优先级：oscillation 先于 no-new-evidence（动作来回更具体）', () => {
    const signal = detectLoop([fp('A', 'same'), fp('B', 'same'), fp('A', 'same'), fp('B', 'same')])
    expect(signal?.kind).toBe('oscillation')
  })

  it('阈值可覆盖：flatEvidenceTurns=2 时两轮同证据即触发', () => {
    const window = [fp('A', 'same'), fp('B', 'same')]
    expect(detectLoop(window)).toBeNull()
    expect(detectLoop(window, { flatEvidenceTurns: 2 })?.kind).toBe('no-new-evidence')
  })

  it('阈值可覆盖：oscillationCycles=3 需要 6 条', () => {
    const four = [fp('A', 'e1'), fp('B', 'e2'), fp('A', 'e3'), fp('B', 'e4')]
    expect(detectLoop(four, { oscillationCycles: 3 })).toBeNull()
    const six = [...four, fp('A', 'e5'), fp('B', 'e6')]
    expect(detectLoop(six, { oscillationCycles: 3 })?.kind).toBe('oscillation')
  })

  it('非法阈值回落缺省（不抛、不静默用 NaN）', () => {
    const window = [fp('A', 'same'), fp('B', 'same'), fp('C', 'same')]
    expect(detectLoop(window, { flatEvidenceTurns: Number.NaN })?.kind).toBe('no-new-evidence')
    expect(detectLoop(window, { flatEvidenceTurns: -1 })?.kind).toBe('no-new-evidence')
    expect(DEFAULT_LOOP_THRESHOLDS.flatEvidenceTurns).toBe(3)
  })

  it('不改入参；非法条目被忽略', () => {
    const window = [fp('A', 'e'), fp('B', 'e'), fp('C', 'e')]
    const copy = JSON.parse(JSON.stringify(window)) as TurnFingerprint[]
    detectLoop(window)
    expect(window).toEqual(copy)
    expect(detectLoop([{ actionHash: 'A' } as TurnFingerprint, null as unknown as TurnFingerprint])).toBeNull()
  })
})

describe('滚动窗口与渲染', () => {
  it('appendFingerprint 纯函数：返回新数组，保留最近 max 条', () => {
    let window: readonly TurnFingerprint[] = []
    const original = window
    for (let i = 1; i <= DEFAULT_WINDOW_SIZE + 3; i += 1) {
      window = appendFingerprint(window, fp(`A${i}`, `e${i}`, i))
    }
    expect(original).toEqual([])
    expect(window.length).toBe(DEFAULT_WINDOW_SIZE)
    expect(window[0]?.actionHash).toBe('A4')
    expect(window[window.length - 1]?.actionHash).toBe(`A${DEFAULT_WINDOW_SIZE + 3}`)
  })

  it('appendFingerprint 支持自定义上限与非法上限回落', () => {
    const window = [fp('A', 'e'), fp('B', 'e')]
    expect(appendFingerprint(window, fp('C', 'e'), 2).map(f => f.actionHash)).toEqual(['B', 'C'])
    expect(appendFingerprint(window, fp('C', 'e'), Number.NaN).length).toBe(3)
  })

  it('renderLoopSignal：无信号返回空串（不注入"没有信号"这句话）', () => {
    expect(renderLoopSignal(null)).toBe('')
    const window = POSITIVE.oscillation ?? []
    const signal = detectLoop(window)
    expect(renderLoopSignal(signal)).toContain(signal?.hint ?? '')
  })

  it('hint 上限是 80 字符（注入的是给模型看的一句话）', () => {
    expect(LOOP_HINT_MAX).toBe(80)
    for (const window of Object.values(POSITIVE)) {
      const hint = detectLoop(window)?.hint ?? ''
      expect(hint.length).toBeLessThanOrEqual(LOOP_HINT_MAX)
      expect(hint.length).toBeGreaterThan(0)
    }
  })

  it('四类信号领域中立：换成生活/陪伴的动作哈希，检测结果不变', () => {
    const coding = detectLoop([fp('bash:npm test', 'e'), fp('bash:npm test', 'e')])
    const comfort = detectLoop([fp('安慰:别难过', 'e'), fp('安慰:别难过', 'e')])
    expect(coding?.kind).toBe('repeat-action')
    expect(comfort?.kind).toBe('repeat-action')
    expect(comfort?.hint).toBe(coding?.hint)
  })
})
