// OMB v2 记忆效用反馈（架构 §7.4 Utility Feedback / Retrieval Episode / 统一价值模型 的 utility 分量）：
// 六计数器（retrieval/hit/miss/inject/decay/promote；记忆级 utility_counts 正式键，T3.4 定型）→ utility_score 派生
// （初值公式：加权计数，权重常量表待标定 §17）；bumpUtility 更新 M1 utility_counts（权威存储）并同步
// memory_stats（retrievals/hits/misses 三列——T3.1 表无 inject/decay/promote 列，此三计数器仅存
// utility_counts，记录在案）；Retrieval Episode 记录（T3.1 retrieval_episode 表，§7.4 归因与
// ranking 学习输入）与 reportEpisodeOutcome（outcome 更新 + 六计数器反馈更新入口）。
// T8.17 反事实抽样接线（Governor 调度）：utility 不确定性高（outcome 证据少）→ 反事实抽样——
// 构造反事实 Retrieval Episode 对比（实际注入集 vs 未注入备选集，outcome 经注入的 estimator 估计）
// → posterior 更新（cf_hit/cf_miss 计数 → derivePosteriorUtilityScore 权重变化）。触发门为纯函数
// （shouldSampleCounterfactual，Governor 可先判再调）；maybeSampleCounterfactual 为门+抽样一体入口。
// layer 2（memory/）：仅 node: 内置 + kernel/schemas/（同层契约）+ memory/ 内文件。
import { makeMutableId } from '../kernel/schemas/base.js';
import type { RetrievalBackend, EpisodeRow } from './backend-retrieval.js';

// ---- 六计数器（§7.4：六计数器 → utility_score；记忆级 utility_counts 正式键，T3.4 定型） ----

/** 六计数器枚举（bumpUtility counter 参数；记忆级 utility_counts 正式键，T3.4 定型） */
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

/** bumpUtility：计数器 +1（记忆级 utility_counts 正式键权威存储，T3.4 定型）→ memory_stats 对应列同步
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

// ---- 反事实抽样（T8.17：Governor 调度——utility 不确定性高 → 反事实 episode 对比 → posterior 更新） ----

/** 不确定性饱和常量（outcome 证据达此值 → 不确定性 0；待标定 §17） */
export const CF_SATURATION = 10;
/** 触发阈值缺省（不确定性 > 阈值 → 抽样；待标定 §17） */
export const CF_DEFAULT_THRESHOLD = 0.5;
/** posterior 调整权重（cf_hit/cf_miss 对 posterior 分的贡献；待标定 §17） */
export const CF_WEIGHT = 0.02;
/** 反事实备选集大小缺省（ranked 中未注入的前 K 个） */
export const CF_ALTERNATIVE_COUNT = 2;

/** 反事实计数键（utility_counts 保留键；不参与六计数器派生，仅 posterior 用） */
export const CF_COUNTERS = ['cf_hit', 'cf_miss'] as const;
export type CfCounter = (typeof CF_COUNTERS)[number];

/**
 * utility 不确定性（§7.4 效用估计的证据充分性代理）：outcome 证据（hit+miss）越少 → 不确定性越高。
 * uncertainty = clamp01(1 - evidence / saturation)，4 位小数；无证据 → 1（最高不确定）。
 */
export function utilityUncertainty(counts: Record<string, number>, saturation: number = CF_SATURATION): number {
  if (!Number.isFinite(saturation) || saturation <= 0) {
    throw new Error(`utilityUncertainty: saturation 必须为正数（got ${saturation}）`);
  }
  const evidence = (counts.hit ?? 0) + (counts.miss ?? 0);
  return Math.round(Math.min(1, Math.max(0, 1 - evidence / saturation)) * 10_000) / 10_000;
}

/**
 * 触发条件（纯函数，Governor 先判再调）：utility 不确定性 > 阈值 → 反事实抽样。
 * 边界（不确定性 == 阈值）不触发（严格 >）。
 */
export function shouldSampleCounterfactual(
  counts: Record<string, number>,
  opts: { threshold?: number; saturation?: number } = {},
): boolean {
  const threshold = opts.threshold ?? CF_DEFAULT_THRESHOLD;
  if (!(threshold >= 0) || !(threshold <= 1)) {
    throw new Error(`shouldSampleCounterfactual: threshold 非法 ${threshold}（应为 [0,1]）`);
  }
  return utilityUncertainty(counts, opts.saturation) > threshold;
}

/** posterior utility_score（T8.17）：基础加权分 + cf 调整（cf_hit − cf_miss）× CF_WEIGHT，clamp [0,1] */
export function derivePosteriorUtilityScore(counts: Record<string, number>): number {
  const base = deriveUtilityScore(counts);
  const adj = CF_WEIGHT * ((counts.cf_hit ?? 0) - (counts.cf_miss ?? 0));
  return Math.round(Math.min(1, Math.max(0, base + adj)) * 10_000) / 10_000;
}

/** 反事实更新记录（posterior 更新的可审计条目） */
export interface CounterfactualUpdate {
  memory_id: string;
  counter: CfCounter;
  delta: number;
}

/** 抽样结果（sampled=false 时 counterfactual_episode_id=null、updates=[]） */
export interface CounterfactualSampleResult {
  sampled: boolean;
  reason: string;
  counterfactual_episode_id: string | null;
  updates: CounterfactualUpdate[];
}

/** outcome 估计器（生产：verifier/LLM 估计"若注入备选集是否会命中"；测试：确定性注入） */
export type OutcomeEstimator = (episodeId: string, injectedIds: string[]) => Promise<'hit' | 'miss'>;

export interface CounterfactualOptions {
  episode_id: string;
  outcome_estimator: OutcomeEstimator;
  alternative_count?: number;
  threshold?: number;
  saturation?: number;
}

