// T1.4 行为测试：State Reducer（Event → State 重建，架构 §12.1 Event / §5.2 三值认识论 / §7.4 Decision Lineage & Utility）。
// 覆盖（brief 9 项 + 补充）：事件序列→精确状态、hypothesis 全生命周期、决策链投影、utility 六计数器、
// 乱序 fail-loud（seq）、缺事件 fail-loud（未知 claim 引用）、未知事件类型 fail-loud（EVENTS_HANDLED 防漂移）、
// 重建一致性（确定性 snapshot_hash）、幂等（重放）、会话边界（session/start|end）、initial 种子、timestamp 排序。
import { describe, expect, it } from 'vitest';
import type { Event } from '../../kernel/schemas/m.js';
import type { State } from '../../kernel/schemas/s.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { EVENTS_HANDLED, reduce } from '../../supervisor/state-reducer.js';
import { PROV, S2_VALID, TS } from './ir-samples.js';

/** M3 Event 工厂：type + payload；id 唯一 evt:uuid（payload 语义见 supervisor/state-reducer.ts 头部注释） */
function evt(type: string, payload: Record<string, unknown> = {}): Event {
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: 'sess-1',
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: undefined,
    payload,
    timestamp: TS,
  };
}

const claimUpdate = (claimId: string, over: Record<string, unknown> = {}) =>
  evt('claim/update', { claim_id: claimId, ...over });
const hypTransition = (hypothesisId: string, over: Record<string, unknown> = {}) =>
  evt('hypothesis/transition', { hypothesis_id: hypothesisId, ...over });
const contradictionFound = (id: string, left: string, right: string, over: Record<string, unknown> = {}) =>
  evt('contradiction/found', { contradiction_id: id, left_claim: left, right_claim: right, ...over });
const decisionMade = (id: string, question: string, chosen: string, over: Record<string, unknown> = {}) =>
  evt('decision/made', { decision_id: id, question, chosen, ...over });

