// layer 2（memory/）：归因观测面（已知问题《效用反馈为空》修复判定——「建立可观测的使用反馈面；
// 在此之前保持诚实空缺」）。
//
// 诚实性约束（本次实现的底线）：**绝不伪造命中/未命中**。因此归因只在存在**可观测证据**时给出结论：
//
//   观测面 = 「上一轮注入的记忆，其**独占特征词**是否出现在本轮人类消息中」。
//   - 独占特征词（distinctive tokens）：该记忆 payload 的 CJK bigram / 拉丁词中，**只在本条记忆出现**
//     且非停用词/非通用词者（长度与集合门槛见常量）。取样口径与 FTS 索引一致（memory/cjk-ngram.ts），
//     保证「词法上可被查到的内容」与「可被观测到被引用的内容」是同一套 token；
//   - 证据不足 → **不归因**（返回 skipped 及原因），保持 episode.outcome=null（"已记录待归因"）——
//     例如注入内容无独占特征词（全是通用词）、或本轮没有人类消息可对照；
//   - 结论两侧都写实：命中 → hit（用户确实引用了注入内容）；未命中 → miss（有可对照的人类消息、
//     特征词齐备但未被引用）。miss 是**有证据的否证**，不是"没观察到"。
//
// 与既有链路的关系：结论经 `reportEpisodeOutcome` 回灌六计数器与 utility_score
// （§7.4 Utility Feedback → 价值排序 ④ 的闭环），计数器随即在 `retrieve` 的价值模型里生效。
import type { RetrievalBackend } from './backend-retrieval.js';
import { reportEpisodeOutcome } from './utility.js';

/** 独占特征词最小长度（CJK bigram 恒为 2；拉丁词下限 3——过短的词噪声太大，不作为证据） */
export const DISTINCTIVE_MIN_LATIN_LEN = 3;
/** 拉丁词上限（超长 token 多为 ids/路径，保留但不再放宽） */
export const DISTINCTIVE_MAX_LEN = 32;
/** 特征词数量下限（不足 → 证据不足，不归因；§17 可标定） */
export const DISTINCTIVE_MIN_TOKENS = 2;
/** 归因要求的最小匹配数（至少 1 个独占特征词出现在人类消息里才算"被引用"） */
export const ATTRIBUTION_MIN_MATCHES = 1;
/**
 * 通用词表（不作为证据）：这些词在任何语境都可能出现，出现**不构成**"引用了该记忆"的证据。
 * 只收录确实无区分度的常见词；宁少勿多（漏收只会让"证据不足"更常发生，不会制造假阳性）。
 */
export const ATTRIBUTION_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'not', 'are', 'was', 'you',
  '工具', '结果', '事件', '内容', '记忆', '系统', '数据', '信息', '问题', '情况', '方式', '时间',
  '已经', '可以', '需要', '这个', '那个', '以及', '或者', '但是', '因为', '所以', '如果', '进行',
]);

/** 一次归因的逐条结果 */
export interface AttributionOutcome {
  memory_id: string;
  /** 结论：'hit' 引用命中 / 'miss' 有证据的否证 / 'skipped' 证据不足（不归因） */
  verdict: 'hit' | 'miss' | 'skipped';
  /** 命中的特征词（verdict='hit' 时非空） */
  matched: string[];
  /** 该记忆的独占特征词数量（证据充分性） */
  distinctive_count: number;
  /** 未归因原因（verdict='skipped' 时非空） */
  reason: string | null;
}

export interface AttributionResult {
  /** 已归因（hit/miss）的条数——这些 episode 的 outcome 与六计数器已更新 */
  attributed: number;
  /** 证据不足而未归因的条数（诚实空缺保持） */
  skipped: number;
  outcomes: AttributionOutcome[];
}

/** CJK 统一表意文字（基本区 + 扩展 A；与 memory/cjk-ngram.ts 同口径） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 非 CJK 段的空白分词（拉丁词/数字/代号；与 FTS 同口径） */
const WORD_SPLIT_RE = /\s+/;

/**
 * 证据 token 提取（**与 FTS 索引完全同口径**，见 memory/cjk-ngram.ts）：
 *   - CJK 段 → 滑动窗口 bigram（'候选召回' → 候选/选召/召回）；单字段 → 单字；
 *   - 非 CJK 段 → 空白分词单词。
 * 同口径的意义：可被词法检索到的内容 = 可被观测到"被引用"的内容，两者不会各说一套。
 *
 * **大小写折叠**（第二路审查 H2）：检索侧 FTS5 `unicode61` 分词器默认折叠大小写，而此处此前精确比较
 * → 记忆写 `SQLite FTS5`、人类消息写 `sqlite fts5` 时"检索命中却归因 miss"，miss 权重（−0.03）持续
 * 压低该记忆 utility，排序系统性劣化。故在 token 出口统一 `toLowerCase()`（两侧同源，集合比较等价于
 * FTS 的大小写不敏感语义）。CJK token 不受影响。
 */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < text.length && CJK_RE.test(text[j]!)) j++;
      const run = text.slice(i, j);
      if (run.length === 1) {
        out.push(run);
      } else {
        for (let k = 0; k + 1 < run.length; k++) out.push(run.slice(k, k + 2));
      }
      i = j;
    } else {
      let j = i;
      while (j < text.length && !CJK_RE.test(text[j]!)) j++;
      for (const w of text.slice(i, j).split(WORD_SPLIT_RE)) {
        if (w.length > 0) out.push(w.toLowerCase());
      }
      i = j;
    }
  }
  return out;
}

/** CJK bigram 判定（证据单位） */
function isCjkBigram(token: string): boolean {
  return token.length === 2 && CJK_RE.test(token[0]!) && CJK_RE.test(token[1]!);
}

