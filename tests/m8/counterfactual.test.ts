// T8.17 反事实抽样接线测试（memory/utility.ts；架构 §7.4 Utility Feedback / Retrieval Episode——
// 反事实抽样由 Governor 调度：utility 不确定性高 → 构造反事实 episode 对比 → posterior 更新）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 覆盖：
//   ① utilityUncertainty：无证据 → 1（高不确定）；证据饱和 → 0；单调下降
//   ② shouldSampleCounterfactual：阈值触发（纯函数）
//   ③ 完整流程：记录 episode → 抽样（构造反事实 episode 对比）→ posterior 更新
//      （utility_score/权重变化：cf_hit/cf_miss 计数 + derivePosteriorUtilityScore）
//   ④ 触发条件门：证据充分（不确定性低）→ sampled:false，无更新
//   ⑤ derivePosteriorUtilityScore：cf_hit 提升 / cf_miss 降低 / clamp [0,1]
//   ⑥ fail-loud：未知 episode → 抛错；estimator 非法返回 → 抛错
//   ⑦ Governor 调度入口 maybeSampleCounterfactual：门 + 抽样一体（组装方一键调用）
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import {
  derivePosteriorUtilityScore,
  maybeSampleCounterfactual,
  recordEpisode,
  reportEpisodeOutcome,
  sampleCounterfactual,
  shouldSampleCounterfactual,
  utilityUncertainty,
  type CounterfactualSampleResult,
} from '../../memory/utility.js';
import type { Memory } from '../../kernel/schemas/m.js';

// ---- 测试工具 ----

let seq = 0;
function makeMemory(payload: string, over: Partial<Memory> = {}): Memory {
  seq++;
  const ts = '2026-08-21T00:00:00.000Z';
  const id = `mem:cf-${String(seq).padStart(4, '0')}`;
  return {
    ir_version: '2.0',
    id,
    schema: 'omb/M1',
    scope: 'Project',
    kind: 'Semantic',
    lifecycle: 'Active',
    prov_class: 'Observation',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'test',
      event: `test/cf-${seq}`,
      actor: 't8.17',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: ts,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    payload,
    value_score: 0.5,
    utility_counts: {},
    ...over,
  };
}

async function openBackend(dir: string): Promise<RetrievalBackend> {
  return new RetrievalBackend(join(dir, 'memory.db'));
}

/** 确定性 outcomeEstimator：注入集含 id 以 'good' 开头 → hit，否则 miss */
function estimator(episodeId: string, injected: string[]): Promise<'hit' | 'miss'> {
  return Promise.resolve(injected.every((id) => id.startsWith('good')) ? 'hit' : 'miss');
}

/** 构造一次真实 episode：候选/ranked/injected（used=bad 命中失败 → 触发反事实对比） */
async function makeEpisode(b: RetrievalBackend, over: { used?: string[]; alt?: string[] } = {}): Promise<string> {
  const used = over.used ?? ['bad-1'];
  const alt = over.alt ?? ['good-1', 'good-2'];
  const ep = await recordEpisode(b, {
    query: JSON.stringify({ text: '检索测试' }),
    scope: 'Project',
    candidate_ids: [...used, ...alt],
    ranked_ids: [...used, ...alt],
    injected_ids: used,
  });
  return ep.id;
}

// ---- 主测试 ----

describe('① utilityUncertainty（证据 → 不确定性，单调下降）', () => {
  it('无证据 → 1；证据越多 → 越低；饱和 → 0', () => {
    expect(utilityUncertainty({})).toBe(1);
    expect(utilityUncertainty({ hit: 0, miss: 0 })).toBe(1);
    const u1 = utilityUncertainty({ hit: 2, miss: 1 });
    const u2 = utilityUncertainty({ hit: 5, miss: 3 });
    expect(u1).toBeGreaterThan(u2);
    expect(u2).toBeGreaterThan(0);
    expect(utilityUncertainty({ hit: 10, miss: 0 })).toBe(0);
    expect(utilityUncertainty({ hit: 100, miss: 100 })).toBe(0);
  });
});

describe('② shouldSampleCounterfactual（触发条件：不确定性 > 阈值）', () => {
  it('高不确定性（证据少）→ true；低不确定性 → false；边界 → false', () => {
    expect(shouldSampleCounterfactual({}, { threshold: 0.5 })).toBe(true);
    expect(shouldSampleCounterfactual({ hit: 5, miss: 5 }, { threshold: 0.5 })).toBe(false);
    // 边界：不确定性 == 阈值 → 不触发（严格 >）
    const at = utilityUncertainty({ hit: 5, miss: 0 }); // = 0.5
    expect(shouldSampleCounterfactual({ hit: 5, miss: 0 }, { threshold: at })).toBe(false);
  });
});

