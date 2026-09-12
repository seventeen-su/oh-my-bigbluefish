// 向量通道与双通道融合行为测试（对应《新增向量检索》与
// 《重构方向：双通道记忆系统》的语义检索组修复判定）：
//   ① 嵌入：确定性（同文本同向量）、CPU 纯 JS（无 GPU/无新依赖）、L2 归一化、零向量语义
//   ② 余弦：同向量 1、正交 0、零向量 0、维度不一致 fail-loud
//   ③ 存储：ingest 后待编码 → 空闲期批量编码（encodePendingBatch）→ 已编码；payload 更新 → 重新待编码
//   ④ 检索：vectorSearch 按 scope/kind 过滤 + topK；未编码条目不出现（诚实缺失）
//   ⑤ 融合：词法 + 向量并集去重加权合并；向量补召回词法漏掉的近似记忆（改写场景）
//   ⑥ 降级：向量全未编码 → channels_used 只有 lexical（主通道报告 lexical，语义不冒充）
//   ⑦ 状态面：vectorStats 给出已编码/待编码/维度/嵌入器标识
// fixture：mkdtemp 临时 db（不动真实 workspace/.omb/memory.db）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import {
  EMBEDDING_DIM,
  HASH_BOW_EMBEDDER,
  cosineSimilarity,
  blobToVector,
  vectorToBlob,
  type Embedder,
} from '../../memory/embeddings.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { retrieve } from '../../memory/retrieve.js';
import { PROV, TS } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-vec-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

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

