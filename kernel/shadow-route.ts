// layer 2（kernel/）：S7 per-session shadow 路由纯函数（实现规格 §5.3 Shadow 流量分配 + G4 真实放量）。
// 零 I/O、零副作用、零随机：同输入 → 同输出（测试锚定）。
// 依赖：仅 node:crypto + 契约层 kernel/schemas/（policy.ts ShadowPolicy）——层 DAG 合规
//（kernel 不 import 上层；与 supervisor/promotion.ts 的 L2 消费面经 runtime 层装配衔接）。
//
// 与 supervisor/shadow.ts（layer 1）的分工：shadow.ts 是**库级** shadow/canary 语义（isExposed 分层曝光 /
// logExposure / runCanary 金丝雀判定）；本模块是**真实会话路由**判定——per-session 桶分流：
//   bucket = hash(session_id + candidate_id) % 100；启用 + 两线分叉（trusted-latest ≠ stable）+
//   桶 < exposure_rate → 会话按 latest 线快照运行（per-request 生效）。
// 桶算法与 shadow.ts bucketFor 对齐（sha256 前 2 字节 big-endian uint16 % 100，同 seed 同桶可复现；
// kernel 不 import supervisor——本地等价实现，对齐注释）。
import { createHash } from 'node:crypto';
import type { ShadowPolicy } from './schemas/policy.js';

/** 桶总数（对齐 supervisor/shadow.ts bucketFor 缺省 DEFAULT_TOTAL=100；桶 ∈ [0, 100)） */
export const SHADOW_TOTAL = 100;

/**
 * 影子桶：sha256(session_id + candidate_id) 前 2 字节（big-endian uint16）→ % 100。
 * 与 supervisor/shadow.ts bucketFor 同款算法（对齐先例；kernel 不 import supervisor——本地等价实现）。
 * 确定性：同 session+candidate → 同桶（可复现）；sha256 前两字节近似均匀 → 分布良好。
 * 越界防护：非字符串输入 → 抛错（fail-loud，防静默错桶）。
 */
export function shadowBucket(session_id: string, candidate_id: string): number {
  if (typeof session_id !== 'string' || typeof candidate_id !== 'string') {
    throw new Error(`shadowBucket: session_id/candidate_id 必须为字符串（got ${typeof session_id}/${typeof candidate_id}）`);
  }
  const hash = createHash('sha256').update(`${session_id}${candidate_id}`, 'utf8').digest();
  const u16 = hash[0]! * 256 + hash[1]!;
  return u16 % SHADOW_TOTAL;
}

/** shouldRouteShadow 判定输入（commit 由调用方解析——本函数只判，不 I/O） */
export interface ShadowRouteInput {
  session_id: string;
  candidate_id: string;
  /** trusted-latest 线 commit（null = 无候选线——不路由） */
  trusted_latest_commit: string | null;
  /** 当前（stable）线 commit（null = 无线状态——不路由） */
  stable_commit: string | null;
  /** shadow 配置（evolve.policy.shadow；exposure_rate 0..100 已由 schema 校验，本函数按已校验值判定） */
  policy: ShadowPolicy;
}

/** 判定结果（route=true → 会话按 latest 线运行；bucket/reason 可审计） */
export interface ShadowRouteVerdict {
  route: boolean;
  bucket: number;
  reason: string;
}

/**
 * per-session shadow 路由判定（确定性纯函数，实现规格 §5.3）：
 *   ① 未启用（policy.enabled=false）→ 不路由（零开销默认路径）；
 *   ② 无 trusted-latest / 无线状态（commit 缺省 null）→ 不路由（无候选线）；
 *   ③ 两线未分叉（trusted_latest == stable）→ 不路由（无差异，零开销）；
 *   ④ 桶 = shadowBucket(session_id, candidate_id) < exposure_rate → 路由；否则不路由（曝光率外）。
 * exposure_rate ∈ [0, 100]（schema 校验）：0 = 不曝光（无会话路由）；100 = 全量（桶恒 < 100 → 全路由）。
 * 同输入 → 同输出（确定性；调用方按需缓存 commit/candidate 解析，本函数只判）。
 */
export function shouldRouteShadow(input: ShadowRouteInput): ShadowRouteVerdict {
  if (!input.policy.enabled) {
    return {
      route: false,
      bucket: shadowBucket(input.session_id, input.candidate_id),
      reason: 'shadow 未启用（policy.shadow.enabled=false）——默认路径',
    };
  }
  if (input.trusted_latest_commit === null || input.stable_commit === null) {
    return {
      route: false,
      bucket: shadowBucket(input.session_id, input.candidate_id),
      reason: '无版本线状态（trusted-latest/stable commit 缺失）——无候选线可路由',
    };
  }
  if (input.trusted_latest_commit === input.stable_commit) {
    return {
      route: false,
      bucket: shadowBucket(input.session_id, input.candidate_id),
      reason: '两线未分叉（trusted-latest == stable）——无差异，零开销',
    };
  }
  const bucket = shadowBucket(input.session_id, input.candidate_id);
  if (bucket >= input.policy.exposure_rate) {
    return {
      route: false,
      bucket,
      reason: `桶 ${bucket} ≥ exposure_rate ${input.policy.exposure_rate}——不曝光（曝光率外）`,
    };
  }
  return {
    route: true,
    bucket,
    reason: `桶 ${bucket} < exposure_rate ${input.policy.exposure_rate}——shadow 分流到 latest 线`,
  };
}
