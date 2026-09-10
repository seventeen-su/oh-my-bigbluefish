// T3.4 行为测试：记忆检索路由与效用反馈（架构 §7.3 六阶段读取 / §7.4 Utility Feedback 与统一价值模型）。
// 覆盖：Scope 分层覆盖链（Session 优先、无则降级）、Kind 偏好路由（task_type 偏好表）、
// Channel 选择（lexical FTS / relation 关系遍历 / temporal updated 排序 / episode payload 时间排序）、
// Expansion（结果不足 limit → top-1 关系扩展 depth 1）、Rank（Memory Value 公式排序）、
// Retrieval Episode 记录与 reportEpisodeOutcome 归因、bumpUtility 六计数器 + utility_score 派生、
// 中文检索实测（配合 T3.1 结论：默认分词器整串单 token）。
// fixture：mkdtemp 临时 db（不动真实 workspace/.omb/memory.db，CONVENTIONS §6）。
// Windows 注意：WAL 侧车文件锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { retrieve, type RetrieveQuery } from '../../memory/retrieve.js';
import { bumpUtility, deriveUtilityScore, reportEpisodeOutcome } from '../../memory/utility.js';
import { PROV, TS } from '../m1/ir-samples.js';

const NOW = Date.parse(TS);

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-ret-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

