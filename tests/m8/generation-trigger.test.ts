// P5 行为测试：Generator LLM 路径（HYPOTHESIZE 真实模型）生产触发（架构 §4.6.2 阶梯 / §5.3 Generate /
// D7：阶梯不满足且预算允许时走 LLM，受 generation budget 约束；施工计划 2026-08-23 P5）。
// 触发条件 = ① 阶梯前三级无合适候选（OOD 语义）② generation 预算允许（budget.yaml 数据化）
//           ③ modelAdapter 存在（无 → 纯规则降级，记录）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失：generation 预算选项/守卫/schema/装配接线）。
// 覆盖：
//   ① 触发条件：阶梯前三失败（空库 OOD）+ generation 允许 + adapter 存在 → 走 LLM（fake adapter 捕获调用）
//   ② 阶梯守卫：Reuse/Compose 命中 → adapter 不被调用（LLM 是最后手段）
//   ③ 预算守卫：generation.enabled=false → 纯规则降级（adapter 不调用）；max_generate_per_request
//      超上限 → 后续 none；generation 未配置 → 无约束（既有注入兼容）
//   ④ 调用参数：modelAdapter.generate 透传 maxTokens/reasoningEffort（默认 low；策略可覆盖）
//   ⑤ scheduler 接线：generation + modelAdapter 注入 → OOD 走 LLM；无 adapter → 纯规则
//   ⑥ assembly 生产接线：createCognitiveRuntime({modelAdapter}) → createScheduler → OOD 走 LLM；
//      未注入 → 纯规则（既有行为）
//   ⑦ budget 数据化：generation 段缺省兼容（旧 budget.yaml → 默认 disabled）+ 非法拒绝（fail-loud）
//   ⑧ 公共 API：GenerationBudgetSchema 经 policy-loader re-export（同绑定防漂移）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_OPERATORS,
  loadPolicy,
  loadProcesses,
  type ProcessDef,
} from '../../kernel/policy-loader.js';
import { GenerationBudgetSchema } from '../../kernel/schemas/policy.js';
import type { ModelAdapter, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import { ProcessGenerator, type WorkingState } from '../../runtime/generator.js';
import { ProcessScheduler, type ScheduleTask } from '../../runtime/scheduler.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

const KERNEL_DIR = fileURLToPath(new URL('../../kernel', import.meta.url));
const POLICY_DIR = join(KERNEL_DIR, 'policy');
const PROCESSES_DIR = join(KERNEL_DIR, 'processes');
const OOD_GOAL = '量子引力 全息对偶';

/** P5 缺省 generation 预算（与 schema 缺省一致） */
const GEN_BUDGET = {
  enabled: true,
  max_generate_per_request: 1,
  max_generate_tokens: 4000,
  reasoning_effort: 'low',
} as const;

// ---- 测试工具 ----

/** 合法 ProcessDef JSON（RETRIEVE → STOP，成本 200；verification 可注入 goal 关键词） */
function validProcessJson(verification = '默认校验'): string {
  return JSON.stringify({
    id: 'llm-hyp',
    version: '1.0.0',
    entry: 'RETRIEVE',
    exit: 'STOP',
    budget: { tokens: 200 },
    operators: [
      {
        id: 'r',
        op: 'RETRIEVE',
        input_binding: {},
        output: 'pack',
        cost: { tokens: 100 },
        verification,
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
      {
        id: 's',
        op: 'STOP',
        input_binding: {},
        output: 'report',
        cost: { tokens: 100 },
        verification,
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
    ],
  });
}

/** 记录调用（prompt + opts）的 fake adapter（可覆盖 generate 行为） */
function fakeAdapter(over: Partial<ModelAdapter> = {}): ModelAdapter & {
  calls: Array<{ prompt: string; opts?: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; opts?: Record<string, unknown> }> = [];
  const adapter: ModelAdapter = {
    provider: 'test',
    model: 'fake',
    async generate(prompt, opts): Promise<ModelGenerateResult> {
      calls.push({ prompt, opts: opts as Record<string, unknown> | undefined });
      return { text: validProcessJson(), usage: { inputTokens: 10, outputTokens: 20 } };
    },
    ...over,
  };
  return Object.assign(adapter, { calls });
}

const oodTask = (state: WorkingState = {}): Parameters<ProcessGenerator['generate']>[0] => ({
  goal: OOD_GOAL,
  state,
  applicability: 'OOD',
});

/** mkProcess 工厂（与 m4 fixture 同构：缺省 cost 100；verification 承载关键词） */
type BuiltinOp = (typeof BUILTIN_OPERATORS)[number];
function mkProcess(
  id: string,
  entry: BuiltinOp,
  exit: BuiltinOp,
  ops: Array<{ id: string; op: BuiltinOp; output: string; verification: string }>,
): ProcessDef {
  return {
    id,
    version: '1.0.0',
    entry,
    exit,
    budget: { tokens: ops.length * 100 },
    operators: ops.map((o) => ({
      id: o.id,
      op: o.op,
      input_binding: {},
      output: o.output,
      cost: { tokens: 100 },
      verification: o.verification,
      error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' },
    })),
  };
}

const PROC_REUSE = mkProcess('reuse-me', 'RETRIEVE', 'STOP', [
  { id: 'r', op: 'RETRIEVE', output: 'memory_pack', verification: '命中查询' },
  { id: 's', op: 'STOP', output: 'stop_report', verification: '命中查询' },
]);
const PROC_A = mkProcess('retrieve-hypothesize', 'RETRIEVE', 'HYPOTHESIZE', [
  { id: 'retrieve', op: 'RETRIEVE', output: 'memory_pack', verification: '记忆检索' },
  { id: 'hypothesize', op: 'HYPOTHESIZE', output: 'hypotheses', verification: '假设派生' },
]);
const PROC_B = mkProcess('discriminate-stop', 'DISCRIMINATE', 'STOP', [
  { id: 'discriminate', op: 'DISCRIMINATE', output: 'experiment_plan', verification: '判别实验' },
  { id: 'stop', op: 'STOP', output: 'stop_report', verification: '停止报告' },
]);

// ---- 主测试 ----

describe('① 触发条件（阶梯前三失败 + 预算允许 + adapter 存在 → LLM）', () => {
  it('空库 OOD + generation 允许 + adapter → method=generate；adapter 捕获调用 1 次', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 1000, generation: GEN_BUDGET, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(res.process?.id).toBe('llm-hyp');
    expect(adapter.calls).toHaveLength(1);
  });
});

describe('② 阶梯守卫（前三级命中 → adapter 不调用；LLM 是最后手段）', () => {
  it('Reuse 命中 → method=reuse，adapter 未被调用', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [PROC_REUSE],
      budget: 1000,
      generation: GEN_BUDGET,
      modelAdapter: adapter,
      retrieveProcess: () => [PROC_REUSE],
    });
    const res = await gen.generate({ goal: '命中查询', state: {}, applicability: 'OOD' });
    expect(res.method).toBe('reuse');
    expect(adapter.calls).toHaveLength(0);
  });

  it('Compose 命中 → method=compose，adapter 未被调用', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [PROC_A, PROC_B],
      budget: 20000,
      generation: GEN_BUDGET,
      modelAdapter: adapter,
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('compose');
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('③ 预算守卫（generation 预算不允许 → 纯规则降级并记录）', () => {
  it('generation.enabled=false → method=none（reason 含 generation）；adapter 未被调用', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      generation: { ...GEN_BUDGET, enabled: false },
      modelAdapter: adapter,
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toMatch(/generation|未启用/);
    expect(adapter.calls).toHaveLength(0);
  });

  it('max_generate_per_request=1：第二次 generate（同实例）→ none（reason 超上限）；adapter 仅 1 次', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      generation: { ...GEN_BUDGET, max_generate_per_request: 1 },
      modelAdapter: adapter,
    });
    const first = await gen.generate(oodTask());
    expect(first.method).toBe('generate');
    const second = await gen.generate(oodTask());
    expect(second.method).toBe('none');
    expect(second.reason).toMatch(/上限|generation/);
    expect(adapter.calls).toHaveLength(1);
  });

  it('generation 未配置 → 无约束（既有 llmGenerate/modelAdapter 注入行为兼容）', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(adapter.calls).toHaveLength(1);
  });
});

