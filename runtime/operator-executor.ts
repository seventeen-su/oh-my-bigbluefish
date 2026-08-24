// OMB v2 算子图执行器（架构 §5.3：拓扑序 + fan-out/fan-in + 错误契约 + Event 钩子）。
// layer 2（runtime/）：对 ./operator.js 仅类型层 import（纯类型，无运行时环）；
// 对 ./operator-builtins.js 取 OperatorError/BUILTIN_OPERATORS（仅函数体内引用，无顶层求值依赖）。
// executeGraph 由 operator.ts 门面 re-export。
// 模块拆分（CONVENTIONS §9 LOC ≤ 400）：执行器与 ABI 契约层、内置算子分文件。
import { createHash } from 'node:crypto';
import { OperatorError, BUILTIN_OPERATORS } from './operator-builtins.js';
import type {
  GraphError,
  GraphExecutionContext,
  GraphResult,
  OperatorBinding,
  OperatorContext,
  OperatorEvent,
  OperatorFn,
  OperatorGraph,
  OperatorOutput,
  OperatorSpec,
} from './operator.js';
import type { NegativePatternRecord } from '../memory/negative-pattern.js';
import { canonicalJson, makeImmutableId } from '../kernel/schemas/base.js';
// R6：dsh_version 唯一宿主版本来源（kernel/schemas IR 契约层，runtime(2) → kernel/schemas(2) ✓）
import { hostVersion } from '../kernel/schemas/host-version.js';

// ---- 常量 ----

/** fan-out 并发上限（§5.3：并行执行无依赖算子，受预算限制） */
export const FAN_OUT_CONCURRENCY = 2;
/** 重试 ≤ 2 次（总尝试 ≤ 3） */
export const MAX_RETRIES = 2;
/** 指数退避基数：retry k 延迟 = base × 2^(k-1) ms */
export const RETRY_BACKOFF_BASE_MS = 5;

/** 算子解析：registry[op.id] → 内置[op.id] → 内置[基名]（HYPOTHESIZE-1 → HYPOTHESIZE） */
function resolveFn(id: string, registry: Record<string, OperatorFn>): OperatorFn | undefined {
  return registry[id] ?? BUILTIN_OPERATORS[id] ?? BUILTIN_OPERATORS[id.replace(/-\d+$/, '')];
}

function opType(id: string): string {
  return id.replace(/-\d+$/, '');
}

/**
 * input_binding 解析：ref 引用上游输出（path 取字段路径）、const 常量、数组 fan-in 合并、其他裸常量。
 * 图上下文输入引用（T4.3-loop 接缝）：ref 未命中任何算子输出时回退到 ctx.inputs（ProcessDef '$.x'
 * 图输入引用经适配器转为 {ref}，执行期在此解析）；仍无 → E_UNRESOLVED_BINDING（fail-loud）。
 */
function resolveInputs(op: OperatorSpec, outputs: Map<string, unknown>, ctxInputs: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(op.input_binding ?? {})) {
    inputs[name] = resolveBinding(binding, outputs, ctxInputs, op.id);
  }
  return inputs;
}

function resolveBinding(
  binding: OperatorBinding,
  outputs: Map<string, unknown>,
  ctxInputs: Record<string, unknown>,
  opId: string,
): unknown {
  if (Array.isArray(binding)) {
    return binding.map((b) => resolveBinding(b as OperatorBinding, outputs, ctxInputs, opId));
  }
  if (binding !== null && typeof binding === 'object') {
    const obj = binding as Record<string, unknown>;
    if (typeof obj.ref === 'string') {
      if (outputs.has(obj.ref)) {
        const out = outputs.get(obj.ref);
        return typeof obj.path === 'string' ? getPath(out, obj.path) : out;
      }
      if (Object.prototype.hasOwnProperty.call(ctxInputs, obj.ref)) {
        const out = ctxInputs[obj.ref];
        return typeof obj.path === 'string' ? getPath(out, obj.path) : out;
      }
      throw new OperatorError('E_UNRESOLVED_BINDING', `算子 ${opId} 的 input_binding 引用未完成输出: ${obj.ref}`, false);
    }
    if ('const' in obj) {
      return obj.const;
    }
  }
  return binding;
}

