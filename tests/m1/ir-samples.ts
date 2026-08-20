// T1.1 测试数据模块（非测试文件）：Semantic IR 合法样例 fixtures 与共享工厂。
// 合法/非法用例表在 ./ir-cases.ts；本模块为纯数据（无 schema import），控制单文件 LOC（CONVENTIONS §9）。

/** 结构化鸭子类型：zod schema 的最小可测面 */
export type ZodLike = {
  safeParse(input: unknown): { success: boolean };
  parse(input: unknown): unknown;
};

/** 宽松记录类型：{ id: string } + 任意字段（便于测试中构造非法补丁） */
export type Rec = { id: string } & Record<string, unknown>;

export const TS = '2026-08-21T00:00:00.000Z';
export const SHA = 'ab'.repeat(32);
export const UUID = '11111111-1111-4111-8111-111111111111';
export const FP = { os: 'win32', node: '24.12.0', dsh_version: '0.1.0', project: 'omb-v2' };
export const PROV = {
  source: 'model',
  event: 'event:1',
  actor: 'kernel',
  environment: FP,
  runtime_snapshot: 'rs:1',
  timestamp: TS,
  transformation_chain: [],
  verification: 'v:1',
};

/** IRBase 缺省字段工厂；over 覆盖（如 immutable 对象的 sha256 id） */
export function base(over: Record<string, unknown> = {}): Rec {
  return {
    id: `claim:${UUID}`,
    ir_version: '2.0',
    schema: 'omb/obj',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: PROV,
    refs: [],
    ...over,
  };
}

/** 删除若干键（构造"缺必填字段"的非法样例） */
export function omit<T extends object>(obj: T, ...keys: string[]): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) {
    delete out[k];
  }
  return out as T;
}

// ---- 各对象合法样例（IRBase 字段 + 对象字段） ----

export const S1_VALID: Rec = {
  ...base({ id: `task:${UUID}`, schema: 'omb/S1' }),
  goal: '修复回归',
  success_criteria: ['测试全绿'],
  constraints: ['不破坏 M0'],
  allowed_effects: ['mutate'],
  verifier: 'v:1',
  budget: { tokens: 5000 },
  termination: { max_steps: 10 },
  environment: FP,
};

const S3_VALID: Rec = {
  ...base({ id: `ws:${UUID}`, schema: 'omb/S3' }),
  goal: 'g',
  confirmed_facts: ['f:1'],
  active_hypotheses: ['h:1'],
  contradictions: ['c:1'],
  open_questions: ['q:1'],
  evidence_gaps: ['g:1'],
  next_best_action: 'a:1',
  environment: FP,
};

const S2_VALID: Rec = {
  ...base({ id: `state:${UUID}`, schema: 'omb/S2' }),
  working: S3_VALID,
  world: 'wm:1',
  self: 'sm:1',
  snapshot_hash: SHA,
};

const WM_VALID: Rec = {
  ...base({ id: `wm:${UUID}`, schema: 'omb/S4' }),
  kind: 'world_model',
  capabilities: ['retrieve'],
  limitations: ['no-network'],
  environment: FP,
};

const SM_VALID: Rec = {
  ...base({ id: `sm:${UUID}`, schema: 'omb/S4' }),
  kind: 'self_model',
  reliable_strategies: ['tdd'],
  blind_spots: ['crypto'],
  current_state: 'ok',
  environment: FP,
};

export const C1_VALID: Rec = {
  ...base({ id: `claim:${UUID}`, schema: 'omb/C1' }),
  text: 'IR 定义完整',
  epistemic: 'supported',
  supported_by: ['e:1'],
  contradicted_by: [],
  confidence: 0.8,
};

const C2_VALID: Rec = {
  ...base({ schema: 'omb/C2' }),
  claim: 'c:1',
  status: 'active',
  alternatives: ['h:2'],
};

