// S1（2026-08-24-completion-sweep）：World/Self 模型运行接线测试。
// 覆盖：
//   runtime/models.ts 纯函数 buildWorldModel/buildSelfModel：字段真实（能力/版本线/commit/布局/bench/
//     hostVersion/插件版本/资源）、确定性（同 view → 同内容同 id）、无副作用（重复构建深度相等）、
//     空状态（无能力/无降级）→ 诚实空与未知标记（不臆造）；S4 schema 校验。
//   CognitiveRuntime 运行接线：worldModel/selfModel 装配（fixture 运行时，S4 schema 合规）；
//     materializeState（reduce 产出 State 的 world/self null → 模型引用；StateSchema 校验通过）；
//     prepareTurn 后会话 State.world/self 非 null 且内容正确；promote 后模型反映新快照（内容寻址重建）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { hostVersion } from '../../kernel/schemas/host-version.js';
import { S4Schema, StateSchema, type State } from '../../kernel/schemas/s.js';
import type { Event } from '../../kernel/schemas/m.js';
import { createSnapshot } from '../../supervisor/versioning.js';
import { reduce } from '../../supervisor/state-reducer.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { buildSelfModel, buildWorldModel, type RuntimeView } from '../../runtime/models.js';
import { PROV, S2_VALID } from '../m1/ir-samples.js';

const SESSION = 'sess-s1-models';
const GOAL = 'World Self 模型运行接线验证';
const COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** fixture RuntimeView（字段全部真实可控；over 覆盖制造降级/空态） */
function fixtureView(over: Partial<RuntimeView> = {}): RuntimeView {
  return {
    assembledAt: '2026-08-24T00:00:00.000Z',
    snapshotHash: 'rs:1234567890abcdef',
    line: 'stable',
    commit: COMMIT,
    lineSnapshot: { line: 'stable', commit: COMMIT, dir: 'C:/fake/lines/stable' },
    lineDegraded: null,
    snapshotDegraded: null,
    componentDegraded: null,
    capabilities: [
      { id: 'cap:1', name: 'memory.retrieve', authority_scope: 'kernel', reliability: 'high' },
      { id: 'cap:2', name: 'memory.remember', authority_scope: 'kernel', reliability: 'high' },
    ],
    components: [{ manifest_id: 'component:memory-retrieval', status: 'active', healthy: true, health_detail: null }],
    degradations: [],
    hostVersion: '0.1.0-rc.7',
    pluginVersion: '1.5.0',
    environmentFingerprint: { os: 'win32', node: 'v24.0.0', dsh_version: '0.1.0-rc.7', project: 'omb-v2' },
    resources: { memory_mb: 16384, cpus: 16, detail: '系统级实测（node:os）' },
    bench: { recent_real_reports: 2, recent_replay_reports: 1 },
    layoutState: 'lines-injected',
    modelAdapterAvailable: false,
    maintenanceAvailable: true,
    checkpointAvailable: true,
    ...over,
  };
}

/** M3 Event 工厂（fixture 运行时事件入链；provenance 复用 ir-samples PROV） */
function evt(type: string, payload: Record<string, unknown>): Event {
  const ts = new Date().toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: SESSION,
    runtime_snapshot: 'rs:test',
    parent_event: null,
    payload,
    timestamp: ts,
  };
}

function req(): Record<string, unknown> {
  return {
    session_id: SESSION,
    goal: GOAL,
    success_criteria: ['世界模型接线'],
    constraints: ['诚实'],
    working_state: {
      goal: GOAL,
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: 'test',
    },
  };
}

