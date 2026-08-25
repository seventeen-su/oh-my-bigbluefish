// W3（未接线审计修复 2026-08-25）：dynamicCordisRunner 生产注入测试——审计结论：S9 增强通道在
// supervisor/candidate-pipeline.ts 内已接（DataCandidateValidationDeps.dynamicRunner 注入面 +
// inspectDynamicRunner 守卫 + 失败回退受限子进程），但 runtime/plugin.ts 从未读取宿主
// ctx.dynamicCordisRunner 并注入——生产恒走受限子进程 fallback。本次接线：
//   runtime/plugin.ts readService(ctx, 'dynamicCordisRunner')（B3 Guard：ctx.get 读取 + try/catch 降级）
//   → createCognitiveRuntime options.dynamicRunner → 实例字段 → runCandidatePipeline deps
//   （G3-exec 优先走 runner 通道；缺失/失败 → 受限子进程 fallback 诚实降级）。
// 覆盖：
//   ① 装配（plugin apply 白盒）：fake ctx（get 返回 dynamicCordisRunner 结构 fake）→ cognitive.dynamicRunner
//      === 注入 fake（readService 经 ctx.get 读取面被调用）
//   ② ctx 缺 dynamicCordisRunner / ctx.get 抛错（B3：真实宿主对未 inject 属性读取抛 cannot get property）
//      → 不注入（undefined），apply 不抛——诚实降级（管线走受限子进程路径，语义见 m8 ⑨ 不注入用例）
//   ③ assembly 选项 → 实例字段（createCognitiveRuntime({dynamicRunner}) 白盒；不注入 → undefined）
//   ④ 端到端 pipeline（参照 tests/m8/dynamic-runner.test.ts ③ 集成用例）：
//      - runCandidatePipeline 注入 fake runner → G3-exec 经 runner 通道执行成功（detail 含
//        dynamicCordisRunner；define/run/invoke/stop/undefine 捕获；未落受限子进程 exec 字段）
//      - runner 通道失败（run 拒绝）→ 回退受限子进程路径 + runnerFallback 记录（注入沙盒不可用 →
//        kind=degraded 确定性断言）
//      - runner 部分缺失（缺 invoke——结果读取通道缺失）→ 守卫降级回退（reason 点名 invoke）
//      - 不注入 dynamicRunner → 既有受限子进程路径零变化（detail 不含 dynamicCordisRunner）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../kernel/policy-loader.js';
import { ensureLineSnapshot } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import {
  runCandidatePipeline,
  validateDataCandidate,
} from '../../supervisor/candidate-pipeline.js';
import type { DynamicCordisRunnerLike } from '../../supervisor/dynamic-runner.js';
import type { CandidateDraft } from '../../kernel/schemas/evolution.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import {
  buildLayoutFixture,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

// ---- fake runner（真实宿主面缺失 → 注入；结构对齐 DynamicCordisRunnerLike——m8 同款） ----

type FakeCall =
  | { op: 'define'; def: unknown }
  | { op: 'run'; agent: { id: string }; pluginId: string; packageId: string; mode: string }
  | { op: 'stop'; agent: { id: string }; pluginId: string }
  | { op: 'undefine'; agent: { id: string }; pluginId: string }
  | { op: 'invoke'; pluginId: string; pluginRunId: string; method: string; args: unknown };

/**
 * fake dynamicCordisRunner：define 同步返回回执（真实宿主 define 为同步，index.ts:151）、run 生效、
 * invoke 返回 {ok:true, value:{ok:true,detail:'fake verify ok'}}、stop/undefine 成功。
 * 通过 overrides 注入失败路径（抛错/拒绝）以测回滚与降级。
 */
