// OMB v2 Process Generator 阶梯（架构 §5.3：Reuse → Compose → Mutate → Generate）。
// 防 token 黑洞：LLM 生成是最后手段；Compose/Mutate 为 M4 规则版（M5 接 LLM/优化）。
// 门面模块：ProcessGenerator 阶梯类 + 产物校验 + 阶梯契约类型；纯算法（assessApplicability/Compose/
// Mutate/编辑距离/检索）在 ./generator-ops.ts（CONVENTIONS §9 LOC ≤ 400 拆分，仿 T4.1 operator 拆分模式）。
// 对外 API 不变：runtime/generator.* 为统一出口，re-export generator-ops 全部公开符号，调用方无感。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
import { BUILTIN_OPERATORS, ProcessDefSchema, type ProcessDef } from '../kernel/policy-loader.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { GenerationBudget } from '../kernel/schemas/policy.js';
import {
  CANONICAL_CHAIN,
  INPUT_TYPES,
  OUTPUT_TYPES,
  assessApplicability,
  composeProcesses,
  editDistance,
  findComposePair,
  keywordRetrieve,
  mutateProcess,
  type Applicability,
  type WorkingState,
} from './generator-ops.js';

// ---- 门面 re-export（统一出口：runtime/generator.*） ----

export {
  CANONICAL_CHAIN,
  INPUT_TYPES,
  MUTATE_OP_COST,
  OUTPUT_TYPES,
  assessApplicability,
  budgetFor,
  composeProcesses,
  editDistance,
  findComposePair,
  keywordRetrieve,
  mutateProcess,
  type Applicability,
  type WorkingState,
} from './generator-ops.js';

// ---- 契约类型（brief §实现设计 转录） ----

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
  /** M4 不注入（记录：LLM 生成器 M5 或后续接入）；与 modelAdapter 并存时本注入优先（显式产物生产者） */
  llmGenerate?: (task: GeneratorTask) => Promise<ProcessDef>;
  /** T8.12：ModelAdapter（DSH 模型调用适配器，契约 kernel/schemas/model-adapter.ts）——注入时
   *  generator 构造 HYPOTHESIZE 提示 → 模型生成候选 → 产物解析 → ProcessDef schema + 预算守卫
   *  （与 llmGenerate 同守卫路径）；无真实 DSH 会话 → 不注入（缺省受限，纯规则阶梯）。 */
  modelAdapter?: ModelAdapter;
  /** P5：generation 预算（触发条件②，budget.yaml budget.generation 数据化产物）——未启用/超单请求上限 →
   *  LLM 路径整体拒绝（纯规则降级并记录）；缺省未配置 → 无约束（兼容既有 llmGenerate/modelAdapter 注入）。 */
  generation?: GenerationBudget;
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

// ---- LLM 路径（T8.12：HYPOTHESIZE 提示构造 + 产物解析；纯函数） ----

/** HYPOTHESIZE 系统提示（模型以 JSON 输出 ProcessDef；成本预算由 generator 守卫） */
const HYPOTHESIZE_SYSTEM =
  '你是 OMB v2 过程生成器。根据目标与过程库，生成一个 ProcessDef JSON（entry/exit/operators 算子图，算子名 ∈ 内置集合），仅输出 JSON。';
/** HYPOTHESIZE 输出 token 上限缺省（generation 未配置时；P5 起由 budget.yaml generation.max_generate_tokens 数据化） */
const DEFAULT_HYPOTHESIZE_MAX_TOKENS = 4000;

/**
 * HYPOTHESIZE 提示构造（LLM 生成路径输入）：goal + working_state + applicability + 过程库摘要
 * （库中过程仅带算子轮廓，防 token 黑洞；过程库过大时由调用方截断——生成是最后手段）。
 */
export function buildHypothesizePrompt(task: GeneratorTask, processes: readonly ProcessDef[]): string {
  return JSON.stringify({
    goal: task.goal,
    working_state: task.state,
    applicability: task.applicability,
    process_library: processes.map((p) => ({
      id: p.id,
      entry: p.entry,
      exit: p.exit,
      operators: p.operators.map((o) => ({ op: o.op, output: o.output })),
    })),
    instruction: '生成一个 ProcessDef JSON（仅输出 JSON，无解释）：含 id/version/entry/exit/budget/operators。',
  });
}

