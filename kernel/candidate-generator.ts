// P1d 候选生成器（首个候选源：信号驱动的策略参数微调确定性生成器，无需 LLM）。
// 架构 §6.5.2 候选生成（对象分层 L0 数据高频轻门）/ §6.5.1 触发链（信号 → 候选）。
// 纯函数、零 I/O、零随机、零副作用：同信号摘要同策略 → 同候选集（确定性，测试锚定）。
// 信号→候选映射表（数据即代码，初值；表结构可扩展新信号/新参数）：
//   - corrections / oracle_fail 高频 → evolve.yaml 对应 trigger strength 上调（repair 演化优先化）
//   - untrusted_object 高频 → evolve.yaml untrusted_object strength 上调（信任池污染 → L0 验证优先化）
//   - scope_miss 高频 → context.yaml kind_costs.reacquisition.retrieval 上调（检索泛化缺口 →
//     Context Compiler 更倾向保留检索内容，重获取成本权重上调）
// 步长与上限受 evolve.policy.candidate_gate 约束（数据化，防激进）：
//   - max_candidates_per_run：单次生成上限（= /evolve 验证预算 K）
//   - max_step_ratio：单次调整相对步长上限（strength 绝对步长 / ratio 相对步长均受此封顶）
// 层 DAG（CONVENTIONS §4）：kernel(2) → kernel/schemas(2)（契约层）+ node: 内置 + js-yaml（同层依赖）。
import { createHash } from 'node:crypto';
import { dump as dumpYaml } from 'js-yaml';
import { canonicalJson } from './schemas/base.js';
import type { SignalSummary } from './schemas/evolution.js';
import type { CandidateDraft, CandidateChange } from './schemas/evolution.js';
import type { PolicyBundle } from './policy-loader.js';
import type { CandidateGate } from './schemas/policy.js';

// ---- 信号→候选映射表（数据即代码；targetFile 为 policy 文件名，path 为文件内参数点路径） ----

/** 调整模式：strength = 绝对步长（0..1 域）；ratio = 相对步长（当前值 × (1+步长)） */
export type AdjustmentMode = 'strength' | 'ratio';

export interface PolicyAdjustmentRule {
  /** 触发信号 kind（与 evolve.yaml signal_triggers 键对齐） */
  signal: string;
  /** 目标策略文件（kernel/policy/ 下） */
  targetFile: 'evolve.yaml' | 'context.yaml';
  /** 参数点路径（文件内；如 signal_triggers.corrections.strength） */
  path: string;
  mode: AdjustmentMode;
  /** 基础步长（strength：绝对 0.05；ratio：相对 5%）；实际步长 = min(baseStep×count, max_step_ratio) */
  baseStep: number;
  /** 触发该规则的信号最小计数 */
  minCount: number;
  /** 参数硬上限（strength → 1；ratio 无硬上限，受 max_step_ratio 约束） */
  maxValue?: number;
  /** 调整依据（motivation 模板） */
  motivation: string;
}

/** 信号→策略参数微调规则表（确定性遍历顺序 = 表序；初值待冻结基准标定 §17） */
export const POLICY_ADJUSTMENT_RULES: readonly PolicyAdjustmentRule[] = [
  {
    signal: 'corrections',
    targetFile: 'evolve.yaml',
    path: 'signal_triggers.corrections.strength',
    mode: 'strength',
    baseStep: 0.05,
    minCount: 1,
    maxValue: 1,
    motivation: '修正/失败模式高频 → repair 演化强度上调',
  },
  {
    signal: 'oracle_fail',
    targetFile: 'evolve.yaml',
    path: 'signal_triggers.oracle_fail.strength',
    mode: 'strength',
    baseStep: 0.05,
    minCount: 1,
    maxValue: 1,
    motivation: 'reproduction oracle 复现失败高频 → repair 演化强度上调',
  },
  {
    signal: 'untrusted_object',
    targetFile: 'evolve.yaml',
    path: 'signal_triggers.untrusted_object.strength',
    mode: 'strength',
    baseStep: 0.05,
    minCount: 1,
    maxValue: 1,
    motivation: '信任池污染信号高频 → L0 候选验证强度上调',
  },
  {
    signal: 'scope_miss',
    targetFile: 'context.yaml',
    path: 'kind_costs.reacquisition.retrieval',
    mode: 'ratio',
    baseStep: 0.05,
    minCount: 1,
    motivation: '检索泛化缺口高频 → 检索重获取成本权重上调（Context Compiler 更倾向保留检索内容）',
  },
];

// ---- 内部工具 ----

/** 两位小数舍入（数值比较稳定性；策略参数值域小数） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 深拷贝（zod 数据经 loadPolicy 深冻结——拷贝后才可修改） */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return value;
}

/** 点路径取值（'a.b.c'；中间段非对象/缺失 → undefined） */
function getPathValue(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 点路径赋值（中间段必须为对象——映射表锚定，非法路径 fail-loud） */
function setPathValue(obj: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`candidate-generator: 路径 ${path} 中间段非法（${key} 非对象）`);
    }
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** 步长与调整值：delta = min(baseStep×count, max_step_ratio)；strength 绝对、ratio 相对；无变化 → null */
function adjustedValue(current: number, count: number, rule: PolicyAdjustmentRule, gate: CandidateGate): number | null {
  const raw = Math.min(rule.baseStep * count, gate.max_step_ratio);
  let next: number;
  if (rule.mode === 'strength') {
    next = round2(Math.min(current + raw, rule.maxValue ?? 1));
  } else {
    next = round2(current * (1 + raw));
  }
  return next === round2(current) ? null : next;
}

