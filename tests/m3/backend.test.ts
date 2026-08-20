// T3.1 行为测试：记忆后端 SqliteMemoryBackend（SQLite+FTS5，架构 §7.5 / §4.3 A4）。
// 覆盖：ingest+query（四维过滤/payload 往返）、FTS5 可用性实测与 bm25 rank、分页游标
// （(updated,id) 复合游标）、关系遍历（BFS+truncated）、事务包装（回滚/嵌套 fail-loud）、
// 幂等键 event_id（§11.3）、update/delete、health、中文检索实测（默认分词器 unicode61）。
// fixture：mkdtemp 临时 db（不动真实 workspace/.omb/memory.db，CONVENTIONS §6）。
// Windows 注意（T1.3 经验）：WAL 侧车文件在连接未关闭时被锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { SqliteMemoryBackend } from '../../memory/backend.js';
import { PROV, TS } from '../m1/ir-samples.js';

const NOW = Date.parse(TS);

const dbPaths: string[] = [];
const backends: SqliteMemoryBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-mem-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

/** 创建 backend 并注册（afterEach 先 close 再删目录——Windows WAL 文件锁） */
function openBackend(dbPath: string): SqliteMemoryBackend {
  const b = new SqliteMemoryBackend(dbPath);
  backends.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** M1 Memory 工厂：默认合法样例；provenance.event 每次唯一（幂等键语义）；over 覆盖任意字段 */
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
    utility_counts: { read: 0, hit: 0 },
    ...over,
  } as unknown as Memory;
}

describe('ingest + query（§4.3 A4 / 四维过滤）', () => {
  it('四维组合写入 → scope 命中、kind/lifecycle/prov_class 组合过滤命中', async () => {
    const b = openBackend(await tmpDb());
    const m1 = makeMemory({ kind: 'Semantic', lifecycle: 'Active', prov_class: 'Observation' });
    const m2 = makeMemory({ kind: 'Episodic', lifecycle: 'Dormant', prov_class: 'User-declared' });
    const m3 = makeMemory({ kind: 'Semantic', lifecycle: 'Frozen', prov_class: 'Observation', scope: 'Global' });
    await b.ingest(m1);
    await b.ingest(m2);
    await b.ingest(m3);

    const proj = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(proj.items).toHaveLength(2);
    expect(proj.total).toBe(2);

    const sem = await b.query({ scope: 'Project', kind: 'Semantic', limit: 10, budget: 100 });
    expect(sem.items.map((m) => m.id)).toEqual([m1.id]);

    const combo = await b.query({
      scope: 'Project',
      kind: 'Episodic',
      lifecycle: 'Dormant',
      prov_class: 'User-declared',
      limit: 10,
      budget: 100,
    });
    expect(combo.items.map((m) => m.id)).toEqual([m2.id]);

    const none = await b.query({ scope: 'Session', limit: 10, budget: 100 });
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(0);
  });

  it('payload 与完整对象往返一致（query 返回 == ingest 输入）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({
      payload: '{"text":"往返一致性检查","n":42}',
      value_score: 0.8,
      utility_counts: { read: 3, hit: 2, miss: 1 },
      belief_ref: 'belief:1',
      lineage_ref: 'lineage:1',
    });
    await b.ingest(m);
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(m);
  });

  it('非法 Memory（枚举/越界）→ ingest fail-loud，无残留', async () => {
    const b = openBackend(await tmpDb());
    const bad1 = makeMemory({ kind: 'Bogus' });
    const bad2 = makeMemory({ value_score: 99 });
    await expect(b.ingest(bad1)).rejects.toThrow();
    await expect(b.ingest(bad2)).rejects.toThrow();
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(0);
  });
});

