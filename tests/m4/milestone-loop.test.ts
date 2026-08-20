// M4 出口整体连通测试：过程生成闭环（未知任务 → ProcessGenerator → ProcessDef → OperatorGraph 适配器 → executeGraph）。
// 用户强化指示（CONVENTIONS §5.1）：每里程碑出口必须有整体连通测试——把 M4 全产物
// （T4.1 Operator ABI/执行器、T4.2 ProcessGenerator 阶梯、T4.3 Action 执行语义经 EXECUTE 能力边界）
// 串成端到端闭环；真实模块 + 真实 processes 库（kernel/processes/*.yaml），禁 mock；
// 仅依赖注入 fake：RETRIEVE 的 retrieveFn（M4 最小，生产 boot 装配 M3 backend）、
// EXECUTE 的 fake CapabilityProvider（能力 ABI 边界）、VERIFY 预留算子（M5 实现，ctx.registry 注入）。
// 覆盖：① 未知任务（OOD）→ 真实库 generate → method none（受控失败，reason 明确，不挂起）
//       ② 生成产物可执行（核心断言：generate 产物 → toOperatorGraph → executeGraph 图成功执行）
//       ③ 已知过程 Reuse → 执行成功（hypothesize-test 全内置链；T2.1 retrieve-verify：检索 fake → 验证 → STOP）
//       ④ 预算端到端：执行受 budget（BUDGET_EXCEEDED 执行前拒绝，墙钟有界）
//       ⑤ 超时不挂起：慢算子 + timeout_ms → TIMEOUT（墙钟有界）
//       ⑥ 确定性：同输入两次全链（generate → adapter → execute）深相等（事件去 ts）
// 接缝（主会话裁决）：OperatorGraph.edges 在 ProcessDef 无对应（由 input_binding 引用派生）；
// schema→ABI 需收窄转换（id 规范化/绑定转换/缺省字段）；ProcessDef '$.x' 图输入引用经 ctx.inputs 解析。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadProcesses, type ProcessDef } from '../../kernel/policy-loader.js';
import { ProcessGenerator, type WorkingState } from '../../runtime/generator.js';
import { toOperatorGraph } from '../../runtime/process-adapter.js';
import { executeGraph, type OperatorEvent, type OperatorFn } from '../../runtime/operator.js';
import type { CapabilityContract, CapabilityProvider } from '../../kernel/capability-abi.js';

// ---- 常量 ----

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** OOD 任务 goal（关键词不与真实过程文本重合 → 无匹配） */
const OOD_GOAL = '量子引力 全息对偶';
const GENERATOR_BUDGET = 20000;
const DEFAULT_CAP = 'capability:default';

// ---- 测试工具 ----

type BuiltinOp = 'RETRIEVE' | 'HYPOTHESIZE' | 'DISCRIMINATE' | 'EXECUTE' | 'OBSERVE' | 'UPDATE' | 'STOP' | 'VERIFY';

interface OpFixture {
  id: string;
  op: BuiltinOp;
  output: string;
  input_binding?: Record<string, unknown>;
  cost?: { tokens?: number; time_ms?: number };
  verification?: string;
  error?: { retryable: boolean; timeout_ms: number; cancelable: boolean; rollback: string };
}