describe('事件序列 → 精确状态（§5.2）', () => {
  it('claim/update ×2 + hypothesis/transition + contradiction/found → confirmed_facts/active_hypotheses/contradictions 精确', () => {
    const events = [
      claimUpdate('c:1', { text: 'IR 定义完整', epistemic: 'supported', confidence: 0.8 }),
      claimUpdate('c:2', { text: 'Zod 选型合理', epistemic: 'supported', confidence: 0.7 }),
      hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
      contradictionFound('x:1', 'c:1', 'c:2', { severity: 'high' }),
    ];
    const { state, projections } = reduce(events);

    expect(state.working.confirmed_facts).toEqual(['c:1', 'c:2']);
    expect(state.working.active_hypotheses).toEqual(['h:1']);
    expect(state.working.contradictions).toEqual(['x:1']);
    expect(projections.claims.get('c:1')).toEqual({
      text: 'IR 定义完整',
      epistemic: 'supported',
      evidence_status: 'inferred',
      confidence: 0.8,
    });
    expect(projections.claims.get('c:2')).toEqual({
      text: 'Zod 选型合理',
      epistemic: 'supported',
      evidence_status: 'inferred',
      confidence: 0.7,
    });
    expect(state.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hypothesis 全生命周期（§5.2 三值认识论）', () => {
  const c = (id: string) => claimUpdate(id, { epistemic: 'supported', confidence: 0.6 });

  it('active → confirmed / rejected / discriminated 状态迁移正确（三值同步）', () => {
    const events = [
      c('c:1'),
      c('c:2'),
      c('c:3'),
      hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
      hypTransition('h:2', { claim_id: 'c:2', status: 'active' }),
      hypTransition('h:3', { claim_id: 'c:3', status: 'active' }),
      hypTransition('h:1', { claim_id: 'c:1', status: 'confirmed' }),
      hypTransition('h:2', { claim_id: 'c:2', status: 'rejected' }),
      hypTransition('h:3', { claim_id: 'c:3', status: 'discriminated' }),
    ];
    const { state, projections } = reduce(events);

    expect(state.working.active_hypotheses).toEqual([]);
    expect([...projections.hypotheses.entries()]).toEqual([
      ['h:1', { claim_id: 'c:1', status: 'confirmed' }],
      ['h:2', { claim_id: 'c:2', status: 'rejected' }],
      ['h:3', { claim_id: 'c:3', status: 'discriminated' }],
    ]);
    // 三值同步：confirmed → supported；rejected/discriminated → contradicted（§5.2）
    expect(projections.claims.get('c:1')?.epistemic).toBe('supported');
    expect(projections.claims.get('c:2')?.epistemic).toBe('contradicted');
    expect(projections.claims.get('c:3')?.epistemic).toBe('contradicted');
    expect(state.working.confirmed_facts).toEqual(['c:1']);
  });

  it('active 阶段：active_hypotheses 仅含 active 假设', () => {
    const events = [
      c('c:1'),
      c('c:2'),
      hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
      hypTransition('h:2', { claim_id: 'c:2', status: 'active' }),
      hypTransition('h:1', { claim_id: 'c:1', status: 'confirmed' }),
    ];
    const { state } = reduce(events);
    expect(state.working.active_hypotheses).toEqual(['h:2']);
  });
});

describe('决策链投影（§7.4 Decision Lineage）', () => {
  it('decision/made → decision_lineage 结构（question/chosen/evidence_used/supersedes）', () => {
    const events = [
      decisionMade('d:1', '选 zod?', 'zod', { evidence_used: ['e:1', 'e:2'] }),
      decisionMade('d:2', 'SQLite 驱动?', 'node:sqlite', { evidence_used: ['e:3'], supersedes: 'd:1' }),
    ];
    const { projections } = reduce(events);

    expect(projections.decision_lineage).toHaveLength(2);
    expect(projections.decision_lineage[0]).toEqual({
      id: 'd:1',
      question: '选 zod?',
      chosen: 'zod',
      evidence_used: ['e:1', 'e:2'],
    });
    expect(projections.decision_lineage[1]).toEqual({
      id: 'd:2',
      question: 'SQLite 驱动?',
      chosen: 'node:sqlite',
      evidence_used: ['e:3'],
      supersedes: 'd:1',
    });
  });
});

describe('utility 计数投影（§7.4 六计数器）', () => {
  it('tool/call ×2 + tool/result ×2 → tool_calls = 2（六计数器全键存在）', () => {
    const { projections } = reduce([
      evt('tool/call', { tool_id: 't:1' }),
      evt('tool/call', { tool_id: 't:2' }),
      evt('tool/result', { tool_id: 't:1' }),
      evt('tool/result', { tool_id: 't:2' }),
    ]);
    expect(projections.utility_counts.tool_calls).toBe(2);
    expect(projections.utility_counts).toEqual({
      tool_calls: 2,
      retrieval_calls: 0,
      memory_ops: 0,
      corrections: 0,
      reads: 0,
      hits: 0,
    });
  });

  it('memory/admitted + memory/consolidated → memory_ops 计数', () => {
    const { projections } = reduce([
      evt('memory/admitted', { memory_id: 'm:1' }),
      evt('memory/consolidated', { memory_id: 'm:1' }),
    ]);
    expect(projections.utility_counts.memory_ops).toBe(2);
  });

  it('process/operator/retrieve → retrieval_calls 计数', () => {
    const { projections } = reduce([evt('process/operator/retrieve', { operator_id: 'op:1' })]);
    expect(projections.utility_counts.retrieval_calls).toBe(1);
  });

  it('claim/update 三值翻转（supported→contradicted）→ corrections 计数（Belief Revision §7.4）', () => {
    const { projections } = reduce([
      claimUpdate('c:1', { epistemic: 'supported' }),
      claimUpdate('c:1', { epistemic: 'contradicted' }),
      claimUpdate('c:1', { epistemic: 'supported' }),
    ]);
    expect(projections.utility_counts.corrections).toBe(2);
  });
});

describe('乱序检测（seq / timestamp）', () => {
  it('seq 非严格递增 → fail-loud 抛错', () => {
    const events = [1, 2, 4, 3].map((seq) => ({ ...evt('claim/update', { claim_id: `c:${seq}` }), seq }));
    expect(() => reduce(events)).toThrow(/seq 乱序|非严格递增/);
  });

  it('seq 混合（部分事件有 seq）→ fail-loud 抛错（排序键不一致）', () => {
    const events = [
      { ...evt('claim/update', { claim_id: 'c:1' }), seq: 1 },
      evt('claim/update', { claim_id: 'c:2' }),
    ];
    expect(() => reduce(events)).toThrow(/混合|排序键/);
  });

  it('seq 严格递增 → 正常归约', () => {
    const events = [1, 2, 3].map((seq) => ({
      ...evt('claim/update', { claim_id: `c:${seq}`, epistemic: 'supported' }),
      seq,
    }));
    const { state } = reduce(events);
    expect(state.working.confirmed_facts).toEqual(['c:1', 'c:2', 'c:3']);
  });

  it('无 seq：按 timestamp 排序，timestamp 相同保持数组序（稳定排序）', () => {
    const t1 = '2026-08-21T00:00:01.000Z';
    const t2 = '2026-08-21T00:00:02.000Z';
    const events = [
      { ...evt('claim/update', { claim_id: 'c:2', epistemic: 'supported' }), timestamp: t2 },
      { ...evt('claim/update', { claim_id: 'c:1', epistemic: 'supported' }), timestamp: t1 },
      { ...evt('claim/update', { claim_id: 'c:3', epistemic: 'supported' }), timestamp: t1 },
    ];
    const { state } = reduce(events);
    expect(state.working.confirmed_facts).toEqual(['c:1', 'c:3', 'c:2']);
  });
});

describe('缺事件 fail-loud（引用检测）', () => {
  it('hypothesis/transition 引用未知 claim → 抛错（缺事件）', () => {
    expect(() => reduce([hypTransition('h:1', { claim_id: 'c:ghost', status: 'active' })])).toThrow(
      /引用未知 claim|缺事件/,
    );
  });

  it('contradiction/found 引用未知 claim → 抛错（缺事件）', () => {
    expect(() => reduce([contradictionFound('x:1', 'c:ghost', 'c:2')])).toThrow(/引用未知 claim|缺事件/);
  });

  it('hypothesis/transition 无 claim_id 且假设从未注册 → 抛错（缺事件）', () => {
    expect(() => reduce([hypTransition('h:1', { status: 'active' })])).toThrow(/引用未知 claim|缺事件/);
  });
});

describe('未知事件类型 fail-loud（EVENTS_HANDLED 防漂移）', () => {
  it('schema 非法类型 → 抛错', () => {
    expect(() => reduce([evt('bogus/type', {})])).toThrow(/未注册事件类型|EVENTS_HANDLED/);
  });

  it('schema 合法但未注册类型（checkpoint/saved、process/operator/foo）→ 抛错（新类型须先注册）', () => {
    expect(() => reduce([evt('checkpoint/saved', {})])).toThrow(/未注册事件类型|EVENTS_HANDLED/);
    expect(() => reduce([evt('process/operator/foo', {})])).toThrow(/未注册事件类型|EVENTS_HANDLED/);
  });

  it('EVENTS_HANDLED 注册表覆盖 brief 最小映射集', () => {
    for (const t of [
      'session/start',
      'session/end',
      'claim/update',
      'hypothesis/transition',
      'contradiction/found',
      'decision/made',
      'tool/call',
      'tool/result',
      'process/operator/retrieve',
      'memory/admitted',
      'memory/consolidated',
    ]) {
      expect(EVENTS_HANDLED).toContain(t);
    }
  });
});

describe('重建一致性（P7：模型可见 ⟺ 可重建）', () => {
  it('reduce 两次 → 相同 snapshot_hash 与状态（确定性）', () => {
    const events = [
      claimUpdate('c:1', { text: 'IR 定义完整', epistemic: 'supported', confidence: 0.8 }),
      claimUpdate('c:2', { epistemic: 'unresolved', confidence: 0.5 }),
      hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
      decisionMade('d:1', '选 zod?', 'zod', { evidence_used: ['e:1'] }),
      contradictionFound('x:1', 'c:1', 'c:2'),
    ];
    const a = reduce(events);
    const b = reduce(events);
    expect(b.state.snapshot_hash).toBe(a.state.snapshot_hash);
    expect(b.state).toEqual(a.state);
    expect(b.projections).toEqual(a.projections);
  });

  it('不同事件序列 → 不同 snapshot_hash', () => {
    const h1 = reduce([claimUpdate('c:1', { epistemic: 'supported' })]).state.snapshot_hash;
    const h2 = reduce([claimUpdate('c:2', { epistemic: 'supported' })]).state.snapshot_hash;
    expect(h1).not.toBe(h2);
  });
});

describe('幂等（重放）', () => {
  it('同一事件序列重放 → 相同状态', () => {
    const events = [claimUpdate('c:1', { epistemic: 'supported' })];
    const first = reduce(events);
    const second = reduce(events);
    expect(second.state).toEqual(first.state);
    expect(second.projections.claims.get('c:1')).toEqual(first.projections.claims.get('c:1'));
  });

  it('空事件序列 → 确定性空状态（工作区为空、snapshot_hash 稳定）', () => {
    const a = reduce([]);
    const b = reduce([]);
    expect(a.state).toEqual(b.state);
    expect(a.state.working.confirmed_facts).toEqual([]);
    expect(a.state.working.active_hypotheses).toEqual([]);
    expect(a.state.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('会话边界（session/start|end）', () => {
  it('session/start 重置工作区并更新 goal（知识视图跨会话累积）', () => {
    const events = [
      evt('session/start', { goal: '目标 A' }),
      claimUpdate('c:1', { epistemic: 'supported' }),
      evt('session/start', { goal: '目标 B' }),
      claimUpdate('c:2', { epistemic: 'supported' }),
    ];
    const { state, projections } = reduce(events);
    expect(state.working.goal).toBe('目标 B');
    expect(state.working.confirmed_facts).toEqual(['c:2']);
    expect(state.working.active_hypotheses).toEqual([]);
    expect(projections.claims.has('c:1')).toBe(true);
  });

  it('session/end → 终结标记（lifecycle retired）', () => {
    const { state } = reduce([evt('session/end', {})]);
    expect(state.lifecycle).toBe('retired');
    expect(state.working.lifecycle).toBe('retired');
  });
});

describe('initial 状态种子（opts.initial）', () => {
  it('goal/confirmed_facts/world/self 保留，事件叠加', () => {
    const { state } = reduce([claimUpdate('c:new', { epistemic: 'supported' })], {
      initial: S2_VALID as unknown as State,
    });
    expect(state.working.goal).toBe('g');
    expect(state.working.confirmed_facts).toEqual(['f:1', 'c:new']);
    expect(state.working.active_hypotheses).toEqual(['h:1']);
    expect(state.world).toBe('wm:1');
    expect(state.self).toBe('sm:1');
  });
});
