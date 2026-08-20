// OMB v2 Process Generator 纯算法模块（T4.2 拆分，CONVENTIONS §9 LOC ≤ 400）。
// 内容：canonical 链/类型键常量、assessApplicability 五分类、Compose/Mutate/编辑距离/检索等纯函数。
// 无 class、顶层无副作用；被 runtime/generator.ts（门面）组合为阶梯，未来 M5 LLM 生成器/优化器可直接复用。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
import {
  APPLICABILITY,
  BUILTIN_OPERATORS,
  type OperatorDef,
  type ProcessDef,
} from '../kernel/policy-loader.js';

/** Process Applicability（架构 §5.1：Strong/Partial/Failed/Contradictory/OOD） */
export type Applicability = (typeof APPLICABILITY)[number];
/** 内置算子名（§5.3 七算子 + 预留 VERIFY；与 T2.1 同一常量） */
type BuiltinOp = (typeof BUILTIN_OPERATORS)[number];

// ---- 常量（初值规则，§17 参数标定项） ----

/** 目标算子序列（§5.3 内置链 archetype；Mutate 的对齐目标） */
export const CANONICAL_CHAIN: readonly BuiltinOp[] = [
  'RETRIEVE',
  'HYPOTHESIZE',
  'DISCRIMINATE',
  'EXECUTE',
  'OBSERVE',
  'UPDATE',
  'STOP',
];

/** 算子输出类型键（§5.3：memory_pack/hypotheses/experiment_plan/tool_results/observations/state_patch/stop_report；VERIFY→verdict） */
export const OUTPUT_TYPES: Record<string, string> = {
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
export const INPUT_TYPES: Record<string, string> = {
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
export const MUTATE_OP_COST = { tokens: 500, time_ms: 2000 };

// ---- 契约类型 ----

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

// ---- 检索 ----

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
export function keywordRetrieve(processes: readonly ProcessDef[], goal: string): ProcessDef[] {
  const keywords = extractKeywords(goal);
  if (keywords.length === 0) {
    return [];
  }
  return processes.filter((p) => keywords.some((k) => processText(p).includes(k)));
}

// ---- 编辑距离 / 差异位 ----

/** 编辑距离（Levenshtein；Mutate 相似度 = 算子序列编辑距离最小） */
export function editDistance(a: readonly string[], b: readonly string[]): number {
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

// ---- Compose ----

/** 首对首尾兼容过程（输出类型 ⊇ 输入类型；i≠j，库序确定性） */
export function findComposePair(processes: readonly ProcessDef[]): readonly [ProcessDef, ProcessDef] | null {
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
export function composeProcesses(a: ProcessDef, b: ProcessDef): ProcessDef {
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

// ---- Mutate ----

/**
 * 变异：最相似过程在首个差异位（非 entry/exit、非目标链外）单算子替换 → 新过程；不可变 → null。
 * 边界守卫：firstDiffIndex 按 max(两序列长) 对齐，短于 canonical 链的进程 diff 位可 ≥ 进程自身长度
 * （如 [RETRIEVE, HYPOTHESIZE] vs 链 → diff at idx 2）——此时无算子可替换，必须返回 null 降级下一阶梯，
 * 否则 map 替换落空、产物与源相同却报 method:'mutate'（no-op bug，T4.2 评审缺陷 2）。
 */
export function mutateProcess(p: ProcessDef): ProcessDef | null {
  const seq = p.operators.map((o) => o.op);
  const idx = firstDiffIndex(seq, CANONICAL_CHAIN);
  // ProcessDef schema：operators[0].op===entry 且末算子===exit → entry/exit 位不可替换；
  // idx >= p.operators.length：diff 位越出进程自身（短链前缀）→ 无替换位 → null
  if (idx < 0 || idx === 0 || idx === p.operators.length - 1 || idx >= p.operators.length || idx >= CANONICAL_CHAIN.length) {
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

// ---- 图预算 ----

/** 图预算（tokens/time_ms 求和；cost 维不计入——与执行器 cost 语义区分） */
export function budgetFor(operators: readonly OperatorDef[]): { tokens: number; time_ms: number } {
  return {
    tokens: operators.reduce((s, o) => s + (o.cost.tokens ?? 0), 0),
    time_ms: operators.reduce((s, o) => s + (o.cost.time_ms ?? 0), 0),
  };
}
