// OMB v2 记忆效用反馈（架构 §7.4 Utility Feedback / Retrieval Episode / 统一价值模型 的 utility 分量）：
// 六计数器（retrieval/hit/miss/inject/decay/promote，M1 utility_counts 六字段）→ utility_score 派生
// （初值公式：加权计数，权重常量表待标定 §17）；bumpUtility 更新 M1 utility_counts（权威存储）并同步
// memory_stats（retrievals/hits/misses 三列——T3.1 表无 inject/decay/promote 列，此三计数器仅存
// utility_counts，记录在案）；Retrieval Episode 记录（T3.1 retrieval_episode 表，§7.4 归因与
// ranking 学习输入）与 reportEpisodeOutcome（outcome 更新 + 六计数器反馈更新入口；反事实抽样由
// Governor 调度，M5 接）。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { makeMutableId } from '../kernel/schemas/base.js';
import type { RetrievalBackend, EpisodeRow } from './backend-retrieval.js';

// ---- 六计数器（§7.4：六计数器 → utility_score；M1 utility_counts 六字段） ----

/** 六计数器枚举（bumpUtility counter 参数；M1 utility_counts 六字段键） */
export const UTILITY_COUNTERS = ['retrieval', 'hit', 'miss', 'inject', 'decay', 'promote'] as const;
export type UtilityCounter = (typeof UTILITY_COUNTERS)[number];

/** 六计数器 → utility_score 初值权重（待标定 §17；hit/promote 正、miss/decay 负、retrieval/inject 弱正） */
export const UTILITY_COUNTER_WEIGHTS: Record<UtilityCounter, number> = {
  retrieval: 0.02,
  hit: 0.05,
  miss: -0.03,
  inject: 0.04,
  decay: -0.02,
  promote: 0.06,
};

/** utility_score 派生（初值公式）：Σ 权重×计数，clamp [0,1]，4 位小数 */
export function deriveUtilityScore(counts: Record<string, number>): number {
  let s = 0;
  for (const c of UTILITY_COUNTERS) {
    s += UTILITY_COUNTER_WEIGHTS[c] * (counts[c] ?? 0);
  }
  return Math.round(Math.min(1, Math.max(0, s)) * 10_000) / 10_000;
}

/** bumpUtility：计数器 +1（M1 utility_counts 六字段权威存储）→ memory_stats 对应列同步
 *  （retrieval→retrievals、hit→hits、miss→misses + last_retrieved；inject/decay/promote 无列）。
 *  非法 counter / 未知 id → fail-loud。 */
export async function bumpUtility(backend: RetrievalBackend, id: string, counter: UtilityCounter): Promise<void> {
  if (!UTILITY_COUNTERS.includes(counter)) {
    throw new Error(`bumpUtility: 非法 counter: ${String(counter)}`);
  }
  const mem = await backend.getById(id);
  if (!mem) {
    throw new Error(`bumpUtility: 记忆不存在: ${id}`);
  }
  const counts = { ...mem.utility_counts };
  counts[counter] = (counts[counter] ?? 0) + 1;
  await backend.update(id, { utility_counts: counts });
  const statsCounter =
    counter === 'retrieval' ? 'retrievals' : counter === 'hit' ? 'hits' : counter === 'miss' ? 'misses' : null;
  if (statsCounter !== null) {
    await backend.bumpStats(id, statsCounter);
  }
}

// ---- Retrieval Episode（§7.4：query/candidate set/rank/context pack/injected/outcome/action） ----

/** Retrieval Episode（T3.1 retrieval_episode 表行形态；outcome 初始 null，事后由 reportEpisodeOutcome 归因） */
export type RetrievalEpisode = EpisodeRow;

/** recordEpisode：记录一次检索（candidate_ids = rank 前初始候选、ranked_ids = rank 后全序、
 *  injected_ids = 最终注入、outcome 占位 null）；返回 episode（含 id）。 */
export async function recordEpisode(
  backend: RetrievalBackend,
  ep: Omit<EpisodeRow, 'id' | 'outcome' | 'created'> & { created?: number },
): Promise<RetrievalEpisode> {
  const row: EpisodeRow = {
    id: makeMutableId('episode'),
    outcome: null,
    created: ep.created ?? Date.now(),
    query: ep.query,
    scope: ep.scope,
    candidate_ids: ep.candidate_ids,
    ranked_ids: ep.ranked_ids,
    injected_ids: ep.injected_ids,
  };
  await backend.insertEpisode(row);
  return row;
}

/** reportEpisodeOutcome：更新 episode outcome（'hit' | 'miss'）并对 injected 记忆做六计数器反馈
 *  （retrieval + inject + hit|miss——§7.4 归因与 ranking 学习入口；utility_score 随计数派生变化）。
 *  未知 episode / 非法 outcome → fail-loud。 */
export async function reportEpisodeOutcome(
  backend: RetrievalBackend,
  episodeId: string,
  outcome: 'hit' | 'miss',
): Promise<void> {
  if (outcome !== 'hit' && outcome !== 'miss') {
    throw new Error(`reportEpisodeOutcome: 非法 outcome: ${String(outcome)}`);
  }
  const ep = await backend.getEpisode(episodeId);
  if (!ep) {
    throw new Error(`reportEpisodeOutcome: episode 不存在: ${episodeId}`);
  }
  await backend.updateEpisodeOutcome(episodeId, outcome);
  for (const id of ep.injected_ids) {
    await bumpUtility(backend, id, 'retrieval');
    await bumpUtility(backend, id, 'inject');
    await bumpUtility(backend, id, outcome);
  }
}
