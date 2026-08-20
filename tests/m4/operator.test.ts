// T4.1 行为测试：Operator ABI 与内置算子（runtime/operator.ts + runtime/operator-builtins.ts，架构 §5.3）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 十二组：① 拓扑执行顺序（Kahn + 事件序列）② fan-out 并行（并发上限 2）
//         ③ 数据流绑定（input_binding ref/const/数组 fan-in）④ EXECUTE 经 CapabilityHandle
//         ⑤ 错误契约-重试（≤2 次指数退避）⑥ 错误契约-非重试 + rollback 补偿
//         ⑦ 超时（AbortSignal.timeout）⑧ 预算（cost 总和超 budget 执行前拒绝）
//         ⑨ 每算子 Event（eventSink 注入）⑩ Micro Certificate（结构完整/确定性）
//         ⑪ 验证谓词（verification 字段；无谓词 → warning）。
//         ⑫ 取消/超时终态语义（CANCELLED 终态不重试；TIMEOUT 按 spec.error.retryable 取舍）。
// 依赖注入（brief 明示）：RETRIEVE 用 fake retrieveFn；EXECUTE 用 fake CapabilityProvider；
// 自定义算子经 ctx.registry 注入（测试仅用计数器/记录数组，无 mock 框架）。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  executeGraph,
  buildMicroCertificate,
  type ExperimentPlan,
  type GraphEdge,
  type Hypothesis,
  type Observation,
  type OperatorContext,
  type OperatorEvent,
  type OperatorFn,
  type OperatorGraph,
  type OperatorSpec,
  type RetrieveFn,
  type StopReport,
  type ToolResult,
} from '../../runtime/operator.js';
import type { CapabilityContract, CapabilityProvider } from '../../kernel/capability-abi.js';

// ---- 测试工具 ----

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** OperatorSpec 工厂（默认：read_only、无验证、无超时/重试/回滚；overrides 覆盖单字段） */
function op(id: string, over: Partial<OperatorSpec> = {}): OperatorSpec {
  return {
    id,
    version: '1.0',
    input_binding: {},
    output: 'out',
    cost: { tokens: 1 },
    side_effect: 'read_only',
    verification: '',
    error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '' },
    transaction: false,
    ...over,
  };
}

/** OperatorGraph 工厂 */
function graph(operators: OperatorSpec[], edges: GraphEdge[], entry: string, exit: string): OperatorGraph {
  return { operators, edges, entry, exit };
}

/** 事件序列索引（按类型 + 算子 id 定位首现） */
function startIdx(events: OperatorEvent[], id: string): number {
  return events.findIndex((e) => e.type === 'process/operator/start' && e.operator_id === id);
}
function endIdx(events: OperatorEvent[], id: string): number {
  return events.findIndex((e) => e.type === 'process/operator/end' && e.operator_id === id);
}

/** fake retrieveFn（M4 注入；生产由 boot 装配 M3 backend） */
function fakeRetrieve(items: unknown[]): RetrieveFn {
  return async () => ({ items, channel_used: 'lexical' });
}

/** fake CapabilityProvider（EXECUTE 经 Handle 调用路径） */
function echoProvider(calls: unknown[]): { provider: CapabilityProvider; sawCtx: { scope: string; budget: number }[] } {
  const sawCtx: { scope: string; budget: number }[] = [];
  const manifest: CapabilityContract = {
    id: 'cap:echo',
    name: 'echo',
    input: z.any(),
    output: z.any(),
    cost: {},
    side_effect: 'read_only',
    reversibility: { declared: false },
    reliability: 'high',
    evidence_quality: 'none',
    idempotency: 'idempotent',
    concurrency: 'safe',
    authority_scope: 'kernel',
  };
  const provider: CapabilityProvider = {
    manifest,
    async createHandle(ctx) {
      sawCtx.push(ctx);
      return {
        contract: manifest,
        async execute(input: unknown) {
          calls.push(input);
          return {
            ok: true,
            output: { echo: input },
            observation_ref: 'observation:6ba7b810-9dad-11d1-80b4-00c04fd430c8',
            metrics: { tokens: 1, latency_ms: 1 },
          };
        },
      };
    },
  };
  return { provider, sawCtx };
}

