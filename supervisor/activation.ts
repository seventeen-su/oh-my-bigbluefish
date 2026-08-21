// OMB v2 Activation 原子切换（架构 §9.4 晋升与回滚 / §4.2 M4+M6 / §11.3 事务模型；施工计划 T5.5）：layer 1。
//
// 设计（brief 已定 + 实现选择，DAG 记录）：
// - 层 DAG（CONVENTIONS §4）：supervisor 不 import runtime。能力向量评估/分类经 deps 注入
//   （runtime/evolution-evaluator.ts 的 evaluate/classify 由调用方绑定证据序列后注入；
//   deps.evaluate(target) 返回结构上满足 CapabilityVectorLike 的向量——契约例外只放行 kernel/schemas）。
// - 流程：幂等检查 → 污染守卫（谱系含 untrusted 拒绝）→ evaluate+classify（Regressed/Unknown 拒晋升）
//   → 切换前快照捕获（rollback_snapshot）→ 原子切换（Recovery Root 注入，T0.4 rollbackTo 语义）
//   → ActivationContract 组装（M6 schema 校验 fail-loud）→ EvolutionObject 落 git（M4，id=sha256(内容)）
//   → SnapshotRegistry.promote（T1.6：新请求用新快照，进行中请求不受影响）→ activation/committed 事件入链
//   （T8.7：修复 P7 事实源断链）→ 记录幂等键。
// - 幂等（T8.7 持久化）：logDir 提供时完成记录落盘（completed/<activation_id>.json，tmp+rename 原子写），
//   重启后同 id 重复 activate → 磁盘恢复契约 no-op；无 logDir → 进程内 Map（m5 语义保持）。
// - crash-window retry hazard（T5.5 评审 Minor 1，T8.7 一并处理）：切换前写 pending 标记
//   （pending/<activation_id>.json：candidate/predecessor/rollback_snapshot）；重试时 pending 存在：
//   current head == pending.candidate → 上次尝试已完成切换（崩溃在切换后）→ 恢复完成剩余步骤（不重复 switch）；
//   head != candidate → 未切换 → 清理 pending 从头执行。rollback 增加断言：current head != contract.candidate
//   → fail-loud（不盲目回退已分叉/已回退状态）。
// - 污染回滚：已激活对象发现污染 → rollback(contract, deps) 调 switchStableHead(predecessor)。
// - 事务顺序（brief 已定）：switch → write EvolutionObject → promote。失败恢复走 rollback_snapshot/分支回退。
// - 激活门禁 = ACTIVATION_GATE：Regressed（brief 硬性：回归拒晋升）+ Unknown（§10.1 样本不足→延后/降级）。
// layer 1（supervisor/）：仅 import node: 内置 + kernel/schemas/（IR 契约例外）+ supervisor/ 内文件。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, makeImmutableId, makeMutableId } from '../kernel/schemas/base.js';
import type { Fingerprint } from '../kernel/schemas/base.js';
import {
  ActivationContractSchema,
  EvolutionObjectSchema,
  type ActivationContract,
  type Event,
  type EvolutionObject,
  type RuntimeSnapshot,
} from '../kernel/schemas/m.js';
import type { CandidateRecord } from './candidates.js';
import type { SnapshotRegistry } from './versioning.js';

// ---- 注入形状（supervisor 不 import runtime——层 DAG；runtime 侧 CapabilityVector 结构上满足） ----

/** 注入评估结果的维度事实最小形状 */
export interface VectorFactLike {
  dimension: string;
  value: number | null;
  sample_size: number;
}

/** 注入评估结果的能力向量最小形状（runtime/evolution-evaluator.ts 的 CapabilityVector 可赋值） */
export interface CapabilityVectorLike {
  id: string;
  target: string;
  facts: VectorFactLike[];
  classification: string;
}

