// OMB v2 演化评估器（架构 §9.4 晋升 / §10.1 能力向量 / P5 三层信号评估；施工计划 T5.5）：layer 2。
//
// 数据结构（T2.6）在 runtime/evaluator.ts；本模块实现其演化评估语义：
// - evaluate(evidence, target, opts)：按 §10.1 九维逐维聚合信号为维度事实（每维独立事实，无总裁判）。
//   信号 → 维度映射（brief 已定 + 实现选择，标注待标定项）：
//     correctness      L2 bench_score（统计优先）或 L1 tool_success/(success+failure)
//     cost             L2 token_cost；缺省回退 L2 latency
//     robustness       L1 不稳定率：1 − (retry+correction)/(success+failure+retry+correction)
//     generalization   L1 scope_hit/(scope_hit+scope_miss)（T8.21：跨 scope 检索 episode 命中率，
//                      来源 retrieval_episode 表归因——采集器 runtime/signal-collectors.ts）
//     interpretability L1 oracle_pass/(oracle_pass+oracle_fail)（T8.21：reproduction oracle 可复现率，
//                      来源 T8.14 oracle 执行产物）
//     regression       L2 regression_delta（越高越好：正 delta = 无回归/改善）
//     transferability  L1 memory_hit/(hit+miss)（schema 无 scope 字段——用命中率近似跨 scope 覆盖，待标定）
//     maintenance_cost L2 latency 代理（无专用 L2 kind；与 cost 共用底层信号但为独立事实，待标定）
//     contamination_risk L1 untrusted/(trusted+untrusted)（T8.21：信任池来源审计，来源 T5.1 CandidatePool
//                      trusted/untrusted+rejected 计数；越低越好——谱系守卫仍由激活层承担，见 supervisor/activation.ts）
//   缺信号维 → 不出事实（getFact 返回 null = value null 语义）。
// - evaluate 产出未对照基线的向量（classification='Unknown' 占位）；classify(v, baseline) 产出正式分类。
// - classify：规则化，无魔法数字——阈值在 EVOLUTION_THRESHOLDS 常量表（§17 待标定：冻结基准集产出后校准）。
//   判定优先级：Regressed → Unknown → Cheaper-but-weaker → More-robust → Better-in-domain → Stable → Candidate。
//   方向表：cost/maintenance_cost/contamination_risk 越低越好，其余维度越高越好。
// layer 2（runtime/）：仅 import 同层 runtime/ 与 kernel/schemas/（CONVENTIONS §4）；纯函数，无 I/O。
import {
  CAPABILITY_DIMENSIONS,
  CapabilityVectorSchema,
  makeVectorId,
  type CapabilityDimension,
  type CapabilityVector,
  type Classification,
  type DimensionFact,
  type EvaluationSignal,
  type L1Signal,
  type L2Signal,
  type SignalSource,
} from './evaluator.js';
import type { Fingerprint } from '../kernel/schemas/base.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';

// ---- 常量（§17 待标定：冻结基准集产出后校准；机制即数据——改数据不改代码） ----

export const EVOLUTION_THRESHOLDS = {
  /** 样本不足阈值：所有维样本量均低于此值 → Unknown（§10.1 样本不足 → Unknown → 延后/降级） */
  MIN_SAMPLES: 5,
  /** cheaper-but-weaker：correctness 相对基线允许的下探幅度（容差带） */
  WEAKER_TOLERANCE: 0.05,
} as const;

/**
 * 默认环境指纹（§4.4；R6：dsh_version 经 hostVersion() 读取唯一宿主版本来源——运行时求值，
 * 装配注入后 = 注入值；缺省 = DSH_HOST_VERSION。函数而非常量：模块加载早于装配注入，
 * 常量会在注入前固化默认值造成漂移）。
 */
export function defaultEnvironment(): Fingerprint {
  return {
    os: process.platform,
    node: process.version,
    dsh_version: hostVersion(),
    project: 'omb-v2',
  };
}

