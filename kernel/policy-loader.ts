// OMB v2 策略与过程数据层（P3 机制即数据，架构 §5.1/§5.3/§4.2 P1/§17 参数标定）。
// YAML 加载 + zod schema 校验 + 深冻结导出：策略/过程全部为数据，代码 = 解释器——
// 改 YAML 即生效（加载器不感知内容）；非法数据 fail-loud。
// layer 2（kernel/）：仅 import node: 内置 + js-yaml + kernel/schemas/（同层，CONVENTIONS §4）。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { BudgetSchema } from './schemas/base.js';

// ---- 枚举常量（as const 类型导出；决策/算子值域固定） ----

/** Process Applicability（架构 §5.1） */
export const APPLICABILITY = ['Strong', 'Partial', 'Failed', 'Contradictory', 'OOD'] as const;
/** 证据缺口状态（§5.1 evidence_sufficiency → 二值化：缺口空/有缺口） */
export const EVIDENCE_GAPS = ['none', 'some'] as const;
/** Governor 决策（§5.1 GovernorDecision） */
export const GOVERNOR_DECISIONS = [
  'RunProcess',
  'GenerateProcess',
  'ExpandSearch',
  'RetrieveMemory',
  'Verify',
  'Delegate',
  'Stop',
] as const;
/** 内置算子（§5.3 7 算子 + 预留 VERIFY；M4 若调整清单，此处同步） */
export const BUILTIN_OPERATORS = [
  'RETRIEVE',
  'HYPOTHESIZE',
  'DISCRIMINATE',
  'EXECUTE',
  'OBSERVE',
  'UPDATE',
  'STOP',
  'VERIFY',
] as const;

// ---- Schema（zod；与类型同源，z.infer 导出） ----

/** Governor 决策表规则（默认规则无 when：匹配任何未命中组合） */
export const GovernorRuleSchema = z.object({
  id: z.string().min(1),
  when: z
    .object({
      applicability: z.enum(APPLICABILITY),
      evidence_gaps: z.enum(EVIDENCE_GAPS),
      budget_ok: z.boolean(),
    })
    .optional(),
  decision: z.enum(GOVERNOR_DECISIONS),
});
export type GovernorRule = z.infer<typeof GovernorRuleSchema>;

/** GovernorPolicy：决策表（§5.1 Fast Governor 结构化 policy） */
export const GovernorPolicySchema = z
  .object({
    rules: z.array(GovernorRuleSchema).min(1),
  })
  .refine(
    (v) => {
      const defaults = v.rules.filter((r) => r.when === undefined);
      return defaults.length === 1 && defaults[0]?.id === 'default';
    },
    { message: '决策表必须恰有一条默认规则（无 when 且 id=default）', path: ['rules'] },
  )
  .refine(
    (v) => {
      const seen = new Set<string>();
      for (const r of v.rules) {
        if (!r.when) continue;
        const key = `${r.when.applicability}|${r.when.evidence_gaps}|${r.when.budget_ok}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: '决策表 when 组合不得重复', path: ['rules'] },
  );
export type GovernorPolicy = z.infer<typeof GovernorPolicySchema>;

/** BudgetPolicy：计算分配器六维预算 + Context 投影预算（§5.1/§17 初值） */
export const BudgetPolicySchema = z.object({
  depth: z.number().int().positive(),
  breadth: z.number().int().positive(),
  tools: z.number().int().positive(),
  retrieval: z.number().int().positive(),
  branches: z.number().int().positive(),
  context: z.number().int().positive(),
  context_budget_tokens: z.number().int().positive(),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

/** ContextPolicy：Context Compiler 参数（§6.1 边际价值权重；§17 开放项初值） */
export const ContextPolicySchema = z.object({
  marginal_weights: z.object({
    info_value: z.number().nonnegative(),
    token_cost: z.number().nonnegative(),
    reacquisition: z.number().nonnegative(),
    attention_pollution: z.number().nonnegative(),
    regression_risk: z.number().nonnegative(),
  }),
  working_state_never_compress: z.literal(true),
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

/** 算子定义（§5.3 Operator ABI 数据化子集：M2 只做数据与校验，执行在 M4） */
export const OperatorDefSchema = z.object({
  id: z.string().min(1),
  op: z.enum(BUILTIN_OPERATORS),
  input_binding: z.record(z.string(), z.unknown()),
  output: z.string().min(1),
  cost: BudgetSchema,
  verification: z.string().min(1),
  error: z.object({
    retryable: z.boolean(),
    timeout_ms: z.number().nonnegative(),
    cancelable: z.boolean(),
    rollback: z.string().min(1),
  }),
});
export type OperatorDef = z.infer<typeof OperatorDefSchema>;

/** ProcessDef：过程 = 数据化程序（§4.2 P1；entry/exit 必须与图端点一致） */
export const ProcessDefSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    entry: z.enum(BUILTIN_OPERATORS),
    exit: z.enum(BUILTIN_OPERATORS),
    budget: BudgetSchema,
    operators: z.array(OperatorDefSchema).min(1),
  })
  .refine((v) => v.operators[0]?.op === v.entry, {
    message: 'entry 必须等于首算子 op',
    path: ['entry'],
  })
  .refine((v) => v.operators[v.operators.length - 1]?.op === v.exit, {
    message: 'exit 必须等于末算子 op',
    path: ['exit'],
  });
export type ProcessDef = z.infer<typeof ProcessDefSchema>;

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
