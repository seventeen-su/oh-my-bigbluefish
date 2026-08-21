// T8.11 行为测试：宪法转换不变量可执行检查（架构 §14.1/§14.2，直接作用于 Semantic IR 事件流）。
// 证据门①：Claim 目标 evidence_status=verified 需要证据在场（Evidence 引用非空或对应 observation 事件在场）→ 违规 fail-loud。
// 降级门②：Observation=contradictory → 活动假设必须降级（active→discriminated/rejected）→ 违规 fail-loud。
// 事件：observation/contradictory {observation_id, claim_id, hypothesis_id, status}（§12.1 事件类型，EVENTS_HANDLED 注册）。
import { describe, expect, it } from 'vitest';
import { EventSchema, type Event } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { EVENTS_HANDLED, reduce } from '../../supervisor/state-reducer.js';
import { PROV, TS } from '../m1/ir-samples.js';

/** M3 Event 工厂（同 tests/m1/state-reducer.test.ts） */
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
    session_id: 'sess-const',
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
const obsContradictory = (observationId: string, claimId: string, hypothesisId: string, over: Record<string, unknown> = {}) =>
  evt('observation/contradictory', { observation_id: observationId, claim_id: claimId, hypothesis_id: hypothesisId, ...over });

/** 活动假设 + 可选附加事件序列（供降级门用例复用） */
function activeHypChain(extra: Event[] = []): Event[] {
  return [
    claimUpdate('c:1', { epistemic: 'supported' }),
    hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
    ...extra,
  ];
}

describe('宪法不变量①：verified 需要证据在场（§14.1：Claim=inferred 且 Evidence=absent → 不得转 verified）', () => {
  it('违规：evidence_status=verified 无证据（无 Evidence 引用、无 observation 事件）→ fail-loud', () => {
    expect(() => reduce([claimUpdate('c:1', { evidence_status: 'verified' })])).toThrow(/宪法不变量违规/);
  });

  it('违规：evidence_status=verified 但 evidence 为空数组 → fail-loud', () => {
    expect(() => reduce([claimUpdate('c:1', { evidence_status: 'verified', evidence: [] })])).toThrow(
      /宪法不变量违规/,
    );
  });

  it('合法：inferred + Evidence 引用（evidence 非空）→ verified', () => {
    const { projections } = reduce([claimUpdate('c:1', { evidence_status: 'verified', evidence: ['e:1'] })]);
    expect(projections.claims.get('c:1')?.evidence_status).toBe('verified');
  });

  it('合法：对应 observation 事件在场 → verified（证据门 observation 分支）', () => {
    const events = [
      ...activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', { status: 'discriminated' })]),
      claimUpdate('c:1', { evidence_status: 'verified' }),
    ];
    const { projections } = reduce(events);
    expect(projections.claims.get('c:1')?.evidence_status).toBe('verified');
  });

  it('非法 evidence_status 值 fail-loud', () => {
    expect(() => reduce([claimUpdate('c:1', { evidence_status: 'proven' })])).toThrow(/非法 evidence_status/);
  });

  it('已验证 claim 后续更新（改文本）不重复触发证据门（证据已确立）', () => {
    const events = [
      claimUpdate('c:1', { evidence_status: 'verified', evidence: ['e:1'] }),
      claimUpdate('c:1', { text: 'IR 定义完整（修订）' }),
    ];
    const { projections } = reduce(events);
    expect(projections.claims.get('c:1')?.evidence_status).toBe('verified');
  });

  it('合法：verified → inferred 证据撤销降级', () => {
    const events = [
      claimUpdate('c:1', { evidence_status: 'verified', evidence: ['e:1'] }),
      claimUpdate('c:1', { evidence_status: 'inferred' }),
    ];
    const { projections } = reduce(events);
    expect(projections.claims.get('c:1')?.evidence_status).toBe('inferred');
  });
});

