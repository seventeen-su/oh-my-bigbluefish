import { describe, expect, it } from 'vitest'
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
  })
})