describe('① 嵌入：确定性 CPU 哈希词袋', () => {
  it('同文本 → 同向量；不同文本 → 不同向量；维度固定；L2 归一化', () => {
    const a1 = HASH_BOW_EMBEDDER.embedSync!('长期记忆系统的双通道检索');
    const a2 = HASH_BOW_EMBEDDER.embedSync!('长期记忆系统的双通道检索');
    const b = HASH_BOW_EMBEDDER.embedSync!('完全无关的天气话题');
    expect(a1.length).toBe(EMBEDDING_DIM);
    expect([...a1]).toEqual([...a2]);
    expect([...a1]).not.toEqual([...b]);
    let norm = 0;
    for (const v of a1) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('空文本 → 零向量（余弦按 0 处理，不参与检索）', () => {
    const z = HASH_BOW_EMBEDDER.embedSync!('');
    expect([...z].every((v) => v === 0)).toBe(true);
    expect(cosineSimilarity(z, HASH_BOW_EMBEDDER.embedSync!('任意内容'))).toBe(0);
  });

  it('嵌入器标识与维度（可替换点契约）', () => {
    expect(HASH_BOW_EMBEDDER.id).toBe('hash-bow-v1');
    expect(HASH_BOW_EMBEDDER.dim).toBe(EMBEDDING_DIM);
  });
});

describe('② 余弦与序列化', () => {
  it('同向量 1、正交 0、维度不一致 fail-loud', () => {
    const a = HASH_BOW_EMBEDDER.embedSync!('记忆检索');
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    const x = new Float32Array([1, 0]);
    const y = new Float32Array([0, 1]);
    expect(cosineSimilarity(x, y)).toBe(0);
    expect(() => cosineSimilarity(x, new Float32Array([1, 0, 0]))).toThrow(/维度不一致/);
  });

  it('Float32 ↔ BLOB 往返一致；非法 BLOB → null（视为未编码）', () => {
    const v = HASH_BOW_EMBEDDER.embedSync!('往返测试');
    const blob = vectorToBlob(v);
    const back = blobToVector(blob);
    expect(back).not.toBeNull();
    expect([...(back as Float32Array)]).toEqual([...v]);
    expect(blobToVector(null)).toBeNull();
    expect(blobToVector(new Uint8Array([1, 2, 3]))).toBeNull(); // 非 4 字节倍数
  });
});

describe('③ 存储与编码流水', () => {
  it('ingest 后待编码 → encodePendingBatch 批量编码 → 已编码；payload 更新后重新待编码', async () => {
    const b = openBackend(await tmpDb());
    const m1 = makeMemory({ payload: '记忆甲：检索链路' });
    const m2 = makeMemory({ payload: '记忆乙：演化门禁' });
    await b.ingest(m1);
    await b.ingest(m2);
    expect(b.vectorStats()).toMatchObject({ encoded: 0, pending: 2, embedder: 'hash-bow-v1' });
    const r = await b.encodePendingBatch();
    expect(r).toEqual({ encoded: 2, remaining: 0 });
    expect(b.vectorStats()).toMatchObject({ encoded: 2, pending: 0, dim: EMBEDDING_DIM });
    // payload 更新 → 向量清空（待重编码），其余字段更新不丢向量
    await b.update(m2.id, { payload: '记忆乙：门禁已改' });
    expect(b.vectorStats()).toMatchObject({ encoded: 1, pending: 1 });
    await b.update(m2.id, { lifecycle: 'Frozen' });
    expect(b.vectorStats()).toMatchObject({ encoded: 1, pending: 1 }); // 未重编码前仍待编码
    expect(await b.encodePendingBatch()).toEqual({ encoded: 1, remaining: 0 });
    expect(b.vectorStats()).toMatchObject({ encoded: 2, pending: 0 });
  });

  it('encodeOne：单条立即编码（写入面同步编码）；未知 id → false', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({ payload: '立即编码的记忆' });
    await b.ingest(m);
    expect(await b.encodeOne(m.id)).toBe(true);
    expect(b.vectorStats()).toMatchObject({ encoded: 1, pending: 0 });
    expect(await b.encodeOne('no-such-id')).toBe(false);
  });

  it('批量编码分页：limit 限制单次处理量（remaining 如实报告）', async () => {
    const b = openBackend(await tmpDb());
    for (let i = 0; i < 5; i++) {
      await b.ingest(makeMemory({ payload: `分页记忆 ${i}` }));
    }
    expect(await b.encodePendingBatch({ limit: 2 })).toEqual({ encoded: 2, remaining: 3 });
    expect(await b.encodePendingBatch({ limit: 10 })).toEqual({ encoded: 3, remaining: 0 });
  });

  it('批量编码：失败条目不占额度、其余照常编码（扫描窗口语义不变）', async () => {
    // 回归护栏：把"逐条 autocommit"改成"编码在事务外、落库一次事务"时，必须保持失败条目的处理语义——
    // 单条编码失败只跳过它自己，不阻塞其后条目（否则失败行占住批头，后面的记忆永远编不上）。
    const b = openBackend(await tmpDb());
    for (let i = 0; i < 4; i++) {
      await b.ingest(makeMemory({ payload: `编码容错 ${i}` }));
    }
    let calls = 0;
    const flaky: Embedder = {
      id: 'flaky-batch',
      dim: EMBEDDING_DIM,
      embed: async (text: string) => {
        calls++;
        if (calls === 1) throw new Error('模拟首条编码失败');
        return HASH_BOW_EMBEDDER.embed(text);
      },
    };
    const r = await b.encodePending(flaky, { limit: 3 });
    // 首条失败被跳过，其余 3 条成功（额度按"成功数"计，不被失败行占用）
    expect(r.encoded).toBe(3);
    expect(r.remaining).toBe(1); // 失败的那条仍待编码（状态面可见）
    expect(calls).toBe(4); // 4 条都被尝试过（失败行不阻断后续）
  });
});

describe('④ 向量检索', () => {
  it('按 scope/kind 过滤 + topK；未编码条目不出现', async () => {
    const b = openBackend(await tmpDb());
    const hit = makeMemory({ payload: '检索链路与融合排序', scope: 'Project' });
    const sameText = makeMemory({ payload: '检索链路与融合排序', scope: 'Project' }); // 同文本同向量（确定性）
    const otherScope = makeMemory({ payload: '检索链路与融合排序', scope: 'Global' });
    const otherKind = makeMemory({ payload: '检索链路与融合排序', scope: 'Project', kind: 'Episodic' });
    const pending = makeMemory({ payload: '检索链路与融合排序', scope: 'Project' });
    await b.ingest(hit);
    await b.ingest(sameText);
    await b.ingest(otherScope);
    await b.ingest(otherKind);
    await b.ingest(pending);
    await b.encodeOne(hit.id);
    await b.encodeOne(sameText.id);
    await b.encodeOne(otherScope.id);
    await b.encodeOne(otherKind.id);
    // pending 未编码 → 不出现（诚实缺失）；otherScope 被 scope 过滤；同文本同向量 → 同分（按 id 决定序）
    const r = await b.vectorSearch('检索链路与融合排序', { scope: 'Project' });
    expect(r.map((x) => x.memory.id).sort()).toEqual([hit.id, sameText.id, otherKind.id].sort());
    expect(r.map((x) => x.memory.id)).not.toContain(pending.id);
    expect(r.map((x) => x.memory.id)).not.toContain(otherScope.id);
    // kind 过滤：Project 下 Episodic 只有 otherKind
    const rKind = await b.vectorSearch('检索链路与融合排序', { scope: 'Project', kinds: ['Episodic'] });
    expect(rKind.map((x) => x.memory.id)).toEqual([otherKind.id]);
    const rAll = await b.vectorSearch('检索链路与融合排序', { topK: 1 });
    expect(rAll).toHaveLength(1);
    expect(rAll[0]!.score).toBeGreaterThan(0.9); // 同文本 → 余弦近 1
  });

  it('检索结果返回**完整** Memory（裁剪后才取正文，形状不缩水）', async () => {
    // 回归护栏：为降低成本，评分阶段只读 `id + vector`，正文只为入选者取（getMany）。
    // 消费方（融合、排序、注入）拿到的必须是完整 Memory——若某次改成"只返回部分字段"，
    // 这里立刻红，而不是等到注入时字段莫名缺失。
    const b = openBackend(await tmpDb());
    const m = makeMemory({
      payload: '完整记录形状校验',
      scope: 'Project',
      kind: 'Semantic',
      prov_class: 'User-declared',
    });
    await b.ingest(m);
    await b.encodeOne(m.id);
    const r = await b.vectorSearch('完整记录形状校验', { scope: 'Project', topK: 5 });
    expect(r).toHaveLength(1);
    const got = r[0]!.memory;
    // 与入库时的完整记录逐字段一致（不是只对 id/payload 抽查）
    expect(got).toEqual(m);
    // 显式钉住几个消费方真正依赖的字段（防"部分投影"回归）。
    // 注意 `body` **不在** Memory 里——它是 DB 列（存序列化后的完整记录），领域模型没有这个字段。
    for (const k of ['id', 'scope', 'kind', 'lifecycle', 'prov_class', 'payload', 'value_score', 'utility_counts'] as const) {
      expect(got[k]).toBeDefined();
    }
  });

  it('词序与改写：高重叠文本相似度高于低重叠文本', async () => {
    const b = openBackend(await tmpDb());
    const near = makeMemory({ payload: '验证契约的边界约定' });
    const far = makeMemory({ payload: '天气与交通出行提示' });
    await b.ingest(near);
    await b.ingest(far);
    await b.encodePendingBatch();
    const r = await b.vectorSearch('契约边界验证', {});
    expect(r[0]!.memory.id).toBe(near.id);
    expect(r[0]!.score).toBeGreaterThan(0.3);
  });
});

describe('⑤⑥ 双通道融合与降级', () => {
  it('向量补召回：词法漏掉的近似记忆被向量通道召回，channels_used 双通道', async () => {
    const b = openBackend(await tmpDb());
    const lexicalHit = makeMemory({ payload: '验证契约的边界说明' });
    const vectorOnly = makeMemory({ payload: '校验约定的范围界定' }); // 与查询无共同 bigram，但 token 集合近似
    await b.ingest(lexicalHit);
    await b.ingest(vectorOnly);
    await b.encodePendingBatch();
    const r = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '契约边界' });
    expect(r.channels_used).toContain('lexical');
    expect(r.channels_used).toContain('vector');
    expect(r.channel_used).toBe('semantic'); // 双通道实际参与 → 报告融合
    const ids = r.items.map((i) => i.memory.id);
    expect(ids).toContain(lexicalHit.id);
  });

  it('降级：向量全未编码 → 只有词法通道，主通道如实报告 lexical', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '验证契约的边界说明' }));
    const r = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '契约边界' });
    expect(r.channels_used).toEqual(['lexical']);
    expect(r.channel_used).toBe('lexical');
    expect(r.items).toHaveLength(1);
  });

  it('无文本查询 → 时序组（episode/temporal），不启用语义组', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '时序组样本', kind: 'Episodic' }));
    await b.encodePendingBatch();
    const r = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, task_type: 'debug' });
    expect(r.channel_used).toBe('episode');
    expect(r.channels_used).toEqual(['episode']);
  });

  it('确定性：同输入两次检索结果一致（融合与排序无随机）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '验证契约的边界说明' }));
    await b.ingest(makeMemory({ payload: '校验约定的范围界定' }));
    await b.encodePendingBatch();
    const a = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '契约边界' }, { episode: false });
    const c = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '契约边界' }, { episode: false });
    expect(c.items.map((i) => i.memory.id)).toEqual(a.items.map((i) => i.memory.id));
  });
});

