/**
 * 常驻提示（v4 技能化后 methods.ts 只剩这一句）。
 *
 * 判据：
 * ① ≤80 字符（模块自身上限；宿主的共享预算是 120，要留余量给其它模块）；
 * ② 逐字节稳定、按预算只缩不涨；
 * ③ 自己承载 R1 的动作，并点名 skills omb-r1…r8（模型据此发现过程卡目录）；
 * ④ 不再提到已删除的工具（omb_method/omb_focus/omb_verify）。
 */
import { describe, expect, it } from 'vitest'
import { RESIDENT_HINT_MAX } from '../../../kernel/abi/index.js'
import {
  RESIDENT_HINT,
  RESIDENT_HINT_MAX_CHARS,
  residentHint,
} from '../../../modules/reasoning/methods.js'

describe('常驻提示：一句入口', () => {
  it('长度 ≤80（且不超过宿主共享预算）', () => {
    expect(RESIDENT_HINT_MAX_CHARS).toBe(80)
    expect(RESIDENT_HINT.length).toBeGreaterThan(20)
    expect(RESIDENT_HINT.length).toBeLessThanOrEqual(80)
    expect(RESIDENT_HINT.length).toBeLessThanOrEqual(RESIDENT_HINT_MAX)
  })

  it('承载 R1 的动作，并点名 skills omb-r1…r8', () => {
    expect(RESIDENT_HINT).toContain('先判断需要多少推理')
    expect(RESIDENT_HINT).toContain('简单直接答')
    expect(RESIDENT_HINT).toContain('skills')
    expect(RESIDENT_HINT).toContain('omb-r1')
    expect(RESIDENT_HINT).toContain('omb-r8')
  })

  it('不再提已删除的三个工具（工具面在 v4 清空）', () => {
    for (const banned of ['omb_method', 'omb_focus', 'omb_verify']) {
      expect(RESIDENT_HINT.includes(banned), `常驻提示仍提到 ${banned}`).toBe(false)
    }
  })

  it('默认返回整句，且逐字节稳定', () => {
    expect(residentHint()).toBe(RESIDENT_HINT)
    expect(residentHint(80)).toBe(RESIDENT_HINT)
    expect(residentHint()).toBe(residentHint())
  })

  it('预算变小只截断、不换句：装不下才带省略号', () => {
    const half = Math.floor(RESIDENT_HINT.length / 2)
    const truncated = residentHint(half)
    expect(truncated.length).toBeLessThanOrEqual(half)
    expect(truncated.endsWith('…')).toBe(true)
    expect(RESIDENT_HINT.startsWith(truncated.slice(0, -1))).toBe(true)
  })

  it('预算只缩不涨：给 120 也只到 80', () => {
    expect(residentHint(120)).toBe(RESIDENT_HINT)
    expect(residentHint(120).length).toBeLessThanOrEqual(RESIDENT_HINT_MAX_CHARS)
  })

  it('畸形/极小预算不抛', () => {
    expect(residentHint(0)).toBe('')
    expect(residentHint(-5)).toBe('')
    expect(residentHint(1)).toHaveLength(1)
    expect(residentHint(Number.NaN)).toBe(RESIDENT_HINT)
    expect(residentHint(Number.POSITIVE_INFINITY)).toBe(RESIDENT_HINT)
  })
})
