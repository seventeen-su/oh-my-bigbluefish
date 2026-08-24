// layer 2（kernel/）：P7 Predictive Invalidation 环境指纹（设计 §14.5 环境变化主动触发器 +
// 实现规格 §15.4 能力衰减曲线；架构 §4.4 Fingerprint）。
// 内容：
//   - diffFingerprints：指纹 diff 纯函数（os/node/dsh_version/project/gpu/cuda 固定字段序 → delta 列表；
//     无变化 → 空对象；确定性，测试锚定）。
//   - collectEnvironmentFingerprint：运行时采集（os/node/dsh_version/project——仅读 node:os 与 process，
//     无 I/O 副作用；gpu/cuda 无探测 → 可选键缺省）。
//   - buildCapabilityDecayRecord：§15.4 记录构造纯函数（指纹 diff 非空 → 记录；空 → null 不动作）。
// 层 DAG（CONVENTIONS §4）：kernel(2) → kernel/schemas(2) 满足"import 目标层 ≤ 源层"；
// 消费方 = runtime(2)（assembly environment_check 任务）。
import { platform } from 'node:os';
import type { Fingerprint } from './schemas/base.js';
import type { CapabilityDecayRecord, EnvironmentFieldDelta } from './schemas/evolution.js';
// R6：dsh_version 唯一宿主版本来源（运行时经 hostVersion() 读取——注入优先，缺省 DSH_HOST_VERSION）
import { DSH_HOST_VERSION, hostVersion } from './schemas/host-version.js';

// ---- 常量（待标定 §17） ----

/** §4.4 Fingerprint 参与 diff 的字段（固定顺序，保证 environment_delta 键序确定性；与 supervisor/maintenance.ts FP_FIELDS 同序） */
export const FINGERPRINT_FIELDS: (keyof Fingerprint)[] = ['os', 'node', 'dsh_version', 'project', 'gpu', 'cuda'];

/** 运行时默认 dsh_version（R6：唯一来源默认值 DSH_HOST_VERSION——与 supervisor 各 provenance 工厂同源） */
export const DEFAULT_DSH_VERSION = DSH_HOST_VERSION;

/** 运行时默认 project */
export const DEFAULT_PROJECT = 'omb-v2';

/** 能力衰减系数（每个环境字段变化归一衰减；与 supervisor/maintenance.ts CAPABILITY_DECAY_FACTOR 同值，待标定 §17） */
export const CAPABILITY_DECAY_FACTOR = 0.8;

// ---- 指纹 diff（纯函数） ----

/**
 * 环境指纹 diff（纯函数）：比较两指纹 → 变化字段 delta（固定字段序；无变化 → 空对象）。
 * delta 值 {from, to}：undefined = 该侧缺失（可选键 gpu/cuda 未声明）。
 */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): Record<string, EnvironmentFieldDelta> {
  const delta: Record<string, EnvironmentFieldDelta> = {};
  for (const f of FINGERPRINT_FIELDS) {
    const from = before[f];
    const to = after[f];
    if (from !== to) {
      delta[f] = { from, to };
    }
  }
  return delta;
}

// ---- 环境指纹采集（运行时；仅读进程与 os 模块） ----

/** 环境指纹采集（运行时）：os/node/dsh_version/project；gpu/cuda 无探测 → 可选键缺省 undefined */
export function collectEnvironmentFingerprint(opts: { dsh_version?: string; project?: string } = {}): Fingerprint {
  return {
    os: platform(),
    node: process.version,
    // R6：缺省经 hostVersion() 读取唯一来源（装配注入后 = 注入值；缺省 = DSH_HOST_VERSION）
    dsh_version: opts.dsh_version ?? hostVersion(),
    project: opts.project ?? DEFAULT_PROJECT,
  };
}

// ---- §15.4 能力衰减记录构造（纯函数） ----

/**
 * §15.4 能力衰减记录构造（纯函数）：指纹 diff 非空 → 按受影响对象 + 衰减系数生成字段级记录；
 * diff 空 → null（不动作）。
 * capability 向量最小形式：单维 'overall'（before=1，after=1×factor^Δ 字段数——与 §9.1 能力衰减
 * 曲线语义一致，待真实能力评估接入后升级为多维向量）；attribution 最小形式：每个受影响对象
 * 记各变化维度的能力 delta（占位——真实 per-object 归因留评估面接入）。
 */
export function buildCapabilityDecayRecord(input: {
  before: Fingerprint;
  after: Fingerprint;
  delta: Record<string, EnvironmentFieldDelta>;
  affected_objects: CapabilityDecayRecord['affected_objects'];
  /** 每环境字段变化的归一衰减系数（缺省 0.8，待标定 §17） */
  decayFactor?: number;
  /** 记录时间戳（缺省 Date.now） */
  ts?: number;
}): CapabilityDecayRecord | null {
  const { before, after, delta, affected_objects } = input;
  const decayFactor = input.decayFactor ?? CAPABILITY_DECAY_FACTOR;
  const ts = input.ts ?? Date.now();
  if (Object.keys(delta).length === 0) {
    return null;
  }
  const dims = Object.keys(delta);
  const beforeVector: CapabilityDecayRecord['capability_vector_before'] = { overall: 1 };
  const afterValue = Math.pow(decayFactor, dims.length);
  const afterVector: CapabilityDecayRecord['capability_vector_after'] = { overall: afterValue };
  const attribution: CapabilityDecayRecord['attribution'] = {};
  for (const obj of affected_objects) {
    attribution[obj.id] = Object.fromEntries(dims.map((d) => [d, afterValue - 1]));
  }
  return {
    ts,
    environment_delta: delta,
    affected_objects,
    regression_set: affected_objects.map((o) => o.id),
    capability_vector_before: beforeVector,
    capability_vector_after: afterVector,
    attribution,
    fingerprint_before: before,
    fingerprint_after: after,
  };
}
