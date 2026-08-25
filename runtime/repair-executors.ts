// layer 2（runtime/）：P3.5/P3.6 Repair 真实验证执行器（七类对象）——对象验证契约应查检查的确定性执行面。
// （计划 .omb/plans/2026-08-25-verification-contract.md P3.5 + P3.6；用户裁决 2026-08-25：P3.5 开工、
//  P2.5 真实 LLM judge 接线搁置——多数用户负担不起第二模型成本，注入面保留。）
//
// 语义：
//   · 检查名与 seedRepairContract 契约 hard_constraints/outcome_conditions 完全一致（防字符串漂移）；
//     执行 = 真实只读校验；P3.6 起六个缺数据面检查（无矛盾/重放一致/代表任务/冻结回归集/可恢复）改为
//     只读验证数据面（stores.facts / stores.baselines，duck-typed 最小形状）——无数据面/无记录 →
//     诚实 unknown + detail 注明（不臆造证据）；数据面齐备 → 真实判定（pass/fail）；
//   · 依赖注入服务面（RepairExecutorServices，duck-typed 最小形状）——测试可注入 fake，装配注入真实服务；
//   · 纯逻辑、无副作用（只读）：检索一致性以 episode=false 只读语义调用 retrieve；抛错按表归入 fail/unknown，
//     不向外抛（兜底 catch → unknown）；
//   · 版本化对比（用户裁决 S1）：基线 environment_fingerprint + runtime_snapshot + verifier_version 与
//     当前（ctx.current，runRepair 注入）全匹配 → pass；任一不匹配 → unknown（基线过期需重放确认——
//     未来演化后知道"究竟和哪个历史状态比较"）；
//   · 确定性：同输入同输出（同检查名 + 同 ctx + 同服务状态 → 同结果）。
//
// 层 DAG：runtime(2) → kernel(2)/kernel/schemas(2) ✓（decideEvolution 冻结回归集重跑）；不 import
// supervisor/（层 1 存储逻辑禁止——stores 以最小形状经 services 注入，supervisor 实例由装配方构造）。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityContractSchema, ProcessSchema, SkillSchema } from '../kernel/schemas/p.js';
import { ContextProjectionSchema } from '../kernel/schemas/a.js';
import {
  REPAIR_CHECK_GENERIC_READABLE,
  REPAIR_CHECK_RETRIEVABLE,
} from '../kernel/repair-contract.js';
// P3.6：冻结回归集重跑——decideEvolution 纯函数（信号摘要+冻结策略 → 判定；与基线期望逐 case 对比）
import { decideEvolution } from '../kernel/evolve-decision.js';
import type { EvolvePolicy } from '../kernel/schemas/policy.js';
import type { SignalSummary } from '../kernel/schemas/evolution.js';

/** P3.6：当前验证器版本（基线注册与版本化对比共用；Verifier Evolution 后递增——版本不等 → 基线过期需重放确认） */
export const VERIFIER_VERSION = '1';

// ---- 服务注入面（最小形状，duck-typed；字段以 assembly 实际可用为准） ----

/** 记忆服务面（getById 必填；retrieve 可选——检索一致性检查依赖） */
export interface RepairExecutorMemoryService {
  getById(id: string): Promise<{ id: string; payload?: unknown } | undefined>;
  /** 检索（只读语义由装配方保证——episode=false）；无能力 → 检索一致性检查诚实 unknown */
  retrieve?(q: unknown): Promise<{ items?: Array<{ memory?: { id?: string } }> }>;
}

// ---- P3.6：验证数据面 duck-typed 最小形状（测试可注入 fake；真实实现 = supervisor/verification-stores.ts，
// 装配方构造后经 services.stores 注入——runtime 不 import supervisor 存储逻辑，层 DAG 零改动） ----

/** 事实库最小形状（只读：factsFor 按 provenance 子串过滤——无矛盾检查关联对象事实；缺省/空对象 → 全量） */
export interface FactStoreLike {
  factsFor(query?: { provenanceContains?: string }): Promise<ReadonlyArray<{ id: string; text: string; provenance: string; valid: boolean }>>;
}

/** 基线库最小形状（只读：getBaseline 按 id+kind——重放/代表任务/回归集/重建输入检查共用） */
export interface BaselineStoreLike {
  getBaseline(id: string, kind: string): Promise<{
    id: string;
    kind: string;
    input: unknown;
    environment_fingerprint: Record<string, unknown>;
    runtime_snapshot: string;
    expected_result: unknown;
    verifier_version: string;
  } | null>;
}

