// OMB v2 Process Generator 阶梯（架构 §5.3：Reuse → Compose → Mutate → Generate）。
// 防 token 黑洞：LLM 生成是最后手段；Compose/Mutate 为 M4 规则版（M5 接 LLM/优化）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
// 模块约定：顶层无副作用；纯函数优先；预算每步检查；产物必须过 ProcessDef schema + 算子名 ∈ 内置集合。
import {
  APPLICABILITY,
  BUILTIN_OPERATORS,
  ProcessDefSchema,
  type OperatorDef,
  type ProcessDef,
} from '../kernel/policy-loader.js';

// ---- 值域（类型从 T2.1 policy-loader 派生，防漂移） ----

/** Process Applicability（架构 §5.1：Strong/Partial/Failed/Contradictory/OOD） */
export type Applicability = (typeof APPLICABILITY)[number];
/** 内置算子名（§5.3 七算子 + 预留 VERIFY；与 T2.1 同一常量） */
type BuiltinOp = (typeof BUILTIN_OPERATORS)[number];

// ---- 常量（初值规则，§17 参数标定项） ----

/** 目标算子序列（§5.3 内置链 archetype；Mutate 的对齐目标） */
const CANONICAL_CHAIN: readonly BuiltinOp[] = [
  'RETRIEVE',
  'HYPOTHESIZE',
  'DISCRIMINATE',
  'EXECUTE',
  'OBSERVE',
  'UPDATE',
  'STOP',
];

/** 算子输出类型键（§5.3：memory_pack/hypotheses/experiment_plan/tool_results/observations/state_patch/stop_report；VERIFY→verdict） */
const OUTPUT_TYPES: Record<string, string> = {
  RETRIEVE: 'memory_pack',
  HYPOTHESIZE: 'hypotheses',
  DISCRIMINATE: 'experiment_plan',
  EXECUTE: 'tool_results',
  OBSERVE: 'observations',
  UPDATE: 'state_patch',
  STOP: 'stop_report',
  VERIFY: 'verdict',
};

/** 算子主输入类型键（Compose 兼容判定：输出类型 ⊇ 输入类型——原子键等值即兼容；RETRIEVE 无上游输入） */
const INPUT_TYPES: Record<string, string> = {
  HYPOTHESIZE: 'memory_pack',
  DISCRIMINATE: 'hypotheses',
  EXECUTE: 'experiment_plan',
  OBSERVE: 'tool_results',
  UPDATE: 'observations',
  STOP: 'state_patch',
  VERIFY: 'memory_pack',
};

/** assessApplicability 关键词覆盖阈值（初值 0.8/0.4，架构 §17 参数标定项，冻结基准产出后修正） */
const STRONG_THRESHOLD = 0.8;
const PARTIAL_THRESHOLD = 0.4;

/** 变异单算子成本（M4 规则版模板值） */
const MUTATE_OP_COST = { tokens: 500, time_ms: 2000 };

// ---- 类型（brief §实现设计 转录） ----

/** S3 WorkingState 最小视图（架构 §4.2；generator 仅消费 contradictions 等字段） */
export interface WorkingState {
  goal?: string;
  confirmed_facts?: string[];
  active_hypotheses?: string[];
  contradictions?: string[];
  open_questions?: string[];
  evidence_gaps?: string[];
  next_best_action?: string;
  environment?: string;
}

/** retrieveProcess 检索查询 */
export interface GeneratorQuery {
  goal: string;
  state?: WorkingState;
}

/** generate 任务（Governor 传入：goal + 工作状态 + applicability 判定） */
export interface GeneratorTask {
  goal: string;
  state: WorkingState;
  applicability: Applicability;
}

/** 生成方法（阶梯命中/未命中） */
export type GenerationMethod = 'reuse' | 'compose' | 'mutate' | 'generate' | 'none';

/** generate 返回：process 为空当且仅当 method=none */
export interface GenerateResult {
  process: ProcessDef | null;
  method: GenerationMethod;
  reason: string;
}

export interface GeneratorOptions {
  processes: readonly ProcessDef[];
  budget: number;
  retrieveProcess?: (q: GeneratorQuery) => readonly ProcessDef[];
  /** M4 不注入（记录：LLM 生成器 M5 或后续接入） */
  llmGenerate?: (task: GeneratorTask) => Promise<ProcessDef>;
}

// ---- 产物校验（ProcessDef schema + 算子名 ∈ 内置集合；非法 → 拒绝走下一阶梯） ----

