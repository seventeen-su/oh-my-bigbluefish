// OMB v2 元演化门禁（架构 §9.5 元演化 + §14.2 哲学自身可演化；施工计划 T7.2）：layer 1。
//
// 设计（brief 已定 + 实现选择）：
// - 元层对象：governance.policy（决策规则）/ evolve.policy（演化规则）——数据对象（T2.1 政策 YAML 同族）；
//   元层变更默认人工评审 + 冻结基线对照（频率远低于对象层，门禁最重）。
// - evaluateMetaChange 门禁顺序（brief）：无冻结基线 → 拒绝；有基线但回归（新基线任务 true→false）
//   → 拒绝；无人工批准 → 拒绝；全过 → ok（应用执行权交回调用方）。
//   结构性前置校验（tests 5/6）：非法 target 拒绝；diff.from/to 必须过对应 policy schema
//   （T2.1 复用：governance.policy → GovernorPolicySchema；evolve.policy → EvolvePolicySchema §9.5）。
// - 冻结基线对照：change.baseline_report 与当前 frozenBaseline 比对（基准快照 hash 一致性，基线漂移拒绝）
//   + 无回归（runBaseline 应用 diff 后：任一任务 passed true→false 拒绝；任务缺失按回归处理，fail-closed）。
// - applyMetaChange：目标/批准/基线/diff 全部校验（防呆守卫）→ 原子写回 policy 文件（tmp+rename）
//   + 记录 evolution/policy-applied 事件（M3 Event，EventStore）。
// - deps 注入（frozenBaseline/runBaseline）：M7 无真实 DSH 时由调用方接 T7.1 bench 产物/回放执行器；
//   幂等：evaluateMetaChange 为纯函数（不写状态），同 change 重复 evaluate → 同结果。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（契约例外）+ supervisor/ 内文件。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { canonicalJson, makeImmutableId, makeMutableId, type Fingerprint } from '../kernel/schemas/base.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层例外，supervisor(1) → kernel/schemas/ ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';
import type { BenchReport } from '../kernel/schemas/bench.js';
import type { Event } from '../kernel/schemas/m.js';
import {
  EvolvePolicySchema,
  GovernorPolicySchema,
} from '../kernel/schemas/policy.js';
import { EventStore } from './event-store.js';

// ---- 元层目标（架构 §9.5：governance.policy / evolve.policy） ----

export const META_TARGETS = ['governance.policy', 'evolve.policy'] as const;
export type MetaTarget = (typeof META_TARGETS)[number];

/** 目标 → 对应 policy schema（T2.1 复用：governance.policy = GovernorPolicy；evolve.policy = §9.5 EvolvePolicy） */
const POLICY_SCHEMAS: Readonly<Record<MetaTarget, typeof GovernorPolicySchema | typeof EvolvePolicySchema>> = {
  'governance.policy': GovernorPolicySchema,
  'evolve.policy': EvolvePolicySchema,
};

/** 目标 → policy 文件名（applyMetaChange 写回位置） */
const TARGET_FILES: Readonly<Record<MetaTarget, string>> = {
  'governance.policy': 'governor.yaml',
  'evolve.policy': 'evolve.yaml',
};

/** 默认 policy 目录：<preset>/kernel/policy/（相对本模块解析，与 cwd 无关） */
const DEFAULT_POLICY_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'kernel', 'policy');

/** 默认事件库路径（生产缺省；测试注入 temp EventStore） */
const DEFAULT_EVENTS_DB = join(process.cwd(), 'workspace', '.omb', 'events.db');

// ---- 元演化变更对象（brief 已定） ----

export interface MetaChange {
  id: string;
  /** 元层目标（§9.5） */
  target: MetaTarget;
  /** policy 文件内容 diff（before/after） */
  diff: { from: string; to: string };
  proposed_by: string;
  /** 冻结基线对照（T7.1 产物；提案所依据的冻结基线快照） */
  baseline_report?: BenchReport;
  human_review: { required: true; approved?: boolean; reviewed_by?: string };
}

export interface EvaluateMetaChangeDeps {
  /** 当前冻结基线（null = 无冻结基线） */
  frozenBaseline: () => Promise<BenchReport | null>;
  /** 新基线：应用 diff 后运行（调用方负责在应用态运行） */
  runBaseline: () => Promise<BenchReport>;
}