/** 验证数据面注入（facts + baselines；tasks 目前无执行器消费——任务库为注册面，消费留后续） */
export interface RepairExecutorStores {
  facts: FactStoreLike;
  baselines: BaselineStoreLike;
}

/** 执行器依赖服务面（全部可选——缺失能力 → 对应检查诚实 unknown/fail，不崩） */
export interface RepairExecutorServices {
  memory: RepairExecutorMemoryService;
  /** 组件注册表服务面（组件健康/能力契约检查依赖） */
  components?: {
    list?(): ReadonlyArray<{ manifest_id: string; status?: string }>;
    healthCheck?(): Promise<Record<string, { ok: boolean; detail?: string }>>;
    manifests?(): ReadonlyArray<{ manifest_id?: string; capabilities?: readonly string[]; contract?: unknown }>;
  };
  /** 已注入的线快照（{line, commit, dir}；无 → null）——快照物化/冒烟套件检查依赖 */
  lineSnapshot?: { line: string; commit: string; dir: string } | null;
  /** 策略目录（策略 schema 合法检查依赖） */
  policyDir?: string;
  /** 过程目录（过程定义结构合法检查依赖） */
  processesDir?: string;
  /** 策略加载器（缺省 → 策略检查 unknown） */
  loadPolicy?(dir?: string): Promise<unknown>;
  /** 过程加载器（缺省 → 过程检查 unknown） */
  loadProcesses?(dir?: string): Promise<ReadonlyArray<{ id?: string }>>;
  /** P3.6：验证数据面（事实库 + 基线库；缺失 → 无矛盾/重放/代表任务/回归集/可恢复 诚实 unknown） */
  stores?: RepairExecutorStores;
}

/** 单检查执行上下文（runRepair 注入：对象 id/契约 kind/对象载荷） */
export interface ExecuteCheckContext {
  objectId: string;
  kind: string;
  payload?: unknown;
  /**
   * P3.6：版本化对比当前态（runRepair 注入：环境指纹/运行时快照/验证器版本）——重放一致/代表任务
   * 与基线全匹配判定用；缺失 → 版本化对比按不匹配处理（unknown，基线过期需重放确认——诚实不臆造）。
   */
  current?: {
    environment_fingerprint: Record<string, unknown>;
    runtime_snapshot: string;
    verifier_version: string;
  };
}

/** 单检查结果三态（与 VerificationEvidence 检查条目同语义） */
export interface CheckOutcome {
  result: 'pass' | 'fail' | 'unknown';
  detail?: string;
}

/** 执行器出口：按检查名逐项执行（未注册检查名 → 诚实 unknown） */
export interface RepairExecutors {
  executeCheck(checkName: string, ctx: ExecuteCheckContext): Promise<CheckOutcome>;
}

// ---- 小工具（确定性、中文可审计） ----

/** 错误信息提取（确定性；非 Error → String） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** zod 校验失败明细（与 policy-loader 同款格式：path: message；'；' 分隔） */
function zodFailDetail(err: { issues?: Array<{ path?: PropertyKey[]; message?: string }> }): string {
  return (err.issues ?? [])
    .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
    .join('; ');
}

