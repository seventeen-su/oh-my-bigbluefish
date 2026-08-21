// OMB v2 e-process 引擎（架构 §10.3 Anytime-valid Certificate——初值公式替换；施工计划 T8.15）。
// 选型记录（实现者选型，brief 授权"自实现最小 e-process"备选）：自实现 Bernoulli 似然比超鞅
// e-process，不引入新依赖（现成库同 jieba 类——新依赖需报告主会话，自实现为认可备选）：
//   e_n = ∏_{i≤n} (p1/p0)^X_i · ((1-p1)/(1-p0))^(1-X_i)，X_i=1 为失败，
//   p0 = 零假设失败率上限（nullFailureRate，缺省取 threshold.max_failure_rate），
//   p1 = 备择失败率（alternativeFailureRate，缺省 0.5）。
// 统计性质（E_P[e_1] = p·(p1/p0) + (1-p)·((1-p1)/(1-p0)) ≤ 1 对 ∀p ≤ p0，因 p1 > p0）→
// e_n 为 H0: 失败率 ≤ p0 下的非负超鞅 → Ville 不等式：P(∃n: e_n ≥ 1/α) ≤ α（anytime-valid，
// 任意停时下 Type I error 受控）→ 拒绝规则 e_n ≥ 1/α（缺省 α=0.05，阈值 20）。
// 与初值公式（n ≥ min_n && failure_rate ≤ max）并存可对照：e-process 小样本更保守（
// 拒绝需证据累积），大样本持续失败快速判定（全失败 n=2 即达阈值——anytime-valid 语义：
// 拒绝不因 min_n 阻塞）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外）+ 同层文件——
// 本模块无任何 import（纯算法 + zod 校验，zod 为已声明依赖经 node_modules 解析）。

// ---- 常量（待标定 §17：α / 备择失败率随冻结基准修正） ----

/** 缺省 anytime-valid 显著性水平（1/α = 拒绝阈值 20） */
export const E_PROCESS_ALPHA = 0.05;

/** 缺省备择失败率 p1（> p0 保证超鞅；固定备择使 e-process 简单可计算） */
export const E_PROCESS_ALTERNATIVE = 0.5;

// ---- 类型 ----

/** e-process 选项（p0/p1/α；缺省：p0 = 判定阈值 max_failure_rate、p1 = 0.5、α = 0.05） */
export interface EProcessOptions {
  /** 零假设失败率上限 p0（0 < p0 < p1 < 1） */
  nullFailureRate?: number;
  /** 备择失败率 p1（0 < p0 < p1 < 1） */
  alternativeFailureRate?: number;
  /** 显著性水平 α（0 < α ≤ 1；拒绝阈值 = 1/α） */
  alpha?: number;
}

/** e-process 判定（与 shadow.ts CanaryVerdict 同字面量并集，结构兼容） */
export type EProcessVerdict = 'promote' | 'hold' | 'rollback';

/** 统计输入（结构最小：shadow.ts 的 Certificate.stat/threshold 派生，避免跨模块循环 import） */
export interface EProcessStatInput {
  n: number;
  failures: number;
  /** 样本不足判定阈值（n < min_n 且未达 e 阈值 → hold） */
  min_n: number;
  /** 失败率上限（缺省 p0 来源） */
  max_failure_rate: number;
}

export interface EProcessResult {
  verdict: EProcessVerdict;
  reason: string;
  /** 当前 e-process 值 */
  e: number;
  /** 拒绝阈值 1/α */
  threshold: number;
}

// ---- 参数解析与校验 ----

/** 解析选项（缺省补全）+ 校验（非法 fail-loud：0 < p0 < p1 < 1、0 < α ≤ 1） */
function resolveOpts(stat: EProcessStatInput, opts: EProcessOptions = {}): Required<EProcessOptions> {
  const p0 = opts.nullFailureRate ?? stat.max_failure_rate;
  const p1 = opts.alternativeFailureRate ?? E_PROCESS_ALTERNATIVE;
  const alpha = opts.alpha ?? E_PROCESS_ALPHA;
  if (!(p0 > 0) || !(p0 < 1)) {
    throw new Error(`e-process: nullFailureRate 非法 ${p0}（应为 0 < p0 < 1）`);
  }
  if (!(p1 > p0) || !(p1 < 1)) {
    throw new Error(`e-process: alternativeFailureRate 非法 ${p1}（应为 p0 < p1 < 1）`);
  }
  if (!(alpha > 0) || !(alpha <= 1)) {
    throw new Error(`e-process: alpha 非法 ${alpha}（应为 0 < α ≤ 1）`);
  }
  return { nullFailureRate: p0, alternativeFailureRate: p1, alpha };
}

