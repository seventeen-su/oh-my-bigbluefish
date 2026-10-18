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
  LOOP_HYSTERESIS_STEPS,
  NO_ANNOUNCE,
  NO_PROGRESS_KINDS,
  type EvidenceObservation,
  type TurnFingerprint,
  announceLoop,
  appendFingerprint,
  detectLoop,
  isNoProgressSignal,
  noteObservation,
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

describe('noteObservation：把 call + result 两条事件归并成"一步"', () => {
  /** 集成层的真实接线：tool/call 的 evidenceHash 为空，tools/result 带证据哈希。 */
  const stream = (steps: readonly (readonly [string, string])[]): readonly TurnFingerprint[] => {
    let window: readonly TurnFingerprint[] = []
    for (const [action, evidence] of steps) {
      window = noteObservation(window, fp(action, ''))
      if (evidence !== '') window = noteObservation(window, fp(`result:${action}`, evidence))
    }
    return window
  }

  it('调用与其结果合成一条指纹，动作哈希是"调用"的', () => {
    const window = stream([['read:a.ts', 'h1']])
    expect(window.length).toBe(1)
    expect(window[0]?.actionHash).toBe('read:a.ts')
    expect(window[0]?.evidenceHash).toBe('h1')
  })

  it('真实接线下的重复动作仍被检出（不归并就永远对不上号）', () => {
    const window = stream([
      ['read:a.ts', 'h1'],
      ['read:a.ts', 'h1'],
    ])
    expect(window.length).toBe(2)
    expect(detectLoop(window)?.kind).toBe('repeat-action')
  })

  it('真实接线下的"连续三轮无新证据"仍被检出', () => {
    const window = stream([
      ['list:dir', 'same'],
      ['stat:x', 'same'],
      ['grep:y', 'same'],
    ])
    expect(window.length).toBe(3)
    expect(detectLoop(window)?.kind).toBe('no-new-evidence')
  })

  it('真实接线下的 A→B→A→B 振荡仍被检出', () => {
    const window = stream([
      ['run:test', 'e1'],
      ['run:lint', 'e2'],
      ['run:test', 'e3'],
      ['run:lint', 'e4'],
    ])
    expect(detectLoop(window)?.kind).toBe('oscillation')
  })

  it('空事件（动作与证据都空）不入账', () => {
    const window = noteObservation(noteObservation([], fp('A', 'e')), fp('', ''))
    expect(window.length).toBe(1)
  })

  it('证据事件没有对应动作时单独成步（例如用户消息）', () => {
    const window = noteObservation([], fp('', 'user-said-x'))
    expect(window.length).toBe(1)
    expect(window[0]?.evidenceHash).toBe('user-said-x')
  })

  it('不把两次连续结果并到一起；上限仍然生效', () => {
    let window: readonly TurnFingerprint[] = []
    for (let index = 1; index <= 20; index += 1) {
      window = noteObservation(window, fp(`step${index}`, ''))
      window = noteObservation(window, fp(`result:${index}`, `e${index}`))
    }
    expect(window.length).toBe(DEFAULT_WINDOW_SIZE)
    expect(window[window.length - 1]?.evidenceHash).toBe('e20')
    expect(window.every(entry => entry.evidenceHash !== '')).toBe(true)
  })

  it('纯函数：不改入参', () => {
    const original = [fp('A', '')]
    const copy = [...original]
    noteObservation(original, fp('result', 'h'))
    expect(original).toEqual(copy)
  })
})

/**
 * v3.6 新增的共用判据：**注入侧**（合法出口段）与**观察侧**（状态面信号）
 * 必须判同一件事。两处各写一份 kind 列表就会漂移，所以只有这一个真源。
 */
describe('无进展信号集合（注入侧与观察侧共用的唯一真源）', () => {
  it('只认 stalled / no-new-evidence —— 这两类的共同含义是"没有新增证据"', () => {
    expect([...NO_PROGRESS_KINDS]).toEqual(['stalled', 'no-new-evidence'])
    for (const kind of NO_PROGRESS_KINDS) {
      expect(isNoProgressSignal({ kind, detail: 'd', hint: 'h' })).toBe(true)
    }
    // "这一步刚做过 / 在两种做法之间来回"不属于无进展：它们各自已有具体出口
    expect(isNoProgressSignal({ kind: 'repeat-action', detail: 'd', hint: 'h' })).toBe(false)
    expect(isNoProgressSignal({ kind: 'oscillation', detail: 'd', hint: 'h' })).toBe(false)
  })

  it('空信号、畸形信号恒为 false（不抛）', () => {
    expect(isNoProgressSignal(null)).toBe(false)
    expect(isNoProgressSignal(undefined)).toBe(false)
    expect(isNoProgressSignal({} as never)).toBe(false)
    expect(isNoProgressSignal({ kind: 'bogus' } as never)).toBe(false)
  })
})