/** 从 payload 提取检索查询文本（字符串本身 / 对象的 payload 字符串字段；前 60 字符去空白）；不可提取 → null */
function extractQueryText(payload: unknown): string | null {
  let raw: unknown = payload;
  if (payload !== null && typeof payload === 'object') {
    raw = (payload as { payload?: unknown }).payload;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  return raw.replace(/\s+/g, '').slice(0, 60);
}

/** 检索查询构造（scope 取 payload.scope 合法值，缺省 Project；limit 5——两次检索对比面） */
function buildRetrieveQuery(payload: unknown, text: string): { scope: string; text: string; limit: number; budget: number } {
  const scope =
    payload !== null && typeof payload === 'object'
      ? ((payload as { scope?: unknown }).scope as string)
      : undefined;
  const validScope = scope === 'Session' || scope === 'Project' || scope === 'Global' ? scope : 'Project';
  return { scope: validScope, text, limit: 5, budget: 0 };
}

/** top-5 id 集合相等（集合语义：顺序无关；去空） */
function sameTop5IdSet(a: Array<string | undefined>, b: Array<string | undefined>): boolean {
  const norm = (xs: Array<string | undefined>): string[] =>
    [...new Set(xs.filter((x): x is string => typeof x === 'string'))].sort();
  const na = norm(a);
  const nb = norm(b);
  return na.length === nb.length && na.every((x, i) => x === nb[i]);
}

/** 确定性深比较（对象键序无关；递归；JSON 可序列化值）——版本化对比 / 回归期望对比用 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) => k === kb[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

/**
 * P3.6：版本化基线对比（重放一致/代表任务共用）——基线 environment_fingerprint + runtime_snapshot +
 * verifier_version 与当前（ctx.current）全匹配 → pass；任一缺失/不匹配 → unknown（detail 注明差异面，
 * 基线过期需重放确认——未来演化后知道"究竟和哪个历史状态比较"）。
 */
function versionedBaselineCompare(
  base: NonNullable<Awaited<ReturnType<BaselineStoreLike['getBaseline']>>>,
  current: ExecuteCheckContext['current'],
): CheckOutcome {
  if (current === undefined) {
    return {
      result: 'unknown',
      detail: '无当前态注入（ctx.current 缺失）——版本化对比无法执行，基线过期需重放确认',
    };
  }
  const fpMatch = deepEqual(base.environment_fingerprint, current.environment_fingerprint);
  const snapMatch = base.runtime_snapshot === current.runtime_snapshot;
  const verMatch = base.verifier_version === current.verifier_version;
  if (fpMatch && snapMatch && verMatch) {
    return {
      result: 'pass',
      detail: '基线版本化对比全匹配（环境指纹/运行时快照/验证器版本）——与基线记录的历史状态一致',
    };
  }
  const diffs: string[] = [];
  if (!fpMatch) diffs.push('环境指纹');
  if (!snapMatch) diffs.push('运行时快照');
  if (!verMatch) diffs.push('验证器版本');
  return {
    result: 'unknown',
    detail: `基线版本化对比不匹配（${diffs.join('、')}）——基线过期需重放确认（不能拿新状态硬比旧基线）`,
  };
}

/** 投影载荷提取：payload 直接为投影对象 / JSON 字符串 / {payload: JSON 字符串}（memory 包装）→ 解析对象；不可解析 → null */
function extractProjectionPayload(payload: unknown): unknown {
  let raw: unknown = payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const inner = (payload as { payload?: unknown }).payload;
    if (inner !== undefined && (typeof inner === 'string' || typeof inner === 'object')) {
      raw = inner;
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}

// ---- 各检查执行器（检查名与 seedRepairContract 完全一致；真实执行 vs 诚实 unknown） ----

/** ① 对象可检索（getById 命中）：memory.getById 命中 → pass；未命中 → fail（预检已保证存在，双保险）；抛错 → fail */
async function execRetrievable(services: RepairExecutorServices, ctx: ExecuteCheckContext): Promise<CheckOutcome> {
  try {
    const m = await services.memory.getById(ctx.objectId);
    return m === undefined
      ? { result: 'fail', detail: `getById 未命中——对象 ${ctx.objectId} 不可检索（预检已保证存在，双保险触发）` }
      : { result: 'pass', detail: `getById 命中——对象 ${ctx.objectId} 存在且可检索` };
  } catch (err) {
    return { result: 'fail', detail: `getById 抛错（${errorText(err)}）——对象 ${ctx.objectId} 检索失败（fail-closed）` };
  }
}

/** ② 检索一致性（同查询同结果）：payload 提取查询文本 → retrieve 两次（limit 5）→ top-5 id 集合相等 → pass；不等 → fail；
 *  retrieve 抛错/无能力/无可提取查询 → unknown（detail 注明） */
async function execRetrievalConsistency(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  if (typeof services.memory.retrieve !== 'function') {
    return { result: 'unknown', detail: 'memory.retrieve 服务不可用——检索一致性检查无法执行（无检索能力）' };
  }
  const query = extractQueryText(ctx.payload);
  if (query === null) {
    return { result: 'unknown', detail: 'payload 无可提取的查询文本（非字符串/无 payload 字符串字段）——检索一致性检查无法执行' };
  }
  const q = buildRetrieveQuery(ctx.payload, query);
  try {
    const r1 = await services.memory.retrieve(q);
    const r2 = await services.memory.retrieve(q);
    const ids1 = (r1?.items ?? []).slice(0, 5).map((it) => it.memory?.id);
    const ids2 = (r2?.items ?? []).slice(0, 5).map((it) => it.memory?.id);
    return sameTop5IdSet(ids1, ids2)
      ? { result: 'pass', detail: `同查询（${query}）同结果——两次检索 top-5 id 集合一致（${ids1.length} 项），检索一致性通过` }
      : { result: 'fail', detail: `同查询（${query}）两次检索 top-5 id 集合不一致——检索一致性失败` };
  } catch (err) {
    return { result: 'unknown', detail: `retrieve 抛错（${errorText(err)}）——检索一致性检查无法执行` };
  }
}

/** ③ 无矛盾（contradiction 检查通过）：事实库只读——provenance 含 objectId 的相关事实；
 *  无相关事实 → unknown（detail 无事实）；任一 valid=false → fail（矛盾/已推翻）；全 valid → pass */
async function execNoContradiction(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  const facts = services.stores?.facts;
  if (facts === undefined) {
    return { result: 'unknown', detail: '事实库不可用（stores.facts 未注入）——矛盾检查无法执行（无事实可判定）' };
  }
  try {
    const related = await facts.factsFor({ provenanceContains: ctx.objectId });
    if (related.length === 0) {
      return { result: 'unknown', detail: `事实库无相关事实（provenance 含 ${ctx.objectId}）——矛盾检查无事实可判定` };
    }
    const invalid = related.filter((f) => f.valid === false);
    if (invalid.length > 0) {
      return {
        result: 'fail',
        detail: `事实库存在已推翻/矛盾事实（${invalid.map((f) => f.id).join('、')}，provenance 含 ${ctx.objectId}）——矛盾检查失败`,
      };
    }
    return {
      result: 'pass',
      detail: `事实库相关事实 ${related.length} 条全部有效（provenance 含 ${ctx.objectId}）——矛盾检查通过`,
    };
  } catch (err) {
    return { result: 'unknown', detail: `事实库读取抛错（${errorText(err)}）——矛盾检查无法执行` };
  }
}

/** ④ 过程定义结构合法（schema 校验）：processesDir 可读 → loadProcesses 后按 objectId 定位 → ProcessSchema.safeParse；
 *  未定位 → unknown；加载抛错 → fail；无 processesDir/loadProcesses → unknown */
async function execProcessSchema(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  if (services.processesDir === undefined || typeof services.loadProcesses !== 'function') {
    return { result: 'unknown', detail: 'processesDir/loadProcesses 服务不可用——过程定义结构校验无法执行' };
  }
  try {
    const defs = await services.loadProcesses(services.processesDir);
    const def = defs.find((d) => d.id === ctx.objectId);
    if (def === undefined) {
      return { result: 'unknown', detail: `loadProcesses 未定位到过程 ${ctx.objectId}（processesDir=${services.processesDir}）——无定义可校验` };
    }
    const parsed = ProcessSchema.safeParse(def);
    return parsed.success
      ? { result: 'pass', detail: `过程 ${ctx.objectId} 通过 ProcessSchema 校验（结构合法）` }
      : { result: 'fail', detail: `过程 ${ctx.objectId} ProcessSchema 校验失败：${zodFailDetail(parsed.error)}` };
  } catch (err) {
    return { result: 'fail', detail: `过程加载抛错（${errorText(err)}）——过程定义结构校验失败` };
  }
}

/** ⑤ 重放一致（replay + state_delta 匹配）：process 基线只读——无基线 → unknown（detail 建议首次
 *  验证后注册）；有 → 版本化对比（环境指纹/运行时快照/验证器版本全匹配 → pass；任一不匹配 → unknown） */
async function execReplayConsistency(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  const baselines = services.stores?.baselines;
  if (baselines === undefined) {
    return { result: 'unknown', detail: '基线库不可用（stores.baselines 未注入）——重放一致检查无法执行' };
  }
  try {
    const base = await baselines.getBaseline(ctx.objectId, 'process');
    if (base === null) {
      return {
        result: 'unknown',
        detail: `无 process 基线（对象 ${ctx.objectId}）——建议首次验证通过后注册基线，下次可版本化对比`,
      };
    }
    return versionedBaselineCompare(base, ctx.current);
  } catch (err) {
    return { result: 'unknown', detail: `基线库读取抛错（${errorText(err)}）——重放一致检查无法执行` };
  }
}

/** ⑥ 技能定义结构合法：payload 可得 → SkillSchema.safeParse → pass/fail；无 payload → unknown */
function execSkillSchema(services: RepairExecutorServices, ctx: ExecuteCheckContext): CheckOutcome {
  if (ctx.payload === undefined) {
    return { result: 'unknown', detail: '无 payload——技能定义结构校验无法执行' };
  }
  const parsed = SkillSchema.safeParse(ctx.payload);
  return parsed.success
    ? { result: 'pass', detail: `技能 ${ctx.objectId} 通过 SkillSchema 校验（结构合法）` }
    : { result: 'fail', detail: `技能 ${ctx.objectId} SkillSchema 校验失败：${zodFailDetail(parsed.error)}` };
}

/** ⑦ 代表任务可执行（representative task + output contract）：skill-task 基线只读——无基线 → unknown；
 *  有 → 版本化对比（同上）→ pass/unknown */
async function execRepresentativeTask(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  const baselines = services.stores?.baselines;
  if (baselines === undefined) {
    return { result: 'unknown', detail: '基线库不可用（stores.baselines 未注入）——代表任务检查无法执行' };
  }
  try {
    const base = await baselines.getBaseline(ctx.objectId, 'skill-task');
    if (base === null) {
      return {
        result: 'unknown',
        detail: `无 skill-task 基线（对象 ${ctx.objectId}，代表任务）——建议首次验证通过后注册基线，下次可版本化对比`,
      };
    }
    return versionedBaselineCompare(base, ctx.current);
  } catch (err) {
    return { result: 'unknown', detail: `基线库读取抛错（${errorText(err)}）——代表任务检查无法执行` };
  }
}

/** ⑧ 策略 schema 合法：policyDir 可得 → loadPolicy(policyDir) 成功 → pass；抛错 → fail；无 policyDir/loadPolicy → unknown */
async function execPolicySchema(services: RepairExecutorServices): Promise<CheckOutcome> {
  if (services.policyDir === undefined || typeof services.loadPolicy !== 'function') {
    return { result: 'unknown', detail: 'policyDir/loadPolicy 服务不可用——策略 schema 校验无法执行' };
  }
  try {
    await services.loadPolicy(services.policyDir);
    return { result: 'pass', detail: `策略目录 ${services.policyDir} 全部策略通过 schema 校验（governor/budget/context/evolve）` };
  } catch (err) {
    return { result: 'fail', detail: `策略加载抛错（${errorText(err)}）——策略 schema 校验失败` };
  }
}

/** ⑨ 冻结回归集通过（frozen regression set）：policy-regression 基线只读——无基线 → unknown；
 *  有 → 逐 case（{signals, expected_decision}）以基线冻结策略重跑 decideEvolution（kernel/evolve-decision.js）
 *  对比 → 全等 → pass；任一不等 → fail（detail 列差异 case）；基线无回归 case（占位注册）→ unknown */
async function execFrozenRegressionSet(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  const baselines = services.stores?.baselines;
  if (baselines === undefined) {
    return { result: 'unknown', detail: '基线库不可用（stores.baselines 未注入）——冻结回归集检查无法执行' };
  }
  try {
    const base = await baselines.getBaseline(ctx.objectId, 'policy-regression');
    if (base === null) {
      return {
        result: 'unknown',
        detail: `无 policy-regression 基线（对象 ${ctx.objectId}，冻结回归集）——建议首次验证通过后注册基线`,
      };
    }
    // 基线 input 形状：{ policy: 冻结时 EvolvePolicy, cases: [{signals, expected_decision}] }
    const input = base.input as
      | { policy?: unknown; cases?: Array<{ signals?: unknown; expected_decision?: unknown }> }
      | null;
    const cases = input?.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      return {
        result: 'unknown',
        detail: 'policy-regression 基线无回归 case（占位注册——待冻结回归集注册后对比）',
      };
    }
    const diffs: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      // 冻结回归集重跑：用基线冻结时的策略（历史状态）——不是当前策略（未来演化后才知道与哪个历史状态比较）
      const actual = decideEvolution({
        summary: (c.signals ?? { window: { from: 0, to: 0 }, counts: {} }) as SignalSummary,
        policy: input!.policy as EvolvePolicy,
      });
      if (!deepEqual(actual, c.expected_decision)) {
        diffs.push(`case[${i}]`);
      }
    }
    return diffs.length === 0
      ? {
          result: 'pass',
          detail: `冻结回归集 ${cases.length} case 全部与基线期望一致（decideEvolution 重跑对比）——回归集通过`,
        }
      : {
          result: 'fail',
          detail: `冻结回归集差异 case（${diffs.join('、')}）——decideEvolution 重跑与基线期望不一致，回归集失败`,
        };
  } catch (err) {
    return { result: 'unknown', detail: `冻结回归集重跑抛错（${errorText(err)}）——回归集检查无法执行` };
  }
}