export function validateProcess(p: unknown): p is ProcessDef {
  if (p === null || typeof p !== 'object') {
    return false;
  }
  const result = ProcessDefSchema.safeParse(p);
  if (!result.success) {
    return false;
  }
  return result.data.operators.every((o) => BUILTIN_OPERATORS.includes(o.op));
}

/** 图 cost 总和（与 T4.1 执行器一致：cost.cost ?? cost.tokens ?? 0） */
export function processCost(p: ProcessDef): number {
  return p.operators.reduce((s, o) => s + (o.cost.cost ?? o.cost.tokens ?? 0), 0);
}

// ---- assessApplicability（供 Governor；初值规则标注待标定 §17） ----

/**
 * 五分类判定（架构 §5.1；初值规则，§17 待标定）：
 * 1) 与已知约束矛盾：task.state.contradictions 非空且过程无判别/观测能力 → Contradictory
 * 2) 算子需求不满足：task.requires 有过程缺失的算子 → Failed
 * 3) goal 关键词覆盖 ≥0.8 → Strong；≥0.4 → Partial
 * 4) 其余（检索无匹配/覆盖不足）→ OOD
 */
export function assessApplicability(
  process: ProcessDef,
  task: { goal: string; state?: WorkingState; requires?: string[] },
): Applicability {
  const contradictions = task.state?.contradictions;
  const hasDiscriminating = process.operators.some((o) => o.op === 'DISCRIMINATE' || o.op === 'OBSERVE');
  if (contradictions !== undefined && contradictions.length > 0 && !hasDiscriminating) {
    return 'Contradictory';
  }
  const ops = new Set<string>(process.operators.map((o) => o.op));
  const requires = task.requires ?? [];
  if (requires.some((r) => !ops.has(r))) {
    return 'Failed';
  }
  const keywords = extractKeywords(task.goal);
  if (keywords.length === 0) {
    return 'OOD';
  }
  const text = processText(process);
  const matched = keywords.filter((k) => text.includes(k)).length;
  const coverage = matched / keywords.length;
  if (coverage >= STRONG_THRESHOLD) {
    return 'Strong';
  }
  if (coverage >= PARTIAL_THRESHOLD) {
    return 'Partial';
  }
  return 'OOD';
}

// ---- ProcessGenerator（阶梯） ----

export class ProcessGenerator {
  private readonly processes: readonly ProcessDef[];
  private readonly budget: number;
  private readonly retrieveProcess: ((q: GeneratorQuery) => readonly ProcessDef[]) | undefined;
  private readonly llmGenerate: ((task: GeneratorTask) => Promise<ProcessDef>) | undefined;

  constructor(opts: GeneratorOptions) {
    this.processes = opts.processes;
    this.budget = opts.budget;
    this.retrieveProcess = opts.retrieveProcess;
    this.llmGenerate = opts.llmGenerate;
  }