/** 统计输入合法性校验（n/failures 非负自洽） */
function checkStat(stat: EProcessStatInput): void {
  if (!Number.isInteger(stat.n) || stat.n < 0 || !Number.isInteger(stat.failures) || stat.failures < 0 || stat.failures > stat.n) {
    throw new Error(`e-process: 统计非法（n=${stat.n}, failures=${stat.failures}）`);
  }
  if (!Number.isInteger(stat.min_n) || stat.min_n < 1 || !(stat.max_failure_rate >= 0) || !(stat.max_failure_rate < 1)) {
    throw new Error(`e-process: 判定阈值非法（min_n=${stat.min_n}, max_failure_rate=${stat.max_failure_rate}）`);
  }
}

// ---- 核心 ----

/**
 * e-process 值：e_n = (p1/p0)^failures · ((1-p1)/(1-p0))^(n-failures)。
 * E_P[e_1] ≤ 1 对 ∀p ≤ p0（p1 > p0）→ 非负超鞅 → Ville 不等式 anytime-valid。
 */
export function eProcessValue(
  stat: { n: number; failures: number },
  opts: { nullFailureRate: number; alternativeFailureRate: number },
): number {
  const { nullFailureRate: p0, alternativeFailureRate: p1 } = opts;
  if (!(p0 > 0) || !(p0 < p1) || !(p1 < 1)) {
    throw new Error(`e-process: 参数非法（p0=${p0}, p1=${p1}，应为 0 < p0 < p1 < 1）`);
  }
  if (!Number.isInteger(stat.n) || stat.n < 0 || !Number.isInteger(stat.failures) || stat.failures < 0 || stat.failures > stat.n) {
    throw new Error(`e-process: 统计非法（n=${stat.n}, failures=${stat.failures}）`);
  }
  const successes = stat.n - stat.failures;
  const e = Math.pow(p1 / p0, stat.failures) * Math.pow((1 - p1) / (1 - p0), successes);
  return Number.isFinite(e) ? e : Number.MAX_VALUE; // 溢出 clamp（超阈值即拒绝，语义不变）
}

/**
 * 连续监测序列：逐试验累积 e 值（e_n = e_{n-1} × 单步因子；失败 ↑、成功 ↓）。
 * 供"连续监测下统计保障"验证（合成序列 → 全程不越阈 / 快速越阈）。
 */
export function eProcessSeries(
  sequence: readonly boolean[],
  opts: EProcessOptions = {},
): number[] {
  const stat: EProcessStatInput = { n: 0, failures: 0, min_n: 1, max_failure_rate: 0.1 };
  const resolved = resolveOpts(stat, opts);
  const out: number[] = [];
  let failures = 0;
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i]) {
      failures++;
    }
    out.push(
      eProcessValue({ n: i + 1, failures }, { nullFailureRate: resolved.nullFailureRate, alternativeFailureRate: resolved.alternativeFailureRate }),
    );
  }
  return out;
}

/**
 * e-process 判定（初值公式的 anytime-valid 替换）：
 *   - rollback：e ≥ 1/α（任意时刻拒绝零假设，不受 min_n 阻塞——anytime-valid 核心）；
 *   - hold：e < 1/α 且 n < min_n（样本不足，未达拒绝阈值也不 promote）；
 *   - promote：其余（n ≥ min_n 且 e 未达阈值——无超额失败证据）。
 */
export function evaluateEProcess(stat: EProcessStatInput, opts: EProcessOptions = {}): EProcessResult {
  checkStat(stat);
  const resolved = resolveOpts(stat, opts);
  const e = eProcessValue(
    { n: stat.n, failures: stat.failures },
    { nullFailureRate: resolved.nullFailureRate, alternativeFailureRate: resolved.alternativeFailureRate },
  );
  const threshold = 1 / resolved.alpha;
  if (e >= threshold) {
    return {
      verdict: 'rollback',
      reason: `e-process 拒绝零假设：e=${e.toFixed(3)} ≥ 1/α=${threshold.toFixed(3)}（anytime-valid：n=${stat.n} 证据累积达标，不受 min_n 阻塞）`,
      e,
      threshold,
    };
  }
  if (stat.n < stat.min_n) {
    return {
      verdict: 'hold',
      reason: `样本不足：n=${stat.n} < min_n=${stat.min_n}（e=${e.toFixed(3)} < 1/α=${threshold.toFixed(3)}，未达拒绝阈值）`,
      e,
      threshold,
    };
  }
  return {
    verdict: 'promote',
    reason: `达标：n=${stat.n} ≥ min_n=${stat.min_n}，e=${e.toFixed(3)} < 1/α=${threshold.toFixed(3)}（无超额失败证据）`,
    e,
    threshold,
  };
}
