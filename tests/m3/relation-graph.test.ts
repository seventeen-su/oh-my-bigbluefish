// 关系图测试（对应 docs/known-issues.md《关系图为空图》修复判定：关系由词法 + 向量召回共同驱动、
// 补边属性与治理面）：
//   - 边属性：weight / created / source 三列（旧库 ALTER 迁移；新库 DDL 建列）
//   - 建图：planSimilarityEdges 纯函数（词法 Jaccard + 向量余弦合成，确定性、阈值、邻居上限、来源标注）
//   - 落地：applySimilarityEdges 幂等（重复不放大、权重取大者）→ 统计面 edges > 0（图不再为空）
//   - 加权扩展：规则边（权重 1）数值不变；相似边按权重缩放扩展贡献
//   - 治理面：listRelations（方向/权重/来源）、unlinkRelation（单条删除）
//   - 整合链接线：consolidate 的 relation 步同时走规则边与相似度边
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { RelationBackend, asRelationBackend, normalizeWeight } from '../../memory/backend-relation.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { HASH_BOW_EMBEDDER } from '../../memory/embeddings.js';
import {
  applySimilarityEdges,
  jaccard,
  payloadTokenSet,
  planSimilarityEdges,
  relationNeedsBuild,
  relationSource,
  relationStrength,
  SIMILAR_LINK_TYPE,
} from '../../memory/relations.js';
import { listRelations, unlinkRelation } from '../../memory/manage.js';
import { consolidate, createDirectScheduler } from '../../memory/consolidate.js';
import { retrieve } from '../../memory/retrieve.js';

let dir: string;
let backend: RelationBackend;
const opened: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omb-m3-rel-'));
  backend = track(new RelationBackend(join(dir, 'memory.db')));
});

afterEach(async () => {
  for (const b of opened.splice(0)) {
    await b.close();
  }
  await rm(dir, { recursive: true, force: true });
});

function track<T extends { close(): Promise<void> }>(b: T): T {
  opened.push(b);
  return b;
}

const TS = '2026-01-01T00:00:00.000Z';