// ---- ① 拓扑执行顺序 ----

describe('① 拓扑执行顺序（RETRIEVE→HYPOTHESIZE×2→DISCRIMINATE→STOP）', () => {
  it('Kahn 拓扑序：事件序列与 completed 顺序正确，fan-in 合并两路假设', async () => {
    const events: OperatorEvent[] = [];
    const res = await executeGraph(
      graph(
        [
          op('RETRIEVE', { input_binding: { q: { const: '记忆查询' }, scope: { const: 'Project' } } }),
          op('HYPOTHESIZE-1', { input_binding: { state: { ref: 'RETRIEVE' }, n: { const: 2 } } }),
          op('HYPOTHESIZE-2', { input_binding: { state: { ref: 'RETRIEVE' }, n: { const: 3 } } }),
          op('DISCRIMINATE', {
            input_binding: {
              h: [{ ref: 'HYPOTHESIZE-1' }, { ref: 'HYPOTHESIZE-2' }], // 数组绑定 = fan-in 合并
              s: { const: { capability_ids: ['cap:default'] } },
              gaps: { const: [] },
            },
          }),
          op('STOP', { input_binding: { state: { ref: 'DISCRIMINATE' }, reason: { const: 'done' } } }),
        ],
        [
          { from: 'RETRIEVE', to: 'HYPOTHESIZE-1' },
          { from: 'RETRIEVE', to: 'HYPOTHESIZE-2' },
          { from: 'HYPOTHESIZE-1', to: 'DISCRIMINATE' },
          { from: 'HYPOTHESIZE-2', to: 'DISCRIMINATE' },
          { from: 'DISCRIMINATE', to: 'STOP' },
        ],
        'RETRIEVE',
        'STOP',
      ),
      { inputs: {}, budget: 1000, retrieveFn: fakeRetrieve([{ id: 'mem-1', payload: '记忆A' }]), eventSink: (e) => events.push(e) },
    );

    expect(res.ok).toBe(true);
    expect(res.failed).toBe(false);
    // completed：RETRIEVE 首、STOP 末，两路假设先于 fan-in 汇
    expect(res.completed[0]).toBe('RETRIEVE');
    expect(res.completed[res.completed.length - 1]).toBe('STOP');
    expect(res.completed.indexOf('HYPOTHESIZE-1')).toBeLessThan(res.completed.indexOf('DISCRIMINATE'));
    expect(res.completed.indexOf('HYPOTHESIZE-2')).toBeLessThan(res.completed.indexOf('DISCRIMINATE'));

    // 事件序列：RETRIEVE 完成 → 两路假设 → DISCRIMINATE → STOP（start/end 各自成对）
    expect(startIdx(events, 'RETRIEVE')).toBeGreaterThanOrEqual(0);
    expect(startIdx(events, 'RETRIEVE')).toBeLessThan(endIdx(events, 'RETRIEVE'));
    expect(endIdx(events, 'RETRIEVE')).toBeLessThan(Math.min(startIdx(events, 'HYPOTHESIZE-1'), startIdx(events, 'HYPOTHESIZE-2')));
    expect(Math.max(endIdx(events, 'HYPOTHESIZE-1'), endIdx(events, 'HYPOTHESIZE-2'))).toBeLessThan(startIdx(events, 'DISCRIMINATE'));
    expect(endIdx(events, 'DISCRIMINATE')).toBeLessThan(startIdx(events, 'STOP'));
    expect(endIdx(events, 'STOP')).toBe(events.length - 1);

    // fan-in 合并：DISCRIMINATE 收到 HYPOTHESIZE-1(2 条) + HYPOTHESIZE-2(3 条) = 5 个实验计划
    const plan = res.outputs['DISCRIMINATE'] as ExperimentPlan;
    expect(plan.experiments).toHaveLength(5);
    // STOP 输出
    const stop = res.outputs['STOP'] as StopReport;
    expect(stop.reason).toBe('done');
  });
});

// ---- ② fan-out 并行 ----

