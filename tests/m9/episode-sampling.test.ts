// 专项 D（评审问题一）：记忆检索 Episode 采样记录与归因测试。
// 背景（已核实）：runtime/assembly.ts 三处 retrieve 全部 { episode: false }——retrieval_episode 表生产
// 零记录 → signal-collectors 的 L1 scope_hit/scope_miss 完全空转；memory/utility.ts 的
// recordEpisode/reportEpisodeOutcome 机制完备（m3/m8/counterfactual 覆盖）但无生产输入。
// 实施（本文件钉住）：
//   ① shouldSampleEpisode 纯函数：确定性哈希（sha256(session+turn) % 10000 < rate*10000）——同输入恒同
//      判定；rate=0 永不 / rate=1 恒真 / 非法率 fail-loud；
//   ② 采样率 0/0.02/1.0 边界注入：runtime 注入率 → prepareTurn 记录数 = 确定性哈希期望（固定会话 id）；
//      rate=0 → 零记录（既有 episode:false 路径零变化回归）；
//   ③ 高价值提升：working_state.open_questions/evidence_gaps 非空 → 生效采样率提升到 0.10
//      （同会话同 turn token 下，0.02 不采而 0.10 采的会话 → 高价值时记录、非高价值不记录）；
//   ④ kern_memory 恒记录：显式记忆工具不受采样率限制（rate=0 也记录）；
//   ⑤ finalizeTurn 归因代理：本会话已记录 episode → 无诚实可观测 hit/miss 信号 → 保持 null 不伪造
//      （attributed/pending 审计计数；已归因的计入 attributed）；
//   ⑥ signal-collectors 扩展：null-outcome「已记录待归因」→ L1 scope_recorded 单独一类（不稀释
//      scope_hit/scope_miss 比率）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCognitiveRuntime, EPISODE_SAMPLE_RATE_DEFAULT, EPISODE_SAMPLE_RATE_HIGH_VALUE, type CognitiveRuntime } from '../../runtime/assembly.js';
import { shouldSampleEpisode } from '../../runtime/turn-helpers.js';
import { collectGeneralizationSignals } from '../../runtime/signal-collectors.js';
import { evaluate, getFact } from '../../runtime/evolution-evaluator.js';
import { recordEpisode, reportEpisodeOutcome } from '../../memory/utility.js';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

/** 确定性采样判定期望（与运行时同口径——固定会话 + turn token 序） */
function expectedSampleCount(sessionId: string, turnCount: number, rate: number): number {
  let n = 0;
  for (let t = 1; t <= turnCount; t++) {
    if (shouldSampleEpisode(sessionId, String(t), rate)) {
      n++;
    }
  }
  return n;
}

/** 最小 CognitiveRequest（working_state 缺省无 open_questions/evidence_gaps → 非高价值路径） */
function req(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    goal: '记忆检索采样测试目标',
    success_criteria: ['可测'],
    constraints: [],
    working_state: {
      goal: '记忆检索采样测试目标',
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: 'test',
    },
    ...over,
  };
}

/** 最小 GovernorDecision（finalizeTurn 输入；形状对齐 m9/artifact-index 生产路径） */
const decision = {
  decision: 'Verify',
  reason: 'episode sampling test',
  budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
  expected_gain: 0.5,
  snapshot: 'rs:test',
} as never;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-m9-epi-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

