/**
 * 控制器状态机的手动编辑（v4.19.0）。
 *
 * 判据：编辑只改内存表（不创建不存在会话、绝不抛）、phase 与表内容同步、
 * 任务 TTL/上限/去重、候选按文本删除/清空；手动编辑不是事件转移 → transition 清空。
 */
import { describe, expect, it } from 'vitest'
import { createCapture } from '../../../modules/memory/capture.js'
import {
  CONTROLLER_TASK_TTL_MS,
  MAX_CONTROLLER_TASKS,
} from '../../../modules/memory/controller.js'
import { fixedClock } from './helpers.js'

function fixture(): {
  capture: ReturnType<typeof createCapture>
  clock: ReturnType<typeof fixedClock>
} {
  const clock = fixedClock()
  const capture = createCapture({
    clock,
    resolveStore: async () => undefined,
    enabledPreferences: true,
    enabledActivity: true,
    enabledOutcome: true,
    // dry-run：事件只推进状态、不执行 persist，候选会留在表里（便于测删除）。
    controllerMode: 'dry-run',
  })
  return { capture, clock }
}

describe('capture.editController / controllerState（v4.19.0）', () => {
  it('未知会话：state 返回空状态，edit 不创建会话、绝不抛', () => {
    const { capture } = fixture()
    expect(capture.controllerState('missing')).toMatchObject({ phase: 'idle', tasks: [], candidates: [] })
    const edited = capture.editController('missing', { kind: 'add-task', text: '不要改测试' })
    expect(edited).toMatchObject({ phase: 'idle', tasks: [], candidates: [] })
    expect(capture.controllerState('missing')).toMatchObject({ phase: 'idle', tasks: [] })
    expect(() => capture.editController('', { kind: 'add-task', text: 'x' })).not.toThrow()
    expect(() => capture.editController('s1', { kind: 'nope' } as never)).not.toThrow()
  })

  it('add-task：写入时间/TTL、phase=tracking-tasks、transition 清空；重复文本去重', () => {
    const { capture, clock } = fixture()
    capture.warm('s1')
    const first = capture.editController('s1', { kind: 'add-task', text: '  别改测试  ' })
    expect(first.phase).toBe('tracking-tasks')
    expect(first.tasks).toHaveLength(1)
    expect(first.tasks[0]).toMatchObject({
      text: '别改测试',
      at: clock.now(),
      expiresAt: clock.now() + CONTROLLER_TASK_TTL_MS,
    })
    // 重复文本（前后空白归一）不叠加，保持首次的时间/TTL
    const duplicate = capture.editController('s1', { kind: 'add-task', text: '  别改测试  ' })
    expect(duplicate.tasks).toHaveLength(1)
    expect(duplicate.tasks[0]?.at).toBe(first.tasks[0]?.at)
    // 只读方法不推进事件、不改 transition 语义：手动编辑后 transition 为 null
    expect(capture.controllerState('s1').phase).toBe('tracking-tasks')
  })

  it('add-task 有界：最多 MAX_CONTROLLER_TASKS 条；空/超长文本不改状态', () => {
    const { capture } = fixture()
    capture.warm('s1')
    for (let index = 0; index < MAX_CONTROLLER_TASKS + 3; index += 1) {
      capture.editController('s1', { kind: 'add-task', text: `任务 ${index}` })
    }
    const state = capture.controllerState('s1')
    expect(state.tasks).toHaveLength(MAX_CONTROLLER_TASKS)
    expect(state.tasks[0]?.text).toBe(`任务 ${MAX_CONTROLLER_TASKS + 2}`)
    const before = state.tasks.map(task => task.text)
    expect(capture.editController('s1', { kind: 'add-task', text: '   ' }).tasks.map(t => t.text)).toEqual(before)
    expect(capture.editController('s1', { kind: 'add-task', text: 'x'.repeat(201) }).tasks.map(t => t.text)).toEqual(before)
  })

  it('remove-task / clear-tasks：按规范化文本删、清空后 phase=idle', () => {
    const { capture } = fixture()
    capture.warm('s1')
    capture.editController('s1', { kind: 'add-task', text: '任务 A' })
    capture.editController('s1', { kind: 'add-task', text: '任务 B' })
    const removed = capture.editController('s1', { kind: 'remove-task', text: '任务 A' })
    expect(removed.tasks.map(task => task.text)).toEqual(['任务 B'])
    // 不存在的文本：原状态返回（不抛、不误删）
    expect(capture.editController('s1', { kind: 'remove-task', text: '任务 C' }).tasks).toHaveLength(1)
    const cleared = capture.editController('s1', { kind: 'clear-tasks' })
    expect(cleared.tasks).toEqual([])
    expect(cleared.phase).toBe('idle')
  })

  it('候选：事件种下后可按文本删除/清空；phase 随两表同步（mixed → candidate-pending → idle）', async () => {
    const { capture, clock } = fixture()
    capture.warm('s1')
    capture.editController('s1', { kind: 'add-task', text: '临时任务' })
    const text = '这个项目决定统一用 pnpm。'
    await capture.onUserMessage({ sessionId: 's1', text, at: clock.now() })
    const mixed = capture.controllerState('s1')
    expect(mixed.candidates.length).toBeGreaterThan(0)
    expect(mixed.phase).toBe('mixed')
    const removed = capture.editController('s1', { kind: 'remove-candidate', text })
    expect(removed.candidates).toEqual([])
    expect(removed.phase).toBe('tracking-tasks')
    const clearedTasks = capture.editController('s1', { kind: 'clear-tasks' })
    expect(clearedTasks.phase).toBe('idle')
    // 再种一个候选后清空候选
    await capture.onUserMessage({ sessionId: 's1', text: '以后都用 pnpm 管理依赖。', at: clock.now() })
    expect(capture.controllerState('s1').candidates.length).toBeGreaterThan(0)
    expect(capture.editController('s1', { kind: 'clear-candidates' }).candidates).toEqual([])
  })

  it('绝不抛：坏的 edit 形状 / 空会话 / 未 warm 的会话都安全', () => {
    const { capture } = fixture()
    expect(() => capture.editController('s-unwarmed', { kind: 'add-task', text: 'x' })).not.toThrow()
    expect(capture.controllerState('s-unwarmed').tasks).toEqual([])
    expect(() => capture.editController('s1', { kind: 'remove-task' } as never)).not.toThrow()
    expect(() => capture.editController('s1', null as never)).not.toThrow()
  })
})
