// T4.3 行为测试：Action Contract 执行语义（runtime/action.ts，架构 §5.4 + §4.2 C8/C9）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失：runtime/action.ts 不存在）。
// 九组：① preconditions 断言（全过执行 / 任一 false 不执行 + failed / 谓词未注册 fail-closed）
//       ② expected_effect 验证通过 → done + actual_effect 绑定 observation_ref（+ side_effects 检测谓词）
//       ③ expected_effect 验证失败 → failed（effect_mismatch）
//       ④ 无验证方式拒绝（expected_effect 空 / 项缺 verification → validateAction 拒绝，不进 Process 库）
//       ⑤ 可逆性（declared=true 无 rollback_path 拒绝；有路径失败时 rollbackAction 被调；钩子未注册 fail-loud）
//       ⑥ 重试（retryable 错误 → 重试 ≤2 次成功 → done；耗尽 → failed + 回滚）
//       ⑦ 非重试错误 → 单次尝试 failed + 回滚
//       ⑧ 状态机事件序列（planned→executing→done/failed；事件钩子断言 + 中间态断言）
//       ⑨ abort（signal 中止 → aborted，不挂起）
//       ⑩ runner 输入守卫（未提供 opts.contract → fail-loud）
// 依赖注入（brief 明示）：execute/observe 经 deps 注入（测试用计数器/记录数组，无 mock 框架，
// 仿 T4.1 operator.test.ts 的 fake 模式）。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_RETRIES,
  rollbackAction,
  runAction,
  validateAction,
  type ActionEvent,
} from '../../runtime/action.js';
import type { CapabilityContract, CapabilityResult } from '../../kernel/capability-abi.js';
import type { Action, ActionContract, Observation } from '../../kernel/schemas/c.js';

// ---- 测试工具 ----

const TS = '2026-08-21T00:00:00.000Z';
const UUID = '11111111-1111-4111-8111-111111111111';
const FP = { os: 'win32', node: '24.12.0', dsh_version: '0.4.0', project: 'omb-v2' };
const PROV = {
  source: 'model',
  event: 'event:1',
  actor: 'kernel',
  environment: FP,
  runtime_snapshot: 'rs:1',
  timestamp: TS,
  transformation_chain: [],
  verification: 'v:1',
};

/** ActionContract 工厂（缺省：无前置条件、单个 expected_effect、不可逆；overrides 覆盖单字段） */
function mkContract(over: Partial<ActionContract> = {}): ActionContract {
  return {
    preconditions: [],
    expected_effect: ['eff-1'],
    actual_effect: [],
    cost: 10,
    risk: 'low',
    reversibility: { declared: false, rollback_path: '' },
    side_effects: [],
    provenance: PROV,
    ...over,
  } as ActionContract;
}

/** C8 Action 工厂（IRBase 字段齐全；state 缺省 planned） */
function mkAction(over: Partial<Action> = {}): Action {
  return {
    id: `action:${UUID}`,
    ir_version: '2.0',
    schema: 'omb/C8',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: PROV,
    refs: [],
    contract: mkContract(),
    state: 'planned',
    ...over,
  } as Action;
}

/** CapabilityContract fixture（与 T2.5 能力 ABI 对齐） */
const CAP: CapabilityContract = {
  id: 'cap:test',
  name: 'test-cap',
  input: z.any(),
  output: z.any(),
  cost: {},
  side_effect: 'read_only',
  reversibility: { declared: true, rollback_path: 'rb-x' },
  reliability: 'high',
  evidence_quality: 'none',
  idempotency: 'idempotent',
  concurrency: 'safe',
  authority_scope: 'kernel',
};

/** execute spy：handler 收到调用序号（1 起），返回 CapabilityResult；记录每次 (contract, input) */
function mkExecute(handler: (call: number) => CapabilityResult) {
  const calls: { contract: CapabilityContract; input: unknown }[] = [];
  const execute = async (contract: CapabilityContract, input: unknown) => {
    calls.push({ contract, input });
    return handler(calls.length);
  };
  return { execute, calls };
}

/** observe spy：记录被绑定的 CapabilityResult，返回带 id 的 Observation（IRBase 字段由调用方补全） */
function mkObserve() {
  const calls: CapabilityResult[] = [];
  const observe = (r: CapabilityResult): Observation => {
    calls.push(r);
    return { id: `observation:bound-${calls.length}`, from: 'tool' as const, payload: 'art:1', ts: TS } as Observation;
  };
  return { observe, calls };
}

const OK_RESULT: CapabilityResult = {
  ok: true,
  output: { file: '/tmp/x', size: 10 },
  observation_ref: 'observation:6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  metrics: { tokens: 1, latency_ms: 1 },
};