describe('④ 调用参数（HYPOTHESIZE maxTokens/reasoningEffort 数据化透传）', () => {
  it('generation.max_generate_tokens=2048 + reasoning_effort=low → adapter 收到 maxTokens=2048 / reasoningEffort=low', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      generation: { ...GEN_BUDGET, max_generate_tokens: 2048 },
      modelAdapter: adapter,
    });
    await gen.generate(oodTask());
    expect(adapter.calls[0]!.opts).toMatchObject({ maxTokens: 2048, reasoningEffort: 'low' });
  });

  it('generation 未配置 → 默认 maxTokens=4000 / reasoningEffort=low（沿用 model-adapter 默认 low）', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({ processes: [], budget: 1000, modelAdapter: adapter });
    await gen.generate(oodTask());
    expect(adapter.calls[0]!.opts).toMatchObject({ maxTokens: 4000, reasoningEffort: 'low' });
  });

  it('reasoning_effort 可策略覆盖（high）→ 透传', async () => {
    const adapter = fakeAdapter();
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      generation: { ...GEN_BUDGET, reasoning_effort: 'high' },
      modelAdapter: adapter,
    });
    await gen.generate(oodTask());
    expect(adapter.calls[0]!.opts).toMatchObject({ reasoningEffort: 'high' });
  });
});