describe('③ 完整流程：触发 → 抽样（反事实 episode 对比）→ posterior 更新', () => {
  it('used 记忆 miss（实际）+ 反事实 alt 集 hit → cf_miss 记于 used、cf_hit 记于 alt；posterior 分数变化', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cf-flow-'));
    try {
      const b = await openBackend(dir);
      const used = makeMemory('实际注入记忆', { id: 'bad-1' });
      const alt1 = makeMemory('候选甲', { id: 'good-1' });
      const alt2 = makeMemory('候选乙', { id: 'good-2' });
      await b.ingest(used);
      await b.ingest(alt1);
      await b.ingest(alt2);
      const episodeId = await makeEpisode(b, { used: ['bad-1'], alt: ['good-1', 'good-2'] });
      // 真实 episode 先归因（反事实对比需实际 outcome）
      await reportEpisodeOutcome(b, episodeId, 'miss');

      const beforeUsed = derivePosteriorUtilityScore((await b.getById('bad-1'))!.utility_counts);
      const result = await sampleCounterfactual(b, {
        episode_id: episodeId,
        outcome_estimator: estimator,
      });

      expect(result.sampled).toBe(true);
      // 反事实 episode 已记录（可回溯：query 标注 [counterfactual]；injected = 反事实集）
      expect(result.counterfactual_episode_id).toBeTruthy();
      const cfEp = await b.getEpisode(result.counterfactual_episode_id!);
      expect(cfEp).toBeDefined();
      expect(cfEp!.query).toContain('[counterfactual]');
      expect(cfEp!.injected_ids).toEqual(['good-1', 'good-2']);
      expect(cfEp!.outcome).toBe('hit');
      // posterior 更新：used 记 cf_miss（降权），alt 记 cf_hit（提权）
      const usedCounts = (await b.getById('bad-1'))!.utility_counts;
      expect(usedCounts.cf_miss).toBe(1);
      const altCounts = (await b.getById('good-1'))!.utility_counts;
      expect(altCounts.cf_hit).toBe(1);
      // utility_score 变化（posterior 权重影响）
      const afterUsed = derivePosteriorUtilityScore(usedCounts);
      expect(afterUsed).toBeLessThan(beforeUsed);
      expect(result.updates.length).toBeGreaterThan(0);
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('④ 触发条件门：证据充分 → 不抽样、无更新', () => {
  it('used 记忆证据饱和（不确定性低）→ sampled:false，无反事实 episode、无计数变化', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cf-gate-'));
    try {
      const b = await openBackend(dir);
      const used = makeMemory('证据充分记忆', { id: 'bad-1', utility_counts: { hit: 20, miss: 20 } });
      await b.ingest(used);
      const episodeId = await makeEpisode(b);
      await reportEpisodeOutcome(b, episodeId, 'miss');
      const result = await sampleCounterfactual(b, {
        episode_id: episodeId,
        outcome_estimator: estimator,
      });
      expect(result.sampled).toBe(false);
      expect(result.counterfactual_episode_id).toBeNull();
      const counts = (await b.getById('bad-1'))!.utility_counts;
      expect(counts.cf_miss).toBeUndefined();
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('⑤ derivePosteriorUtilityScore（cf_hit 提升 / cf_miss 降低 / clamp）', () => {
  it('基础分 + cf 调整：cf_hit 升、cf_miss 降、越界 clamp [0,1]', () => {
    const base = { hit: 5 }; // 基础 0.25
    expect(derivePosteriorUtilityScore(base)).toBeCloseTo(0.25, 4);
    expect(derivePosteriorUtilityScore({ ...base, cf_hit: 10 })).toBeGreaterThan(derivePosteriorUtilityScore(base));
    expect(derivePosteriorUtilityScore({ ...base, cf_miss: 10 })).toBeLessThan(derivePosteriorUtilityScore(base));
    expect(derivePosteriorUtilityScore({ cf_hit: 10000 })).toBe(1);
    expect(derivePosteriorUtilityScore({ cf_miss: 10000 })).toBe(0);
  });
});

describe('⑥ fail-loud', () => {
  it('未知 episode → 抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cf-unknown-'));
    try {
      const b = await openBackend(dir);
      await expect(
        sampleCounterfactual(b, { episode_id: 'episode:ghost', outcome_estimator: estimator }),
      ).rejects.toThrow(/不存在|episode/);
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('⑦ Governor 调度入口 maybeSampleCounterfactual（门 + 抽样一体）', () => {
  it('未触发 → sampled:false；触发 → 完成抽样（组合入口）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-cf-maybe-'));
    try {
      const b = await openBackend(dir);
      // 未触发：证据充分
      const sat = makeMemory('饱和', { id: 'bad-s', utility_counts: { hit: 30 } });
      await b.ingest(sat);
      const epSat = await makeEpisode(b, { used: ['bad-s'] });
      await reportEpisodeOutcome(b, epSat, 'miss');
      const no = await maybeSampleCounterfactual(b, {
        episode_id: epSat,
        outcome_estimator: estimator,
        threshold: 0.5,
      });
      expect(no.sampled).toBe(false);
      // 触发：无证据（备选集须已落库——反事实对比对象）
      const fresh = makeMemory('新记忆', { id: 'bad-f' });
      const alt1 = makeMemory('备选甲', { id: 'good-1' });
      const alt2 = makeMemory('备选乙', { id: 'good-2' });
      await b.ingest(fresh);
      await b.ingest(alt1);
      await b.ingest(alt2);
      const epFresh = await makeEpisode(b, { used: ['bad-f'] });
      await reportEpisodeOutcome(b, epFresh, 'miss');
      const yes = await maybeSampleCounterfactual(b, {
        episode_id: epFresh,
        outcome_estimator: estimator,
        threshold: 0.5,
      });
      expect(yes.sampled).toBe(true);
      expect((yes as CounterfactualSampleResult).counterfactual_episode_id).toBeTruthy();
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
