/**
 * `SessionRuntime` / `TurnEnvelope` / `ToolCallContext` —— 归属的正确性。
 *
 * 这一组用例钉住 task-7 的**两条不变式**（模块级交错用例在 phase 2 随迁移一起加）：
 *
 * ① **拿不到会话就不猜**：`note()` 拒绝空会话并把这次记进"归属未知"计数；
 *    工具归属在宿主没给 `agent` 时是 `unknown`，**不会**退化成"最近一个会话"。
 * ② **按会话隔离**：`for(A)` / `for(B)` 的槽互不可见；A、B 交错观测不会互相覆盖。
 *
 * 归属来源的确切取值路径（DSH 0.2.0-rc.2）：
 * - `exec.agent.id`：`packages/core/agent/src/types.ts:15-18`
 * - `exec.agent.session.header.{parentSession,delegationDepth}`：
 *   `packages/core/agent/src/runtime-types.ts:163-168` +
 *   `packages/core/session/src/types.ts:101/107/123`
 * - 宿主把执行上下文交给工具：`packages/core/tools/src/index.ts:236`（签名）与
 *   `:1581`（真实调用），agent 由 `packages/core/agent-loop/src/tool-calls.ts:68-81` 传入。
 */
import { describe, expect, it } from 'vitest'
import { SessionRuntimeTable, toolCallContext } from '../../kernel/sessionRuntime.js'
import { createKernel } from '../../kernel/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import { toolCallContextFromHostExec } from '../../dsh/tools.js'
import { fixedClock } from './memory/helpers.js'

describe('内核接线：按会话运行态**只有一份**', () => {
  it('createKernel 提供 SERVICES.sessionRuntime，消费者拿到的是同一个实例', () => {
    const handle = createKernel()
    const table = handle.kernel.service<SessionRuntimeTable>(SERVICES.sessionRuntime)
    expect(table).toBeInstanceOf(SessionRuntimeTable)
    // 多个消费者（隐私、推理、记忆…）必须复用同一份：各建一份 = 同一个会话的状态
    // 被拆到不同的表里，那正是 `lastActiveSession` 那类缺陷的翻版。
    expect(handle.kernel.service(SERVICES.sessionRuntime)).toBe(table)
    // 服务名与消费方（`omb-privacy`）用的字面量一致
    expect(SERVICES.sessionRuntime).toBe('omb:session-runtime')
    handle.dispose()
  })

  it('内核注销时清空按会话运行态（重挂后读不到上一代的槽）', () => {
    const handle = createKernel()
    const table = handle.kernel.service<SessionRuntimeTable>(SERVICES.sessionRuntime)
    table?.ensure('A')?.slot('privacy:mode', () => 'strict')
    table?.note({ sessionId: 'A', source: 'session-event' })
    expect(table?.for('A')?.peekSlot('privacy:mode')).toBe('strict')
    expect(table?.stats().sessions).toBe(1)

    handle.dispose()
    expect(table?.list()).toHaveLength(0)
    expect(table?.for('A')).toBeUndefined()
    expect(table?.stats()).toEqual({ sessions: 0, unknownObservations: 0 })
  })
})

describe('ToolCallContext：归属只认确切来源', () => {
  it('agent.id 存在 → attribution=session，并带出调用 id 与血统', () => {
    const call = toolCallContext({
      sessionId: 's-A',
      callId: 'c1',
      parentSessionId: 's-parent',
      delegationDepth: 1,
    })
    expect(call).toMatchObject({
      sessionId: 's-A',
      callId: 'c1',
      parentSessionId: 's-parent',
      delegationDepth: 1,
      attribution: 'session',
    })
  })

  it('没有会话 id → attribution=unknown（**绝不**填一个"最近会话"进去）', () => {
    expect(toolCallContext({})).toEqual({ attribution: 'unknown' })
    expect(toolCallContext({ sessionId: '   ' }).attribution).toBe('unknown')
    expect(toolCallContext({ sessionId: 42 }).attribution).toBe('unknown')
  })
})

describe('宿主 exec → 归属投影（dsh 层唯一的形状读取点）', () => {
  it('从 exec.agent.id 拿到会话（DSH 声明字段）', () => {
    const call = toolCallContextFromHostExec({ callId: 'c9', agent: { id: 'sess-1' } })
    expect(call).toMatchObject({ sessionId: 'sess-1', callId: 'c9', attribution: 'session' })
  })

  it('agent.id 缺失时用 agent.session.header.id 兜底，并带出子代理血统', () => {
    const call = toolCallContextFromHostExec({
      callId: 'c10',
      agent: { session: { header: { id: 'child-1', parentSession: 'parent-1', delegationDepth: 2 } } },
    })
    expect(call).toMatchObject({
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      delegationDepth: 2,
      attribution: 'session',
    })
  })

  it('宿主形状漂移（没有 agent / 不是对象 / 抛异常）→ unknown，绝不抛', () => {
    expect(toolCallContextFromHostExec(undefined).attribution).toBe('unknown')
    expect(toolCallContextFromHostExec('nonsense').attribution).toBe('unknown')
    expect(toolCallContextFromHostExec({ agent: { id: 42 } }).attribution).toBe('unknown')
    const hostile = {
      get callId(): string {
        throw new Error('宿主形状读取爆炸')
      },
    }
    expect(toolCallContextFromHostExec(hostile).attribution).toBe('unknown')
  })
})

