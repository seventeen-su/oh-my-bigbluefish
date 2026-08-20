// M3 出口整体连通测试：记忆闭环（Event → stage → admit → consolidate → retrieve → 效用反馈）。
// 用户强化指示（CONVENTIONS §5.1）：每里程碑出口必须有整体连通测试——把 M3 全产物
// （T3.1 backend / T3.2 staging / T3.3 consolidate / T3.4 retrieve+utility）串成端到端闭环，
// 并连通 M1 链（EventStore 追加写 + M1 已注册事件类型）；真实模块 + 真实 SQLite，禁 mock。
// 覆盖：① 写入链 ② staging→admission ③ consolidation（dedup Frozen + relation 建立）
//       ④ retrieve 闭环（task_type 路由 + text 查询 → channel/命中/Rank）
//       ⑤ 效用反馈（reportEpisodeOutcome → stats + utility_score 变化）
//       ⑥ 幂等/确定性（事件流重放无副作用；retrieve 两次一致）
//       ⑦ schema 合规抽查（admitted 过 MemorySchema；episode 行结构完整）。
// fixture：mkdtemp 临时目录（events.db / memory.db 分开——EventStore 与记忆后端各自独立 db，
// 同生产布局 workspace/.omb/memory.db）；consolidate 注入 now=TS 防 decay 误触发。
// 幂等键 = event.provenance.event（§11.3 / T3.2 契约）：stage/admit/backend.ingest 同键。
// Windows 注意（T1.3 经验）：WAL 侧车文件锁 → afterAll 先 close 再 rm。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemorySchema,
  type Event,
  type Memory,
  type MemoryKind,
  type MemoryProvClass,
} from '../../kernel/schemas/m.js';
import { makeMutableId, type Scope } from '../../kernel/schemas/base.js';
import { EventStore } from '../../supervisor/event-store.js';
import { EVENTS_HANDLED } from '../../supervisor/state-reducer.js';
import { StagingManager } from '../../memory/staging.js';
import { consolidate } from '../../memory/consolidate.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { retrieve, type RetrieveQuery } from '../../memory/retrieve.js';
import { deriveUtilityScore, reportEpisodeOutcome } from '../../memory/utility.js';
import { PROV, TS } from '../m1/ir-samples.js';

const NOW = Date.parse(TS);
const DAY = 24 * 60 * 60 * 1000;
const SESSION_ID = 'sess-m3-loop';

// ---- 共享 fixture（describe 内顺序执行，闭环状态跨 it 传递） ----

let dir: string;
let store: EventStore;
let staging: StagingManager;
let backend: RetrievalBackend;
/** 原始事件序列（append 前构造；provenance.event 即幂等键） */
let events: (Event & { seq: number })[];
/** 两个 memory/admitted 事件（admission 断言用其 provenance.event） */
let mem1Evt: Event;
let mem2Evt: Event;
/** 各记忆 id（consolidation/retrieve/效用断言用） */
let mem1Id = '';
let seedId = '';
let lowId = '';
let dupId = '';
/** retrieve A 的 episode id（效用反馈归因用） */
let epAId = '';

/** M3 Event 工厂：seq 递增、timestamp 递增、单会话链（同款 replay-chain.test.ts fixture 风格）；
 *  provenance.event 每次唯一（幂等键，§11.3） */
function evt(type: string, payload: Record<string, unknown>, seq: number): Event & { seq: number } {
  const t = new Date(NOW + seq * 1000).toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: t,
    updated: t,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    type: type as Event['type'],
    session_id: SESSION_ID,
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: `c:${seq}`,
    payload,
    timestamp: t,
    seq,
  };
}

/** 记忆闭环事件序列：session/start → claim/update ×2 → memory/admitted ×2（payload.memory
 *  合法 Memory 候选，不同内容/scope）→ session/end（全为 M1 已注册类型） */
