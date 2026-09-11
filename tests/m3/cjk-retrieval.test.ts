// 中文检索命中修复行为测试（对应《中文命中率低与空结果记录》修复判定）。
//
// 修复内容（memory/sql.ts ftsMatchExpr）：CJK 双侧分词把查询切成 bigram 后，修复前把多 token
// 原样交给 FTS5 = **隐式 AND** → 要求查询的每条 bigram 同时命中，长中文查询系统性漏检
// （实测「契约边界」0 命中）；修复后 token 之间取 OR（各自短语化），相关度交 bm25 排序。
//
// 覆盖：
//   ① 长中文查询命中（修复前 0 命中）：部分 bigram 命中即可召回
//   ② 排序不退化：命中更多查询 bigram 的记录仍排在前面（bm25）
//   ③ 保留字/语法字符查询不再报语法错（AND/OR/NOT/NEAR、冒号、星号、连字符）
//   ④ 空串/空白 → 空表达式（调用方不应据此执行 MATCH）
//   ⑤ 端到端：retrieve（中文查询）命中 + 空结果可观测（episode 记录候选为空，不伪造命中）
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { tokenizeForFts } from '../../memory/cjk-ngram.js';
import { ftsMatchExpr } from '../../memory/sql.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { retrieve } from '../../memory/retrieve.js';
import { PROV, TS } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-cjk-')), 'memory.db');
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

describe('① ftsMatchExpr 口径：token 之间 OR（各自短语化）', () => {
  it('多 token → 逐 token 引号化后 OR 连接；单 token 等价于短语；空串 → 空表达式', () => {
    expect(ftsMatchExpr('验证 证契 契约')).toBe('"验证" OR "证契" OR "契约"');
    expect(ftsMatchExpr('契约')).toBe('"契约"');
    expect(ftsMatchExpr('project')).toBe('"project"');
    expect(ftsMatchExpr('')).toBe('');
    expect(ftsMatchExpr('   ')).toBe('');
  });

  it('保留字与语法字符一律短语化（不再触发 MATCH 语法错误）', () => {
    for (const raw of ['AND', 'OR', 'NOT', 'NEAR', 'a:b', 'a*b', 'a-b', 'x(y)', 'q"uote', 'a\\b']) {
      const expr = ftsMatchExpr(raw);
      expect(expr.startsWith('"')).toBe(true);
      expect(expr.endsWith('"')).toBe(true);
      expect(expr).not.toMatch(/^[a-z]+$/i);
    }
    expect(ftsMatchExpr('a "b" c')).toBe('"a" OR """b""" OR "c"');
  });
});

describe('② 长中文查询命中（修复前 0 命中）', () => {
  it('查询 bigram 只部分命中 → 仍召回（OR 语义）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '验证契约的边界说明' }));
    // 「契约边界」的 bigram = 契约/约边/边界；记忆中只有「契约」「边界」→ 修复前隐式 AND 0 命中
    const hit = await b.query({ scope: 'Project', limit: 10, budget: 100, text: '契约边界' });
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]!.payload).toContain('边界');
  });

  it('排序不退化：命中更多查询 bigram 的记录排前（bm25）', async () => {
    const b = openBackend(await tmpDb());
    const full = makeMemory({ payload: '验证契约的完整说明' }); // 命中 验证/证契/契约 三个 bigram
    const partial = makeMemory({ payload: '验证流程说明' }); // 只命中 验证
    await b.ingest(full);
    await b.ingest(partial);
    const r = await b.query({ scope: 'Project', limit: 10, budget: 100, text: '验证契约' });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.id).toBe(full.id);
    expect(r.items[1]!.id).toBe(partial.id);
  });

  it('不相关查询仍无命中（OR 不制造假阳性）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '长期记忆系统设计' }));
    const r = await b.query({ scope: 'Project', limit: 10, budget: 100, text: '编译原理' });
    expect(r.items).toEqual([]);
  });
});

describe('③ 端到端 retrieve：中文查询命中 + 空结果可观测', () => {
  it('中文查询命中记忆（lexical 通道），episode 记录注入结果', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory({ payload: '项目验证契约与边界约定' });
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '验证契约' });
    expect(r.channel_used).toBe('lexical');
    expect(r.items.map((i) => i.memory.id)).toContain(m.id);
    expect(r.episode?.injected_ids).toContain(m.id);
  });

  it('空结果可观测：候选与注入皆空并如实记录（不伪造命中）', async () => {
    const b = openBackend(await tmpDb());
    await b.ingest(makeMemory({ payload: '长期记忆系统设计' }));
    const r = await retrieve(b, { scope: 'Project', limit: 5, budget: 100, text: '编译原理' });
    expect(r.items).toEqual([]);
    expect(r.episode).toBeDefined();
    expect(r.episode!.candidate_ids).toEqual([]);
    expect(r.episode!.ranked_ids).toEqual([]);
    expect(r.episode!.injected_ids).toEqual([]);
    expect(r.episode!.outcome).toBeNull(); // 未归因（诚实空缺，不臆造）
  });
});

describe('④ 分词口径锚点（防漂移）', () => {
  it('CJK bigram 双侧分词：查询与索引同口径', () => {
    expect(tokenizeForFts('验证契约')).toBe('验证 证契 契约');
    expect(ftsMatchExpr(tokenizeForFts('验证契约'))).toBe('"验证" OR "证契" OR "契约"');
  });
});