/** 越低越好的维度（成本/维护成本/污染风险）；其余维度越高越好（§10.1） */
const LOWER_IS_BETTER: ReadonlySet<CapabilityDimension> = new Set([
  'cost',
  'maintenance_cost',
  'contamination_risk',
]);

// ---- 信号聚合工具 ----

/** 单维聚合结果（值 + 样本量 + 信号源 + 证据引用 + 区间） */
interface Aggregated {
  value: number;
  sample: number;
  sources: SignalSource[];
  refs: string[];
  interval?: { low: number; high: number };
}

/** L1 计数求和（某 kind 全窗口累计） */
function sumCounts(signals: readonly L1Signal[], kind: L1Signal['kind']): number {
  return signals.filter((s) => s.kind === kind).reduce((acc, s) => acc + s.count, 0);
}

/** L2 样本加权均值（多信号合成；区间不确定性保留给调用方） */
function weightedMean(items: ReadonlyArray<{ value: number; sample: number }>): { value: number; sample: number } {
  const total = items.reduce((acc, x) => acc + x.sample, 0);
  if (total === 0) {
    return { value: 0, sample: 0 };
  }
  const sum = items.reduce((acc, x) => acc + x.value * x.sample, 0);
  return { value: sum / total, sample: total };
}

/** 首个带区间的信号区间（L2 统计不确定性表达，不伪装无参数） */
function firstInterval(
  items: ReadonlyArray<{ confidence_interval?: { low: number; high: number } }>,
): { low: number; high: number } | undefined {
  for (const item of items) {
    if (item.confidence_interval !== undefined) {
      return item.confidence_interval;
    }
  }
  return undefined;
}

/** L1 计数对比例（T8.21 三维真实采集：pos/(pos+neg)；无计数 → null——缺数据不出事实） */
function l1Ratio(
  signals: readonly EvaluationSignal[],
  pos: L1Signal['kind'],
  neg: L1Signal['kind'],
): Aggregated | null {
  const l1 = signals.filter((s): s is L1Signal => s.layer === 'L1');
  const p = sumCounts(l1, pos);
  const n = sumCounts(l1, neg);
  const total = p + n;
  if (total === 0) {
    return null;
  }
  return { value: p / total, sample: total, sources: ['L1_mechanical'], refs: [] };
}