const FAIL_RESULT = (code: string, message: string, retryable: boolean): CapabilityResult => ({
  ok: false,
  error: { code, message, retryable },
  metrics: { tokens: 0, latency_ms: 0 },
});

// ---- ① preconditions ----

describe('① preconditions 断言（全过执行；任一 false 不执行 + failed）', () => {
  it('preconditions 全过 → execute 被调（contract+input），outcome done', async () => {
    const action = mkAction({ contract: mkContract({ preconditions: ['pre-a', 'pre-b'] }) });
    const { execute, calls } = mkExecute(() => OK_RESULT);
    const outcome = await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        predicates: { 'pre-a': () => true, 'pre-b': () => true },
        verifiers: { 'eff-1': () => true },
      },
      { contract: CAP, input: { path: '/tmp/x' } },
    );
    expect(outcome.state).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contract.id).toBe(CAP.id);
    expect(calls[0]!.input).toEqual({ path: '/tmp/x' });
    expect(action.state).toBe('done');
  });

  it('任一 precondition false → execute 未被调，outcome failed（precondition_failed），state failed', async () => {
    const action = mkAction({ contract: mkContract({ preconditions: ['pre-a', 'pre-b'] }) });
    const { execute, calls } = mkExecute(() => OK_RESULT);
    const outcome = await runAction(
      action,
      { execute, observe: mkObserve().observe, predicates: { 'pre-a': () => true, 'pre-b': () => false } },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('precondition_failed');
    expect(outcome.reason).toContain('pre-b');
    expect(calls).toHaveLength(0);
    expect(action.state).toBe('failed');
  });

  it('precondition 谓词未注册 → fail-closed（视为 false，不执行）', async () => {
    const action = mkAction({ contract: mkContract({ preconditions: ['pre-missing'] }) });
    const { execute, calls } = mkExecute(() => OK_RESULT);
    const outcome = await runAction(action, { execute, observe: mkObserve().observe, predicates: {} }, { contract: CAP });
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('precondition_failed');
    expect(calls).toHaveLength(0);
  });
});

// ---- ② expected_effect 验证通过 ----

describe('② expected_effect 验证通过 → done + actual_effect 绑定 observation_ref', () => {
  it('验证全过 → done：actual_effect=expected_effect，observation_ref 取自 execute 结果，observe 绑定执行结果', async () => {
    const action = mkAction({ contract: mkContract({ expected_effect: ['eff-1', 'eff-2'], side_effects: ['se-x'] }) });
    const { execute } = mkExecute(() => OK_RESULT);
    const { observe, calls: observeCalls } = mkObserve();
    const detected: string[] = [];
    const outcome = await runAction(
      action,
      {
        execute,
        observe,
        verifiers: { 'eff-1': (o) => (o as { file?: string }).file === '/tmp/x', 'eff-2': () => true },
        sideEffects: {
          'se-x': (o) => {
            detected.push(String((o as { file?: string }).file));
            return true;
          },
        },
      },
      { contract: CAP, input: { path: '/tmp/x' } },
    );
    expect(outcome.state).toBe('done');
    expect(outcome.actual_effect).toEqual(['eff-1', 'eff-2']);
    expect(outcome.observation_ref).toBe(OK_RESULT.observation_ref);
    expect(observeCalls).toHaveLength(1);
    expect(observeCalls[0]).toBe(OK_RESULT); // actual_effect 绑定的是 execute 结果
    expect(detected).toEqual(['/tmp/x']); // side_effects 检测谓词执行（M4 最小）
    expect(action.state).toBe('done');
  });
});

// ---- ③ expected_effect 验证失败 ----