/** 依赖注入（Recovery Root / git / SnapshotRegistry / 评估器 / 信任池 / 持久化 / 事件） */
export interface ActivationDeps {
  /** Recovery Root 注入（T0.4 rollbackTo 语义）：stable_head = candidate_hash 原子切换；返回切换前后 head */
  switchStableHead(candidateHash: string): Promise<{ previous: string; new: string }> | { previous: string; new: string };
  /** Evolution Object 落 git（versions.git；内容寻址幂等——同内容同 id） */
  writeEvolutionObject(obj: EvolutionObject): Promise<void> | void;
  /** Runtime Snapshot 注册表（T1.6）：promote 新快照——新请求用新快照，进行中请求不受影响 */
  snapshotRegistry: SnapshotRegistry;
  /** 激活后快照构建器（新 stable_head 对应 RuntimeSnapshot；注入——supervisor 不知组件哈希） */
  nextSnapshot(): RuntimeSnapshot;
  /** 能力向量评估（注入——调用方绑定证据序列，target=候选 id；返回向量结构满足 CapabilityVectorLike） */
  evaluate(target: string): CapabilityVectorLike;
  /** 分类（注入；对照基线，产出 §10.1 七分类字符串） */
  classify(v: CapabilityVectorLike, baseline: CapabilityVectorLike): string;
  /** 谱系/信任守卫（T5.1 注入；候选谱系含 untrusted → ok:false 即拒绝，污染隔离 §9.3/P11） */
  checkLineage(rec: CandidateRecord): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  /** 当前 stable head（T8.7：crash-window 恢复判定 + predecessor 记录 + rollback 断言；logDir/pending 路径必需） */
  currentStableHead?(): string | Promise<string>;
  /** Event Store 追加（T8.7 注入：activation/committed 事件入链，修复 P7 事实源断链） */
  eventStore?: { append(e: Event): Promise<void> };
}

/** 激活输入（brief opts + 事务幂等键 + M6/M4 契约字段；激活所需评估经 deps 注入） */
export interface ActivationInput {
  /** 幂等键（§11.3 Activation 事务）：同 activation_id 重复 activate → no-op */
  activation_id: string;
  /** 候选记录（信任池；谱系检查在 activate 内执行） */
  candidate: CandidateRecord;
  /** 证据证书（验证链产物，§9.2/§10.1） */
  evidence_certificate: string;
  /** 激活作用域（M6 activation_scope） */
  activation_scope: string;
  /** 兼容 schema（M6 compatible_schema；同时落入 M4 compat） */
  compatible_schema: string;
  /** 当前稳定能力向量（分类对照基线） */
  baseline: CapabilityVectorLike;
  /** M4 diff（候选 vs stable；缺省 `candidate:<id>`） */
  diff?: string;
  /** M4 bench 引用（缺省 'none'） */
  bench?: string;
  /** M4 spdx（缺省 'UNLICENSED'） */
  spdx?: string;
  /** provenance 环境指纹（缺省运行时默认） */
  environment?: Fingerprint;
  /**
   * 持久化日志目录（T8.7；缺省无 = 进程内 Map，m5 语义）。
   * 提供时：completed/<activation_id>.json（完成记录）+ pending/<activation_id>.json（切换前标记，
   * crash-window retry hazard）均落此，tmp+rename 原子写。
   */
  logDir?: string;
  deps: ActivationDeps;
}

/** 激活门禁：Regressed（回归，brief 硬性拒晋升）+ Unknown（§10.1 样本不足→延后/降级） */
export const ACTIVATION_GATE: ReadonlySet<string> = new Set(['Regressed', 'Unknown']);

/** 默认环境指纹（§4.4；与 versioning.ts 同款运行时默认） */
const DEFAULT_ENVIRONMENT: Fingerprint = {
  os: process.platform,
  node: process.version,
  dsh_version: '0.1.0',
  project: 'omb-v2',
};

/** 进程内幂等注册表（无 logDir 时的幂等权威；有 logDir 时磁盘为权威，此表为缓存） */
const completed = new Map<string, ActivationContract>();

/** 清空进程内幂等注册表（测试隔离；logDir 磁盘记录不受影响） */
export function resetActivationLog(): void {
  completed.clear();
}

// ---- T8.7 持久化（tmp+rename 原子写；completed/pending 双目录） ----

interface PendingMarker {
  activation_id: string;
  candidate: string;
  predecessor: string;
  rollback_snapshot: string;
  started_at: number;
}

function completedFile(logDir: string, id: string): string {
  return join(logDir, 'completed', `${id}.json`);
}

function pendingFile(logDir: string, id: string): string {
  return join(logDir, 'pending', `${id}.json`);
}

/** 原子写 JSON（tmp + rename，§11.3 crash consistency 同款语义） */
function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function loadCompleted(logDir: string, id: string): ActivationContract | null {
  try {
    const raw = readFileSync(completedFile(logDir, id), 'utf8');
    return JSON.parse(raw) as ActivationContract;
  } catch {
    return null;
  }
}

function writeCompleted(logDir: string, id: string, contract: ActivationContract): void {
  atomicWriteJson(completedFile(logDir, id), contract);
}

function loadPending(logDir: string, id: string): PendingMarker | null {
  try {
    const raw = readFileSync(pendingFile(logDir, id), 'utf8');
    return JSON.parse(raw) as PendingMarker;
  } catch {
    return null;
  }
}

