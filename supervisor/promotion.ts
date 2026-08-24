// layer 1：P1e 晋升执行与回滚契约（架构 §3.2 promote / §6.5.3 防退化门禁执行 / §6.5.4 晋升决策 /
// §17.2 Activation Contract / 实现规格 §5.4 RollbackContract + §10 Activation 事务）。layer 1。
//
// 职责：
//   - promoteToStable：stable ← trusted-latest 显式门禁推进。门禁判定（shouldPromoteToStable 纯函数）
//     在 kernel/（layer 2）——supervisor 不 import kernel 非 schemas（层 DAG，CONVENTIONS §4）→
//     判定结果由调用方（runtime 层装配）注入（gate: {ok, reasons}），本模块只执行：
//     幂等检查（activation_id 确定性派生，同 commit 对重复推进拒绝）→ 竞态守卫（stable 已前进 → 拒绝）→
//     rollbackTo 原子切换（update-ref + fsync + worktree best-effort——稳定线 worktree 只读 ACL 时
//     degraded 为常态，D1 ⑤ 运行时经 lines 快照物化读取，不依赖 worktree）→ ActivationContract 持久化
//     （M6；activation_scope 为显式字段，由调用方传入——D3 裁决不写死）→ activation/committed +
//     evolution/promoted 事件入链。
//   - rollbackPromotion：RollbackContract {target_snapshot, scope, affected_sessions, restore_plan}
//     （实现规格 §5.4）→ rollbackTo 回退（update-ref stable 回退）→ evolution/rolled_back 事件 +
//     activation-log rolled_back 记录 + 候选 error 池标记（candidates.markError，§3.3
//     error/<组件>/<id>——组件归属 deps.component，缺省 kernel：非组件候选）。
//   - readShadowSignals：.evolution/shadows/（exposure.log + S7 exposure-<date>.jsonl）→ L2 统计输入
//     （n/failures；缺目录/文件 → 空；S7 per-session 条目按 (session,candidate) 键最后一条胜出计数）。
//   - promotionActivationId：激活幂等键确定性派生（dshEventId 风格：dsh:evt:<sha256(stable|candidate)>）。
//
// 层规则：仅 import node: 内置 + kernel/schemas/（IR 契约例外）+ supervisor/ + substrate/。
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { rollbackTo, type WorktreeStatus } from '../substrate/rollback.js';
import { resolveLineCommit, type VersionLayout } from '../substrate/lines.js';
import { makeMutableId } from '../kernel/schemas/base.js';
import type { Fingerprint } from '../kernel/schemas/base.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层例外，supervisor(1) → kernel/schemas/ ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';
import {
  ActivationContractSchema,
  EventSchema,
  type ActivationContract,
  type Event,
} from '../kernel/schemas/m.js';
import {
  clearPending,
  loadCompleted,
  writeCompleted,
  writePending,
  writeRolledBack,
  type PendingMarker,
  type RolledBackRecord,
} from './activation-log.js';
import { CandidatePool } from './candidates.js';
import type { EventStore } from './event-store.js';

// ---- 注入形状（门禁判定为 kernel 纯函数产物——结构上满足；supervisor 不 import kernel 非 schemas） ----

/** 晋升门禁判定结果（kernel/promotion-gate.ts shouldPromoteToStable 产物；调用方注入） */
export interface PromotionGateVerdictLike {
  ok: boolean;
  reasons: string[];
}

/** 冻结基准对照（同 P1d BenchCompare；晋升事件 bench 字段与 G3 同款） */
export interface BenchCompareLike {
  baseline: { passed: number; total: number };
  candidate: { passed: number; total: number };
  cost_degradation_ratio: number;
}

// ---- 激活幂等键（确定性派生，dshEventId 风格：dsh:evt:<sha256>） ----

/**
 * 晋升激活幂等键：`dsh:evt:<sha256(stable_commit|candidate_commit)>`（确定性派生，同 commit 对 → 同 id；
 * 与 runtime/loop-hooks.ts dshEventId 同格式——supervisor 不 import runtime，本地派生等价实现）。
 * 同 commit 对重复推进 → 同 activation_id → 幂等拒绝（§11.3 Activation 事务幂等键）。
 */
export function promotionActivationId(stableCommit: string, candidateCommit: string): string {
  const hash = createHash('sha256').update(`${stableCommit}|${candidateCommit}`, 'utf8').digest('hex');
  return `dsh:evt:${hash}`;
}