  /**
   * 阶梯入口：预算预检 → Reuse → （仅 OOD）→ Compose → Mutate → Generate。
   * 已知过程（applicability=Strong/Partial）直接复用，绝不进入生成路径（本任务核心验收）。
   */
  async generate(task: GeneratorTask): Promise<GenerateResult> {
    // 预算预检：预算 < 库中最小过程图成本 → 任何阶梯产物都不可负担
    const minCost = this.minLibraryCost();
    if (minCost !== null && this.budget < minCost) {
      return {
        process: null,
        method: 'none',
        reason: `budget: 预算 ${this.budget} 小于最小过程图成本 ${minCost}，无法生成任何过程`,
      };
    }

    // ① Reuse：检索（注入或默认关键词）→ 已知过程（Strong/Partial）直接复用
    const reused = this.tryReuse(task);
    if (reused) {
      return reused;
    }

    // 仅 OOD 触发生成（架构 §5.1：仅 OOD + 预期收益低触发 Generator；M4 预期收益项未接入，记录）
    if (task.applicability !== 'OOD') {
      return {
        process: null,
        method: 'none',
        reason: `none: applicability=${task.applicability} 不触发过程生成（仅 OOD 触发 Generator）`,
      };
    }

    // ② Compose → ③ Mutate（规则版；产物校验失败降级并记录）
    let validationFail = false;
    const composed = this.tryCompose();
    if (composed !== null) {
      if ('invalid' in composed) {
        validationFail = true;
      } else {
        return composed.result;
      }
    }
    const mutated = this.tryMutate();
    if (mutated !== null) {
      if ('invalid' in mutated) {
        validationFail = true;
      } else {
        return mutated.result;
      }
    }

    // ④ Generate（LLM 最后手段；M4 默认不注入）
    if (this.llmGenerate) {
      try {
        const p = await this.llmGenerate(task);
        if (validateProcess(p)) {
          return { process: p, method: 'generate', reason: 'generate: LLM 生成（最后手段，全部规则阶梯失败后）' };
        }
        return { process: null, method: 'none', reason: 'validation: LLM 生成产物未通过 ProcessDef schema 校验' };
      } catch (e) {
        return {
          process: null,
          method: 'none',
          reason: `none: LLM 生成器执行失败: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    return {
      process: null,
      method: 'none',
      reason: validationFail
        ? 'validation: 组合/变异产物未通过 ProcessDef schema 校验，已降级，最终无可用过程'
        : 'none: 无 LLM 生成器（M4 未注入 llmGenerate——LLM 生成 M5 或后续接入）',
    };
  }

  // ---- 阶梯步骤 ----

  /** Reuse：检索候选 → 首个 assessApplicability ∈ {Strong, Partial} 的合法过程直接复用 */
  private tryReuse(task: GeneratorTask): GenerateResult | null {
    const q: GeneratorQuery = { goal: task.goal, state: task.state };
    const candidates = this.retrieveProcess ? this.retrieveProcess(q) : keywordRetrieve(this.processes, task.goal);
    const pool = candidates.length > 0 ? candidates : this.processes; // 检索空 → 全库兜底
    for (const p of pool) {
      const a = assessApplicability(p, task);
      if (a !== 'Strong' && a !== 'Partial') {
        continue;
      }
      if (!validateProcess(p)) {
        continue; // 防御：非法过程不复用 → 降级下一候选
      }
      if (processCost(p) > this.budget) {
        return { process: null, method: 'none', reason: `budget: 已知过程 ${p.id} 成本超预算` };
      }
      return { process: p, method: 'reuse', reason: `reuse: 已知过程 ${p.id} applicability=${a} 直接复用` };
    }
    return null;
  }

  /** Compose（规则版）：库中首对首尾兼容过程组合；产物非法 → {invalid} 降级；超预算 → none/budget */
  private tryCompose(): StepResult {
    const pair = findComposePair(this.processes);
    if (!pair) {
      return null;
    }
    const [a, b] = pair;
    const product = composeProcesses(a, b);
    if (!validateProcess(product)) {
      return { invalid: true };
    }
    if (processCost(product) > this.budget) {
      return { result: { process: null, method: 'none', reason: `budget: 组合产物 ${product.id} 成本超预算` } };
    }
    return {
      result: {
        process: product,
        method: 'compose',
        reason: `compose: ${a.id}+${b.id} 首尾兼容（${OUTPUT_TYPES[a.exit]} ⊇ ${INPUT_TYPES[b.entry]}）组合成功`,
      },
    };
  }

  /** Mutate（规则版）：最相似过程（编辑距离最小）单算子替换；产物非法 → {invalid} 降级；超预算 → none/budget */
  private tryMutate(): StepResult {
    if (this.processes.length === 0) {
      return null;
    }
    let best: ProcessDef | null = null;
    let bestDist = Infinity;
    for (const p of this.processes) {
      const d = editDistance(p.operators.map((o) => o.op), CANONICAL_CHAIN);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (best === null) {
      return null;
    }
    const product = mutateProcess(best);
    if (product === null) {
      return null; // 无可变异位（差异只在 entry/exit 或超出目标链）→ 降级
    }
    if (!validateProcess(product)) {
      return { invalid: true };
    }
    if (processCost(product) > this.budget) {
      return { result: { process: null, method: 'none', reason: `budget: 变异产物 ${product.id} 成本超预算` } };
    }
    return {
      result: {
        process: product,
        method: 'mutate',
        reason: `mutate: 最相似过程 ${best.id} 单算子替换（序列变化 ≤1）`,
      },
    };
  }

  private minLibraryCost(): number | null {
    if (this.processes.length === 0) {
      return null;
    }
    return Math.min(...this.processes.map((p) => processCost(p)));
  }
}

// ---- 内部辅助 ----

/** 阶梯步骤结果：{result} 命中（直接返回）；{invalid} 产物校验失败（降级并记录）；null 无可做（继续下一步） */
type StepResult = { result: GenerateResult } | { invalid: true } | null;

/** 目标关键词提取（初值：按分隔符切词、长度 ≥2；§17 待标定） */
function extractKeywords(goal: string): string[] {
  return goal
    .split(/[\s,，。.!！?？;；:：、'"“”‘’()（）[\]{}<>《》]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** 过程文本（关键词覆盖匹配面：id + entry/exit + 每算子 op/output/verification） */
function processText(p: ProcessDef): string {
  return [p.id, p.entry, p.exit, ...p.operators.map((o) => `${o.op} ${o.output} ${o.verification}`)].join(' ');
}

/** 默认检索：goal 关键词任一命中过程文本即返回（初值；生产可注入 retrieveProcess 覆盖） */
function keywordRetrieve(processes: readonly ProcessDef[], goal: string): ProcessDef[] {
  const keywords = extractKeywords(goal);
  if (keywords.length === 0) {
    return [];
  }
  return processes.filter((p) => keywords.some((k) => processText(p).includes(k)));
}

/** 编辑距离（Levenshtein；Mutate 相似度 = 算子序列编辑距离最小） */
function editDistance(a: readonly string[], b: readonly string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

/** 首个差异位（按对齐位置；越界视为差异；全同 → -1） */
function firstDiffIndex(seq: readonly string[], target: readonly string[]): number {
  const len = Math.max(seq.length, target.length);
  for (let i = 0; i < len; i++) {
    if (seq[i] !== target[i]) {
      return i;
    }
  }
  return -1;
}

/** 首对首尾兼容过程（输出类型 ⊇ 输入类型；i≠j，库序确定性） */
function findComposePair(processes: readonly ProcessDef[]): readonly [ProcessDef, ProcessDef] | null {
  for (let i = 0; i < processes.length; i++) {
    for (let j = 0; j < processes.length; j++) {
      if (i === j) {
        continue;
      }
      const a = processes[i]!;
      const b = processes[j]!;
      const outA = OUTPUT_TYPES[a.exit];
      const inB = INPUT_TYPES[b.entry];
      if (outA !== undefined && outA === inB) {
        return [a, b];
      }
    }
  }
  return null;
}

/** 组合：a 算子图 + b 算子图（id 冲突则 b 侧加前缀）；entry=a.entry，exit=b.exit */
function composeProcesses(a: ProcessDef, b: ProcessDef): ProcessDef {
  const collide = a.operators.some((oa) => b.operators.some((ob) => ob.id === oa.id));
  const bOps = collide ? b.operators.map((o) => ({ ...o, id: `b-${o.id}` })) : b.operators;
  const operators = [...a.operators, ...bOps];
  return {
    id: `composed-${a.id}-${b.id}`,
    version: '1.0.0',
    entry: a.entry,
    exit: b.exit,
    budget: budgetFor(operators),
    operators,
  };
}

/** 变异：最相似过程在首个差异位（非 entry/exit、非目标链外）单算子替换 → 新过程；不可变 → null */
function mutateProcess(p: ProcessDef): ProcessDef | null {
  const seq = p.operators.map((o) => o.op);
  const idx = firstDiffIndex(seq, CANONICAL_CHAIN);
  // ProcessDef schema：operators[0].op===entry 且末算子===exit → entry/exit 位不可替换
  if (idx < 0 || idx === 0 || idx === p.operators.length - 1 || idx >= CANONICAL_CHAIN.length) {
    return null;
  }
  const targetOp = CANONICAL_CHAIN[idx]!;
  const replacement: OperatorDef = {
    id: `mut-${idx}`,
    op: targetOp,
    input_binding: {},
    output: OUTPUT_TYPES[targetOp] ?? 'output',
    cost: MUTATE_OP_COST,
    verification: '规则变异算子（T4.2 Mutate 单算子替换）',
    error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' },
  };
  const operators = p.operators.map((o, i) => (i === idx ? replacement : o));
  return {
    id: `mutated-${p.id}`,
    version: '1.0.0',
    entry: p.entry,
    exit: p.exit,
    budget: budgetFor(operators),
    operators,
  };
}

/** 图预算（tokens/time_ms 求和；cost 维不计入——与执行器 cost 语义区分） */
function budgetFor(operators: readonly OperatorDef[]): { tokens: number; time_ms: number } {
  return {
    tokens: operators.reduce((s, o) => s + (o.cost.tokens ?? 0), 0),
    time_ms: operators.reduce((s, o) => s + (o.cost.time_ms ?? 0), 0),
  };
}