describe('③ expected_effect 验证失败 → failed（effect_mismatch）', () => {
  it('任一验证谓词拒绝 → failed reason effect_mismatch（含失败项），无回滚声明则不回滚', async () => {
    const action = mkAction({ contract: mkContract({ expected_effect: ['eff-ok', 'eff-bad'] }) });
    const { execute } = mkExecute(() => OK_RESULT);
    const outcome = await runAction(
      action,
      { execute, observe: mkObserve().observe, verifiers: { 'eff-ok': () => true, 'eff-bad': () => false } },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('effect_mismatch');
    expect(outcome.reason).toContain('eff-bad');
    expect(outcome.rollback_performed).toBeUndefined();
    expect(action.state).toBe('failed');
  });
});

// ---- ④ 无验证方式拒绝 ----

describe('④ 无验证方式拒绝（expected_effect 空 / 项缺 verification → 不进 Process 库）', () => {
  it('expected_effect 为空 → validateAction 拒绝', () => {
    const action = mkAction({ contract: mkContract({ expected_effect: [] }) });
    const v = validateAction(action);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('expected_effect');
  });

  it('expected_effect 有项但 verification 缺失（空串）→ 拒绝', () => {
    const action = mkAction({ contract: mkContract({ expected_effect: [''] }) });
    const v = validateAction(action);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('expected_effect');
  });

  it('合法 Action（验证方式齐全）→ 通过', () => {
    expect(validateAction(mkAction()).ok).toBe(true);
  });
});

// ---- ⑤ 可逆性 ----

describe('⑤ 可逆性（declared=true 无 rollback_path 拒绝；有路径失败时回滚）', () => {
  it('reversibility.declared=true 但 rollback_path 缺失 → validateAction 拒绝', () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: '' } }) });
    const v = validateAction(action);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('rollback_path');
  });

  it('可逆 + 执行失败 → rollbackAction 被调，outcome.rollback_performed=true', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: 'rb-x' } }) });
    let rollbackCalls = 0;
    const { execute } = mkExecute(() => FAIL_RESULT('E_FATAL', 'fatal', false));
    const outcome = await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        rollbacks: {
          'rb-x': async () => {
            rollbackCalls++;
          },
        },
      },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.rollback_performed).toBe(true);
    expect(rollbackCalls).toBe(1);
    expect(action.state).toBe('failed');
  });

  it('验证失败同样走回滚（effect_mismatch + 可逆）', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: 'rb-x' } }) });
    let rollbackCalls = 0;
    const { execute } = mkExecute(() => OK_RESULT);
    const outcome = await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        verifiers: { 'eff-1': () => false },
        rollbacks: {
          'rb-x': async () => {
            rollbackCalls++;
          },
        },
      },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('effect_mismatch');
    expect(outcome.rollback_performed).toBe(true);
    expect(rollbackCalls).toBe(1);
  });

  it('declared=true 且 rollback_path 缺失 → rollbackAction fail-loud', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: '' } }) });
    await expect(rollbackAction(action, { execute: async () => OK_RESULT, observe: mkObserve().observe })).rejects.toThrow(
      /rollback_path/,
    );
  });

  it('回滚钩子未注册（declared=true，路径非空）→ rollbackAction fail-loud', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: 'rb-missing' } }) });
    await expect(
      rollbackAction(action, { execute: async () => OK_RESULT, observe: mkObserve().observe, rollbacks: {} }),
    ).rejects.toThrow(/rb-missing/);
  });
});

// ---- ⑥ 重试 ----

describe('⑥ 重试（retryable 错误 → 重试 ≤2 次；耗尽 → failed + 回滚）', () => {
  it('前两次 retryable 失败 → 第三次成功：execute 共 3 次，outcome done，重试事件 2 条', async () => {
    const action = mkAction();
    const { execute, calls } = mkExecute((n) => (n < 3 ? FAIL_RESULT('E_TRANSIENT', `transient-${n}`, true) : OK_RESULT));
    const events: ActionEvent[] = [];
    const outcome = await runAction(
      action,
      { execute, observe: mkObserve().observe, verifiers: { 'eff-1': () => true } },
      { contract: CAP, eventSink: (e) => events.push(e) },
    );
    expect(outcome.state).toBe('done');
    expect(calls).toHaveLength(3); // 重试 ≤ 2 次
    expect(events.filter((e) => e.type === 'action/retry')).toHaveLength(2);
    expect(action.state).toBe('done');
  });

  it('retryable 始终失败 → MAX_RETRIES+1 次尝试后 failed（reason execute_failed），可逆则回滚', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: 'rb-x' } }) });
    let rollbackCalls = 0;
    const { execute, calls } = mkExecute(() => FAIL_RESULT('E_TRANSIENT', 'always', true));
    const outcome = await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        rollbacks: {
          'rb-x': async () => {
            rollbackCalls++;
          },
        },
      },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(calls).toHaveLength(MAX_RETRIES + 1);
    expect(outcome.reason).toContain('E_TRANSIENT');
    expect(outcome.rollback_performed).toBe(true);
    expect(rollbackCalls).toBe(1);
  });
});

// ---- ⑦ 非重试错误 ----