describe('⑤ scheduler 接线（generation + modelAdapter 注入缺省生成器）', () => {
  let processes: readonly ProcessDef[];

  beforeAll(async () => {
    processes = await loadProcesses(PROCESSES_DIR);
  });

  afterAll(() => {
    // 深冻结内存数据，无资源需释放
  });

  const task = (over: Partial<ScheduleTask> = {}): ScheduleTask => ({ goal: OOD_GOAL, state: {}, ...over });

  it('ProcessScheduler({ generation, modelAdapter }) + OOD → kind=generated（method=generate）', async () => {
    const adapter = fakeAdapter();
    const sched = new ProcessScheduler({ processes, generation: GEN_BUDGET, modelAdapter: adapter });
    const res = await sched.schedule(task());
    expect(res.kind).toBe('generated');
    expect(res.process?.id).toBe('llm-hyp');
    expect(res.method).toBe('generate');
    expect(adapter.calls).toHaveLength(1);
  });

  it('无 adapter → 纯规则降级：kind=none（既有行为）', async () => {
    const sched = new ProcessScheduler({ processes, generation: GEN_BUDGET });
    const res = await sched.schedule(task());
    expect(res.kind).toBe('none');
    expect(res.process).toBeNull();
  });
});

describe('⑥ assembly 生产接线（组合根注入 modelAdapter + generation 预算 → 生成器）', () => {
  const runtimes: CognitiveRuntime[] = [];
  const roots: string[] = [];

  afterAll(async () => {
    for (const rt of runtimes) {
      await rt.close();
    }
    runtimes.length = 0;
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  async function makeRuntime(modelAdapter?: ModelAdapter): Promise<CognitiveRuntime> {
    const base = await mkdtemp(join(tmpdir(), 'omb-p5-gen-'));
    roots.push(base);
    const rt = createCognitiveRuntime({ root: base, modelAdapter });
    runtimes.push(rt);
    return rt;
  }

  it('createCognitiveRuntime({ modelAdapter }) → createScheduler(processes) → OOD 走 LLM（adapter 捕获调用）', async () => {
    const adapter = fakeAdapter();
    const runtime = await makeRuntime(adapter);
    const sched = await runtime.createScheduler(await loadProcesses(PROCESSES_DIR));
    const res = await sched.schedule({ goal: OOD_GOAL, state: {} });
    expect(res.kind).toBe('generated');
    expect(res.method).toBe('generate');
    expect(adapter.calls).toHaveLength(1);
    // generation 预算来自真实 budget.yaml（生产显式启用）
    expect((await runtime.ready()).policy.budget.generation.enabled).toBe(true);
  });

  it('未注入 modelAdapter → createScheduler → OOD → none（纯规则，既有行为）', async () => {
    const runtime = await makeRuntime();
    const sched = await runtime.createScheduler(await loadProcesses(PROCESSES_DIR));
    const res = await sched.schedule({ goal: OOD_GOAL, state: {} });
    expect(res.kind).toBe('none');
    expect(res.process).toBeNull();
  });
});

describe('⑦ budget 数据化（generation 段缺省兼容 + 非法拒绝）', () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  async function policyFixture(budgetYaml: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'omb-p5-pol-'));
    roots.push(root);
    await cp(POLICY_DIR, join(root, 'policy'), { recursive: true });
    await writeFile(join(root, 'policy', 'budget.yaml'), budgetYaml, 'utf8');
    return join(root, 'policy');
  }

  it('budget.yaml 无 generation 段（旧形状）→ loadPolicy 成功；generation = 缺省（disabled/1/4000/low）', async () => {
    const dir = await policyFixture(
      [
        'depth: 8',
        'breadth: 4',
        'tools: 12',
        'retrieval: 6',
        'branches: 8',
        'context: 16000',
        'context_budget_tokens: 4000',
      ].join('\n'),
    );
    const p = await loadPolicy(dir);
    expect(p.budget.generation).toEqual({
      enabled: false,
      max_generate_per_request: 1,
      max_generate_tokens: 4000,
      reasoning_effort: 'low',
    });
  });

  it('generation 段非法（enabled 非布尔）→ loadPolicy 抛错（fail-loud，指明 generation 字段）', async () => {
    const dir = await policyFixture(
      [
        'depth: 8',
        'breadth: 4',
        'tools: 12',
        'retrieval: 6',
        'branches: 8',
        'context: 16000',
        'context_budget_tokens: 4000',
        'generation:',
        '  enabled: maybe',
        '  max_generate_per_request: 1',
        '  max_generate_tokens: 4000',
        '  reasoning_effort: low',
      ].join('\n'),
    );
    await expect(loadPolicy(dir)).rejects.toThrow(/generation/);
  });

  it('真实 budget.yaml：generation 段显式启用（enabled=true）', async () => {
    const p = await loadPolicy(POLICY_DIR);
    expect(p.budget.generation.enabled).toBe(true);
    expect(p.budget.generation.max_generate_per_request).toBeGreaterThan(0);
    expect(p.budget.generation.max_generate_tokens).toBeGreaterThan(0);
  });
});

describe('⑧ 公共 API（GenerationBudgetSchema re-export 防漂移）', () => {
  it('policy-loader 与契约层同一绑定', async () => {
    const loader = await import('../../kernel/policy-loader.js');
    expect(loader.GenerationBudgetSchema).toBeDefined();
    expect(loader.GenerationBudgetSchema).toBe(GenerationBudgetSchema);
  });
});
