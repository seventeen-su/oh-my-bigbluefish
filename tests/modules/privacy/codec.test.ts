/**
 * 持久化文档编解码（纯函数）。
 *
 * 核心判据：
 * ① **文件不存在 ≠ 文件损坏**：前者是"从未配置过"（基线 normal），
 *    后者是"曾经配置过但读不出来"（基线按最严兜底）。混为一谈会让首次安装的用户
 *    记忆直接不可用，或让损坏悄悄放宽隐私——两个方向都是事故。
 * ② 编码是**逐字节确定**的（键排序），于是"内容未变就不写"成立。
 */
import { describe, expect, it } from 'vitest'
import {
  decodeDoc,
  degradedDoc,
  docSize,
  emptyDoc,
  encodeDoc,
  PRIVACY_DOC_VERSION,
} from '../../../modules/memory/privacy/codec.js'

const NOW = 1_700_000_000_000

describe('空/不存在', () => {
  it('不存在 → 基线 normal、无错误、非降级', () => {
    const result = decodeDoc('', NOW, false)
    expect(result.exists).toBe(false)
    expect(result.degraded).toBe(false)
    expect(result.error).toBeNull()
    expect(result.doc.failClosedAt).toBeNull()
    expect(result.doc.modes).toEqual({})
  })

  it('空文档形状稳定', () => {
    expect(emptyDoc()).toEqual({ version: PRIVACY_DOC_VERSION, failClosedAt: null, modes: {} })
    expect(docSize(emptyDoc())).toBe(0)
  })
})

describe('损坏 → fail-closed（粘性）', () => {
  it('文件为空 → 降级且基线被钉为最严', () => {
    const result = decodeDoc('   \n', NOW)
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('为空')
    expect(result.doc.failClosedAt).toBe(NOW)
  })

  it('非法 JSON → 降级', () => {
    const result = decodeDoc('{ not json', NOW)
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('不是合法 JSON')
    expect(result.doc.failClosedAt).toBe(NOW)
  })

  it('顶层不是对象 → 降级', () => {
    expect(decodeDoc('"sealed"', NOW).degraded).toBe(true)
    expect(decodeDoc('[1,2]', NOW).degraded).toBe(true)
  })

  it('版本不认识 → 降级（不猜未来结构）', () => {
    const result = decodeDoc(JSON.stringify({ version: 99, modes: {} }), NOW)
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('不认识的隐私状态版本')
    expect(result.doc.modes).toEqual({})
  })

  it('单条非法 → 丢弃该条**并整体降级**（丢一条就等于丢一个会话的限制）', () => {
    const text = JSON.stringify({
      version: PRIVACY_DOC_VERSION,
      failClosedAt: null,
      modes: { keep: 'sealed', bad: 'whatever', alsoBad: 42 },
    })
    const result = decodeDoc(text, NOW)
    expect(result.doc.modes).toEqual({ keep: 'sealed' })
    expect(result.degraded).toBe(true)
    expect(result.doc.failClosedAt).toBe(NOW)
    expect(result.error).toContain('2 条')
  })

  it('已有的粘性标记被保留（即使这次解析成功了）', () => {
    const sticky = NOW - 1000
    const text = encodeDoc({ version: PRIVACY_DOC_VERSION, failClosedAt: sticky, modes: { s1: 'sealed' } })
    const result = decodeDoc(text, NOW)
    expect(result.degraded).toBe(false)
    expect(result.doc.failClosedAt).toBe(sticky) // 粘性：解析成功也不自动清除
    expect(result.doc.modes).toEqual({ s1: 'sealed' })
  })

  it('degradedDoc 会带上解析期读到的合法条目', () => {
    const doc = degradedDoc(NOW, { s1: 'read-only' })
    expect(doc.failClosedAt).toBe(NOW)
    expect(doc.modes).toEqual({ s1: 'read-only' })
  })
})

describe('编码确定性', () => {
  it('键排序 → 逐字节相同（与写入顺序无关）', () => {
    const a = encodeDoc({ version: 1, failClosedAt: null, modes: { b: 'sealed', a: 'normal' } })
    const b = encodeDoc({ version: 1, failClosedAt: null, modes: { a: 'normal', b: 'sealed' } })
    expect(a).toBe(b)
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'))
  })

  it('往返一致', () => {
    const doc = { version: PRIVACY_DOC_VERSION, failClosedAt: null, modes: { s1: 'sealed' as const } }
    const decoded = decodeDoc(encodeDoc(doc), NOW)
    expect(decoded.degraded).toBe(false)
    expect(decoded.doc.modes).toEqual({ s1: 'sealed' })
  })

  it('编码会丢掉非法取值（不让脏数据回流）', () => {
    const text = encodeDoc({
      version: 1,
      failClosedAt: null,
      modes: { ok: 'sealed', bad: 'nope' as never },
    })
    expect(text).toContain('"ok"')
    expect(text).not.toContain('nope')
  })
})