describe('② fan-out 并行（并发上限 2，fan-in 等待全部）', () => {
  it('两个无依赖算子并发执行：交错证明并行；两路输出都进 fan-in', async () => {
    const trace: string[] = [];
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    // P1 阻塞等待 P2 放行：顺序执行实现下 P1 会超时后才结束 → 断言失败
    const p1: OperatorFn = {
      async run() {
        trace.push('p1-start');
        await Promise.race([gate, delay(500)]);
        trace.push('p1-end');
        return 'o1';
      },
    };
    const p2: OperatorFn = {
      async run() {
        trace.push('p2-start');
        releaseGate?.();
        await delay(20);
        trace.push('p2-end');
        return 'o2';
      },
    };
    const join: OperatorFn = {
      async run(ctx: OperatorContext) {
        trace.push(`join:${String(ctx.inputs.a)},${String(ctx.inputs.b)}`);
        return 'joined';
      },
    };

    const res = await executeGraph(
      graph(
        [
          op('P1'),
          op('P2'),
          op('JOIN', { input_binding: { a: { ref: 'P1' }, b: { ref: 'P2' } } }),
        ],
        [
          { from: 'P1', to: 'JOIN' },
          { from: 'P2', to: 'JOIN' },
        ],
        'P1',
        'JOIN',
      ),
      { inputs: {}, budget: 100, registry: { P1: p1, P2: p2, JOIN: join } },
    );

    expect(res.ok).toBe(true);
    // 并行证明：P1 在 P2 启动时仍未结束（gate 依赖 P2 放行）
    expect(trace.indexOf('p2-start')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('p2-start')).toBeLessThan(trace.indexOf('p1-end'));
    // 两路输出都进 fan-in
    expect(trace).toContain('join:o1,o2');
    expect(res.completed.indexOf('P1')).toBeLessThan(res.completed.indexOf('JOIN'));
    expect(res.completed.indexOf('P2')).toBeLessThan(res.completed.indexOf('JOIN'));
  });
});

// ---- ③ 数据流绑定 ----

describe('③ 数据流绑定（input_binding：ref 引用上游输出）', () => {
  it('RETRIEVE 输出经 ref 绑定进入 HYPOTHESIZE 输入', async () => {
    const res = await executeGraph(
      graph(
        [
          op('RETRIEVE', { input_binding: { q: { const: '记忆查询' }, scope: { const: 'Project' } } }),
          op('HYPOTHESIZE-1', { input_binding: { state: { ref: 'RETRIEVE' }, n: { const: 1 } } }),
        ],
        [{ from: 'RETRIEVE', to: 'HYPOTHESIZE-1' }],
        'RETRIEVE',
        'HYPOTHESIZE-1',
      ),
      { inputs: {}, budget: 100, retrieveFn: fakeRetrieve([{ id: 'mem-1', payload: 'SQLite记忆存储实测通过' }]) },
    );

    expect(res.ok).toBe(true);
    const hyps = res.outputs['HYPOTHESIZE-1'] as Hypothesis[];
    expect(hyps).toHaveLength(1);
    // HYPOTHESIZE 的 state 输入来自 RETRIEVE 的 MemoryPack（items.payload 派生事实池）
    expect(hyps[0]!.text).toContain('SQLite记忆存储实测通过');
  });

  it('ref + path 字段路径绑定：取上游输出的子字段', async () => {
    const res = await executeGraph(
      graph(
        [
          op('RETRIEVE', { input_binding: { q: { const: 'x' }, scope: { const: 'Project' } } }),
          op('HYPOTHESIZE-1', { input_binding: { state: { ref: 'RETRIEVE', path: 'items' }, n: { const: 2 } } }),
        ],
        [{ from: 'RETRIEVE', to: 'HYPOTHESIZE-1' }],
        'RETRIEVE',
        'HYPOTHESIZE-1',
      ),
      { inputs: {}, budget: 100, retrieveFn: fakeRetrieve([{ id: 'mem-1', payload: '路径绑定' }]) },
    );
    expect(res.ok).toBe(true);
    const hyps = res.outputs['HYPOTHESIZE-1'] as Hypothesis[];
    expect(hyps[0]!.text).toContain('路径绑定');
  });
});

// ---- ④ EXECUTE 经 Handle ----

