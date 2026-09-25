/**
 * `modules/memory/text.ts`：CJK / 中英混合分词 + FTS5 MATCH 表达式。
 *
 * 这些用例是 §11.3 移植清单里 `tests/m3/cjk-retrieval.test.ts` 的**语义**（CJK 子串召回；
 * 单字/多字/混合/非 CJK 边界），不复制旧文件。
 */
import { describe, expect, it } from 'vitest'
import { ftsMatchExpr, tokenizeForFts } from '../../../modules/memory/text.js'

describe('tokenizeForFts —— CJK 二元滑窗', () => {
  it('多字 CJK 段切成重叠 bigram（使「记忆」能命中「长期记忆系统」）', () => {
    expect(tokenizeForFts('长期记忆系统')).toBe('长期 期记 记忆 忆系 系统')
  })

  it('长度为 2 的 CJK 段就是一个 bigram', () => {
    expect(tokenizeForFts('记忆')).toBe('记忆')
  })

  it('单字 CJK 段保留单字（不足二元）', () => {
    expect(tokenizeForFts('鱼')).toBe('鱼')
  })

  it('多个 CJK 段各自成窗（空白是段边界）', () => {
    expect(tokenizeForFts('记忆 系统')).toBe('记忆 系统')
  })

  it('混合中英：非 CJK 段原样保留，两侧 CJK 各自成窗', () => {
    expect(tokenizeForFts('FTS5 中文检索 SQLite')).toBe('FTS5 中文 文检 检索 SQLite')
  })

  it('CJK 与英文紧邻（无空白）也是段边界', () => {
    expect(tokenizeForFts('用SQLite存记忆')).toBe('用 SQLite 存记 记忆')
  })

  it('标识符 / API 名 / 错误串大小写与符号精确保留', () => {
    expect(tokenizeForFts('kernel.provide("embedder") ENOENT a:b')).toBe(
      'kernel.provide("embedder") ENOENT a:b',
    )
  })

  it('非 CJK 段按空白切分并丢弃空片段（连续空白、首尾空白）', () => {
    expect(tokenizeForFts('  alpha   beta\t\n gamma  ')).toBe('alpha beta gamma')
  })

  it('空串与纯空白 → 空 token 串', () => {
    expect(tokenizeForFts('')).toBe('')
    expect(tokenizeForFts('   \t\n ')).toBe('')
  })

  it('换行分隔的混合正文不粘连 token', () => {
    expect(tokenizeForFts('第一行\n第二行 FTS5')).toBe('第一 一行 第二 二行 FTS5')
  })

  it('CJK 扩展 A 区（\\u3400-\\u4dbf）同样参与滑窗', () => {
    expect(tokenizeForFts('㐀㐁㐂')).toBe('㐀㐁 㐁㐂')
  })

  it('确定性：同输入 → 同输出（两侧分词必须可复现）', () => {
    const text = '长期记忆系统 with FTS5'
    expect(tokenizeForFts(text)).toBe(tokenizeForFts(text))
  })
})

describe('ftsMatchExpr —— MATCH 表达式与转义', () => {
  it('每个 token 加引号、OR 连接（不是隐式 AND，否则长查询系统性漏检）', () => {
    expect(ftsMatchExpr('契约 约边 边界')).toBe('"契约" OR "约边" OR "边界"')
  })

  it('空 / 纯空白 token 串 → 空表达式（调用方不得以此执行 MATCH）', () => {
    expect(ftsMatchExpr('')).toBe('')
    expect(ftsMatchExpr('   ')).toBe('')
  })

  it('双引号被双写转义（防 MATCH 语法注入）', () => {
    expect(ftsMatchExpr('a"b')).toBe('"a""b"')
    expect(ftsMatchExpr('say "hi" now')).toBe('"say" OR """hi""" OR "now"')
  })

  it('保留字与语法字符不再是语法：被关进引号内', () => {
    expect(ftsMatchExpr('AND')).toBe('"AND"')
    expect(ftsMatchExpr('NOT OR NEAR')).toBe('"NOT" OR "OR" OR "NEAR"')
    expect(ftsMatchExpr('a:b* -c ^d')).toBe('"a:b*" OR "-c" OR "^d"')
  })

  it('CJK 分词结果可直接喂进来（两侧同源）', () => {
    expect(ftsMatchExpr(tokenizeForFts('长期记忆系统'))).toBe(
      '"长期" OR "期记" OR "记忆" OR "忆系" OR "系统"',
    )
  })

  it('多余空白不产生空引号项', () => {
    expect(ftsMatchExpr('  a   b  ')).toBe('"a" OR "b"')
  })
})