function makeFakeRunner(
  overrides: Partial<Record<'define' | 'run' | 'stop' | 'undefine' | 'invoke', (...args: never[]) => unknown>> = {},
): { runner: DynamicCordisRunnerLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const runner: DynamicCordisRunnerLike = {
    define: ((def: unknown) => {
      calls.push({ op: 'define', def });
      const d = def as { name: string; purpose: string };
      return { pluginId: 'ombvfy-1', packageId: 'pkg-1', name: d.name, purpose: d.purpose, hasHostHalf: true, hasClientHalf: false };
    }) as DynamicCordisRunnerLike['define'],
    run: (async (agent: { id: string }, pluginId: string, packageId: string, mode: string) => {
      calls.push({ op: 'run', agent, pluginId, packageId, mode });
      return { ok: true, status: 'running', pluginId, packageId, pluginRunId: 'run-1', waitingFor: [], mode };
    }) as DynamicCordisRunnerLike['run'],
    stop: (async (agent: { id: string }, pluginId: string) => {
      calls.push({ op: 'stop', agent, pluginId });
      return { ok: true };
    }) as DynamicCordisRunnerLike['stop'],
    undefine: (async (agent: { id: string }, pluginId: string) => {
      calls.push({ op: 'undefine', agent, pluginId });
      return { ok: true, wasRunning: true };
    }) as DynamicCordisRunnerLike['undefine'],
    invoke: (async (pluginId: string, pluginRunId: string, method: string, args: unknown) => {
      calls.push({ op: 'invoke', pluginId, pluginRunId, method, args });
      return { ok: true, value: { ok: true, detail: 'fake verify ok' } };
    }) as DynamicCordisRunnerLike['invoke'],
  };
  for (const key of Object.keys(overrides) as Array<'define' | 'run' | 'stop' | 'undefine' | 'invoke'>) {
    const fn = overrides[key]!;
    (runner as Record<string, unknown>)[key] = ((...args: unknown[]) => {
      if (key === 'define') {
        calls.push({ op: 'define', def: args[0] });
      } else if (key === 'run') {
        calls.push({
          op: 'run',
          agent: args[0] as { id: string },
          pluginId: String(args[1]),
          packageId: String(args[2]),
          mode: String(args[3]),
        });
      } else if (key === 'stop') {
        calls.push({ op: 'stop', agent: args[0] as { id: string }, pluginId: String(args[1]) });
      } else if (key === 'undefine') {
        calls.push({ op: 'undefine', agent: args[0] as { id: string }, pluginId: String(args[1]) });
      } else if (key === 'invoke') {
        calls.push({ op: 'invoke', pluginId: String(args[0]), pluginRunId: String(args[1]), method: String(args[2]), args: args[3] });
      }
      return (fn as (...a: unknown[]) => unknown)(...args);
    }) as never;
  }
  return { runner, calls };
}

// ---- 候选/验证脚本工具（m8 同款） ----

function buildCandidateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omb-w3-runner-root-'));
}

function draft(
  target: string,
  content: string,
  opts: { signal?: string; verify?: string } = {},
): CandidateDraft {
  return {
    id: `sha256:${createHash('sha256').update(`${target}\u0000${content}`).digest('hex').slice(0, 12)}`,
    seq: 0,
    kind: 'policy',
    target,
    content,
    diff: `${target}: 测试变更`,
    motivation: `signal ${opts.signal ?? 'corrections'} 测试`,
    signal: opts.signal ?? 'corrections',
    change: { path: 'test.path', old: 0, new: 1 },
    ...(opts.verify !== undefined ? { verify: { script: opts.verify } } : {}),
  };
}

async function evolveTweakContent(): Promise<string> {
  const p = await loadPolicy();
  const evolve = {
    ...p.evolve,
    signal_triggers: {
      ...p.evolve.signal_triggers,
      corrections: { ...p.evolve.signal_triggers.corrections!, strength: 0.95 },
    },
  };
  return dumpYaml(evolve);
}

/** runner 通道验证脚本（host 半契约：经 harness.handle('verify', handler) 注册裁决——结果读取契约） */
const SCRIPT_RUNNER = `harness.handle('verify', (args) => ({ ok: true, detail: 'runner verify ok' })); return { apply(ctx) {} };`;

/** 受限子进程路径合法脚本（文件契约：写 OMB_SANDBOX_RESULT_FILE + 尝试写候选目录被拒） */
const SCRIPT_RESTRICTED_OK = `const fs = require('node:fs');
const path = require('node:path');
const resultFile = process.env.OMB_SANDBOX_RESULT_FILE;
const candDir = process.argv[2];
let probe = null;
try {
  fs.writeFileSync(path.join(candDir, 'write-probe.txt'), 'x');
  probe = 'LEAK';
} catch (e) {
  probe = e && e.code ? e.code : String(e);
}
const ok = probe === 'EPERM' || probe === 'EACCES';
fs.writeFileSync(resultFile, JSON.stringify({ ok, detail: 'verify ok; write-denied=' + probe }));
`;

// ---- fixture 布局工具（m8 candidate-pipeline 同款） ----

function makeLayout(fx: LayoutFixture): VersionLayout {
  return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
}

/** 物化线快照 → policy 目录（P1a 目录注入同款） */
async function baselinePolicyDirOf(fx: LayoutFixture): Promise<string> {
  const snap = ensureLineSnapshot(makeLayout(fx), 'latest');
  return path.join(snap.dir, 'kernel', 'policy');
}

