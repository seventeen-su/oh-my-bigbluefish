/**
 * `adapters/dsh/host.ts` 两处被删除的死回退的回归锚点：
 *
 * 1. legacy prompt sink 分支：DSH `systemPrompt.context(context: PromptContext)` 只接受对象，
 *    且 `getContextOrder` 是同服务的固定方法（`packages/core/system-prompt/src/index.ts:511,521`），
 *    所以“没有 getContextOrder 就走 legacy `context(text)`”的分支不可达。现在无论宿主是否有
 *    `getContextOrder`，都只用对象式注册。
 * 2. `record.sessionId` 回退：DSH `ToolExecution` 没有顶层 `sessionId`
 *    （`packages/core/tools/src/contracts.ts:175-225`），session 只能从 `agent.session` 取。
 */
import { describe, expect, it } from 'vitest'
import {
  createPromptSink,
  sessionFromExec,
  type HostContextLike,
} from '../../../packages/v7/src/adapters/dsh/host.js'

interface RegisteredContext {
  readonly name: string
  readonly order: number
  readonly text: (assembleContext: unknown) => string
}

const SESSION = (id: string) => ({ agent: { session: { id } } })

function fakeHost(getContextOrder?: (name: string) => number) {
  const registered: unknown[] = []
  const service = {
    context: (arg: unknown): (() => void) => {
      registered.push(arg)
      return () => {}
    },
    ...(getContextOrder === undefined ? {} : { getContextOrder }),
  }
  const ctx = { get: (name: string) => (name === 'systemPrompt' ? service : undefined) }
  return { ctx: ctx as HostContextLike, registered }
}

function registeredContext(registered: unknown[]): RegisteredContext {
  const first = registered[0]
  if (typeof first !== 'object' || first === null) throw new Error(`没有以对象注册 prompt context：${String(first)}`)
  return first as RegisteredContext
}

describe('DSH 宿主适配器：prompt sink 注册形状', () => {
  it('给定宿主没有 getContextOrder 当注册则仍以对象式注册并可由 provider 供文本', () => {
    const host = fakeHost()
    const sink = createPromptSink(host.ctx)

    expect(sink.available).toBe(true)
    const context = registeredContext(host.registered)
    expect(context.name).toBe('omb-v7:injection')
    expect(typeof context.text).toBe('function')
    expect(sink.write('session-a', 'T0 常驻文本')).toBe(true)
    expect(context.text(SESSION('session-a'))).toBe('T0 常驻文本')
  })

  it('给定宿主有 getContextOrder 当注册则 order 落在 WEB_SURFACE 之后', () => {
    const host = fakeHost(() => 200)
    createPromptSink(host.ctx)

    expect(registeredContext(host.registered).order).toBe(205)
  })

  it('给定同一 session 覆盖写当读 provider 则返回最后一次文本（空串清旧依赖此语义）', () => {
    const host = fakeHost(() => 200)
    const sink = createPromptSink(host.ctx)
    const context = registeredContext(host.registered)

    expect(sink.write('session-b', '上一轮文本')).toBe(true)
    expect(sink.write('session-b', '')).toBe(true)

    expect(context.text(SESSION('session-b'))).toBe('')
  })

  it('给定空白 sessionId 当写则返回 false 且不落任何 session 文本', () => {
    const host = fakeHost(() => 200)
    const sink = createPromptSink(host.ctx)
    const context = registeredContext(host.registered)

    expect(sink.write('   ', '不该落库的文本')).toBe(false)
    expect(context.text(SESSION('   '))).toBe('')
  })

  it('给定 dispose 当读 provider 则返回空串', () => {
    const host = fakeHost(() => 200)
    const sink = createPromptSink(host.ctx)
    const context = registeredContext(host.registered)
    expect(sink.write('session-c', '文本')).toBe(true)

    sink.dispose()

    expect(context.text(SESSION('session-c'))).toBe('')
  })
})

describe('DSH 宿主适配器：工具执行的 session 来源', () => {
  it('给定 exec 只有顶层 sessionId 当解析则 undefined（不再有该回退）', () => {
    expect(sessionFromExec({ sessionId: 'stale-session' })).toBeUndefined()
  })

  it('给定 agent.session.id 当解析则取它，并带上 header.cwd 与 agent 名字', () => {
    const context = sessionFromExec({
      sessionId: 'stale-session',
      agent: { name: 'lead/reviewer', session: { id: 'session-d', header: { cwd: 'D:\\work' } } },
    })

    expect(context).toEqual({ sessionId: 'session-d', cwd: 'D:\\work', agentPath: 'lead/reviewer' })
  })
})