describe('FTS5 检索（可用性实测 + bm25 rank）', () => {
  it('FTS5 可用：构造即建 memory_fts 虚拟表；关键词 MATCH 命中（大小写不敏感）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: 'SQLite FTS5 全文检索' }));
    await b.ingest(makeMemory({ payload: 'SQLite 数据库存储引擎' }));
    await b.ingest(makeMemory({ payload: '记忆后端设计文档' }));
    const page = await b.query({ scope: 'Project', text: 'sqlite', limit: 10, budget: 100 });
    expect(page.total).toBe(2);
    expect(page.items.map((m) => m.payload)).toEqual(
      expect.arrayContaining(['SQLite FTS5 全文检索', 'SQLite 数据库存储引擎']),
    );
  });

  it('bm25 rank：关键词出现次数多的文档排前（相关度高在前）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: 'SQLite SQLite SQLite 高频' }));
    await b.ingest(makeMemory({ payload: 'SQLite SQLite 相关度测试文档' }));
    await b.ingest(makeMemory({ payload: 'SQLite 单次出现文档' }));
    const page = await b.query({ scope: 'Project', text: 'SQLite', limit: 10, budget: 100 });
    expect(page.items.map((m) => m.payload)).toEqual([
      'SQLite SQLite SQLite 高频',
      'SQLite SQLite 相关度测试文档',
      'SQLite 单次出现文档',
    ]);
  });

  it('text 含 FTS 保留字/冒号 → 引号化，MATCH 不抛错', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '条件查询测试' }));
    // 裸 AND 在 FTS5 是语法错误；引号化后作为普通 token 查询
    const r1 = await b.query({ scope: 'Project', text: 'AND', limit: 10, budget: 100 });
    expect(r1.items).toHaveLength(0);
    // 冒号是列过滤语法；短语化后作为字面文本
    const r2 = await b.query({ scope: 'Project', text: 'a:b', limit: 10, budget: 100 });
    expect(r2.items).toHaveLength(0);
  });

  it('多 token text → FTS 隐式 AND（空格分隔）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: 'memory backend design' }));
    await b.ingest(makeMemory({ payload: 'sqlite backend' }));
    const both = await b.query({ scope: 'Project', text: 'backend', limit: 10, budget: 100 });
    expect(both.total).toBe(2);
    const and = await b.query({ scope: 'Project', text: 'memory design', limit: 10, budget: 100 });
    expect(and.items.map((m) => m.payload)).toEqual(['memory backend design']);
    const none = await b.query({ scope: 'Project', text: 'memory sqlite', limit: 10, budget: 100 });
    expect(none.total).toBe(0);
  });
});

describe('分页游标（(updated,id) 复合游标）', () => {
  it('30 条 limit 10 → 3 页游标衔接无重无漏；末页无游标；游标耗尽 → 空页', async () => {
    const b = openBackend(await tmpDb());
    const ids: string[] = [];
    let firstMem: Memory | undefined; // i=0：updated 最小，DESC 序末位
    for (let i = 0; i < 30; i++) {
      const m = makeMemory({ updated: new Date(NOW + i * 1000).toISOString() });
      ids.push(m.id);
      if (i === 0) {
        firstMem = m;
      }
      await b.ingest(m);
    }
    // 首页为最新 10 条（updated DESC）
    const first = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(first.items.map((m) => m.id)).toEqual(ids.slice(20).reverse());

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < 3; p++) {
      const page = await b.query({ scope: 'Project', limit: 10, budget: 100 }, { cursor });
      sizes.push(page.items.length);
      seen.push(...page.items.map((m) => m.id));
      cursor = page.cursor;
    }
    expect(sizes).toEqual([10, 10, 10]);
    expect(cursor).toBeUndefined(); // 恰好整除 → 末页无下一页游标（keyset 终止语义）
    expect(new Set(seen).size).toBe(30);
    expect(new Set(seen)).toEqual(new Set(ids));

    // 用末位项（updated 最小）的 (updated,id) 构造游标 → 游标耗尽 → 空页
    const drained = await b.query(
      { scope: 'Project', limit: 10, budget: 100 },
      { cursor: `${Date.parse(firstMem!.updated)}:${firstMem!.id}` },
    );
    expect(drained.items).toHaveLength(0);
    expect(drained.cursor).toBeUndefined();
  });
});

