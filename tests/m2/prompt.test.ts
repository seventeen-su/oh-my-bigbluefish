// T2.4 行为测试：systemPrompt 集成与预算达标（架构 §6.2 / §14.1）。
// 原则：宪法与内部机制不进入 prompt（哲学直接作用于 IR，§14.1）；prompt = 静态区最小契约说明
//   （任务语义/必要约定/输出预期）+ 动态尾部（working_state 渲染）；Model-visible ⟺ logged
//   （session/start 事件 payload 带 prompt_tokens，不新增事件类型——brief 决策）。
// 类目：① 静态区最小性（黑名单断言 + goal/约束摘要/输出预期）
//       ② 动态尾部（working_state 8 字段全部出现、内容与输入一致不篡改）
//       ③ 预算达标（e2e 管道：固定状态 → Governor(T2.2) → Context Compiler(T2.3) → buildPrompt；
//          典型任务 total_tokens ≤ 500；scratch 默认隔离不进 prompt）
//       ④ 确定性（同输入同输出）
//       ⑤ token 估算（countTokens 单调、中文与英文均可处理）
//       ⑥ logged 钩子（注入 spy 回调验证调用参数；接线 T1.3 EventStore fixture 验证
//          session/start 事件 payload.prompt_tokens）
// fixture：真实 kernel/policy（loadPolicy，不动真实目录）+ T1.3 EventStore（mkdtemp 临时 db）。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import { EventStore } from '../../supervisor/event-store.js';
import {
  buildPrompt,
  countTokens,
  INTERNAL_MECHANISM_WORDS,
  makePromptVisibilityEvent,
  renderWorkingState,
  type PromptInput,
  type PromptTaskContract,
  type PromptVisibilityHook,
  type PromptWorkingState,
} from '../../runtime/prompt.js';
import { compile, type CandidateItem, type CompileInput } from '../../runtime/renderer.js';
import { decide, type GovernorInput } from '../../runtime/governor.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));

let policy: PolicyBundle;
beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
});

// ---- fixture 工厂 ----

/** PromptTaskContract 工厂（缺省：goal + 约束 + 成功条件） */
function tc(over: Partial<PromptTaskContract> = {}): PromptTaskContract {
  return {
    goal: '验证 OMB 最小认知解释器',
    constraints: ['验证先行'],
    success_criteria: ['决策正确', '确定性'],
    ...over,
  };
}

/** PromptWorkingState 工厂（缺省：8 字段典型值；goal 与 task_contract 一致——goal 在静态区） */
function ws(over: Partial<PromptWorkingState> = {}): PromptWorkingState {
  return {
    goal: '验证 OMB 最小认知解释器',
    confirmed_facts: ['固定状态输入'],
    active_hypotheses: ['H1: 管道确定性'],
    contradictions: [],
    open_questions: ['Q1: 投影如何进入 prompt'],
    evidence_gaps: ['缺候选选择证据'],
    next_best_action: '构造管道测试',
    environment: 'win32',
    ...over,
  };
}

/** PromptInput 工厂 */
function input(over: Partial<PromptInput> = {}): PromptInput {
  return { session_id: 'session-1', task_contract: tc(), working_state: ws(), ...over };
}

/** CandidateItem 工厂（缺省：retrieval / 高价值 / planning / 预算友好） */
function item(over: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: 'c1',
    kind: 'retrieval',
    content: '证据内容',
    tokens: 10,
    view: 'planning',
    info_value: 100,
    source_ref: 'src:c1',
    ...over,
  };
}

/** CompileInput 工厂（缺省：空候选、预算充足） */
function compileInput(over: Partial<CompileInput> = {}): CompileInput {
  return {
    task_contract: { goal: tc().goal, success_criteria: tc().success_criteria },
    candidates: [],
    budget_tokens: 4000,
    policy: policy.context,
    ...over,
  };
}

