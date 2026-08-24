// R7 行为测试（P1 架构闭合）：Context 候选来源扩展（架构 §6.1 候选全集——
// Memory/Evidence/Capability/Process/Artifact）+ S3 ΔInfoValue 缺口匹配启发式（§17 首版承诺）。
// 评估依据（.omb/drafts/下一步说明.md §14A/B）：buildContextProjection 输入 = WorkingState + retrieved.items
// （仅 Memory）→ 三视图结构已实现、内容来源不完整；R7 把候选来源扩展为设计全集：
//   候选统一入口（gatherContextCandidates）+ 各来源接入（注入 fake 事件库/注册表/制品库）+
//   编译面接入（新 source section + 预算贪心保持 + 确定性 + 空来源无新增 section）；
//   ΔInfoValue（S3）：WorkingState 缺口匹配启发式动态估计——五来源统一，固定值/r.value 近似移除。
// 严格 TDD：本文件先于实现编写（runtime/context-candidates.ts 不存在 → RED）。
// 覆盖：
//   estimateInfoValue：确定性（同输入同值）+ gap 命中 > 未命中 + 冲突减分 + 空缺口低值 + 空内容 0
//   gather：memory/evidence/capability/process/artifact 五来源候选收集 + N/M/K 封顶 + 空来源缺省 +
//           info_value 统一经 estimateInfoValue（memory 不再用 r.value、process 不再固定 200）
//   toCandidateItems：ContextCandidate → renderer CandidateItem（功能视图映射 + ref 透传）
//   compile：新来源 section 输出（evidence/capability/artifact——process 统一并入）+ 预算截断 + 确定性
//   buildContextProjection：sources 注入 → 新 section；sources 缺省 → 与既有一致（process 固定 section）
//   生产路径：真实事件库 observeEvent → prepareTurn 投影含 evidence section；确定性保持
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import { ContextProjectionSchema } from '../../kernel/schemas/a.js';
import type { Event } from '../../kernel/schemas/m.js';
import type { RankedMemory } from '../../memory/retrieve.js';
import type { CapabilityLike } from '../../supervisor/capability.js';
import type { ArtifactMeta } from '../../supervisor/artifact-store.js';
import { compile, type ProcessSectionInput } from '../../runtime/renderer.js';
import { buildContextProjection, makeRuntimeEvent } from '../../runtime/turn-helpers.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import {
  ARTIFACT_CANDIDATE_LIMIT,
  CAPABILITY_CANDIDATE_LIMIT,
  EVIDENCE_CANDIDATE_LIMIT,
  INFO_VALUE_BASE,
  estimateInfoValue,
  gatherContextCandidates,
  toCandidateItems,
  type ContextCandidate,
  type InfoValueContext,
} from '../../runtime/context-candidates.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));

let policy: PolicyBundle;
beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
});

// ---- fixture：fake 来源 + 最小事件/记忆/过程 ----

/** 最小工作状态（PromptWorkingState 结构面） */
const ws = {
  goal: 'R7 测试目标',
  confirmed_facts: [] as string[],
  active_hypotheses: [] as string[],
  contradictions: [] as string[],
  open_questions: [] as string[],
  evidence_gaps: [] as string[],
  next_best_action: '',
  environment: 'test',
};

let seq = 0;
/** 最小 M3 事件（gather 仅读 id/type/payload；schema 面完整供生产路径 observeEvent 复用） */
function fakeEvent(type: string, payload: Record<string, unknown> = {}): Event {
  seq += 1;
  const ts = '2026-08-21T00:00:00.000Z';
  return {
    ir_version: '2.0',
    id: `evt:${seq}`,
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'test',
      event: type,
      actor: 't',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: ts,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    type: type as Event['type'],
    session_id: 'sess-r7',
    runtime_snapshot: 'rs:test',
    parent_event: null,
    payload,
    timestamp: ts,
  };
}

/** fake 事件库（query 返回注入序列；gather 侧封顶为权威） */
function fakeEventStore(events: Event[]): { query: () => Promise<{ events: Event[] }> } {
  return { query: async () => ({ events }) };
}

