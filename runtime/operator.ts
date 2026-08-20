// OMB v2 Operator ABI（架构 §5.3 Process Generator / Operator ABI）。
// layer 2（runtime/）：仅 node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
// 内容：OperatorSpec/OperatorFn/OperatorContext 契约类型、OperatorGraph/GraphResult/Event 类型、
// Micro Certificate（§5.3：input_state_hash/operator_graph_hash/expected/actual/verifier/
// state_delta/environment；M5 入库），并作为 runtime/operator 的统一门面 re-export。
// 模块拆分（CONVENTIONS §9 LOC ≤ 400）：执行器（拓扑序/fan-out/fan-in/错误契约/Event 钩子）在
// ./operator-executor.ts；内置 7 算子 + OperatorError + 内置数据形态在 ./operator-builtins.ts
// （后者对本文件仅类型层 import，无运行时环）。
import { createHash } from 'node:crypto';
import type { CapabilityProvider } from '../kernel/capability-abi.js';
import { canonicalJson } from '../kernel/schemas/base.js';

// ---- 门面 re-export（统一出口：runtime/operator.*） ----

export {
  BUILTIN_OPERATORS,
  DEFAULT_CAPABILITY_ID,
  OperatorError,
  type ExperimentPlan,
  type Hypothesis,
  type MemoryPack,
  type Observation,
  type StatePatch,
  type StopReport,
  type ToolResult,
} from './operator-builtins.js';
export { executeGraph, FAN_OUT_CONCURRENCY, MAX_RETRIES, RETRY_BACKOFF_BASE_MS } from './operator-executor.js';

// ---- 常量 ----

/** Micro Certificate 验证者（M4 静态验证；M5 接 Evidence Ladder） */
export const VERIFIER_ID = 'runtime/operator';

// ---- 契约类型（与 T2.1 ProcessDef Operator 对齐） ----

/** 算子错误契约（§5.3：retryable/timeout_ms/cancelable/rollback） */
export interface OperatorErrorSpec {
  retryable: boolean;
  timeout_ms: number;
  cancelable: boolean;
  /** rollback 补偿钩子键（ctx.rollbacks 查找；空串 = 无补偿） */
  rollback: string;
}

/** 算子成本（与 T2.1 BudgetSchema 对齐；求和用 cost.cost ?? cost.tokens ?? 0） */
export interface OperatorCost {
  tokens?: number;
  time_ms?: number;
  cost?: number;
}

/**
 * 数据流绑定（input_binding 值）：
 * - { ref, path? }：引用上游算子输出（path = '.' 分隔字段路径）
 * - { const }：常量
 * - 数组：fan-in 合并（逐元素按序解析 → 数组）
 * - 其他值：裸常量
 */
export type OperatorBinding = { ref: string; path?: string } | { const: unknown } | unknown[];

/** OperatorSpec（与 T2.1 ProcessDef Operator 对齐；verification/rollback 空串 = 未配置） */
export interface OperatorSpec {
  id: string;
  version: string;
  input_binding: Record<string, OperatorBinding>;
  output: string;
  cost: OperatorCost;
  side_effect: string;
  verification: string;
  error: OperatorErrorSpec;
  transaction: boolean;
}

/** 算子运行上下文（inputs 为 input_binding 解析后的输入；依赖经注入透传） */
export interface OperatorContext {
  inputs: Record<string, unknown>;
  budget: number;
  logger?: (msg: string) => void;
  signal?: AbortSignal;
  /** RETRIEVE 依赖注入（M3 backend；M4 测试注入 fake） */
  retrieveFn?: RetrieveFn;
  /** EXECUTE 依赖注入（能力 ABI：capability_id → Provider；无 Broker，M6 完善路由） */
  capabilities?: Record<string, CapabilityProvider>;
  /** verification 谓词注册表（verification 字符串 → 谓词） */
  verifiers?: Record<string, VerifyFn>;
  /** rollback 补偿钩子注册表（error.rollback 键 → 钩子） */
  rollbacks?: Record<string, RollbackFn>;
}

