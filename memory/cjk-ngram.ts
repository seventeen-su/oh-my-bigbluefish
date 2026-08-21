// OMB v2 中文分词（架构 §7.5 存储 FTS5；施工计划 T8.16）。
// 选型记录（实测约束 + 实现者选型）：
//   - 约束：node:sqlite 内置 SQLite 无法注册自定义 FTS5 tokenizer（需编译扩展）→ 双侧分词方案：
//     ingest 时对文本中文分词、空格连接写入 FTS 列；查询时同分词器处理查询串再 MATCH。
//   - 选型：ngram 自实现（bigram，无新依赖）——jieba 类（nodejieba 原生 / jieba-wasm）需新依赖
//     → 用户边界④（新依赖需报告主会话）；ngram 为 brief 认可的备选，先落地并记录实测。
// 分词规则（CJK 统一表意文字 \u3400-\u4dbf + \u4e00-\u9fff）：
//   - CJK 段长度 ≥ 2 → 滑动窗口 bigram（'长期记忆系统' → 长期 期记 记忆 忆系 系统）；
//   - CJK 段长度 = 1 → 单字 token（'系' → 系）；
//   - 非 CJK 段按空白拆单词原样保留（'SQLite FTS5' → SQLite FTS5；'a:b' 冒号粘连保留为单 token）。
// 效果：中文子串命中（'记忆' 命中 '长期记忆系统'）；单字查询（长度≥2 段中的字）不命中（bigram
// 索引限制，文档化）。英文行为与 unicode61 一致。
// layer 2（memory/）：纯函数模块，无 import。
/** CJK 统一表意文字（基本区 + 扩展 A） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 双侧分词：CJK 段 → bigram（单字段 → 单字）；非 CJK 段 → 空白分词单词。
 * 输出空格连接的 token 串（写 FTS 列 / 查询 MATCH 前同用）。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < n && CJK_RE.test(text[j]!)) {
        j++;
      }
      const run = text.slice(i, j);
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          tokens.push(run.slice(k, k + 2));
        }
      }
      i = j;
    } else {
      let j = i;
      while (j < n && !CJK_RE.test(text[j]!)) {
        j++;
      }
      const segment = text.slice(i, j);
      for (const word of segment.split(/\s+/)) {
        if (word.length > 0) {
          tokens.push(word);
        }
      }
      i = j;
    }
  }
  return tokens.join(' ');
}