/** fake 能力注册表 */
function fakeCapabilities(caps: CapabilityLike[]): { list: () => CapabilityLike[] } {
  return { list: () => caps };
}

/** fake 制品库（index 返回注入 meta 表） */
function fakeArtifacts(metas: Record<string, ArtifactMeta>): { index: () => Promise<Map<string, ArtifactMeta>> } {
  return { index: async () => new Map(Object.entries(metas)) };
}

/** RankedMemory 最小构造（payload/值可注入） */
function memoryItem(id: string, payload = '记忆内容', value = 0.8): RankedMemory {
  return {
    memory: {
      ir_version: '2.0',
      id,
      schema: 'omb/M1',
      scope: 'Project',
      kind: 'Semantic',
      lifecycle: 'Active',
      prov_class: 'Observation',
      immutable: false,
      owner: 'kernel',
      created: '2026-08-21T00:00:00.000Z',
      updated: '2026-08-21T00:00:00.000Z',
      provenance: {
        source: 'test',
        event: 'test/ingest',
        actor: 't',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
        runtime_snapshot: 'rs:test',
        timestamp: '2026-08-21T00:00:00.000Z',
        transformation_chain: [],
        verification: 'test',
      },
      refs: [],
      payload,
      value_score: value,
      utility_counts: {},
    },
    rank: 0,
    value,
  };
}

/** R3 调度结果（ProcessSectionInput 结构面） */
function processInput(): ProcessSectionInput {
  return {
    process_id: 'retrieve-verify',
    name: 'retrieve-verify',
    steps: ['RETRIEVE', 'VERIFY', 'STOP'],
    budget_tokens: 8000,
    method: 'reuse',
  };
}

/** gather 输入工厂（缺省：空来源 + 空记忆；逐用例覆盖） */
function gatherInput(
  over: Partial<Parameters<typeof gatherContextCandidates>[0]> = {},
): Parameters<typeof gatherContextCandidates>[0] {
  return {
    working_state: ws,
    goal: ws.goal,
    memory_items: [] as RankedMemory[],
    runtime: { eventStore: fakeEventStore([]), capabilities: fakeCapabilities([]) },
    ...over,
  };
}

