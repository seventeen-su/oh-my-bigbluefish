// OMB v2 State Reducer（§12.1 Event / §5.2 三值认识论 / §7.4 Decision Lineage & Utility）：layer 1 纯函数归约器。
// P7：模型可见 ⟺ 可重建——State 仅由事件流重建；reduce(events, opts?) → { state, projections }（brief 输出规格）。
// 防漂移：EVENTS_HANDLED 注册表 = APPLY 键集，未注册事件类型 fail-loud（新类型须先注册并实现映射）。
// 乱序：含 seq → 必须严格递增否则 fail-loud；无 seq → timestamp 稳定排序（同 timestamp 保持数组序）。
// 缺事件：hypothesis/transition 与 contradiction/found 引用流中未出现的 claim → fail-loud。
// payload 约定（最小集；M3 校验由 EventStore 负责）：claim/update {claim_id,text?,epistemic?,evidence_status?,evidence?,confidence?}
//   （§14.1 宪法①：目标 evidence_status=verified 需证据在场——evidence 引用或对应 observation 事件，违规 fail-loud）
//   observation/contradictory {observation_id,claim_id,hypothesis_id,status}（§14.1 宪法②：Observation=contradictory → 活动假设必须降级）
//   hypothesis/transition {hypothesis_id,claim_id?,status}  contradiction/found {contradiction_id,left_claim,right_claim}
//   decision/made {decision_id,question,chosen,evidence_used?,supersedes?}  tool/call|result {tool_id?}
//   process/operator/retrieve {operator_id?}  memory/admitted|consolidated {memory_id?}  session/start {goal?}  session/end {}
// 解释性决策（详见 task-1.4-report.md）：world/self 未知为 null；contradiction/found 只追加（§5.2 矛盾不迫使判 false，
//   三值由 claim/update / hypothesis/transition 驱动）；session/end 终结标记 = lifecycle retired。
import { createHash } from 'node:crypto';
import type { Fingerprint, Lifecycle, Owner, Provenance, Ref, Scope } from '../kernel/schemas/base.js';
import type { State, WorkingState } from '../kernel/schemas/s.js';
import type { Event } from '../kernel/schemas/m.js';
import {
  EVIDENCE_STATUSES,
  applyContradictoryObservation,
  assertVerifiedEvidence,
  parseObservationPayload,
  type EvidenceStatus,
} from './constitution.js';
const IR_VERSION = '2.0';
/** 空事件流时的确定性环境指纹（不依赖运行时，保证重建确定性） */
const DEFAULT_FP: Fingerprint = { os: 'unknown', node: 'unknown', dsh_version: '0.1.0', project: 'omb-v2' };
// ---- 投影类型 ----

export type Epistemic = 'supported' | 'contradicted' | 'unresolved';
export type HypothesisStatus = 'active' | 'discriminated' | 'rejected' | 'confirmed';

/** Claim 三值认识论视图（投影：id → 视图，§5.2 + §14.1 证据态） */
export interface ClaimView {
  text: string;
  epistemic: Epistemic;
  evidence_status: EvidenceStatus;
  confidence: number;
}
/** Hypothesis 状态视图（投影；扩展：brief 最小集 + 假设状态，供 T3.4） */
export interface HypothesisView {
  claim_id: string;
  status: HypothesisStatus;
}
/** 决策链投影条目（§7.4：决策 → supersedes → 旧决策） */
export interface DecisionLineageEntry {
  id: string;
  question: string;
  chosen: string;
  evidence_used: string[];
  supersedes?: string;
}
/** Utility 六计数器（reduce 系统级投影键：tool_calls/retrieval_calls/memory_ops/corrections/reads/hits；
 *  系统级派生数据，不写入 memory 表——非记忆级 utility_counts 键；记忆级 utility_counts 键 = T3.4 定型六反馈键） */