// ---- 晋升执行 ----

export interface PromoteToStableInput {
  /** 门禁判定结果（kernel 纯函数产物；ok=false → 不推进，返回 reasons） */
  gate: PromotionGateVerdictLike;
  /** trusted-latest commit（晋升目标） */
  candidate_commit: string;
  /** 当前 stable commit（调用方解析；切换前校验——竞态守卫） */
  stable_commit: string;
  /** 冻结基准对照（事件 bench 字段） */
  bench: BenchCompareLike;
  /** P1d Evolution Object 链头（.evolution-objects/；evolution/promoted 事件引用；可选） */
  object_id?: string;
  /** 候选 id（事件引用/回滚 error 池键；可选） */
  candidate_id?: string;
  /** M6 activation_scope（显式字段——调用方传入，D3 裁决不写死；生产 = 'project'） */
  activation_scope: string;
  /** M6 compatible_schema（缺省 'policy/v1'） */
  compatible_schema?: string;
}

export interface PromoteToStableDeps {
  layout: VersionLayout;
  /** activation-log 持久化目录（提供 → pending→completed 落盘 + 磁盘幂等权威；缺省 → 仅当前 head 幂等） */
  activationLogDir?: string;
  eventStore?: EventStore;
  sessionId?: string;
  snapshotHash?: string;
}

export interface PromoteToStableResult {
  promoted: boolean;
  /** 幂等键（确定性派生；成功/已存在时提供） */
  activation_id?: string;
  /** 完成的 ActivationContract（成功时提供） */
  contract?: ActivationContract;
  /** 切换后 stable head（成功时 = candidate_commit） */
  stable_commit?: string;
  /** worktree 同步状态（成功时；best-effort——只读 ACL → degraded 常态） */
  worktree_status?: WorktreeStatus;
  /** 失败/重复原因（门禁未过 / duplicate / 竞态；成功且事件入链失败时 = 告警说明） */
  reason?: string;
}

/**
 * 默认环境指纹（R6：dsh_version 经 hostVersion() 读取唯一宿主版本来源——运行时求值，
 * 装配注入后 = 注入值；缺省 = DSH_HOST_VERSION。函数而非常量——模块加载早于装配注入，
 * 常量会在注入前固化默认值造成漂移）。
 */
function defaultEnvironment(): Fingerprint {
  return {
    os: process.platform,
    node: process.version,
    dsh_version: hostVersion(),
    project: 'omb-v2',
  };
}

/** 晋升 provenance（事件/契约共用）；snapshotHash 缺省 'rs:assembly' */
function provenanceOf(verification: string, snapshotHash: string | undefined) {
  const ts = new Date().toISOString();
  return {
    source: 'supervisor/promotion',
    event: 'activation/committed',
    actor: 'system',
    environment: defaultEnvironment(),
    runtime_snapshot: snapshotHash ?? 'rs:assembly',
    timestamp: ts,
    transformation_chain: ['candidate-pipeline', 'promotion-gate', 'promote'],
    verification,
  };
}

/** activation/committed 事件（M3；payload 含 activation_id/commit 对/scope） */
function buildCommittedEvent(
  contract: ActivationContract,
  deps: { sessionId?: string; snapshotHash?: string },
): Event {
  const ts = new Date().toISOString();
  const ev: Event = {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: provenanceOf('promotion-gate', deps.snapshotHash),
    refs: [],
    type: 'activation/committed',
    session_id: deps.sessionId ?? 'system',
    runtime_snapshot: deps.snapshotHash ?? 'rs:assembly',
    parent_event: null,
    payload: {
      activation_id: contract.id,
      predecessor: contract.predecessor,
      candidate: contract.candidate,
      rollback_snapshot: contract.rollback_snapshot,
      scope: contract.activation_scope,
      evidence: contract.evidence_certificate,
    },
    timestamp: ts,
  };
  const checked = EventSchema.safeParse(ev);
  if (!checked.success) {
    throw new Error(`activation/committed 事件构造失败（EventSchema）: ${checked.error.message}`);
  }
  return ev;
}

