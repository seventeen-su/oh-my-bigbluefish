// OMB v2 策略与过程数据层（P3 机制即数据，架构 §5.1/§5.3/§4.2 P1/§17 参数标定）。
// YAML 加载 + zod schema 校验 + 深冻结导出：策略/过程全部为数据，代码 = 解释器——
// 改 YAML 即生效（加载器不感知内容）；非法数据 fail-loud。
// layer 2（kernel/）：仅 import node: 内置 + js-yaml + kernel/schemas/（同层/契约层，CONVENTIONS §4）。
// schema/枚举定义在 kernel/schemas/policy.ts（契约层，T7.2 起 supervisor 复用）；本文件 re-export 保持公共 API。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import {
  BudgetPolicySchema,
  ContextPolicySchema,
  GovernorPolicySchema,
  ProcessDefSchema,
  type BudgetPolicy,
  type ContextPolicy,
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
  GovernorPolicySchema,
  GovernorRuleSchema,
  KindCostTableSchema,
  OperatorDefSchema,
  ProcessDefSchema,
  type BudgetPolicy,
  type CandidateKind,
  type ContextPolicy,
  type GovernorPolicy,
  type GovernorRule,
  type KindCostTable,
  type OperatorDef,
  type ProcessDef,
} from './schemas/policy.js';

/** loadPolicy 返回的三策略捆绑 */
export interface PolicyBundle {
  governor: GovernorPolicy;
  budget: BudgetPolicy;
  context: ContextPolicy;
}

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

/** 加载三策略（governor.yaml / budget.yaml / context.yaml）并深冻结 */
export async function loadPolicy(dir: string): Promise<PolicyBundle> {
  const [governor, budget, context] = await Promise.all([
    parsePolicyFile(join(dir, 'governor.yaml'), GovernorPolicySchema),
    parsePolicyFile(join(dir, 'budget.yaml'), BudgetPolicySchema),
    parsePolicyFile(join(dir, 'context.yaml'), ContextPolicySchema),
  ]);
  return deepFreeze({ governor, budget, context });
}

/** 加载目录下全部 *.yaml 过程（文件名排序保证确定性）并深冻结 */
export async function loadProcesses(dir: string): Promise<readonly ProcessDef[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const processes = await Promise.all(files.map((f) => parsePolicyFile(join(dir, f), ProcessDefSchema)));
  return deepFreeze(processes);
}