/** 创建 backend 并注册（afterEach 先 close 再删目录——Windows WAL 文件锁） */
function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** M1 Memory 工厂：六计数器默认全 0（§7.4 六计数器）；provenance.event 每次唯一（幂等键）；over 覆盖任意字段 */
function makeMemory(over: Record<string, unknown> = {}): Memory {
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: '默认记忆内容',
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

/** 便捷检索（RetrieveQuery 最小字段） */
function q(over: Partial<RetrieveQuery> = {}): RetrieveQuery {
  return { scope: 'Project', limit: 10, budget: 100, ...over };
}

describe('Scope 分层覆盖链（§7.3 阶段 1：Session 覆盖 Project 覆盖 Global）', () => {
  it('Session/Project/Global 同名记忆 → Session 命中优先（scope_chain 止于首命中）', async () => {
    const b = openBackend(await tmpDb());
    const session = makeMemory({ scope: 'Session', payload: '共享配置说明' });
    const project = makeMemory({ scope: 'Project', payload: '共享配置说明' });
    const global = makeMemory({ scope: 'Global', payload: '共享配置说明' });
    await b.ingest(session);
    await b.ingest(project);
    await b.ingest(global);

    const r = await retrieve(b, q({ scope: 'Session' }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.memory.id).toBe(session.id);
    expect(r.items[0]?.memory.scope).toBe('Session');
    expect(r.scope_chain).toEqual(['Session']);
  });

  it('Session 无 → 降级 Project（覆盖链 [Session, Project]）', async () => {
    const b = openBackend(await tmpDb());
    const project = makeMemory({ scope: 'Project', payload: '共享配置说明' });
    const global = makeMemory({ scope: 'Global', payload: '共享配置说明' });
    await b.ingest(project);
    await b.ingest(global);

    const r = await retrieve(b, q({ scope: 'Session' }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.memory.id).toBe(project.id);
    expect(r.items[0]?.memory.scope).toBe('Project');
    expect(r.scope_chain).toEqual(['Session', 'Project']);
  });

  it('Session/Project 均无 → 降级 Global；全部无 → 空结果（scope_chain 覆盖全链）', async () => {
    const b = openBackend(await tmpDb());
    const global = makeMemory({ scope: 'Global', payload: '全局默认配置' });
    await b.ingest(global);

    const r1 = await retrieve(b, q({ scope: 'Session' }));
    expect(r1.items.map((x) => x.memory.scope)).toEqual(['Global']);
    expect(r1.scope_chain).toEqual(['Session', 'Project', 'Global']);

    const b2 = openBackend(await tmpDb());
    const r2 = await retrieve(b2, q({ scope: 'Session' }));
    expect(r2.items).toHaveLength(0);
    expect(r2.scope_chain).toEqual(['Session', 'Project', 'Global']);
  });
});

describe('Kind 偏好路由（§7.3 阶段 2：task_type → 形态偏好表）', () => {
  it('task_type=debug → Episodic 优先（偏好表生效，非偏好 kind 被过滤）', async () => {
    const b = openBackend(await tmpDb());
    const episodic = makeMemory({ kind: 'Episodic', payload: '调试记录：上次崩溃现场' });
    const semantic = makeMemory({ kind: 'Semantic', payload: '系统架构说明' });
    await b.ingest(episodic);
    await b.ingest(semantic);

    const r = await retrieve(b, q({ task_type: 'debug' }));
    expect(r.items.map((x) => x.memory.kind)).toEqual(['Episodic']);
    expect(r.items[0]?.memory.id).toBe(episodic.id);
  });

  it('task_type=planning → Procedural 优先', async () => {
    const b = openBackend(await tmpDb());
    const procedural = makeMemory({ kind: 'Procedural', payload: '构建流程步骤' });
    const semantic = makeMemory({ kind: 'Semantic', payload: '系统架构说明' });
    await b.ingest(procedural);
    await b.ingest(semantic);

    const r = await retrieve(b, q({ task_type: 'planning' }));
    expect(r.items.map((x) => x.memory.kind)).toEqual(['Procedural']);
  });

  it('task_type=qa → Semantic/Decision 偏好（两者均返回）', async () => {
    const b = openBackend(await tmpDb());
    const semantic = makeMemory({ kind: 'Semantic', payload: '结构关系说明' });
    const decision = makeMemory({ kind: 'Decision', payload: '技术选型结论' });
    const episodic = makeMemory({ kind: 'Episodic', payload: '调试记录' });
    await b.ingest(semantic);
    await b.ingest(decision);
    await b.ingest(episodic);

    const r = await retrieve(b, q({ task_type: 'qa' }));
    const kinds = r.items.map((x) => x.memory.kind).sort();
    expect(kinds).toEqual(['Decision', 'Semantic']);
  });

  it('显式 kind 覆盖 task_type 偏好', async () => {
    const b = openBackend(await tmpDb());
    const semantic = makeMemory({ kind: 'Semantic', payload: '系统架构说明' });
    const episodic = makeMemory({ kind: 'Episodic', payload: '调试记录' });
    await b.ingest(semantic);
    await b.ingest(episodic);

    const r = await retrieve(b, q({ kind: 'Semantic', task_type: 'debug' }));
    expect(r.items.map((x) => x.memory.kind)).toEqual(['Semantic']);
  });
});

describe('Channel 选择（§7.3 阶段 3：Memory Traversal Operator）', () => {
  it('text 查询 → channel_used=lexical（FTS5 命中）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({ payload: 'SQLite 数据库存储引擎' });
    await b.ingest(m);

    const r = await retrieve(b, q({ text: 'SQLite' }));
    expect(r.channel_used).toBe('lexical');
    expect(r.items.map((x) => x.memory.id)).toEqual([m.id]);
  });

  it('relation 查询 → channel_used=relation（按 type 走关系表遍历）', async () => {
    const b = openBackend(await tmpDb());
    const a = makeMemory({ payload: '现象：崩溃' });
    const cause = makeMemory({ payload: '原因：内存泄漏' });
    await b.ingest(a);
    await b.ingest(cause);
    await b.link(a.id, cause.id, 'causal');

    const r = await retrieve(b, q({ relation: 'causal' }));
    expect(r.channel_used).toBe('relation');
    expect(r.items.map((x) => x.memory.id)).toContain(cause.id);
    expect(r.items.map((x) => x.memory.id)).not.toContain(a.id); // 非邻接（无 causal 入边）不入选
  });

  it('无 text/relation → channel_used=temporal（updated 降序）', async () => {
    const b = openBackend(await tmpDb());
    const older = makeMemory({ updated: new Date(NOW).toISOString() });
    const newer = makeMemory({ updated: new Date(NOW + 60_000).toISOString() });
    await b.ingest(older);
    await b.ingest(newer);

    const r = await retrieve(b, q());
    expect(r.channel_used).toBe('temporal');
    expect(r.items.map((x) => x.memory.id)).toEqual([newer.id, older.id]);
  });

  it('episodic 偏好（task_type=debug）且无 text/relation → channel_used=episode（payload 时间字段降序）', async () => {
    const b = openBackend(await tmpDb());
    const older = makeMemory({ kind: 'Episodic', payload: '{"ts": 1000, "note": "较早事件"}' });
    const newer = makeMemory({ kind: 'Episodic', payload: '{"ts": 2000, "note": "较新事件"}' });
    await b.ingest(older);
    await b.ingest(newer);

    const r = await retrieve(b, q({ task_type: 'debug' }));
    expect(r.channel_used).toBe('episode');
    expect(r.items.map((x) => x.memory.id)).toEqual([newer.id, older.id]);
  });
});

describe('Expansion（§7.3 阶段 4：结果不足 limit → top-1 关系扩展 depth 1）', () => {
  it('FTS 仅命中 1 条且 limit 更大 → top-1 的 depth-1 邻接记忆补充结果', async () => {
    const b = openBackend(await tmpDb());
    // 邻接记忆与查询无 bigram 重叠（中文 bigram 重叠会被词法 OR 召回，掩盖"扩展"这条路径本身）
    const seed = makeMemory({ payload: '种子记忆内容' });
    const nb1 = makeMemory({ payload: 'ALPHANOTE' });
    const nb2 = makeMemory({ payload: 'BETANOTE' });
    await b.ingest(seed);
    await b.ingest(nb1);
    await b.ingest(nb2);
    await b.link(seed.id, nb1.id, 'related');
    await b.link(seed.id, nb2.id, 'related');

    const r = await retrieve(b, q({ text: '种子记忆内容', limit: 3 }));
    expect(r.channel_used).toBe('lexical');
    expect(r.items).toHaveLength(3);
    const ids = r.items.map((x) => x.memory.id);
    expect(ids[0]).toBe(seed.id); // 命中项保持最前
    expect(ids).toEqual(expect.arrayContaining([nb1.id, nb2.id]));
  });

  it('扩展受 limit 预算约束（limit 2 → 2 条）', async () => {
    const b = openBackend(await tmpDb());
    const seed = makeMemory({ payload: '种子记忆内容' });
    const nb1 = makeMemory({ payload: 'ALPHANOTE' });
    const nb2 = makeMemory({ payload: 'BETANOTE' });
    await b.ingest(seed);
    await b.ingest(nb1);
    await b.ingest(nb2);
    await b.link(seed.id, nb1.id, 'related');
    await b.link(seed.id, nb2.id, 'related');

    const r = await retrieve(b, q({ text: '种子记忆内容', limit: 2 }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.memory.id).toBe(seed.id);
  });
});

describe('Rank（§7.3 阶段 5：Memory Value 统一价值模型）', () => {
  it('utility 高/低记忆 → 高价值在前（value 排序正确，rank 为序位）', async () => {
    const b = openBackend(await tmpDb());
    const hi = makeMemory({ payload: '高频命中记忆', utility_counts: { retrieval: 10, hit: 8, inject: 5 } });
    const lo = makeMemory({ payload: '低频冷记忆', utility_counts: { retrieval: 1, hit: 0, inject: 0 } });
    await b.ingest(hi);
    await b.ingest(lo);

    const r = await retrieve(b, q());
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.memory.id).toBe(hi.id);
    expect(r.items[1]?.memory.id).toBe(lo.id);
    expect(r.items[0]!.value).toBeGreaterThan(r.items[1]!.value);
    expect(r.items[0]?.rank).toBe(0);
    expect(r.items[1]?.rank).toBe(1);
  });

  it('污染标记（Suspicious lifecycle）扣减 Memory Value', async () => {
    const b = openBackend(await tmpDb());
    const clean = makeMemory({ payload: '可信记忆内容' });
    const suspicious = makeMemory({ payload: '可疑记忆内容', lifecycle: 'Suspicious' });
    await b.ingest(clean);
    await b.ingest(suspicious);

    const r = await retrieve(b, q());
    expect(r.items[0]?.memory.id).toBe(clean.id); // 污染扣减 → 可疑项排后
    expect(r.items[0]!.value).toBeGreaterThan(r.items[1]!.value);
  });
});

describe('Retrieval Episode（§7.4：query/candidate/ranked/injected/outcome 可归因）', () => {
  it('retrieve 默认记录 episode（candidate/ranked/injected ids 结构完整，outcome 占位 null）', async () => {
    const b = openBackend(await tmpDb());
    const older = makeMemory({ payload: '记忆一', updated: new Date(NOW).toISOString() });
    const newer = makeMemory({ payload: '记忆二', updated: new Date(NOW + 60_000).toISOString() });
    await b.ingest(older);
    await b.ingest(newer);

    const r = await retrieve(b, q());
    expect(r.episode).toBeDefined();
    expect(r.episode!.outcome).toBeNull();
    expect(r.episode!.query).toContain('Project');

    const row = await b.getEpisode(r.episode!.id);
    expect(row).toBeDefined();
    expect(row!.candidate_ids).toEqual(expect.arrayContaining([older.id, newer.id]));
    // ranked = 按价值排序后的全部候选；injected = 最终注入（本场景 = ranked 全量）
    expect(row!.ranked_ids).toEqual([newer.id, older.id]); // 同 profile → updated 降序决胜
    expect(row!.injected_ids).toEqual(row!.ranked_ids);
    expect(row!.outcome).toBeNull();
    expect(row!.scope).toBe('Project');
    expect(typeof row!.created).toBe('number');
  });

  it('opts.episode=false → 不记录 episode', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory());
    const r = await retrieve(b, q(), { episode: false });
    expect(r.episode).toBeUndefined();
  });

  it('reportEpisodeOutcome(hit) → outcome 更新 + 六计数器（retrieval/inject/hit）+ memory_stats 同步', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({ payload: '被注入的记忆' });
    await b.ingest(m);
    const r = await retrieve(b, q({ text: '被注入的记忆' }));
    expect(r.episode).toBeDefined();

    await reportEpisodeOutcome(b, r.episode!.id, 'hit');

    const row = await b.getEpisode(r.episode!.id);
    expect(row!.outcome).toBe('hit');

    const mem = (await b.query(q())).items[0]!;
    expect(mem.utility_counts).toMatchObject({ retrieval: 1, inject: 1, hit: 1, miss: 0 });
    const stats = await b.getStats(m.id);
    expect(stats).toMatchObject({ retrievals: 1, hits: 1, misses: 0 });
    expect(stats!.last_retrieved).toBeGreaterThan(0);
  });

  it('reportEpisodeOutcome(miss) → miss 计数', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({ payload: '未被采用的记忆' });
    await b.ingest(m);
    const r = await retrieve(b, q({ text: '未被采用的记忆' }));
    await reportEpisodeOutcome(b, r.episode!.id, 'miss');

    const mem = (await b.query(q())).items[0]!;
    expect(mem.utility_counts).toMatchObject({ retrieval: 1, inject: 1, miss: 1, hit: 0 });
  });

  it('reportEpisodeOutcome 未知 episode → fail-loud', async () => {
    const b = openBackend(await tmpDb());
    await expect(reportEpisodeOutcome(b, 'episode:ghost', 'hit')).rejects.toThrow();
  });
});