function memory(id: string, payload: string, kind = 'Semantic', updated = TS): Memory {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = n.toString(16).padStart(8, '0').slice(0, 8);
  return {
    ir_version: '2.0',
    id: `memory:${hex}-0000-4000-8000-000000000000`.slice(0, 45),
    schema: 'omb/M1',
    scope: 'Project',
    kind,
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated,
    prov_class: 'Observation',
    provenance: {
      source: 'test',
      event: `test/${id}`,
      actor: 'test',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: TS,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    payload,
    value_score: 0.5,
    utility_counts: {},
  } as unknown as Memory;
}

describe('① 边属性（weight / created / source）', () => {
  it('link 写入属性；缺省权重 1、来源 rule（既有规则边语义不变）', async () => {
    await backend.link('m:a', 'm:b', 'informs');
    const e = backend.edgeOf('m:a', 'm:b', 'informs');
    expect(e).toMatchObject({ from_id: 'm:a', to_id: 'm:b', type: 'informs', weight: 1, source: 'rule' });
    expect(typeof e?.created).toBe('number');
  });

  it('权重非法 fail-loud；>1 截到 1（权重是比例，不允许放大）', async () => {
    expect(() => normalizeWeight(Number.NaN)).toThrow(/非法权重/);
    expect(() => normalizeWeight(0)).toThrow(/非法权重/);
    expect(normalizeWeight(1.5)).toBe(1);
    await expect(backend.link('m:a', 'm:c', 'related', { weight: 0 })).rejects.toThrow(/非法权重/);
  });

  it('重复 link → fail-loud（既有 UNIQUE 语义保持不变）', async () => {
    await backend.link('m:a', 'm:b', 'related');
    await expect(backend.link('m:a', 'm:b', 'related')).rejects.toThrow(/边写入失败/);
  });

  it('旧库（无属性列）迁移后按权重 1 / 来源 unknown 读出——不伪造建边来源', async () => {
    // 直接构造迁移前形态：删列在 SQLite 不可行，改为写入 NULL 属性行模拟历史数据
    await backend.link('m:x', 'm:y', 'informs');
    await backend.relationEdges({ from: 'm:x' });
    const raw = (backend as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    raw.prepare('UPDATE memory_relation SET weight = NULL, created = NULL, source = NULL WHERE from_id = ?').run('m:x');
    const e = backend.edgeOf('m:x', 'm:y', 'informs');
    expect(e).toMatchObject({ weight: 1, created: null, source: null });
    expect(backend.relationStats().bySource).toEqual({ unknown: 1 });
  });
});

describe('② 建图纯函数（词法 + 向量共同驱动）', () => {
  it('token 集合与 Jaccard：CJK bigram 与 FTS 索引同口径', () => {
    const t = payloadTokenSet('长期记忆系统');
    expect([...t].sort()).toEqual(['忆系', '期记', '记忆', '系统', '长期'].sort());
    expect(jaccard(payloadTokenSet('验证契约边界'), payloadTokenSet('验证契约'))).toBeGreaterThan(0.4);
    expect(jaccard(payloadTokenSet('完全无关的甲'), payloadTokenSet('another thing entirely'))).toBe(0);
  });

  it('合成强度与来源标注：向量缺失 → 仅词法；两路显著 → both；都不显著不算驱动', () => {
    expect(relationStrength(0.6, null)).toBeCloseTo(0.6, 4);
    expect(relationStrength(0.6, 0.8)).toBeCloseTo(0.7, 4);
    expect(relationSource(0.6, null)).toBe('lexical');
    expect(relationSource(0.6, 0.8)).toBe('both');
    expect(relationSource(0.5, 0.1)).toBe('lexical'); // 向量低于显著线 → 只认词法驱动
    expect(relationSource(0.05, 0.7)).toBe('vector');
  });

  it('相似内容建边、无关内容不建边（阈值生效）', () => {
    const a = memory('a', '验证契约的边界说明');
    const b = memory('b', '验证契约的边界与口径');
    const c = memory('c', '完全无关的另一段内容');
    const planned = planSimilarityEdges([a, b, c], new Map());
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ weight: expect.any(Number), source: 'lexical' });
    const ids = [planned[0]!.from_id, planned[0]!.to_id].sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(planned[0]!.weight).toBeGreaterThanOrEqual(0.45);
  });

  it('向量证据参与：有向量时强度被抬高并标注 both；无向量时不虚构向量证据', () => {
    const a = memory('a', 'alpha payload one');
    const b = memory('b', 'alpha payload two');
    const vec = HASH_BOW_EMBEDDER;
    const vectors = new Map([
      [a.id, vec.embed(a.payload)],
      [b.id, vec.embed(b.payload)],
    ]);
    const plan = { threshold: 0.05 } as const;
    const withVec = planSimilarityEdges([a, b], vectors, plan);
    const noVec = planSimilarityEdges([a, b], new Map(), plan);
    expect(withVec[0]?.source).toBe('both'); // 词法与向量两路都显著
    expect(noVec[0]?.source).toBe('lexical');
    // 同一条内容对：有向量证据 → 强度更高（0.5×Jaccard + 0.5×余弦 > 纯 Jaccard）
    expect(withVec[0]!.weight).toBeGreaterThan(noVec[0]!.weight);
  });

  it('每点邻居上限生效且结果确定（同输入两次同输出）', () => {
    const pool = Array.from({ length: 8 }, (_, i) => memory(`n${i}`, `验证契约的边界说明 变体${i}`));
    const first = planSimilarityEdges(pool, new Map(), { maxNeighbors: 2 });
    const second = planSimilarityEdges(pool, new Map(), { maxNeighbors: 2 });
    expect(second).toEqual(first);
    // 每点最多推举 maxNeighbors 条 → 去重后的边数上界为 n × maxNeighbors
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(pool.length * 2);
    // 上限收紧 → 边数不增（单调）
    const tight = planSimilarityEdges(pool, new Map(), { maxNeighbors: 1 });
    expect(tight.length).toBeLessThanOrEqual(first.length);
  });

  it('完全重复内容不建相似边（属 dedup 的职责）', () => {
    const a = memory('a', '同一条内容');
    const b = memory('b', '同一条内容');
    expect(planSimilarityEdges([a, b], new Map())).toEqual([]);
  });
});

describe('③ 落地与统计（图不再为空）', () => {
  it('applySimilarityEdges 建边 → 统计面可见；重复执行幂等不放大权重', async () => {
    const a = memory('a', '验证契约的边界说明');
    const b = memory('b', '验证契约的边界与口径');
    const planned = planSimilarityEdges([a, b], new Map());
    const first = await applySimilarityEdges(backend, planned, 1000);
    expect(first.created).toBe(1);
    expect(backend.edgeCount()).toBe(1);
    const before = backend.edgeOf(planned[0]!.from_id, planned[0]!.to_id, SIMILAR_LINK_TYPE)!;
    const second = await applySimilarityEdges(backend, planned, 2000);
    expect(second.created).toBe(0);
    expect(second.unchanged + second.updated).toBe(1);
    const after = backend.edgeOf(planned[0]!.from_id, planned[0]!.to_id, SIMILAR_LINK_TYPE)!;
    expect(after.weight).toBe(before.weight);
    expect(after.created).toBe(1000); // 时间戳不被重跑覆盖（重跑不改变既有边）
    const stats = backend.relationStats();
    expect(stats).toMatchObject({ edges: 1, maxWeight: before.weight, bySource: { lexical: 1 } });
    expect(stats.meanWeight).toBeCloseTo(before.weight, 4);
  });

  it('upsertRelation 权重取较大者（更强证据不被弱证据覆盖）', async () => {
    await backend.upsertRelation('m:a', 'm:b', 'similar', { weight: 0.5, source: 'lexical' });
    const up = await backend.upsertRelation('m:a', 'm:b', 'similar', { weight: 0.8, source: 'both' });
    expect(up).toMatchObject({ created: false, updated: true, weight: 0.8 });
    expect(backend.edgeOf('m:a', 'm:b', 'similar')).toMatchObject({ weight: 0.8, source: 'both' });
    const weak = await backend.upsertRelation('m:a', 'm:b', 'similar', { weight: 0.2, source: 'lexical' });
    expect(weak).toMatchObject({ created: false, updated: false, weight: 0.8 });
    expect(backend.edgeOf('m:a', 'm:b', 'similar')?.source).toBe('both');
  });

  it('稀疏度判定：图空才建；边数达到 memories/2 后不再建（不空转）', () => {
    expect(relationNeedsBuild(0, 0)).toBe(false);
    expect(relationNeedsBuild(0, 1)).toBe(false);
    expect(relationNeedsBuild(0, 2)).toBe(true);
    expect(relationNeedsBuild(1, 4)).toBe(true); // 1 < 2
    expect(relationNeedsBuild(2, 4)).toBe(false); // 2 ≥ 2
  });

  it('asRelationBackend 结构判定：带边属性能力才放行（纯后端 → null）', () => {
    expect(asRelationBackend(backend)).toBe(backend);
    expect(asRelationBackend({ link: () => undefined })).toBeNull();
  });
});