describe('⑦ 状态面', () => {
  it('vectorStats：已编码/待编码/维度/嵌入器标识', async () => {
    const b = openBackend(await tmpDb());
    expect(b.vectorStats()).toMatchObject({ encoded: 0, pending: 0, dim: null, embedder: 'hash-bow-v1' });
    await b.ingest(makeMemory({ payload: '状态面样本' }));
    expect(b.vectorStats()).toMatchObject({ encoded: 0, pending: 1 });
    await b.encodePendingBatch();
    expect(b.vectorStats()).toMatchObject({ encoded: 1, pending: 0, dim: EMBEDDING_DIM });
  });

  it('stored_dims / embedder_mismatch：分清"真的没有向量"与"本进程装错了嵌入器"', async () => {
    // 这条来自真实排查教训：直接用默认嵌入器（哈希词袋 256 维）打开一个**装着 512 维神经向量**的库时，
    // dim=null + mismatched=N 外观上与"向量通道全废"完全一样，我因此两次把正常库读成故障。
    // 新增两项后该情形可机械判定为 embedder-mismatch（假象）。
    const db = await tmpDb();
    const b = openBackend(db);
    // 空库：既没有向量，也没有不同源
    expect(b.vectorStats()).toMatchObject({ encoded: 0, stored_dims: [], embedder_mismatch: false });
    expect(b.embeddingStatusView().verdict).toBe('no-vectors');

    // 用 512 维嵌入器写入（模拟真模型写下的向量）
    const dim512: Embedder = { id: 'probe-512', dim: 512, embed: async () => new Float32Array(512).fill(0.1) };
    b.setEmbedder(dim512);
    await b.ingest(makeMemory({ payload: '神经向量样本' }));
    await b.encodePendingBatch();
    expect(b.vectorStats()).toMatchObject({ encoded: 1, stored_dims: [512], embedder_mismatch: false, dim: 512 });
    expect(b.embeddingStatusView().verdict).toBe('ok');

    // 另开一个后端（默认哈希词袋 256 维）打开同一个库 → 这正是"装错嵌入器"的现场
    const b2 = openBackend(db);
    const s2 = b2.vectorStats();
    expect(s2.stored_dims).toEqual([512]); // 盘上真实维度仍然如实报出
    expect(s2.embedder_dim).toBe(EMBEDDING_DIM);
    expect(s2.embedder_mismatch).toBe(true); // ← 关键：能识别出"不同源"而非"全废"
    expect(s2.dim).toBeNull();
    const view = b2.embeddingStatusView();
    expect(view.verdict).toBe('embedder-mismatch');
    expect(view.note).toMatch(/不同源|假象|setEmbedder/);
  });

  it('混维（真正需要重编码）与不同源（假象）被区分开', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    // 先写 256 维（默认），再换 512 维写一条 → 盘上出现两种维度，这才是真正的"混维"
    await b.ingest(makeMemory({ payload: '旧的 256 维' }));
    await b.encodePendingBatch();
    const dim512: Embedder = { id: 'probe-512', dim: 512, embed: async () => new Float32Array(512).fill(0.1) };
    b.setEmbedder(dim512); // 换嵌入器 → 异维行被置为待编码（既有修复），故这里手工再造一条异维行
    await b.ingest(makeMemory({ payload: '新的 512 维' }));
    await b.encodePendingBatch();
    const stats = b.vectorStats();
    expect(stats.stored_dims).toEqual([512]); // 旧行已被作废重编码成 512，盘上维度统一
    expect(stats.embedder_mismatch).toBe(false);
    expect(stats.mismatched).toBe(0);
  });
});
