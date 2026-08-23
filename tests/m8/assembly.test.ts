// T8.3 行为测试：认知系统装配进插件生命周期（runtime/assembly.ts 组合根 + runtime/plugin.ts apply 装配）。
// 现状：认知系统仅是带测试的库——本任务把 governor/memory/event-store/supervisor 实例化并注入插件。
// 验收（brief）：插件激活即装配（apply 时实例化依赖图）；请求路径经 Governor
// （最小请求处理链：事件 → Governor 决策 → 记忆检索 → prompt）。
// 装配经组合根（runtime/assembly.ts，层 2；runtime → supervisor 依 DAG 规则"目标层 ≤ 源层"合法——
// eslint 强制同款语义，见 CONVENTIONS §4 与 tests/m0/dag-lint.test.ts；plugin.ts 经 deps 注入或组合根缺省装配）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOVERNOR_DECISIONS } from '../../kernel/policy-loader.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-m8a-asm-'));
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

describe('T8.3 认知系统装配（createCognitiveRuntime）', () => {
  it('装配：governor/memory/event-store/supervisor 实例化依赖图（EventStore 可写、memory 可读写、policy/processes 已加载）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    expect(runtime.eventStore).toBeDefined();
    expect(runtime.memory).toBeDefined();
    const { policy, processes } = await runtime.ready();
    expect(processes.length).toBeGreaterThan(0);
    expect(policy.governor.rules.length).toBeGreaterThan(0);
    // EventStore 可用（append + 读回）
    expect(await runtime.eventStore.count()).toBe(0);
  });

  it('装配使用用户态目录：memory.db/events.db 落在 <root> 下（用户态/内核态分离，架构 §3）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const fs = await import('node:fs');
    expect(fs.existsSync(join(root, 'memory.db'))).toBe(true);
    expect(fs.existsSync(join(root, 'events.db'))).toBe(true);
  });
});

describe('T8.3 请求路径经 Governor（最小请求处理链：事件 → 决策 → 检索 → prompt）', () => {
  it('handleRequest：事件入链（session/start + decision/made）→ Governor 决策（OOD+缺口 → GenerateProcess）→ 记忆检索 → prompt 组装', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // 预置记忆（检索面）
    await runtime.memory.ingest({
      ir_version: '2.0',
      id: 'mem:00000000-0000-4000-8000-000000000001',
      schema: 'omb/M1',
      scope: 'Project',
      kind: 'Semantic',
      lifecycle: 'Active',
      prov_class: 'Observation',
      immutable: false,
      owner: 'kernel',
      created: '2026-08-21T00:00:00.000Z',
      updated: '2026-08-21T00:00:00.000Z',
      provenance: {
        source: 'test',
        event: 'test/ingest-1',
        actor: 't8.3',
        environment: { os: 'win32', node: 'v24', dsh_version: '0.8.0', project: 'omb-v2' },
        runtime_snapshot: 'rs:test',
        timestamp: '2026-08-21T00:00:00.000Z',
        transformation_chain: [],
        verification: 'test',
      },
      refs: [],
      payload: '量子引力 全息对偶 相关事实',
      value_score: 0.8,
      utility_counts: {},
    });

    const res = await runtime.handleRequest({
      session_id: 'sess-t8.3-1',
      goal: '量子引力 全息对偶',
      success_criteria: ['给出判别实验'],
      constraints: ['预算内'],
      working_state: {
        goal: '量子引力 全息对偶',
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: ['全息对偶是否成立'],
        evidence_gaps: ['判别观测'],
        next_best_action: '',
        environment: 'test',
      },
    });

    // ① 事件入链：session/start + decision/made 各一条
    const events = (await runtime.eventStore.query({ session_id: 'sess-t8.3-1' })).events;
    expect(events.map((e) => e.type).sort()).toEqual(['decision/made', 'session/start']);
    // ② Governor 决策（OOD + 缺口 some + 预算 ok → GenerateProcess；reason 明确）
    expect(GOVERNOR_DECISIONS).toContain(res.decision.decision);
    expect(res.decision.decision).toBe('GenerateProcess');
    expect(res.decision.reason).toContain('GenerateProcess');
    // ③ 记忆检索命中（goal 文本 → FTS 命中预置记忆）
    expect(res.retrieval.items.length).toBeGreaterThan(0);
    expect(res.retrieval.items[0]?.memory.payload).toContain('量子引力');
    // ④ prompt 组装（任务语义进静态区；token 估算非零）
    expect(res.prompt.system).toContain('任务：量子引力 全息对偶');
    expect(res.prompt.total_tokens).toBeGreaterThan(0);
    expect(res.events_appended).toBe(2);
  });

  it('决策可断言：success_criteria 全覆盖（表外短路）→ Stop；未覆盖 → 查决策表', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // 全覆盖 → task_done 短路 Stop
    const done = await runtime.handleRequest({
      session_id: 'sess-t8.3-2',
      goal: '目标',
      success_criteria: ['c1'],
      working_state: { goal: '目标', confirmed_facts: [], active_hypotheses: [], contradictions: [], open_questions: [], evidence_gaps: [], next_best_action: '', environment: 'test' },
      evidence_sufficiency: { covered_success_conditions: ['c1'], critical_gaps: [], score: 1 },
    });
    expect(done.decision.decision).toBe('Stop');
    expect(done.decision.reason).toContain('任务完成');
  });
});

describe('T8.3 插件激活即装配（plugin.ts apply）', () => {
  it('apply(ctx, config)：激活即装配 → 认知运行时实例化（缺省装配经组合根，用户态目录由 config.cognitiveRoot 指定）', async () => {
    const captured: unknown[] = [];
    const ctx: ContextLike = {
      commands: { register: (def: unknown) => captured.push(def) },
    };
    const handle = apply(ctx, { cognitiveRoot: root, bootstrap: false });
    expect(handle.cognitive).toBeDefined();
    expect(handle.cognitive!.eventStore).toBeDefined();
    expect(handle.cognitive!.memory).toBeDefined();
    // 装配的认知运行时可用（事件/检索经真实存储）
    const fs = await import('node:fs');
    expect(fs.existsSync(join(root, 'memory.db'))).toBe(true);
    await (handle.cognitive as CognitiveRuntime).close();
  });

  it('apply 经 deps 注入：get("cognitive") 已提供 → 使用注入实例（不重复装配、不写用户态目录）', async () => {
    const injected = track(createCognitiveRuntime({ root }));
    const captured: unknown[] = [];
    const ctx: ContextLike = {
      commands: { register: (def: unknown) => captured.push(def) },
      get: (name: string) => (name === 'cognitive' ? injected : undefined),
    };
    const handle = apply(ctx, { cognitiveRoot: join(base, 'should-not-be-used'), bootstrap: false });
    expect(handle.cognitive).toBe(injected); // 注入实例原样使用
    const fs = await import('node:fs');
    expect(fs.existsSync(join(base, 'should-not-be-used'))).toBe(false); // 未按缺省路径装配
    await injected.close();
  });
});
