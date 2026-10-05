/**
 * 状态存放与继承（挂在会话运行态上的那一份）。
 *
 * 判据：
 * ① 按会话键控：`for(A)` 永远拿不到 B 的状态（容器契约）
 * ② 继承是**读时解析**：父改模式，子立刻跟着变（不写副本，因此不会漂移）
 * ③ 环、超深、伪造血缘都退化为基线（安全方向）
 */
import { describe, expect, it } from 'vitest'
import { SessionRuntimeTable } from '../../../kernel/sessionRuntime.js'
import { PrivacyState, describeResolved, PRIVACY_SLOT } from '../../../modules/privacy/state.js'
import type { PrivacyBaseline } from '../../../modules/privacy/state.js'
import { fixedClock } from '../memory/helpers.js'

function build(baseline?: PrivacyBaseline): { state: PrivacyState; sessions: SessionRuntimeTable } {
  const clock = fixedClock()
  const sessions = new SessionRuntimeTable(clock)
  const state = new PrivacyState({
    sessions,
    clock,
    baseline: () => baseline ?? { mode: 'normal', origin: 'default', detail: '未配置' },
  })
  return { state, sessions }
}

describe('按会话键控', () => {
  it('显式设置只影响本会话', () => {
    const { state } = build()
    state.setOverride('A', 'sealed')
    expect(state.resolve('A').mode).toBe('sealed')
    expect(state.resolve('B').mode).toBe('normal')
    expect(state.overrideOf('B')).toBeUndefined()
  })

  it('覆盖与清除', () => {
    const { state } = build()
    state.setOverride('A', 'read-only')
    expect(state.resolve('A')).toMatchObject({ mode: 'read-only', origin: 'command' })
    state.setOverride('A', 'sealed')
    expect(state.resolve('A').mode).toBe('sealed')
    expect(state.clearOverride('A')).toBe(true)
    expect(state.resolve('A').mode).toBe('normal')
  })

  it('空会话 id 不产生状态（不建"别人的"运行态）', () => {
    const { state } = build()
    expect(state.setOverride('', 'sealed')).toBeNull()
    expect(state.overrides()).toEqual([])
  })

  it('列表稳定排序（状态面与持久化都要求确定输出）', () => {
    const { state } = build()
    state.setOverride('b', 'normal')
    state.setOverride('a', 'sealed')
    expect(state.overrides().map(entry => entry.sessionId)).toEqual(['a', 'b'])
  })

  it('槽名带模块前缀（容器契约：槽名冲突会让两个模块互相覆盖）', () => {
    const { state, sessions } = build()
    state.setOverride('A', 'sealed')
    expect(sessions.for('A')?.peekSlot(PRIVACY_SLOT)).toBeDefined()
    expect(PRIVACY_SLOT.startsWith('privacy:')).toBe(true)
  })
})

/**
 * `isActive` 是 G1（P0）修法的唯一判据：`PrivacyGate.#anyRestricted()` 只看它。
 *
 * 两种"条目在容器里"的形态必须被分开：
 * - **活跃**：本进程内 `note()`/`accept()` 过（真有观测）→ 限制必须继续生效；
 * - **历史记录**：只 `setOverride()`（= 启动时从状态文件重放）→ 不得掐住全进程。
 */
describe('isActive：本进程活跃过 vs 只是重放的历史记录', () => {
  it('只有 note() 过的会话才算活跃；只 setOverride 的不算', () => {
    const { state, sessions } = build()
    state.setOverride('restored', 'sealed')
    expect(state.isActive('restored'), '重放进来的条目没有任何观测，是历史记录').toBe(false)

    state.noteLineage({ sessionId: 'live', source: 'session-event' })
    state.setOverride('live', 'sealed')
    expect(state.isActive('live')).toBe(true)

    // 重放的会话随后真的活跃起来 → 立刻算活跃（重新武装，fail-closed 不放宽）
    sessions.note({ sessionId: 'restored', source: 'session-event' })
    expect(state.isActive('restored')).toBe(true)
  })

  it('从未见过的会话 / 空 id 都不是活跃', () => {
    const { state } = build()
    expect(state.isActive('nobody')).toBe(false)
    expect(state.isActive('')).toBe(false)
  })

  it('容器读不出来 → 按活跃处理（安全方向：宁可不放行归属未知的写）', () => {
    const broken = new Proxy({} as SessionRuntimeTable, {
      get: () => {
        throw new Error('容器坏了')
      },
    })
    const state = new PrivacyState({
      sessions: broken,
      clock: fixedClock(),
      baseline: () => ({ mode: 'normal', origin: 'default', detail: '未配置' }),
    })
    expect(state.isActive('A')).toBe(true)
  })
})

/**
 * `hasRestrictedActiveSession()` 是"归属未知的写是否被禁"的判据（`#anyRestricted()`）。
 *
 * 它必须**含继承**：子代理继承不写回子会话，所以"父会话已结束、子会话仍在跑"
 * 这种情形下，受限的那个会话根本不在 `overrides()` 里。
 */