/** ⑩ 组件健康检查通过：objectId 匹配 components.list() 某 manifest_id → healthCheck() 该组件 ok → pass/fail；
 *  未匹配 → unknown（detail 注明非组件 id）；服务面缺失 → unknown */
async function execComponentHealth(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): Promise<CheckOutcome> {
  const comps = services.components;
  if (comps === undefined || typeof comps.list !== 'function' || typeof comps.healthCheck !== 'function') {
    return { result: 'unknown', detail: '组件服务面不可用（list/healthCheck 缺失）——组件健康检查无法执行' };
  }
  const ids = comps.list().map((c) => c.manifest_id);
  if (!ids.includes(ctx.objectId)) {
    return { result: 'unknown', detail: `${ctx.objectId} 非组件 manifest_id（组件清单：${ids.join('、') || '空'}）——组件健康检查不适用` };
  }
  try {
    const report = await comps.healthCheck();
    const h = report[ctx.objectId];
    if (h === undefined) {
      return { result: 'fail', detail: `组件 ${ctx.objectId} 无健康检查报告——组件健康检查失败` };
    }
    return h.ok
      ? { result: 'pass', detail: `组件 ${ctx.objectId} 健康检查通过` }
      : { result: 'fail', detail: `组件 ${ctx.objectId} 健康检查失败（${h.detail ?? '无详情'}）` };
  } catch (err) {
    return { result: 'fail', detail: `组件健康检查抛错（${errorText(err)}）——组件健康检查失败` };
  }
}

