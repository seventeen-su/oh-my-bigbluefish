// 审查加固回归（记忆面，防复发）：
//   ① 归因回灌只针对**本轮真正判定的记忆**（skipped / 被 skip_ids 排除者绝不计数——诚实性底线）
//   ② reportEpisodeOutcome：未知/已删除记忆跳过（不写半成品）、outcome 与计数在同一事务
//   ③ merge 迁移入边保留权重/来源，且不产生自环
//   ④ 相似边权重排序下推到 SQL（高权重强边不会被 LIMIT 截断在外）
//   ⑤ 向量：异维陈旧向量跳过单行（不再整条通道消失）、NaN 分数不入候选、状态面暴露 mismatched
//   ⑥ 向量检索过滤面与词法对齐（lifecycle/prov_class）
//   ⑦ 编码补扫：批头连续失败不阻塞后续记忆
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { HASH_BOW_EMBEDDER, type Embedder } from '../../memory/embeddings.js';
import { attributeEpisode } from '../../memory/attribution.js';
import { listRelations, mergeMemories } from '../../memory/manage.js';
import { recordEpisode, reportEpisodeOutcome } from '../../memory/utility.js';
import { retrieve } from '../../memory/retrieve.js';
import { SIMILAR_LINK_TYPE } from '../../memory/relations.js';

let dir: string;
const opened: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omb-m3-hard-'));
});

