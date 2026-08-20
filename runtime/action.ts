// OMB v2 Action Contract 执行语义（架构 §5.4 + §4.2 C8/C9）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
// 内容：validateAction（无验证方式拒绝，不进 Process 库）、rollbackAction（可逆性补偿，fail-loud）、
// runAction（状态机 planned→executing→done/failed/aborted + 事件钩子，仿 T4.1 OperatorEvent 轻量模式）。
// 执行语义（§5.4）：preconditions 可执行断言 → deps.execute（能力 ABI）→ expected_effect 可验证谓词 →
// actual_effect 绑定 Observation（deps.observe）；失败按 error.retryable 重试 ≤2 次 → 可逆则回滚；
// side_effects 检测声明（M4 最小：检测谓词可选，失败仅 warning）。
// 依赖注入（brief 明示）：execute/observe 经 deps 注入；predicates/verifiers/rollbacks/sideEffects 为
// 字符串键 → 谓词注册表（与 T4.1 OperatorContext 同模式）；per-run 载荷（contract/input/signal/eventSink）
// 经 opts 传入。predicate 未注册 fail-closed：precondition 视为 false、verification 视为不通过。
import type { CapabilityContract, CapabilityResult } from '../kernel/capability-abi.js';
import type { Action, ActionContract, Observation } from '../kernel/schemas/c.js';

// ---- 常量 ----

/** 重试上限 ≤ 2 次（总尝试 ≤ 3，与 T4.1 MAX_RETRIES 对齐） */
export const MAX_RETRIES = 2;

// ---- 契约类型 ----

/** precondition 断言上下文（谓词可读取执行输入与契约） */
export interface PreconditionContext {
  input: unknown;
  contract: ActionContract;
}

export type PreconditionFn = (ctx: PreconditionContext) => boolean | Promise<boolean>;

/** expected_effect 验证谓词：对 execute 输出逐项验证 */
export type EffectVerifyFn = (output: unknown) => boolean | Promise<boolean>;

/** rollback_path 补偿钩子（接收最后一次 execute 输出；与 T4.1 RollbackFn 同签名） */
export type RollbackFn = (output: unknown) => void | Promise<void>;

/** side_effect 检测谓词（M4 最小：可选，失败仅记录 warning） */
export type SideEffectDetectFn = (output: unknown) => boolean | Promise<boolean>;

/** Action 执行依赖（能力 ABI + 谓词/钩子注册表） */
export interface ActionDeps {
  execute: (contract: CapabilityContract, input: unknown) => Promise<CapabilityResult>;
  observe: (r: CapabilityResult) => Observation;
  predicates?: Record<string, PreconditionFn>;
  verifiers?: Record<string, EffectVerifyFn>;
  rollbacks?: Record<string, RollbackFn>;
  sideEffects?: Record<string, SideEffectDetectFn>;
}

/** per-run 载荷：能力契约绑定 + 执行输入 + 取消信号 + 事件钩子 */
export interface ActionRunOptions {
  contract: CapabilityContract;
  input?: unknown;
  signal?: AbortSignal;
  eventSink?: (e: ActionEvent) => void;
  logger?: (msg: string) => void;
}

export interface ActionOutcome {
  state: 'done' | 'failed' | 'aborted';
  /** done 时绑定：验证通过的 expected_effect 列表 */
  actual_effect?: string[];
  /** done 时绑定：execute 结果 observation_ref（无则取 observe 产物的 id） */
  observation_ref?: string;
  /** failed + 可逆时：回滚已执行 */
  rollback_performed?: boolean;
  reason?: string;
}

/** 状态迁移事件（轻量模式，仿 T4.1 OperatorEvent；action/* 前缀按 brief 允许） */
export type ActionEventType =
  | 'action/start'
  | 'action/retry'
  | 'action/end'
  | 'action/failed'
  | 'action/rollback'
  | 'action/aborted';

export interface ActionEvent {
  type: ActionEventType;
  action_id: string;
  /** 执行尝试序号（1 起；执行前 aborted 为 0） */
  attempt: number;
  ok?: boolean;
  reason?: string;
  ts: number;
}

