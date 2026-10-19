/**
 * 事件驱动记忆控制器（v4.7.0：决策 + 执行）。
 *
 * reducer 仍是纯函数：测试钉住安全闸门、TTL 与形态判据；执行层在 capture.test.ts。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTROLLER_TASK_TTL_MS,
  EMPTY_CONTROLLER_STATE,
  reduceMemoryEvent,
  type ControllerEvent,
  type ControllerSessionState,
} from '../../../modules/memory/controller.js'

function run(events: readonly ControllerEvent[]): {
  state: ControllerSessionState
  actions: ReturnType<typeof reduceMemoryEvent>['actions']
} {
  let state = EMPTY_CONTROLLER_STATE
  const actions: ReturnType<typeof reduceMemoryEvent>['actions'][number][] = []
  for (const event of events) {
    const reduced = reduceMemoryEvent(state, event)
    state = reduced.state
    actions.push(...reduced.actions)
  }
  return { state, actions }
}

describe('MemoryController：安全闸门', () => {
  it('用户明确要求记住 + 长期边界 → persist confirmed', () => {
    const { actions, state } = run([{ type: 'user-message', text: '记住：以后回答不要太长。', at: 1 }])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'persist', explicit: true })
    if (actions[0]?.type === 'persist') {
      expect(actions[0].candidate).toMatchObject({ scope: 'user', kind: 'semantic', stage: 'confirmed' })
    }
    expect(state.candidates).toHaveLength(1)
  })

  it('非显式的稳定决策 → 只产生 candidate，不冒充 confirmed', () => {
    const { actions } = run([{ type: 'user-message', text: '这个项目决定统一用 pnpm。', at: 1 }])
    expect(actions[0]).toMatchObject({ type: 'persist', explicit: false })
    if (actions[0]?.type === 'persist') {
      expect(actions[0].candidate).toMatchObject({ scope: 'project', stage: 'candidate' })
    }
  })

  it('临时任务约束 → 只 track-task，回合结束 expire，绝不 persist', () => {
    const { actions } = run([
      { type: 'user-message', text: '这次不要联网，先离线测试。', at: 1 },
      { type: 'turn-end', at: 2 },
    ])
    expect(actions.filter(action => action.type === 'persist')).toHaveLength(0)
    expect(actions[0]).toMatchObject({ type: 'track-task' })
    expect(actions[1]).toMatchObject({ type: 'expire-task' })
  })

  it('显式记住临时约束 → 只请求模型限定边界，不自动写', () => {
    const { actions } = run([{ type: 'user-message', text: '记住：这次不要联网。', at: 1 }])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'request-model', reason: 'explicit-temporary' })
  })

  it('纠正旧结论 → lookup + request-model，不直接写', () => {
    const { actions } = run([{ type: 'user-message', text: '之前说的方案不对，改成先用 SQLite。', at: 1 }])
    expect(actions.map(action => action.type)).toEqual(['lookup', 'request-model'])
  })

  it('工具结果不产生记忆动作（项目证据另走 project-evidence）', () => {
    const { actions } = run([{ type: 'tool-result', tool: 'pwsh', text: 'ok\n[exit code: 0]', at: 1 }])
    expect(actions).toEqual([])
  })

  it('同一文本去重；memory-written 清除候选', () => {
    const first = run([{ type: 'user-message', text: '以后都用 pnpm。', at: 1 }])
    const second = reduceMemoryEvent(first.state, { type: 'user-message', text: '以后都用 pnpm。', at: 2 })
    expect(second.actions).toEqual([])
    const cleared = reduceMemoryEvent(second.state, { type: 'memory-written', text: '以后都用 pnpm。', at: 3 })
    expect(cleared.state.candidates).toHaveLength(0)
  })

  it('含密钥的消息不进入控制器', () => {
    const { actions } = run([{ type: 'user-message', text: '记住 token=sk-abcdefghijklmnopqrstuvwxyz', at: 1 }])
    expect(actions).toEqual([])
  })

  it('形态闸门：疑问句 / 命令 / 代码不产生 persist（与捕获路径同判据）', () => {
    expect(run([{ type: 'user-message', text: '以后这种情况怎么办？', at: 1 }]).actions).toEqual([])
    expect(run([{ type: 'user-message', text: '以后要不要直接用 pnpm？', at: 1 }]).actions).toEqual([])
    expect(run([{ type: 'user-message', text: '/compact 以后都用这个', at: 1 }]).actions).toEqual([])
    expect(run([{ type: 'user-message', text: '```ts\nconst x = 1\n``` 以后都用这个', at: 1 }]).actions).toEqual([])
  })

  it('非显式长期偏好但没有任何偏好标记 → 不写（与捕获路径 no-marker 一致）', () => {
    // “长期”是长期边界但不是偏好标记：旧捕获路径也会因 no-marker 跳过。
    expect(run([{ type: 'user-message', text: '长期使用 pnpm 作为包管理器。', at: 1 }]).actions).toEqual([])
  })

  it('任务 TTL：下一次事件先清算到期约束（不依赖回合结束）', () => {
    const first = run([{ type: 'user-message', text: '这次不要联网，先离线测试。', at: 1 }])
    expect(first.actions[0]).toMatchObject({ type: 'track-task' })
    expect(first.state.tasks).toHaveLength(1)

    const later = reduceMemoryEvent(first.state, {
      type: 'user-message',
      text: '好的，继续。',
      at: 1 + CONTROLLER_TASK_TTL_MS,
    })
    expect(later.actions[0]).toMatchObject({ type: 'expire-task', reason: 'ttl' })
    expect(later.state.tasks).toHaveLength(0)
  })

  it('回合结束无条件清空剩余任务（reason=turn-end）', () => {
    const first = run([{ type: 'user-message', text: '这次不要联网，先离线测试。', at: 1 }])
    const ended = reduceMemoryEvent(first.state, { type: 'turn-end', at: 2 })
    expect(ended.actions[0]).toMatchObject({ type: 'expire-task', reason: 'turn-end' })
    expect(ended.state.tasks).toHaveLength(0)
  })
})