describe('R7 gatherContextCandidates：各来源候选收集（注入 fake 事件库/注册表/制品库）', () => {
  it('memory：检索项 → memory 候选（ref=memory id、info_value=缺口匹配启发式（空缺口 → 基础值）、view=summary、tokens 估算非零）', async () => {
    const mem = memoryItem('mem:1', '记忆载荷', 0.7);
    const cands = await gatherContextCandidates(gatherInput({ memory_items: [mem] }));
    const m = cands.find((c) => c.kind === 'memory');
    expect(m).toBeDefined();
    expect(m!.ref).toBe('mem:1');
    expect(m!.view).toBe('summary');
    expect(m!.content).toBe('记忆载荷');
    // S3：memory 统一缺口匹配启发式（r.value 为检索排序信号，不直接作为投影价值）；空缺口 → 基础值
    expect(m!.info_value).toBe(INFO_VALUE_BASE);
    expect(m!.tokens_est).toBeGreaterThan(0);
  });

  it('evidence：Observation/decision 类事件 → evidence 候选（ref=event:<id>、view=original、content 含类型与载荷）；非 evidence 类型不入选', async () => {
    const events = [
      fakeEvent('session/start', { goal: 'g' }),
      fakeEvent('decision/made', { chosen: 'Verify' }),
      fakeEvent('tool/result', { tool_id: 't:1', name: 'read' }),
      fakeEvent('claim/update', { claim_id: 'c:1' }),
    ];
    const cands = await gatherContextCandidates(
      gatherInput({
        session_id: 'sess-r7',
        runtime: { eventStore: fakeEventStore(events), capabilities: fakeCapabilities([]) },
      }),
    );
    const evs = cands.filter((c) => c.kind === 'evidence');
    expect(evs).toHaveLength(3); // session/start 非 Observation/decision 类 → 不入选
    expect(evs.map((c) => c.ref)).toEqual(['event:evt:2', 'event:evt:3', 'event:evt:4']);
    expect(evs.every((c) => c.view === 'original')).toBe(true);
    expect(evs[1]!.content).toContain('tool/result');
    expect(evs[1]!.content).toContain('t:1');
  });

  it('evidence 封顶：10 条 evidence 事件 → 恰 EVIDENCE_CANDIDATE_LIMIT 条（最近 N 条，确定性）', async () => {
    const events = Array.from({ length: 10 }, (_, i) => fakeEvent('tool/result', { i }));
    const cands = await gatherContextCandidates(
      gatherInput({
        session_id: 'sess-r7',
        runtime: { eventStore: fakeEventStore(events), capabilities: fakeCapabilities([]) },
      }),
    );
    const evs = cands.filter((c) => c.kind === 'evidence');
    expect(evs).toHaveLength(EVIDENCE_CANDIDATE_LIMIT);
    expect(evs[0]!.ref).toBe(`event:${events[events.length - EVIDENCE_CANDIDATE_LIMIT]!.id}`); // 最近端（seq 窗口尾）
    expect(evs[evs.length - 1]!.ref).toBe(`event:${events[events.length - 1]!.id}`);
  });

  it('capability：注册表能力 → capability 候选（ref=能力 id、view=original、content=能力：name）', async () => {
    const caps: CapabilityLike[] = [
      { id: 'cap:1', name: 'memory.retrieve', authority_scope: 'kernel' },
      { id: 'cap:2', name: 'web.search', authority_scope: 'kernel', reliability: 'high' },
    ];
    const cands = await gatherContextCandidates(
      gatherInput({ runtime: { eventStore: fakeEventStore([]), capabilities: fakeCapabilities(caps) } }),
    );
    const cs = cands.filter((c) => c.kind === 'capability');
    expect(cs).toHaveLength(2);
    expect(cs[0]!.ref).toBe('cap:1');
    expect(cs[0]!.content).toContain('memory.retrieve');
    expect(cs[0]!.view).toBe('original');
  });

  it('capability 封顶：8 能力 → 恰 CAPABILITY_CANDIDATE_LIMIT 条', async () => {
    const caps: CapabilityLike[] = Array.from({ length: 8 }, (_, i) => ({
      id: `cap:${i}`,
      name: `cap.${i}`,
      authority_scope: 'kernel',
    }));
    const cands = await gatherContextCandidates(
      gatherInput({ runtime: { eventStore: fakeEventStore([]), capabilities: fakeCapabilities(caps) } }),
    );
    expect(cands.filter((c) => c.kind === 'capability')).toHaveLength(CAPABILITY_CANDIDATE_LIMIT);
  });

  it('process：R3 调度结果 → process 候选（复用 process section 渲染；info_value=缺口匹配启发式——固定 200 已移除，空缺口 → 基础值）', async () => {
    const cands = await gatherContextCandidates(gatherInput({ process: processInput() }));
    const p = cands.find((c) => c.kind === 'process');
    expect(p).toBeDefined();
    expect(p!.ref).toBe('process:retrieve-verify');
    expect(p!.view).toBe('original');
    expect(p!.content).toContain('认知过程');
    expect(p!.content).toContain('RETRIEVE → VERIFY → STOP');
    // S3：process 不再恒全源最高（固定 200 移除）——缺口匹配时才优先；空缺口 → 基础值
    expect(p!.info_value).toBe(INFO_VALUE_BASE);
  });

  it('artifact：制品索引 → artifact 候选（view=pointer、按 created 降序取 K；ref=制品 id）', async () => {
    const metas: Record<string, ArtifactMeta> = {
      'sha256:0000000000000000000000000000000000000000000000000000000000000001': {
        type: 'report',
        scope: 'Project',
        size: 10,
        created: '2026-08-21T00:00:00.000Z',
      },
      'sha256:0000000000000000000000000000000000000000000000000000000000000002': {
        type: 'log',
        scope: 'Project',
        size: 20,
        created: '2026-08-22T00:00:00.000Z',
      },
      'sha256:0000000000000000000000000000000000000000000000000000000000000003': {
        type: 'code',
        scope: 'Global',
        size: 30,
        created: '2026-08-23T00:00:00.000Z',
      },
    };
    const cands = await gatherContextCandidates(
      gatherInput({
        runtime: {
          eventStore: fakeEventStore([]),
          capabilities: fakeCapabilities([]),
          artifactStore: fakeArtifacts(metas),
        },
      }),
    );
    const arts = cands.filter((c) => c.kind === 'artifact');
    expect(arts).toHaveLength(3);
    expect(arts.map((c) => c.ref)).toEqual([
      'sha256:0000000000000000000000000000000000000000000000000000000000000003', // created 最新优先
      'sha256:0000000000000000000000000000000000000000000000000000000000000002',
      'sha256:0000000000000000000000000000000000000000000000000000000000000001',
    ]);
    expect(arts[0]!.view).toBe('pointer');
  });

  it('artifact 封顶：5 制品 → 恰 ARTIFACT_CANDIDATE_LIMIT 条（最近 K 条）', async () => {
    const metas: Record<string, ArtifactMeta> = {};
    for (let i = 1; i <= 5; i++) {
      metas[`sha256:${String(i).padStart(64, '0')}`] = {
        type: `t${i}`,
        scope: 'Project',
        size: i,
        created: `2026-08-2${i}T00:00:00.000Z`,
      };
    }
    const cands = await gatherContextCandidates(
      gatherInput({
        runtime: {
          eventStore: fakeEventStore([]),
          capabilities: fakeCapabilities([]),
          artifactStore: fakeArtifacts(metas),
        },
      }),
    );
    expect(cands.filter((c) => c.kind === 'artifact')).toHaveLength(ARTIFACT_CANDIDATE_LIMIT);
  });

  it('artifact 缺省空：无 artifactStore 来源（CognitiveRuntime 未装配）→ 无 artifact 候选', async () => {
    const cands = await gatherContextCandidates(
      gatherInput({ runtime: { eventStore: fakeEventStore([]), capabilities: fakeCapabilities([]) } }),
    );
    expect(cands.some((c) => c.kind === 'artifact')).toBe(false);
  });

  it('无 session_id → 无 evidence 候选（会话上下文缺失时不臆造）', async () => {
    const cands = await gatherContextCandidates(
      gatherInput({
        runtime: { eventStore: fakeEventStore([fakeEvent('decision/made', {})]), capabilities: fakeCapabilities([]) },
      }),
    );
    expect(cands.some((c) => c.kind === 'evidence')).toBe(false);
  });

  it('空来源（空事件/空注册表/无过程/无制品）→ 仅 memory 候选', async () => {
    const cands = await gatherContextCandidates(gatherInput({ memory_items: [memoryItem('mem:1')] }));
    expect(cands).toHaveLength(1);
    expect(cands[0]!.kind).toBe('memory');
  });
});

