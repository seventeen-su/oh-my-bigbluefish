// layer 2（runtime/）：P3.5 Repair 真实验证执行器（七类对象）——对象验证契约应查检查的确定性执行面。
// （计划 .omb/plans/2026-08-25-verification-contract.md P3.5；用户裁决 2026-08-25：P3.5 开工、
//  P2.5 真实 LLM judge 接线搁置——多数用户负担不起第二模型成本，注入面保留。）
//
// 语义：
//   · 检查名与 seedRepairContract 契约 hard_constraints/outcome_conditions 完全一致（防字符串漂移）；
//     执行 = 真实只读校验；当前无法真实执行的面（无矛盾/重放一致/代表任务/冻结回归集/可恢复）→
//     诚实 unknown + detail 注明依赖面（需 P3.6 数据面/基线注册面，或 judge（P2.5 搁置））——不臆造证据；
//   · 依赖注入服务面（RepairExecutorServices，duck-typed 最小形状）——测试可注入 fake，装配注入真实服务；
//   · 纯逻辑、无副作用（只读）：检索一致性以 episode=false 只读语义调用 retrieve；抛错按表归入 fail/unknown，
//     不向外抛（兜底 catch → unknown）；
//   · 确定性：同输入同输出（同检查名 + 同 ctx + 同服务状态 → 同结果）。
//
// 层 DAG：runtime(2) → kernel(2)/kernel/schemas(2) ✓；不 import supervisor/（层 1 maintenance 等逻辑禁止）。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityContractSchema, ProcessSchema, SkillSchema } from '../kernel/schemas/p.js';
import { ContextProjectionSchema } from '../kernel/schemas/a.js';
import {
  REPAIR_CHECK_GENERIC_READABLE,
  REPAIR_CHECK_RETRIEVABLE,
} from '../kernel/repair-contract.js';

// ---- 服务注入面（最小形状，duck-typed；字段以 assembly 实际可用为准） ----

/** 记忆服务面（getById 必填；retrieve 可选——检索一致性检查依赖） */
export interface RepairExecutorMemoryService {
  getById(id: string): Promise<{ id: string; payload?: unknown } | undefined>;
  /** 检索（只读语义由装配方保证——episode=false）；无能力 → 检索一致性检查诚实 unknown */
  retrieve?(q: unknown): Promise<{ items?: Array<{ memory?: { id?: string } }> }>;
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
}

/** 单检查执行上下文（runRepair 注入：对象 id/契约 kind/对象载荷） */
export interface ExecuteCheckContext {
  objectId: string;
  kind: string;
  payload?: unknown;
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

/** ③ 无矛盾（contradiction 检查通过）：诚实 unknown——矛盾检测依赖事件归约/语义面，repair 路径无该面 */
function execNoContradiction(): CheckOutcome {
  return {
    result: 'unknown',
    detail: '矛盾检测依赖事件归约/语义面，repair 路径无该面——需 P3.6 数据面或 judge（P2.5 搁置）',
  };
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

/** ⑤ 重放一致（replay + state_delta 匹配）：诚实 unknown——无过程重放基线存储 */
function execReplayConsistency(): CheckOutcome {
  return {
    result: 'unknown',
    detail: '无过程重放基线存储（replay + state_delta 需基线注册面）——需 P3.6 基线注册面或 judge（P2.5 搁置）',
  };
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

/** ⑦ 代表任务可执行（representative task + output contract）：诚实 unknown——无代表任务注册面 */
function execRepresentativeTask(): CheckOutcome {
  return {
    result: 'unknown',
    detail: '无代表任务注册面（representative task + output contract 需任务注册/执行面）——需 P3.6 或 judge（P2.5 搁置）',
  };
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

/** ⑨ 冻结回归集通过（frozen regression set）：诚实 unknown——无冻结回归集存储 */
function execFrozenRegressionSet(): CheckOutcome {
  return {
    result: 'unknown',
    detail: '无冻结回归集存储——需回归基线面（P3.6）或 judge（P2.5 搁置）',
  };
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

/** ⑭ 可恢复（restore）：诚实 unknown——restore 机制未注册 */
function execRestore(): CheckOutcome {
  return {
    result: 'unknown',
    detail: 'restore 机制未注册——需 P3.6 restore 注册面或 judge（P2.5 搁置）',
  };
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