describe('④ EXECUTE 经 CapabilityHandle（能力 ABI 依赖边界）', () => {
  it('EXECUTE 调 handle.execute，结果进 OBSERVE', async () => {
    const calls: unknown[] = [];
    const { provider, sawCtx } = echoProvider(calls);
    const res = await executeGraph(
      graph(
        [
          op('DISCRIMINATE', {
            input_binding: {
              h: { const: [{ id: 'hyp-1', text: '假设', status: 'candidate', source: 'test' }] },
              s: { const: { capability_ids: ['cap:echo'] } },
              gaps: { const: [] },
            },
          }),
          op('EXECUTE', { input_binding: { plan: { ref: 'DISCRIMINATE' } }, side_effect: 'mutate' }),
          op('OBSERVE', { input_binding: { results: { ref: 'EXECUTE' }, plan: { ref: 'DISCRIMINATE' } } }),
        ],
        [
          { from: 'DISCRIMINATE', to: 'EXECUTE' },
          { from: 'EXECUTE', to: 'OBSERVE' },
        ],
        'DISCRIMINATE',
        'OBSERVE',
      ),
      { inputs: {}, budget: 100, capabilities: { 'cap:echo': provider } },
    );

    expect(res.ok).toBe(true);
    // createHandle 上下文 + execute 实参（DISCRIMINATE 计划的 args）
    expect(sawCtx).toHaveLength(1);
    expect(sawCtx[0]?.scope).toBe('session');
    expect(calls).toEqual([{ hypothesis_id: 'hyp-1', text: '假设' }]);
    // EXECUTE 输出 ToolResult[]
    const tools = res.outputs['EXECUTE'] as ToolResult[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.ok).toBe(true);
    expect(tools[0]!.tool).toBe('cap:echo');
    expect(tools[0]!.output).toEqual({ echo: { hypothesis_id: 'hyp-1', text: '假设' } });
    expect(tools[0]!.observation_ref).toMatch(/^observation:/);
    // OBSERVE 把 ToolResult 转 Observation（绑定 evidence）
    const obs = res.outputs['OBSERVE'] as Observation[];
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source).toBe('cap:echo');
    expect(obs[0]!.evidence).toEqual({ echo: { hypothesis_id: 'hyp-1', text: '假设' } });
    expect(obs[0]!.observation_ref).toMatch(/^observation:/);
  });

  it('无匹配 handle → 错误契约：整图失败（E_NO_CAPABILITY）', async () => {
    const res = await executeGraph(
      graph(
        [
          op('DISCRIMINATE', {
            input_binding: {
              h: { const: [{ id: 'hyp-1', text: '假设', status: 'candidate', source: 'test' }] },
              s: { const: { capability_ids: ['cap:missing'] } },
              gaps: { const: [] },
            },
          }),
          op('EXECUTE', { input_binding: { plan: { ref: 'DISCRIMINATE' } } }),
        ],
        [{ from: 'DISCRIMINATE', to: 'EXECUTE' }],
        'DISCRIMINATE',
        'EXECUTE',
      ),
      { inputs: {}, budget: 100, capabilities: {} },
    );
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('E_NO_CAPABILITY');
    expect(res.error?.operator_id).toBe('EXECUTE');
  });
});

// ---- ⑤ 错误契约-重试 ----

describe('⑤ 错误契约-重试（retryable → 重试 ≤ 2 次，指数退避）', () => {
  it('retryable 算子前两次抛错 → 第三次成功，总尝试 = 3', async () => {
    let attempts = 0;
    const flaky: OperatorFn = {
      async run() {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient');
        }
        return 'ok';
      },
    };
    const res = await executeGraph(
      graph([op('flaky', { error: { retryable: true, timeout_ms: 0, cancelable: false, rollback: '' } })], [], 'flaky', 'flaky'),
      { inputs: {}, budget: 100, registry: { flaky } },
    );
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(res.outputs['flaky']).toBe('ok');
  });

  it('retryable 算子始终失败 → 3 次尝试后整图失败（含重试事件）', async () => {
    let attempts = 0;
    const alwaysFail: OperatorFn = {
      async run() {
        attempts++;
        throw new Error('boom');
      },
    };
    const events: OperatorEvent[] = [];
    const res = await executeGraph(
      graph([op('af', { error: { retryable: true, timeout_ms: 0, cancelable: false, rollback: '' } })], [], 'af', 'af'),
      { inputs: {}, budget: 100, registry: { af: alwaysFail }, eventSink: (e) => events.push(e) },
    );
    expect(res.failed).toBe(true);
    expect(res.error?.operator_id).toBe('af');
    expect(res.error?.message).toContain('boom');
    expect(attempts).toBe(3);
    expect(res.completed).toEqual([]);
    // 事件：start/failed/retry × 2 轮 + 末轮 start/failed
    const retries = events.filter((e) => e.type === 'process/operator/retry');
    expect(retries).toHaveLength(2);
    expect(events.filter((e) => e.type === 'process/operator/start')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'process/operator/failed')).toHaveLength(3);
  });

  it('未知算子（registry 无匹配且非内置）→ 整图失败 E_UNKNOWN_OPERATOR', async () => {
    const res = await executeGraph(graph([op('NOPE')], [], 'NOPE', 'NOPE'), { inputs: {}, budget: 100 });
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('E_UNKNOWN_OPERATOR');
  });
});