/** GovernorInput 工厂（缺省：Strong + 缺口空 + 预算足 → RunProcess；success_criteria 部分覆盖不短路 Stop） */
function govInput(): GovernorInput {
  return {
    task_contract: { goal: tc().goal, success_criteria: tc().success_criteria },
    state_snapshot: { snapshot_hash: 'sha256:test' },
    environment: 'test',
    candidate_processes: ['retrieve-verify'],
    applicability_results: [{ process_id: 'retrieve-verify', applicability: 'Strong' }],
    budget: {
      envelope: policy.budget,
      remaining: { depth: 8, breadth: 4, tools: 12, retrieval: 6, branches: 8, context: 16000 },
    },
    risk: 0.1,
    progress_vector: {
      constraint_reduction: 0.5,
      hypothesis_reduction: 0.5,
      hypothesis_discrimination: 0.5,
      evidence_strengthening: 0.5,
      goal_completion: 0.5,
      reproducibility: 0.5,
      uncertainty_reduction: 0.5,
    },
    uncertainty_vector: { goal: 0.2 },
    maintenance_state: { debt: 0 },
    evidence_sufficiency: { covered_success_conditions: ['决策正确'], critical_gaps: [], score: 1 },
  };
}

// ---- EventStore fixture 清理（Windows：先 close 再删目录，防 WAL -shm/-wal 锁 EBUSY） ----