export interface EvaluateResult {
  ok: boolean;
  reason: string;
}

// ---- 纯校验（无 I/O） ----

/** 目标是否合法（§9.5 两个元层目标） */
function isValidTarget(target: string): target is MetaTarget {
  return (META_TARGETS as readonly string[]).includes(target);
}

/** diff 单侧内容校验：YAML 解析 → 对应 policy schema（T2.1 复用）；非法 → detail */
function validateDiffSide(target: MetaTarget, content: string): { ok: boolean; detail?: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    return { ok: false, detail: `YAML 解析失败: ${(e as Error).message}` };
  }
  const schema = POLICY_SCHEMAS[target];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, detail };
  }
  return { ok: true };
}

/** 基准快照 hash（冻结基线对照：同快照同 hash；漂移 = hash 不同） */
function baselineSnapshotHash(report: BenchReport): string {
  return makeImmutableId(canonicalJson(report));
}

/** 回归检测：基线中 passed=true 的任务在新基线缺失或非 true → 回归（fail-closed） */
function findRegressions(baseline: BenchReport, fresh: BenchReport): string[] {
  const freshById = new Map(fresh.results.map((r) => [r.task_id, r.passed]));
  const regressed: string[] = [];
  for (const r of baseline.results) {
    if (!r.passed) continue;
    const p = freshById.get(r.task_id);
    if (p === undefined || p !== true) {
      regressed.push(r.task_id);
    }
  }
  return regressed.sort();
}

// ---- 门禁评估（纯函数：不写状态；幂等） ----

/**
 * 元演化门禁（§9.5）：门禁顺序 无基线 → 回归 → 人工 → 全过。
 * 返回 { ok, reason }；ok=true 时调用方获得应用执行权（applyMetaChange）。
 * 结构性前置：非法 target / diff 不过对应 policy schema 直接拒绝。
 */
export async function evaluateMetaChange(
  change: MetaChange,
  deps: EvaluateMetaChangeDeps,
): Promise<EvaluateResult> {
  // 前置 1：target 合法（tests 5）
  if (!isValidTarget(change.target)) {
    return { ok: false, reason: `invalid_target:${change.target}` };
  }
  // 前置 2：diff 校验（tests 6）——from/to 必须过对应 policy schema（T2.1 复用）
  const fromCheck = validateDiffSide(change.target, change.diff.from);
  if (!fromCheck.ok) {
    return { ok: false, reason: `invalid_diff.from:${fromCheck.detail ?? '非法内容'}` };
  }
  const toCheck = validateDiffSide(change.target, change.diff.to);
  if (!toCheck.ok) {
    return { ok: false, reason: `invalid_diff.to:${toCheck.detail ?? '非法内容'}` };
  }
  // 门禁 1：无冻结基线对照（核心验收：frozenBaseline null 或 change 未附 baseline_report → 拒绝）
  const frozen = await deps.frozenBaseline();
  if (frozen === null) {
    return { ok: false, reason: 'no_frozen_baseline' };
  }
  if (change.baseline_report === undefined) {
    return { ok: false, reason: 'no_baseline_report' };
  }
  // 冻结基线对照：提案依据的基线快照与当前冻结基线 hash 必须一致（基线漂移 → 拒绝）
  if (baselineSnapshotHash(change.baseline_report) !== baselineSnapshotHash(frozen)) {
    return { ok: false, reason: 'frozen_baseline_mismatch' };
  }
  // 门禁 2：基线回归（runBaseline 应用 diff 后；任一任务 true→false → 拒绝）
  const fresh = await deps.runBaseline();
  const regressed = findRegressions(change.baseline_report, fresh);
  if (regressed.length > 0) {
    return { ok: false, reason: `baseline_regression:${regressed.join(',')}` };
  }
  // 门禁 3：人工评审（approve 缺失 → 挂起）
  if (change.human_review.approved !== true) {
    return { ok: false, reason: 'awaiting_human_review' };
  }
  // 全过
  return { ok: true, reason: 'ok' };
}

// ---- 应用（校验通过后：原子写回 policy 文件 + 事件记录） ----

export interface ApplyMetaChangeOpts {
  /** policy 目录（缺省 <preset>/kernel/policy/） */
  policyDir?: string;
  /** 事件库（缺省 workspace/.omb/events.db；测试注入 temp EventStore） */
  eventStore?: EventStore;
  /** 事件 provenance 环境指纹（缺省运行时默认） */
  environment?: Fingerprint;
  /** 时钟注入（事件时间戳；缺省 Date.now ISO） */
  now?: () => string;
}