function loopEvents(): (Event & { seq: number })[] {
  return [
    evt('session/start', { goal: 'M3 记忆闭环整体连通验证' }, 1),
    evt('claim/update', { claim_id: 'c:1', text: '记忆闭环设计完整', epistemic: 'supported', confidence: 0.8 }, 2),
    evt('claim/update', { claim_id: 'c:2', text: '效用反馈驱动排序', epistemic: 'supported', confidence: 0.9 }, 3),
    evt(
      'memory/admitted',
      { memory: { scope: 'Project', kind: 'Episodic', prov_class: 'Observation', payload: 'SQLite记忆存储实测通过' } },
      4,
    ),
    evt(
      'memory/admitted',
      { memory: { scope: 'Global', kind: 'Semantic', prov_class: 'Observation', payload: '闭环测试验证通过' } },
      5,
    ),
    evt('session/end', {}, 6),
  ];
}

/** 预置记忆工厂（直接 backend.ingest；provenance.event 每次唯一；updated 控制 consolidate 判定） */
function seedMemory(over: {
  payload: string;
  updated: string;
  scope?: Scope;
  kind?: MemoryKind;
  prov_class?: MemoryProvClass;
}): Memory {
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: over.scope ?? 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: over.updated,
    updated: over.updated,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: over.kind ?? 'Semantic',
    prov_class: over.prov_class ?? 'Observation',
    payload: over.payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  };
}

/** RetrieveQuery 最小字段工厂（同款 retrieve.test.ts） */
function q(over: Partial<RetrieveQuery> = {}): RetrieveQuery {
  return { scope: 'Project', limit: 10, budget: 100, ...over };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omb-m3loop-'));
  store = new EventStore(join(dir, 'events.db'));
  staging = new StagingManager(join(dir, 'memory.db'));
  backend = new RetrievalBackend(join(dir, 'memory.db'));
  events = loopEvents();
  mem1Evt = events[3]!;
  mem2Evt = events[4]!;
});

afterAll(async () => {
  await store.close();
  await staging.close();
  await backend.close();
  await rm(dir, { recursive: true, force: true });
});