// ---- ⑥ 错误契约-非重试 + rollback ----

describe('⑥ 错误契约-非重试（直接失败 + rollback 补偿钩子）', () => {
  it('非 retryable 算子抛错 → 单次尝试即失败，rollback 钩子被调，整图 failed', async () => {
    let attempts = 0;
    let rollbackCalls = 0;
    const fatal: OperatorFn = {
      async run() {
        attempts++;
        throw new Error('fatal');
      },
    };
    const res = await executeGraph(
      graph([op('fatal', { error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'rb-fatal' } })], [], 'fatal', 'fatal'),
      { inputs: {}, budget: 100, registry: { fatal }, rollbacks: { 'rb-fatal': async () => { rollbackCalls++; } } },
    );
    expect(res.failed).toBe(true);
    expect(attempts).toBe(1); // 不重试
    expect(rollbackCalls).toBe(1); // 补偿钩子调用
    expect(res.rollbacks_called).toEqual(['rb-fatal']);
    expect(res.negative_pattern?.code).toBe('E_OPERATOR'); // Negative Pattern 占位记录
  });
});

// ---- ⑦ 超时 ----

describe('⑦ 超时（timeout_ms → AbortSignal.timeout 中止，不挂起）', () => {
  it('算子超过 timeout_ms → 超时中止，整图 failed，用时受控', async () => {
    const slow: OperatorFn = {
      async run() {
        await delay(500);
        return 'late';
      },
    };
    const t0 = Date.now();
    const res = await executeGraph(
      graph([op('slow', { error: { retryable: false, timeout_ms: 30, cancelable: false, rollback: '' } })], [], 'slow', 'slow'),
      { inputs: {}, budget: 100, registry: { slow } },
    );
    const elapsed = Date.now() - t0;
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(res.error?.operator_id).toBe('slow');
    expect(elapsed).toBeLessThan(400); // 未被 500ms 睡眠挂起
  });
});

// ---- ⑧ 预算 ----

describe('⑧ 预算（cost 总和超 budget → 执行前拒绝）', () => {
  it('cost 总和(120) > budget(100) → 执行前拒绝 BUDGET_EXCEEDED，无算子运行', async () => {
    const g = graph(
      [
        op('a', { cost: { cost: 60 } }),
        op('b', { cost: { cost: 60 } }),
      ],
      [{ from: 'a', to: 'b' }],
      'a',
      'b',
    );
    const res = await executeGraph(g, { inputs: {}, budget: 100 });
    expect(res.failed).toBe(true);
    expect(res.code).toBe('BUDGET_EXCEEDED');
    expect(res.completed).toEqual([]);
    expect(res.events).toEqual([]);
  });

  it('cost 总和 ≤ budget → 正常执行', async () => {
    const res = await executeGraph(
      graph(
        [op('RETRIEVE', { cost: { cost: 60 }, input_binding: { q: { const: 'x' }, scope: { const: 'Project' } } })],
        [],
        'RETRIEVE',
        'RETRIEVE',
      ),
      { inputs: {}, budget: 60, retrieveFn: fakeRetrieve([{ id: 'm', payload: 'p' }]) },
    );
    expect(res.ok).toBe(true);
  });
});

