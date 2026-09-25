/**
 * CJK / 中英混合分词与 FTS5 MATCH 表达式（**零依赖纯函数**）。
 *
 * 为什么必须存在（实测结论，规划 §8.3）：
 *   `node:sqlite` 内置的 SQLite **不能注册自定义 FTS5 tokenizer**（需编译扩展），
 *   默认 `unicode61` 把连续 CJK 当成**一个 token**，于是 `'记忆'` 无法命中 `'长期记忆系统'`。
 *   因此中英混合语料必须在 **JS 侧双侧分词**：写入时把分词结果空格连接存进 FTS 列，
 *   查询时用同一个分词器处理查询串再 `MATCH`。
 *
 * 分词规则（CJK 统一表意文字 `\u3400-\u4dbf` + `\u4e00-\u9fff`）：
 *   - CJK 连续段长度 ≥ 2 → 二元滑窗（`'长期记忆系统'` → `长期 期记 记忆 忆系 系统`）
 *   - CJK 连续段长度 = 1 → 单字 token（`'系'` → `系`）
 *   - 非 CJK 段 → 按空白切分并**原样保留**（大小写、下划线、`.`/`:`/`-` 等都不动）：
 *     标识符、英文 API 名、错误串必须精确匹配，不能被规范化掉
 *
 * 代价（已知且刻意接受）：单字查询命中不了长度 ≥2 段里的字（bigram 索引的固有限制）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * **接口冻结**：`tokenizeForFts` 与 `ftsMatchExpr` 是本仓库的跨模块契约，
 * 被 `modules/memory/store.ts`（词法通道）与 `modules/memory/retrieve.ts`（查询侧）共同依赖。
 * 签名与语义不得单方面更改——需要改就找 lead 裁决并同步通知消费方。
 * 归属：embed-dev（`tests/modules/embed/text.test.ts`）。
 * ─────────────────────────────────────────────────────────────────────────
 */

/** CJK 统一表意文字：基本区 + 扩展 A。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

/**
 * 把文本切成适合 FTS5 的 token 串（空格分隔），CJK 用二元滑窗。
 *
 * 输入空串 / 纯空白 → 空串（调用方据此跳过 `MATCH`，不要拿空表达式去查）。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    if (isCjk(text.charAt(i))) {
      let j = i
      while (j < n && isCjk(text.charAt(j))) j++
      const run = text.slice(i, j)
      if (run.length === 1) {
        tokens.push(run)
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          tokens.push(run.slice(k, k + 2))
        }
      }
      i = j
    } else {
      let j = i
      while (j < n && !isCjk(text.charAt(j))) j++
      for (const word of text.slice(i, j).split(/\s+/)) {
        if (word.length > 0) tokens.push(word)
      }
      i = j
    }
  }
  return tokens.join(' ')
}

/**
 * 把 token 串转成 FTS5 MATCH 表达式（每个 token 加引号、OR 连接）。
 *
 * 为什么是 **OR 而不是隐式 AND**：CJK 被切成互相重叠的 bigram，AND 会要求全部 bigram 同时命中——
 * 查询「契约边界」在只含「契约」的记忆上会 0 命中，且查询越长越容易漏。OR 把相关度交给 bm25
 * 排序：命中更多 bigram 的记录排得更前，精度由排序保住，召回不再被 AND 掐死。
 *
 * 为什么每个 token 都加引号：①防止 `AND` / `OR` / `NOT` / `NEAR` 等保留字与 `:` `*` `-` `^`
 * 等语法字符把表达式变成语法错误或另一个查询；②引号内整体短语化，语义稳定。
 * 引号按 FTS5 字符串字面量规则用**双写**转义（`"` → `""`）——这是 MATCH 语法注入的唯一入口，
 * 必须转义。
 *
 * 空 token 串 → 空表达式（调用方**不得**以此执行 `MATCH`）。
 */
export function ftsMatchExpr(tokens: string): string {
  const trimmed = tokens.trim()
  if (trimmed.length === 0) return ''
  const parts: string[] = []
  for (const token of trimmed.split(/\s+/)) {
    if (token.length === 0) continue
    parts.push(`"${token.replace(/"/g, '""')}"`)
  }
  return parts.join(' OR ')
}