describe('宪法不变量②：Observation=contradictory → 活动假设必须降级（§14.1）', () => {
  it('违规：无降级 status → fail-loud（活动假设必须 active→discriminated/rejected）', () => {
    expect(() => reduce(activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', {})]))).toThrow(/宪法不变量违规/);
  });

  it('违规：status 保持 active（非降级）→ fail-loud', () => {
    expect(() =>
      reduce(activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', { status: 'active' })])),
    ).toThrow(/宪法不变量违规/);
  });

  it('违规：status=confirmed（升级而非降级）→ fail-loud', () => {
    expect(() =>
      reduce(activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', { status: 'confirmed' })])),
    ).toThrow(/宪法不变量违规/);
  });

  it('违规：假设非 active（已 confirmed）→ fail-loud（活动假设才须降级）', () => {
    const events = [
      ...activeHypChain([hypTransition('h:1', { claim_id: 'c:1', status: 'confirmed' })]),
      obsContradictory('o:1', 'c:1', 'h:1', { status: 'discriminated' }),
    ];
    expect(() => reduce(events)).toThrow(/宪法不变量违规/);
  });

  it('违规：假设不属于该 claim → fail-loud', () => {
    const events = [
      claimUpdate('c:1', { epistemic: 'supported' }),
      claimUpdate('c:2', { epistemic: 'supported' }),
      hypTransition('h:1', { claim_id: 'c:1', status: 'active' }),
      obsContradictory('o:1', 'c:2', 'h:1', { status: 'discriminated' }),
    ];
    expect(() => reduce(events)).toThrow(/宪法不变量违规/);
  });

  it('违规：引用未知假设 → fail-loud（缺事件）', () => {
    expect(() =>
      reduce([claimUpdate('c:1', {}), obsContradictory('o:1', 'c:1', 'h:ghost', { status: 'discriminated' })]),
    ).toThrow(/引用未知假设|缺事件/);
  });

  it('违规：引用未知 claim → fail-loud（缺事件）', () => {
    expect(() =>
      reduce([obsContradictory('o:1', 'c:ghost', 'h:1', { status: 'discriminated' })]),
    ).toThrow(/引用未知 claim|缺事件/);
  });

  it('违规：缺少 observation_id/claim_id/hypothesis_id → fail-loud', () => {
    expect(() => reduce([evt('observation/contradictory', {})])).toThrow(/缺少 observation_id|claim_id|hypothesis_id/);
  });

  it('合法：active → discriminated（降级成功，claim 三值同步 contradicted）', () => {
    const { state, projections } = reduce(
      activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', { status: 'discriminated' })]),
    );
    expect(state.working.active_hypotheses).toEqual([]);
    expect(projections.hypotheses.get('h:1')).toEqual({ claim_id: 'c:1', status: 'discriminated' });
    expect(projections.claims.get('c:1')?.epistemic).toBe('contradicted'); // §5.2 三值同步
    expect(state.working.confirmed_facts).toEqual([]);
  });

  it('合法：active → rejected（降级成功）', () => {
    const { state, projections } = reduce(
      activeHypChain([obsContradictory('o:1', 'c:1', 'h:1', { status: 'rejected' })]),
    );
    expect(state.working.active_hypotheses).toEqual([]);
    expect(projections.hypotheses.get('h:1')).toEqual({ claim_id: 'c:1', status: 'rejected' });
    expect(projections.claims.get('c:1')?.epistemic).toBe('contradicted');
  });
});

describe('事件类型注册（§12.1 事件类型 + EVENTS_HANDLED 防漂移）', () => {
  it('observation/contradictory 为 schema 合法固定事件类型', () => {
    expect(EventSchema.safeParse(obsContradictory('o:1', 'c:1', 'h:1', { status: 'discriminated' })).success).toBe(true);
  });

  it('EVENTS_HANDLED 已注册 observation/contradictory（新类型须先注册并实现映射）', () => {
    expect(EVENTS_HANDLED).toContain('observation/contradictory');
  });
});
