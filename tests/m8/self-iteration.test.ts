// 自迭代开关面 / 状态工具 / 提示词主动性 行为测试
// （对应 docs/known-issues.md《开关落在宿主插件配置，不引入界面》《需要"查看自迭代状态"的快速工具》
//   《"AI 从未尝试自迭代"与提示词主动性》《并发能力未知（无探测面）》四条修复判定）：
//   ① 开关面落在插件配置：链路总开关 / 触发门槛 / 后台模型调用许可 / 演化节律——缺省全启用
//   ② 总开关关闭 → 判定照常但 should_evolve=false，原因写进状态（不静默）
//   ③ 触发门槛：最高强度低于门槛 → 不演化
//   ④ 演化节律关闭 → finalizeTurn 不入队 evolution_decision
//   ⑤ 状态工具：kern_status 带 line/evolution 参数；状态段回答「为什么没有演化」（门禁逐项 + 开关面 +
//      最近判定结论/原因 + 信号计数 + 债务快照）+ 三线领先/落后关系
//   ⑥ 并发档位：后台模型调用许可随并发能力切换（并发 1 → 禁止；未知 → 沿用既有行为）
//   ⑦ 提示词主动性：契约含按需许可（先看状态、条件满足再触发），同时保留「不主动加载内部机制」边界
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMB_RUNTIME_CONTRACT } from '../../runtime/runtime-contract.js';
import { kernStatusTool } from '../../runtime/kern-tools.js';
import { evolutionStateFile, readEvolutionState } from '../../runtime/evolution-state.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-selfiter-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

/** 写一条触发演化（corrections strength 0.9）的信号记录 */
async function seedCorrectionSignal(): Promise<void> {
  const dir = join(root, '.evolution', 'signals');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const rec = { ts: Date.now(), kind: 'corrections', session_id: 's1', payload: { count: 1 } };
  await (await import('node:fs/promises')).writeFile(join(dir, `${day}.jsonl`), `${JSON.stringify(rec)}\n`, 'utf8');
}

describe('① 开关面落在插件配置（不引入界面）', () => {
  it('缺省（不写配置）→ 全启用，既有行为不变', () => {
    const captured: unknown[] = [];
    const ctx: ContextLike = { commands: { register: (def: unknown) => captured.push(def) } };
    const handle = apply(ctx, { cognitiveRoot: root, bootstrap: false });
    const rt = track(handle.cognitive as CognitiveRuntime);
    expect(rt.selfIterationConfig()).toEqual({
      enabled: true,
      min_strength: 0,
      background_model_calls: true,
      schedule: true,
    });
  });

  it('配置面逐项生效：enabled/minStrength/backgroundModelCalls/schedule', () => {
    const ctx: ContextLike = { commands: { register: () => {} } };
    const handle = apply(ctx, {
      cognitiveRoot: root,
      bootstrap: false,
      selfIteration: { enabled: false, minStrength: 0.6, backgroundModelCalls: false, schedule: false },
    });
    const rt = track(handle.cognitive as CognitiveRuntime);
    expect(rt.selfIterationConfig()).toEqual({
      enabled: false,
      min_strength: 0.6,
      background_model_calls: false,
      schedule: false,
    });
  });
});

describe('② 链路总开关', () => {
  it('关闭 → 判定照常记录，但 should_evolve=false 且原因写明配置（不静默）', async () => {
    await seedCorrectionSignal();
    const rt = track(createCognitiveRuntime({ root, selfIteration: { enabled: false } }));
    const r = await rt.runEvolutionNow({ session_id: 's1' });
    expect(r.decision.should_evolve).toBe(false);
    expect(r.decision.reason).toContain('disabled_by_config');
    expect(r.enqueued).toEqual([]); // 不生成候选
    const state = await readEvolutionState(evolutionStateFile(join(root, '.evolution')));
    expect(state?.decision.reason).toContain('disabled_by_config');
    expect(state?.gates.find((g) => g.gate === '链路总开关')).toMatchObject({ passed: false });
  });

  it('缺省启用 → 同一信号照常演化（开关不影响既有语义）', async () => {
    await seedCorrectionSignal();
    const rt = track(createCognitiveRuntime({ root }));
    const r = await rt.runEvolutionNow({ session_id: 's1' });
    expect(r.decision.should_evolve).toBe(true);
    expect(r.decision.triggers.map((t: { kind: string }) => t.kind)).toContain('corrections');
  });
});