describe('⑦ 非重试错误 → 单次尝试 failed + 回滚', () => {
  it('execute 返回非 retryable 错误 → execute 仅 1 次，failed（reason 含错误码），回滚执行', async () => {
    const action = mkAction({ contract: mkContract({ reversibility: { declared: true, rollback_path: 'rb-x' } }) });
    let rollbackCalls = 0;
    const { execute, calls } = mkExecute(() => FAIL_RESULT('E_FATAL', 'fatal', false));
    const outcome = await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        rollbacks: {
          'rb-x': async () => {
            rollbackCalls++;
          },
        },
      },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('E_FATAL');
    expect(calls).toHaveLength(1); // 不重试
    expect(rollbackCalls).toBe(1);
    expect(outcome.rollback_performed).toBe(true);
  });

  it('execute 抛异常（非 CapabilityResult 错误）→ 视为非重试失败 E_EXECUTE，不回滚（无声明）', async () => {
    const action = mkAction();
    const outcome = await runAction(
      action,
      {
        execute: async () => {
          throw new Error('boom');
        },
        observe: mkObserve().observe,
      },
      { contract: CAP },
    );
    expect(outcome.state).toBe('failed');
    expect(outcome.reason).toContain('E_EXECUTE');
    expect(outcome.reason).toContain('boom');
    expect(outcome.rollback_performed).toBeUndefined();
  });
});

// ---- ⑧ 状态机事件序列 ----

describe('⑧ 状态机：planned→executing→done/failed 事件序列（事件钩子断言）', () => {
  it('成功路径：事件序列 [action/start, action/end]；precondition 断言期间 state=executing；终态 done', async () => {
    const action = mkAction({ contract: mkContract({ preconditions: ['pre-a'] }) });
    const states: string[] = [];
    const events: ActionEvent[] = [];
    const { execute } = mkExecute(() => OK_RESULT);
    await runAction(
      action,
      {
        execute,
        observe: mkObserve().observe,
        predicates: {
          'pre-a': () => {
            states.push(action.state);
            return true;
          },
        },
        verifiers: { 'eff-1': () => true },
      },
      { contract: CAP, eventSink: (e) => events.push(e) },
    );
    expect(states).toEqual(['executing']); // 断言在 executing 状态下执行（planned→executing 已迁移）
    expect(events.map((e) => e.type)).toEqual(['action/start', 'action/end']);
    expect(events[0]!.attempt).toBe(1);
    expect(action.state).toBe('done');
  });

  it('失败路径：事件序列 [action/start, action/failed]；终态 failed', async () => {
    const action = mkAction();
    const events: ActionEvent[] = [];
    const { execute } = mkExecute(() => FAIL_RESULT('E_FATAL', 'fatal', false));
    const outcome = await runAction(action, { execute, observe: mkObserve().observe }, { contract: CAP, eventSink: (e) => events.push(e) });
    expect(outcome.state).toBe('failed');
    expect(events.map((e) => e.type)).toEqual(['action/start', 'action/failed']);
    expect(events[0]!.attempt).toBe(1);
    expect(action.state).toBe('failed');
  });
});

// ---- ⑨ abort ----

describe('⑨ abort（signal 中止 → aborted，不挂起）', () => {
  it('执行前信号已中止 → outcome aborted，execute 未被调，state aborted', async () => {
    const action = mkAction();
    const controller = new AbortController();
    controller.abort();
    const { execute, calls } = mkExecute(() => OK_RESULT);
    const events: ActionEvent[] = [];
    const outcome = await runAction(
      action,
      { execute, observe: mkObserve().observe },
      { contract: CAP, signal: controller.signal, eventSink: (e) => events.push(e) },
    );
    expect(outcome.state).toBe('aborted');
    expect(calls).toHaveLength(0);
    expect(action.state).toBe('aborted');
    expect(events.map((e) => e.type)).toEqual(['action/aborted']);
  });

  it('执行中 abort（execute 挂起时触发）→ outcome aborted，不挂起', async () => {
    const action = mkAction();
    const controller = new AbortController();
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let entered: (() => void) | undefined;
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const execute = async () => {
      entered?.();
      await gate; // 挂起：中止由 abort 事件驱动
      return OK_RESULT;
    };
    const events: ActionEvent[] = [];
    const pending = runAction(
      action,
      { execute, observe: mkObserve().observe },
      { contract: CAP, signal: controller.signal, eventSink: (e) => events.push(e) },
    );
    await enteredP; // 等 execute 进入挂起后再中止
    controller.abort();
    releaseGate?.(); // 释放挂起（外层已因 abort 拒绝，此处仅清理悬空 promise）
    const outcome = await pending;
    expect(outcome.state).toBe('aborted');
    expect(action.state).toBe('aborted');
    expect(events.map((e) => e.type)).toEqual(['action/start', 'action/aborted']);
  });
});

// ---- ⑩ runner 输入守卫 ----

describe('⑩ runner 输入守卫（能力契约缺失 → fail-loud，不静默执行）', () => {
  it('未提供 opts.contract → runAction 抛错（不把 undefined 契约传给 execute）', async () => {
    const action = mkAction();
    const { execute, calls } = mkExecute(() => OK_RESULT);
    await expect(runAction(action, { execute, observe: mkObserve().observe })).rejects.toThrow(/contract/);
    expect(calls).toHaveLength(0);
  });
});