/** ActionRunner 契约（brief §实现设计 转录；runAction 为具体实现） */
export interface ActionRunner {
  run(action: Action, deps: ActionDeps, opts?: ActionRunOptions): Promise<ActionOutcome>;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

// ---- 校验（无验证方式 → 拒绝，不进 Process 库） ----

/**
 * 校验：① expected_effect 非空且每项可验证（verification 描述非空）
 *      ② reversibility.declared=true 时 rollback_path 必须存在。
 * 无验证方式（expected_effect 空或项缺 verification）→ ok:false。
 */
export function validateAction(action: Action): ValidationResult {
  const effects = action.contract.expected_effect;
  if (!Array.isArray(effects) || effects.length === 0) {
    return { ok: false, reason: 'expected_effect 为空：无验证方式的 Action 不进 Process 库' };
  }
  for (const eff of effects) {
    if (typeof eff !== 'string' || eff.trim().length === 0) {
      return { ok: false, reason: `expected_effect 项缺失验证方式: ${JSON.stringify(eff)}` };
    }
  }
  if (
    action.contract.reversibility.declared &&
    (!action.contract.reversibility.rollback_path || action.contract.reversibility.rollback_path.trim().length === 0)
  ) {
    return { ok: false, reason: 'reversibility.declared=true 但 rollback_path 缺失' };
  }
  return { ok: true };
}

// ---- 回滚（可逆性补偿） ----

/**
 * 按 rollback_path 执行补偿（deps.rollbacks 注册表查找）。
 * 无回滚路径且 declared=true → fail-loud（throw）；钩子未注册 → fail-loud。
 * 未声明可逆 → no-op。
 */
export async function rollbackAction(action: Action, deps: ActionDeps, opts: { output?: unknown } = {}): Promise<void> {
  const { declared, rollback_path } = action.contract.reversibility;
  if (declared && (!rollback_path || rollback_path.length === 0)) {
    throw new Error('rollbackAction: reversibility.declared=true 但 rollback_path 缺失');
  }
  if (!rollback_path || rollback_path.length === 0) {
    return; // 未声明可逆 → 无补偿
  }
  const fn = deps.rollbacks?.[rollback_path];
  if (!fn) {
    throw new Error(`rollbackAction: 回滚钩子未注册: ${rollback_path}`);
  }
  await fn(opts.output);
}

// ---- 中止工具 ----

function abortError(): Error {
  const err = new Error('action aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

/** 执行中取消：信号中止 → 拒绝（不挂起）；与 T4.1 runAttempt 同模式 */
async function withAbort<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) {
    return fn();
  }
  if (signal.aborted) {
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    fn()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ---- 执行 ----

function isReversible(contract: ActionContract): boolean {
  return contract.reversibility.declared && contract.reversibility.rollback_path.length > 0;
}

/** 失败后补偿：可逆才执行回滚；回滚失败不改变 failed 结论（记录 warning，补偿链留 M5） */
async function maybeRollback(
  action: Action,
  deps: ActionDeps,
  ctx: { output?: unknown; attempt: number; emit: (e: ActionEvent) => void; logger?: (msg: string) => void },
): Promise<boolean> {
  if (!isReversible(action.contract)) {
    return false;
  }
  try {
    await rollbackAction(action, deps, { output: ctx.output });
    ctx.emit({ type: 'action/rollback', action_id: action.id, attempt: ctx.attempt, ts: Date.now() });
    return true;
  } catch (err) {
    ctx.logger?.(`warning: action 回滚失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * 能力 ABI 调用 + 错误契约：retryable 错误重试 ≤2 次（立即重试，无退避——Action 层不承诺节流）；
 * 耗尽/非重试 → 返回最终失败结果；execute 抛异常 → 视为非重试失败（E_EXECUTE）；AbortError 透传（→ aborted）。
 */
async function executeWithRetry(
  action: Action,
  deps: ActionDeps,
  opts: ActionRunOptions,
  emit: (e: ActionEvent) => void,
): Promise<{ result: CapabilityResult; attempts: number }> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    throwIfAborted(opts.signal);
    let r: CapabilityResult;
    try {
      r = await withAbort(opts.signal, () => deps.execute(opts.contract, opts.input));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      r = { ok: false, error: { code: 'E_EXECUTE', message, retryable: false }, metrics: { tokens: 0, latency_ms: 0 } };
    }
    if (r.ok) {
      return { result: r, attempts: attempt };
    }
    if (attempt <= MAX_RETRIES && r.error?.retryable) {
      emit({ type: 'action/retry', action_id: action.id, attempt, reason: r.error.message, ts: Date.now() });
      continue;
    }
    return { result: r, attempts: attempt };
  }
  throw new Error('unreachable');
}

/**
 * Action 执行（状态机 planned→executing→done/failed/aborted，每状态迁移写事件钩子）：
 * 1. planned → executing（事件钩子）
 * 2. preconditions 断言：全部 true 才继续；任一 false → failed（precondition_failed），不执行
 * 3. 经 deps.execute 调用（能力 ABI）→ CapabilityResult
 * 4. ok → expected_effect 验证：谓词逐项对 output 验证；全过 → done + actual_effect 绑定 Observation；
 *    有失败 → failed（effect_mismatch）+ 若可逆 → 回滚
 * 5. 失败（execute error）→ 按 error.retryable 重试 ≤2 次 → 仍失败 → failed + 可逆则回滚
 * 6. side_effects 声明：执行后检测（M4 最小：记录声明在 contract.side_effects，检测谓词可选）
 * 7. 事件钩子：每状态迁移写 Event（action/* 前缀，轻量模式）
 * 中止：signal 已中止 → 直接 aborted；执行中中止 → aborted（终态，不重试不回滚）。
 */
export async function runAction(action: Action, deps: ActionDeps, opts: ActionRunOptions = {} as ActionRunOptions): Promise<ActionOutcome> {
  if (!opts.contract) {
    throw new Error('runAction: 缺少能力契约（opts.contract）');
  }
  const { signal, eventSink, logger } = opts;
  const emit = (e: ActionEvent) => eventSink?.(e);

  if (signal?.aborted) {
    action.state = 'aborted';
    emit({ type: 'action/aborted', action_id: action.id, attempt: 0, reason: 'aborted', ts: Date.now() });
    return { state: 'aborted', reason: 'aborted' };
  }
  action.state = 'executing';
  emit({ type: 'action/start', action_id: action.id, attempt: 1, ts: Date.now() });

  try {
    // 2. preconditions 断言（谓词未注册 → fail-closed）
    for (const pre of action.contract.preconditions) {
      throwIfAborted(signal);
      const pred = deps.predicates?.[pre];
      const pass = pred ? await pred({ input: opts.input, contract: action.contract }) : false;
      if (!pass) {
        action.state = 'failed';
        emit({ type: 'action/failed', action_id: action.id, attempt: 1, ok: false, reason: 'precondition_failed', ts: Date.now() });
        return { state: 'failed', reason: `precondition_failed: ${pre}` };
      }
    }

    // 3. 能力 ABI 调用（3/5. 错误契约：retryable 重试 ≤2 次 → 仍失败 → failed + 可逆则回滚）
    const { result, attempts } = await executeWithRetry(action, deps, opts, emit);
    if (!result.ok) {
      const code = result.error?.code ?? 'E_UNKNOWN';
      const message = result.error?.message ?? '未知错误';
      const reason = `execute_failed: ${code}: ${message}`;
      action.state = 'failed';
      emit({ type: 'action/failed', action_id: action.id, attempt: attempts, ok: false, reason, ts: Date.now() });
      const rollback_performed = await maybeRollback(action, deps, { output: undefined, attempt: attempts, emit, logger });
      return { state: 'failed', reason, ...(rollback_performed ? { rollback_performed } : {}) };
    }

    // 4. expected_effect 验证（谓词未注册 → 视为不通过；任一失败 → effect_mismatch + 可逆则回滚）
    const output = result.output;
    const failedEffects: string[] = [];
    for (const eff of action.contract.expected_effect) {
      throwIfAborted(signal);
      const verifier = deps.verifiers?.[eff];
      const pass = verifier ? await verifier(output) : false;
      if (!pass) {
        failedEffects.push(eff);
      }
    }
    if (failedEffects.length > 0) {
      const reason = `effect_mismatch: ${failedEffects.join(', ')}`;
      action.state = 'failed';
      emit({ type: 'action/failed', action_id: action.id, attempt: attempts, ok: false, reason, ts: Date.now() });
      const rollback_performed = await maybeRollback(action, deps, { output, attempt: attempts, emit, logger });
      return { state: 'failed', reason, ...(rollback_performed ? { rollback_performed } : {}) };
    }

    // 6. side_effects 检测（M4 最小：检测谓词可选；失败仅 warning，不改变结论）
    for (const se of action.contract.side_effects) {
      const detect = deps.sideEffects?.[se];
      if (detect && !(await detect(output))) {
        logger?.(`warning: side_effect 检测失败: ${se}`);
      }
    }

    // 4. done + actual_effect 绑定 Observation（deps.observe）
    const observation = deps.observe(result);
    const observation_ref = result.observation_ref ?? observation.id;
    action.state = 'done';
    emit({ type: 'action/end', action_id: action.id, attempt: attempts, ok: true, ts: Date.now() });
    return {
      state: 'done',
      actual_effect: [...action.contract.expected_effect],
      ...(observation_ref !== undefined ? { observation_ref } : {}),
    };
  } catch (err) {
    // 中止终态：executing → aborted（不重试不回滚——取消即放弃）
    if (err instanceof Error && err.name === 'AbortError') {
      action.state = 'aborted';
      emit({ type: 'action/aborted', action_id: action.id, attempt: 1, reason: 'aborted', ts: Date.now() });
      return { state: 'aborted', reason: 'aborted' };
    }
    throw err;
  }
}