/** 是否为可用作证据的 token（CJK bigram 或足够长的拉丁词；过滤停用词） */
function isDistinctiveToken(token: string): boolean {
  if (ATTRIBUTION_STOPWORDS.has(token)) return false;
  if (token.length > DISTINCTIVE_MAX_LEN) return false;
  if (isCjkBigram(token)) return true;
  if (CJK_RE.test(token)) return false; // 非 bigram 的 CJK token（单字）不作为证据
  return token.length >= DISTINCTIVE_MIN_LATIN_LEN;
}

/**
 * 计算某条记忆的**独占特征词**：只在该条 payload 出现（不出现在同批其它记忆）且通过证据门槛的 token。
 * 独占过滤的作用：同一批注入里普遍出现的词（如共同主题词）无法区分"引用了哪一条"，不作为证据。
 * 确定性：同输入 → 同输出（集合按字典序返回）。
 */
export function distinctiveTokens(target: string, others: readonly string[]): string[] {
  const mine = new Set(tokensOf(target).filter((t) => isDistinctiveToken(t)));
  if (mine.size === 0) return [];
  const othersTokens = new Set<string>();
  for (const other of others) {
    for (const t of tokensOf(other)) {
      othersTokens.add(t);
    }
  }
  return [...mine].filter((t) => !othersTokens.has(t)).sort();
}

/**
 * 归因一次注入（episode 维度）：对 episode 的 injected_ids 逐条判断"是否被引用"，
 * 命中/否证经 `reportEpisodeOutcome` 回灌。
 *
 * @param humanText 用于对照的人类消息文本（引用观测窗口）；缺省/空 → 全条 skipped（无对照面）
 * @param opts.skip_ids 应跳过的 id（调用方已归因过的记忆——避免同一记忆被重复计数把 utility 灌水）
 * @param opts.max 最多归因条数（缺省全部）
 */
export async function attributeEpisode(
  backend: RetrievalBackend,
  episodeId: string,
  humanText: string,
  opts: { max?: number; skip_ids?: ReadonlySet<string> } = {},
): Promise<AttributionResult> {
  const ep = await backend.getEpisode(episodeId);
  if (ep === undefined) {
    throw new Error(`attributeEpisode: episode 不存在: ${episodeId}`);
  }
  const skip = opts.skip_ids ?? new Set<string>();
  const injected = ep.injected_ids.filter((id) => !skip.has(id)).slice(0, opts.max ?? ep.injected_ids.length);
  if (injected.length === 0) {
    return { attributed: 0, skipped: 0, outcomes: [] };
  }
  const payloads = new Map<string, string>();
  for (const id of injected) {
    const m = await backend.getById(id);
    if (m !== undefined) payloads.set(id, m.payload);
  }
  const haystack = tokensOf(humanText);
  const haystackSet = new Set(haystack);
  const outcomes: AttributionOutcome[] = [];
  let attributed = 0;
  let skipped = 0;
  let anyHit = false;
  /** 本轮真正得到结论（hit/miss）的记忆 id——只把这些交给回灌面（绝不含 skipped/被排除者） */
  const decidedIds: string[] = [];
  for (const id of injected) {
    const payload = payloads.get(id);
    if (payload === undefined) {
      outcomes.push({ memory_id: id, verdict: 'skipped', matched: [], distinctive_count: 0, reason: '记忆已不存在（无法核验）' });
      skipped++;
      continue;
    }
    const others = [...payloads.entries()].filter(([other]) => other !== id).map(([, p]) => p);
    const distinctive = distinctiveTokens(payload, others);
    if (distinctive.length < DISTINCTIVE_MIN_TOKENS) {
      outcomes.push({
        memory_id: id,
        verdict: 'skipped',
        matched: [],
        distinctive_count: distinctive.length,
        reason: `独占特征词不足（${distinctive.length} < ${DISTINCTIVE_MIN_TOKENS}）——证据不足，不归因`,
      });
      skipped++;
      continue;
    }
    if (haystack.length === 0) {
      outcomes.push({
        memory_id: id,
        verdict: 'skipped',
        matched: [],
        distinctive_count: distinctive.length,
        reason: '无人类消息可对照（本轮无 user 消息）——保持待归因',
      });
      skipped++;
      continue;
    }
    const matched = distinctive.filter((t) => haystackSet.has(t));
    const verdict: 'hit' | 'miss' = matched.length >= ATTRIBUTION_MIN_MATCHES ? 'hit' : 'miss';
    if (verdict === 'hit') anyHit = true;
    // 证据强度标注（审查修复 C-M9）：同批只有这一条记忆时 others 为空 → "独占"未经对照，任一共通技术词
    // 都算证据。这不改变判定（命中仍需人类消息里出现该条记忆的字面 token），但必须在观测面标明强度，
    // 避免把弱证据读成强证据。
    const isolated = others.length === 0;
    outcomes.push({
      memory_id: id,
      verdict,
      matched,
      distinctive_count: distinctive.length,
      reason: isolated ? '单候选（同批无对照记忆）——独占性未经对照，证据强度较低' : null,
    });
    decidedIds.push(id);
    attributed++;
  }
  // episode 级 outcome 汇总（任一命中 → hit；否则有证据的否证 → miss）；
  // 全部 skipped（证据不足）→ **不写 outcome**（保持 null，诚实空缺），也不动六计数器。
  // 回灌只针对本轮判定的记忆（decidedIds）——skipped（证据不足）与被 skip_ids 排除者绝不计数，
  // 否则会伪造 hit/miss 并重复计数（审查修复：诚实性底线）。
  if (attributed > 0 && ep.outcome === null) {
    await reportEpisodeOutcome(backend, episodeId, anyHit ? 'hit' : 'miss', { ids: decidedIds });
  }
  return { attributed, skipped, outcomes };
}