describe('S3 estimateInfoValue：缺口匹配启发式（§17 首版承诺——动态估计，确定性纯函数）', () => {
  /** 缺口匹配输入工厂（结构面同 PromptWorkingState 缺口子集） */
  function ctx(over: Partial<InfoValueContext> = {}): InfoValueContext {
    return { evidence_gaps: [], open_questions: [], confirmed_facts: [], ...over };
  }

  it('确定性：同 candidate + 同 working_state → 同值（重复调用深相等）', () => {
    const ws = ctx({ evidence_gaps: ['记忆检索'], open_questions: ['系统性能'] });
    const a = estimateInfoValue('记忆检索完成', ws);
    const b = estimateInfoValue('记忆检索完成', ws);
    expect(b).toBe(a);
    expect(Number.isFinite(a)).toBe(true);
  });

  it('gap 命中 > 未命中：候选内容覆盖 evidence_gaps → 高于基础值', () => {
    const base = estimateInfoValue('无关内容', ctx());
    const hit = estimateInfoValue('记忆检索', ctx({ evidence_gaps: ['记忆检索'] }));
    expect(hit).toBeGreaterThan(base);
    // 全命中：基础值 + 全 gap 加成（无 question/conflict 项）
    expect(hit).toBe(INFO_VALUE_BASE + 120);
  });

  it('gap 命中权重 > question 命中权重：同内容分别命中 gap/question → gap 值更高', () => {
    const gapHit = estimateInfoValue('记忆检索', ctx({ evidence_gaps: ['记忆检索'] }));
    const qHit = estimateInfoValue('记忆检索', ctx({ open_questions: ['记忆检索'] }));
    expect(qHit).toBe(INFO_VALUE_BASE + 60); // 全 question 命中：基础值 + 60
    expect(gapHit).toBeGreaterThan(qHit); // gap 权重 120 > question 权重 60
  });

  it('冲突减分：候选内容与 confirmed_facts 重叠 → 低于未冲突（防重复信息）', () => {
    const noConflict = estimateInfoValue('记忆检索', ctx({ evidence_gaps: ['记忆检索'] }));
    const conflicted = estimateInfoValue('记忆检索', ctx({ evidence_gaps: ['记忆检索'], confirmed_facts: ['记忆检索'] }));
    expect(conflicted).toBeLessThan(noConflict);
    // 全冲突：基础值 + gap 120 − conflict 60
    expect(conflicted).toBe(INFO_VALUE_BASE + 120 - 60);
  });

  it('冲突可减至 0：仅 confirmed_facts 全命中（无 gap/question）→ 0（不出现负值）', () => {
    expect(estimateInfoValue('记忆检索', ctx({ confirmed_facts: ['记忆检索'] }))).toBe(0);
  });

  it('空缺口/空问题 → 均匀低基础值（所有候选同值；不臆造高价值）', () => {
    const ws = ctx(); // 全空
    expect(estimateInfoValue('记忆检索', ws)).toBe(INFO_VALUE_BASE);
    expect(estimateInfoValue('系统性能', ws)).toBe(INFO_VALUE_BASE);
    expect(estimateInfoValue('memory.retrieve', ws)).toBe(INFO_VALUE_BASE);
    expect(INFO_VALUE_BASE).toBeLessThan(INFO_VALUE_BASE + 120); // 基础值低于命中值
  });

  it('候选内容空/空白 → 0', () => {
    const ws = ctx({ evidence_gaps: ['记忆检索'] });
    expect(estimateInfoValue('', ws)).toBe(0);
    expect(estimateInfoValue('   ', ws)).toBe(0);
  });

  it('部分重叠按比例：重叠 token 比例越高 → 值越高（连续递增）', () => {
    const ws = ctx({ evidence_gaps: ['记忆检索完成'] });
    const none = estimateInfoValue('无关内容', ws);
    const partial = estimateInfoValue('记忆检索', ws); // bigram 部分重叠
    const full = estimateInfoValue('记忆检索完成', ws);
    expect(partial).toBeGreaterThan(none);
    expect(full).toBeGreaterThan(partial);
  });
});