/** 模型产物解析：容忍 ```json 代码围栏 → JSON.parse → ProcessDef schema 校验；任何失败 → null */
export function parseProcessJson(text: string): ProcessDef | null {
  const trimmed = text.trim();
  const cleaned = /^```/i.test(trimmed)
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  return validateProcess(parsed) ? parsed : null;
}

// ---- ProcessGenerator（阶梯） ----

export class ProcessGenerator {
  private readonly processes: readonly ProcessDef[];
  private readonly budget: number;
  private readonly retrieveProcess: ((q: GeneratorQuery) => readonly ProcessDef[]) | undefined;
  private readonly llmGenerate: ((task: GeneratorTask) => Promise<ProcessDef>) | undefined;
  private readonly modelAdapter: ModelAdapter | undefined;
  /** P5：generation 预算（触发条件②；undefined → 无约束，兼容既有注入） */
  private readonly generation: GenerationBudget | undefined;
  /** P5：单请求 LLM 生成调用计数（实例即单请求语义——生产 createScheduler 每次构造新生成器） */
  private generationUsed = 0;

  constructor(opts: GeneratorOptions) {
    this.processes = opts.processes;
    this.budget = opts.budget;
    this.retrieveProcess = opts.retrieveProcess;
    this.llmGenerate = opts.llmGenerate;
    this.modelAdapter = opts.modelAdapter;
    this.generation = opts.generation;
  }

  /**
   * 阶梯入口：预算预检 → Reuse → （仅 OOD）→ Compose → Mutate → Generate。
   * 已知过程（applicability=Strong/Partial）直接复用，绝不进入生成路径（本任务核心验收）。
   */
  async generate(task: GeneratorTask): Promise<GenerateResult> {
    // 预算预检：预算 < 库中最小过程图成本 → 任何阶梯产物都不可负担（库空 minCost===null 跳过，逐阶梯守卫兜底）
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

    // ④ Generate（LLM 最后手段；M4 默认不注入）——校验后仍须过预算守卫（库空时 precheck 无最小成本可依）。
    // P5：触发条件② generation 预算守卫——未启用/超单请求上限 → LLM 路径整体拒绝（纯规则降级并记录）
    const generationBlocked = this.generationBlockedReason();
    if (generationBlocked !== null) {
      return { process: null, method: 'none', reason: generationBlocked };
    }
    this.generationUsed += 1; // 预算守卫通过 → 计入本次 LLM 调用（超上限 → 同实例下次 generate 拒绝）

    if (this.llmGenerate) {
      try {
        const p = await this.llmGenerate(task);
        if (validateProcess(p)) {
          if (processCost(p) > this.budget) {
            return {
              process: null,
              method: 'none',
              reason: `budget: LLM 生成产物成本 ${processCost(p)} 超预算 ${this.budget}`,
            };
          }
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

    // T8.12：ModelAdapter 路径（与 llmGenerate 同守卫路径：schema 校验 → 预算守卫；产物解析失败降级）
    if (this.modelAdapter) {
      try {
        const p = await this.generateViaModelAdapter(task);
        if (p !== null) {
          if (processCost(p) > this.budget) {
            return {
              process: null,
              method: 'none',
              reason: `budget: LLM 生成产物成本 ${processCost(p)} 超预算 ${this.budget}`,
            };
          }
          return { process: p, method: 'generate', reason: 'generate: LLM 生成（经 ModelAdapter，全部规则阶梯失败后）' };
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
      return null; // 无可变异位（差异只在 entry/exit、短链越界或超出目标链）→ 降级
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

  /** P5：generation 预算守卫（触发条件②）——未配置 → 无约束（既有注入兼容）；禁用/超上限 → 拒绝 + 降级原因 */
  private generationBlockedReason(): string | null {
    if (this.generation === undefined) {
      return null;
    }
    if (!this.generation.enabled) {
      return `generation: LLM 生成未启用（budget.generation.enabled=false）——纯规则降级`;
    }
    if (this.generationUsed >= this.generation.max_generate_per_request) {
      return `generation: 单请求 LLM 生成次数超上限（${this.generation.max_generate_per_request}）——纯规则降级`;
    }
    return null;
  }

  /** ModelAdapter 生成路径：HYPOTHESIZE 提示构造 → 模型生成 → 产物解析（非法 → null 降级） */
  private async generateViaModelAdapter(task: GeneratorTask): Promise<ProcessDef | null> {
    const prompt = buildHypothesizePrompt(task, this.processes);
    const res = await this.modelAdapter!.generate(prompt, {
      system: HYPOTHESIZE_SYSTEM,
      // P5：HYPOTHESIZE maxTokens/reasoningEffort 数据化（budget.generation；缺省 4000/low——沿用
      // model-adapter 默认 low，防推理吃光输出预算；真实模型调用参数留宿主/策略配置，测试用 fake adapter 捕获）
      maxTokens: this.generation?.max_generate_tokens ?? DEFAULT_HYPOTHESIZE_MAX_TOKENS,
      reasoningEffort: this.generation?.reasoning_effort ?? 'low',
    });
    return parseProcessJson(res.text);
  }
}

// ---- 内部辅助 ----

/** 阶梯步骤结果：{result} 命中（直接返回）；{invalid} 产物校验失败（降级并记录）；null 无可做（继续下一步） */
type StepResult = { result: GenerateResult } | { invalid: true } | null;
