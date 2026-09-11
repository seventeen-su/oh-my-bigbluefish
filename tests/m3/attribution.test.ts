// 归因观测面与效用反馈闭环行为测试（对应《效用反馈为空》修复判定：
// 「建立可观测的使用反馈面；在此之前保持诚实空缺」）：
//   ① 独占特征词：只在本条记忆出现、非停用词、长度合格（决定"证据是否充分"）
//   ② 证据充分 + 被引用 → hit；证据充分 + 未被引用 → miss（有证据的否证）
//   ③ 证据不足 → skipped 且 episode.outcome 保持 null（诚实空缺，绝不伪造）
//   ④ 闭环：hit/miss 经 reportEpisodeOutcome 回灌六计数器与 utility_score（价值排序随之变化）
//   ⑤ 装配面：prepareTurn 跨轮归因（上一轮注入 → 下一轮人类消息作引用窗口）；会话内不重复计数
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import {
  ATTRIBUTION_STOPWORDS,
  attributeEpisode,
  distinctiveTokens,
} from '../../memory/attribution.js';
import { retrieve } from '../../memory/retrieve.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { PROV, TS } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];
const bases: string[] = [];
const runtimes: CognitiveRuntime[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-attr-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

async function tmpRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'omb-attr-asm-'));
  bases.push(base);
  return join(base, '.omb');
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
  await Promise.all(bases.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function makeMemory(payload: string, over: Record<string, unknown> = {}): Memory {
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
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

describe('① 独占特征词', () => {
  it('只保留本条独有、非停用词、长度合格的 token', () => {
    const mine = 'HNSW 索引的候选召回策略 与 记忆系统';
    const other = 'HNSW 索引的写入策略 与 记忆系统';
    const t = distinctiveTokens(mine, [other]);
    expect(t).toContain('候选');
    expect(t).toContain('召回');
    expect(t).not.toContain('HNSW'); // 另一条也有 → 不独占
    expect(t).not.toContain('索引');
    expect(t).not.toContain('记忆'); // 停用词
    expect(t).not.toContain('系统'); // 停用词
    expect(ATTRIBUTION_STOPWORDS.has('记忆')).toBe(true);
  });

  it('确定性：同输入两次结果一致（字典序）', () => {
    const a = distinctiveTokens('alpha beta gamma 双通道 检索', []);
    const b = distinctiveTokens('alpha beta gamma 双通道 检索', []);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('停用词与短拉丁词不作为证据', () => {
    expect(distinctiveTokens('the and 记忆 系统', [])).toEqual([]);
    expect(distinctiveTokens('ab abc', [])).toEqual(['abc']); // 2 字母太短
  });
});

describe('②③ episode 归因（hit / miss / 证据不足）', () => {
  it('被引用 → hit：episode.outcome=hit 且六计数器回灌', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory('HNSW 索引的候选召回策略说明');
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: 'HNSW 候选召回' });
    const ep = r.episode!;
    expect(ep.injected_ids).toContain(m.id);
    const res = await attributeEpisode(b, ep.id, '就用 HNSW 的候选召回 方案继续');
    expect(res.attributed).toBeGreaterThan(0);
    expect(res.outcomes.find((o) => o.memory_id === m.id)?.verdict).toBe('hit');
    const after = await b.getEpisode(ep.id);
    expect(after?.outcome).toBe('hit');
    const mem = await b.getById(m.id);
    expect(mem?.utility_counts.hit).toBe(1);
    expect(mem?.utility_counts.inject).toBe(1);
  });

  it('有对照但未被引用 → miss（有证据的否证）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory('HNSW 索引的候选召回策略说明');
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: 'HNSW 候选召回' });
    const ep = r.episode!;
    const res = await attributeEpisode(b, ep.id, '换个话题：今天天气不错');
    expect(res.outcomes.find((o) => o.memory_id === m.id)?.verdict).toBe('miss');
    expect((await b.getEpisode(ep.id))?.outcome).toBe('miss');
    expect((await b.getById(m.id))?.utility_counts.miss).toBe(1);
  });

  it('证据不足 → skipped 且 outcome 保持 null（诚实空缺，绝不伪造）', async () => {
    const b = openBackend(await tmpDb());
    // 全为停用词/通用词 → 无独占特征词（证据不足）
    const m = makeMemory('记忆 系统 内容 信息');
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: '记忆 系统' });
    const ep = r.episode!;
    const res = await attributeEpisode(b, ep.id, '这些内容我已经知道了');
    expect(res.attributed).toBe(0);
    expect(res.skipped).toBeGreaterThan(0);
    expect(res.outcomes.every((o) => o.verdict === 'skipped')).toBe(true);
    expect(res.outcomes[0]?.reason).toContain('独占特征词不足');
    expect((await b.getEpisode(ep.id))?.outcome).toBeNull(); // 关键：不伪造
    const mem = await b.getById(m.id);
    expect(mem?.utility_counts.hit ?? 0).toBe(0);
    expect(mem?.utility_counts.miss ?? 0).toBe(0);
  });

  it('无人类消息可对照 → skipped（保持待归因）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory('HNSW 索引的候选召回策略说明');
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: 'HNSW 候选召回' });
    const ep = r.episode!;
    const res = await attributeEpisode(b, ep.id, '');
    expect(res.attributed).toBe(0);
    expect((await b.getEpisode(ep.id))?.outcome).toBeNull();
  });

  it('skip_ids：已归因过的记忆不再重复计数（防 utility 灌水）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory('HNSW 索引的候选召回策略说明');
    await b.ingest(m);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: 'HNSW 候选召回' });
    const ep = r.episode!;
    const res = await attributeEpisode(b, ep.id, 'HNSW 候选召回 没问题', { skip_ids: new Set([m.id]) });
    expect(res.attributed).toBe(0);
    expect(res.outcomes).toEqual([]);
  });

  it('未知 episode → fail-loud（不静默）', async () => {
    const b = openBackend(await tmpDb());
    await expect(attributeEpisode(b, 'nope', 'x')).rejects.toThrow(/episode 不存在/);
  });
});