describe('SessionRuntimeTable：按会话键控，绝不串味', () => {
  it('两个会话的槽互不可见（同样的键，两个对象）', () => {
    const table = new SessionRuntimeTable(fixedClock())
    const a = table.ensure('A')
    const b = table.ensure('B')
    expect(a).not.toBe(b)

    const slotA = a?.slot('memory:pressure', () => ({ session: 'A' }))
    const slotB = b?.slot('memory:pressure', () => ({ session: 'B' }))
    expect(slotA).toEqual({ session: 'A' })
    expect(slotB).toEqual({ session: 'B' })
    expect(a?.slot('memory:pressure', () => ({ session: 'X' }))).toBe(slotA) // 同会话复用
    expect(b?.peekSlot('memory:pressure')).toBe(slotB)
    expect(a?.peekSlot('reasoning:loop')).toBeUndefined() // 没建过就不创建
  })

  it('交错观测：A → B → A，两个会话各自的"最近一次"都对，槽也不串', () => {
    const table = new SessionRuntimeTable(fixedClock())
    const a = table.ensure('A')
    const b = table.ensure('B')
    a?.slot('reasoning:loop', () => ({ signals: [] as string[] }))
    b?.slot('reasoning:loop', () => ({ signals: [] as string[] }))

    const first = table.note({ sessionId: 'A', turnId: 1, source: 'session-event' })
    const second = table.note({ sessionId: 'B', turnId: 1, source: 'session-event' })
    const third = table.note({ sessionId: 'A', turnId: 2, source: 'session-event' })

    expect([first?.sessionId, second?.sessionId, third?.sessionId]).toEqual(['A', 'B', 'A'])
    expect(a?.lastTurn?.turnId).toBe(2)
    expect(b?.lastTurn?.turnId).toBe(1)
    // 序号是**按会话**独立递增的：B 的第二次观测不会推进 A 的序号
    expect([first?.sequence, second?.sequence, third?.sequence]).toEqual([1, 1, 2])
  })

  it('空会话 → 拒绝并计入"归属未知"（不建运行态、不猜）', () => {
    const table = new SessionRuntimeTable(fixedClock())
    expect(table.note({ sessionId: '', source: 'tool-call' })).toBeNull()
    expect(table.note({ sessionId: undefined, source: 'tool-call' })).toBeNull()
    expect(table.note({ sessionId: '   ', source: 'session-event' })).toBeNull()
    expect(table.list()).toHaveLength(0)
    expect(table.unknown()).toEqual({ observations: 3, lastSource: 'session-event' })
    expect(table.ensure('')).toBeNull()
    expect(table.stats()).toEqual({ sessions: 0, unknownObservations: 3 })
  })

  it('迟到/重复的信封被丢弃（sequence 单调）', () => {
    const table = new SessionRuntimeTable(fixedClock())
    const first = table.note({ sessionId: 'A', turnId: 1, source: 'session-event' })
    const second = table.note({ sessionId: 'A', turnId: 2, source: 'session-event' })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // 迟到的旧信封（序号更小）→ 拒绝，不回退"最近一次"
    expect(table.accept({ ...(first as NonNullable<typeof first>) })).toBeNull()
    expect(table.for('A')?.lastTurn?.turnId).toBe(2)
  })

  it('子代理会话是独立运行态，且记下父会话血统', () => {
    const table = new SessionRuntimeTable(fixedClock())
    const parent = table.note({ sessionId: 'P', turnId: 1, source: 'session-event' })
    const child = table.note({
      sessionId: 'C',
      turnId: 1,
      source: 'session-event',
      parentSessionId: 'P',
      delegationDepth: 1,
    })
    expect(parent?.parentSessionId).toBeUndefined() // 顶层会话没有父
    expect(child).toMatchObject({ sessionId: 'C', parentSessionId: 'P', delegationDepth: 1 })
    expect(table.for('C')?.parentSessionId).toBe('P')
    expect(table.for('P')?.parentSessionId).toBeNull()
    // 子会话的槽与父会话完全隔离
    table.for('C')?.slot('memory:state', () => 'child')
    expect(table.for('P')?.peekSlot('memory:state')).toBeUndefined()
    expect(table.list().map(runtime => runtime.sessionId)).toEqual(['C', 'P'])
  })

  it('时钟由调用方注入；时钟故障也不抛（时间戳退化为 0，不影响归属）', () => {
    const clock = fixedClock(1_700_000_000_000)
    const table = new SessionRuntimeTable(clock)
    expect(table.note({ sessionId: 'A', source: 'explicit' })?.timestamp).toBe(1_700_000_000_000)

    const broken = new SessionRuntimeTable({
      now: () => {
        throw new Error('时钟故障')
      },
    })
    expect(broken.note({ sessionId: 'A', source: 'explicit' })?.timestamp).toBe(0)
  })

  it('forget / clear：忘掉一个会话不影响其余；clear 连"归属未知"计数一起清', () => {
    const table = new SessionRuntimeTable(fixedClock())
    table.note({ sessionId: 'A', source: 'explicit' })
    table.note({ sessionId: 'B', source: 'explicit' })
    table.note({ sessionId: '', source: 'tool-call' })

    table.forget('A')
    expect(table.list().map(runtime => runtime.sessionId)).toEqual(['B'])
    expect(table.unknown().observations).toBe(1)

    table.clear()
    expect(table.list()).toHaveLength(0)
    expect(table.unknown()).toEqual({ observations: 0, lastSource: null })
  })
})
