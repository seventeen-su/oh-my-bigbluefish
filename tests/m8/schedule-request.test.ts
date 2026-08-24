// R3 行为测试（P0 架构闭合）：Governor→Scheduler→Process 进入请求链（prepareTurn 调度步骤）。
// 设计（§5.1/§4.6.1）：Fast Governor + Rare Generator——Governor 决策后插入调度步骤：
//   已知状态 → ProcessScheduler 选已有过程（确定性零成本）；OOD → Generator 生成 Ephemeral Process
//   （generation 预算允许，P5 语义）；调度**只做决策与投影，不驱动执行**（DSH 原生 Agent Loop 是唯一执行者——
//   不调用 operator executor、不循环调用模型；调度本身经 ModelAdapter 的 LLM 生成除外，那是 P5 预算内的生成手段）。
// 严格 TDD：本文件先于实现编写并确认失败（prepareTurn 无调度步骤 → decision.process 缺失）。
// 覆盖：
//   已知过程（Strong/Partial）→ decision.process.kind=known + projection 含「认知过程」section + working_state 过程引用
//   OOD + generation 预算允许 + adapter → Ephemeral 生成（kind=generated；adapter 捕获 1 次）
//   OOD + generation 预算拒绝（enabled=false）→ kind=none + 降级记录 + 投影无 process section（P5 语义）
//   scheduler 异常 → 降级不阻塞（prepareTurn 完成；decision.process.degraded 记录）
//   不驱动执行：已知过程调度后零模型调用 + 零执行事件（DSH Loop 是唯一执行者）
//   确定性：同 working state + 同策略 → 同调度结果（decision.process 与 projection.id 一致）
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelAdapter, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

const KERNEL_DIR = fileURLToPath(new URL('../../kernel', import.meta.url));
const POLICY_DIR = join(KERNEL_DIR, 'policy');
const SESSION = 'sess-r3-schedule';

/** 合法 ProcessDef JSON（RETRIEVE → STOP，成本 200；R3 测试的 LLM 生成产物） */
function validProcessJson(): string {
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
        verification: '检索',
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
      {
        id: 's',
        op: 'STOP',
        input_binding: {},
        output: 'report',
        cost: { tokens: 100 },
        verification: '停止',
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: 'none' },
      },
    ],
  });
}

