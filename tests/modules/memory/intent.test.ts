/**
 * 记忆意图分类（v4.6.1 P1）：临时任务约束不能自动晋升为长期记忆。
 */
import { describe, expect, it } from 'vitest'
import { classifyMemoryIntent, isDurableIntent } from '../../../modules/memory/intent.js'

describe('classifyMemoryIntent', () => {
  it('这次/当前任务/先 + 约束 → task-constraint（不写长期记忆）', () => {
    expect(classifyMemoryIntent('这次不要联网，先离线测试').intent).toBe('task-constraint')
    expect(classifyMemoryIntent('这个任务先不要改数据库').intent).toBe('task-constraint')
    expect(classifyMemoryIntent('本次必须只读').intent).toBe('task-constraint')
  })

  it('临时指令（无约束词）→ temporary-instruction', () => {
    expect(classifyMemoryIntent('这次先跑单元测试').intent).toBe('temporary-instruction')
  })

  it('长期边界 + 偏好 → long-term-preference', () => {
    expect(classifyMemoryIntent('以后回答请简洁一点，不要分点').intent).toBe('long-term-preference')
    expect(classifyMemoryIntent('我习惯先看日志再改代码').intent).toBe('long-term-preference')
  })

  it('长期边界 + 决策 → stable-decision', () => {
    expect(classifyMemoryIntent('这个项目决定统一用 pnpm').intent).toBe('stable-decision')
  })

  it('“决定/采用/方案”没有长期边界 → 仍按稳定决策候选，但不能绕过准入', () => {
    expect(classifyMemoryIntent('我们决定采用 Rust 重写核心').intent).toBe('stable-decision')
    expect(isDurableIntent('stable-decision')).toBe(true)
  })

  it('只有“不要/必须”没有边界 → candidate，不自动写长期偏好', () => {
    expect(classifyMemoryIntent('不要用 npm').intent).toBe('candidate')
    expect(isDurableIntent('candidate')).toBe(false)
    expect(isDurableIntent('task-constraint')).toBe(false)
  })
})
