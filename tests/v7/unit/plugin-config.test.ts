import { describe, expect, it } from 'vitest'
import { isValidTimeZone } from '../../../packages/v7/src/retrieval/timezone.js'
import { parseConfig } from '../../../plugin/v7/index.js'

describe('v7 plugin config', () => {
  it('给定 urlAllowlist 当解析配置则保留 allowlist 与私网开关', () => {
    const parsed = parseConfig({
      urlAllowlist: ['https://example.com/docs'],
      urlAllowPrivateAddresses: true,
      urlTimeoutMs: 1234,
      urlMaxBytes: 2048,
    })
    expect(parsed.problems).toEqual([])
    expect(parsed.config.urlAllowlist).toEqual(['https://example.com/docs'])
    expect(parsed.config.urlAllowPrivateAddresses).toBe(true)
    expect(parsed.config.urlTimeoutMs).toBe(1234)
    expect(parsed.config.urlMaxBytes).toBe(2048)
  })

  it('给定非法 urlAllowlist 当解析配置则报问题并保持关闭', () => {
    const parsed = parseConfig({ urlAllowlist: ['https://example.com', ''] })
    expect(parsed.problems).toContain('urlAllowlist 必须是非空字符串数组')
    expect(parsed.config.urlAllowlist).toEqual([])
  })

  it('给定空配置当解析配置则 url 默认关闭', () => {
    const parsed = parseConfig({})
    expect(parsed.config.urlAllowlist).toEqual([])
    expect(parsed.config.urlAllowPrivateAddresses).toBe(false)
    // 时区永远落到一个显式 IANA 名称上（配置 > 宿主 > UTC），检索模块不需要自己猜。
    expect(isValidTimeZone(parsed.config.timeZone)).toBe(true)
  })

  it('给定时区配置当解析配置则保留 IANA 名称，非法值报问题并回落到宿主时区', () => {
    expect(parseConfig({ timezone: 'Asia/Shanghai' }).config.timeZone).toBe('Asia/Shanghai')

    const fallback = parseConfig({})
    const invalid = parseConfig({ timezone: 'Not/AZone' })
    expect(invalid.problems.some(problem => problem.includes('timezone'))).toBe(true)
    expect(invalid.config.timeZone).toBe(fallback.config.timeZone)
    expect(isValidTimeZone(invalid.config.timeZone)).toBe(true)
  })
})