export interface UtilityCounts {
  tool_calls: number;
  retrieval_calls: number;
  memory_ops: number;
  corrections: number;
  reads: number;
  hits: number;
}
/** reduce 附带投影（派生数据，供 T1.6/T3.4 使用） */
export interface Projections {
  claims: Map<string, ClaimView>;
  hypotheses: Map<string, HypothesisView>;
  decision_lineage: DecisionLineageEntry[];
  utility_counts: UtilityCounts;
}
/** 重建输出 State（brief 输出规格：world/self 为引用，未知时 null；含 IRBase 字段） */
export interface ReducedState {
  id: string;
  ir_version: string;
  schema: string;
  scope: Scope;
  lifecycle: Lifecycle;
  immutable: false;
  owner: Owner;
  created: string;
  updated: string;
  provenance: Provenance;
  refs: Ref[];
  working: WorkingState;
  world: string | null;
  self: string | null;
  snapshot_hash: string;
}
export interface ReduceResult {
  state: ReducedState;
  projections: Projections;
}
/** 可归约事件：M3 Event + 可选 seq（事件存储追加序号，供乱序检测） */
export type ReducibleEvent = Event & { seq?: number };

// ---- 确定性派生工具（重建一致性：同输入 → 同状态，P7） ----

/** 确定性 uuid 形状 id（sha256 派生；非随机，保证重放一致） */
function detUuid(type: string, seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex');
  const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return `${type}:${u}`;
}
/** snapshot_hash：应用序事件 id 聚合 sha256（restore 重建一致性比对用） */
function snapshotHash(applied: Event[]): string {
  return createHash('sha256').update(applied.map((e) => e.id).join('\n'), 'utf8').digest('hex');
}
/** 状态 provenance（由末事件派生；空流用 initial/默认值） */
function makeProvenance(last: Event | null, init: State | undefined, ts: string): Provenance {
  return {
    source: 'system',
    event: last?.id ?? init?.provenance.event ?? '',
    actor: 'kernel',
    environment: last?.provenance.environment ?? init?.provenance.environment ?? DEFAULT_FP,
    runtime_snapshot: last?.runtime_snapshot ?? init?.provenance.runtime_snapshot ?? '',
    timestamp: ts,
    transformation_chain: [],
    verification: 'replay',
  };
}

// ---- 归约累积器 ----

interface Accum {
  claims: Map<string, ClaimView>;
  hypotheses: Map<string, HypothesisView>;
  lineage: DecisionLineageEntry[];
  utility: UtilityCounts;
  confirmed: string[];
  actives: string[];
  contradictions: string[];
  observedClaims: Set<string>; // §14.1 宪法①：有 observation 事件在场的 claim（转 verified 的证据来源之一）
  goal: string;
  nextBestAction: string;
  environment: Fingerprint;
  lifecycle: Lifecycle;
}