/**
 * Wave 1 / R3：callId 精确配对、surface 代际分区、注入迟滞。
 *
 * 这三条对应调研报告里的两个真实缺陷：
 * ① v3.6 用"上一条缺证据就补"归并——DSH 每步 1.27 次工具调用，并发调用时
 *    call 事件先成批出现、result 才陆续到达，证据会挂到错误动作上；
 * ② 压缩/替换后如果沿用旧窗口，压缩前的"重复/无进展"会算到压缩后的头上。
 */
describe('R3：callId 配对 + 代际分区 + 注入迟滞', () => {
  const obs = (
    actionHash: string,
    evidenceHash: string,
    callId: string,
    generation = 0,
  ): EvidenceObservation & { generation: number } => ({ actionHash, evidenceHash, callId, at: 0, generation })

  it('并发调用：两个 call 先到、两个 result 乱序到达 → 按 callId 各自配对', () => {
    let window = noteObservation([], obs('call-A', '', 'c1'), DEFAULT_WINDOW_SIZE, 0)
    window = noteObservation(window, obs('call-B', '', 'c2'), DEFAULT_WINDOW_SIZE, 0)
    window = noteObservation(window, obs('', 'res-B', 'c2'), DEFAULT_WINDOW_SIZE, 0)
    window = noteObservation(window, obs('', 'res-A', 'c1'), DEFAULT_WINDOW_SIZE, 0)
    expect(window.map(entry => [entry.actionHash, entry.evidenceHash, entry.callId])).toEqual([
      ['call-A', 'res-A', 'c1'],
      ['call-B', 'res-B', 'c2'],
    ])
  })

  it('没有对应 call 的 result 单独成步（不污染上一条动作）', () => {
    let window = noteObservation([], obs('call-A', '', 'c1'), DEFAULT_WINDOW_SIZE, 0)
    window = noteObservation(window, obs('', 'orphan-evidence', 'c9'), DEFAULT_WINDOW_SIZE, 0)
    expect(window).toHaveLength(2)
    expect(window[0]?.evidenceHash).toBe('')
    expect(window[1]?.evidenceHash).toBe('orphan-evidence')
  })

  it('旧接线（没有 callId）仍走兜底归并：上一条缺证据就补', () => {
    let window = noteObservation([], { actionHash: 'read:a.ts', evidenceHash: '', at: 1 })
    window = noteObservation(window, { actionHash: 'result:a', evidenceHash: 'h1', at: 2 })
    expect(window).toHaveLength(1)
    expect(window[0]).toMatchObject({ actionHash: 'read:a.ts', evidenceHash: 'h1' })
  })

  it('surface 代际变化：旧代际指纹整段丢弃', () => {
    let window: readonly TurnFingerprint[] = []
    for (const action of ['a', 'b', 'c']) {
      window = noteObservation(window, obs(action, 'same', ''), DEFAULT_WINDOW_SIZE, 0)
    }
    expect(window).toHaveLength(3)
    window = noteObservation(window, obs('d', 'new', '', 1), DEFAULT_WINDOW_SIZE, 1)
    expect(window).toHaveLength(1)
    expect(window[0]).toMatchObject({ actionHash: 'd', evidenceHash: 'new', generation: 1 })
  })

  it('迟滞：同信号冷却期内不重复；kind 变化立刻放行；信号解除后复发可立刻报', () => {
    const signal = (kind: 'stalled' | 'no-new-evidence') => ({ kind, detail: 'd', hint: 'h' })
    const first = announceLoop(NO_ANNOUNCE, signal('stalled'), 1)
    expect(first.inject).toBe(true)
    expect(first.state).toEqual({ kind: 'stalled', step: 1 })

    const cooling = announceLoop(first.state, signal('stalled'), 2)
    expect(cooling.inject).toBe(false)
    expect(cooling.state).toEqual(first.state)

    const afterCooldown = announceLoop(first.state, signal('stalled'), 1 + LOOP_HYSTERESIS_STEPS)
    expect(afterCooldown.inject).toBe(true)

    // 信号变化：立刻放行（新的诊断更具体/更不同）
    expect(announceLoop(first.state, signal('no-new-evidence'), 2).inject).toBe(true)

    // 信号解除：状态归零；同一信号复发可立刻报
    const cleared = announceLoop(first.state, null, 2)
    expect(cleared.inject).toBe(false)
    expect(cleared.state.kind).toBeNull()
    expect(announceLoop(cleared.state, signal('stalled'), 3).inject).toBe(true)
  })

  it('迟滞是纯函数、非法 step 不抛', () => {
    const signal = { kind: 'stalled' as const, detail: 'd', hint: 'h' }
    expect(announceLoop(NO_ANNOUNCE, signal, Number.NaN).inject).toBe(true)
    expect(announceLoop(undefined, null, 1).inject).toBe(false)
    expect(announceLoop(undefined, null, 1).state).toEqual(NO_ANNOUNCE)
  })
})
