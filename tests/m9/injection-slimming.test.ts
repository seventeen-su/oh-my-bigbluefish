// 每轮注入瘦身行为测试（对应 docs/known-issues.md《每轮注入的构成与浪费点》修复判定）：
//   ① 契约标题改为「OMB认知层使用方式：」并精简措辞（不强调版本），总量 ≤500 字符
//   ② evidence 候选改为紧凑摘要：只取文本字段 + 截断，不再整段原始 JSON
//   ③ 空字段不渲染（全空工作状态不再输出空占位）
//   ④ goal 截断（完整内容已在对话中），数组条目与单条长度设上限
//   ⑤ 三段 section 合并的注入总长设上限（最坏情况与常规情况各一条）
//   ⑥ 确定性：同输入同输出（截断/摘录不引入随机）
import { describe, expect, it } from 'vitest';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import { loadProcesses, type ProcessDef } from '../../kernel/policy-loader.js';
import { fileURLToPath } from 'node:url';
import { OMB_RUNTIME_CONTRACT, buildCapabilitiesLine } from '../../runtime/runtime-contract.js';
import { projectionToText } from '../../runtime/loop-hooks.js';
import {
  GOAL_LIMIT,
  WORKING_STATE_ITEM_CHARS,
  WORKING_STATE_ITEM_LIMIT,
  compile,
  renderWorkingStateText,
  type CandidateItem,
} from '../../runtime/renderer.js';
import {
  EVIDENCE_TEXT_LIMIT,
  compactEvidenceText,
  gatherContextCandidates,
} from '../../runtime/context-candidates.js';
import type { Event } from '../../kernel/schemas/m.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const PROCESSES_DIR = fileURLToPath(new URL('../../kernel/processes', import.meta.url));

/** 三段注入总长上限（最坏情况：超长 goal + 超长 payload 事件 + 多项候选；§17 可标定） */
const INJECTION_TOTAL_MAX_WORST = 2400;
/** 三段注入总长上限（常规情况） */
const INJECTION_TOTAL_MAX_TYPICAL = 900;

let policyPromise: Promise<PolicyBundle> | undefined;
let processesPromise: Promise<readonly ProcessDef[]> | undefined;
const policy = async (): Promise<PolicyBundle> => (policyPromise ??= loadPolicy(POLICY_DIR));
const processes = async (): Promise<readonly ProcessDef[]> => (processesPromise ??= loadProcesses(PROCESSES_DIR));

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