describe('hasRestrictedActiveSession：活跃 + 生效模式受限（含继承）', () => {
  it('只有历史记录（本进程未活跃）→ false；活跃起来 → true', () => {
    const { state, sessions } = build()
    state.setOverride('A', 'sealed')
    expect(state.hasRestrictedActiveSession()).toBe(false)
    sessions.note({ sessionId: 'A', source: 'session-event' })
    expect(state.hasRestrictedActiveSession()).toBe(true)
  })

  it('本进程设过 normal 的活跃会话不算受限（别把闸门焊死）', () => {
    const { state, sessions } = build()
    state.setOverride('A', 'normal')
    sessions.note({ sessionId: 'A', source: 'session-event' })
    expect(state.hasRestrictedActiveSession()).toBe(false)
  })

  it('父会话已结束、子会话仍活跃并继承受限档 → true（漏掉它=归属未知写被静默放行）', () => {
    const { state } = build()
    state.setOverride('parent', 'sealed') // 只是历史记录（未活跃）
    // 子会话活了：血缘 + 观测都来自本进程
    state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
    expect(state.overrides().map(entry => entry.sessionId), '子会话没有自己的记录').toEqual(['parent'])
    expect(state.hasRestrictedActiveSession()).toBe(true)
  })

  it('基线受限时也由调用方兜住（这里只看会话）', () => {
    const { state } = build({ mode: 'sealed', origin: 'fail-closed', detail: '损坏' })
    expect(state.hasRestrictedActiveSession(), '基线不是"会话"，由 gate 的 baselineRestricted 管').toBe(false)
  })
})

describe('子代理继承（读时解析）', () => {
  it('子会话没有自己的设置 → 继承父会话', () => {
    const { state } = build()
    state.setOverride('parent', 'sealed')
    state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
    const resolved = state.resolve('child')
    expect(resolved).toMatchObject({ mode: 'sealed', origin: 'inherited', inheritedFrom: 'parent' })
    expect(describeResolved(resolved)).toContain('继承自 parent')
  })

  it('多级：孙子继承最近的显式设置', () => {
    const { state } = build()
    state.setOverride('grandparent', 'read-only')
    state.noteLineage({ sessionId: 'child', parentSessionId: 'grandparent', source: 'session-event' })
    state.noteLineage({ sessionId: 'grandchild', parentSessionId: 'child', source: 'session-event' })
    const resolved = state.resolve('grandchild')
    expect(resolved).toMatchObject({ mode: 'read-only', origin: 'inherited', inheritedFrom: 'grandparent' })
  })

  it('子会话自己的设置优先于继承', () => {
    const { state } = build()
    state.setOverride('parent', 'sealed')
    state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
    state.setOverride('child', 'normal')
    expect(state.resolve('child')).toMatchObject({ mode: 'normal', origin: 'command' })
  })

  it('父会话改模式 → 子会话立刻跟着变（不写副本，因此不会漂移）', () => {
    const { state } = build()
    state.setOverride('parent', 'read-only')
    state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
    expect(state.resolve('child').mode).toBe('read-only')
    state.setOverride('parent', 'sealed')
    expect(state.resolve('child').mode).toBe('sealed')
  })

  it('血缘环（伪造数据）不会死循环，回落到基线', () => {
    const { state } = build()
    state.noteLineage({ sessionId: 'a', parentSessionId: 'b', source: 'session-event' })
    state.noteLineage({ sessionId: 'b', parentSessionId: 'a', source: 'session-event' })
    expect(state.resolve('a').mode).toBe('normal')
  })

  it('血缘缺失 → 基线（不会拿"最近看到的会话"顶替）', () => {
    const { state } = build()
    state.setOverride('parent', 'sealed')
    expect(state.resolve('unknown-child').mode).toBe('normal')
  })
})

describe('基线（fail-closed）', () => {
  it('基线受限时，没有记录的会话就是受限', () => {
    const { state } = build({
      mode: 'sealed',
      origin: 'fail-closed',
      detail: '状态文件损坏：按最严兜底',
    })
    const resolved = state.resolve('anything')
    expect(resolved).toMatchObject({ mode: 'sealed', origin: 'fail-closed' })
    expect(resolved.detail).toContain('损坏')
  })

  it('基线受限时可被显式设置覆盖（用户手打的命令优先），但仍标明来源', () => {
    const { state } = build({ mode: 'sealed', origin: 'fail-closed', detail: '损坏' })
    state.setOverride('s1', 'normal')
    expect(state.resolve('s1')).toMatchObject({ mode: 'normal', origin: 'command' })
  })

  it('基线解析自身出错 → 按 sealed 兜底（安全方向）', () => {
    const clock = fixedClock()
    const sessions = new SessionRuntimeTable(clock)
    const state = new PrivacyState({
      sessions,
      clock,
      baseline: () => {
        throw new Error('炸了')
      },
    })
    expect(state.resolve('x')).toMatchObject({ mode: 'sealed', origin: 'fail-closed' })
  })

  it('未提供会话 id 时也走基线（不猜是谁）', () => {
    const { state } = build()
    expect(state.resolve('').detail).toContain('未提供会话 id')
  })
})