/** 目标文件 → 策略对象（深拷贝；仅 evolve.yaml/context.yaml 可被本表调整） */
function policyFileObject(policy: PolicyBundle, targetFile: PolicyAdjustmentRule['targetFile']): Record<string, unknown> {
  if (targetFile === 'evolve.yaml') {
    return deepClone(policy.evolve) as unknown as Record<string, unknown>;
  }
  return deepClone(policy.context) as unknown as Record<string, unknown>;
}

/** 数值显示（去尾零；0.9 → '0.9'，1 → '1'） */
function fmt(value: number): string {
  return String(value);
}

// ---- 生成器 ----

/**
 * 信号摘要 + 当前策略 → 策略参数微调候选集（确定性）。
 * 流程：规则表序遍历（表序固定）→ 命中信号（计数 ≥ minCount）→ 参数调整（步长受 candidate_gate
 * 约束）→ 无变化跳过 → 完整 YAML 序列化（js-yaml dump，键序 = schema 序，确定性）→ 内容寻址 id
 * （target+content 的 sha256 前缀；同内容同 id → candidate_id 幂等键）→ 去重 → 排序 → 上限截断。
 * @param signals 信号摘要（窗口 + 按 kind 聚合计数）
 * @param policy 当前策略捆绑（含 evolve.policy.candidate_gate 数据化门禁）
 */
export function generatePolicyAdjustmentCandidates(
  signals: SignalSummary,
  policy: PolicyBundle,
): CandidateDraft[] {
  const gate = policy.evolve.candidate_gate;
  // 命中计数（kind 字典序无关——只取计数）
  const counts = new Map<string, number>();
  for (const kind of Object.keys(signals.counts)) {
    const c = signals.counts[kind];
    if (typeof c === 'number' && c > 0) {
      counts.set(kind, c);
    }
  }

  const drafts: Array<Omit<CandidateDraft, 'id' | 'seq'> & { contentHash: string }> = [];
  for (const rule of POLICY_ADJUSTMENT_RULES) {
    const count = counts.get(rule.signal);
    if (count === undefined || count < rule.minCount) {
      continue;
    }
    const fileObj = policyFileObject(policy, rule.targetFile);
    const current = getPathValue(fileObj, rule.path);
    if (typeof current !== 'number') {
      // 映射表锚定的参数缺失 → fail-loud（策略与表不同步，不静默跳过）
      throw new Error(`candidate-generator: 策略缺少参数 ${rule.path}（映射表与策略不同步）`);
    }
    const next = adjustedValue(current, count, rule, gate);
    if (next === null) {
      continue; // 调整无变化（步长/舍入后同值）→ 不产出噪声候选
    }
    setPathValue(fileObj, rule.path, next);
    const content = dumpYaml(fileObj, { lineWidth: -1, noRefs: true });
    const target = `kernel/policy/${rule.targetFile}`;
    const change: CandidateChange = { path: rule.path, old: current, new: next };
    const motivation = `${rule.signal}×${count} 高频信号 → ${rule.motivation}（${rule.path} ${fmt(current)}→${fmt(next)}，步长受 max_step_ratio=${gate.max_step_ratio} 约束）`;
    const diff = `${rule.targetFile}: ${rule.path} ${fmt(current)} → ${fmt(next)}（${rule.motivation}）`;
    const contentHash = createHash('sha256')
      .update(canonicalJson({ target, content }), 'utf8')
      .digest('hex');
    drafts.push({ contentHash, kind: 'policy', target, content, diff, motivation, signal: rule.signal, change });
  }

  // 去重（同 target+content → 同 contentHash；保留首个）+ 排序（内容哈希升序，确定性）
  const seen = new Set<string>();
  const unique = drafts.filter((d) => {
    if (seen.has(d.contentHash)) {
      return false;
    }
    seen.add(d.contentHash);
    return true;
  });
  unique.sort((a, b) => a.contentHash.localeCompare(b.contentHash));

  // 上限截断（max_candidates_per_run 数据化）
  const capped = unique.slice(0, gate.max_candidates_per_run);

  // id：内容寻址前缀；同前缀碰撞 → 追加 -<seq>（序号 = 组内排序索引；同内容同 id 不受影响）
  const prefixCount = new Map<string, number>();
  for (const d of capped) {
    prefixCount.set(d.contentHash.slice(0, 12), (prefixCount.get(d.contentHash.slice(0, 12)) ?? 0) + 1);
  }
  const prefixSeen = new Map<string, number>();
  return capped.map((d, i) => {
    const prefix = d.contentHash.slice(0, 12);
    const groupSize = prefixCount.get(prefix) ?? 1;
    const idx = prefixSeen.get(prefix) ?? 0;
    prefixSeen.set(prefix, idx + 1);
    const id = groupSize > 1 ? `sha256:${prefix}-${idx}` : `sha256:${prefix}`;
    return { id, seq: i, kind: d.kind, target: d.target, content: d.content, diff: d.diff, motivation: d.motivation, signal: d.signal, change: d.change };
  });
}