// ---- ⑨ 每算子 Event ----

describe('⑨ 每算子 Event（eventSink 钩子：operator/start、operator/end）', () => {
  it('eventSink 收到每算子 start/end 事件，且与 result.events 一致', async () => {
    const sink: OperatorEvent[] = [];
    const res = await executeGraph(
      graph(
        [
          op('RETRIEVE', { input_binding: { q: { const: 'x' }, scope: { const: 'Project' } } }),
          op('STOP', { input_binding: { state: { ref: 'RETRIEVE' }, reason: { const: 'done' } } }),
        ],
        [{ from: 'RETRIEVE', to: 'STOP' }],
        'RETRIEVE',
        'STOP',
      ),
      { inputs: {}, budget: 100, retrieveFn: fakeRetrieve([{ id: 'm', payload: 'p' }]), eventSink: (e) => sink.push(e) },
    );
    expect(res.ok).toBe(true);
    expect(sink).toHaveLength(4); // RETRIEVE start/end + STOP start/end
    expect(sink.map((e) => e.type)).toEqual([
      'process/operator/start',
      'process/operator/end',
      'process/operator/start',
      'process/operator/end',
    ]);
    expect(sink[0]!.operator_id).toBe('RETRIEVE');
    expect(sink[1]!.operator_id).toBe('RETRIEVE');
    expect(sink[2]!.operator_id).toBe('STOP');
    expect(sink[3]!.operator_id).toBe('STOP');
    expect(res.events.map((e) => e.type)).toEqual(sink.map((e) => e.type));
  });
});

// ---- ⑩ Micro Certificate ----

describe('⑩ Micro Certificate（buildMicroCertificate 结构完整，§5.3）', () => {
  const g = graph(
    [
      op('r1', { input_binding: { q: { const: 'x' }, scope: { const: 'Project' } } }),
      op('s1', { input_binding: { state: { ref: 'r1' }, reason: { const: 'done' } } }),
    ],
    [{ from: 'r1', to: 's1' }],
    'r1',
    's1',
  );

  it('结构完整：input_state_hash/operator_graph_hash/expected/actual/verifier/state_delta/environment', () => {
    const cert = buildMicroCertificate(g, { inputs: { task: 't1' } }, { state_delta: { facts: 2 } });
    expect(cert.input_state_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cert.operator_graph_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cert.input_state_hash).not.toBe(cert.operator_graph_hash);
    expect(cert.expected.effect).toContain('r1');
    expect(cert.actual.effect).toBe('completed');
    expect(cert.verifier).toBe('runtime/operator');
    expect(cert.state_delta).toEqual({ facts: 2 });
    expect(cert.environment.node).toBe(process.version);
    expect(cert.environment.os).toBe(process.platform);
  });

  it('确定性：同输入同图 → 同 hash；输入变化 → input_state_hash 变化', () => {
    const a = buildMicroCertificate(g, { inputs: { task: 't1' } });
    const b = buildMicroCertificate(g, { inputs: { task: 't1' } });
    const c = buildMicroCertificate(g, { inputs: { task: 't2' } });
    expect(a.input_state_hash).toBe(b.input_state_hash);
    expect(a.operator_graph_hash).toBe(b.operator_graph_hash);
    expect(c.input_state_hash).not.toBe(a.input_state_hash);
    expect(c.operator_graph_hash).toBe(a.operator_graph_hash); // 图未变
  });
});

// ---- ⑪ 验证谓词 ----

describe('⑪ 验证谓词（verification 字段：存在即执行谓词；无谓词 → warning）', () => {
  it('谓词通过 → 算子成功', async () => {
    const res = await executeGraph(
      graph([op('v1', { verification: 'pred-ok' })], [], 'v1', 'v1'),
      { inputs: {}, budget: 100, registry: { v1: { run: async () => 'x' } }, verifiers: { 'pred-ok': (o) => o === 'x' } },
    );
    expect(res.ok).toBe(true);
  });

  it('谓词拒绝 → 整图失败 VERIFICATION_FAILED', async () => {
    const res = await executeGraph(
      graph([op('v2', { verification: 'pred-bad' })], [], 'v2', 'v2'),
      { inputs: {}, budget: 100, registry: { v2: { run: async () => 'x' } }, verifiers: { 'pred-bad': () => false } },
    );
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('VERIFICATION_FAILED');
  });

  it('无谓词 → logger 记录 warning，图仍成功', async () => {
    const warns: string[] = [];
    const res = await executeGraph(
      graph([op('v3', { verification: 'pred-missing' })], [], 'v3', 'v3'),
      { inputs: {}, budget: 100, registry: { v3: { run: async () => 'x' } }, logger: (m) => warns.push(m) },
    );
    expect(res.ok).toBe(true);
    expect(warns.some((w) => w.includes('pred-missing'))).toBe(true);
  });
});

