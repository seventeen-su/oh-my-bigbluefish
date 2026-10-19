/**
 * 记忆主动性提示（v4.5.3 用户新增：AI 主动记忆/管理，不等用户提醒）。
 *
 * 判据：只在用户消息有明确信号时给一行提示；普通问句/闲聊不打扰。
 */
import { describe, expect, it } from 'vitest'
import { PROACTIVE_MAX_CHARS, detectProactiveCue } from '../../../modules/memory/proactive.js'

describe('detectProactiveCue', () => {
  it('显式要求记住 → 立即写的提示（问句也触发）', () => {
    const cue = detectProactiveCue('以后都用中文回答，记住这一点。')
    expect(cue?.cue).toBe('explicit-remember')
    expect(cue?.text).toContain('omb_remember')
    expect(cue?.text).toContain('不要只回复')
    expect(detectProactiveCue('能记住这个决定吗？')?.cue).toBe('explicit-remember')
  })

  it('纠正旧结论 → 先召回再 supersedes 更正', () => {
    const cue = detectProactiveCue('之前说的方案不对，改成先用 SQLite。')
    expect(cue?.cue).toBe('correction')
    expect(cue?.text).toContain('omb_recall')
    expect(cue?.text).toContain('supersedes')
  })

  it('项目决定/长期约定 → 记 semantic 项目库', () => {
    const cue = detectProactiveCue('这个项目决定统一用 pnpm，不再用 npm。')
    expect(cue?.cue).toBe('decision')
    expect(cue?.text).toContain('项目库')
  })

  it('长期偏好 → 主动写语义记忆（用户库）', () => {
    const cue = detectProactiveCue('我习惯先看日志再改代码。')
    expect(cue?.cue).toBe('preference')
    expect(cue?.text).toContain('用户库')
  })

  it('普通问句/闲聊/超长文本 → 不提示（不打扰）', () => {
    expect(detectProactiveCue('这个函数为什么返回 undefined？')).toBeNull()
    expect(detectProactiveCue('好的，继续。')).toBeNull()
    expect(detectProactiveCue('')).toBeNull()
    expect(detectProactiveCue('啊'.repeat(PROACTIVE_MAX_CHARS + 1))).toBeNull()
  })

  it('优先级：显式要求记住 > 纠正 > 决定 > 偏好', () => {
    expect(detectProactiveCue('记住：之前说错了，决定以后都这样')?.cue).toBe('explicit-remember')
    expect(detectProactiveCue('之前说错了，决定以后都这样')?.cue).toBe('correction')
    expect(detectProactiveCue('决定以后都这样，我习惯早起')?.cue).toBe('decision')
  })
})