/** cf 计数器 +1（utility_counts 保留键；未知 id fail-loud） */
async function bumpCf(backend: RetrievalBackend, id: string, counter: CfCounter): Promise<void> {
  const mem = await backend.getById(id);
  if (!mem) {
    throw new Error(`sampleCounterfactual: 记忆不存在: ${id}`);
  }
  const counts = { ...mem.utility_counts };
  counts[counter] = (counts[counter] ?? 0) + 1;
  await backend.update(id, { utility_counts: counts });
}

/** 聚合 used 记忆的 outcome 证据（反事实触发门输入） */
async function aggregateOutcomeEvidence(backend: RetrievalBackend, ids: string[]): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  for (const id of ids) {
    const mem = await backend.getById(id);
    if (!mem) {
      throw new Error(`sampleCounterfactual: 记忆不存在: ${id}`);
    }
    for (const key of ['hit', 'miss'] as const) {
      total[key] = (total[key] ?? 0) + (mem.utility_counts[key] ?? 0);
    }
  }
  return total;
}

/**
 * 反事实抽样（Governor 调度点实现）：真实 episode 已归因（outcome 非 null）且 utility 不确定性超阈值 →
 * 构造反事实 episode（injected = ranked 中未注入备选集，outcome = estimator 估计）→ 对比 posterior 更新：
 *   - 实际 miss 且反事实 hit → used 记 cf_miss（降权）、alt 记 cf_hit（提权）——miss 可能源于排序而非记忆本身；
 *   - 实际 hit 且反事实 miss → used 记 cf_hit（强化）、alt 记 cf_miss。
 * 门未过 / outcome 未归因 / 无备选 → sampled=false（不抽样，无副作用）。
 */
export async function sampleCounterfactual(
  backend: RetrievalBackend,
  opts: CounterfactualOptions,
): Promise<CounterfactualSampleResult> {
  if (typeof opts.outcome_estimator !== 'function') {
    throw new Error('sampleCounterfactual: outcome_estimator 必须为函数');
  }
  const ep = await backend.getEpisode(opts.episode_id);
  if (!ep) {
    throw new Error(`sampleCounterfactual: episode 不存在: ${opts.episode_id}`);
  }
  if (ep.outcome === null) {
    return { sampled: false, reason: 'episode outcome 未归因（先 reportEpisodeOutcome 再抽样）', counterfactual_episode_id: null, updates: [] };
  }
  const used = ep.injected_ids;
  const alternativeCount = opts.alternative_count ?? CF_ALTERNATIVE_COUNT;
  const alternatives = ep.ranked_ids.filter((id) => !used.includes(id)).slice(0, alternativeCount);
  if (alternatives.length === 0) {
    return { sampled: false, reason: '无未注入备选（ranked 全为 injected）——无可对比的反事实', counterfactual_episode_id: null, updates: [] };
  }

  // 触发门：used 记忆 outcome 证据聚合 → 不确定性 > 阈值
  const evidence = await aggregateOutcomeEvidence(backend, used);
  if (!shouldSampleCounterfactual(evidence, { threshold: opts.threshold, saturation: opts.saturation })) {
    return { sampled: false, reason: 'utility 不确定性未超阈值（outcome 证据充分，不抽样）', counterfactual_episode_id: null, updates: [] };
  }

  // 反事实 outcome 估计（非法返回 fail-loud）
  const estimated = await opts.outcome_estimator(opts.episode_id, alternatives);
  if (estimated !== 'hit' && estimated !== 'miss') {
    throw new Error(`sampleCounterfactual: outcome_estimator 返回非法 outcome: ${String(estimated)}`);
  }

  // 反事实 episode 记录（可回溯：query 标注 [counterfactual]）
  const cfRow: EpisodeRow = {
    id: makeMutableId('episode'),
    query: `${ep.query} [counterfactual]`,
    scope: ep.scope,
    candidate_ids: alternatives,
    ranked_ids: alternatives,
    injected_ids: alternatives,
    outcome: estimated,
    created: Date.now(),
  };
  await backend.insertEpisode(cfRow);

  // posterior 对比更新（实际 outcome vs 反事实估计）
  const updates: CounterfactualUpdate[] = [];
  const actual = ep.outcome as 'hit' | 'miss';
  if (actual === 'miss' && estimated === 'hit') {
    for (const id of used) {
      await bumpCf(backend, id, 'cf_miss');
      updates.push({ memory_id: id, counter: 'cf_miss', delta: 1 });
    }
    for (const id of alternatives) {
      await bumpCf(backend, id, 'cf_hit');
      updates.push({ memory_id: id, counter: 'cf_hit', delta: 1 });
    }
  } else if (actual === 'hit' && estimated === 'miss') {
    for (const id of used) {
      await bumpCf(backend, id, 'cf_hit');
      updates.push({ memory_id: id, counter: 'cf_hit', delta: 1 });
    }
    for (const id of alternatives) {
      await bumpCf(backend, id, 'cf_miss');
      updates.push({ memory_id: id, counter: 'cf_miss', delta: 1 });
    }
  }

  return {
    sampled: true,
    reason: `反事实抽样完成：实际=${actual} vs 反事实(备选)=${estimated}，${updates.length} 条 posterior 更新`,
    counterfactual_episode_id: cfRow.id,
    updates,
  };
}

/** Governor 调度入口（门 + 抽样一体）：shouldSampleCounterfactual 语义内置于 sampleCounterfactual */
export async function maybeSampleCounterfactual(
  backend: RetrievalBackend,
  opts: CounterfactualOptions,
): Promise<CounterfactualSampleResult> {
  return sampleCounterfactual(backend, opts);
}
