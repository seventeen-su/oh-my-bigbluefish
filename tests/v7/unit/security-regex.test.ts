import { describe, expect, it } from 'vitest'
import {
  RegexService,
} from '../../../packages/v7/src/security/regex.js'
import {
  REGEX_MAX_CANDIDATES,
  REGEX_MAX_CONCURRENCY,
  REGEX_MAX_INPUT_CHARS,
  REGEX_MAX_QUANTIFIERS,
  REGEX_MAX_SOURCE_CHARS,
  REGEX_QUEUE_LIMIT,
} from '../../../packages/v7/src/security/regex-limits.js'

function pattern(id: string, source: string, flags?: string) {
  return { id, source, ...(flags === undefined ? {} : { flags }) }
}

describe('RegexService（QuickJS 正则安全执行）', () => {
  it('给定嵌套量词与长输入当匹配则 50ms 级中断返回 timeout 且不抛宿主', async () => {
    const service = new RegexService()
    // 先预热 QuickJS WASM 模块，避免把一次性模块加载计入 50ms 断言。
    await service.match({ input: 'warmup', candidates: [pattern('warmup', 'warmup')] })
    const startedAt = performance.now()

    const result = await service.match({
      input: `${'a'.repeat(40)}b`,
      candidates: [pattern('redos', '(a+)+$')],
    })
    const wallMs = performance.now() - startedAt

    expect(result.status).toBe('timeout')
    expect(result.reason).toContain('50ms')
    expect(result.timedOutIds).toEqual(['redos'])
    expect(result.matchedIds).toEqual([])
    expect(result.durationMs).toBeGreaterThanOrEqual(10)
    // 中断按墙钟 50ms 触发；给 CI 的调度抖动留余量（本机实测约 52ms）。
    expect(result.durationMs).toBeLessThan(250)
    expect(wallMs).toBeLessThan(1000)
  })

  it('给定超时之后当再次匹配普通正则则 QuickJS 上下文仍可用', async () => {
    const service = new RegexService()
    await service.match({ input: `${'a'.repeat(40)}b`, candidates: [pattern('redos', '(a+)+$')] })

    const result = await service.match({
      input: 'DEPLOY_OK',
      candidates: [pattern('normal', '^deploy_ok$', 'i')],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['normal'])
  })

  it('给定 flags i/m/s 当匹配则各自语义生效且按候选顺序返回', async () => {
    const service = new RegexService()
    const input = 'first\nSECOND\nthird'

    const result = await service.match({
      input,
      candidates: [
        pattern('case-insensitive', 'second', 'i'),
        pattern('multiline', '^SECOND$', 'm'),
        pattern('dotall', 'first.SECOND', 's'),
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['case-insensitive', 'multiline', 'dotall'])
  })

  it('给定非法正则当匹配则不抛宿主且不拖累同批正常候选', async () => {
    const service = new RegexService()

    const result = await service.match({
      input: 'abc',
      candidates: [pattern('bad', '('), pattern('good', 'b')],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['good'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toMatchObject({ id: 'bad', reason: 'invalid-source' })
  })

  it('给定空源码与非法 flags 当静态预检则快速拒绝且不进入沙箱', async () => {
    const service = new RegexService()

    const result = await service.match({
      input: 'abc',
      candidates: [
        pattern('empty', ''),
        pattern('duplicate-flags', 'a', 'ii'),
        pattern('unknown-flag', 'a', 'z'),
        pattern('good', 'abc'),
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['good'])
    expect(result.rejected.map(item => [item.id, item.reason])).toEqual([
      ['empty', 'empty-source'],
      ['duplicate-flags', 'invalid-flags'],
      ['unknown-flag', 'invalid-flags'],
    ])
  })

  it('给定超长源码当静态预检则拒绝并继续匹配正常候选', async () => {
    const service = new RegexService()

    const result = await service.match({
      input: 'abc',
      candidates: [
        pattern('too-long', 'a'.repeat(REGEX_MAX_SOURCE_CHARS + 1)),
        pattern('good', 'abc'),
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['good'])
    expect(result.rejected[0]).toMatchObject({ id: 'too-long', reason: 'source-too-long' })
  })

  it('给定量词数量超过静态复杂度预算当预检则拒绝但不替代 50ms 运行时中断', async () => {
    const service = new RegexService()

    const result = await service.match({
      input: 'abc',
      candidates: [
        pattern('too-complex', `${'a+'.repeat(REGEX_MAX_QUANTIFIERS + 1)}$`),
        pattern('good', 'abc'),
      ],
    })

    expect(result.status).toBe('ok')
    expect(result.matchedIds).toEqual(['good'])
    expect(result.rejected[0]).toMatchObject({ id: 'too-complex', reason: 'too-complex' })
  })

  it('给定输入超过长度上限当匹配则不进入沙箱且返回 invalid-input', async () => {
    const service = new RegexService()

    const result = await service.match({
      input: 'a'.repeat(REGEX_MAX_INPUT_CHARS + 1),
      candidates: [pattern('any', 'a')],
    })

    expect(result.status).toBe('invalid-input')
    expect(result.reason).toContain(String(REGEX_MAX_INPUT_CHARS))
    expect(result.matchedIds).toEqual([])
  })

  it('给定候选数量超过上限当匹配则返回 invalid-input 而不是无界执行', async () => {
    const service = new RegexService()
    const candidates = Array.from(
      { length: REGEX_MAX_CANDIDATES + 1 },
      (_, index) => pattern(String(index), 'a'),
    )

    const result = await service.match({ input: 'a', candidates })

    expect(result.status).toBe('invalid-input')
    expect(result.reason).toContain(String(REGEX_MAX_CANDIDATES))
  })

  it('给定 20 路并发当超过并发与排队上限则多余调用明确返回 busy', async () => {
    const service = new RegexService()
    const total = REGEX_MAX_CONCURRENCY + REGEX_QUEUE_LIMIT + 8

    const results = await Promise.all(
      Array.from({ length: total }, () => service.match({
        input: 'abc',
        candidates: [pattern('one', 'abc')],
      })),
    )

    expect(results.filter(result => result.status === 'busy')).toHaveLength(total - REGEX_MAX_CONCURRENCY - REGEX_QUEUE_LIMIT)
    expect(results.filter(result => result.status === 'ok')).toHaveLength(REGEX_MAX_CONCURRENCY + REGEX_QUEUE_LIMIT)
    expect(results.every(result => result.status === 'ok' || result.status === 'busy')).toBe(true)
  })
})