// ---- ⑫ 取消/超时终态语义（T4.1 评审 Important：取消是终态，不进入重试路径） ----

describe('⑫ 取消/超时终态语义（CANCELLED 终态不重试；TIMEOUT 按 spec.error.retryable 取舍）', () => {
  it('cancelable 算子运行中被图级信号中止 → 单次尝试立即失败：start 仅 1 次、无 retry、无退避、错误码 CANCELLED', async () => {
    let runCalls = 0;
    let enteredRun: (() => void) | undefined;
    const entered = new Promise<void>((r) => {
      enteredRun = r;
    });
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const cancelable: OperatorFn = {
      async run() {
        runCalls++;
        enteredRun?.();
        await gate; // 挂起：中止由 abort 事件驱动（算子自身不感知取消）
        return 'never';
      },
    };
    const controller = new AbortController();
    const events: OperatorEvent[] = [];
    const pending = executeGraph(
      graph([op('c1', { error: { retryable: true, timeout_ms: 0, cancelable: true, rollback: '' } })], [], 'c1', 'c1'),
      { inputs: {}, budget: 100, registry: { c1: cancelable }, signal: controller.signal, eventSink: (e) => events.push(e) },
    );
    await entered; // 等算子进入 run（start 事件已发出）后再中止 → 命中运行中取消路径
    controller.abort();
    releaseGate?.(); // 释放挂起（外层已因 abort 拒绝，此处仅清理悬空 promise）
    const res = await pending;
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('CANCELLED'); // 结果码明确
    expect(res.error?.operator_id).toBe('c1');
    expect(runCalls).toBe(1); // 不重试：算子仅被调用 1 次
    // 事件序列即证据：start 仅 1 次、无 retry 事件（退避只在 retry 前发生）→ 取消未走重试路径
    expect(events.map((e) => e.type)).toEqual(['process/operator/start', 'process/operator/failed']);
    expect(events.filter((e) => e.type === 'process/operator/retry')).toHaveLength(0);
  });

  it('执行前图级信号已中止 → 直接 CANCELLED，无算子运行', async () => {
    let runCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const res = await executeGraph(
      graph([op('c0', { error: { retryable: true, timeout_ms: 0, cancelable: true, rollback: '' } })], [], 'c0', 'c0'),
      {
        inputs: {},
        budget: 100,
        registry: {
          c0: {
            run: async () => {
              runCalls++;
              return 'x';
            },
          },
        },
        signal: controller.signal,
      },
    );
    expect(res.failed).toBe(true);
    expect(res.code).toBe('CANCELLED');
    expect(runCalls).toBe(0);
    expect(res.events).toEqual([]);
  });

  it('TIMEOUT 取舍：spec.error.retryable=true 时超时重试（≤2 次），错误码仍为 TIMEOUT', async () => {
    const slow: OperatorFn = {
      async run() {
        await delay(500);
        return 'late';
      },
    };
    const events: OperatorEvent[] = [];
    const res = await executeGraph(
      graph([op('slow2', { error: { retryable: true, timeout_ms: 30, cancelable: false, rollback: '' } })], [], 'slow2', 'slow2'),
      { inputs: {}, budget: 100, registry: { slow2: slow }, eventSink: (e) => events.push(e) },
    );
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(res.error?.operator_id).toBe('slow2');
    expect(events.filter((e) => e.type === 'process/operator/start')).toHaveLength(3); // 重试 ≤ 2 次
    expect(events.filter((e) => e.type === 'process/operator/retry')).toHaveLength(2);
  });
});
