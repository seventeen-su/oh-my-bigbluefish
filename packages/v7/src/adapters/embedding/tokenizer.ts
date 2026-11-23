/**
 * BERT WordPiece 分词（只读 `vocab.txt`，不引第三方分词库）。
 *
 * BGE-small-zh-v1.5 的分词器就是 BERT WordPiece + 逐字切分 CJK：
 * 1) 基础切分：CJK 单字成 token、标点单 token、其余按空白并小写；
 * 2) WordPiece：贪心最长匹配，非首块加 `##` 前缀，整词不可分则 `[UNK]`；
 * 3) 序列：`[CLS] ids… [SEP]`，按 `maxLength` 截断。
 *
 * 两处容易被实现成静默错误的地方，这里显式处理：
 * - **超长单词短路**：贪心最长匹配的内层从串尾回扫，对长度 n 是 O(n²)；一段无空白的长文本
 *   （压缩代码、base64、超长 URL）能把单次编码拖到几十秒。HF 的阈值是 100 字符，
 *   超过即整词 `[UNK]`，这里同口径短路。
 * - **词表必须可判定**：空文件或缺少 `[CLS]`/`[SEP]` 的词表如果"装载成功"，之后所有文本
 *   都会编码成同一串 `[UNK]`，向量完全相同——通道看起来在工作却毫无区分力。装载期直接抛错。
 */

import { readFileSync } from 'node:fs'

/** BGE 训练长度（含 `[CLS]`/`[SEP]`）；超过部分截断。 */
export const BERT_MAX_LENGTH = 512

/** 单 token 字符上限（与 HF `max_input_chars_per_word` 同口径）。 */
const MAX_INPUT_CHARS_PER_WORD = 100

function isWhitespace(char: string): boolean {
  return /\s/u.test(char)
}

/**
 * 控制字符（BERT `_is_control` 口径）。
 * `\t` / `\n` / `\r` 不算控制符：HF 对它们返回 False，随后被 `isspace()` 折叠成单个空格。
 * 若把它们丢掉，换行两侧的词会被粘成一个 token（`"a\nb"` → `ab`），切错且不可观测。
 */
function isControl(char: string): boolean {
  if (char === '\t' || char === '\n' || char === '\r') return false
  return /[\u0000-\u001f\u007f-\u009f]/u.test(char)
}

/** ASCII + Unicode 标点（BERT `_is_punctuation`）。 */
function isPunctuation(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }
  return /\p{P}/u.test(char)
}

/** CJK 表意文字（逐字切分；与 BERT `_is_chinese_char` 同区间集合）。 */
function isCjkChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

/** 基础清洗：去空字符/替换符/控制符 → 空白折叠为单空格 → 去组合重音（NFD + 去 Mn）。 */
function cleanText(text: string): string {
  let out = ''
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (cp === 0 || cp === 0xfffd || isControl(char)) continue
    if (isWhitespace(char)) {
      out += ' '
      continue
    }
    out += char.normalize('NFD').replace(/\p{Mn}/gu, '')
  }
  return out
}

/** 词表：token → id（行号即 id）。 */
export type Vocabulary = ReadonlyMap<string, number>

/** 把 `vocab.txt` 的行映射成词表（行号即 id；只忽略文件末尾换行产生的空行）。 */
export function vocabularyFromLines(lines: readonly string[]): Vocabulary {
  const vocab = new Map<string, number>()
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/\r$/, '')
    // 文件以换行结尾时 split 会多出一个空串；它不是词表条目，不能占掉一个 id。
    if (index === lines.length - 1 && line.length === 0) continue
    if (!vocab.has(line)) vocab.set(line, index)
  }
  return vocab
}

export class WordPieceTokenizer {
  readonly #vocab: Vocabulary
  readonly clsId: number
  readonly sepId: number
  readonly unkId: number
  readonly padId: number
  /** 最大序列长度（含 `[CLS]`/`[SEP]`）。 */
  readonly maxLength: number

  private constructor(vocab: Vocabulary, maxLength: number) {
    this.#vocab = vocab
    this.clsId = vocab.get('[CLS]') ?? 101
    this.sepId = vocab.get('[SEP]') ?? 102
    this.unkId = vocab.get('[UNK]') ?? 100
    this.padId = vocab.get('[PAD]') ?? 0
    this.maxLength = maxLength
  }

  /** 从词表装载（`vocabularyFromLines` 已按行号定型）。 */
  static fromVocab(lines: readonly string[], maxLength: number = BERT_MAX_LENGTH): WordPieceTokenizer {
    if (!Number.isInteger(maxLength) || maxLength < 2) {
      throw new RangeError(`maxLength 必须是 ≥2 的整数，实际：${String(maxLength)}`)
    }
    const vocab = vocabularyFromLines(lines)
    if (vocab.size === 0) {
      throw new Error('不是可用的 BERT 词表：文件为空')
    }
    if (!vocab.has('[CLS]') || !vocab.has('[SEP]')) {
      throw new Error('不是可用的 BERT 词表：缺少 [CLS]/[SEP]，请确认 vocab.txt 与权重同源且完整')
    }
    return new WordPieceTokenizer(vocab, maxLength)
  }

  /** 从 `vocab.txt` 装载（CRLF 容错）。 */
  static fromFile(file: string, maxLength: number = BERT_MAX_LENGTH): WordPieceTokenizer {
    return WordPieceTokenizer.fromVocab(readFileSync(file, 'utf8').split('\n'), maxLength)
  }

  get vocabSize(): number {
    return this.#vocab.size
  }

  /** 基础切分：CJK 逐字、标点独立成 token、其余按空白并小写。 */
  #basicTokens(text: string): string[] {
    const out: string[] = []
    let buffer = ''
    const flush = (): void => {
      if (buffer.length > 0) {
        out.push(buffer)
        buffer = ''
      }
    }
    for (const char of text) {
      if (isWhitespace(char)) {
        flush()
        continue
      }
      if (isCjkChar(char) || isPunctuation(char)) {
        flush()
        out.push(char)
        continue
      }
      buffer += char.toLowerCase()
    }
    flush()
    return out
  }

  /** 贪心最长匹配；整词不可分 → `[UNK]`。 */
  #wordPiece(token: string): number[] {
    if (token.length > MAX_INPUT_CHARS_PER_WORD) return [this.unkId]
    const ids: number[] = []
    let start = 0
    while (start < token.length) {
      let end = token.length
      let matched: number | undefined
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + token.slice(start, end)
        const id = this.#vocab.get(piece)
        if (id !== undefined) {
          matched = id
          break
        }
        end--
      }
      if (matched === undefined) return [this.unkId]
      ids.push(matched)
      start = end
    }
    return ids
  }

  /** 文本 → token id（含 `[CLS]`/`[SEP]`；超长按 `maxLength` 截断）。 */
  encode(text: string): number[] {
    const ids: number[] = [this.clsId]
    for (const token of this.#basicTokens(cleanText(text))) {
      for (const id of this.#wordPiece(token)) {
        if (ids.length >= this.maxLength - 1) break
        ids.push(id)
      }
      if (ids.length >= this.maxLength - 1) break
    }
    ids.push(this.sepId)
    return ids
  }
}