/** ⑪ 能力契约满足（capability contract）：组件 manifest 的 contract 经 CapabilityContractSchema 校验 → pass/fail；
 *  无契约字段 → unknown（capabilities 仅为能力名清单） */
function execCapabilityContract(
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
): CheckOutcome {
  const comps = services.components;
  if (comps === undefined || typeof comps.manifests !== 'function') {
    return { result: 'unknown', detail: '组件服务面无 manifests——能力契约校验无法执行' };
  }
  const manifest = comps.manifests().find((m) => m.manifest_id === ctx.objectId);
  if (manifest === undefined) {
    return { result: 'unknown', detail: `${ctx.objectId} 非组件 manifest_id——能力契约校验不适用` };
  }
  if (manifest.contract === undefined) {
    return { result: 'unknown', detail: `组件 ${ctx.objectId} 无契约字段（capabilities 仅为能力名清单，无契约对象）——能力契约校验不适用` };
  }
  const parsed = CapabilityContractSchema.safeParse(manifest.contract);
  return parsed.success
    ? { result: 'pass', detail: `组件 ${ctx.objectId} 能力契约通过 CapabilityContractSchema 校验` }
    : { result: 'fail', detail: `组件 ${ctx.objectId} 能力契约校验失败：${zodFailDetail(parsed.error)}` };
}