function pushUnique(arr: string[], id: string): void {
  if (!arr.includes(id)) {
    arr.push(id);
  }
}
function removeId(arr: string[], id: string): void {
  const i = arr.indexOf(id);
  if (i >= 0) {
    arr.splice(i, 1);
  }
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const EPISTEMICS = new Set<string>(['supported', 'contradicted', 'unresolved']);
const STATUSES = new Set<string>(['active', 'discriminated', 'rejected', 'confirmed']);
// ---- 事件 → 状态更新映射（最小集；新类型须注册于 APPLY 并实现映射） ----

/** claim/update：Claim 三值表 + confirmed_facts；三值翻转计 corrections（§7.4 Belief Revision）；
 *  证据态（evidence_status）经宪法①证据门（§14.1：verified 需证据在场，违规 fail-loud） */
function applyClaimUpdate(a: Accum, e: Event): void {
  const p = e.payload as {
    claim_id?: unknown;
    text?: unknown;
    epistemic?: unknown;
    evidence_status?: unknown;
    evidence?: unknown;
    confidence?: unknown;
  };
  const id = str(p.claim_id);
  if (!id) {
    throw new Error('reduce: claim/update 缺少 claim_id');
  }
  const prev = a.claims.get(id);
  const epRaw = (p.epistemic ?? prev?.epistemic ?? 'unresolved') as string;
  if (!EPISTEMICS.has(epRaw)) {
    throw new Error(`reduce: claim/update 非法 epistemic: ${epRaw}`);
  }
  const esRaw = str(p.evidence_status) ?? prev?.evidence_status ?? 'inferred';
  if (!(EVIDENCE_STATUSES as readonly string[]).includes(esRaw)) {
    throw new Error(`reduce: claim/update 非法 evidence_status: ${esRaw}`);
  }
  const evidenceStatus = esRaw as EvidenceStatus;
  if (evidenceStatus === 'verified' && prev?.evidence_status !== 'verified') {
    assertVerifiedEvidence(id, p.evidence, a.observedClaims); // 宪法①：进入 verified 需证据（已 verified 不再重复触发）
  }
  const view: ClaimView = {
    text: str(p.text) ?? prev?.text ?? id,
    epistemic: epRaw as Epistemic,
    evidence_status: evidenceStatus,
    confidence: typeof p.confidence === 'number' && Number.isFinite(p.confidence) ? p.confidence : (prev?.confidence ?? 0),
  };
  a.claims.set(id, view);
  if (view.epistemic === 'supported') pushUnique(a.confirmed, id);
  else removeId(a.confirmed, id);
  if (prev && prev.epistemic !== view.epistemic) a.utility.corrections += 1;
}

/** hypothesis/transition：状态迁移 + active_hypotheses + claim 三值同步（§5.2） */
function applyHypothesisTransition(a: Accum, e: Event): void {
  const p = e.payload as { hypothesis_id?: unknown; claim_id?: unknown; status?: unknown };
  const hid = str(p.hypothesis_id);
  if (!hid) {
    throw new Error('reduce: hypothesis/transition 缺少 hypothesis_id');
  }
  const statusRaw = String(p.status ?? '');
  if (!STATUSES.has(statusRaw)) {
    throw new Error(`reduce: hypothesis/transition 非法 status: ${statusRaw}`);
  }
  const status = statusRaw as HypothesisStatus;
  const prev = a.hypotheses.get(hid);
  const claimId = str(p.claim_id) ?? prev?.claim_id;
  if (!claimId) {
    throw new Error('reduce: hypothesis/transition 无法确定 claim（缺事件：假设从未注册且事件未携带 claim_id）');
  }
  if (!a.claims.has(claimId)) {
    throw new Error(`reduce: hypothesis/transition 引用未知 claim: ${claimId}（缺事件：claim/update 未在事件流中出现）`);
  }
  a.hypotheses.set(hid, { claim_id: claimId, status });
  if (status === 'active') pushUnique(a.actives, hid);
  else removeId(a.actives, hid);
  // 三值同步：confirmed → supported；rejected/discriminated → contradicted
  const claim = a.claims.get(claimId);
  if (claim && status === 'confirmed') {
    a.claims.set(claimId, { ...claim, epistemic: 'supported' });
    pushUnique(a.confirmed, claimId);
  } else if (claim && (status === 'rejected' || status === 'discriminated')) {
    a.claims.set(claimId, { ...claim, epistemic: 'contradicted' });
    removeId(a.confirmed, claimId);
  }
}

/** observation/contradictory：宪法②（§14.1）——Observation=contradictory → 活动假设必须降级（违规 fail-loud）；
 *  应用 active→discriminated/rejected + claim 三值同步 contradicted；claim 记入 observedClaims（宪法①证据在场） */
function applyObservationContradictory(a: Accum, e: Event): void {
  const p = e.payload as Record<string, unknown>;
  const { claimId, hypothesisId } = parseObservationPayload(p);
  if (!a.claims.has(claimId)) {
    throw new Error(`reduce: observation/contradictory 引用未知 claim: ${claimId}（缺事件）`);
  }
  const claim = a.claims.get(claimId) as ClaimView;
  applyContradictoryObservation(a.hypotheses, a.actives, claimId, hypothesisId, p.status);
  a.claims.set(claimId, { ...claim, epistemic: 'contradicted' });
  removeId(a.confirmed, claimId);
  a.observedClaims.add(claimId);
}

/** contradiction/found：WorkingState.contradictions 追加（unresolved=true 语义；§5.2 矛盾不迫使判 false） */
function applyContradictionFound(a: Accum, e: Event): void {
  const p = e.payload as { contradiction_id?: unknown; left_claim?: unknown; right_claim?: unknown };
  const id = str(p.contradiction_id);
  const left = str(p.left_claim);
  const right = str(p.right_claim);
  if (!id || !left || !right) {
    throw new Error('reduce: contradiction/found 缺少 contradiction_id/left_claim/right_claim');
  }
  if (!a.claims.has(left)) {
    throw new Error(`reduce: contradiction/found 引用未知 claim: ${left}（缺事件）`);
  }
  if (!a.claims.has(right)) {
    throw new Error(`reduce: contradiction/found 引用未知 claim: ${right}（缺事件）`);
  }
  pushUnique(a.contradictions, id);
}

/** decision/made：决策链投影（§7.4 Decision Lineage） */
function applyDecisionMade(a: Accum, e: Event): void {
  const p = e.payload as { decision_id?: unknown; question?: unknown; chosen?: unknown; evidence_used?: unknown; supersedes?: unknown };
  const id = str(p.decision_id);
  const question = str(p.question);
  const chosen = str(p.chosen);
  if (!id || !question || !chosen) {
    throw new Error('reduce: decision/made 缺少 decision_id/question/chosen');
  }
  const entry: DecisionLineageEntry = {
    id,
    question,
    chosen,
    evidence_used: Array.isArray(p.evidence_used)
      ? p.evidence_used.filter((x): x is string => typeof x === 'string')
      : [],
  };
  if (typeof p.supersedes === 'string' && p.supersedes.length > 0) {
    entry.supersedes = p.supersedes;
  }
  a.lineage.push(entry);
}

function applyToolCall(a: Accum): void {
  a.utility.tool_calls += 1;
}
/** tool/result：工具证据（证据计数基础）；tool_calls 由 tool/call 计数，其余证据计数器归 M1.1 对接 */
function applyToolResult(): void {
  /* no-op：已注册防漂移 */
}
function applyRetrieve(a: Accum): void {
  a.utility.retrieval_calls += 1;
}
function applyMemory(a: Accum): void {
  a.utility.memory_ops += 1;
}
/** session/start：重置工作区（goal 更新；认知集合清空；知识视图跨会话累积） */
function applySessionStart(a: Accum, e: Event): void {
  const p = e.payload as { goal?: unknown };
  if (typeof p.goal === 'string' && p.goal.length > 0) {
    a.goal = p.goal;
  }
  a.confirmed = [];
  a.actives = [];
  a.contradictions = [];
  a.lifecycle = 'active';
}/** session/end：终结标记（lifecycle retired，下一 session/start 重新激活） */
function applySessionEnd(a: Accum): void {
  a.lifecycle = 'retired';
}

type ApplyFn = (a: Accum, e: Event) => void;

/** 派发表 = EVENTS_HANDLED 注册表（单一事实源：键集即已注册事件类型） */
const APPLY: Record<string, ApplyFn> = {
  'session/start': applySessionStart,
  'session/end': applySessionEnd,
  'claim/update': applyClaimUpdate,
  'hypothesis/transition': applyHypothesisTransition,
  'observation/contradictory': applyObservationContradictory,
  'contradiction/found': applyContradictionFound,
  'decision/made': applyDecisionMade,
  'tool/call': applyToolCall,
  'tool/result': applyToolResult,
  'process/operator/retrieve': applyRetrieve,
  'memory/admitted': applyMemory,
  'memory/consolidated': applyMemory,
};

/** 已注册事件类型（防漂移注册表：新事件类型须先注册并实现映射） */
export const EVENTS_HANDLED: readonly string[] = Object.keys(APPLY);

/** 排序：含 seq → 严格递增校验（乱序 fail-loud）；无 seq → 按 timestamp 稳定排序（同 timestamp 保持数组序） */
function orderEvents(events: ReducibleEvent[]): Event[] {
  const withSeq = events.filter((e) => e.seq !== undefined);
  const withoutSeq = events.filter((e) => e.seq === undefined);
  if (withSeq.length > 0 && withoutSeq.length > 0) {
    throw new Error('reduce: 事件序列混合 seq 与无 seq 事件（排序键不一致）');
  }
  if (withSeq.length > 0) {
    for (let i = 1; i < withSeq.length; i++) {
      const prev = withSeq[i - 1] as ReducibleEvent;
      const cur = withSeq[i] as ReducibleEvent;
      if ((cur.seq as number) <= (prev.seq as number)) {
        throw new Error(`reduce: 事件 seq 乱序（非严格递增）: seq=${prev.seq} → seq=${cur.seq}`);
      }
    }
    return withSeq;
  }
  for (const e of events) {
    if (Number.isNaN(Date.parse(e.timestamp))) {
      throw new Error(`reduce: timestamp 无法解析: ${e.timestamp}`);
    }
  }
  return [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/** 归约器：顺序应用事件 → 重建 State + 派生投影（P7 唯一事实源；确定性、幂等） */
export function reduce(events: ReducibleEvent[], opts: { initial?: State } = {}): ReduceResult {
  const applied = orderEvents(events);
  const init = opts.initial;
  const a: Accum = {
    claims: new Map(),
    hypotheses: new Map(),
    lineage: [],
    utility: { tool_calls: 0, retrieval_calls: 0, memory_ops: 0, corrections: 0, reads: 0, hits: 0 },
    confirmed: init ? [...init.working.confirmed_facts] : [],
    actives: init ? [...init.working.active_hypotheses] : [],
    contradictions: init ? [...init.working.contradictions] : [],
    observedClaims: new Set(),
    goal: init?.working.goal ?? '',
    nextBestAction: init?.working.next_best_action ?? '',
    environment: init?.working.environment ?? DEFAULT_FP,
    lifecycle: init?.lifecycle ?? 'active',
  };

  let firstTs = '';
  let lastTs = '';
  let lastEvent: Event | null = null;
  for (const e of applied) {
    const apply = APPLY[e.type];
    if (apply === undefined) {
      throw new Error(
        `reduce: 未注册事件类型: ${e.type}（EVENTS_HANDLED 未覆盖——新事件类型须先在 state-reducer 注册并实现映射）`,
      );
    }
    apply(a, e);
    if (firstTs === '') firstTs = e.timestamp;
    lastTs = e.timestamp;
    lastEvent = e;
  }

  const hash = snapshotHash(applied);
  const scope: Scope = lastEvent?.scope ?? init?.scope ?? 'Project';
  const provenance = makeProvenance(lastEvent, init, lastTs);
  const state: ReducedState = {
    id: detUuid('state', hash),
    ir_version: IR_VERSION,
    schema: 'omb/S2',
    scope,
    lifecycle: a.lifecycle,
    immutable: false,
    owner: 'kernel',
    created: firstTs,
    updated: lastTs,
    provenance,
    refs: [],
    working: {
      id: detUuid('ws', `${hash}:working`),
      ir_version: IR_VERSION,
      schema: 'omb/S3',
      scope,
      lifecycle: a.lifecycle,
      immutable: false,
      owner: 'kernel',
      created: firstTs,
      updated: lastTs,
      provenance,
      refs: [],
      goal: a.goal,
      confirmed_facts: a.confirmed,
      active_hypotheses: a.actives,
      contradictions: a.contradictions,
      open_questions: init ? [...init.working.open_questions] : [],
      evidence_gaps: init ? [...init.working.evidence_gaps] : [],
      next_best_action: a.nextBestAction,
      environment: a.environment,
    },
    world: init?.world ?? null,
    self: init?.self ?? null,
    snapshot_hash: hash,
  };

  return {
    state,
    projections: {
      claims: a.claims,
      hypotheses: a.hypotheses,
      decision_lineage: a.lineage,
      utility_counts: a.utility,
    },
  };
}
