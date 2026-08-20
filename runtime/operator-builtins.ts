// OMB v2 内置算子实现（架构 §5.3 七算子签名 + 数据流绑定）。
// layer 2（runtime/）：本文件只对 ./operator.js 做类型层 import（纯类型，运行时无环）；
// OperatorError 与内置算子数据形态随本文件存放（执行器/内置算子/门面共用），
// 由 operator.ts 统一 re-export。
// HYPOTHESIZE 的 LLM 生成留 M5（架构 §5.3 阶梯：Generate 是最后手段）——M4 为纯规则模板派生。
import type { OperatorContext, OperatorFn } from './operator.js';

/** 算子运行期错误（错误契约：code + retryable；retryable=false 阻断重试） */
export class OperatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** DISCRIMINATE 缺省能力 id（EXECUTE 依 plan.experiments[].capability_id 解析 handle） */
export const DEFAULT_CAPABILITY_ID = 'capability:default';

// ---- 内置算子数据形态（§5.3 签名转录） ----

/** RETRIEVE(q,scope,kind,budget)→MemoryPack */
export interface MemoryPack {
  query: string;
  scope: string;
  items: unknown[];
}

/** HYPOTHESIZE(state,n)→Hypothesis[] */
export interface Hypothesis {
  id: string;
  text: string;
  status: 'candidate';
  source: string;
}

/** DISCRIMINATE(h,s,gaps)→ExperimentPlan */
export interface ExperimentPlan {
  experiments: Array<{
    hypothesis_id: string;
    capability_id: string;
    args: unknown;
    /** 预期观测×2（判别实验） */
    expected_observations: [string, string];
  }>;
  gaps: string[];
}

/** EXECUTE(plan)→ToolResult[] */
export interface ToolResult {
  ok: boolean;
  tool: string;
  output: unknown;
  observation_ref?: string;
}

/** OBSERVE(results,plan)→Observation[] */
export interface Observation {
  id: string;
  source: string;
  evidence: unknown;
  ok: boolean;
  observation_ref?: string;
  expected?: [string, string];
}

/** UPDATE(state,obs)→StatePatch */
export interface StatePatch {
  confirmed_facts: string[];
  evidence_gaps: string[];
}

/** STOP(state,reason)→StopReport */
export interface StopReport {
  reason: string;
  summary: Record<string, unknown>;
}

/** ctx.inputs 读取（缺失 → fallback） */
function input<T>(ctx: OperatorContext, name: string, fallback: T): T {
  const v = ctx.inputs[name];
  return v === undefined ? fallback : (v as T);
}

/** HYPOTHESIZE 事实池：confirmed_facts → items(payload) → 兜底（纯规则，无 LLM） */
function factPool(state: unknown): string[] {
  if (state === null || state === undefined) {
    return [];
  }
  if (Array.isArray(state)) {
    return state.map((s) => (typeof s === 'string' ? s : JSON.stringify(s)));
  }
  const obj = state as Record<string, unknown>;
  if (Array.isArray(obj.confirmed_facts)) {
    return obj.confirmed_facts.map(String);
  }
  if (Array.isArray(obj.items)) {
    return obj.items.map((m) => {
      const payload = (m as { payload?: unknown } | null)?.payload;
      return typeof payload === 'string' ? payload : JSON.stringify(m);
    });
  }
  return [JSON.stringify(state)];
}

/** RETRIEVE(q,scope,kind,budget)→MemoryPack：调用注入的记忆检索（M4 测试注入 fake） */
async function runRetrieve(ctx: OperatorContext): Promise<MemoryPack> {
  const q = input<string>(ctx, 'q', '');
  const scope = input<string>(ctx, 'scope', 'Project');
  const kind = input<string | undefined>(ctx, 'kind', undefined);
  const budget = input<number>(ctx, 'budget', ctx.budget);
  if (!ctx.retrieveFn) {
    throw new OperatorError('E_RETRIEVE_NO_FN', 'RETRIEVE: 未注入 retrieveFn（生产由 boot 装配 M3 backend）', false);
  }
  const res = await ctx.retrieveFn({ q, scope, kind, budget, limit: 8 });
  return { query: q, scope, items: res.items };
}

/** HYPOTHESIZE(state,n)→Hypothesis[]：从事实池/矛盾派生 n 个假设模板（纯规则；LLM 留 M5） */
async function runHypothesize(ctx: OperatorContext): Promise<Hypothesis[]> {
  const state = ctx.inputs['state'];
  const n = Math.max(1, Math.min(Math.floor(input<number>(ctx, 'n', 2)), 8));
  const facts = factPool(state);
  const contradictions = (state as { contradictions?: unknown[] } | null)?.contradictions ?? [];
  const out: Hypothesis[] = [];
  for (let i = 0; i < n; i++) {
    const base = facts[i % Math.max(facts.length, 1)] ?? '状态';
    const contra = contradictions[i % Math.max(contradictions.length, 1)];
    out.push({
      id: `hyp-${i + 1}`,
      text:
        contra === undefined
          ? `假设模板 ${i + 1}: 基于 ${base}`
          : `假设模板 ${i + 1}: 基于 ${base}（校验矛盾 ${String(contra)}）`,
      status: 'candidate',
      source: 'rule',
    });
  }
  return out;
}