describe('① shouldSampleEpisode 纯函数（确定性哈希采样）', () => {
  it('rate=0 → 永不采样；rate=1 → 恒采样（多会话多 token 组合）', () => {
    for (let i = 0; i < 50; i++) {
      const sid = `zero-${i}`;
      for (let t = 1; t <= 5; t++) {
        expect(shouldSampleEpisode(sid, String(t), 0)).toBe(false);
        expect(shouldSampleEpisode(sid, String(t), 1)).toBe(true);
      }
    }
  });

  it('rate=0.02 → 确定性（同输入两次同判定）且非恒真/非恒假', () => {
    const samples: boolean[] = [];
    for (let i = 0; i < 400; i++) {
      const sid = `det-${i}`;
      const a = shouldSampleEpisode(sid, '1', 0.02);
      const b = shouldSampleEpisode(sid, '1', 0.02);
      expect(a).toBe(b); // 确定性
      samples.push(a);
    }
    expect(samples.some((s) => s)).toBe(true); // 非恒假（2% 注入率下 400 样本必含命中）
    expect(samples.some((s) => !s)).toBe(true); // 非恒真
  });

  it('非法采样率 → fail-loud（负数/超 1/NaN/Infinity）', () => {
    for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => shouldSampleEpisode('s', '1', bad)).toThrow();
    }
  });

  it('不同 turn token → 判定可不同（会话内逐 turn 独立采样）', () => {
    // 至少存在某会话 turn1/turn2 判定不同（确定性下可穷举验证非全同——采样为逐 turn 独立事件）
    const seen = new Set<boolean>();
    for (let i = 0; i < 300 && seen.size < 2; i++) {
      const sid = `turn-${i}`;
      seen.add(shouldSampleEpisode(sid, '1', 0.02));
      seen.add(shouldSampleEpisode(sid, '2', 0.02));
    }
    expect(seen.size).toBe(2);
  });
});

describe('② 采样率边界注入（prepareTurn → retrieval_episode 记录数 = 确定性期望）', () => {
  it('rate=0 → prepareTurn 零记录（既有 episode:false 路径零变化回归）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 0 }));
    await runtime.prepareTurn(req('sess-zero') as never);
    await runtime.prepareTurn(req('sess-zero') as never);
    expect(await runtime.memory.listEpisodes()).toEqual([]);
  });

  it('rate=1.0 → 每 turn 恒记录（两次 prepareTurn → 2 条 episode）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 1 }));
    await runtime.prepareTurn(req('sess-all') as never);
    await runtime.prepareTurn(req('sess-all') as never);
    const episodes = await runtime.memory.listEpisodes();
    expect(episodes).toHaveLength(2);
    expect(episodes.every((e) => e.outcome === null)).toBe(true); // 记录即 outcome 占位 null（不预造归因）
  });

  it('rate=0.02（显式注入）→ 固定会话 id 下记录数 = 哈希期望（确定性注入）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 0.02 }));
    const sid = 'sess-rate-002';
    const expected = expectedSampleCount(sid, 2, 0.02);
    await runtime.prepareTurn(req(sid) as never);
    await runtime.prepareTurn(req(sid) as never);
    expect(await runtime.memory.listEpisodes()).toHaveLength(expected);
  });

  it('缺省采样率（不配 = 0.02）→ 与 EPISODE_SAMPLE_RATE_DEFAULT 期望一致', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const sid = 'sess-default';
    const expected = expectedSampleCount(sid, 3, EPISODE_SAMPLE_RATE_DEFAULT);
    await runtime.prepareTurn(req(sid) as never);
    await runtime.prepareTurn(req(sid) as never);
    await runtime.prepareTurn(req(sid) as never);
    expect(await runtime.memory.listEpisodes()).toHaveLength(expected);
  });

  it('非法注入采样率 → 装配 fail-loud（不静默降级）', () => {
    expect(() => createCognitiveRuntime({ root, episodeSampleRate: 2 })).toThrow();
    expect(() => createCognitiveRuntime({ root, episodeSampleRate: -1 })).toThrow();
  });
});

