// layer 2：能力向量三维真实化采集器（架构 §10.1 三层信号 / §9.2 Verification Synthesis / §9.3 信任池；
// 施工计划 T8.21——generalization/interpretability/contamination_risk 由 L3 占位（blinded_judge）
// 改为真实采集路径，信号 kind 为 L1 计数对，聚合/事实由 evolution-evaluator.evaluate 承担）。
//
// 采集器（每维独立事实来源）：
// - collectGeneralizationSignals：检索 episode 归因统计（跨 scope 命中率）——真实来源 =
//   retrieval_episode 表（§7.4 recordEpisode/reportEpisodeOutcome 归因数据），产出 L1 scope_hit/scope_miss
//   （专项 D：null-outcome「已记录待归因」单独计为 scope_recorded——检索数据量照常入信号）；
// - collectInterpretabilitySignals：reproduction oracle 可复现性——真实来源 = T8.14
//   runReproductionOracle 执行产物（OracleVerdict，independent anchor + 沙箱复现 + adversarial validation），
//   产出 L1 oracle_pass/oracle_fail；
// - collectContaminationSignals：信任池来源审计——真实来源 = T5.1 CandidatePool
//   （.evolution trusted/untrusted/rejected 盘上记录，counts()），产出 L1 trusted_object/untrusted_object
//   （untrusted_object = untrusted + rejected：污染风险 = 非 trusted 比例，越低越好）。
// 采集器零副作用（只读；interpretability 为纯函数）；缺数据 → 空信号数组（evaluate 不出事实）。
// layer 2（runtime/）：import 目标层 ≤ 2（supervisor(1)/memory(2) 放行，CONVENTIONS §4）。
import type { RetrievalBackend } from '../memory/backend-retrieval.js';
import type { CandidatePool } from '../supervisor/candidates.js';
import type { OracleVerdict } from '../supervisor/oracle.js';
import type { EvaluationSignal, L1Signal } from './evaluator.js';

/** L1 信号时间窗（观察窗；episode 采集按 created 过滤） */
export interface SignalWindow {
  from: number;
  to: number;
}

/** L1 计数信号构造（count ≤ 0 不产出——零计数不产生信号，避免噪声） */
function countSignal(
  kind: L1Signal['kind'],
  target: string,
  count: number,
  window: SignalWindow,
): EvaluationSignal | null {
  if (count <= 0) {
    return null;
  }
  return { layer: 'L1', kind, target, count, window };
}

/**
 * generalization 采集（跨 scope 检索命中率）：全部 retrieval_episode 行 → created ∈ window 的 episode
 * 分 hit/miss 计数 → L1 scope_hit/scope_miss（target = 被评估对象）。
 * 专项 D（评审问题一）：outcome 为 null 的 episode（已记录待归因——采样记录后归因观测面未到）单独计为
 * L1 scope_recorded——检索数据量照常入信号，且**不当作 hit 也不当作 miss**（诚实分离：归因观测面留待，
 * evaluate 的 generalization 比率只认 scope_hit/scope_miss，待归因不稀释分母）。
 */
export async function collectGeneralizationSignals(
  backend: RetrievalBackend,
  target: string,
  window: SignalWindow,
): Promise<EvaluationSignal[]> {
  const episodes = await backend.listEpisodes();
  let hit = 0;
  let miss = 0;
  let pending = 0;
  for (const ep of episodes) {
    if (ep.created < window.from || ep.created > window.to) {
      continue;
    }
    if (ep.outcome === null) {
      pending++; // 已记录待归因（outcome 未归因——不伪造 hit/miss）
      continue;
    }
    if (ep.outcome === 'hit') {
      hit++;
    } else if (ep.outcome === 'miss') {
      miss++;
    }
  }
  const out: EvaluationSignal[] = [];
  const s1 = countSignal('scope_hit', target, hit, window);
  const s2 = countSignal('scope_miss', target, miss, window);
  const s3 = countSignal('scope_recorded', target, pending, window);
  if (s1 !== null) out.push(s1);
  if (s2 !== null) out.push(s2);
  if (s3 !== null) out.push(s3);
  return out;
}

/** interpretability 采集（oracle 可复现率）：T8.14 OracleVerdict 执行产物 → L1 oracle_pass/oracle_fail（纯函数） */
export function collectInterpretabilitySignals(
  verdicts: readonly OracleVerdict[],
  target: string,
  window: SignalWindow,
): EvaluationSignal[] {
  const pass = verdicts.filter((v) => v.ok).length;
  const fail = verdicts.length - pass;
  const out: EvaluationSignal[] = [];
  const s1 = countSignal('oracle_pass', target, pass, window);
  const s2 = countSignal('oracle_fail', target, fail, window);
  if (s1 !== null) out.push(s1);
  if (s2 !== null) out.push(s2);
  return out;
}

/** contamination_risk 采集（信任池来源审计）：CandidatePool 计数 → L1 trusted_object/untrusted_object
 * （untrusted_object = untrusted + rejected：污染风险 = 非 trusted 比例）。 */
export async function collectContaminationSignals(
  pool: CandidatePool,
  target: string,
  window: SignalWindow,
): Promise<EvaluationSignal[]> {
  const c = await pool.counts();
  const trusted = c.trusted;
  const untrusted = c.untrusted + c.rejected;
  const out: EvaluationSignal[] = [];
  const s1 = countSignal('trusted_object', target, trusted, window);
  const s2 = countSignal('untrusted_object', target, untrusted, window);
  if (s1 !== null) out.push(s1);
  if (s2 !== null) out.push(s2);
  return out;
}