/** 复用 gatherContextCandidates 的 fake 事件库（结构最小面） */
function fakeEvent(type: string, payload: Record<string, unknown>, i: number): Event {
  return {
    id: `evt:${i}`,
    type,
    payload,
    session_id: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as unknown as Event;
}

describe('① 契约标题与措辞', () => {
  it('标题为「OMB认知层使用方式：」，不含版本强调，总量 ≤500 字符', () => {
    expect(OMB_RUNTIME_CONTRACT.startsWith('OMB认知层使用方式：')).toBe(true);
    expect(OMB_RUNTIME_CONTRACT).not.toContain('运行时契约（认知层使用方式）');
    expect(OMB_RUNTIME_CONTRACT.length).toBeLessThanOrEqual(500);
  });
});

describe('② evidence 紧凑摘要', () => {
  it('文本字段优先（text/detail/summary…），超长截断到 EVIDENCE_TEXT_LIMIT', () => {
    const long = 'x'.repeat(500);
    expect(compactEvidenceText({ text: long })).toBe(`${'x'.repeat(EVIDENCE_TEXT_LIMIT)}…`);
    expect(compactEvidenceText({ detail: '细节' })).toBe('细节');
    expect(compactEvidenceText({ summary: '摘要', text: '正文' })).toBe('正文'); // 字段序：text 优先
  });

  it('无文本字段 → 结构摘要只列标量（数组/对象折叠为计数），不输出 JSON 大括号引号堆叠', () => {
    const s = compactEvidenceText({ tool_id: 't:1', name: 'read', ok: true, items: [1, 2, 3], meta: { a: 1, b: 2 } });
    expect(s).toContain('tool_id=t:1');
    expect(s).toContain('name=read');
    expect(s).toContain('ok=true');
    expect(s).toContain('items[3]'); // 数组折叠为计数
    expect(s).toContain('meta{2}'); // 对象折叠为字段数
    // 无原始 JSON 痕迹：不带引号键值、不出现数组内容展开
    expect(s).not.toContain('"');
    expect(s).not.toContain('[1,');
    expect(s).not.toContain('"a":');
  });

  it('空载荷 / 无字段 → 诚实占位（不产生空 section）', () => {
    expect(compactEvidenceText(null)).toBe('(无文本载荷)');
    expect(compactEvidenceText({})).toBe('(无文本载荷)');
    expect(compactEvidenceText({ a: null, b: undefined })).toBe('(无文本载荷)');
  });

  it('候选口径：payload 大体量事件 → content 短小（type 前缀保留）', async () => {
    const big = { text: 'y'.repeat(4000) };
    const cands = await gatherContextCandidates({
      goal: 'g',
      working_state: {
        goal: 'g',
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
      memory_items: [],
      runtime: {
        eventStore: {
          query: async () => ({ events: [fakeEvent('tool/result', big, 1)] }),
        } as never,
        capabilities: { list: () => [] } as never,
      },
      session_id: 's1',
    });
    const ev = cands.find((c) => c.kind === 'evidence');
    expect(ev).toBeDefined();
    expect(ev!.content.startsWith('tool/result: ')).toBe(true);
    expect(ev!.content.length).toBeLessThanOrEqual('tool/result: '.length + EVIDENCE_TEXT_LIMIT + 1);
    expect(ev!.content).not.toContain('y'.repeat(EVIDENCE_TEXT_LIMIT + 1));
  });
});

describe('③④ 工作状态字段级投影', () => {
  const empty = {
    goal: '',
    confirmed_facts: [],
    active_hypotheses: [],
    contradictions: [],
    open_questions: [],
    evidence_gaps: [],
    next_best_action: '',
    environment: 'unknown',
  };

  it('全空工作状态 → 空对象（不再输出空字段占位）', () => {
    const text = renderWorkingStateText(empty);
    expect(text).toBe('{}');
    for (const f of ['confirmed_facts', 'active_hypotheses', 'contradictions', 'open_questions', 'evidence_gaps', 'next_best_action']) {
      expect(text).not.toContain(f);
    }
  });

  it('goal 截断到 GOAL_LIMIT（超长加省略号）；短 goal 原样', () => {
    const longGoal = '目'.repeat(GOAL_LIMIT + 50);
    const t = renderWorkingStateText({ ...empty, goal: longGoal });
    expect(t).toContain('…');
    expect(JSON.parse(t).goal.length).toBe(GOAL_LIMIT + 1); // 截断内容 + 省略号
    expect(renderWorkingStateText({ ...empty, goal: '短目标' })).toContain('短目标');
  });

  it('数组字段：条目数上限 + 单条长度上限（超出标注总数）', () => {
    const facts = Array.from({ length: WORKING_STATE_ITEM_LIMIT + 2 }, (_, i) => `事实${i}`);
    const parsed = JSON.parse(
      renderWorkingStateText({ ...empty, confirmed_facts: facts, next_best_action: '动'.repeat(200) }),
    ) as { confirmed_facts: string[]; next_best_action: string };
    expect(parsed.confirmed_facts).toHaveLength(WORKING_STATE_ITEM_LIMIT + 1); // N 条 + 总数标注
    expect(parsed.confirmed_facts[WORKING_STATE_ITEM_LIMIT]).toContain(`共 ${facts.length} 条`);
    expect(parsed.next_best_action.length).toBeLessThanOrEqual(WORKING_STATE_ITEM_CHARS + 1);
  });

  it('确定性：同输入两次渲染完全相同', () => {
    const ws = { ...empty, goal: 'g', confirmed_facts: ['a', 'b'], evidence_gaps: ['gap'] };
    expect(renderWorkingStateText(ws)).toBe(renderWorkingStateText(ws));
  });
});

describe('⑤ 三段注入总长上限', () => {
  /** 三段合并文本（契约 + 能力行 + 投影）——与宿主注入顺序一致 */
  function threeSections(text: string): string {
    return [OMB_RUNTIME_CONTRACT, buildCapabilitiesLine({ capabilities: ['memory.retrieve'], judgeAvailable: true, runnerAvailable: true }), text].join('\n');
  }

  it('常规情况：常规 goal + 少量候选 + 常规工作状态 → 总长 ≤ 900 字符', async () => {
    const p = await policy();
    const proj = compile({
      task_contract: { goal: '实现记忆检索', success_criteria: ['检索命中'] },
      working_state: {
        goal: '实现记忆检索',
        confirmed_facts: ['FTS5 可用'],
        active_hypotheses: [],
        contradictions: [],
        open_questions: ['中文分词口径'],
        evidence_gaps: [],
        next_best_action: '补分词测试',
        environment: 'win32',
      },
      candidates: [
        item({ id: 'm1', kind: 'memory', content: '记忆内容：检索链路已接通', source_ref: 'mem:1' }),
        item({ id: 'e1', kind: 'evidence', content: 'tool/result: read 成功', source_ref: 'event:1' }),
      ],
      budget_tokens: 500,
      policy: p.context,
    });
    const total = threeSections(projectionToText(proj)).length;
    expect(total).toBeLessThanOrEqual(INJECTION_TOTAL_MAX_TYPICAL);
  });

  it('最坏情况：超长 goal + 超长 payload 事件 + 多项候选 → 总长 ≤ 2400 字符', async () => {
    const p = await policy();
    const procs = await processes();
    const cands = await gatherContextCandidates({
      goal: '目标是'.repeat(2000),
      working_state: {
        goal: '目标是'.repeat(2000),
        confirmed_facts: Array.from({ length: 50 }, (_, i) => `超长事实${i}${'x'.repeat(300)}`),
        active_hypotheses: Array.from({ length: 50 }, (_, i) => `假设${i}${'y'.repeat(300)}`),
        contradictions: [],
        open_questions: Array.from({ length: 20 }, (_, i) => `问题${i}${'z'.repeat(300)}`),
        evidence_gaps: Array.from({ length: 20 }, (_, i) => `缺口${i}${'w'.repeat(300)}`),
        next_best_action: '下一步'.repeat(500),
        environment: 'win32',
      },
      memory_items: Array.from({ length: 10 }, (_, i) => ({
        memory: { id: `m${i}`, payload: '记忆'.repeat(500) },
        value: 1,
        reasons: [],
      })) as never,
      runtime: {
        eventStore: {
          query: async () => ({
            events: Array.from({ length: 10 }, (_, i) =>
              fakeEvent('tool/result', { text: '载荷'.repeat(2000), i }, i),
            ),
          }),
        } as never,
        capabilities: { list: () => [] } as never,
        artifacts: async () => [],
      },
      session_id: 's1',
      process: {
        process_id: procs[0]!.id,
        name: procs[0]!.id,
        steps: procs[0]!.operators.map((o) => o.op),
        budget_tokens: 100,
        method: 'test',
      },
    });
    const proj = compile({
      task_contract: { goal: '目标是'.repeat(2000), success_criteria: [] },
      working_state: {
        goal: '目标是'.repeat(2000),
        confirmed_facts: Array.from({ length: 50 }, (_, i) => `超长事实${i}${'x'.repeat(300)}`),
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'win32',
      },
      candidates: cands.map((c) => item({
        id: c.ref,
        kind: c.kind as CandidateItem['kind'],
        content: c.content,
        tokens: Math.max(1, Math.ceil(c.content.length / 4)),
        view: 'planning',
        info_value: c.info_value,
        source_ref: c.ref,
      })),
      budget_tokens: 500,
      policy: p.context,
    });
    const text = threeSections(projectionToText(proj));
    expect(text.length).toBeLessThanOrEqual(INJECTION_TOTAL_MAX_WORST);
    // 投影头不再带版本强调
    expect(text).not.toContain('认知投影（OMB v2');
  });
});
