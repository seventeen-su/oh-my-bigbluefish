/**
 * 模式语义（纯函数）。
 *
 * 这里钉的是**表格语义**：`read-only` 可读不可写、`sealed` 不可读不可写。
 * 任何"顺手放宽"（例如让 read-only 也能写一条"重要的"）都会让这张表失败。
 */
import { describe, expect, it } from 'vitest'
import {
  allowsRead,
  allowsWrite,
  isPrivacyMode,
  modeTitle,
  originTitle,
  parseMode,
  PRIVACY_MODES,
  rankOf,
  readDeniedDetail,
  stricterOf,
  UNATTRIBUTED_WRITE_DENIED,
  writeDeniedDetail,
  type ResolvedPrivacy,
} from '../../../modules/privacy/modes.js'

function resolved(mode: ResolvedPrivacy['mode'], origin: ResolvedPrivacy['origin'] = 'command', inheritedFrom: string | null = null): ResolvedPrivacy {
  return { mode, origin, inheritedFrom, detail: 'test' }
}

describe('读写语义（与表格一字不差）', () => {
  it('normal：可读可写', () => {
    expect(allowsRead('normal')).toBe(true)
    expect(allowsWrite('normal')).toBe(true)
  })

  it('read-only：可读**不可写**', () => {
    expect(allowsRead('read-only')).toBe(true)
    expect(allowsWrite('read-only')).toBe(false)
  })

  it('sealed：不可读**不可写**', () => {
    expect(allowsRead('sealed')).toBe(false)
    expect(allowsWrite('sealed')).toBe(false)
  })
})

describe('严格度是全序（fail-closed 的"更严"靠它）', () => {
  it('normal < read-only < sealed', () => {
    expect(rankOf('normal')).toBeLessThan(rankOf('read-only'))
    expect(rankOf('read-only')).toBeLessThan(rankOf('sealed'))
    expect(stricterOf('normal', 'sealed')).toBe('sealed')
    expect(stricterOf('sealed', 'normal')).toBe('sealed')
    expect(stricterOf('read-only', 'read-only')).toBe('read-only')
  })
})

describe('解析与取值', () => {
  it('只认三种取值', () => {
    expect(PRIVACY_MODES).toEqual(['normal', 'read-only', 'sealed'])
    expect(isPrivacyMode('sealed')).toBe(true)
    expect(isPrivacyMode('SEALED')).toBe(false)
    expect(isPrivacyMode(undefined)).toBe(false)
  })

  it('命令输入接受少量等价写法，解析不出来就是解析不出来', () => {
    expect(parseMode('SEALED')).toBe('sealed')
    expect(parseMode('readOnly')).toBe('read-only')
    expect(parseMode('ro')).toBe('read-only')
    expect(parseMode('off')).toBe('normal')
    expect(parseMode('随便')).toBeUndefined()
    expect(parseMode('')).toBeUndefined()
  })
})

describe('拒绝原因必须可读', () => {
  it('读被拒：写明模式、来源、继承出处与解除办法', () => {
    const text = readDeniedDetail(resolved('sealed', 'inherited', 'parent-1'))
    expect(text).toContain('sealed')
    expect(text).toContain('禁止读取记忆')
    expect(text).toContain('继承自 parent-1')
    expect(text).toContain('/omb-privacy')
  })

  it('写被拒：写明是"禁止写入"以及哪些路径算写', () => {
    const text = writeDeniedDetail(resolved('read-only'))
    expect(text).toContain('read-only')
    expect(text).toContain('禁止写入记忆')
    expect(text).toContain('向量落盘')
    expect(text).toContain('命令设置')
  })

  it('归属未知的拒绝写说明"为什么禁"（不是"你设错了模式"）', () => {
    expect(UNATTRIBUTED_WRITE_DENIED).toContain('无法确定本次调用的会话归属')
    expect(UNATTRIBUTED_WRITE_DENIED).toContain('读不受影响')
  })

  it('标签可读且区分来源', () => {
    expect(modeTitle('sealed')).toContain('不可读不可写')
    expect(originTitle('inherited')).toBe('继承')
    expect(originTitle('fail-closed')).toContain('fail-closed')
  })
})