/** ProcessDef 工厂（生成产物构造；error 缺省：非重试/无超时/不可取消） */
function mkProcessDef(id: string, entry: BuiltinOp, exit: BuiltinOp, ops: OpFixture[]): ProcessDef {
  return {
    id,
    version: '1.0.0',
    entry,
    exit,
    budget: { tokens: 100000, time_ms: 100000 },
    operators: ops.map((o) => ({
      id: o.id,
      op: o.op,
      input_binding: o.input_binding ?? {},
      output: o.output,
      cost: o.cost ?? { tokens: 100 },
      verification: o.verification ?? '默认校验',
      error: o.error ?? { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' },
    })),
  };
}

/** 生成产物（canonical 链：含 EXECUTE；'$.x' 引用 + 裸常量，仿真 YAML 形状） */
const GEN_PRODUCT = mkProcessDef('generated-canonical', 'RETRIEVE', 'STOP', [
  { id: 'retrieve', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal', scope: 'Project', kind: 'Semantic' }, cost: { tokens: 2000, time_ms: 100 }, verification: '记忆检索命中' },
  { id: 'hypothesize', op: 'HYPOTHESIZE', output: 'hypotheses', input_binding: { state: '$.memory_pack', n: 2 }, cost: { tokens: 1000, time_ms: 100 }, verification: '假设派生' },
  { id: 'discriminate', op: 'DISCRIMINATE', output: 'experiment_plan', input_binding: { h: '$.hypotheses', s: '$.working', gaps: '$.working.evidence_gaps' }, cost: { tokens: 1000, time_ms: 100 }, verification: '判别实验' },
  { id: 'execute', op: 'EXECUTE', output: 'tool_results', input_binding: { plan: '$.experiment_plan' }, cost: { tokens: 2000, time_ms: 100 }, verification: '能力执行' },
  { id: 'observe', op: 'OBSERVE', output: 'observations', input_binding: { results: '$.tool_results', plan: '$.experiment_plan' }, cost: { tokens: 500, time_ms: 100 }, verification: '观测转换' },
  { id: 'update', op: 'UPDATE', output: 'state_patch', input_binding: { state: '$.working', obs: '$.observations' }, cost: { tokens: 500, time_ms: 100 }, verification: '状态更新' },
  { id: 'stop', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working', reason: '$.state_patch' }, cost: { tokens: 100, time_ms: 50 }, verification: '停止报告', error: { retryable: false, timeout_ms: 50, cancelable: false, rollback: '无' } },
]);

/** fake retrieveFn（M4 注入；生产由 boot 装配 M3 backend） */
function fakeRetrieve(items: unknown[]) {
  return async () => ({ items, channel_used: 'lexical' as const });
}

/** fake CapabilityProvider（EXECUTE 经 Handle 调用路径；记录调用实参） */
function fakeCapability(calls: unknown[]): CapabilityProvider {
  const manifest: CapabilityContract = {
    id: DEFAULT_CAP,
    name: 'fake',
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
  return {
    manifest,
    async createHandle() {
      return {
        contract: manifest,
        async execute(input: unknown) {
          calls.push(input);
          return { ok: true, output: { echo: input }, observation_ref: 'observation:loop', metrics: { tokens: 1, latency_ms: 1 } };
        },
      };
    },
  };
}

/** VERIFY 预留算子（M5 实现；M4 经 ctx.registry 注入测试替身：pack → verdict） */
const FAKE_VERIFY: OperatorFn = {
  async run(ctx) {
    const pack = ctx.inputs['pack'] as { items?: unknown[] } | undefined;
    const items = Array.isArray(pack?.items) ? pack.items : [];
    return { verdict: items.length > 0 ? 'confirmed' : 'refuted', evidence_count: items.length };
  },
};

/** 执行依赖（图输入 + 依赖注入）；overrides 覆盖单字段 */
function execCtx(over: {
  inputs?: Record<string, unknown>;
  budget?: number;
  registry?: Record<string, OperatorFn>;
  capabilities?: Record<string, CapabilityProvider>;
  retrieveFn?: (q: { q: string; scope: string; kind?: string; budget?: number; limit?: number }) => Promise<{ items: unknown[]; channel_used?: string }>;
  logger?: (m: string) => void;
  eventSink?: (e: OperatorEvent) => void;
} = {}) {
  return {
    inputs: { goal: OOD_GOAL, working: { confirmed_facts: ['事实A', '事实B'], evidence_gaps: ['gap-1'], capability_ids: [DEFAULT_CAP] } },
    budget: GENERATOR_BUDGET,
    retrieveFn: fakeRetrieve([{ id: 'mem-1', payload: '记忆1' }]),
    capabilities: { [DEFAULT_CAP]: fakeCapability([]) },
    ...over,
  };
}

// ---- 共享 fixture（beforeAll：真实 processes 库） ----

let processes: readonly ProcessDef[];

beforeAll(async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../kernel/processes');
  processes = await loadProcesses(dir);
  expect(processes.map((p) => p.id).sort()).toEqual(['hypothesize-test', 'retrieve-verify']);
});

afterAll(() => {
  // 无资源需释放（进程库为深冻结内存数据）
});

const oodTask = (state: WorkingState = {}): Parameters<ProcessGenerator['generate']>[0] => ({
  goal: OOD_GOAL,
  state,
  applicability: 'OOD',
});

// ---- ① 未知任务 → 真实库 generate → none（受控失败） ----

describe('① 未知任务（OOD）→ 真实 processes 库 generate → method none（受控失败，reason 明确，不挂起）', () => {
  it('真实库无匹配/无组合对/无可变异位且无 LLM → none + reason 明确（非挂起：墙钟有界）', async () => {
    const gen = new ProcessGenerator({ processes, budget: GENERATOR_BUDGET });
    const t0 = Date.now();
    const res = await gen.generate(oodTask());
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // 不挂起
    expect(res.method).toBe('none');
    expect(res.process).toBeNull();
    expect(res.reason.length).toBeGreaterThan(0);
    expect(res.reason).toMatch(/none|validation|budget/); // 受控失败：明确原因而非挂起
    expect(res.reason).toContain('LLM'); // 无 LLM 生成器分支（M4 记录）
  });
});

// ---- ② 生成产物可执行（核心断言） ----

describe('② 生成产物可执行（核心断言：generate 产物 → toOperatorGraph → executeGraph 成功）', () => {
  it('未知任务 + 注入 llmGenerate → method generate → 适配 → 内置算子 + fake CapabilityHandle 执行成功（事件序列完整、STOP 末位、无挂起）', async () => {
    const calls: unknown[] = [];
    const warnings: string[] = [];
    const sink: OperatorEvent[] = [];
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes,
      budget: GENERATOR_BUDGET,
      llmGenerate: async () => {
        llmCalls++;
        return GEN_PRODUCT;
      },
    });
    const genRes = await gen.generate(oodTask());
    expect(genRes.method).toBe('generate');
    expect(genRes.process).not.toBeNull();
    expect(llmCalls).toBe(1);

    // 接缝：ProcessDef → OperatorGraph
    const graph = toOperatorGraph(genRes.process!);
    expect(graph.operators).toHaveLength(7);
    expect(graph.edges.length).toBeGreaterThan(0);

    // 执行：内置算子 + fake CapabilityHandle（EXECUTE）+ fake retrieveFn
    const t0 = Date.now();
    const res = await executeGraph(graph, execCtx({ capabilities: { [DEFAULT_CAP]: fakeCapability(calls) }, logger: (m) => warnings.push(m), eventSink: (e) => sink.push(e) }));
    const elapsed = Date.now() - t0;

    // 图成功执行
    expect(res.ok).toBe(true);
    expect(res.failed).toBe(false);
    expect(res.completed[0]).toBe('RETRIEVE');
    expect(res.completed[res.completed.length - 1]).toBe('STOP');
    expect(res.completed).toHaveLength(7); // 全部算子完成
    // EXECUTE 经 fake CapabilityHandle 执行（n=2 假设 → 2 个判别实验 → 2 次 handle.execute）
    expect(calls).toHaveLength(2);
    // 结果事件序列完整：每算子 start/end 成对，STOP end 为末事件
    expect(sink.length).toBe(res.completed.length * 2);
    const starts = sink.filter((e) => e.type === 'process/operator/start').map((e) => e.operator_id);
    const ends = sink.filter((e) => e.type === 'process/operator/end').map((e) => e.operator_id);
    expect(starts).toEqual(res.completed);
    expect(ends).toEqual(res.completed);
    // UPDATE 端到端生效：观测（obs 键契约）应用 → state_patch 增补 evidence:capability:default
    const patch = res.outputs['UPDATE'] as { confirmed_facts: string[]; evidence_gaps: string[] };
    expect(patch.confirmed_facts).toContain('evidence:capability:default');
    // STOP 输出（末算子完成；stop.state 绑定图输入 working → 摘要为其快照；
    // reason 键契约：绑定 state_patch → 真实数据流入报告，不再走 'completed' 兜底）
    const stop = res.outputs['STOP'] as {
      reason: { confirmed_facts: string[]; evidence_gaps: string[] };
      summary: { confirmed_facts: number; gaps: number };
    };
    expect(stop.reason).toEqual(patch);
    expect(stop.summary).toEqual({ confirmed_facts: 2, gaps: 1 });
    // 无挂起：墙钟有界（成功路径无定时器）
    expect(elapsed).toBeLessThan(2000);
    // M4 最小验证契约：verification 谓词未注册 → warning 不阻断
    expect(warnings.some((w) => w.includes('验证谓词未注册'))).toBe(true);
  });
});

// ---- ③ 已知过程 Reuse → 执行成功 ----

describe('③ 已知过程 Reuse → 执行成功（端到端）', () => {
  it('hypothesize-test（全内置链，EXECUTE 经 fake CapabilityHandle）→ 图成功执行', async () => {
    const calls: unknown[] = [];
    const gen = new ProcessGenerator({ processes, budget: GENERATOR_BUDGET });
    const res = await gen.generate({ goal: '假设 观测', state: {}, applicability: 'OOD' });
    expect(res.method).toBe('reuse');
    expect(res.process?.id).toBe('hypothesize-test');

    const graph = toOperatorGraph(res.process!);
    const exec = await executeGraph(
      graph,
      execCtx({
        inputs: { working: { confirmed_facts: ['事实A'], evidence_gaps: [] } },
        capabilities: { [DEFAULT_CAP]: fakeCapability(calls) },
      }),
    );
    expect(exec.ok).toBe(true);
    expect(exec.completed[0]).toBe('HYPOTHESIZE');
    expect(exec.completed[exec.completed.length - 1]).toBe('STOP');
    // 全链 6 算子（含 EXECUTE）全部完成：接缝跑通完整链
    expect(exec.completed).toHaveLength(6);
    expect(exec.completed).toContain('EXECUTE');
    // 键名契约统一（YAML input_binding → 内置算子输入契约键 q/h/obs）：
    // DISCRIMINATE 收到真实假设（h 键）→ 判别实验非空 → EXECUTE 经 fake CapabilityHandle 真实调用 3 次（YAML n=3）
    expect(calls).toHaveLength(3);
    // UPDATE 应用观测（obs 键契约）：observations 流入 → state_patch 增补 evidence:capability:default
    const patch = exec.outputs['UPDATE'] as { confirmed_facts: string[]; evidence_gaps: string[] };
    expect(patch.confirmed_facts).toContain('evidence:capability:default');
    const stop = exec.outputs['STOP'] as {
      reason: { confirmed_facts: string[]; evidence_gaps: string[] };
      summary: { confirmed_facts: number; gaps: number };
    };
    // STOP reason 键契约：绑定 state_patch → 报告携带真实更新结果（非兜底 'completed'）
    expect(stop.reason).toEqual(patch);
    expect(stop.summary).toEqual({ confirmed_facts: 1, gaps: 0 });
  });

  it('T2.1 retrieve-verify（检索 fake → VERIFY（预留算子 registry 注入）→ STOP）→ 图成功执行', async () => {
    const gen = new ProcessGenerator({ processes, budget: GENERATOR_BUDGET });
    const res = await gen.generate({ goal: '命中查询', state: {}, applicability: 'OOD' });
    expect(res.method).toBe('reuse');
    expect(res.process?.id).toBe('retrieve-verify');

    const graph = toOperatorGraph(res.process!);
    const exec = await executeGraph(
      graph,
      execCtx({
        inputs: { goal: '命中查询', working: { confirmed_facts: ['事实X'], evidence_gaps: [] } },
        registry: { VERIFY: FAKE_VERIFY }, // VERIFY 预留算子 M5 实现；M4 测试替身
        retrieveFn: fakeRetrieve([{ id: 'm1', payload: '记忆1' }]),
      }),
    );
    expect(exec.ok).toBe(true);
    expect(exec.completed).toEqual(['RETRIEVE', 'VERIFY', 'STOP']);
    // 检索 fake → 验证 → STOP：verdict 判定 confirmed（items 非空）；
    // STOP reason 键契约：绑定 verdict 输出 → 报告携带真实判定（非兜底 'completed'）
    const verdict = exec.outputs['VERIFY'] as { verdict: string; evidence_count: number };
    expect(verdict.verdict).toBe('confirmed');
    expect(verdict.evidence_count).toBe(1);
    const stop = exec.outputs['STOP'] as { reason: { verdict: string; evidence_count: number }; summary: { confirmed_facts: number; gaps: number } };
    expect(stop.reason).toEqual(verdict);
    expect(stop.summary).toEqual({ confirmed_facts: 1, gaps: 0 });
  });
});

// ---- ④ 预算端到端 ----

describe('④ 预算端到端：执行受 budget（BUDGET_EXCEEDED 执行前拒绝，墙钟有界，无算子运行）', () => {
  it('生成图 cost 总和 > budget → 立即拒绝，不挂起、无事件', async () => {
    const graph = toOperatorGraph(GEN_PRODUCT);
    const t0 = Date.now();
    const res = await executeGraph(graph, execCtx({ budget: 1 }));
    const elapsed = Date.now() - t0;
    expect(res.failed).toBe(true);
    expect(res.code).toBe('BUDGET_EXCEEDED');
    expect(res.completed).toEqual([]);
    expect(res.events).toEqual([]); // 无算子运行
    expect(elapsed).toBeLessThan(500); // 墙钟有界
  });
});

// ---- ⑤ 超时不挂起 ----

describe('⑤ 超时不挂起：慢算子 + timeout_ms → TIMEOUT（墙钟有界）', () => {
  it('registry 注入慢 STOP（500ms 睡眠）且 spec timeout_ms=50 → TIMEOUT 受控失败，未被挂起', async () => {
    const graph = toOperatorGraph(GEN_PRODUCT);
    const slowStop: OperatorFn = {
      async run() {
        await delay(500); // 慢算子：无超时保护会挂起 500ms+
        return 'late';
      },
    };
    const t0 = Date.now();
    const res = await executeGraph(graph, execCtx({ registry: { STOP: slowStop } }));
    const elapsed = Date.now() - t0;
    expect(res.failed).toBe(true);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(res.error?.operator_id).toBe('STOP');
    expect(res.completed.length).toBeLessThan(7); // 未全部完成
    expect(elapsed).toBeLessThan(300); // 未被 500ms 睡眠挂起
  });
});

// ---- ⑥ 确定性 ----

describe('⑥ 确定性：同输入两次全链（generate → adapter → execute）深相等（事件去 ts）', () => {
  it('reuse 已知过程两次 → GenerateResult / OperatorGraph / 执行结果全部深相等', async () => {
    const run = async () => {
      const gen = new ProcessGenerator({ processes, budget: GENERATOR_BUDGET });
      const genRes = await gen.generate({ goal: '假设 观测', state: {}, applicability: 'OOD' });
      const graph = toOperatorGraph(genRes.process!);
      const exec = await executeGraph(graph, execCtx({ inputs: { working: { confirmed_facts: ['事实A'], evidence_gaps: [] } } }));
      return { genRes, graph, exec };
    };
    const a = await run();
    const b = await run();
    expect(JSON.stringify(b.genRes)).toBe(JSON.stringify(a.genRes)); // generate 深相等
    expect(JSON.stringify(b.graph)).toBe(JSON.stringify(a.graph)); // 适配器深相等
    expect(b.exec.ok).toBe(a.exec.ok);
    expect(b.exec.completed).toEqual(a.exec.completed);
    expect(b.exec.outputs).toEqual(a.exec.outputs); // 执行结果深相等
    const strip = (e: OperatorEvent) => ({ ...e, ts: 0 });
    expect(b.exec.events.map(strip)).toEqual(a.exec.events.map(strip)); // 事件序相等（去 ts）
  });
});