const C3_VALID: Rec = {
  ...base({ schema: 'omb/C3' }),
  left_claim: 'c:1',
  right_claim: 'c:2',
  scope: 'project',
  evidence: ['e:1'],
  severity: 'high',
  unresolved: true,
};

const C4_VALID: Rec = {
  ...base({ schema: 'omb/C4' }),
  observation_ref: 'o:1',
  strength: 'strong',
  reproducibility: 'high',
  environment: FP,
};

const C5_VALID: Rec = {
  ...base({ schema: 'omb/C5' }),
  from: 'tool',
  payload: 'art:1',
  ts: TS,
};

const C6_VALID: Rec = {
  ...base({ schema: 'omb/C6' }),
  claim_ref: 'c:1',
  state: { historical: ['c:0'], current: 'c:1', transition_event: 'evt:1', confidence: 0.7 },
  revision_log: ['evt:1'],
};

const C7_VALID: Rec = {
  ...base({ schema: 'omb/C7' }),
  question: 'zod v4?',
  why_unresolved: '未实测',
  candidate_answers: ['v3', 'v4'],
  discriminating_observation: 'o:1',
  expected_information_gain: 'high',
  cost: 3,
};

const AC_VALID: Rec = {
  ...base({ id: `ac:${UUID}`, schema: 'omb/C9' }),
  preconditions: ['p:1'],
  expected_effect: ['e:1'],
  actual_effect: ['e:1'],
  cost: 1,
  risk: 'low',
  reversibility: { declared: true, rollback_path: 'rb:1' },
  side_effects: [],
  provenance: PROV,
};

const C8_VALID: Rec = {
  ...base({ id: `act:${UUID}`, schema: 'omb/C8' }),
  contract: AC_VALID,
  state: 'planned',
};

const C10_VALID: Rec = {
  ...base({ schema: 'omb/C10' }),
  question: '选 zod?',
  alternatives: ['zod', 'ajv'],
  chosen: 'zod',
  evidence_used: ['e:1'],
  environment: FP,
  lineage: ['d:0'],
};

const C11_VALID: Rec = {
  ...base({ schema: 'omb/C11' }),
  context: 'fp:1',
  action: 'a:1',
  result: 'r:1',
  relations: { requires: [], excludes: [], fallback: [], causes: ['c:1'], supersedes: [] },
};

const OP_VALID: Rec = {
  ...base({ id: 'op:1', schema: 'omb/P2' }),
  version: '1.0.0',
  input_binding: { q: 'x' },
  output: 'pack:1',
  cost: { tokens: 10 },
  side_effect: 'none',
  verification: 'v:1',
  error: { retryable: true, timeout_ms: 1000, cancelable: true, rollback: 'rb:1' },
  transaction: true,
};

const P1_VALID: Rec = {
  ...base({ schema: 'omb/P1' }),
  operator_graph: [OP_VALID],
  entry: 'op:1',
  exit: 'done',
  budget: { tokens: 1000 },
  version: '1.0.0',
  parent: null,
};

const P3_VALID: Rec = {
  ...base({ schema: 'omb/P3' }),
  contract: {
    input: 'in:1',
    output: 'out:1',
    cost: { tokens: 10 },
    side_effect: 'read_only',
    reversibility: { declared: true, rollback_path: 'rb' },
  },
  provider: 'builtin',
  authority_scope: 'own',
  stats: { calls: 3, failures: 0 },
};

const P4_VALID: Rec = {
  ...base({ schema: 'omb/P4' }),
  verb: 'read',
  object: 'file',
  scope: '/tmp',
  effects: 'read_only',
  constraints: [],
  required_verification: 'v:1',
};

const P5_VALID: Rec = {
  ...base({ schema: 'omb/P5' }),
  name: 'tdd',
  source: 'bundled',
  ownership: 'global',
  parent: null,
  overrides: [],
  version: '1.0.0',
};

const M1_VALID: Rec = {
  ...base({ schema: 'omb/M1' }),
  kind: 'Semantic',
  lifecycle: 'Active',
  prov_class: 'Observation',
  payload: 'art:1',
  value_score: 0.6,
  utility_counts: { read: 3, hit: 2 },
};