/** 记录调用（prompt + opts）的 fake adapter（generation-trigger 同款） */
function fakeAdapter(): ModelAdapter & { calls: Array<{ prompt: string; opts?: Record<string, unknown> }> } {
  const calls: Array<{ prompt: string; opts?: Record<string, unknown> }> = [];
  const adapter: ModelAdapter = {
    provider: 'test',
    model: 'fake',
    async generate(prompt, opts): Promise<ModelGenerateResult> {
      calls.push({ prompt, opts: opts as Record<string, unknown> | undefined });
      return { text: validProcessJson(), usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
  return Object.assign(adapter, { calls });
}

/** generation 禁用的 budget.yaml（P5：enabled=false → LLM 路径整体拒绝，纯规则降级） */
function generationDisabledYaml(): string {
  return [
    'depth: 8',
    'breadth: 4',
    'tools: 12',
    'retrieval: 6',
    'branches: 8',
    'context: 16000',
    'context_budget_tokens: 500',
    'generation:',
    '  enabled: false',
    '  max_generate_per_request: 1',
    '  max_generate_tokens: 4000',
    '  reasoning_effort: low',
  ].join('\n');
}

/** 复制真实策略目录并改写 budget.yaml（generation-trigger ⑦ 同款 fixture） */
async function policyFixture(budgetYaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-r3-pol-'));
  await cp(POLICY_DIR, join(root, 'policy'), { recursive: true });
  await writeFile(join(root, 'policy', 'budget.yaml'), budgetYaml, 'utf8');
  return join(root, 'policy');
}

/** 最小请求（prepareTurn 输入；缺省 goal=retrieve verify——关键词全覆盖 → retrieve-verify Strong） */
function req(over: Record<string, unknown> = {}): Record<string, unknown> {
  const goal = 'retrieve verify';
  return {
    session_id: SESSION,
    goal,
    success_criteria: ['验证检索闭环'],
    constraints: [],
    working_state: {
      goal,
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: 'test',
    },
    ...over,
  };
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];
const roots: string[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-r3-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

describe('R3 已知过程调度（Strong/Partial → 复用，投影含认知过程 section）', () => {
  it('Strong 匹配 → decision.process.kind=known（process_id）+ projection 含「认知过程」section + working_state 过程引用', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const prepared = await runtime.prepareTurn(req() as never);

    expect(prepared.decision.process?.kind).toBe('known');
    expect(prepared.decision.process?.process_id).toBe('retrieve-verify');
    expect(prepared.decision.process?.method).toBe('reuse');
    expect(prepared.decision.process?.applicability).toBe('Strong');
    expect(prepared.decision.process?.name).toBe('retrieve-verify');
    expect(prepared.decision.process?.steps).toEqual(['RETRIEVE', 'VERIFY', 'STOP']);
    expect(prepared.decision.process?.budget_tokens).toBeGreaterThan(0);
    expect(prepared.decision.process?.degraded).toBeNull();

    const procSection = prepared.projection.sections.find((s) => s.source_ref === 'process:retrieve-verify');
    expect(procSection).toBeDefined();
    expect(procSection!.view).toBe('planning');
    expect(procSection!.content).toContain('认知过程');
    expect(procSection!.content).toContain('RETRIEVE → VERIFY → STOP');
    expect(prepared.projection.total_tokens).toBeLessThanOrEqual(500); // token 受控（投影预算内）

    // Working State 写入过程引用（next_best_action）
    expect(prepared.working_state.next_best_action).toContain('retrieve-verify');
  });

  it('Partial 匹配 → 同样选定已有过程（applicability=Partial）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const prepared = await runtime.prepareTurn(req({ goal: '命中查询 无关词' }) as never);

    expect(prepared.decision.process?.kind).toBe('known');
    expect(prepared.decision.process?.process_id).toBe('retrieve-verify');
    expect(prepared.decision.process?.applicability).toBe('Partial');
    expect(prepared.projection.sections.some((s) => s.source_ref === 'process:retrieve-verify')).toBe(true);
  });

  it('确定性：同 working state + 同策略两次 prepareTurn → 同调度结果（decision.process 与 projection.id 一致）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const a = await runtime.prepareTurn(req() as never);
    const b = await runtime.prepareTurn(req() as never);

    expect(b.decision.process).toEqual(a.decision.process);
    expect(b.projection.id).toBe(a.projection.id);
  });
});

describe('R3 OOD → Ephemeral 生成（generation 预算语义，P5）', () => {
  it('OOD + generation 预算允许 + adapter → kind=generated（method=generate；adapter 捕获 1 次；投影含 section）', async () => {
    const adapter = fakeAdapter();
    runtime = track(createCognitiveRuntime({ root, modelAdapter: adapter }));
    const prepared = await runtime.prepareTurn(req({ goal: '量子引力 全息对偶' }) as never);

    expect(prepared.decision.process?.kind).toBe('generated');
    expect(prepared.decision.process?.process_id).toBe('llm-hyp');
    expect(prepared.decision.process?.method).toBe('generate');
    expect(prepared.decision.process?.degraded).toBeNull();
    expect(adapter.calls).toHaveLength(1); // generation 预算允许 → LLM 生成 1 次（P5 触发条件①②③ 全满足）
    const procSection = prepared.projection.sections.find((s) => s.source_ref === 'process:llm-hyp');
    expect(procSection).toBeDefined();
    expect(procSection!.content).toContain('认知过程');
  });

  it('OOD + generation 预算拒绝（enabled=false）→ kind=none + 降级记录 + 投影无 process section（P5 语义）', async () => {
    const policyDir = await policyFixture(generationDisabledYaml());
    roots.push(dirname(policyDir));
    const adapter = fakeAdapter();
    runtime = track(createCognitiveRuntime({ root, policyDir, modelAdapter: adapter }));
    const prepared = await runtime.prepareTurn(req({ goal: '量子引力 全息对偶' }) as never);

    expect(prepared.decision.process?.kind).toBe('none');
    expect(prepared.decision.process?.process_id).toBeNull();
    expect(prepared.decision.process?.degraded).toMatch(/generation|未启用/);
    expect(adapter.calls).toHaveLength(0); // 预算拒绝 → LLM 不被调用
    expect(prepared.projection.sections.some((s) => s.source_ref.startsWith('process:'))).toBe(false);
    // 降级不阻塞 prepareTurn 其余流程：决策/投影照常
    expect(prepared.decision.decision).toBe('GenerateProcess');
    expect(prepared.projection.sections.some((s) => s.view === 'planning')).toBe(true);
  });
});

describe('R3 降级路径与执行边界', () => {
  it('scheduler 异常 → 降级不阻塞（decision.process.degraded 记录；投影无 process section）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    runtime.createScheduler = async () => {
      throw new Error('scheduler boom');
    };
    const prepared = await runtime.prepareTurn(req() as never);

    expect(prepared.decision.process?.kind).toBe('none');
    expect(prepared.decision.process?.degraded).toContain('scheduler boom');
    expect(prepared.decision.decision).toBe('GenerateProcess'); // Governor 决策照常
    expect(prepared.projection.sections.some((s) => s.source_ref.startsWith('process:'))).toBe(false);
  });

  it('不驱动执行：已知过程调度后零模型调用 + 零执行事件（DSH 原生 Agent Loop 是唯一执行者）', async () => {
    const adapter = fakeAdapter();
    runtime = track(createCognitiveRuntime({ root, modelAdapter: adapter }));
    const prepared = await runtime.prepareTurn(req() as never);

    // 已知过程直接复用 → 调度不触发 LLM；prepareTurn 不驱动执行 → 零事件（无注入钩子）、无执行类事件
    expect(prepared.decision.process?.kind).toBe('known');
    expect(adapter.calls).toHaveLength(0);
    expect(prepared.events_appended).toBe(0);
    expect(await runtime.eventStore.count()).toBe(0);
  });
});