const stores: EventStore[] = [];
const dbPaths: string[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

// ---- ① 静态区最小性 ----

describe('① 静态区最小性（最小契约说明，不注入宪法/内部机制）', () => {
  it('黑名单断言：prompt 不含 宪法/不变量/IR/schema 等内部机制词（黑名单与实现共享，防漂移）', () => {
    const p = buildPrompt(input());
    // brief 黑名单词必须在共享清单内（防实现删词逃逸）
    expect(INTERNAL_MECHANISM_WORDS).toEqual(expect.arrayContaining(['宪法', '不变量', 'IR', 'schema']));
    for (const w of INTERNAL_MECHANISM_WORDS) {
      expect(p.system).not.toContain(w);
    }
  });

  it('包含最小契约说明：任务语义（goal 一行）+ 必要约定（constraints 摘要）+ 输出预期（success_criteria）', () => {
    const p = buildPrompt(input());
    expect(p.system).toContain('任务：验证 OMB 最小认知解释器');
    expect(p.system).toContain('约定：验证先行');
    expect(p.system).toContain('输出预期：决策正确；确定性');
  });

  it('constraints 为空 → 不渲染约定行（最小性：无空 section）', () => {
    const p = buildPrompt(input({ task_contract: tc({ constraints: [] }) }));
    expect(p.system).not.toContain('约定：');
    expect(p.sections.some((s) => s.name === '约定')).toBe(false);
  });
});

// ---- ② 动态尾部 ----

describe('② 动态尾部（working_state 渲染：紧凑键值、8 字段、不篡改）', () => {
  it('working_state 8 字段全部出现（goal 经静态区任务行；其余 7 字段在动态尾部）且内容与输入一致', () => {
    const p = buildPrompt(input());
    // 8 字段值全部出现在 prompt，且与输入逐字段一致（不篡改）
    expect(p.system).toContain('任务：验证 OMB 最小认知解释器'); // goal（ws.goal === tc.goal）
    expect(p.system).toContain('已确认事实：固定状态输入');
    expect(p.system).toContain('活跃假设：H1: 管道确定性');
    expect(p.system).toContain('矛盾：无');
    expect(p.system).toContain('开放问题：Q1: 投影如何进入 prompt');
    expect(p.system).toContain('证据缺口：缺候选选择证据');
    expect(p.system).toContain('下一步行动：构造管道测试');
    expect(p.system).toContain('环境：win32');
  });

  it('renderWorkingState：7 字段紧凑键值渲染、数组顺序保留、空数组 → 无、goal 不在尾部（静态区已含）', () => {
    const r = renderWorkingState(ws({ confirmed_facts: ['a', 'b'], active_hypotheses: [] }));
    expect(r).toContain('已确认事实：a；b');
    expect(r).toContain('活跃假设：无');
    expect(r).toContain('矛盾：无');
    expect(r).toContain('环境：win32');
    expect(r).not.toContain('目标：'); // goal 已在静态区，尾部不重复
    expect(r).not.toContain('固定状态输入'); // 覆盖生效（不篡改：渲染只取输入）
  });
});

// ---- ③ 预算达标（e2e 管道） ----

describe('③ 预算达标（e2e：固定状态 → Governor → Context Projection → buildPrompt 管道）', () => {
  it('典型任务（goal+8 字段 working_state+3 候选）→ decision=RunProcess、prompt 含最小内容、total_tokens ≤ 500、确定性', () => {
    // 1. Governor（T2.2）：固定状态 → 已知 Process（retrieve-verify Strong 适用）
    const decision = decide(govInput(), policy.governor);
    expect(decision.decision).toBe('RunProcess');

    // 2. Context Compiler（T2.3）：候选 → ContextProjection（含 planning/scratch 视图）
    const projection = compile(
      compileInput({
        candidates: [
          item({ id: 'ev', kind: 'retrieval', content: '证据：决策表命中 RunProcess', source_ref: 'src:ev' }),
          item({ id: 'mem', kind: 'memory', content: '记忆：retrieve-verify 上次成功', source_ref: 'src:mem' }),
          item({ id: 'scr', kind: 'logs', content: '执行痕迹（scratch 默认隔离）', view: 'scratch', source_ref: 'src:scr' }),
        ],
      }),
    );

    // 3. buildPrompt：最小契约说明 + 动态尾部 + 上下文投影
    const p = buildPrompt(input({ projection }));
    expect(p.system).toContain('任务：验证 OMB 最小认知解释器');
    expect(p.system).toContain('约定：验证先行');
    expect(p.system).toContain('已确认事实：固定状态输入');
    expect(p.system).toContain('证据：决策表命中 RunProcess'); // planning 视图上下文进入 prompt
    expect(p.system).not.toContain('执行痕迹'); // execution_scratch 默认隔离（§6.1），不进入 prompt

    // 固定开销达标：静态区 + 动态尾部（含投影上下文）≤ 500 token
    expect(p.total_tokens).toBeLessThanOrEqual(500);

    // 确定性：同管道同输出
    expect(buildPrompt(input({ projection }))).toEqual(p);
  });
});

// ---- ④ 确定性 ----

describe('④ 确定性（同输入同输出，无随机/无时间依赖）', () => {
  it('同一输入两次 buildPrompt → 深比较完全一致（钩子不影响输出）', () => {
    const a = buildPrompt(input());
    const b = buildPrompt(input(), vi.fn());
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

// ---- ⑤ token 估算 ----

describe('⑤ token 估算（countTokens：中文 ≈1 token/字符，其余 ≈4 字符/token；近似公式，M7 基准校准）', () => {
  it('单调：更长文本 → 更多 token（中文与英文各自单调）', () => {
    expect(countTokens('中'.repeat(30))).toBeGreaterThan(countTokens('中'.repeat(5)));
    expect(countTokens('a'.repeat(120))).toBeGreaterThan(countTokens('a'.repeat(8)));
    expect(countTokens('验证先行'.repeat(6))).toBeGreaterThan(countTokens('验证先行'));
  });

  it('中文与英文均可处理（中文按字符计、英文按 4 字符/token、空串 0）', () => {
    expect(countTokens('中文测试')).toBe(4);
    expect(countTokens('hello')).toBe(2); // ceil(5/4)
    expect(countTokens('')).toBe(0);
    expect(countTokens('OMB 解释器')).toBeGreaterThan(0);
  });
});

// ---- ⑥ logged 钩子 ----

describe('⑥ logged 钩子（Model-visible ⟺ logged：session/start 事件 payload 带 prompt_tokens）', () => {
  it('注入 spy 回调：buildPrompt 恰好调用一次 onVisible(session_id, total_tokens)', () => {
    const spy = vi.fn();
    const p = buildPrompt(input(), spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('session-1', p.total_tokens);
  });

  it('未注入钩子 → 不调用（默认不记录，接线由调用方决定）', () => {
    const p = buildPrompt(input());
    expect(p.total_tokens).toBeGreaterThan(0);
  });

  it('钩子接线 T1.3 EventStore fixture：产生 session/start 事件且 payload.prompt_tokens 与 total_tokens 一致', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'omb-prompt-')), 'events.db');
    dbPaths.push(dbPath);
    const store = new EventStore(dbPath);
    stores.push(store);
    const hook: PromptVisibilityHook = (sid, tokens) => {
      void store.append(makePromptVisibilityEvent(sid, tokens));
    };
    const p = buildPrompt(input(), hook);
    await vi.waitFor(async () => {
      const { events } = await store.query({ type: 'session/start', session_id: 'session-1' });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ prompt_tokens: p.total_tokens });
    });
  });
});