const M3_VALID: Rec = {
  ...base({ id: `evt:${UUID}`, schema: 'omb/M3' }),
  type: 'memory/admitted',
  session_id: 's:1',
  runtime_snapshot: 'rs:1',
  parent_event: null,
  causality: 'c:1',
  payload: { m: 'x' },
  provenance: PROV,
  timestamp: TS,
};

const M4_VALID: Rec = {
  ...base({ id: `sha256:${SHA}`, immutable: true, schema: 'omb/M4' }),
  protocol_version: '1.0',
  parent: null,
  diff: 'd:1',
  compat: 'backward',
  bench: 'b:1',
  provenance: PROV,
  spdx: 'MIT',
  verifications: ['vc:1'],
};

const M5_VALID: Rec = {
  ...base({ schema: 'omb/M5' }),
  components: {
    scheduler: 's:1',
    memory: 'm:1',
    verifier: 'v:1',
    renderer: 'r:1',
    capability: 'c:1',
    philosophy: SHA,
  },
  task_contract_ref: 'tc:1',
  created: TS,
  activation_contract_ref: 'ac:1',
};

const M6_VALID: Rec = {
  ...base({ schema: 'omb/M6' }),
  predecessor: 'evo:1',
  candidate: 'evo:2',
  required_capabilities: ['cap:1'],
  evidence_certificate: 'ec:1',
  compatible_schema: '2.0',
  activation_scope: 'project',
  rollback_snapshot: 'rs:1',
};

const M7_VALID: Rec = {
  ...base({ schema: 'omb/M7' }),
  working_state: 'st:1',
  hash: SHA,
  timestamp: TS,
  runtime_snapshot: 'rs:1',
  provenance: PROV,
};

const M8_VALID: Rec = {
  ...base({ schema: 'omb/M8' }),
  task_id: 't:1',
  value: 0.8,
  accumulated_at: TS,
  priority: 'high',
  estimated_cost: 5,
  urgency: 0.9,
};

export const A1_VALID: Rec = {
  ...base({ id: `sha256:${SHA}`, immutable: true, schema: 'omb/A1' }),
  type: 'text',
  content: 'content',
  provenance: PROV,
  scope: 'Project',
  hash: SHA,
  version: '1.0.0',
  parent: [],
  derived_from: [],
  restore_policy: 'keep',
  compressed_views: [],
};

const A2_VALID: Rec = {
  ...base({ id: `sha256:${SHA}`, immutable: true, schema: 'omb/A2' }),
  version: '1.0.0',
  immutable: true,
  skills: [{ id: 'sk:1', pin: `sha256:${SHA}` }],
  capabilities: ['cap:1'],
  assumptions: ['a:1'],
  validated: true,
  context_plan: 'cp:1',
};

const A3_VALID: Rec = {
  ...base({ schema: 'omb/A3' }),
  type: 'planning',
  sections: [{ source_ref: 'art:1', view: 'plan', content: 'c', tokens: 10 }],
  original_artifact_ids: ['art:1'],
  total_tokens: 10,
  restore_capable: true,
  deterministic: true,
};

/** 合法样例 consts（供 ./ir-cases.ts 的 VALID/INVALID 表使用） */
export {
  S2_VALID,
  S3_VALID,
  WM_VALID,
  SM_VALID,
  C2_VALID,
  C3_VALID,
  C4_VALID,
  C5_VALID,
  C6_VALID,
  C7_VALID,
  C8_VALID,
  AC_VALID,
  C10_VALID,
  C11_VALID,
  OP_VALID,
  P1_VALID,
  P3_VALID,
  P4_VALID,
  P5_VALID,
  M1_VALID,
  M3_VALID,
  M4_VALID,
  M5_VALID,
  M6_VALID,
  M7_VALID,
  M8_VALID,
  A2_VALID,
  A3_VALID,
};