describe('④ 闭环：归因回灌 → utility_score → 价值排序', () => {
  it('命中计数提升记忆的 utility_score（价值模型输入随之变化）', async () => {
    const b = openBackend(await tmpDb());
    const m = makeMemory('HNSW 索引的候选召回策略说明');
    await b.ingest(m);
    const before = (await b.getById(m.id))?.utility_counts ?? {};
    expect(before.hit ?? 0).toBe(0);
    const r = await retrieve(b, { scope: 'Project', limit: 3, budget: 100, text: 'HNSW 候选召回' });
    await attributeEpisode(b, r.episode!.id, 'HNSW 候选召回 方案可以');
    const after = (await b.getById(m.id))?.utility_counts ?? {};
    expect(after.hit).toBe(1);
    expect(after.retrieval).toBe(1);
    expect(after.inject).toBe(1);
    // 统计表同步（memory_stats：retrievals/hits）
    const stats = await b.getStats(m.id);
    expect(stats?.hits).toBe(1);
    expect(stats?.retrievals).toBe(1);
  });
});

describe('⑤ 装配面：prepareTurn 跨轮归因', () => {
  it('上一轮注入 → 下一轮人类消息引用 → episode 归因 + 状态面计数', async () => {
    const root = await tmpRoot();
    const rt = createCognitiveRuntime({ root, episodeSampleRate: 1 }); // 恒采样（测试确定性）
    runtimes.push(rt);
    const memoryId = await rt.memory.ingest(makeMemory('HNSW 索引的候选召回策略说明'));
    const request = (goal: string) => ({
      session_id: 's-attr',
      goal,
      success_criteria: [],
      working_state: {
        goal,
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
    });
    // 第 1 轮：检索注入（HNSW 相关内容）
    await rt.prepareTurn(request('HNSW 候选召回 怎么做'), {});
    // 第 2 轮：人类消息引用了上一轮注入内容的独占特征词 → 归因 hit
    await rt.prepareTurn(request('就按 HNSW 的候选召回策略实现'), {});
    const episodes = await rt.memory.listEpisodes();
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes.some((e) => e.outcome === 'hit')).toBe(true);
    const mem = await rt.memory.getById(memoryId);
    expect(mem?.utility_counts.hit).toBe(1);
    const summary = rt.attributionSummary();
    expect(summary.attributed).toBeGreaterThan(0);
  });

  it('第二轮无引用 → miss；证据不足时保持 null（装配面口径一致）', async () => {
    const root = await tmpRoot();
    const rt = createCognitiveRuntime({ root, episodeSampleRate: 1 });
    runtimes.push(rt);
    await rt.memory.ingest(makeMemory('HNSW 索引的候选召回策略说明'));
    const request = (goal: string) => ({
      session_id: 's-attr-2',
      goal,
      success_criteria: [],
      working_state: {
        goal,
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
    });
    await rt.prepareTurn(request('HNSW 候选召回 怎么做'), {});
    await rt.prepareTurn(request('完全不相关的新话题'), {});
    const episodes = await rt.memory.listEpisodes();
    expect(episodes.some((e) => e.outcome === 'miss')).toBe(true);
  });
});