/** evolution/promoted（stable 晋升；payload 引用 P1d Evolution Object 链头 + activation_id） */
function buildPromotedEvent(
  input: PromoteToStableInput,
  activationId: string,
  deps: { sessionId?: string; snapshotHash?: string },
): Event {
  const ts = new Date().toISOString();
  const ev: Event = {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      ...provenanceOf('promotion-gate', deps.snapshotHash),
      event: 'evolution/promoted',
    },
    refs: [],
    type: 'evolution/promoted',
    session_id: deps.sessionId ?? 'system',
    runtime_snapshot: deps.snapshotHash ?? 'rs:assembly',
    parent_event: null,
    payload: {
      stage: 'stable',
      object_id: input.object_id ?? null,
      candidate_id: input.candidate_id ?? null,
      commit: input.candidate_commit,
      predecessor: input.stable_commit,
      activation_id: activationId,
      scope: input.activation_scope,
      bench: JSON.stringify(input.bench),
    },
    timestamp: ts,
  };
  const checked = EventSchema.safeParse(ev);
  if (!checked.success) {
    throw new Error(`evolution/promoted 事件构造失败（EventSchema）: ${checked.error.message}`);
  }
  return ev;
}

/**
 * stable ← trusted-latest 显式门禁推进（§3.2 promote + §6.5.3 防退化 + §17.2 Activation Contract）：
 * ① 门禁判定（注入）未过 → 不推进，返回 reasons（候选保持 trusted-latest，等待下次检查）；
 * ② 幂等（同 commit 对重复推进拒绝）→ 竞态守卫（stable 已前进 ≠ 预期 predecessor → 拒绝）；
 * ③ pending 标记（crash-window）→ rollbackTo 原子切换（update-ref + fsync + worktree best-effort）→
 *    ActivationContract（M6：predecessor/rollback_snapshot = 旧 stable）→ completed 落盘 + 清 pending →
 *    activation/committed + evolution/promoted 事件入链。
 * 失败即返回 {promoted:false, reason}（git 错误 → reason 含失败详情；不抛——调用方摘要可读）。
 */
export async function promoteToStable(
  input: PromoteToStableInput,
  deps: PromoteToStableDeps,
): Promise<PromoteToStableResult> {
  try {
    // ① 门禁判定（kernel 纯函数产物；未过 → 不推进）
    if (!input.gate.ok) {
      return {
        promoted: false,
        reason: `门禁未通过——不推进（候选保持 trusted-latest，等待下次检查）: ${input.gate.reasons.join('；')}`,
      };
    }
    const activationId = promotionActivationId(input.stable_commit, input.candidate_commit);

    // ② 幂等 + 竞态守卫（当前 stable head 权威判定）
    const currentStable = resolveLineCommit(deps.layout, 'stable');
    if (currentStable === input.candidate_commit) {
      return { promoted: false, activation_id: activationId, reason: 'duplicate（stable 已是该 commit——已晋升）' };
    }
    if (currentStable !== input.stable_commit) {
      return {
        promoted: false,
        activation_id: activationId,
        reason: `竞态守卫: stable 当前 ${currentStable.slice(0, 12)} ≠ 预期 predecessor ${input.stable_commit.slice(0, 12)}（已前进/分叉）——不覆盖，等待下次检查`,
      };
    }
    if (deps.activationLogDir !== undefined) {
      const disk = loadCompleted(deps.activationLogDir, activationId);
      if (disk !== null) {
        return { promoted: false, activation_id: activationId, reason: 'duplicate（activation_id 已 completed）' };
      }
    }

    // ③ pending 标记（切换前落盘；crash-window 重试判定——同 activation.ts 语义）
    const pending: PendingMarker = {
      activation_id: activationId,
      candidate: input.candidate_commit,
      predecessor: input.stable_commit,
      rollback_snapshot: input.stable_commit,
      started_at: Date.now(),
    };
    if (deps.activationLogDir !== undefined) {
      writePending(deps.activationLogDir, pending);
    }

    // ④ 原子切换（rollbackTo：update-ref 原子 + fsync + worktree best-effort——稳定线只读 ACL → degraded 常态）
    const switched = rollbackTo({
      bareRepo: deps.layout.bareRepo,
      revision: input.candidate_commit,
      branch: 'stable',
      worktree: deps.layout.stableWorktree,
      worktreePolicy: 'best-effort',
      fsync: true,
      gitBin: deps.layout.gitBin,
    });

    // ⑤ ActivationContract（M6；predecessor/rollback_snapshot = 旧 stable；activation_scope 显式字段）
    const now = new Date().toISOString();
    const contract: ActivationContract = {
      id: activationId,
      ir_version: '2.0',
      schema: 'omb/M6',
      scope: 'Project',
      lifecycle: 'active',
      immutable: false,
      owner: 'kernel',
      created: now,
      updated: now,
      provenance: provenanceOf('promotion-gate', deps.snapshotHash),
      refs: [],
      predecessor: input.stable_commit,
      candidate: input.candidate_commit,
      required_capabilities: [],
      evidence_certificate: 'promotion-gate',
      compatible_schema: input.compatible_schema ?? 'policy/v1',
      activation_scope: input.activation_scope,
      rollback_snapshot: input.stable_commit,
    };
    ActivationContractSchema.parse(contract); // M6 fail-loud（不合规不落盘）

    // ⑥ completed 落盘 + 清 pending
    if (deps.activationLogDir !== undefined) {
      writeCompleted(deps.activationLogDir, activationId, contract);
      clearPending(deps.activationLogDir, activationId);
    }

    // ⑦ 事件入链（尽力而为：入链失败不撤销已切换 ref——事件为日志）
    let reason: string | undefined;
    if (deps.eventStore !== undefined) {
      try {
        await deps.eventStore.append(
          buildCommittedEvent(contract, { sessionId: deps.sessionId, snapshotHash: deps.snapshotHash }),
        );
        await deps.eventStore.append(
          buildPromotedEvent(input, activationId, { sessionId: deps.sessionId, snapshotHash: deps.snapshotHash }),
        );
      } catch (err) {
        reason = `事件入链失败（${(err as Error).message}）——stable 切换与契约已生效`;
      }
    }
    return {
      promoted: true,
      activation_id: activationId,
      contract,
      stable_commit: switched.new_head,
      worktree_status: switched.worktree_status,
      reason,
    };
  } catch (err) {
    return { promoted: false, reason: `晋升失败: ${(err as Error).message}` };
  }
}