describe('M3 记忆闭环整体连通（Event → stage → admit → consolidate → retrieve → 效用反馈）', () => {
  it('① 写入链：事件序列 append 至 EventStore（M1 已注册类型，seq/timestamp 递增）', async () => {
    for (const t of events.map((e) => e.type)) {
      expect(EVENTS_HANDLED).toContain(t); // M1 注册表契约：链内类型必须已注册
    }
    await store.appendMany(events);
    expect(await store.count()).toBe(6);
    const { events: readBack } = await store.query({});
    expect(readBack.map((e) => e.type)).toEqual(events.map((e) => e.type)); // 存储保真（seq 序）
  });

  it('② staging→admission：EventStore 读事件 → stage 全部 → admit → 2 条记忆入 memory 表', async () => {
    const { events: readBack } = await store.query({});
    for (const e of readBack) {
      const r = await staging.stage(e);
      expect(r.admitted).toBe(true); // 6 条全部入 staging（无来源拦截）
    }
    const res = await staging.admit();
    // 仅 2 条 memory/admitted 是合法 Memory 候选 → admitted；其余（无 payload.memory）rejected invalid
    expect(res.admitted.sort()).toEqual([mem1Evt.provenance.event, mem2Evt.provenance.event].sort());
    expect(res.rejected).toHaveLength(4);
    expect(res.rejected.every((r) => r.reason === 'invalid')).toBe(true);

    // memory 表对应记忆落位（经 backend.query 验证）；幂等键 = provenance.event
    const proj = await backend.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(proj.total).toBe(1);
    expect(proj.items[0]?.payload).toBe('SQLite记忆存储实测通过');
    expect(proj.items[0]?.provenance.event).toBe(mem1Evt.provenance.event);
    mem1Id = proj.items[0]!.id;
    const glob = await backend.query({ scope: 'Global', limit: 10, budget: 100 });
    expect(glob.total).toBe(1);
    expect(glob.items[0]?.payload).toBe('闭环测试验证通过');
    expect(glob.items[0]?.provenance.event).toBe(mem2Evt.provenance.event);
  });

  it('③ consolidation：注入 now 防 decay；dedup Frozen + relation 建立', async () => {
    // 预置同 scope 可关联记忆（Decision → Episodic 邻接表 informs）与低价值对照（qa 路由 Rank 对比用）。
    // updated 取 NOW+5000/+6000（晚于 mem1 事件 NOW+4000）→ 保证 qa 路由的 backend.query limit
    // 恰好覆盖两条 Decision 候选（limit 先于 kind 过滤生效）；时间在未来 → decay 不触发。
    const seed = seedMemory({ payload: 'SQLite记忆存储方案', updated: new Date(NOW + 5000).toISOString(), kind: 'Decision' });
    const low = seedMemory({
      payload: '旧工具选型记录',
      updated: new Date(NOW + 6000).toISOString(),
      kind: 'Decision',
      prov_class: 'Model-inferred',
    });
    seedId = seed.id;
    lowId = low.id;
    await backend.ingest(seed);
    await backend.ingest(low);
    // admit 之后预置同 scope+kind 重复内容（updated 更旧）→ consolidate dedup 将其 Frozen
    const dup = seedMemory({ payload: '闭环测试验证通过', updated: new Date(NOW - 30 * DAY).toISOString(), scope: 'Global' });
    dupId = dup.id;
    await backend.ingest(dup);

    const report = await consolidate(backend, { now: NOW }); // now=TS：链内 updated ≥ TS → decay 不触发
    expect(report.decayed).toBe(0);
    expect(report.deduped).toBe(1); // 旧重复项被 Frozen，保留 admit 的 mem2
    expect(report.related).toBe(2); // 两条 Decision → Episodic informs 边
    expect(report.affected_scopes.sort()).toEqual(['Global', 'Project']);

    // dedup 落位：dupId Frozen、mem2 保持 Active
    expect((await backend.getById(dupId))?.lifecycle).toBe('Frozen');
    const glob = await backend.query({ scope: 'Global', limit: 10, budget: 100 });
    expect(glob.items.find((m) => m.payload === '闭环测试验证通过')?.lifecycle).toBe('Active');

    // relation 落位：seedDecision --informs--> mem1（Episodic）
    const walk = await backend.relationTraverse(seedId, ['informs'], 1);
    const toIds = walk.nodes.find((n) => n.id === seedId)?.relations.map((r) => r.to_id) ?? [];
    expect(toIds).toContain(mem1Id);
  });

  it('④ retrieve 闭环：text 查询 → lexical 命中预置记忆；task_type 路由 → kind 偏好 + Rank 按价值', async () => {
    // A：lexical 通道（FTS5 全串 token 精确命中预置的 seedDecision）
    const rA = await retrieve(backend, q({ text: 'SQLite记忆存储方案', limit: 1 }));
    expect(rA.channel_used).toBe('lexical');
    expect(rA.scope_chain).toEqual(['Project']);
    expect(rA.items).toHaveLength(1);
    expect(rA.items[0]?.memory.id).toBe(seedId); // 命中预置记忆
    expect(rA.items[0]?.rank).toBe(0);
    epAId = rA.episode!.id;

    // B：task_type 路由（qa → Semantic/Decision 偏好，Episodic 被过滤）+ Rank 价值降序：
    //     channel 序 = 时间降序 [low, seed]，但价值序 = [seed, low]（Observation > Model-inferred）
    //     ——Rank 覆盖时间序；limit=2 = 偏好候选数 → 无扩展
    const rB = await retrieve(backend, q({ task_type: 'qa', limit: 2 }));
    expect(rB.channel_used).toBe('temporal'); // 无 text/relation、偏好不含 Episodic → temporal
    expect(rB.items.map((x) => x.memory.id)).toEqual([seedId, lowId]);
    expect(rB.items.map((x) => x.memory.kind)).toEqual(['Decision', 'Decision']);
    expect(rB.items.map((x) => x.memory.kind)).not.toContain('Episodic'); // qa 偏好过滤
    expect(rB.items[0]!.value).toBeGreaterThan(rB.items[1]!.value); // Rank 顺序合理
    expect(rB.items[0]?.rank).toBe(0);
    expect(rB.items[1]?.rank).toBe(1);
  });

  it('⑤ 效用反馈：reportEpisodeOutcome(hit) → episode outcome + memory_stats 计数 + utility_score 变化', async () => {
    expect(deriveUtilityScore((await backend.getById(seedId))!.utility_counts)).toBe(0); // 预置六计数器全 0

    await reportEpisodeOutcome(backend, epAId, 'hit');

    expect((await backend.getEpisode(epAId))!.outcome).toBe('hit');
    const after = (await backend.getById(seedId))!;
    expect(after.utility_counts).toMatchObject({ retrieval: 1, inject: 1, hit: 1, miss: 0 });
    expect(deriveUtilityScore(after.utility_counts)).toBeGreaterThan(0); // bump 生效：utility_score 变化
    const stats = await backend.getStats(seedId);
    expect(stats).toMatchObject({ retrievals: 1, hits: 1, misses: 0 });
    expect(stats!.last_retrieved).toBeGreaterThan(0);
  });

  it('⑥ 幂等/确定性：同一事件流重放（重读 → stage → admit）无副作用；retrieve 两次结果一致', async () => {
    // 重放 = 恢复语义（§11.3）：从 EventStore 重读同一事件流再次 stage → admit
    const { events: replayed } = await store.query({});
    for (const e of replayed) {
      const r = await staging.stage(e);
      expect(r.admitted).toBe(true); // admit 已清空 staging → 重 stage 重新入队
    }
    const res = await staging.admit();
    expect(res.admitted).toEqual([]); // 全部 rejected（no-op 收敛）
    expect(res.rejected.filter((r) => r.reason === 'duplicate')).toHaveLength(2); // 内容已存在
    expect(res.rejected.filter((r) => r.reason === 'invalid')).toHaveLength(4); // 无 memory 候选

    // memory 表无新增（2 预置 Project + 2 admitted + 1 预置 Global = 5）
    const proj = await backend.query({ scope: 'Project', limit: 100, budget: 1e9 });
    const glob = await backend.query({ scope: 'Global', limit: 100, budget: 1e9 });
    expect((proj.total ?? 0) + (glob.total ?? 0)).toBe(5);

    // retrieve 确定性：同查询两次 → 全等（episode 关闭避免唯一 id 干扰）
    const run = () => retrieve(backend, q({ text: 'SQLite记忆存储方案', limit: 1 }), { episode: false });
    const a = await run();
    const b = await run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b.items).toEqual(a.items);
    expect(b.channel_used).toBe(a.channel_used);
  });

  it('⑦ schema 合规抽查：admitted 记忆过 MemorySchema；episode 行结构完整', async () => {
    // admitted 记忆（backend.query body 保真重建）过 MemorySchema
    const proj = await backend.query({ scope: 'Project', limit: 10, budget: 100 });
    const mem1 = proj.items.find((m) => m.payload === 'SQLite记忆存储实测通过')!;
    expect(MemorySchema.safeParse(mem1).success).toBe(true);
    expect(mem1.provenance.event).toBe(mem1Evt.provenance.event); // 幂等键保真
    const glob = await backend.query({ scope: 'Global', limit: 10, budget: 100 });
    const mem2 = glob.items.find((m) => m.payload === '闭环测试验证通过')!;
    expect(MemorySchema.safeParse(mem2).success).toBe(true);

    // episode 行结构完整（六字段 + outcome 归因）
    const ep = await backend.getEpisode(epAId);
    expect(ep).toBeDefined();
    expect(typeof ep!.id).toBe('string');
    expect(typeof ep!.query).toBe('string');
    expect(ep!.scope).toBe('Project');
    expect(Array.isArray(ep!.candidate_ids)).toBe(true);
    expect(Array.isArray(ep!.ranked_ids)).toBe(true);
    expect(Array.isArray(ep!.injected_ids)).toBe(true);
    expect(ep!.injected_ids).toEqual([seedId]); // retrieve A limit=1 → 仅注入 seed
    expect(ep!.outcome).toBe('hit'); // ⑤ 已归因
    expect(typeof ep!.created).toBe('number');
  });
});