describe('③ 触发门槛', () => {
  it('最高触发强度低于门槛 → 不演化，原因写明门槛（门槛 = 实际强度 + 余量；不依赖具体策略数值）', async () => {
    await seedCorrectionSignal(); // corrections 为 evolve=true 的触发信号
    const rt = track(createCognitiveRuntime({ root }));
    const base = await rt.runEvolutionNow({ session_id: 's1' });
    expect(base.decision.should_evolve).toBe(true);
    const strength = base.decision.strength; // 运行时实际生效强度（装配线策略决定）
    // 门槛略高于实际强度 → 拦下
    const rt2 = track(createCognitiveRuntime({ root, selfIteration: { minStrength: strength + 0.01 } }));
    const r = await rt2.runEvolutionNow({ session_id: 's1' });
    expect(r.decision.should_evolve).toBe(false);
    expect(r.decision.reason).toContain('strength_below_min');
    // 门槛低于实际强度 → 照常演化
    const rt3 = track(createCognitiveRuntime({ root, selfIteration: { minStrength: strength - 0.01 } }));
    const r3 = await rt3.runEvolutionNow({ session_id: 's1' });
    expect(r3.decision.should_evolve).toBe(true);
  });
});

describe('④ 演化节律', () => {
  it('schedule=false → finalizeTurn 不入队 evolution_decision（其余维护任务照常）', async () => {
    const rt = track(createCognitiveRuntime({ root, selfIteration: { schedule: false } }));
    const res = await rt.handleRequest({
      session_id: 's1',
      goal: '目标',
      success_criteria: ['c1'],
      working_state: {
        goal: '目标',
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
    });
    expect(res.decision.decision).toBeDefined();
    const debt = await rt.status();
    expect(debt.debt_sources?.some((d) => d.task_id === 'evolution_decision') ?? false).toBe(false);
  });
});

describe('⑤ 状态工具（扩展 kern_status，不新增工具）', () => {
  it('statusFor 附带自迭代状态段：最近判定结论与原因、信号计数、债务快照、门禁逐项、开关面', async () => {
    await seedCorrectionSignal();
    const rt = track(createCognitiveRuntime({ root }));
    await rt.runEvolutionNow({ session_id: 's1' });
    const st = await rt.statusFor();
    expect(st.evolution).not.toBeNull();
    const ev = st.evolution!;
    expect(ev.enabled).toBe(true);
    expect(ev.last_decision?.should_evolve).toBe(true);
    expect(ev.last_decision?.reason).toContain('trigger:');
    expect(ev.last_decision_trigger).toBe('evolve-command:now');
    expect(ev.signals.corrections).toBeGreaterThan(0);
    expect(ev.signals_total).toBeGreaterThan(0);
    expect(ev.gates.map((g) => g.gate)).toContain('链路总开关');
    expect(ev.gates.map((g) => g.gate)).toContain('债务硬限');
    expect(ev.gates.map((g) => g.gate)).toContain('后台模型调用许可');
    expect(ev.debt).toMatchObject({ soft: 10, hard: 50, critical: 100 });
    expect(ev.lines.map((l) => l.line)).toEqual(['initial', 'stable', 'latest']);
  });

  it('无判定记录 → 状态段诚实标注缺失（不臆造结论）；evolution=false → 不带该段', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    const st = await rt.statusFor();
    expect(st.evolution?.last_decision).toBeNull();
    expect(st.evolution?.degraded).toContain('尚无演化判定记录');
    const st2 = await rt.statusFor({ evolution: false });
    expect(st2.evolution).toBeNull();
  });

  it('line 参数 → 返回该线状态与领先/落后关系（多线状态）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    const st = await rt.statusFor({ line: 'latest' });
    expect(st.evolution?.line?.line).toBe('latest');
    for (const l of st.evolution?.lines ?? []) {
      expect(typeof l.ahead).toBe('number');
      expect(typeof l.behind).toBe('number');
    }
  });

  it('kern_status 工具：参数解析 + 优先走 statusFor + 未提供 statusFor 时降级', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    const seen: Array<{ line?: string; evolution?: boolean }> = [];
    const tool = kernStatusTool({
      statusFor: async (input) => {
        seen.push(input ?? {});
        return { evolution: null } as never;
      },
    });
    expect(tool.name).toBe('kern_status');
    await tool.execute?.({ line: 'stable', evolution: false }, {});
    expect(seen[0]).toEqual({ line: 'stable', evolution: false });
    // 非法参数类型 → 不传（守卫式接入，不抛）
    await tool.execute?.({ line: 42, evolution: 'yes' }, {});
    expect(seen[1]).toEqual({ line: undefined, evolution: undefined });
    // 只有 status() 的旧运行时 → 退回无参调用
    const legacy = kernStatusTool({ status: async () => ({ evolution: null }) as never });
    const out = await legacy.execute?.({ line: 'latest' }, {});
    expect(out).toMatchObject({ evolution: null });
    // 两者都缺 → 降级返回（不抛）
    const none = kernStatusTool({});
    const degraded = (await none.execute?.({}, {})) as { ok?: boolean; degraded?: string };
    expect(degraded.ok).toBe(false);
    expect(degraded.degraded).toContain('status()');
    expect(rt.statusFor).toBeDefined();
  });
});