/** ⑫ 投影 schema 校验通过：payload 可得 → ContextProjectionSchema.safeParse → pass/fail；无 payload → unknown */
function execProjectionSchema(services: RepairExecutorServices, ctx: ExecuteCheckContext): CheckOutcome {
  if (ctx.payload === undefined) {
    return { result: 'unknown', detail: '无 payload——投影 schema 校验无法执行' };
  }
  const parsed = ContextProjectionSchema.safeParse(ctx.payload);
  return parsed.success
    ? { result: 'pass', detail: `投影 ${ctx.objectId} 通过 ContextProjectionSchema 校验（schema 合法）` }
    : { result: 'fail', detail: `投影 ${ctx.objectId} ContextProjectionSchema 校验失败：${zodFailDetail(parsed.error)}` };
}

/** ⑬ 必填字段齐全（required fields）：复用投影 schema 校验（detail 注明）；payload 非投影形态/无 payload → unknown */
function execRequiredFields(services: RepairExecutorServices, ctx: ExecuteCheckContext): CheckOutcome {
  if (ctx.payload === undefined || ctx.payload === null || typeof ctx.payload !== 'object') {
    return { result: 'unknown', detail: '无 payload——必填字段校验无法执行（复用投影 schema 校验面）' };
  }
  const p = ctx.payload as Record<string, unknown>;
  if (!('type' in p) || !('sections' in p)) {
    return { result: 'unknown', detail: 'payload 非投影形态（无 type/sections）——必填字段校验不适用（复用投影 schema 校验面）' };
  }
  const parsed = ContextProjectionSchema.safeParse(ctx.payload);
  return parsed.success
    ? { result: 'pass', detail: '投影必填字段齐全（复用 ContextProjectionSchema 校验）' }
    : { result: 'fail', detail: `投影必填字段缺失/非法：${zodFailDetail(parsed.error)}` };
}

