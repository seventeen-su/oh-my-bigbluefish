import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BERT_MAX_LENGTH,
  vocabularyFromLines,
  WordPieceTokenizer,
} from '../../../../packages/v7/src/adapters/embedding/tokenizer.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/vocab.txt', import.meta.url))

function fixture(): WordPieceTokenizer {
  return WordPieceTokenizer.fromFile(FIXTURE)
}

describe('WordPieceTokenizer', () => {
  it('装载词表后按行号给出 [CLS]/[SEP]/[UNK]/[PAD]', () => {
    const tokenizer = fixture()
    expect(tokenizer.clsId).toBe(2)
    expect(tokenizer.sepId).toBe(3)
    expect(tokenizer.unkId).toBe(1)
    expect(tokenizer.padId).toBe(0)
    expect(tokenizer.maxLength).toBe(BERT_MAX_LENGTH)
    expect(tokenizer.vocabSize).toBe(10)
  })

  it('给定 CJK 文本当编码则逐字成 token 并夹上 [CLS]/[SEP]', () => {
    expect(fixture().encode('你好')).toEqual([2, 4, 5, 3])
  })

  it('给定英文单词当编码则按 WordPiece 最长匹配切开', () => {
    // hello 命中整词；world 不在词表，切成 wor + ##ld。
    expect(fixture().encode('hello world')).toEqual([2, 6, 7, 8, 3])
  })

  it('给定中文标点当编码则标点独立成 token', () => {
    expect(fixture().encode('你，好')).toEqual([2, 4, 9, 5, 3])
  })

  it('给定词表外字符当编码则该词整体记 [UNK]', () => {
    expect(fixture().encode('z')).toEqual([2, 1, 3])
    expect(fixture().encode('好z')).toEqual([2, 5, 1, 3])
  })

  it('给定大小写混合当编码则先小写再匹配', () => {
    expect(fixture().encode('Hello')).toEqual([2, 6, 3])
  })

  it('给定首尾空白与连续空白当编码则折叠后结果相同', () => {
    expect(fixture().encode('  你  好  ')).toEqual([2, 4, 5, 3])
  })

  it('给定空文本当编码则只剩 [CLS]/[SEP]', () => {
    expect(fixture().encode('')).toEqual([2, 3])
  })

  it('给定超过 100 字符的长 token 当编码则整词短路为 [UNK]（不做 O(n²) 回扫）', () => {
    const tokenizer = WordPieceTokenizer.fromVocab(['[CLS]', '[SEP]', '[UNK]', 'a', '##a'])
    // 100 字符仍可拆成 100 个词块（走贪心最长匹配）。
    const decomposed = tokenizer.encode('a'.repeat(100))
    expect(decomposed.length).toBe(102)
    expect(decomposed).not.toContain(2)
    // 101 字符触发 HF 同口径短路：整词 [UNK]，而不是拼 101 个词块。
    expect(tokenizer.encode('a'.repeat(101))).toEqual([0, 2, 1])
  })

  it('给定 maxLength 当编码则长度不超过上限且保留 [CLS]/[SEP]', () => {
    const tokenizer = WordPieceTokenizer.fromVocab(readFileSync(FIXTURE, 'utf8').split('\n'), 4)
    const ids = tokenizer.encode('hello你好')
    expect(ids.length).toBe(4)
    expect(ids[0]).toBe(tokenizer.clsId)
    expect(ids[ids.length - 1]).toBe(tokenizer.sepId)
  })

  it('给定多块单词当编码且上限为 4 则在块边界截断', () => {
    const tokenizer = WordPieceTokenizer.fromVocab(readFileSync(FIXTURE, 'utf8').split('\n'), 4)
    expect(tokenizer.encode('hello world')).toEqual([2, 6, 7, 3])
  })

  it('给定空词表当装载则抛错而不是产出一个全 [UNK] 的假分词器', () => {
    expect(() => WordPieceTokenizer.fromVocab([])).toThrow(/文件为空/)
  })

  it('给定缺 [CLS]/[SEP] 的词表当装载则抛错', () => {
    expect(() => WordPieceTokenizer.fromVocab(['[PAD]', '[UNK]'])).toThrow(/缺少 \[CLS\]\/\[SEP\]/)
  })

  it('给定 maxLength < 2 当装载则抛 RangeError', () => {
    expect(() => WordPieceTokenizer.fromVocab(['[CLS]', '[SEP]'], 1)).toThrow(RangeError)
  })
})

describe('vocabularyFromLines', () => {
  it('给定以换行结尾的文件内容则忽略末尾空行，不占用 token id', () => {
    const vocab = vocabularyFromLines(['[PAD]', '[CLS]', '[SEP]', ''])
    expect(vocab.get('[CLS]')).toBe(1)
    expect(vocab.get('[SEP]')).toBe(2)
    expect(vocab.has('')).toBe(false)
  })

  it('给定中间空行则保留为 id（行号即 id，不能移位）', () => {
    const vocab = vocabularyFromLines(['[CLS]', '', '[SEP]'])
    expect(vocab.get('[SEP]')).toBe(2)
  })
})

describe('WordPieceTokenizer.fromFile', () => {
  it('给定不存在的词表文件当装载则抛 ENOENT', () => {
    expect(() => WordPieceTokenizer.fromFile(FIXTURE.replace('vocab.txt', 'missing.txt'))).toThrow(/ENOENT/)
  })
})