describe('关系遍历（relationTraverse：BFS + truncated）', () => {
  it('A→B→C→D 链 depth 2 → 三节点深度正确 + truncated true；depth 3 → 全链 truncated false', async () => {
    const b = openBackend(await tmpDb());
    const a = makeMemory();
    const nodeB = makeMemory();
    const nodeC = makeMemory();
    const nodeD = makeMemory();
    await b.ingest(a);
    await b.ingest(nodeB);
    await b.ingest(nodeC);
    await b.ingest(nodeD);
    await b.link(a.id, nodeB.id, 'related');
    await b.link(nodeB.id, nodeC.id, 'related');
    await b.link(nodeC.id, nodeD.id, 'related');

    const w2 = await b.relationTraverse(a.id, ['related'], 2);
    expect(w2.seed).toBe(a.id);
    expect(w2.truncated).toBe(true);
    expect(w2.nodes.map((n) => ({ id: n.id, depth: n.depth }))).toEqual([
      { id: a.id, depth: 0 },
      { id: nodeB.id, depth: 1 },
      { id: nodeC.id, depth: 2 },
    ]);
    expect(w2.nodes[2]?.relations).toEqual([{ type: 'related', to_id: nodeD.id }]);

    const w3 = await b.relationTraverse(a.id, ['related'], 3);
    expect(w3.truncated).toBe(false);
    expect(w3.nodes.map((n) => n.id)).toEqual([a.id, nodeB.id, nodeC.id, nodeD.id]);
    expect(w3.nodes[3]?.depth).toBe(3);
  });

  it('depth 0 → 仅 seed，出边未遍历 → truncated true', async () => {
    const b = openBackend(await tmpDb());
    const a = makeMemory();
    const nodeB = makeMemory();
    await b.ingest(a);
    await b.ingest(nodeB);
    await b.link(a.id, nodeB.id, 'related');
    const w = await b.relationTraverse(a.id, ['related'], 0);
    expect(w.nodes).toEqual([{ id: a.id, depth: 0, relations: [{ type: 'related', to_id: nodeB.id }] }]);
    expect(w.truncated).toBe(true);
  });

  it('type 过滤：仅遍历指定类型；types=[] → 全类型', async () => {
    const b = openBackend(await tmpDb());
    const a = makeMemory();
    const nodeY = makeMemory();
    const nodeX = makeMemory();
    await b.ingest(a);
    await b.ingest(nodeY);
    await b.ingest(nodeX);
    await b.link(a.id, nodeY.id, 'related');
    await b.link(a.id, nodeX.id, 'other');

    const w = await b.relationTraverse(a.id, ['related'], 1);
    expect(w.nodes.map((n) => n.id)).toEqual([a.id, nodeY.id]);
    expect(w.nodes[0]?.relations).toEqual([{ type: 'related', to_id: nodeY.id }]);
    expect(w.truncated).toBe(false);

    const all = await b.relationTraverse(a.id, [], 1);
    expect(all.nodes.map((n) => n.id)).toEqual([a.id, nodeY.id, nodeX.id]);
    expect(all.nodes[0]?.relations).toEqual([
      { type: 'related', to_id: nodeY.id },
      { type: 'other', to_id: nodeX.id },
    ]);
  });

  it('未知 seed（无关系）→ 仅 seed 节点，不抛错', async () => {
    const b = openBackend(await tmpDb());
    const w = await b.relationTraverse('ghost', ['related'], 2);
    expect(w).toEqual({ seed: 'ghost', nodes: [{ id: 'ghost', depth: 0, relations: [] }], truncated: false });
  });
});

describe('事务包装（transaction：BEGIN/COMMIT/ROLLBACK）', () => {
  it('成功事务内多次 ingest → 全部写入', async () => {
    const b = openBackend(await tmpDb());
    const m1 = makeMemory();
    const m2 = makeMemory();
    await b.transaction(async () => {
      await b.ingest(m1);
      await b.ingest(m2);
    });
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(2);
  });

  it('事务内抛错 → ROLLBACK 无部分写入（ingest 加入外层事务，FTS 同步一并回滚）', async () => {
    const b = openBackend(await tmpDb());
    const m1 = makeMemory();
    const m2 = makeMemory();
    await expect(
      b.transaction(async () => {
        await b.ingest(m1);
        await b.ingest(m2);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(0);
    expect((await b.query({ scope: 'Project', text: m1.payload, limit: 10, budget: 100 })).total).toBe(0);
  });

  it('嵌套 transaction() → fail-loud 抛错', async () => {
    const b = openBackend(await tmpDb());
    await expect(b.transaction(async () => b.transaction(async () => undefined))).rejects.toThrow(/嵌套/);
  });
});

describe('幂等键（event_id，§11.3 恢复 = 幂等重跑）', () => {
  it('同 memory（同 id 同 event_id）二次 ingest → no-op 返回既有 id，count 不变', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    const id1 = await b.ingest(m);
    const id2 = await b.ingest(m);
    expect(id2).toBe(id1);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(1);
  });

  it('同 event_id 不同 id → no-op 保留首条（UNIQUE 约束生效）', async () => {
    const b = openBackend(await tmpDb());
    const e = makeMutableId('evt');
    const m1 = makeMemory({ provenance: { ...PROV, event: e } });
    const m2 = makeMemory({ provenance: { ...PROV, event: e } });
    const id1 = await b.ingest(m1);
    const id2 = await b.ingest(m2);
    expect(id2).toBe(id1);
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.payload).toBe(m1.payload);
  });

  it('同 id 不同 event_id → 拒绝（主键冲突 fail-loud）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    await b.ingest(m);
    const m2 = makeMemory({ id: m.id, provenance: { ...PROV, event: makeMutableId('evt') } });
    await expect(b.ingest(m2)).rejects.toThrow();
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(1);
  });
});