describe('Utility 计数（§7.4：六计数器 + utility_score 派生）', () => {
  it('bumpUtility 六计数器各自累加；memory_stats 三个对应列同步', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    await b.ingest(m);

    await bumpUtility(b, m.id, 'retrieval');
    await bumpUtility(b, m.id, 'retrieval');
    await bumpUtility(b, m.id, 'hit');
    await bumpUtility(b, m.id, 'miss');
    await bumpUtility(b, m.id, 'inject');
    await bumpUtility(b, m.id, 'decay');
    await bumpUtility(b, m.id, 'promote');

    const mem = (await b.query(q())).items[0]!;
    expect(mem.utility_counts).toMatchObject({
      retrieval: 2,
      hit: 1,
      miss: 1,
      inject: 1,
      decay: 1,
      promote: 1,
    });
    const stats = await b.getStats(m.id);
    expect(stats).toMatchObject({ retrievals: 2, hits: 1, misses: 1 });
    expect(stats!.last_retrieved).toBeGreaterThan(0);
  });

  it('utility_score 随计数变化（派生公式：加权计数）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    await b.ingest(m);
    const s0 = deriveUtilityScore(m.utility_counts);
    expect(s0).toBe(0);

    await bumpUtility(b, m.id, 'hit');
    const mem = (await b.query(q())).items[0]!;
    const s1 = deriveUtilityScore(mem.utility_counts);
    expect(s1).toBeGreaterThan(s0);

    // 计数越高 → rank 价值越高（utility 分量 0.4）
    await bumpUtility(b, m.id, 'retrieval');
    await bumpUtility(b, m.id, 'retrieval');
    await bumpUtility(b, m.id, 'inject');
    const r = await retrieve(b, q());
    expect(r.items[0]?.memory.id).toBe(m.id);
    expect(r.items[0]!.value).toBeGreaterThan(0.4 * deriveUtilityScore(mem.utility_counts));
  });

  it('bumpUtility 非法 counter → fail-loud', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    await b.ingest(m);
    await expect(bumpUtility(b, m.id, 'bogus' as never)).rejects.toThrow();
  });

  it('bumpUtility 未知 id → fail-loud', async () => {
    const b = openBackend(await tmpDb());
    await expect(bumpUtility(b, 'memory:ghost', 'hit')).rejects.toThrow();
  });
});

describe('中文检索实测（T8.16 中文分词接入后：bigram 双侧分词，子串命中）', () => {
  it('整串中文查询命中（lexical channel；bigram 分词后整串命中）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆系统设计文档' }));
    const r = await retrieve(b, q({ text: '记忆系统设计文档' }));
    expect(r.channel_used).toBe('lexical');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.memory.payload).toBe('记忆系统设计文档');
  });

  it('中文子串命中（T8.16："记忆"命中"记忆系统设计文档"）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆系统设计文档' }));
    for (const kw of ['记忆', '记忆系统', '设计文档']) {
      const r = await retrieve(b, q({ text: kw }));
      expect(r.items, kw).toHaveLength(1);
      expect(r.items[0]?.memory.payload).toBe('记忆系统设计文档');
    }
  });

  it('空格分隔的中文关键词可独立命中（空格产生独立 token）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆 SQLite 设计' }));
    const r = await retrieve(b, q({ text: 'SQLite' }));
    expect(r.items).toHaveLength(1);
  });
});