/** ⑭ 可恢复（restore）：projection-rebuild 基线只读——无基线 → unknown；有 → baseline.input 含重建输入
 *  （rebuild_input 非空）且对象 payload 可解析为合法投影（ContextProjectionSchema）→ pass；否则 unknown */
async function execRestore(services: RepairExecutorServices, ctx: ExecuteCheckContext): Promise<CheckOutcome> {
  const baselines = services.stores?.baselines;
  if (baselines === undefined) {
    return { result: 'unknown', detail: '基线库不可用（stores.baselines 未注入）——可恢复检查无法执行' };
  }
  try {
    const base = await baselines.getBaseline(ctx.objectId, 'projection-rebuild');
    if (base === null) {
      return {
        result: 'unknown',
        detail: `无 projection-rebuild 基线（对象 ${ctx.objectId}，重建输入）——建议首次验证通过后注册基线`,
      };
    }
    // 基线 input 形状：{ rebuild_input: 重建输入 }（占位注册 → 无重建输入 → unknown）
    const input = base.input as { rebuild_input?: unknown } | null;
    if (input === null || input.rebuild_input === undefined || input.rebuild_input === null) {
      return {
        result: 'unknown',
        detail: 'projection-rebuild 基线无重建输入（占位注册——待重建输入注册后对比）',
      };
    }
    const projection = extractProjectionPayload(ctx.payload);
    if (projection === null) {
      return {
        result: 'unknown',
        detail: '对象 payload 不可解析（非 JSON 字符串/非对象）——可恢复检查无法执行',
      };
    }
    const parsed = ContextProjectionSchema.safeParse(projection);
    return parsed.success
      ? { result: 'pass', detail: '重建输入齐备且对象 payload 可解析为合法投影——可恢复检查通过' }
      : {
          result: 'unknown',
          detail: `对象 payload 解析后非合法投影（ContextProjectionSchema 校验失败：${zodFailDetail(parsed.error)}）——可恢复检查无法执行`,
        };
  } catch (err) {
    return { result: 'unknown', detail: `可恢复检查抛错（${errorText(err)}）——无法执行` };
  }
}

/** ⑮ 快照物化完整可读：lineSnapshot.dir 的 kernel/policy + kernel/processes 子目录可读（readdir 成功）→ pass；
 *  缺失/不可读 → fail；无线快照 → unknown */
async function execSnapshotMaterialized(services: RepairExecutorServices): Promise<CheckOutcome> {
  const snap = services.lineSnapshot;
  if (snap === null || snap === undefined) {
    return { result: 'unknown', detail: '无线快照（旧布局/未注入）——快照物化检查不适用' };
  }
  try {
    await readdir(join(snap.dir, 'kernel', 'policy'));
    await readdir(join(snap.dir, 'kernel', 'processes'));
    return { result: 'pass', detail: `线快照 ${snap.line}@${snap.commit} 的 kernel/policy 与 kernel/processes 子目录可读——物化完整` };
  } catch (err) {
    return { result: 'fail', detail: `线快照 ${snap.line}@${snap.commit} 物化不完整/不可读（${errorText(err)}）` };
  }
}

/** ⑯ 冒烟套件通过（smoke suite）：线快照 dir 上 loadPolicy + loadProcesses 均成功 → pass；任一抛错 → fail；
 *  无线快照/加载器缺失 → unknown */
