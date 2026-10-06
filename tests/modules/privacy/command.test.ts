/**
 * 命令解析与执行（纯逻辑）。
 *
 * 判据：语法全覆盖；**拿不到会话时拒绝执行并说明原因**（绝不猜"最近一个会话"）；
 * 任何输入都不抛（宿主命令处理器抛异常会影响整条命令通道）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CommandResultLike, PrivacyCommandApi } from '../../../modules/memory/privacy/command.js'
import {
  PRIVACY_COMMAND_NAME,
  PRIVACY_USAGE,
  runPrivacyCommand,
  sessionOfInvocation,
} from '../../../modules/memory/privacy/command.js'

function api(overrides: Partial<PrivacyCommandApi> = {}): PrivacyCommandApi & {
  readonly setMode: ReturnType<typeof vi.fn>
  readonly trust: ReturnType<typeof vi.fn>
  readonly forget: ReturnType<typeof vi.fn>
  readonly clearInactive: ReturnType<typeof vi.fn>
} {
  const setMode = vi.fn((): CommandResultLike => ({ kind: 'success', text: 'set ok' }))
  const trust = vi.fn((): CommandResultLike => ({ kind: 'success', text: 'trust ok' }))
  const forget = vi.fn((): CommandResultLike => ({ kind: 'success', text: 'forget ok' }))
  const clearInactive = vi.fn((): CommandResultLike => ({ kind: 'success', text: 'clear ok' }))
  return {
    statusText: (sessionId: string | null) => `status:${sessionId ?? 'none'}`,
    setMode,
    trust,
    forget,
    clearInactive,
    ...overrides,
  } as PrivacyCommandApi & {
    readonly setMode: ReturnType<typeof vi.fn>
    readonly trust: ReturnType<typeof vi.fn>
    readonly forget: ReturnType<typeof vi.fn>
    readonly clearInactive: ReturnType<typeof vi.fn>
  }
}

const withSession = { sessionId: 's1', parentSessionId: null, delegationDepth: null }
const noSession = { sessionId: null, parentSessionId: null, delegationDepth: null }

describe('会话身份投影', () => {
  it('agent.id 优先，header.id 兜底', () => {
    expect(sessionOfInvocation({ agent: { id: 'a1' } })).toMatchObject({ sessionId: 'a1' })
    expect(sessionOfInvocation({ agent: { session: { header: { id: 'h1' } } } })).toMatchObject({ sessionId: 'h1' })
  })

  it('子代理血统来自 header.parentSession / delegationDepth', () => {
    const projected = sessionOfInvocation({
      agent: { id: 'child', session: { header: { parentSession: 'parent', delegationDepth: 2 } } },
    })
    expect(projected).toMatchObject({ sessionId: 'child', parentSessionId: 'parent', delegationDepth: 2 })
  })

  it('拿不到就是 null（不猜）', () => {
    expect(sessionOfInvocation({})).toEqual({ sessionId: null, parentSessionId: null, delegationDepth: null })
    expect(sessionOfInvocation({ agent: { id: '' } }).sessionId).toBeNull()
    expect(sessionOfInvocation({ agent: { id: 'x', session: { header: { delegationDepth: -1 } } } }).delegationDepth).toBeNull()
  })
})

describe('命令语法', () => {
  it('命令名固定（宿主按 name 注册）', () => {
    expect(PRIVACY_COMMAND_NAME).toBe('omb-privacy')
  })

  it('不带参数 = status', () => {
    const a = api()
    expect(runPrivacyCommand('', withSession, a)).toEqual({ kind: 'success', text: 'status:s1' })
    expect(runPrivacyCommand('status', withSession, a)).toEqual({ kind: 'success', text: 'status:s1' })
  })

  it('三种模式分别落到对应的 setMode 参数', () => {
    const sealed = api()
    expect(runPrivacyCommand('sealed', withSession, sealed).kind).toBe('success')
    expect(sealed.setMode).toHaveBeenCalledWith('s1', 'sealed')

    const readOnly = api()
    runPrivacyCommand('read-only', withSession, readOnly)
    expect(readOnly.setMode).toHaveBeenCalledWith('s1', 'read-only')

    const readonlyAlias = api()
    runPrivacyCommand('readonly', withSession, readonlyAlias)
    expect(readonlyAlias.setMode).toHaveBeenCalledWith('s1', 'read-only')

    const normal = api()
    runPrivacyCommand('NORMAL', withSession, normal)
    expect(normal.setMode).toHaveBeenCalledWith('s1', 'normal')
  })

  it('trust 走显式的人工通道', () => {
    const a = api()
    expect(runPrivacyCommand('trust', withSession, a)).toEqual({ kind: 'success', text: 'trust ok' })
    expect(a.trust).toHaveBeenCalledTimes(1)
  })

  it('forget 把会话 id 透传给 api；不带 id 时给可读用法（不猜是哪个会话）', () => {
    const withId = api()
    expect(runPrivacyCommand('forget sess-A', withSession, withId)).toEqual({ kind: 'success', text: 'forget ok' })
    expect(withId.forget).toHaveBeenCalledWith('sess-A')
    expect(withId.clearInactive).not.toHaveBeenCalled()

    const noId = api()
    const result = runPrivacyCommand('forget', withSession, noId)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('forget <会话id>')
    expect(noId.forget).not.toHaveBeenCalled()
  })

  it('clear 走"清全部已结束会话"的通道', () => {
    const a = api()
    expect(runPrivacyCommand('clear', withSession, a)).toEqual({ kind: 'success', text: 'clear ok' })
    expect(a.clearInactive).toHaveBeenCalledTimes(1)
  })

  it('用法文本点名 forget / clear（用户要在输入框里看得到出口）', () => {
    expect(PRIVACY_USAGE).toContain('forget')
    expect(PRIVACY_USAGE).toContain('clear')
    expect(runPrivacyCommand('help', withSession, api()).text).toContain('forget <会话id>')
  })

  it('拿不到会话 → 拒绝执行并说明原因（不猜是哪个会话）', () => {
    const a = api()
    const result = runPrivacyCommand('sealed', noSession, a)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('拿不到本次命令所属的会话')
    expect(a.setMode).not.toHaveBeenCalled()
  })

  it('未知参数给用法', () => {
    const result = runPrivacyCommand('随便', withSession, api())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不认识的参数')
    expect(result.text).toContain('/omb-privacy')
  })

  it('help 与 `?` 给用法', () => {
    expect(runPrivacyCommand('help', withSession, api()).text).toBe(PRIVACY_USAGE)
    expect(runPrivacyCommand('?', withSession, api()).text).toBe(PRIVACY_USAGE)
  })

  it('api 抛异常 → 变成可读的 error 结果（命令通道不得被打断）', () => {
    const a = api({
      setMode: (() => {
        throw new Error('炸了')
      }) as unknown as PrivacyCommandApi['setMode'],
    })
    const result = runPrivacyCommand('sealed', withSession, a)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('炸了')
  })
})