describe('④ 关系图接线（整合链 relation 步 + 加权扩展）', () => {
  it('consolidate 跑完 → similar 边建立（图非空）；重跑不新增', async () => {
    const b = track(new RetrievalBackend(join(dir, 'consolidate.db')));
    await b.ingest(memory('a', '验证契约的边界说明用于整合测试'));
    await b.ingest(memory('b', '验证契约的边界与口径用于整合测试'));
    await consolidate(b, { scheduler: createDirectScheduler() });
    const edges = b.relationEdges({ type: SIMILAR_LINK_TYPE });
    expect(edges.length).toBeGreaterThan(0);
    const before = edges.length;
    await consolidate(b, { scheduler: createDirectScheduler() });
    expect(b.relationEdges({ type: SIMILAR_LINK_TYPE })).toHaveLength(before);
  });

  it('加权扩展：预算只够一条时，权重高的邻接优先入选（不再一律等权）', async () => {
    const build = async (name: string, ruleWeight: number, weakWeight: number) => {
      const b = track(new RetrievalBackend(join(dir, name)));
      const seed = memory('seed', '种子记忆内容');
      const rule = memory('rule', 'ALPHANOTE');
      const weak = memory('weak', 'BETANOTE');
      await b.ingest(seed);
      await b.ingest(rule);
      await b.ingest(weak);
      await b.link(seed.id, rule.id, 'related', { weight: ruleWeight });
      await b.link(seed.id, weak.id, SIMILAR_LINK_TYPE, { weight: weakWeight, source: 'lexical' });
      const r = await retrieve(b, { scope: 'Project', text: '种子记忆内容', limit: 2, budget: 10000 }, { episode: false });
      return { ids: r.items.map((x) => x.memory.id), seed: seed.id, rule: rule.id, weak: weak.id };
    };
    const heavyRule = await build('w1.db', 1, 0.1);
    expect(heavyRule.ids[0]).toBe(heavyRule.seed);
    expect(heavyRule.ids).toContain(heavyRule.rule);
    expect(heavyRule.ids).not.toContain(heavyRule.weak); // 弱相似边被预算挡下
    // 权重反转 → 入选者随之反转（权重真的在起作用，而非固定取第一条边）
    const heavySimilar = await build('w2.db', 0.05, 1);
    expect(heavySimilar.ids).toContain(heavySimilar.weak);
    expect(heavySimilar.ids).not.toContain(heavySimilar.rule);
  });
});

describe('⑤ 治理面（列举 / 单条删除）', () => {
  it('listRelations：按记忆定位返回出边与入边，并标注方向、权重、来源', async () => {
    await backend.link('m:a', 'm:b', 'informs');
    await backend.link('m:c', 'm:a', 'similar', { weight: 0.7, source: 'both' });
    const r = listRelations(backend, { id: 'm:a', limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    const out = r.items.find((e) => e.to_id === 'm:b')!;
    const inbound = r.items.find((e) => e.from_id === 'm:c')!;
    expect(out.direction).toBe('out');
    expect(inbound).toMatchObject({ direction: 'in', weight: 0.7, source: 'both' });
  });

  it('unlinkRelation：删除成功与"边不存在"如实区分', async () => {
    await backend.link('m:a', 'm:b', 'related');
    expect(unlinkRelation(backend, { from: 'm:a', to: 'm:b', type: 'related' })).toMatchObject({ ok: true, removed: true });
    expect(backend.edgeCount()).toBe(0);
    const again = unlinkRelation(backend, { from: 'm:a', to: 'm:b', type: 'related' });
    expect(again).toMatchObject({ ok: false, removed: false });
    expect(again.degraded).toMatch(/边不存在/);
    expect(unlinkRelation(backend, { from: '', to: 'm:b', type: 'related' }).degraded).toMatch(/均为必填/);
  });
});