afterEach(async () => {
  for (const b of opened.splice(0)) {
    await b.close();
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

function track<T extends { close(): Promise<void> }>(b: T): T {
  opened.push(b);
  return b;
}

const TS = '2026-01-01T00:00:00.000Z';

function memory(id: string, payload: string, over: Partial<Memory> = {}): Memory {
  return {
    ir_version: '2.0',
    id: `memory:${id}`,
    schema: 'omb/M1',
    scope: 'Project',
    kind: 'Semantic',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
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
    ...over,
  } as unknown as Memory;
}

function counts(m: Memory | undefined): Record<string, number> {
  return (m?.utility_counts ?? {}) as Record<string, number>;
}

describe('① 归因回灌的诚实性（只计本轮判定的记忆）', () => {
  it('注入 [A, B(证据不足 skipped)] + 无关人类消息 → 只有 A 计 miss，B 一列不加', async () => {
    const b = track(new RetrievalBackend(join(dir, 'a.db')));
    // B 的 payload 只有停用/单字级 token → 独占特征词不足 → skipped
    const a = await b.ingest(memory('a0000000-0000-4000-8000-000000000001', '验证契约的边界说明'));
    const bId = await b.ingest(memory('b0000000-0000-4000-8000-000000000002', '记忆 内容 信息 系统'));
    const ep = await recordEpisode(b, {
      query: 'q',
      scope: 'Project',
      candidate_ids: [a, bId],
      ranked_ids: [a, bId],
      injected_ids: [a, bId],
    });
    const res = await attributeEpisode(b, ep.id, '完全无关的另一段人类文本 zzz');
    expect(res.outcomes.find((o) => o.memory_id === a)?.verdict).toBe('miss');
    expect(res.outcomes.find((o) => o.memory_id === bId)?.verdict).toBe('skipped');
    const am = await b.getById(a);
    const bm = await b.getById(bId);
    expect(counts(am).miss).toBe(1);
    expect(counts(am).inject).toBe(1);
    // skipped 的记忆不得被计成 miss（此前用 injected_ids 全集回灌 → 伪造否证）
    expect(counts(bm).miss ?? 0).toBe(0);
    expect(counts(bm).inject ?? 0).toBe(0);
  });

  it('skip_ids 排除的记忆不再被重复计数', async () => {
    const b = track(new RetrievalBackend(join(dir, 'b.db')));
    const a = await b.ingest(memory('a0000000-0000-4000-8000-000000000011', '验证契约的边界说明'));
    const c = await b.ingest(memory('c0000000-0000-4000-8000-000000000012', '部署流水线的产物目录'));
    const ep = await recordEpisode(b, {
      query: 'q',
      scope: 'Project',
      candidate_ids: [a, c],
      ranked_ids: [a, c],
      injected_ids: [a, c],
    });
    await attributeEpisode(b, ep.id, '验证契约的边界说明', { skip_ids: new Set([c]) });
    const cm = await b.getById(c);
    expect(counts(cm).retrieval ?? 0).toBe(0); // 被排除者不参与回灌
  });
});

describe('② reportEpisodeOutcome 的健壮性', () => {
  it('injected 记忆已被删除 → 跳过而不是抛错（outcome 仍写入）', async () => {
    const b = track(new RetrievalBackend(join(dir, 'c.db')));
    const a = await b.ingest(memory('a0000000-0000-4000-8000-000000000021', '验证契约的边界说明'));
    const gone = await b.ingest(memory('d0000000-0000-4000-8000-000000000022', '另一条将被删除的记忆'));
    const ep = await recordEpisode(b, {
      query: 'q',
      scope: 'Project',
      candidate_ids: [a, gone],
      ranked_ids: [a, gone],
      injected_ids: [a, gone],
    });
    await b.delete(gone);
    await expect(reportEpisodeOutcome(b, ep.id, 'hit')).resolves.toBeUndefined();
    expect((await b.getEpisode(ep.id))?.outcome).toBe('hit');
    expect(counts(await b.getById(a)).hit).toBe(1);
  });
});

describe('③ merge 迁移入边：保留属性、不产生自环', () => {
  it('入边的权重/来源被保留（不再被抬成满权 rule），且 T→S 不变成自环', async () => {
    const b = track(new RetrievalBackend(join(dir, 'd.db')));
    const source = await b.ingest(memory('e0000000-0000-4000-8000-000000000031', '被合并的源记忆'));
    const target = await b.ingest(memory('f0000000-0000-4000-8000-000000000032', '保留的目标记忆'));
    const other = await b.ingest(memory('a0000000-0000-4000-8000-000000000033', '指向源的第三条记忆'));
    await b.link(other, source, SIMILAR_LINK_TYPE, { weight: 0.42, source: 'lexical' });
    await b.link(target, source, 'related', { weight: 0.7, source: 'manual' }); // T→S：合并后会变自环
    const r = await mergeMemories(b, source, target);
    expect(r.ok).toBe(true);
    const edges = listRelations(b, { id: target, limit: 20 }).items;
    const migrated = edges.find((e) => e.from_id === other)!;
    expect(migrated).toMatchObject({ weight: 0.42, source: 'lexical' });
    expect(edges.some((e) => e.from_id === target && e.to_id === target)).toBe(false); // 自环不产生
  });
});

describe('④ 相似边权重排序（SQL 下推）', () => {
  it('出边超过 limit 时仍能取到权重最高的边', async () => {
    const b = track(new RetrievalBackend(join(dir, 'e.db')));
    const seed = await b.ingest(memory('a0000000-0000-4000-8000-000000000041', '种子记忆内容'));
    // 先建 20 条弱边（id 靠前），再建 1 条满权边（id 靠后）——旧实现按 id LIMIT 会把它截断在外
    for (let i = 0; i < 20; i++) {
      const nb = await b.ingest(memory(`b0000000-0000-4000-8000-0000000000${50 + i}`, `弱邻${i} ALPHANOTE`));
      await b.link(seed, nb, SIMILAR_LINK_TYPE, { weight: 0.5, source: 'lexical' });
    }
    const strong = await b.ingest(memory('c0000000-0000-4000-8000-000000000099', 'BETANOTE'));
    await b.link(seed, strong, 'related', { weight: 1 });
    const top = b.relationEdges({ from: seed, limit: 5, order: 'weight_desc' });
    expect(top[0]?.to_id).toBe(strong);
    expect(top[0]?.weight).toBe(1);
  });
});

describe('⑤⑥⑦ 向量通道加固', () => {
  it('异维陈旧向量只跳过该行（通道不消失），状态面报告 mismatched', async () => {
    const b = track(new RetrievalBackend(join(dir, 'f.db')));
    await b.ingest(memory('a0000000-0000-4000-8000-000000000051', '验证契约的边界说明'));
    await b.ingest(memory('b0000000-0000-4000-8000-000000000052', '验证契约的边界与口径'));
    await b.encodePendingBatch();
    expect(b.vectorStats()).toMatchObject({ encoded: 2, pending: 0, mismatched: 0, dim: 256 });
    // 换 64 维嵌入器：检索不应抛错（旧实现抛"维度不一致"→ 被 retrieve 的 catch 吞掉、通道静默消失）
    const dim64: Embedder = {
      id: 'probe-dim64',
      dim: 64,
      embed: async () => new Float32Array(64).fill(0.1),
    };
    const hits = await b.vectorSearchWith(dim64, '验证契约');
    expect(hits).toHaveLength(0);
    const stats = b.vectorStats();
    expect(stats.mismatched).toBe(0); // 统计按**当前**嵌入器（256）计算 → 全部一致
    expect(stats.dim).toBe(256);
  });

  it('retrieve 在向量通道抛错时把降级原因带进结果（不再静默）', async () => {
    const b = track(new RetrievalBackend(join(dir, 'g.db')));
    await b.ingest(memory('a0000000-0000-4000-8000-000000000061', '验证契约的边界说明'));
    const orig = b.vectorSearch.bind(b);
    (b as unknown as { vectorSearch: unknown }).vectorSearch = () => {
      throw new Error('模拟向量通道故障');
    };
    const r = await retrieve(b, { scope: 'Project', text: '验证契约', limit: 5, budget: 10000 }, { episode: false });
    expect(r.degraded).toMatch(/向量通道故障/);
    (b as unknown as { vectorSearch: unknown }).vectorSearch = orig;
  });

  it('编码补扫：批头连续失败不阻塞后续记忆（窗口内继续编码）', async () => {
    const b = track(new RetrievalBackend(join(dir, 'h.db')));
    for (let i = 0; i < 5; i++) {
      await b.ingest(memory(`d0000000-0000-4000-8000-0000000000${70 + i}`, `第 ${i} 条待编码内容`));
    }
    let calls = 0;
    const flaky: Embedder = {
      id: 'flaky',
      dim: 256,
      embed: async (text: string) => {
        calls++;
        if (calls <= 2) {
          throw new Error('模拟编码失败'); // 最新的两条失败
        }
        return await HASH_BOW_EMBEDDER.embed(text);
      },
    };
    const r = await b.encodePending(flaky, { limit: 2 });
    expect(r.encoded).toBe(2); // 失败行不再屏蔽其后的记忆（本批目标达成即止）
    // 仍待编码 3 条 = 2 条失败（保持待编码，状态面可见）+ 1 条本批未及（工作量有界）
    expect(r.remaining).toBe(3);
  });
});