describe('R7 toCandidateItems：ContextCandidate → renderer CandidateItem（功能视图映射 + ref 透传）', () => {
  it('kind → 功能视图（memory/capability/process→planning；evidence/artifact→evidence）；id/source_ref=ref', () => {
    const cands: ContextCandidate[] = [
      { kind: 'memory', ref: 'm:1', view: 'summary', content: 'a', tokens_est: 2, info_value: 0.8 },
      { kind: 'evidence', ref: 'e:1', view: 'original', content: 'b', tokens_est: 2, info_value: 120 },
      { kind: 'capability', ref: 'c:1', view: 'original', content: 'c', tokens_est: 2, info_value: 100 },
      { kind: 'process', ref: 'p:1', view: 'original', content: 'd', tokens_est: 2, info_value: 200 },
      { kind: 'artifact', ref: 'a:1', view: 'pointer', content: 'e', tokens_est: 2, info_value: 150 },
    ];
    const items = toCandidateItems(cands);
    const byKind = new Map(items.map((i) => [i.kind, i]));
    expect(byKind.get('memory')!.view).toBe('planning');
    expect(byKind.get('capability')!.view).toBe('planning');
    expect(byKind.get('process')!.view).toBe('planning');
    expect(byKind.get('evidence')!.view).toBe('evidence');
    expect(byKind.get('artifact')!.view).toBe('evidence');
    for (const item of items) {
      expect(item.id).toBe(item.source_ref); // ref 透传（artifact 走 original_artifact_ids）
    }
  });
});