// ---- 回滚契约（实现规格 §5.4 RollbackContract + §10 Activation 恢复 rollback_snapshot） ----

/** RollbackContract（§5.4：{ target_snapshot, scope, affected_sessions, restore_plan }） */
export interface RollbackContractLike {
  target_snapshot: string;
  scope: string;
  affected_sessions: string[];
  restore_plan: string[];
}

export interface RollbackPromotionDeps {
  layout: VersionLayout;
  /** activation-log 目录（completed 记录源 + rolled_back 落盘） */
  activationLogDir?: string;
  eventStore?: EventStore;
  sessionId?: string;
  snapshotHash?: string;
  /** 候选信任池根（提供 + candidate_id/object_id → 回滚对象入 error 池，§3.3） */
  evolutionRoot?: string;
  /** 回滚对象候选 id（error 池键；可选） */
  candidate_id?: string;
  /** 回滚对象 Evolution Object id（error 池键回退；可选） */
  object_id?: string;
  /** S6：回滚对象组件归属（markError 归档 error/<component>/<id>；缺省 kernel——非组件候选，
   *  候选 provenance.component 解析由 CandidatePool 内部兜底） */
  component?: string;
  /** RollbackContract.affected_sessions（P1b 收集面 = 快照 registry 活跃请求绑定，调用方收集；缺省 []） */
  affectedSessions?: string[];
  /** 显式传入契约（无 activationLogDir 时）；缺省从 activationLogDir 读 completed */
  contract?: ActivationContract;
}

export interface RollbackPromotionResult {
  rolled_back: boolean;
  contract: RollbackContractLike;
  previous_head: string;
  new_head: string;
  worktree_status?: WorktreeStatus;
  /** 非致命告警（如 error 池标记未执行——缺候选 id/信任池根） */
  warning?: string;
}

/** evolution/rolled_back 事件（M3；payload 含 activation_id/from/to/reason/契约） */
function buildRolledBackEvent(
  activationId: string,
  contract: RollbackContractLike,
  from: string,
  to: string,
  reason: string,
  deps: { sessionId?: string; snapshotHash?: string },
): Event {
  const ts = new Date().toISOString();
  const ev: Event = {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      ...provenanceOf('rollback-contract', deps.snapshotHash),
      event: 'evolution/rolled_back',
    },
    refs: [],
    type: 'evolution/rolled_back',
    session_id: deps.sessionId ?? 'system',
    runtime_snapshot: deps.snapshotHash ?? 'rs:assembly',
    parent_event: null,
    payload: {
      activation_id: activationId,
      from,
      to,
      reason,
      contract,
    },
    timestamp: ts,
  };
  const checked = EventSchema.safeParse(ev);
  if (!checked.success) {
    throw new Error(`evolution/rolled_back 事件构造失败（EventSchema）: ${checked.error.message}`);
  }
  return ev;
}

