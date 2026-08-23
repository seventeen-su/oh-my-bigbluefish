// OMB v2 策略与过程数据层（P3 机制即数据，架构 §5.1/§5.3/§4.2 P1/§17 参数标定）。
// YAML 加载 + zod schema 校验 + 深冻结导出：策略/过程全部为数据，代码 = 解释器——
// 改 YAML 即生效（加载器不感知内容）；非法数据 fail-loud。
// layer 2（kernel/）：仅 import node: 内置 + js-yaml + kernel/schemas/（同层/契约层，CONVENTIONS §4）。
// schema/枚举定义在 kernel/schemas/policy.ts（契约层，T7.2 起 supervisor 复用）；本文件 re-export 保持公共 API。
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import {
  BudgetPolicySchema,
  ContextPolicySchema,
  DEFAULT_CANDIDATE_GATE,
  EvolvePolicySchema,
  GovernorPolicySchema,
  ProcessDefSchema,
  type BudgetPolicy,
  type ContextPolicy,
  type EvolvePolicy,
  type GovernorPolicy,
  type ProcessDef,
} from './schemas/policy.js';

// ---- re-export（公共 API 与 T2.1 一致：枚举/schema/类型经契约层再导出） ----

export {
  APPLICABILITY,
  BUILTIN_OPERATORS,
  CANDIDATE_KINDS,
  EVIDENCE_GAPS,
  GOVERNOR_DECISIONS,
  BudgetPolicySchema,
  ContextPolicySchema,
  DEFAULT_DEBT_THRESHOLDS,
  DebtThresholdsSchema,
  DEFAULT_CANDIDATE_GATE,
  CandidateGateSchema,
  DEFAULT_GENERATION_BUDGET,
  GenerationBudgetSchema,
  EvolvePolicySchema,
  GovernorPolicySchema,
  GovernorRuleSchema,
  KindCostTableSchema,
  OBJECT_LAYERS,
  OperatorDefSchema,
  ProcessDefSchema,
  SignalTriggerSchema,
  type BudgetPolicy,
  type CandidateGate,
  type CandidateKind,
  type ContextPolicy,
  type DebtThresholds,
  type EvolvePolicy,
  type GenerationBudget,
  type GovernorPolicy,
  type GovernorRule,
  type KindCostTable,
  type ObjectLayer,
  type OperatorDef,
  type ProcessDef,
  type SignalTrigger,
} from './schemas/policy.js';

/** loadPolicy 返回的四策略捆绑（P1c：evolve.policy 数据化判定加入） */
export interface PolicyBundle {
  governor: GovernorPolicy;
  budget: BudgetPolicy;
  context: ContextPolicy;
  evolve: EvolvePolicy;
}

/** evolve.yaml 缺省策略（旧布局线快照/临时目录无 evolve.yaml → 缺省；内容 = 出厂初值，与 kernel/policy/evolve.yaml 同源） */
const DEFAULT_EVOLVE_POLICY: EvolvePolicy = {
  daily_evolution_cost: 100,
  roi_min: 1.0,
  maintenance_rate: 0.5,
  signal_triggers: {},
  debt_thresholds: { soft: 10, hard: 50, critical: 100 },
  candidate_gate: { ...DEFAULT_CANDIDATE_GATE },
};

/** 仓库根候选（src 布局本文件在 <preset>/kernel/ → 上一级即 preset 根；编译布局 <preset>/lib/kernel/ 多一层 → 存在性回退） */
const HERE_CANDIDATE = fileURLToPath(new URL('..', import.meta.url));
/** 仓库根：存在性回退（src 布局 HERE_CANDIDATE 即根；编译布局其下无 kernel/policy → 取上级） */
const HERE = existsSync(join(HERE_CANDIDATE, 'kernel', 'policy')) ? HERE_CANDIDATE : dirname(HERE_CANDIDATE);

/** 仓库默认策略目录（loadPolicy 缺省目录；P1a：调用方可注入线快照目录覆盖） */
const DEFAULT_POLICY_DIR = join(HERE, 'kernel', 'policy');
/** 仓库默认过程目录（loadProcesses 缺省目录；P1a：调用方可注入线快照目录覆盖） */
const DEFAULT_PROCESSES_DIR = join(HERE, 'kernel', 'processes');

// ---- 加载器 ----

/** 读文件 → YAML parse → zod 校验（fail-loud：路径 + 校验问题明细） */
async function parsePolicyFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(file, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`policy 校验失败 ${file}: ${detail}`);
  }
  return result.data;
}

/** 递归冻结（机制即数据：运行期策略/过程不可变） */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 加载 evolve.yaml（P1c）：存在 → zod 校验 fail-loud；缺失（旧布局线快照/临时目录未种子）→
 * 缺省策略（向后兼容——loadPolicy 目录注入面不因新策略文件缺席而炸）。
 */
async function loadEvolvePolicy(policyDir: string): Promise<EvolvePolicy> {
  const file = join(policyDir, 'evolve.yaml');
  try {
    return await parsePolicyFile(file, EvolvePolicySchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_EVOLVE_POLICY };
    }
    throw err;
  }
}

/** 加载四策略（governor.yaml / budget.yaml / context.yaml / evolve.yaml）并深冻结。
 *  @param dir 策略目录（缺省 <repo>/kernel/policy；P1a 线快照注入时传 lines/<line>/<commit>/kernel/policy） */
export async function loadPolicy(dir?: string): Promise<PolicyBundle> {
  const policyDir = dir ?? DEFAULT_POLICY_DIR;
  const [governor, budget, context, evolve] = await Promise.all([
    parsePolicyFile(join(policyDir, 'governor.yaml'), GovernorPolicySchema),
    parsePolicyFile(join(policyDir, 'budget.yaml'), BudgetPolicySchema),
    parsePolicyFile(join(policyDir, 'context.yaml'), ContextPolicySchema),
    loadEvolvePolicy(policyDir),
  ]);
  return deepFreeze({ governor, budget, context, evolve });
}

/** 加载目录下全部 *.yaml 过程（文件名排序保证确定性）并深冻结。
 *  @param dir 过程目录（缺省 <repo>/kernel/processes；P1a 线快照注入时传 lines/<line>/<commit>/kernel/processes） */
export async function loadProcesses(dir?: string): Promise<readonly ProcessDef[]> {
  const processesDir = dir ?? DEFAULT_PROCESSES_DIR;
  const files = (await readdir(processesDir)).filter((f) => f.endsWith('.yaml')).sort();
  const processes = await Promise.all(files.map((f) => parsePolicyFile(join(processesDir, f), ProcessDefSchema)));
  return deepFreeze(processes);
}