describe('R7 compile：新来源 section + 预算截断 + 确定性（renderer 面）', () => {
  function compileInput(cands: ContextCandidate[], budget = 500) {
    return {
      task_contract: { goal: 'g', success_criteria: ['s'] },
      candidates: toCandidateItems(cands),
      budget_tokens: budget,
      policy: policy.context,
    };
  }

  it('evidence/capability/process/artifact 候选 → 对应 section（视图正确）+ A3 schema 通过 + restore_capable', () => {
    const cands: ContextCandidate[] = [
      { kind: 'memory', ref: 'm:1', view: 'summary', content: '记忆内容', tokens_est: 4, info_value: 0.8 },
      { kind: 'evidence', ref: 'e:1', view: 'original', content: 'tool/result: {"tool_id":"t:1"}', tokens_est: 8, info_value: 120 },
      { kind: 'capability', ref: 'c:1', view: 'original', content: '能力：memory.retrieve', tokens_est: 6, info_value: 100 },
      { kind: 'process', ref: 'p:1', view: 'original', content: '认知过程：retrieve-verify', tokens_est: 6, info_value: 200 },
      { kind: 'artifact', ref: 'a:1', view: 'pointer', content: '制品：report', tokens_est: 4, info_value: 150 },
    ];
    const proj = compile(compileInput(cands));
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
    const byRef = new Map(proj.sections.map((s) => [s.source_ref, s]));
    expect(byRef.get('e:1')!.view).toBe('evidence_artifact'); // evidence → evidence 视图
    expect(byRef.get('c:1')!.view).toBe('planning');
    expect(byRef.get('p:1')!.view).toBe('planning');
    expect(byRef.get('a:1')!.view).toBe('evidence_artifact');
    expect(byRef.get('a:1')!.content).toBe('ref:a:1'); // pointer 投影（可 context_restore）
    expect(proj.restore_capable).toBe(true);
    expect(proj.original_artifact_ids).toEqual(['a:1']);
    expect(proj.total_tokens).toBeLessThanOrEqual(500);
  });

  it('预算截断：低预算下高边际先入选、溢出即停止（现有 marginal 贪心语义复用）', () => {
    const cands: ContextCandidate[] = [
      { kind: 'artifact', ref: 'a:1', view: 'pointer', content: 'A', tokens_est: 30, info_value: 150 },
      { kind: 'evidence', ref: 'e:1', view: 'original', content: 'E', tokens_est: 30, info_value: 120 },
      { kind: 'capability', ref: 'c:1', view: 'original', content: 'C', tokens_est: 30, info_value: 100 },
    ];
    const proj = compile(compileInput(cands, 40));
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['a:1']); // artifact 边际最高；30+30>40 → 溢出停止
    expect(proj.total_tokens).toBe(30);
  });

  it('确定性：同输入（含新来源候选）两次 compile → JSON 深相等', () => {
    const cands: ContextCandidate[] = [
      { kind: 'evidence', ref: 'e:1', view: 'original', content: 'E', tokens_est: 8, info_value: 120 },
      { kind: 'capability', ref: 'c:1', view: 'original', content: 'C', tokens_est: 6, info_value: 100 },
      { kind: 'process', ref: 'p:1', view: 'original', content: 'P', tokens_est: 6, info_value: 200 },
      { kind: 'artifact', ref: 'a:1', view: 'pointer', content: 'A', tokens_est: 4, info_value: 150 },
    ];
    const input = compileInput(cands);
    const a = compile(input);
    const b = compile(input);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('空候选来源 → 无新增 section（仅 memory + ws → 无 evidence/capability/process/artifact section）', () => {
    const proj = compile(
      compileInput([{ kind: 'memory', ref: 'm:1', view: 'summary', content: 'mem', tokens_est: 2, info_value: 0.8 }]),
    );
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).not.toContain('e:1');
    expect(refs).not.toContain('c:1');
    expect(refs).not.toContain('p:1');
    expect(refs).not.toContain('a:1');
  });
});