describe('update / delete', () => {
  it('update 改 lifecycle + payload → 查询命中新值；updated 刷新；FTS 索引同步', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory();
    await b.ingest(m);
    const before = (await b.query({ scope: 'Project', limit: 10, budget: 100 })).items[0]!;
    await b.update(m.id, { lifecycle: 'Frozen', payload: '更新后的内容' });

    const frozen = await b.query({ scope: 'Project', lifecycle: 'Frozen', limit: 10, budget: 100 });
    expect(frozen.items.map((x) => x.id)).toEqual([m.id]);
    expect(frozen.items[0]?.lifecycle).toBe('Frozen');
    expect(frozen.items[0]?.payload).toBe('更新后的内容');
    expect(frozen.items[0]?.updated).not.toBe(before.updated);
    expect((await b.query({ scope: 'Project', lifecycle: 'Active', limit: 10, budget: 100 })).total).toBe(0);

    const oldFts = await b.query({ scope: 'Project', text: m.payload, limit: 10, budget: 100 });
    expect(oldFts.total).toBe(0);
    const newFts = await b.query({ scope: 'Project', text: '更新后的内容', limit: 10, budget: 100 });
    expect(newFts.total).toBe(1);
  });

  it('update 未知 id → fail-loud', async () => {
    const b = openBackend(await tmpDb());
    await expect(b.update('no-such', { lifecycle: 'Frozen' })).rejects.toThrow(/不存在/);
  });

  it('delete 后 query 与 FTS 均不再命中；关联出边级联清除', async () => {
    const b = openBackend(await tmpDb());
    const a = makeMemory({ payload: 'SQLite 待删除' });
    const nodeB = makeMemory();
    await b.ingest(a);
    await b.ingest(nodeB);
    await b.link(a.id, nodeB.id, 'related');

    await b.delete(a.id);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).items.map((x) => x.id)).toEqual([
      nodeB.id,
    ]);
    expect((await b.query({ scope: 'Project', text: 'SQLite', limit: 10, budget: 100 })).total).toBe(0);
    // 出边已级联清除：从 a 出发仅剩 seed 节点本身
    const w = await b.relationTraverse(a.id, ['related'], 1);
    expect(w.nodes).toEqual([{ id: a.id, depth: 0, relations: [] }]);
  });

  it('delete 未知 id → fail-loud', async () => {
    const b = openBackend(await tmpDb());
    await expect(b.delete('no-such')).rejects.toThrow(/不存在/);
  });
});

describe('health', () => {
  it('db 可打开 → ok true + detail', async () => {
    const b = openBackend(await tmpDb());
    const h = await b.health();
    expect(h.ok).toBe(true);
    expect(typeof h.detail).toBe('string');
  });

  it('close 后 → ok false', async () => {
    const b = openBackend(await tmpDb());
    await b.close();
    const h = await b.health();
    expect(h.ok).toBe(false);
  });
});

describe('中文检索实测（默认分词器 unicode61）', () => {
  it('整 token 中文 MATCH 命中', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆系统设计文档' }));
    const page = await b.query({ scope: 'Project', text: '记忆系统设计文档', limit: 10, budget: 100 });
    expect(page.total).toBe(1);
  });

  it('中文子串/前缀不命中——默认分词器按整串单 token、不按字符切分（实测记录，§17 开放项）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆系统设计文档' }));
    for (const kw of ['记忆', '记忆系统', '设计文档']) {
      const page = await b.query({ scope: 'Project', text: kw, limit: 10, budget: 100 });
      expect(page.total).toBe(0);
    }
  });

  it('中英混合无空格串为单一 token：内嵌英文不可单独命中', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆后端采用SQLite进行存储' }));
    const embedded = await b.query({ scope: 'Project', text: 'SQLite', limit: 10, budget: 100 });
    expect(embedded.total).toBe(0);
    const whole = await b.query({
      scope: 'Project',
      text: '记忆后端采用SQLite进行存储',
      limit: 10,
      budget: 100,
    });
    expect(whole.total).toBe(1);
  });

  it('空格分隔的中文关键词可独立命中（空格产生独立 token）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '记忆 SQLite 设计' }));
    const page = await b.query({ scope: 'Project', text: 'SQLite', limit: 10, budget: 100 });
    expect(page.total).toBe(1);
  });
});