/**
 * 晋升回滚（实现规格 §5.4 回滚契约 + §10 Activation 恢复 rollback_snapshot）：
 * ① 契约解析（显式传入或 activationLogDir completed；rollback_snapshot = 旧 stable commit）；
 * ② RollbackContract {target_snapshot=rollback_snapshot, scope='project', affected_sessions（调用方收集）,
 *    restore_plan='update-ref stable 回退 + worktree checkout'}；
 * ③ rollbackTo 执行（update-ref 原子回退 + fsync + worktree best-effort）；
 * ④ evolution/rolled_back 事件 + activation-log rolled_back 记录（from→to/reason/候选与对象 id）；
 * ⑤ 候选 error 池标记（candidates.markError——保留 payload/provenance/出错信号，
 *    §3.3 error/<组件>/<id>，组件归属 deps.component 缺省 kernel）。
 * 失败（缺契约/rollbackTo 抛错）→ fail-loud（抛错；不静默——回滚失败必须可见）。
 */
export async function rollbackPromotion(
  activationId: string,
  reason: string,
  deps: RollbackPromotionDeps,
): Promise<RollbackPromotionResult> {
  // ① 契约解析（rollback_snapshot = 回退目标）
  let contract: ActivationContract;
  if (deps.contract !== undefined) {
    contract = deps.contract;
  } else if (deps.activationLogDir !== undefined) {
    const disk = loadCompleted(deps.activationLogDir, activationId);
    if (disk === null) {
      throw new Error(`rollbackPromotion: activation ${activationId} 无 completed 记录（无法确定 rollback_snapshot）`);
    }
    contract = disk;
  } else {
    throw new Error('rollbackPromotion: 需提供 contract 或 activationLogDir（completed 记录源）');
  }
  const target = contract.rollback_snapshot;
  const from = contract.candidate;

  // ② RollbackContract（§5.4）
  const rollbackContract: RollbackContractLike = {
    target_snapshot: target,
    scope: 'project',
    affected_sessions: deps.affectedSessions ?? [],
    restore_plan: [
      `update-ref refs/heads/stable ${target.slice(0, 12)}（原子回退）`,
      'worktree checkout --force <target>（best-effort——稳定线只读 ACL 时 degraded 常态）',
    ],
  };

  // ③ rollbackTo 执行（Recovery Root 原语：update-ref + fsync + worktree best-effort）
  const switched = rollbackTo({
    bareRepo: deps.layout.bareRepo,
    revision: target,
    branch: 'stable',
    worktree: deps.layout.stableWorktree,
    worktreePolicy: 'best-effort',
    fsync: true,
    gitBin: deps.layout.gitBin,
  });

  // ④ 事件 + activation-log rolled_back 记录
  if (deps.eventStore !== undefined) {
    await deps.eventStore.append(
      buildRolledBackEvent(activationId, rollbackContract, from, target, reason, {
        sessionId: deps.sessionId,
        snapshotHash: deps.snapshotHash,
      }),
    );
  }
  let warning: string | undefined;
  if (deps.activationLogDir !== undefined) {
    const record: RolledBackRecord = {
      activation_id: activationId,
      from,
      to: target,
      reason,
      candidate_id: deps.candidate_id,
      object_id: deps.object_id,
      ts: Date.now(),
    };
    writeRolledBack(deps.activationLogDir, record);
  }

  // ⑤ 候选 error 池标记（§3.3 error/<id>/；缺候选 id/信任池根 → 告警（回滚本身已生效））
  const errorKey = deps.candidate_id ?? deps.object_id;
  if (deps.evolutionRoot !== undefined && errorKey !== undefined) {
    try {
      const pool = new CandidatePool(deps.evolutionRoot);
      await pool.markError(errorKey, `rollbackPromotion(${activationId}): ${reason}`, { component: deps.component });
    } catch (err) {
      warning = `error 池标记失败（${(err as Error).message}）——回滚已生效，仅归档缺失`;
    }
  } else if (deps.evolutionRoot !== undefined) {
    warning = '未提供 candidate_id/object_id——回滚对象未入 error 池（仅事件与 rolled_back 记录留痕）';
  }

  return {
    rolled_back: true,
    contract: rollbackContract,
    previous_head: switched.previous_head,
    new_head: switched.new_head,
    worktree_status: switched.worktree_status,
    warning,
  };
}