let base: string;
let root: string;
let runtime: CognitiveRuntime;
const runtimes: CognitiveRuntime[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-s1-models-'));
  root = join(base, '.omb');
  runtimes.length = 0;
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

describe('buildWorldModel（S4 纯函数）', () => {
  it('字段真实：版本线/commit/lines 快照/布局/能力/bench/环境指纹 + S4 schema 校验', () => {
    const v = fixtureView();
    const m = buildWorldModel(v);

    expect(m.kind).toBe('world_model');
    expect(m.line).toBe('stable');
    expect(m.commit).toBe(COMMIT);
    expect(m.line_snapshot).toEqual(v.lineSnapshot);
    expect(m.layout_state).toBe('lines-injected');
    expect(m.capabilities).toEqual(['memory.remember', 'memory.retrieve']); // 能力名去重排序
    expect(m.bench).toEqual({ recent_real_reports: 2, recent_replay_reports: 1 });
    expect(m.environment.os).toBe('win32');
    expect(m.environment.dsh_version).toBe('0.1.0-rc.7');
    expect(m.limitations).toEqual([]); // 无降级 → 诚实空
    expect(S4Schema.safeParse(m).success).toBe(true);
  });

  it('lines 降级/未注入 → layout_state=repo-default、commit 缺省、limitations 诚实记录', () => {
    const v = fixtureView({
      lineSnapshot: null,
      commit: null,
      layoutState: 'repo-default',
      lineDegraded: 'lines 按线加载不可用——回退仓库默认策略/过程',
    });
    const m = buildWorldModel(v);

    expect(m.layout_state).toBe('repo-default');
    expect(m.commit).toBeUndefined(); // 未知 → 缺省（诚实，不臆造）
    expect(m.limitations.some((l) => l.includes('lines 按线加载不可用'))).toBe(true);
    expect(S4Schema.safeParse(m).success).toBe(true);
  });

  it('确定性：同 view → 同内容同 id；状态变化 → 内容与 id 变化（内容寻址）', () => {
    const v = fixtureView();
    const a = buildWorldModel(v);
    const b = buildWorldModel(v);
    expect(b).toEqual(a);
    expect(b.id).toBe(a.id);
    // 版本线变化（/mode 切换语义）→ 内容与 id 变化
    const v2 = fixtureView({ line: 'latest', commit: 'f00d'.repeat(10) });
    const c = buildWorldModel(v2);
    expect(c.line).toBe('latest');
    expect(c.id).not.toBe(a.id);
    expect(c).not.toEqual(a);
  });

  it('空状态（无能力/无降级/无线快照）→ 诚实空与未知标记（不臆造）', () => {
    const v = fixtureView({
      capabilities: [],
      components: [],
      degradations: [],
      lineSnapshot: null,
      commit: null,
      layoutState: 'repo-default',
    });
    const m = buildWorldModel(v);

    expect(m.capabilities).toEqual([]);
    expect(m.layout_state).toBe('repo-default');
    expect(m.commit).toBeUndefined();
    expect(m.limitations.length).toBeGreaterThan(0); // 降级/未知被如实记录，而非假装正常
    expect(S4Schema.safeParse(m).success).toBe(true);
  });
});

describe('buildSelfModel（S4 纯函数）', () => {
  it('字段真实：能力面/组件状态/hostVersion/插件版本/资源 + 可靠策略 + S4 schema 校验', () => {
    const v = fixtureView();
    const m = buildSelfModel(v);

    expect(m.kind).toBe('self_model');
    expect(m.host_version).toBe('0.1.0-rc.7');
    expect(m.plugin_version).toBe('1.5.0');
    expect(m.resources).toEqual({ memory_mb: 16384, cpus: 16, detail: '系统级实测（node:os）' });
    expect(m.current_state).toContain('memory.retrieve'); // 能力面
    expect(m.current_state).toContain('component:memory-retrieval:active'); // 组件状态
    expect(m.current_state).toContain('hostVersion=0.1.0-rc.7');
    expect(m.reliable_strategies.length).toBeGreaterThan(0);
    expect(m.environment.dsh_version).toBe('0.1.0-rc.7');
    // 诚实盲点：modelAdapter 未装配 → LLM 路径未验证
    expect(m.blind_spots.some((b) => b.includes('modelAdapter'))).toBe(true);
    expect(S4Schema.safeParse(m).success).toBe(true);
  });

  it('确定性：同 view → 同内容同 id；装配面变化 → 盲点与 current_state 如实变化', () => {
    const v = fixtureView();
    const a = buildSelfModel(v);
    const b = buildSelfModel(v);
    expect(b).toEqual(a);
    expect(b.id).toBe(a.id);

    // modelAdapter 装配 → 该盲点消失；maintenance 未装配 → 新盲点出现
    const v2 = fixtureView({ modelAdapterAvailable: true, maintenanceAvailable: false, checkpointAvailable: false });
    const c = buildSelfModel(v2);
    expect(c.blind_spots.some((x) => x.includes('modelAdapter'))).toBe(false);
    expect(c.blind_spots.some((x) => x.includes('维护调度器未装配'))).toBe(true);
    expect(c.blind_spots.some((x) => x.includes('checkpoint 持久化未装配'))).toBe(true);
    expect(c.id).not.toBe(a.id);
  });

  it('空状态（无能力/无组件/资源无硬数据）→ 诚实空与未知标记（不臆造）', () => {
    const v = fixtureView({
      capabilities: [],
      components: [],
      degradations: [],
      resources: { memory_mb: null, cpus: null, detail: '无硬数据源——诚实未知' },
      modelAdapterAvailable: false,
      maintenanceAvailable: false,
      checkpointAvailable: false,
    });
    const m = buildSelfModel(v);

    expect(m.current_state).toContain('能力 0 项');
    expect(m.current_state).toContain('组件 0 个');
    expect(m.blind_spots.some((b) => b.includes('资源') && b.includes('未知'))).toBe(true);
    expect(m.blind_spots.some((b) => b.includes('modelAdapter'))).toBe(true);
    expect(m.blind_spots.some((b) => b.includes('维护调度器未装配'))).toBe(true);
    expect(m.blind_spots.some((b) => b.includes('checkpoint 持久化未装配'))).toBe(true);
    expect(S4Schema.safeParse(m).success).toBe(true);
  });

  it('降级记录（degradations/快照/组件）→ current_state 与 blind_spots 如实反映', () => {
    const v = fixtureView({
      degradations: [{ hook: 'ctx.tools', reason: '接口缺失', at: '2026-08-24T00:00:00.000Z' }],
      snapshotDegraded: '快照机制降级（rs:assembly）',
      componentDegraded: '组件激活失败',
    });
    const m = buildSelfModel(v);

    expect(m.current_state).toContain('快照机制降级');
    expect(m.current_state).toContain('组件激活失败');
    expect(m.current_state).toContain('守卫降级 1 条');
    expect(m.blind_spots.some((b) => b.includes('守卫降级 1 条'))).toBe(true);
    expect(S4Schema.safeParse(m).success).toBe(true);
  });
});

describe('CognitiveRuntime 运行接线（fixture 运行时）', () => {
  it('worldModel/selfModel 装配：S4 schema 合规、字段真实、视图缓存确定性（重复读取同一模型）', () => {
    runtime = track(createCognitiveRuntime({ root }));

    const wm = runtime.worldModel;
    const sm = runtime.selfModel;
    expect(S4Schema.safeParse(wm).success).toBe(true);
    expect(S4Schema.safeParse(sm).success).toBe(true);
    expect(wm.kind).toBe('world_model');
    expect(wm.line).toBe('stable');
    expect(wm.capabilities).toContain('memory.retrieve'); // 组件 manifest 能力已登记进能力注册表
    expect(sm.kind).toBe('self_model');
    expect(sm.host_version).toBe(hostVersion()); // R6 唯一宿主版本来源
    // 视图缓存 → 同一模型实例（确定性）
    expect(runtime.worldModel).toBe(wm);
    expect(runtime.selfModel).toBe(sm);
  });

  it('materializeState：reduce 产出 State 的 world/self null → 模型引用（两路径均填充；schema 合规路径校验通过）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.observeEvent(evt('session/start', { goal: GOAL }));

    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const reduced = reduce(events).state;
    expect(reduced.world).toBeNull(); // 纯归约：事件流本身不含世界/自我模型（P7 诚实 null）
    expect(reduced.self).toBeNull();

    // 路径① 事件流直归约（无 initial：working 缺省字段为既有诚实空语义）——world/self 仍被填充（不抛）
    const plainState = runtime.materializeState(reduced);
    expect(plainState.world).toBe(runtime.worldModel.id); // 引用 → 组装后的模型 id
    expect(plainState.self).toBe(runtime.selfModel.id);
    expect(plainState.world).not.toBeNull();
    expect(plainState.self).not.toBeNull();

    // 路径② schema 合规回放（带 initial，checkpoint 契约层调用方保证）——填充后 StateSchema 校验通过
    const { state: seeded } = reduce([evt('session/start', { goal: GOAL })], {
      initial: S2_VALID as unknown as State,
    });
    const wired = runtime.materializeState(seeded);
    expect(StateSchema.safeParse(wired).success).toBe(true);
    expect(wired.world).toBe(runtime.worldModel.id);
    expect(wired.self).toBe(runtime.selfModel.id);
  });

  it('prepareTurn 后会话 State.world/self 非 null 且内容正确（fixture 运行时）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    await runtime.prepareTurn(req() as never);

    const events = (await runtime.eventStore.query({ session_id: SESSION })).events;
    const state = runtime.materializeState(reduce(events).state);

    expect(state.world).not.toBeNull();
    expect(state.self).not.toBeNull();
    expect(state.world).toBe(runtime.worldModel.id);
    expect(state.self).toBe(runtime.selfModel.id);
    // 内容正确：模型来自同一运行时视图（版本线/能力/宿主版本）
    expect(runtime.worldModel.line).toBe('stable');
    expect(runtime.worldModel.capabilities).toContain('memory.retrieve');
    expect(runtime.selfModel.host_version).toBe(hostVersion());
    // 引用可解析：State.world/self 指向的模型存在且为对应 kind
    const world = runtime.worldModel;
    expect(state.world).toBe(world.id);
    expect(world.kind).toBe('world_model');
  });

  it('promoteSnapshot 后模型反映新快照（缓存重置，内容寻址重建）', () => {
    runtime = track(createCognitiveRuntime({ root }));
    const before = runtime.worldModel;

    const next = createSnapshot({
      components: {
        scheduler: '11'.repeat(32),
        memory: '11'.repeat(32),
        verifier: '11'.repeat(32),
        renderer: '11'.repeat(32),
        capability: '11'.repeat(32),
        philosophy: '11'.repeat(32),
      },
      gitRevision: 'promoted-snapshot',
    });
    runtime.promoteSnapshot(next);

    const after = runtime.worldModel;
    expect(after).not.toBe(before);
    expect(after.provenance.runtime_snapshot).not.toBe(before.provenance.runtime_snapshot);
    expect(after.provenance.runtime_snapshot).toMatch(/^rs:/);
    expect(S4Schema.safeParse(after).success).toBe(true);
  });
});