describe('R7 buildContextProjection 集成（sources 注入 + 缺省兼容）', () => {
  it('sources 注入（fake 事件库/注册表/过程）→ 投影含 evidence/capability/process section；预算内；A3 合规', async () => {
    const proj = await buildContextProjection(
      policy,
      { goal: 'g', success_criteria: ['s'] },
      ws,
      [memoryItem('mem:1', '记忆内容', 0.8)],
      processInput(),
      {
        eventStore: fakeEventStore([fakeEvent('tool/result', { tool_id: 't:1', name: 'read' })]),
        capabilities: fakeCapabilities([{ id: 'cap:1', name: 'memory.retrieve', authority_scope: 'kernel' }]),
        session_id: 'sess-r7',
      },
    );
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).toContain('process:retrieve-verify'); // process 统一并入候选流
    expect(refs.some((r) => r.startsWith('event:'))).toBe(true); // evidence section
    expect(refs).toContain('cap:1'); // capability section
    expect(proj.total_tokens).toBeLessThanOrEqual(500);
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });

  it('sources 缺省 → 与既有一致：无新增 section；process 走固定 section（旧调用面零感知）', async () => {
    const proj = await buildContextProjection(
      policy,
      { goal: 'g', success_criteria: ['s'] },
      ws,
      [],
      processInput(),
    );
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['working_state', 'process:retrieve-verify']);
    expect(proj.sections.some((s) => s.source_ref.startsWith('event:'))).toBe(false);
  });

  it('空来源（空事件/空注册表）→ 无新增 section（既有测试零感知）', async () => {
    const proj = await buildContextProjection(
      policy,
      { goal: 'g', success_criteria: ['s'] },
      ws,
      [],
      null,
      { eventStore: fakeEventStore([]), capabilities: fakeCapabilities([]), session_id: 'sess-r7' },
    );
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['working_state']);
    expect(proj.sections).toHaveLength(1);
  });
});

describe('R7 生产路径（createCognitiveRuntime：真实事件库/注册表）', () => {
  let base: string;
  let runtimes: CognitiveRuntime[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'omb-r7-'));
    runtimes = [];
  });

  afterEach(async () => {
    for (const rt of runtimes) {
      await rt.close().catch(() => undefined);
    }
    runtimes = [];
    await rm(base, { recursive: true, force: true });
  });

  function track(rt: CognitiveRuntime): CognitiveRuntime {
    runtimes.push(rt);
    return rt;
  }

  function req(sessionId: string): Record<string, unknown> {
    return {
      session_id: sessionId,
      goal: 'retrieve verify',
      success_criteria: ['验证检索闭环'],
      constraints: [],
      working_state: {
        goal: 'retrieve verify',
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
    };
  }

  it('observeEvent(tool/result) 后 prepareTurn → 投影含 evidence section（真实事件库查询）+ capability section（注册表）', async () => {
    const rt = track(createCognitiveRuntime({ root: join(base, '.omb') }));
    await rt.observeEvent(makeRuntimeEvent('tool/result', 'sess-r7', 'rs:test', { tool_id: 't:1', name: 'read' }, ['test']));
    const prepared = await rt.prepareTurn(req('sess-r7') as never);

    const evidence = prepared.projection.sections.find((s) => s.source_ref.startsWith('event:'));
    expect(evidence).toBeDefined();
    expect(evidence!.content).toContain('tool/result');
    expect(evidence!.view).toBe('evidence_artifact');
    // capability 来源 = 组件注册表登记（memory-retrieval 组件 manifest.capabilities）
    expect(prepared.projection.sections.some((s) => s.source_ref.startsWith('capability:component:memory-retrieval'))).toBe(true);
    expect(ContextProjectionSchema.safeParse(prepared.projection).success).toBe(true);
  });

  it('确定性：同会话同请求两次 prepareTurn → 同 projection.id（含新来源候选）', async () => {
    const rt = track(createCognitiveRuntime({ root: join(base, '.omb') }));
    await rt.observeEvent(makeRuntimeEvent('tool/result', 'sess-r7', 'rs:test', { tool_id: 't:1' }, ['test']));
    const a = await rt.prepareTurn(req('sess-r7') as never);
    const b = await rt.prepareTurn(req('sess-r7') as never);
    expect(b.projection.id).toBe(a.projection.id);
    expect(b.projection.sections).toEqual(a.projection.sections);
  });
});
