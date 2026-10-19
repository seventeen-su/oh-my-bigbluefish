/**
 * 统一知识生命周期（v4.6.0；七点审查第 6 点）。
 *
 * 判据：阶段只由 `kind + assertedBy` 推导，**不看召回次数/使用计数**；
 * 因此不存在"被多召回几次就自动升级"的伪晋升路径。
 */
import { describe, expect, it } from 'vitest'
import { stageLabel, stageOfMemory } from '../../../modules/memory/lifecycle.js'

describe('stageOfMemory：由记录事实推导阶段', () => {
  it('事件永远是最低层', () => {
    expect(stageOfMemory({ kind: 'episodic', assertedBy: 'model' })).toBe('event')
    expect(stageOfMemory({ kind: 'episodic', assertedBy: 'user' })).toBe('event')
  })

  it('用户确认的结论/偏好 → 已确认；模型/执行断言 → 候选', () => {
    expect(stageOfMemory({ kind: 'semantic', assertedBy: 'user' })).toBe('confirmed')
    expect(stageOfMemory({ kind: 'semantic', assertedBy: 'model' })).toBe('candidate')
    expect(stageOfMemory({ kind: 'semantic', assertedBy: 'execution' })).toBe('candidate')
  })

  it('可复用经验只来自用户确认的做法；其余只是候选', () => {
    expect(stageOfMemory({ kind: 'procedural', assertedBy: 'user' })).toBe('experience')
    expect(stageOfMemory({ kind: 'procedural', assertedBy: 'model' })).toBe('candidate')
    expect(stageOfMemory({ kind: 'procedural', assertedBy: 'execution' })).toBe('candidate')
  })

  it('阶段有稳定的中文名（召回/画像共用）', () => {
    expect(stageLabel('event')).toBe('事件')
    expect(stageLabel('candidate')).toBe('候选')
    expect(stageLabel('confirmed')).toBe('已确认')
    expect(stageLabel('experience')).toBe('经验')
  })
})