export type OperatorOutput = unknown;

export interface OperatorFn {
  run(ctx: OperatorContext): Promise<OperatorOutput>;
}

/** RETRIEVE 依赖注入签名（M4 最小；生产 boot 适配 memory/retrieve.ts） */
export type RetrieveFn = (q: {
  q: string;
  scope: string;
  kind?: string;
  budget?: number;
  limit?: number;
}) => Promise<{ items: unknown[]; channel_used?: string }>;

export type VerifyFn = (output: unknown) => boolean | Promise<boolean>;
export type RollbackFn = (output: unknown) => void | Promise<void>;

/** 算子图（edges 定义拓扑依赖；entry/exit 供 Micro Certificate 与过程元数据） */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface OperatorGraph {
  operators: OperatorSpec[];
  edges: GraphEdge[];
  entry: string;
  exit: string;
}

/** 每算子 Event（eventSink 钩子；type 与 M1 EventTypeSchema 通配段 process/operator/* 一致） */
export type OperatorEventType =
  | 'process/operator/start'
  | 'process/operator/end'
  | 'process/operator/retry'
  | 'process/operator/failed'
  | 'process/operator/rollback';

export interface OperatorEvent {
  type: OperatorEventType;
  operator_id: string;
  /** 基名（HYPOTHESIZE-1 → HYPOTHESIZE） */
  operator_type: string;
  attempt: number;
  ok?: boolean;
  ts: number;
}

export interface GraphError {
  code: string;
  message: string;
  operator_id?: string;
  attempt?: number;
}

export interface GraphResult {
  ok: boolean;
  failed: boolean;
  /** BUDGET_EXCEEDED | CANCELLED | CYCLE | E_GRAPH | OPERATOR_FAILED */
  code?: string;
  error?: GraphError;
  /** opId → 算子输出 */
  outputs: Record<string, unknown>;
  /** 成功完成序 */
  completed: string[];
  events: OperatorEvent[];
  rollbacks_called: string[];
  /** Negative Pattern 记录占位（M5 落库） */
  negative_pattern?: GraphError;
}

/** 执行上下文（图级：输入/预算/取消/钩子/依赖注入） */
export interface GraphExecutionContext {
  inputs: Record<string, unknown>;
  budget: number;
  signal?: AbortSignal;
  eventSink?: (event: OperatorEvent) => void;
  logger?: (msg: string) => void;
  retrieveFn?: RetrieveFn;
  capabilities?: Record<string, CapabilityProvider>;
  verifiers?: Record<string, VerifyFn>;
  rollbacks?: Record<string, RollbackFn>;
  /** 自定义算子（按 op.id 覆盖/扩展内置） */
  registry?: Record<string, OperatorFn>;
}

// ---- Micro Certificate（§5.3：Ephemeral →（证书）→ Behavioral Candidate；M5 入库） ----

export interface MicroCertificate {
  input_state_hash: string;
  operator_graph_hash: string;
  expected: { effect: string };
  actual: { effect: string };
  verifier: string;
  state_delta: Record<string, unknown>;
  environment: Record<string, string>;
}

/** 证书构造（纯函数）：input_state_hash/operator_graph_hash 用 canonicalJson + sha256（图须可序列化） */
export function buildMicroCertificate(
  graph: OperatorGraph,
  ctx: { inputs: Record<string, unknown>; environment?: Record<string, string> },
  opts: { expected_effect?: string; actual_effect?: string; state_delta?: Record<string, unknown> } = {},
): MicroCertificate {
  const hash = (content: unknown) => `sha256:${createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')}`;
  return {
    input_state_hash: hash(ctx.inputs),
    operator_graph_hash: hash(graph),
    expected: { effect: opts.expected_effect ?? `${graph.entry} → ${graph.exit}` },
    actual: { effect: opts.actual_effect ?? 'completed' },
    verifier: VERIFIER_ID,
    state_delta: opts.state_delta ?? {},
    environment: { node: process.version, os: process.platform, dsh_version: '0.4.0', project: 'omb-v2', ...ctx.environment },
  };
}