/** DISCRIMINATE(h,s,gaps)→ExperimentPlan：每假设给判别实验（预期观测×2；capability 取 s.capability_ids） */
async function runDiscriminate(ctx: OperatorContext): Promise<ExperimentPlan> {
  const hRaw = ctx.inputs['h'];
  const s = (ctx.inputs['s'] ?? {}) as Record<string, unknown>;
  const gaps = Array.isArray(ctx.inputs['gaps']) ? (ctx.inputs['gaps'] as unknown[]).map(String) : [];
  const flat = (Array.isArray(hRaw) ? hRaw : [hRaw]).flat(); // 数组绑定 = fan-in 合并（两路假设并集）
  const hyps = flat.filter((h): h is Hypothesis => h !== null && typeof h === 'object');
  const caps =
    Array.isArray(s.capability_ids) && s.capability_ids.length > 0
      ? (s.capability_ids as unknown[]).map(String)
      : [DEFAULT_CAPABILITY_ID];
  return {
    experiments: hyps.map((h, i) => ({
      hypothesis_id: h.id,
      capability_id: caps[i % caps.length] ?? DEFAULT_CAPABILITY_ID,
      args: { hypothesis_id: h.id, text: h.text },
      expected_observations: [`观测A: ${h.text}`, `观测B: ${h.text}`] as [string, string],
    })),
    gaps,
  };
}

/** EXECUTE(plan)→ToolResult[]：经 CapabilityHandle.execute 调用（能力 ABI）；无匹配 handle → 错误契约 */
async function runExecute(ctx: OperatorContext): Promise<ToolResult[]> {
  const plan = ctx.inputs['plan'] as ExperimentPlan | undefined;
  if (!plan || !Array.isArray(plan.experiments)) {
    throw new OperatorError('E_EXECUTE_BAD_PLAN', 'EXECUTE: plan 输入缺失或结构非法', false);
  }
  const results: ToolResult[] = [];
  for (const exp of plan.experiments) {
    const provider = ctx.capabilities?.[exp.capability_id];
    if (!provider) {
      throw new OperatorError('E_NO_CAPABILITY', `EXECUTE: 无匹配 handle: ${exp.capability_id}`, false);
    }
    const handle = await provider.createHandle({ scope: 'session', budget: ctx.budget });
    const res = await handle.execute(exp.args);
    if (!res.ok) {
      throw new OperatorError(res.error?.code ?? 'E_CAPABILITY', res.error?.message ?? 'capability 执行失败', res.error?.retryable ?? false);
    }
    results.push({ ok: true, tool: exp.capability_id, output: res.output, observation_ref: res.observation_ref });
  }
  return results;
}

/** OBSERVE(results,plan)→Observation[]：ToolResult → Observation（绑定 evidence/observation_ref） */
async function runObserve(ctx: OperatorContext): Promise<Observation[]> {
  const results = (Array.isArray(ctx.inputs['results']) ? ctx.inputs['results'] : []) as ToolResult[];
  const plan = (ctx.inputs['plan'] ?? {}) as ExperimentPlan;
  return results.map((r, i) => ({
    id: `obs-${i + 1}`,
    source: r.tool,
    evidence: r.output,
    ok: r.ok,
    observation_ref: r.observation_ref,
    expected: plan.experiments?.[i]?.expected_observations,
  }));
}

/** UPDATE(state,obs)→StatePatch：应用观测（最小：confirmed_facts 增补 evidence 事实，gaps 保留） */
async function runUpdate(ctx: OperatorContext): Promise<StatePatch> {
  const state = (ctx.inputs['state'] ?? {}) as Record<string, unknown>;
  const obs = (Array.isArray(ctx.inputs['obs']) ? ctx.inputs['obs'] : []) as Observation[];
  const confirmed = Array.isArray(state.confirmed_facts) ? (state.confirmed_facts as unknown[]).map(String) : [];
  const gaps = Array.isArray(state.evidence_gaps) ? (state.evidence_gaps as unknown[]).map(String) : [];
  const newFacts = obs.filter((o) => o.ok).map((o) => `evidence:${o.source}`);
  return { confirmed_facts: [...new Set([...confirmed, ...newFacts])], evidence_gaps: gaps };
}

/** STOP(state,reason)→StopReport：reason + 状态摘要 */
async function runStop(ctx: OperatorContext): Promise<StopReport> {
  const state = (ctx.inputs['state'] ?? {}) as Record<string, unknown>;
  const reason = input<string>(ctx, 'reason', 'completed');
  return {
    reason,
    summary: {
      confirmed_facts: Array.isArray(state.confirmed_facts) ? state.confirmed_facts.length : 0,
      gaps: Array.isArray(state.evidence_gaps) ? state.evidence_gaps.length : 0,
    },
  };
}

/** 内置 7 算子注册表（§5.3；执行器按 op.id 解析，registry 覆盖优先） */
export const BUILTIN_OPERATORS: Record<string, OperatorFn> = {
  RETRIEVE: { run: runRetrieve },
  HYPOTHESIZE: { run: runHypothesize },
  DISCRIMINATE: { run: runDiscriminate },
  EXECUTE: { run: runExecute },
  OBSERVE: { run: runObserve },
  UPDATE: { run: runUpdate },
  STOP: { run: runStop },
};