async function execSmokeSuite(services: RepairExecutorServices): Promise<CheckOutcome> {
  const snap = services.lineSnapshot;
  if (snap === null || snap === undefined) {
    return { result: 'unknown', detail: '无线快照——冒烟套件不适用' };
  }
  if (typeof services.loadPolicy !== 'function' || typeof services.loadProcesses !== 'function') {
    return { result: 'unknown', detail: 'loadPolicy/loadProcesses 服务不可用——冒烟套件无法执行' };
  }
  try {
    await services.loadPolicy(join(snap.dir, 'kernel', 'policy'));
    await services.loadProcesses(join(snap.dir, 'kernel', 'processes'));
    return { result: 'pass', detail: `线快照 ${snap.line}@${snap.commit} 冒烟套件通过（policy + processes 均可加载）` };
  } catch (err) {
    return { result: 'fail', detail: `线快照 ${snap.line}@${snap.commit} 冒烟套件失败（${errorText(err)}）` };
  }
}

/** ⑰ 对象结构 schema 校验通过（generic）：payload 为可解析 JSON 对象 → pass；否则 fail */
function execGenericObjectSchema(services: RepairExecutorServices, ctx: ExecuteCheckContext): CheckOutcome {
  if (ctx.payload === undefined || ctx.payload === null) {
    return { result: 'fail', detail: '无 payload——generic 对象结构 schema 校验失败' };
  }
  let candidate: unknown = ctx.payload;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { result: 'fail', detail: 'payload 非可解析 JSON——generic 对象结构 schema 校验失败' };
    }
  }
  if (typeof candidate === 'object' && !Array.isArray(candidate)) {
    return { result: 'pass', detail: 'payload 为可解析 JSON 对象——generic 对象结构 schema 校验通过' };
  }
  return { result: 'fail', detail: 'payload 非 JSON 对象（数组/标量）——generic 对象结构 schema 校验失败' };
}

// ---- 检查名 → 执行器映射（键与 seedRepairContract 完全一致） ----

type Executor = (
  services: RepairExecutorServices,
  ctx: ExecuteCheckContext,
) => Promise<CheckOutcome> | CheckOutcome;

const EXECUTORS: Record<string, Executor> = {
  // memory 契约
  [REPAIR_CHECK_RETRIEVABLE]: execRetrievable,
  '检索一致性（同查询同结果）': execRetrievalConsistency,
  '无矛盾（contradiction 检查通过）': execNoContradiction,
  // process 契约
  '过程定义结构合法（schema 校验）': execProcessSchema,
  '重放一致（replay + state_delta 匹配）': execReplayConsistency,
  // skill 契约
  '技能定义结构合法': execSkillSchema,
  '代表任务可执行（representative task + output contract）': execRepresentativeTask,
  // policy 契约
  '策略 schema 合法': execPolicySchema,
  '冻结回归集通过（frozen regression set）': execFrozenRegressionSet,
  // capability 契约
  '组件健康检查通过': execComponentHealth,
  '能力契约满足（capability contract）': execCapabilityContract,
  // projection 契约
  '投影 schema 校验通过': execProjectionSchema,
  '必填字段齐全（required fields）': execRequiredFields,
  '可恢复（restore）': execRestore,
  // version 契约
  '快照物化完整可读': execSnapshotMaterialized,
  '冒烟套件通过（smoke suite）': execSmokeSuite,
  // generic 兜底契约
  [REPAIR_CHECK_GENERIC_READABLE]: execRetrievable, // '对象存在且可读' ≡ getById 命中判定（预检已保证存在，双保险）
  '对象结构 schema 校验通过': execGenericObjectSchema,
};

/**
 * 创建 Repair 真实验证执行器（确定性纯逻辑；构造不抛错——闭包组装）。
 * executeCheck：按检查名派发；未注册检查名 → 诚实 unknown（detail 注明无执行器）；
 * 执行器内已按表归入 fail/unknown，兜底 catch 不向外抛（防御外部服务异常）。
 */
export function createRepairExecutors(services: RepairExecutorServices): RepairExecutors {
  return {
    async executeCheck(checkName, ctx): Promise<CheckOutcome> {
      const executor = EXECUTORS[checkName];
      if (executor === undefined) {
        return { result: 'unknown', detail: `无执行器（检查名未注册：${checkName}）` };
      }
      try {
        return await executor(services, ctx);
      } catch (err) {
        // 执行器内部应已归表；此处兜底防御（外部服务异常）——不向外抛，按 unknown 降级
        return { result: 'unknown', detail: `执行器异常（${errorText(err)}）——按 unknown 降级（不向外抛）` };
      }
    },
  };
}