describe('③ 高价值提升（open_questions/evidence_gaps 非空 → 采样率提升到 0.10）', () => {
  it('0.02 不采而 0.10 采的会话：高价值 ws → 记录；非高价值 ws → 不记录（同会话同 turn token 对照）', async () => {
    // 确定性寻找：shouldSampleEpisode(sid,'1',0.10)=true 且 shouldSampleEpisode(sid,'1',0.02)=false 的会话
    let sid = '';
    for (let i = 0; i < 300 && sid === ''; i++) {
      const c = `hv-sess-${i}`;
      if (shouldSampleEpisode(c, '1', EPISODE_SAMPLE_RATE_HIGH_VALUE) && !shouldSampleEpisode(c, '1', EPISODE_SAMPLE_RATE_DEFAULT)) {
        sid = c;
      }
    }
    expect(sid).not.toBe(''); // 2% vs 10% 注入率下必存在（确定性）

    // 高价值（open_questions 非空）→ 生效率 0.10 → 采样命中
    const rtHigh = track(createCognitiveRuntime({ root: join(base, 'hv'), episodeSampleRate: EPISODE_SAMPLE_RATE_DEFAULT }));
    await rtHigh.prepareTurn(
      req(sid, { working_state: { ...(req(sid).working_state as object), open_questions: ['问题'], evidence_gaps: ['缺口'] } }) as never,
    );
    expect(await rtHigh.memory.listEpisodes()).toHaveLength(1);

    // 对照：新运行时（turn 计数重置 → 同 turn token '1'）+ 非高价值 ws → 生效率 0.02 → 不采样
    const rtLow = track(createCognitiveRuntime({ root: join(base, 'lo'), episodeSampleRate: EPISODE_SAMPLE_RATE_DEFAULT }));
    await rtLow.prepareTurn(req(sid) as never);
    expect(await rtLow.memory.listEpisodes()).toEqual([]);
  });

  it('evidence_gaps 非空同样触发提升（与 open_questions 并列条件）', async () => {
    let sid = '';
    for (let i = 0; i < 300 && sid === ''; i++) {
      const c = `hv-gap-${i}`;
      if (shouldSampleEpisode(c, '1', EPISODE_SAMPLE_RATE_HIGH_VALUE) && !shouldSampleEpisode(c, '1', EPISODE_SAMPLE_RATE_DEFAULT)) {
        sid = c;
      }
    }
    expect(sid).not.toBe('');
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: EPISODE_SAMPLE_RATE_DEFAULT }));
    await runtime.prepareTurn(
      req(sid, { working_state: { ...(req(sid).working_state as object), open_questions: [], evidence_gaps: ['缺口'] } }) as never,
    );
    expect(await runtime.memory.listEpisodes()).toHaveLength(1);
  });
});

describe('④ kern_memory 恒记录（显式记忆工具不受采样率限制）', () => {
  it('rate=0 下 kern_memory 检索仍记录 episode（低频高价值 → 恒 episode=true）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 0 }));
    const r = await runtime.retrieveMemory({ text: 'kernprobe' });
    expect(r.ok).toBe(true);
    const episodes = await runtime.memory.listEpisodes();
    expect(episodes).toHaveLength(1); // 显式工具恒记录（非采样）
    expect(episodes[0]!.outcome).toBeNull();
  });

  it('缺省率下 kern_memory 恒记录且独立于 prepareTurn 采样', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.retrieveMemory({ text: 'kernprobe' });
    const episodes = await runtime.memory.listEpisodes();
    expect(episodes).toHaveLength(1); // 与 prepareTurn 是否采样无关——恒记录
  });
});