/**
 * 默认环境指纹（§4.4；R6：dsh_version 经 hostVersion() 读取唯一宿主版本来源（DSH_HOST_VERSION
 * 缺省 / 装配注入覆写）——运行时求值，函数而非常量（模块加载早于装配注入，常量会固化默认值漂移）。
 */
function defaultEnv(): Fingerprint {
  return {
    os: process.platform,
    node: process.version,
    dsh_version: hostVersion(),
    project: 'omb-v2',
  };
}

/** evolution/policy-applied 事件组装（M3 Event 全字段；payload 记录变更审计信息） */
function buildAppliedEvent(change: MetaChange, ts: string, env: Fingerprint): Event {
  return {
    id: makeMutableId('meta-change'),
    ir_version: '2.0',
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'supervisor/evolve-meta',
      event: change.id,
      actor: change.proposed_by,
      environment: env,
      runtime_snapshot: 'rs:evolve-meta',
      timestamp: ts,
      transformation_chain: ['meta-change:apply'],
      verification: 'evolve-meta:gate-passed',
    },
    refs: [],
    type: 'evolution/policy-applied',
    session_id: 'meta',
    runtime_snapshot: 'rs:evolve-meta',
    parent_event: null,
    payload: {
      change_id: change.id,
      target: change.target,
      proposed_by: change.proposed_by,
      reviewed_by: change.human_review.reviewed_by ?? null,
      from: change.diff.from,
      to: change.diff.to,
    },
    timestamp: ts,
  };
}

/**
 * 应用元层变更（校验通过后调用）：防呆守卫（未批准/缺基线/diff 非法/target 非法 → 抛错不写）→
 * 原子写回 policy 文件（内容 = diff.to；tmp+rename）→ 记录 evolution/policy-applied 事件。
 * 并发漂移守卫：目标文件已存在且内容 ≠ diff.from → 抛错不覆盖（diff 语义：from=变更前基线）。
 */
export async function applyMetaChange(change: MetaChange, opts: ApplyMetaChangeOpts = {}): Promise<void> {
  // ---- 防呆守卫（apply 不重复跑门禁 deps，但结构性校验必须过） ----
  if (!isValidTarget(change.target)) {
    throw new Error(`applyMetaChange: 非法 target: ${change.target}`);
  }
  const fromCheck = validateDiffSide(change.target, change.diff.from);
  if (!fromCheck.ok) {
    throw new Error(`applyMetaChange: diff.from 校验失败: ${fromCheck.detail ?? '非法内容'}`);
  }
  const toCheck = validateDiffSide(change.target, change.diff.to);
  if (!toCheck.ok) {
    throw new Error(`applyMetaChange: diff.to 校验失败: ${toCheck.detail ?? '非法内容'}`);
  }
  if (change.baseline_report === undefined) {
    throw new Error('applyMetaChange: 缺冻结基线对照（baseline_report 缺失）');
  }
  if (change.human_review.approved !== true) {
    throw new Error('applyMetaChange: 未获人工评审批准（human_review.approved !== true）');
  }

  // ---- 原子写回 policy 文件（内容 = diff.to；tmp+rename，Windows 同卷原子） ----
  const policyDir = opts.policyDir ?? DEFAULT_POLICY_DIR;
  const file = join(policyDir, TARGET_FILES[change.target]);
  let current: string | null = null;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    current = null; // 文件不存在（首次创建 evolve.yaml 等）
  }
  if (current !== null && current !== change.diff.from) {
    throw new Error('applyMetaChange: 当前 policy 文件与 diff.from 不一致（并发漂移，拒绝覆盖）');
  }
  await mkdir(policyDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, change.diff.to, 'utf8');
  await rename(tmp, file);

  // ---- 事件记录（evolution/policy-applied） ----
  const now = opts.now ?? (() => new Date().toISOString());
  const ts = now();
  const store = opts.eventStore ?? new EventStore(DEFAULT_EVENTS_DB);
  try {
    await store.append(buildAppliedEvent(change, ts, opts.environment ?? defaultEnv()));
  } finally {
    if (opts.eventStore === undefined) {
      await store.close();
    }
  }
}
