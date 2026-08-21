// layer 2：已知过程调度器（架构 §3 ③ scheduler.ts / §5.3 Process Applicability；施工计划 M2 列名缺失补全）。
// 独立实现（T8.4）：
// - 已知过程选择：Applicability Strong/Partial 直接复用（库序确定性；成本预算守卫——超预算 → none/budget，
//   不执行超预算过程，与 T4.2 ProcessGenerator.tryReuse 同语义）；
// - 无已知过程：代表 applicability（库序首过程，确定性）为 OOD → 交 Generator（T4.2 阶梯
//   Reuse → Compose → Mutate → Generate）；Contradictory/Failed → 不触发生成（Governor 决策域：
//   RetrieveMemory/ExpandSearch——本层只报告不执行）；
// - 调度结果 → process-adapter（toOperatorGraph）→ executeGraph：由调用方/上层编排
//   （M4 loop 先例：tests/m4/milestone-loop.test.ts 的 generate → toOperatorGraph → executeGraph 链）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
import type { ProcessDef } from '../kernel/policy-loader.js';
import { ProcessGenerator, processCost, type GeneratorQuery } from './generator.js';
import { assessApplicability, type Applicability, type WorkingState } from './generator-ops.js';

/** 缺省生成预算（未显式配置时 Generator 用） */
const DEFAULT_GENERATOR_BUDGET = 20000;

/** 调度任务（Governor RunProcess/GenerateProcess 决策的下游输入） */
export interface ScheduleTask {
  goal: string;
  state: WorkingState;
  /** 过程必须覆盖的算子集（assessApplicability requires 维度；缺省无要求） */
  requires?: string[];
  /** 执行预算（已知过程成本超预算 → none/budget；缺省不设限） */
  budget?: number;
}

/** 调度结果（kind=known/generated/none；process 非空当且仅当 known/generated） */
export interface ScheduleResult {
  kind: 'known' | 'generated' | 'none';
  process: ProcessDef | null;
  /** known 时的适用性判定 */
  applicability?: Applicability;
  /** 生成方法（generated 时 meaningful；none 恒为 none） */
  method: 'reuse' | 'compose' | 'mutate' | 'generate' | 'none';
  reason: string;
}

export interface SchedulerOptions {
  /** 过程库（机制即数据：kernel/processes/*.yaml 加载产物） */
  processes: readonly ProcessDef[];
  /** OOD 生成器（缺省内置 ProcessGenerator；测试注入 llmGenerate 阶梯） */
  generator?: ProcessGenerator;
  /** 缺省生成预算（generator 未注入时） */
  generatorBudget?: number;
  /** 检索注入（Generator 复用阶梯；缺省关键词检索） */
  retrieveProcess?: (q: GeneratorQuery) => readonly ProcessDef[];
}

/**
 * 已知过程调度器：Strong/Partial 直接复用（库序确定性）；OOD 交 Generator；Failed/Contradictory 不生成。
 */
export class ProcessScheduler {
  private readonly processes: readonly ProcessDef[];
  private readonly generator: ProcessGenerator;

  constructor(opts: SchedulerOptions) {
    this.processes = opts.processes;
    this.generator =
      opts.generator ??
      new ProcessGenerator({
        processes: opts.processes,
        budget: opts.generatorBudget ?? DEFAULT_GENERATOR_BUDGET,
        retrieveProcess: opts.retrieveProcess,
      });
  }

  async schedule(task: ScheduleTask): Promise<ScheduleResult> {
    // ① 已知过程选择：库序首个 Strong/Partial（确定性）；成本预算守卫
    for (const p of this.processes) {
      const applicability = assessApplicability(p, task);
      if (applicability !== 'Strong' && applicability !== 'Partial') {
        continue;
      }
      if (task.budget !== undefined && processCost(p) > task.budget) {
        return {
          kind: 'none',
          process: null,
          method: 'none',
          reason: `budget: 已知过程 ${p.id} 成本 ${processCost(p)} 超预算 ${task.budget}，不执行`,
        };
      }
      return {
        kind: 'known',
        process: p,
        applicability,
        method: 'reuse',
        reason: `known: 已知过程 ${p.id}（applicability=${applicability}）直接复用`,
      };
    }

    // ② 无已知过程 → 代表 applicability（库序首过程，确定性；与 Governor applicability_results[0] 同视图）
    const first = this.processes[0];
    const representative: Applicability = first === undefined ? 'OOD' : assessApplicability(first, task);
    if (representative === 'Contradictory' || representative === 'Failed') {
      const governorAction = representative === 'Contradictory' ? 'RetrieveMemory' : 'ExpandSearch';
      return {
        kind: 'none',
        process: null,
        method: 'none',
        reason: `none: 无已知过程（applicability=${representative}）——非 OOD 不触发生成（Governor 决策域：${governorAction}）`,
      };
    }

    // ③ OOD → 交 Generator（T4.2 阶梯）
    const res = await this.generator.generate({ goal: task.goal, state: task.state, applicability: 'OOD' });
    if (res.process !== null) {
      return { kind: 'generated', process: res.process, method: res.method, reason: res.reason };
    }
    return { kind: 'none', process: null, method: 'none', reason: res.reason };
  }
}