describe('⑤ finalizeTurn 归因代理（诚实性——不伪造 hit/miss）', () => {
  it('本会话已记录 null-outcome episode → 保持 null + pending 计数（证据不足则不归因）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 1 }));
    await runtime.prepareTurn(req('sess-attr') as never);
    const res = await runtime.finalizeTurn({
      session_id: 'sess-attr',
      decision,
      working_state: req('sess-attr').working_state as never,
    });
    // 归因代理：finalizeTurn 只做审计统计；归因本身在**下一次 prepareTurn** 用新人类消息作引用窗口
    //（证据不足 → 保持 null「待归因」，绝不硬造结论）。skipped 为证据不足计数（进程内累计）。
    expect(res.episode_attribution).toMatchObject({ attributed: 0, pending: 1 });
    const episodes = await runtime.memory.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.outcome).toBeNull(); // outcome 仍 null（未硬造）
  });

  it('外部已归因 episode → attributed 计数；后续未归因 → pending（审计面如实分离）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 1 }));
    await runtime.prepareTurn(req('sess-attr2') as never);
    const episodes = await runtime.memory.listEpisodes();
    expect(episodes).toHaveLength(1);
    // 外部归因面（reportEpisodeOutcome——§7.4 唯一诚实归因入口）先于 finalizeTurn 归因
    await reportEpisodeOutcome(runtime.memory, episodes[0]!.id, 'hit');
    await runtime.prepareTurn(req('sess-attr2') as never); // 第二 turn 采样记录（仍 null）
    const res = await runtime.finalizeTurn({
      session_id: 'sess-attr2',
      decision,
      working_state: req('sess-attr2').working_state as never,
    });
    expect(res.episode_attribution).toMatchObject({ attributed: 1, pending: 1 });
  });

  it('无采样记录的会话 → 归因代理空结果（attributed 0 / pending 0）', async () => {
    runtime = track(createCognitiveRuntime({ root, episodeSampleRate: 0 }));
    const res = await runtime.finalizeTurn({
      session_id: 'sess-none',
      decision,
      working_state: req('sess-none').working_state as never,
    });
    expect(res.episode_attribution).toMatchObject({ attributed: 0, pending: 0 });
  });
});

describe('⑥ signal-collectors：null-outcome「已记录待归因」→ L1 scope_recorded（不稀释命中率）', () => {
  it('1 hit + 1 miss + 1 待归因 → scope_hit/scope_miss/scope_recorded 各 1；generalization 比率不受待归因稀释', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const mem = await runtime.memory.ingest({
      ir_version: '2.0',
      id: 'mem:00000000-0000-4000-8000-00000000aaaa',
      schema: 'omb/M1',
      scope: 'Project',
      kind: 'Semantic',
      lifecycle: 'Active',
      prov_class: 'Observation',
      immutable: false,
      owner: 'kernel',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      provenance: {
        source: 'test',
        event: 'm9/episode-sampling-1',
        actor: 'm9',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.1.1-rc.1', project: 'omb-v2' },
        runtime_snapshot: 'rs:test',
        timestamp: new Date().toISOString(),
        transformation_chain: [],
        verification: 'test',
      },
      refs: [],
      payload: '采样信号样本',
      value_score: 0.5,
      utility_counts: {},
    });
    const epHit = await recordEpisode(runtime.memory, { query: 'q1', scope: 'Project', candidate_ids: [mem], ranked_ids: [mem], injected_ids: [mem] });
    await reportEpisodeOutcome(runtime.memory, epHit.id, 'hit');
    const epMiss = await recordEpisode(runtime.memory, { query: 'q2', scope: 'Project', candidate_ids: [mem], ranked_ids: [mem], injected_ids: [mem] });
    await reportEpisodeOutcome(runtime.memory, epMiss.id, 'miss');
    await recordEpisode(runtime.memory, { query: 'q3', scope: 'Project', candidate_ids: [mem], ranked_ids: [mem], injected_ids: [mem] }); // 不归因 → null

    const window = { from: 0, to: Date.now() + 60_000 };
    const signals = await collectGeneralizationSignals(runtime.memory, 't:m9', window);
    const byKind = new Map(signals.filter((s) => s.layer === 'L1').map((s) => [s.kind, s.count]));
    expect(byKind.get('scope_hit')).toBe(1);
    expect(byKind.get('scope_miss')).toBe(1);
    expect(byKind.get('scope_recorded')).toBe(1); // 待归因单独一类（检索数据量照常入信号）
    // 不稀释命中率比率：比率只认 scope_hit/scope_miss（待归因不混入分母）
    const fact = getFact(evaluate(signals, 't:m9'), 'generalization');
    expect(fact!.value).toBeCloseTo(0.5); // 1/(1+1)，非 1/3
    expect(fact!.sample_size).toBe(2);
  });
});