/** 逐维信号聚合：无任何可用信号 → null（缺信号维不出事实） */
function aggregate(dim: CapabilityDimension, signals: readonly EvaluationSignal[]): Aggregated | null {
  switch (dim) {
    case 'correctness': {
      const l1 = signals.filter((s): s is L1Signal => s.layer === 'L1');
      const bench = signals.filter((s): s is L2Signal => s.layer === 'L2' && s.kind === 'bench_score');
      const ok = sumCounts(l1, 'tool_success');
      const fail = sumCounts(l1, 'tool_failure');
      const sources: SignalSource[] = [];
      if (ok + fail > 0) {
        sources.push('L1_mechanical');
      }
      if (bench.length > 0) {
        const w = weightedMean(bench.map((s) => ({ value: s.value, sample: s.sample_size })));
        sources.push('L2_statistical');
        return {
          value: w.value,
          sample: w.sample,
          sources,
          refs: bench.map((s) => s.bench_ref),
          interval: firstInterval(bench),
        };
      }
      const total = ok + fail;
      if (total === 0) {
        return null;
      }
      return { value: ok / total, sample: total, sources, refs: [] };
    }
    case 'cost': {
      const tok = signals.filter((s): s is L2Signal => s.layer === 'L2' && s.kind === 'token_cost');
      if (tok.length > 0) {
        const w = weightedMean(tok.map((s) => ({ value: s.value, sample: s.sample_size })));
        return {
          value: w.value,
          sample: w.sample,
          sources: ['L2_statistical'],
          refs: tok.map((s) => s.bench_ref),
          interval: firstInterval(tok),
        };
      }
      const lat = signals.filter((s): s is L2Signal => s.layer === 'L2' && s.kind === 'latency');
      if (lat.length > 0) {
        const w = weightedMean(lat.map((s) => ({ value: s.value, sample: s.sample_size })));
        return {
          value: w.value,
          sample: w.sample,
          sources: ['L2_statistical'],
          refs: lat.map((s) => s.bench_ref),
          interval: firstInterval(lat),
        };
      }
      return null;
    }
    case 'robustness': {
      // 缺 retry/correction 信号 → 缺信号维（不把 tool_success/failure 误当鲁棒性证据——每维独立事实）
      const l1 = signals.filter((s): s is L1Signal => s.layer === 'L1');
      const retry = sumCounts(l1, 'retry');
      const corr = sumCounts(l1, 'correction');
      if (retry + corr === 0) {
        return null;
      }
      const ok = sumCounts(l1, 'tool_success');
      const fail = sumCounts(l1, 'tool_failure');
      const total = ok + fail + retry + corr;
      return { value: 1 - (retry + corr) / total, sample: total, sources: ['L1_mechanical'], refs: [] };
    }
    case 'generalization':
      // T8.21：跨 scope 检索 episode 命中率（scope_hit/(scope_hit+scope_miss)，真实采集）
      return l1Ratio(signals, 'scope_hit', 'scope_miss');
    case 'interpretability':
      // T8.21：reproduction oracle 可复现率（oracle_pass/(oracle_pass+oracle_fail)，T8.14 执行产物）
      return l1Ratio(signals, 'oracle_pass', 'oracle_fail');
    case 'contamination_risk':
      // T8.21：信任池污染风险 = untrusted/(trusted+untrusted)（T5.1 来源审计；值越高风险越大——越低越好维）
      return l1Ratio(signals, 'untrusted_object', 'trusted_object');
    case 'regression': {
      const deltas = signals.filter((s): s is L2Signal => s.layer === 'L2' && s.kind === 'regression_delta');
      if (deltas.length === 0) {
        return null;
      }
      const w = weightedMean(deltas.map((s) => ({ value: s.value, sample: s.sample_size })));
      return {
        value: w.value,
        sample: w.sample,
        sources: ['L2_statistical'],
        refs: deltas.map((s) => s.bench_ref),
        interval: firstInterval(deltas),
      };
    }
    case 'transferability': {
      const l1 = signals.filter((s): s is L1Signal => s.layer === 'L1');
      const hit = sumCounts(l1, 'memory_hit');
      const miss = sumCounts(l1, 'memory_miss');
      const total = hit + miss;
      if (total === 0) {
        return null;
      }
      return { value: hit / total, sample: total, sources: ['L1_mechanical'], refs: [] };
    }
    case 'maintenance_cost': {
      const lat = signals.filter((s): s is L2Signal => s.layer === 'L2' && s.kind === 'latency');
      if (lat.length === 0) {
        return null;
      }
      const w = weightedMean(lat.map((s) => ({ value: s.value, sample: s.sample_size })));
      return {
        value: w.value,
        sample: w.sample,
        sources: ['L2_statistical'],
        refs: lat.map((s) => s.bench_ref),
        interval: firstInterval(lat),
      };
    }
  }
}

// ---- 查询 ----

/** 按维度取事实（缺信号维 → null = value null 语义） */
export function getFact(v: CapabilityVector, dim: CapabilityDimension): DimensionFact | null {
  return v.facts.find((f) => f.dimension === dim) ?? null;
}

/** 维度事实值（无事实 → null） */
function factValue(v: CapabilityVector, dim: CapabilityDimension): number | null {
  return getFact(v, dim)?.value ?? null;
}

/** 达标判定（方向表：越低越好维度用 ≤，其余用 ≥） */
function meetsOrBeats(v: number, baseline: number, dim: CapabilityDimension): boolean {
  return LOWER_IS_BETTER.has(dim) ? v <= baseline : v >= baseline;
}