function writePending(logDir: string, marker: PendingMarker): void {
  atomicWriteJson(pendingFile(logDir, marker.activation_id), marker);
}

function clearPending(logDir: string, id: string): void {
  rmSync(pendingFile(logDir, id), { force: true });
}

// ---- activation/committed 事件（T8.7 事件入链；M3 schema） ----

/** 构造 activation/committed 事件（事件 id 为可变 uuid；幂等由 completed 检查保证，不重复 append） */
function makeActivationEvent(
  contract: ActivationContract,
  input: ActivationInput,
  classification: string,
): Event {
  const ts = new Date().toISOString();
  const env = input.environment ?? DEFAULT_ENVIRONMENT;
  return {
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
      source: 'supervisor/activation',
      event: 'activation/committed',
      actor: 'system',
      environment: env,
      runtime_snapshot: contract.rollback_snapshot,
      timestamp: ts,
      transformation_chain: ['activate'],
      verification: `classification:${classification}`,
    },
    refs: [],
    type: 'activation/committed',
    session_id: 'system',
    runtime_snapshot: contract.rollback_snapshot,
    parent_event: null,
    payload: {
      activation_id: input.activation_id,
      candidate: input.candidate.id,
      predecessor: contract.predecessor,
      rollback_snapshot: contract.rollback_snapshot,
      classification,
    },
    timestamp: ts,
  };
}

/**
 * 演化晋升原子切换：能力向量评估+分类（非 Regressed/Unknown）→ 污染守卫 → 原子切换 → 契约/进化对象落库
 * → 快照晋升 → 事件入链 → 幂等键记录（持久化）。
 * 返回 M6 ActivationContract（predecessor=切换前 stable_head；rollback_snapshot=切换前快照）。
 */