function poolRootOf(fx: LayoutFixture): string {
  return path.join(fx.root, 'workspace', '.omb', '.evolution');
}

// ---- 装配 ①/②：plugin apply 读取 ctx.dynamicCordisRunner → createCognitiveRuntime 收到 dynamicRunner ----

let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-w3-wiring-'));
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close().catch(() => undefined);
  }
  runtimes = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

/** 插件装配路径的 fake ctx：真实宿主形状（commands 注册面 + get 免 inject 服务读取面） */
function makePluginCtx(getImpl: (name: string) => unknown): { ctx: ContextLike; getCalls: string[] } {
  const getCalls: string[] = [];
  const ctx: ContextLike = {
    commands: { register: () => undefined },
    get: (name: string) => {
      getCalls.push(name);
      return getImpl(name);
    },
  };
  return { ctx, getCalls };
}

/** 白盒读取 plugin 装配出的认知运行时的 dynamicRunner 实例字段 */
function injectedDynamicRunner(cognitive: unknown): unknown {
  return (cognitive as { dynamicRunner?: unknown }).dynamicRunner;
}

describe('W3 装配 ①：plugin apply 读取 ctx.dynamicCordisRunner → createCognitiveRuntime 收到 dynamicRunner', () => {
  it('fake ctx（get 返回 dynamicCordisRunner 结构 fake）→ cognitive.dynamicRunner === 注入 fake；get 读取面被调用', () => {
    const { runner } = makeFakeRunner();
    const { ctx, getCalls } = makePluginCtx((name) => (name === 'dynamicCordisRunner' ? runner : undefined));
    const r = apply(ctx, { bootstrap: false, cognitiveRoot: root });
    expect(r.cognitive).toBeDefined();
    // 白盒：装配出的运行时实例字段收到注入（plugin → options → 实例字段）
    expect(injectedDynamicRunner(r.cognitive)).toBe(runner);
    // 宿主服务经 ctx.get 读取（B3 Guard 契约：未 inject 属性直接读取抛错）
    expect(getCalls).toContain('dynamicCordisRunner');
    track(r.cognitive as CognitiveRuntime);
  });

  it('ctx 缺 dynamicCordisRunner（get 返回 undefined）→ 不注入（dynamicRunner undefined）——管线走受限子进程路径（语义不变）', () => {
    const { ctx } = makePluginCtx(() => undefined);
    const r = apply(ctx, { bootstrap: false, cognitiveRoot: root });
    expect(r.cognitive).toBeDefined();
    expect(injectedDynamicRunner(r.cognitive)).toBeUndefined();
    track(r.cognitive as CognitiveRuntime);
  });

  it('ctx.get 对 dynamicCordisRunner 抛错（B3：未 inject 属性读取抛 cannot get property）→ apply 不抛、不注入（诚实降级）', () => {
    const { ctx } = makePluginCtx((name) => {
      if (name === 'dynamicCordisRunner') {
        throw new Error('cannot get property "dynamicCordisRunner" without inject');
      }
      return undefined;
    });
    let r: ReturnType<typeof apply>;
    expect(() => {
      r = apply(ctx, { bootstrap: false, cognitiveRoot: root });
    }).not.toThrow(); // B3：读取抛错 → try/catch 降级，不阻断装配
    expect(r!.cognitive).toBeDefined();
    expect(injectedDynamicRunner(r!.cognitive)).toBeUndefined();
    track(r!.cognitive as CognitiveRuntime);
  });
});

describe('W3 装配 ③：assembly 选项 → 实例字段（runCandidatePipeline deps 注入面直接消费方）', () => {
  it('createCognitiveRuntime({dynamicRunner}) → 实例字段收到；不注入 → undefined', () => {
    const { runner } = makeFakeRunner();
    const rt = track(createCognitiveRuntime({ root, dynamicRunner: runner }));
    expect(rt.dynamicRunner).toBe(runner);

    const rt2 = track(createCognitiveRuntime({ root: path.join(root, 'no-runner') }));
    expect(rt2.dynamicRunner).toBeUndefined();
  });
});

// ---- 端到端 ④：pipeline 注入 fake runner → G3-exec 通道/回退/守卫 ----