// ---- 评估 ----

/**
 * 能力向量评估：按目标过滤信号 → 九维逐维聚合（每维独立事实，无总裁判）。
 * 产出向量的 classification 为 'Unknown' 占位（未对照基线）；正式分类由 classify() 产出。
 */
export function evaluate(
  evidence: readonly EvaluationSignal[],
  target: string,
  opts?: { environment?: Fingerprint },
): CapabilityVector {
  const signals = evidence.filter((s) => s.target === target);
  const facts: DimensionFact[] = [];
  for (const dim of CAPABILITY_DIMENSIONS) {
    const agg = aggregate(dim, signals);
    if (agg === null) {
      continue; // 缺信号维 → 不出事实（getFact 返回 null）
    }
    const fact: DimensionFact = {
      dimension: dim,
      value: agg.value,
      signal_sources: agg.sources,
      evidence_refs: agg.refs,
      sample_size: agg.sample,
    };
    if (agg.interval !== undefined) {
      fact.confidence_interval = agg.interval;
    }
    facts.push(fact);
  }
  const vector: CapabilityVector = {
    id: makeVectorId(),
    target,
    facts,
    classification: 'Unknown',
    classification_confidence: 0,
    environment: opts?.environment ?? defaultEnvironment(),
    created: Date.now(),
    provenance: { source: 'evolution-evaluator', events: [...new Set(facts.flatMap((f) => f.evidence_refs))] },
  };
  return CapabilityVectorSchema.parse(vector);
}

// ---- 分类（规则化，阈值进 EVOLUTION_THRESHOLDS，无魔法数字） ----

/**
 * 结果分类（§10.1 七分类）。判定优先级：
 *   Regressed（regression 维 < 基线）→ Unknown（样本不足）→ Cheaper-but-weaker（cost 优 + correctness 略低容差内）
 *   → More-robust（robustness 优）→ Better-in-domain（correctness 优）→ Stable（基线各维均达标）
 *   → Candidate（部分维 null / 未达标）。
 */
export function classify(v: CapabilityVector, baseline: CapabilityVector): Classification {
  const vReg = factValue(v, 'regression');
  const bReg = factValue(baseline, 'regression');
  if (vReg !== null && bReg !== null && vReg < bReg) {
    return 'Regressed';
  }
  const samples = v.facts.map((f) => f.sample_size);
  if (v.facts.length === 0 || Math.max(...samples) < EVOLUTION_THRESHOLDS.MIN_SAMPLES) {
    return 'Unknown';
  }
  const vCost = factValue(v, 'cost');
  const bCost = factValue(baseline, 'cost');
  const vCorr = factValue(v, 'correctness');
  const bCorr = factValue(baseline, 'correctness');
  if (
    vCost !== null &&
    bCost !== null &&
    vCost < bCost &&
    vCorr !== null &&
    bCorr !== null &&
    vCorr < bCorr &&
    bCorr - vCorr <= EVOLUTION_THRESHOLDS.WEAKER_TOLERANCE
  ) {
    return 'Cheaper-but-weaker';
  }
  const vRob = factValue(v, 'robustness');
  const bRob = factValue(baseline, 'robustness');
  if (vRob !== null && bRob !== null && vRob > bRob) {
    return 'More-robust';
  }
  if (vCorr !== null && bCorr !== null && vCorr > bCorr) {
    return 'Better-in-domain';
  }
  let stable = v.facts.length > 0;
  for (const bf of baseline.facts) {
    if (bf.value === null) {
      continue;
    }
    const vVal = factValue(v, bf.dimension);
    if (vVal === null || !meetsOrBeats(vVal, bf.value, bf.dimension)) {
      stable = false;
      break;
    }
  }
  if (stable) {
    return 'Stable';
  }
  return 'Candidate';
}