export async function activate(input: ActivationInput): Promise<ActivationContract> {
  // ① 幂等检查：logDir → 磁盘为权威（重启恢复）；无 logDir → 进程内 Map（m5 语义）
  if (input.logDir !== undefined) {
    const disk = loadCompleted(input.logDir, input.activation_id);
    if (disk !== null) {
      completed.set(input.activation_id, disk);
      return disk;
    }
  }
  const existing = completed.get(input.activation_id);
  if (existing !== undefined) {
    return existing; // 幂等：同 activation_id 重复 → no-op（switch/write/promote 不再执行）
  }

  // ② 污染守卫（P11/§9.3）：候选谱系含 untrusted → 拒绝（T5.1 checkLineage 注入）
  const lineage = await input.deps.checkLineage(input.candidate);
  if (!lineage.ok) {
    throw new Error(`activation 拒绝（污染隔离 §9.3）: ${lineage.reason ?? '候选谱系含 untrusted'}`);
  }

  // ③ 能力向量评估 + 分类（§10.1 无总裁判；评估器经注入——supervisor 不 import runtime，层 DAG）
  const vector = input.deps.evaluate(input.candidate.id);
  const classification = input.deps.classify(vector, input.baseline);
  if (ACTIVATION_GATE.has(classification)) {
    const why = classification === 'Regressed' ? '回归（regression 维低于基线）' : '样本不足（Unknown，§10.1 延后/降级）';
    throw new Error(`activation 拒绝晋升: 分类 ${classification} — ${why}`);
  }

  // ④ crash-window 恢复判定（T5.5 Minor 1）：pending 存在时——
  //    current head == pending.candidate → 上次尝试已完成切换（崩溃在切换后）→ 恢复完成剩余步骤；
  //    head != candidate → 未切换 → 清理 pending 从头执行。
  let resumed = false;
  let pending: PendingMarker | null = null;
  let rollbackSnapshot = input.deps.snapshotRegistry.currentSnapshot.id;
  let predecessor = '';
  if (input.logDir !== undefined) {
    pending = loadPending(input.logDir, input.activation_id);
    if (pending !== null) {
      if (input.deps.currentStableHead === undefined) {
        throw new Error(
          `activation: 存在未决 pending（crash-window）但未注入 currentStableHead，无法安全恢复: ${input.activation_id}`,
        );
      }
      const head = await input.deps.currentStableHead();
      if (head === pending.candidate) {
        resumed = true;
        predecessor = pending.predecessor;
        rollbackSnapshot = pending.rollback_snapshot; // 切换前快照以 pending 记录为准
      } else {
        clearPending(input.logDir, input.activation_id);
      }
    }
  }

  // ⑤ 原子切换（未恢复时执行；Recovery Root 注入，T0.4 rollbackTo 语义；§11.3 Activation 恢复 = rollback_snapshot）。
  //    pending 标记在切换前落盘（crash-window：崩溃后重试可判定切换是否已发生）。
  if (!resumed) {
    if (input.logDir !== undefined) {
      if (input.deps.currentStableHead === undefined) {
        throw new Error(`activation: logDir 持久化需注入 currentStableHead（predecessor/pending 记录）: ${input.activation_id}`);
      }
      predecessor = await input.deps.currentStableHead();
      writePending(input.logDir, {
        activation_id: input.activation_id,
        candidate: input.candidate.id,
        predecessor,
        rollback_snapshot: rollbackSnapshot,
        started_at: Date.now(),
      });
    }
    const switched = await input.deps.switchStableHead(input.candidate.id);
    if (predecessor === '') {
      predecessor = switched.previous; // 无 logDir：沿用旧语义（switch 返回切换前 head）
    }
  }

  const ts = new Date().toISOString();
  const env = input.environment ?? DEFAULT_ENVIRONMENT;

  // ⑥ ActivationContract 组装（M6；predecessor = 切换前 stable_head）
  const contract: ActivationContract = {
    id: makeMutableId('activation'),
    ir_version: '2.0',
    schema: 'omb/M6',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'supervisor/activation',
      event: `activation/${input.activation_id}`,
      actor: 'system',
      environment: env,
      runtime_snapshot: rollbackSnapshot,
      timestamp: ts,
      transformation_chain: [],
      verification: `classification:${classification}`,
    },
    refs: [],
    predecessor,
    candidate: input.candidate.id,
    required_capabilities: [input.candidate.kind],
    evidence_certificate: input.evidence_certificate,
    compatible_schema: input.compatible_schema,
    activation_scope: input.activation_scope,
    rollback_snapshot: rollbackSnapshot,
  };
  ActivationContractSchema.parse(contract); // fail-loud：契约不合 M6 schema 绝不外发

  // ⑦ EvolutionObject 落 git（M4：id=sha256(内容)/protocol_version/parent/diff/compat/bench/provenance/spdx/verifications）
  const evoBody: Omit<EvolutionObject, 'id'> = {
    ir_version: '2.0',
    schema: 'omb/M4',
    scope: 'Project',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: contract.provenance,
    refs: [],
    protocol_version: '2.0',
    parent: input.candidate.parent,
    diff: input.diff ?? `candidate:${input.candidate.id}`,
    compat: input.compatible_schema,
    bench: input.bench ?? 'none',
    spdx: input.spdx ?? 'UNLICENSED',
    verifications: [
      ...new Set([input.evidence_certificate, ...input.candidate.gates_passed, `classification:${classification}`]),
    ],
  };
  const evo: EvolutionObject = {
    ...evoBody,
    id: makeImmutableId(canonicalJson(evoBody)),
  };
  EvolutionObjectSchema.parse(evo); // fail-loud
  await input.deps.writeEvolutionObject(evo);

  // ⑧ 快照晋升（T1.6：promote 只影响后续请求；进行中请求继续持有旧快照）
  input.deps.snapshotRegistry.promote(input.deps.nextSnapshot());

  // ⑨ activation/committed 事件入链（T8.7：修复 P7 事实源断链；EventStore 经注入——supervisor 不 import runtime）
  if (input.deps.eventStore !== undefined) {
    await input.deps.eventStore.append(makeActivationEvent(contract, input, classification));
  }

  // ⑩ 记录事务完成（幂等键；logDir → 磁盘原子写 + 内存缓存；无 logDir → 内存）
  if (input.logDir !== undefined) {
    writeCompleted(input.logDir, input.activation_id, contract);
    clearPending(input.logDir, input.activation_id);
  }
  completed.set(input.activation_id, contract);
  return contract;
}

/**
 * 污染回滚：stable_head 切回 predecessor（Recovery Root 原子切换）。
 * T5.5 Minor 1 断言（注入 currentStableHead 时生效）：current head != contract.candidate → fail-loud
 * （不盲目回退已分叉/已回退状态）；未注入 → 旧语义（直接切回）。
 */
export async function rollback(
  contract: ActivationContract,
  deps: {
    switchStableHead: ActivationDeps['switchStableHead'];
    currentStableHead?: ActivationDeps['currentStableHead'];
  },
): Promise<{ previous: string; new: string }> {
  if (deps.currentStableHead !== undefined) {
    const head = await deps.currentStableHead();
    if (head !== contract.candidate) {
      throw new Error(
        `activation.rollback 断言失败（T5.5 Minor 1）: current stable head ${head} != contract.candidate ${contract.candidate}——不盲目回退（已回退或已分叉）`,
      );
    }
  }
  return await deps.switchStableHead(contract.predecessor);
}