function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 中止原因分类：AbortSignal.timeout 的 reason 为 TimeoutError；图级取消为 CANCELLED。
 * 取舍（T4.1 评审 Important）：CANCELLED 是终态——图级取消 = 整图放弃，重试只会
 * 在已中止的信号下空转（每次预检立即抛 CANCELLED 再叠加退避），故固定 retryable:false，
 * 取消绝不进入重试路径；TIMEOUT 可能为瞬态（慢依赖偶发），保留 spec.error.retryable
 * 的可重试语义，由算子声明决定。
 */
function abortError(op: OperatorSpec, signal: AbortSignal): OperatorError {
  const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  return new OperatorError(
    timeout ? 'TIMEOUT' : 'CANCELLED',
    timeout ? `算子 ${op.id} 超时（${op.error.timeout_ms}ms）` : `算子 ${op.id} 被取消`,
    timeout ? op.error.retryable : false,
  );
}

/** 单次尝试：timeout_ms → AbortSignal.timeout；cancelable → 并入图级信号；算子与信号赛跑（不挂起） */
async function runAttempt(
  op: OperatorSpec,
  fn: OperatorFn,
  opCtx: OperatorContext,
  graphSignal: AbortSignal | undefined,
): Promise<OperatorOutput> {
  const signals: AbortSignal[] = [];
  if (op.error.timeout_ms > 0) {
    signals.push(AbortSignal.timeout(op.error.timeout_ms));
  }
  if (op.error.cancelable && graphSignal) {
    signals.push(graphSignal);
  }
  if (signals.length === 0) {
    return fn.run(opCtx);
  }
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  if (signal.aborted) {
    throw abortError(op, signal);
  }
  return new Promise<OperatorOutput>((resolve, reject) => {
    const onAbort = () => reject(abortError(op, signal));
    signal.addEventListener('abort', onAbort, { once: true });
    fn.run({ ...opCtx, signal })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** 每算子验证：verification 存在即执行谓词；无谓词 → warning（M4 最小） */
async function verifyOutput(op: OperatorSpec, output: OperatorOutput, opCtx: OperatorContext): Promise<void> {
  if (op.verification.length === 0) {
    return;
  }
  const pred = opCtx.verifiers?.[op.verification];
  if (!pred) {
    opCtx.logger?.(`warning: 算子 ${op.id} 的验证谓词未注册: ${op.verification}`);
    return;
  }
  if (!(await pred(output))) {
    throw new OperatorError('VERIFICATION_FAILED', `算子 ${op.id} 输出未通过验证: ${op.verification}`, false);
  }
}

function toGraphError(err: unknown, operatorId: string, attempt: number): GraphError {
  if (err instanceof OperatorError) {
    return { code: err.code, message: err.message, operator_id: operatorId, attempt };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'E_OPERATOR', message, operator_id: operatorId, attempt };
}

// ---- T8.8 Negative Pattern 落库（整图失败 → 失败样本记录，供演化信号 CapabilityGap） ----

/** 图 hash：sha256(canonicalJson(graph))（确定性——同图同 hash） */
function graphHash(graph: OperatorGraph): string {
  return `sha256:${createHash('sha256').update(canonicalJson(graph), 'utf8').digest('hex')}`;
}

/**
 * 失败样本构造（整图失败 → 表记录：graph hash/失败算子/错误/环境/时间 + provenance 链
 * 表行 → 事件/过程引用）。id 内容寻址（graph_hash+operator+code+message）——同失败幂等去重。
 */
function buildNegativePatternRecord(
  graph: OperatorGraph,
  ctx: GraphExecutionContext,
  result: GraphResult,
): NegativePatternRecord {
  const hash = graphHash(graph);
  const operator = result.error?.operator_id ?? 'graph';
  const code = result.error?.code ?? result.code ?? 'E_GRAPH'; // 精确算子错误码优先（TIMEOUT/E_NO_CAPABILITY…）
  const message = result.error?.message ?? '整图失败';
  const ts = Date.now();
  return {
    id: makeImmutableId(canonicalJson({ graph_hash: hash, failed_operator: operator, code, message })),
    graph_hash: hash,
    failed_operator: operator,
    code,
    message,
    environment: { os: process.platform, node: process.version, dsh_version: hostVersion(), project: 'omb-v2' }, // R6：唯一宿主版本来源
    created: ts,
    provenance: {
      source: 'operator-executor',
      event: `process/operator/failed:${operator}`,
      process_ref: ctx.graphId ?? `graph:${graph.entry}→${graph.exit}`,
      graph_hash: hash,
      timestamp: new Date(ts).toISOString(),
      transformation_chain: ['executeGraph'],
      verification: 'negative-pattern',
    },
  };
}

/** 整图失败 → 注入 sink 写失败样本（sink 未注入 → no-op，不改变执行结果） */
async function emitNegativePattern(
  graph: OperatorGraph,
  ctx: GraphExecutionContext,
  result: GraphResult,
): Promise<void> {
  if (ctx.negativePatternSink === undefined) {
    return;
  }
  await ctx.negativePatternSink(buildNegativePatternRecord(graph, ctx, result));
}

/** 错误可重试性：OperatorError.retryable=false 显式阻断重试；其他错误交给 spec.error.retryable */
function errRetryable(err: unknown): boolean | undefined {
  return err instanceof OperatorError ? err.retryable : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 算子成本（预算求和；cost.cost 优先，回退 tokens，再回退 0） */
function operatorCost(op: OperatorSpec): number {
  return op.cost.cost ?? op.cost.tokens ?? 0;
}

type RunOutcome = { ok: true; output: OperatorOutput } | { ok: false; error: GraphError };

/** 单算子执行：错误契约（重试 ≤ 2 次指数退避；TIMEOUT 按 spec.error.retryable 取舍，
 *  CANCELLED 终态固定不重试；成功前 verification） */
async function runOne(
  op: OperatorSpec,
  registry: Record<string, OperatorFn>,
  ctx: GraphExecutionContext,
  outputs: Map<string, unknown>,
  emit: (evt: OperatorEvent) => void,
): Promise<RunOutcome> {
  const fn = resolveFn(op.id, registry);
  if (!fn) {
    return { ok: false, error: { code: 'E_UNKNOWN_OPERATOR', message: `未知算子: ${op.id}`, operator_id: op.id, attempt: 1 } };
  }
  let lastError: GraphError | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    emit({ type: 'process/operator/start', operator_id: op.id, operator_type: opType(op.id), attempt, ts: Date.now() });
    try {
      const inputs = resolveInputs(op, outputs, ctx.inputs);
      const opCtx: OperatorContext = {
        inputs,
        budget: ctx.budget,
        logger: ctx.logger,
        retrieveFn: ctx.retrieveFn,
        capabilities: ctx.capabilities,
        verifiers: ctx.verifiers,
        rollbacks: ctx.rollbacks,
      };
      const output = await runAttempt(op, fn, opCtx, ctx.signal);
      await verifyOutput(op, output, opCtx);
      emit({ type: 'process/operator/end', operator_id: op.id, operator_type: opType(op.id), attempt, ok: true, ts: Date.now() });
      return { ok: true, output };
    } catch (err) {
      lastError = toGraphError(err, op.id, attempt);
      emit({ type: 'process/operator/failed', operator_id: op.id, operator_type: opType(op.id), attempt, ok: false, ts: Date.now() });
      const retryable = op.error.retryable && errRetryable(err) !== false;
      if (attempt > MAX_RETRIES || !retryable) {
        break;
      }
      emit({ type: 'process/operator/retry', operator_id: op.id, operator_type: opType(op.id), attempt, ts: Date.now() });
      await delay(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: lastError ?? { code: 'E_OPERATOR', message: '未知失败', operator_id: op.id, attempt: MAX_RETRIES + 1 } };
}

/**
 * 图执行：Kahn 拓扑序 + 有界并发 fan-out（上限 FAN_OUT_CONCURRENCY）+ fan-in 依赖等待。
 * 预算：cost 总和超 budget → 执行前拒绝（决定：执行前校验，不逐算子扣减）。
 * 失败契约：retryable 重试 → 非重试/耗尽 → rollback 补偿 → 整图失败（failed + Negative Pattern 占位）。
 */
export async function executeGraph(graph: OperatorGraph, ctx: GraphExecutionContext): Promise<GraphResult> {
  const result: GraphResult = { ok: true, failed: false, outputs: {}, completed: [], events: [], rollbacks_called: [] };
  const emit = (evt: OperatorEvent) => {
    result.events.push(evt);
    ctx.eventSink?.(evt);
  };
  // 整图失败统一出口：标记失败（result.code = 失败类）+ 失败样本落库（T8.8；sink 未注入则仅标记）。
  // preciseError 提供时 result.error 保留精确算子错误（code 如 TIMEOUT/E_NO_CAPABILITY——m4 错误契约钉住）。
  const fail = async (
    code: string,
    message: string,
    operatorId?: string,
    attempt?: number,
    preciseError?: GraphError,
  ): Promise<GraphResult> => {
    result.ok = false;
    result.failed = true;
    result.code = code;
    result.error = preciseError ?? {
      code,
      message,
      ...(operatorId !== undefined ? { operator_id: operatorId } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
    };
    await emitNegativePattern(graph, ctx, result);
    return result;
  };

  // 预算：执行前总成本校验
  const totalCost = graph.operators.reduce((sum, op) => sum + operatorCost(op), 0);
  if (totalCost > ctx.budget) {
    return await fail('BUDGET_EXCEEDED', `算子总成本 ${totalCost} 超出预算 ${ctx.budget}`);
  }

  // 图结构校验：重复 id / 边引用未知算子
  const opById = new Map<string, OperatorSpec>();
  for (const op of graph.operators) {
    if (opById.has(op.id)) {
      return await fail('E_GRAPH', `重复算子 id: ${op.id}`);
    }
    opById.set(op.id, op);
  }
  for (const edge of graph.edges) {
    if (!opById.has(edge.from) || !opById.has(edge.to)) {
      return await fail('E_GRAPH', `边引用未知算子: ${edge.from}→${edge.to}`);
    }
  }

  // Kahn：入度 + 后继表；就绪队列按图序（确定性）
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const op of graph.operators) {
    indegree.set(op.id, 0);
    dependents.set(op.id, []);
  }
  for (const edge of graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    dependents.get(edge.from)?.push(edge.to);
  }
  const ready: string[] = graph.operators.filter((op) => (indegree.get(op.id) ?? 0) === 0).map((op) => op.id);
  const pending = new Set(graph.operators.map((op) => op.id));
  const outputs = new Map<string, unknown>();
  const registry = ctx.registry ?? {};

  // 拓扑执行：批内并发（上限 FAN_OUT_CONCURRENCY），批间依赖等待（fan-in）
  while (pending.size > 0) {
    if (ctx.signal?.aborted) {
      return await fail('CANCELLED', '图级信号取消');
    }
    if (ready.length === 0) {
      return await fail('CYCLE', '算子图存在环（Kahn 无法推进）');
    }
    const batch = ready.splice(0, FAN_OUT_CONCURRENCY);
    const settled = await Promise.all(batch.map((id) => runOne(opById.get(id)!, registry, ctx, outputs, emit)));
    for (let i = 0; i < batch.length; i++) {
      const id = batch[i]!;
      const outcome = settled[i]!;
      if (!outcome.ok) {
        const op = opById.get(id)!;
        const rollbackFn = op.error.rollback.length > 0 ? ctx.rollbacks?.[op.error.rollback] : undefined;
        if (rollbackFn) {
          try {
            await rollbackFn(outputs.get(id));
            result.rollbacks_called.push(op.error.rollback);
            emit({ type: 'process/operator/rollback', operator_id: id, operator_type: opType(id), attempt: outcome.error.attempt ?? 1, ts: Date.now() });
          } catch {
            // rollback 失败不阻断整图失败结论（M4 记录；补偿链留 M5）
          }
        }
        result.negative_pattern = outcome.error; // Negative Pattern 记录（T8.8 落库由 emitNegativePattern 处理）
        return await fail('OPERATOR_FAILED', outcome.error.message, undefined, undefined, outcome.error);
      }
      outputs.set(id, outcome.output);
      result.completed.push(id);
      pending.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        const next = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, next);
        if (next === 0) {
          ready.push(dep);
        }
      }
    }
  }

  result.outputs = Object.fromEntries(outputs);
  return result;
}