describe('W3 端到端 ④：候选验证增强通道（参照 m8 dynamic-runner ③ 集成用例）', () => {
  fixtureIt('runCandidatePipeline 注入 fake runner → G3-exec 经 runner 通道执行成功（detail 含 dynamicCordisRunner；define/run/invoke/stop/undefine 捕获；未落受限子进程）', async () => {
    const fx = buildLayoutFixture();
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner, calls } = makeFakeRunner();
      const outcome = await runCandidatePipeline(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RUNNER }),
        {
          layout: makeLayout(fx),
          evolutionRoot: poolRootOf(fx),
          baselinePolicyDir: await baselinePolicyDirOf(fx),
          dynamicRunner: runner,
          sessionId: 'w3-sess-1',
        },
      );
      expect(outcome.validated).toBe(true);
      expect(outcome.gates.g3Exec?.kind).toBe('exec');
      expect(outcome.gates.g3Exec?.ok).toBe(true);
      // 通道详情（受限子进程路径无此字段）+ detail 点名 dynamicCordisRunner
      expect(outcome.gates.g3Exec?.detail).toContain('dynamicCordisRunner');
      expect(outcome.gates.g3Exec?.runner).toEqual({
        pluginId: 'ombvfy-1',
        packageId: 'pkg-1',
        pluginRunId: 'run-1',
        verdict: { ok: true, detail: 'fake verify ok' },
        stopped: true,
        undefined: true,
      });
      // 未走受限子进程（exec 字段仅受限路径有）
      expect(outcome.gates.g3Exec?.exec).toBeUndefined();
      // 通道调用捕获：define（无副作用登记）→ run（生效）→ invoke（结果读取）→ stop（回退）→ undefine（先停后忘）
      expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'invoke', 'stop', 'undefine']);
      // 会话归属契约：define.sessionId / run.agent.id = 注入 sessionId
      const def = calls.find((c) => c.op === 'define') as Extract<FakeCall, { op: 'define' }> | undefined;
      expect((def?.def as { sessionId: string }).sessionId).toBe('w3-sess-1');
      const run = calls.find((c) => c.op === 'run') as Extract<FakeCall, { op: 'run' }> | undefined;
      expect(run?.agent).toEqual({ id: 'w3-sess-1' });
      // G1/G3-replay 照常
      expect(outcome.gates.g1?.ok).toBe(true);
      expect(outcome.gates.g3?.ok).toBe(true);
    } finally {
      teardownLayoutFixture(fx);
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 通道失败（run 拒绝）→ 降级回退受限子进程路径 + runnerFallback 记录（注入沙盒不可用 → kind=degraded，门禁语义保持）', async () => {
    const fx = buildLayoutFixture();
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner({
        run: (async () => ({ ok: false, reason: 'host-half-failed', message: 'script crashed' })) as never,
      });
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }),
        {
          baselinePolicyDir: await baselinePolicyDirOf(fx),
          candidateRoot,
          dynamicRunner: runner,
          sandboxStatus: () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        },
      );
      expect(r.passed).toBe(true); // 降级不阻塞门禁语义（G1/G3-replay 照常）
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.ok).toBe(true);
      // runnerFallback 记录：通道失败 → 回退受限子进程路径
      expect(r.gates.g3Exec?.degraded).toMatch(/回退|dynamicCordisRunner/);
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      teardownLayoutFixture(fx);
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 部分缺失（缺 invoke——结果读取通道缺失）→ 守卫降级回退（reason 点名 invoke；注入沙盒不可用 → kind=degraded）', async () => {
    const fx = buildLayoutFixture();
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner();
      delete (runner as Partial<DynamicCordisRunnerLike>).invoke;
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }),
        {
          baselinePolicyDir: await baselinePolicyDirOf(fx),
          candidateRoot,
          dynamicRunner: runner,
          sandboxStatus: () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        },
      );
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      // 守卫降级原因点名 invoke + 回退受限子进程路径
      expect(r.gates.g3Exec?.degraded).toMatch(/invoke/);
      expect(r.gates.g3Exec?.degraded).toMatch(/回退/);
    } finally {
      teardownLayoutFixture(fx);
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('不注入 dynamicRunner → 既有受限子进程路径零变化（无 runner 字段；detail 不含 dynamicCordisRunner）', async () => {
    const fx = buildLayoutFixture();
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(
        draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }),
        {
          baselinePolicyDir: await baselinePolicyDirOf(fx),
          candidateRoot,
        },
      );
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(true);
      expect(r.gates.g3Exec?.exec?.code).toBe(0); // 受限子进程真实执行（结果文件回传 + 沙盒语义验证）
      expect(r.gates.g3Exec?.runner).toBeUndefined();
      expect(r.gates.g3Exec?.detail).not.toMatch(/dynamicCordisRunner/);
    } finally {
      teardownLayoutFixture(fx);
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });
});