// ---- L2 统计输入（.evolution/shadows/exposure.log） ----

/** L2 shadow 统计输入（n=曝光样本数 / failures=失败样本数；n=0 → 无 shadow 数据不阻塞） */
export interface ShadowSignalsLike {
  n: number;
  failures: number;
}

/**
 * 读取 shadow exposure 日志（JSONL）→ L2 统计输入（n=曝光样本数 / failures=失败样本数；n=0 → 无 shadow 数据不阻塞）。
 * 入参为**文件路径** → 读该文件（既有契约）；为**目录**（S7：.evolution/shadows/）→ 扫描目录内
 * exposure*.log / exposure*.jsonl（既有 exposure.log + S7 按日分片 exposure-<date>.jsonl 一并纳入，排序确定性）。
 * 计数语义（双格式并存，不重复计数）：
 *   - 既有条目（decision 字段，T5.3/G4 格式）：n = decision ∈ shadow/canary/control/skip/canary_rollback；
 *     failures = canary_rollback（回滚触发 = 失败后验）或 outcome=restore_failed 条目；
 *   - S7 per-session 条目（{candidate_id, bucket, session_id, task_domain, exposure_ts, outcome}，无 decision）：
 *     按 (session_id, candidate_id) 键**最后一条胜出**——exposure 占位（outcome='pending'）被 finalizeTurn
 *     回写的 success/degraded 覆盖（同键不重复计数）；n = 键数（有曝光即计入），failures = 最终
 *     outcome='degraded' 的键数（outcome='pending' 仅曝光未收尾 → 计入 n 不计失败——诚实保守）。
 * 文件/目录缺失或不可读 → {n:0, failures:0}（无 shadow 数据，以基准门禁为准——不抛）；单行损坏跳过（读取面降级）。
 */
export async function readShadowSignals(logPathOrDir: string): Promise<ShadowSignalsLike> {
  const raw = await readShadowRaw(logPathOrDir);
  let n = 0;
  let failures = 0;
  const sessionOutcomes = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let entry: { decision?: string; outcome?: string; session_id?: string; candidate_id?: string };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue; // 单行损坏跳过（审计日志不为判定器抛错）
    }
    if (entry.decision !== undefined) {
      // 既有条目（T5.3/G4 格式）——原计数语义
      if (entry.decision === 'canary_rollback' || entry.outcome === 'restore_failed') {
        failures += 1;
        n += 1;
      } else if (
        entry.decision === 'shadow' ||
        entry.decision === 'canary' ||
        entry.decision === 'control' ||
        entry.decision === 'skip'
      ) {
        n += 1;
      }
      continue;
    }
    // S7 per-session 条目——(session_id, candidate_id) 键最后一条胜出（outcome 回写覆盖占位）
    if (
      typeof entry.session_id === 'string' &&
      typeof entry.candidate_id === 'string' &&
      typeof entry.outcome === 'string'
    ) {
      sessionOutcomes.set(`${entry.session_id}|${entry.candidate_id}`, entry.outcome);
    }
  }
  for (const outcome of sessionOutcomes.values()) {
    n += 1;
    if (outcome === 'degraded') {
      failures += 1;
    }
  }
  return { n, failures };
}

/** 读取 exposure 日志原文：目录 → 扫描 exposure*.log/exposure*.jsonl（排序）拼接；文件 → 读文件；缺失/不可读 → '' */
async function readShadowRaw(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      const names = (await readdir(path))
        .filter((f) => /^exposure.*\.(jsonl|log)$/.test(f))
        .sort();
      const parts: string[] = [];
      for (const name of names) {
        try {
          parts.push(await readFile(join(path, name), 'utf8'));
        } catch {
          // 单文件不可读跳过（读取面降级）
        }
      }
      return parts.join('\n');
    }
    return await readFile(path, 'utf8');
  } catch {
    return ''; // 缺失/不可读 → 无 shadow 数据（不抛）
  }
}

/** shadow exposure log 相对 .evolution 的路径约定（与 candidate-pipeline G4 落盘一致） */
export const SHADOW_LOG_REL = join('shadows', 'exposure.log');