describe('⑥ 并发档位（后台模型调用许可随并发能力切换）', () => {
  it('声明并发 1 → 后台模型调用自动禁止（候选生成降级为纯规则）', async () => {
    await seedCorrectionSignal();
    const ctx: ContextLike = { commands: { register: () => {} } };
    const handle = apply(ctx, { cognitiveRoot: root, bootstrap: false, concurrency: { maxConcurrentRequests: 1 } });
    const rt = track(handle.cognitive as CognitiveRuntime);
    expect(rt.selfIterationConfig().background_model_calls).toBe(false);
    const r = await rt.runEvolutionNow({ session_id: 's1' });
    // 判定照常（演化不被禁止），链路照常；状态段写明后台调用许可被禁
    expect(r.decision.should_evolve).toBe(true);
    const st = await rt.statusFor();
    expect(st.evolution?.background_model_calls).toBe(false);
    const gate = st.evolution?.gates.find((g) => g.gate === '后台模型调用许可');
    expect(gate?.passed).toBe(false);
    expect(gate?.reason).toContain('background_model_calls_disabled');
  });

  it('声明并发 4 → 后台模型调用许可；显式 false 覆盖为禁止', async () => {
    const ctx: ContextLike = { commands: { register: () => {} } };
    const h1 = apply(ctx, { cognitiveRoot: join(base, 'r1'), bootstrap: false, concurrency: { maxConcurrentRequests: 4 } });
    const rt1 = track(h1.cognitive as CognitiveRuntime);
    expect(rt1.selfIterationConfig().background_model_calls).toBe(true);
    const h2 = apply(ctx, {
      cognitiveRoot: join(base, 'r2'),
      bootstrap: false,
      concurrency: { maxConcurrentRequests: 4 },
      selfIteration: { backgroundModelCalls: false },
    });
    const rt2 = track(h2.cognitive as CognitiveRuntime);
    expect(rt2.selfIterationConfig().background_model_calls).toBe(false);
  });

  it('宿主 llm 暴露并发元数据 → 自动读取（声明值被宿主覆盖）', () => {
    const ctx: ContextLike = {
      commands: { register: () => {} },
      get: (name: string) =>
        name === 'llm' ? ({ stream: () => {}, maxConcurrentRequests: 1 } as unknown) : undefined,
    };
    const handle = apply(ctx, { cognitiveRoot: join(base, 'r3'), bootstrap: false, concurrency: { maxConcurrentRequests: 8 } });
    const rt = track(handle.cognitive as CognitiveRuntime);
    expect(rt.selfIterationConfig().background_model_calls).toBe(false); // 宿主 1 覆盖声明 8
  });
});

describe('⑦ 提示词主动性（契约按需许可 + 边界保留）', () => {
  it('契约含「先看状态、条件满足再触发」的按需许可，且保留「不主动加载内部机制」边界', () => {
    expect(OMB_RUNTIME_CONTRACT).toContain('kern_status');
    expect(OMB_RUNTIME_CONTRACT).toContain('条件满足再');
    expect(OMB_RUNTIME_CONTRACT).toContain('不主动加载内部机制');
    expect(OMB_RUNTIME_CONTRACT).toContain('不无由触发改动');
  });

  it('契约标题精简且不强调版本；总量仍在 500 字符硬约束内', () => {
    expect(OMB_RUNTIME_CONTRACT.startsWith('OMB认知层使用方式：')).toBe(true);
    expect(OMB_RUNTIME_CONTRACT).not.toContain('OMB v2 运行时契约');
    expect(OMB_RUNTIME_CONTRACT.length).toBeLessThanOrEqual(500);
  });
});

describe('状态文件落盘（可观测面）', () => {
  it('判定后 .evolution/evolve-state.json 落盘且可读回（原子写）', async () => {
    await seedCorrectionSignal();
    const rt = track(createCognitiveRuntime({ root }));
    await rt.runEvolutionNow({ session_id: 's1' });
    const file = evolutionStateFile(join(root, '.evolution'));
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(await readFile(file, 'utf8')) as { decision: { reason: string } };
    expect(raw.decision.reason.length).toBeGreaterThan(0);
  });
});
