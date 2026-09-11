// S9 dynamicCordisRunner 接线测试（设计 §4.5 混合路线试验形态通道 + §3.4 受限子进程关系）。
// 覆盖：
//   ① 接口守卫（inspectDynamicRunner）：runner 缺失 / 部分缺失（define/run/stop/undefine/invoke）→ 通道不可用降级
//   ② runner 通道单元（runCandidateViaRunner + fake runner）：define 无副作用登记捕获（host-only 无 client →
//      run 无人工审批往返）、run 生效、invoke 结果读取（verify handler 契约）、stop 回退 dispose、undefine 先停后忘；
//      失败（define/run/invoke 抛错或拒绝）→ 回滚（best-effort stop/undefine）+ ok=false（调用方降级回退受限子进程）
//   ③ 候选验证增强通道集成（validateDataCandidate deps.dynamicRunner 注入面）：
//      runner 可用 → 候选验证经 runner（不落受限子进程）；verdict ok=false → 拒绝；
//      通道失败 → 降级回退受限子进程路径 + 记录；部分缺失 → 守卫降级；不注入 → 既有路径零变化
//   ④ 真实宿主面缺失 → 全部走 fake runner 注入（不要求真实 DSH 环境）
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../kernel/policy-loader.js';
import { ensureLineSnapshot } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { validateDataCandidate } from '../../supervisor/candidate-pipeline.js';
import {
  inspectDynamicRunner,
  runCandidateViaRunner,
  type DynamicCordisRunnerLike,
} from '../../supervisor/dynamic-runner.js';
import type { CandidateDraft } from '../../kernel/schemas/evolution.js';
import { buildLayoutFixture, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';
// 受限验证脚本平台无关化（写拒绝码随通道而异；真机教训见该模块说明）
import { restrictedVerifyScript } from '../helpers/sandbox-scripts.js';

const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

let fx: LayoutFixture | null = null;
let baselinePolicyDir = '';

beforeAll(async () => {
  fx = buildLayoutFixture();
  const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
  const snap = ensureLineSnapshot(layout, 'latest');
  baselinePolicyDir = path.join(snap.dir, 'kernel', 'policy');
});

afterAll(() => {
  if (fx) {
    teardownLayoutFixture(fx);
  }
  fx = null;
});

// ---- fake runner 工具 ----

type FakeCall =
  | { op: 'define'; def: unknown }
  | { op: 'run'; agent: { id: string }; pluginId: string; packageId: string; mode: string }
  | { op: 'stop'; agent: { id: string }; pluginId: string }
  | { op: 'undefine'; agent: { id: string }; pluginId: string }
  | { op: 'invoke'; pluginId: string; pluginRunId: string; method: string; args: unknown };

/**
 * fake dynamicCordisRunner（真实宿主面缺失 → 注入；结构对齐 DynamicCordisRunnerLike）。
 * 缺省行为：define 同步返回回执（真实宿主 define 为同步，index.ts:151）、run 生效、
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
    // 覆盖同样先记录调用（attempt 语义：抛错也留下调用痕迹）再委托给注入行为
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

// ---- 集成测试候选 ----

function buildCandidateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omb-runner-root-'));
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

/**
 * 受限子进程路径合法脚本（文件契约：写 OMB_SANDBOX_RESULT_FILE + 尝试写候选目录被拒）。
 * **平台无关**：写拒绝码由通道决定（Windows EPERM/EACCES、Linux bwrap EROFS、权限模型
 * EACCES/ERR_ACCESS_DENIED）——见 tests/helpers/sandbox-scripts.ts 的真机教训说明。
 */
const SCRIPT_RESTRICTED_OK = restrictedVerifyScript();

// ---------------------------------------------------------------------------
// ① 接口守卫（缺失/部分缺失 → 通道不可用降级）
// ---------------------------------------------------------------------------

describe('S9 接口守卫（inspectDynamicRunner：缺失/部分缺失 → 降级）', () => {
  it('runner 缺失（undefined/null）→ {available:false} + 机器可读 reason', () => {
    expect(inspectDynamicRunner(undefined)).toEqual({ available: false, reason: expect.stringContaining('缺失') });
    expect(inspectDynamicRunner(null as unknown as DynamicCordisRunnerLike)).toEqual({
      available: false,
      reason: expect.stringContaining('缺失'),
    });
  });

  it('define 缺失 → 部分缺失降级（reason 点名 define）', () => {
    const { runner } = makeFakeRunner();
    delete (runner as Partial<DynamicCordisRunnerLike>).define;
    const g = inspectDynamicRunner(runner);
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/define/);
  });

  it('run 非函数 → 部分缺失降级（reason 点名 run）', () => {
    const { runner } = makeFakeRunner();
    (runner as Record<string, unknown>).run = 42; // 直接赋值（绕过 fake 覆盖包装——守卫测非函数面）
    const g = inspectDynamicRunner(runner);
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/run/);
  });

  it('stop 缺失 → 部分缺失降级（reason 点名 stop）', () => {
    const { runner } = makeFakeRunner();
    delete (runner as Partial<DynamicCordisRunnerLike>).stop;
    const g = inspectDynamicRunner(runner);
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/stop/);
  });

  it('undefine 缺失 → 部分缺失降级（reason 点名 undefine）', () => {
    const { runner } = makeFakeRunner();
    delete (runner as Partial<DynamicCordisRunnerLike>).undefine;
    const g = inspectDynamicRunner(runner);
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/undefine/);
  });

  it('invoke 缺失（结果读取通道缺失）→ 部分缺失降级（reason 点名 invoke）', () => {
    const { runner } = makeFakeRunner();
    delete (runner as Partial<DynamicCordisRunnerLike>).invoke;
    const g = inspectDynamicRunner(runner);
    expect(g.available).toBe(false);
    expect(g.reason).toMatch(/invoke/);
  });

  it('完整 runner（define/run/stop/undefine/invoke 齐备）→ {available:true}', () => {
    const { runner } = makeFakeRunner();
    expect(inspectDynamicRunner(runner)).toEqual({ available: true });
  });
});

// ---------------------------------------------------------------------------
// ② runner 通道单元（fake runner：define/run/invoke/stop/undefine 调用捕获 + 回滚）
// ---------------------------------------------------------------------------

describe('S9 runner 通道（runCandidateViaRunner + fake runner）', () => {
  const OPTS = {
    runner: makeFakeRunner().runner,
    sessionId: 'sess-1',
    name: 'verify-candidate',
    purpose: 'OMB 候选验证',
    script: SCRIPT_RUNNER,
  };

  it('调用序与参数：define（host-only 登记）→ run → invoke verify → stop → undefine；返回 verdict + 回滚标志', async () => {
    const { runner, calls } = makeFakeRunner();
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(true);
    expect(r.verdict).toEqual({ ok: true, detail: 'fake verify ok' });
    expect(r.pluginId).toBe('ombvfy-1');
    expect(r.packageId).toBe('pkg-1');
    expect(r.pluginRunId).toBe('run-1');
    expect(r.stopped).toBe(true);
    expect(r.undefined).toBe(true);
    // 调用序（define 无副作用登记 → run 生效 → 结果读取 → stop 回退 → undefine 先停后忘）
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'invoke', 'stop', 'undefine']);
    // define 参数：session 归属 + 新插件 + host-only（无 client → run 无人工审批往返）
    const def = calls[0] as Extract<FakeCall, { op: 'define' }>;
    expect(def.def).toMatchObject({
      sessionId: 'sess-1',
      plugin: { kind: 'new', idPrefix: expect.stringMatching(/^[a-z]{3,6}$/) },
      name: 'verify-candidate',
      purpose: 'OMB 候选验证',
      code: { host: SCRIPT_RUNNER },
    });
    expect((def.def as { code: { client?: string } }).code.client).toBeUndefined();
    // run 参数：agent.id = sessionId + mode 'run'（新插件首次激活）
    const run = calls[1] as Extract<FakeCall, { op: 'run' }>;
    expect(run.agent).toEqual({ id: 'sess-1' });
    expect(run.mode).toBe('run');
    // invoke 结果读取：verify handler 契约 + null args
    const inv = calls[2] as Extract<FakeCall, { op: 'invoke' }>;
    expect(inv.method).toBe('verify');
    expect(inv.args).toBeNull();
  });

  it('define 同步返回回执（真实宿主 define 为同步，index.ts:151）也可——await 兼容', async () => {
    const { runner, calls } = makeFakeRunner();
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(true);
    expect(calls[0]?.op).toBe('define');
  });

  it('verdict 读取：invoke value {ok:false, detail} → 通道 ok=true + verdict.ok=false（脚本报告失败 ≠ 通道失败）', async () => {
    const { runner } = makeFakeRunner({
      invoke: (async () => ({ ok: true, value: { ok: false, detail: 'verification failed' } })) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(true); // 通道完整执行（define→run→invoke→stop→undefine）
    expect(r.verdict).toEqual({ ok: false, detail: 'verification failed' });
    expect(r.stopped).toBe(true);
    expect(r.undefined).toBe(true);
  });

  it('define 抛错 → ok=false + reason，且不调 run/stop/undefine（未登记无可回滚）', async () => {
    const { runner, calls } = makeFakeRunner({
      define: (() => {
        throw new Error('define boom');
      }) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/define/);
    expect(r.stopped).toBe(false);
    expect(r.undefined).toBe(false);
    // 仅 define 被尝试（抛错即止）；run/stop/undefine 均未调用（未登记无可回滚）
    expect(calls.map((c) => c.op)).toEqual(['define']);
  });

  it('run 拒绝（{ok:false}）→ 通道失败 + 回滚（stop/undefine 仍被调用）', async () => {
    const { runner, calls } = makeFakeRunner({
      run: (async () => ({ ok: false, reason: 'host-half-failed', message: 'script crashed' })) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/host-half-failed|script crashed/);
    expect(r.stopped).toBe(true); // 回滚：stop 调用成功
    expect(r.undefined).toBe(true); // 回滚：undefine 调用成功
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'stop', 'undefine']);
  });

  it('run 抛错 → 通道失败 + 回滚（stop/undefine 仍被调用）', async () => {
    const { runner, calls } = makeFakeRunner({
      run: (async () => {
        throw new Error('run boom');
      }) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/run/);
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'stop', 'undefine']);
  });

  it('invoke 抛错（结果读取失败）→ 通道失败 + 回滚（stop/undefine 仍被调用）', async () => {
    const { runner, calls } = makeFakeRunner({
      invoke: (async () => {
        throw new Error('invoke boom');
      }) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invoke|结果读取/);
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'invoke', 'stop', 'undefine']);
  });

  it('invoke 返回 {ok:false, code:"method-not-found"}（脚本未注册 verify handler）→ 通道失败 + 回滚', async () => {
    const { runner, calls } = makeFakeRunner({
      invoke: (async () => ({ ok: false, code: 'method-not-found', message: 'no verify handler' })) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/method-not-found|verify/);
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'invoke', 'stop', 'undefine']);
  });

  it('回滚 best-effort：stop 失败（抛错）→ 仍调 undefine；stop {ok:false,not-running} 视为已停', async () => {
    const { runner, calls } = makeFakeRunner({
      run: (async () => ({ ok: false, reason: 'plugin-missing', message: 'gone' })) as never,
      stop: (async () => {
        throw new Error('stop boom');
      }) as never,
    });
    const r = await runCandidateViaRunner({ ...OPTS, runner });
    expect(r.ok).toBe(false);
    expect(r.stopped).toBe(false); // stop 抛错 → 未成功（best-effort 失败记录）
    expect(r.undefined).toBe(true); // undefine 仍执行
    expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'stop', 'undefine']);

    const { runner: runner2, calls: calls2 } = makeFakeRunner({
      run: (async () => ({ ok: false, reason: 'plugin-missing', message: 'gone' })) as never,
      stop: (async () => ({ ok: false, reason: 'not-running', message: 'not running' })) as never,
    });
    const r2 = await runCandidateViaRunner({ ...OPTS, runner: runner2 });
    expect(r2.ok).toBe(false);
    expect(r2.stopped).toBe(true); // not-running = 已停（幂等语义）
    expect(calls2.map((c) => c.op)).toEqual(['define', 'run', 'stop', 'undefine']);
  });
});

// ---------------------------------------------------------------------------
// ③ 候选验证增强通道集成（validateDataCandidate deps.dynamicRunner 注入面）
// ---------------------------------------------------------------------------

describe('S9 候选验证增强通道（G3-exec deps.dynamicRunner 注入面）', () => {
  fixtureIt('runner 可用 → 候选验证经 runner 通道（define/run/invoke/stop/undefine），不落受限子进程；passed=true', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner, calls } = makeFakeRunner();
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RUNNER }), {
        baselinePolicyDir,
        candidateRoot,
        dynamicRunner: runner,
        sessionId: 'sess-42',
      });
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(true);
      // runner 通道详情（受限子进程路径无此字段）
      expect(r.gates.g3Exec?.runner).toEqual({
        pluginId: 'ombvfy-1',
        packageId: 'pkg-1',
        pluginRunId: 'run-1',
        verdict: { ok: true, detail: 'fake verify ok' },
        stopped: true,
        undefined: true,
      });
      // 未走受限子进程（exec 字段仅受限路径有）
      expect(r.gates.g3Exec?.exec).toBeUndefined();
      // 注入面传递：sessionId → define.sessionId（会话归属契约）
      const def = calls.find((c) => c.op === 'define') as Extract<FakeCall, { op: 'define' }> | undefined;
      expect((def?.def as { sessionId: string }).sessionId).toBe('sess-42');
      expect(calls.map((c) => c.op)).toEqual(['define', 'run', 'invoke', 'stop', 'undefine']);
      // G1/G3-replay 照常
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 通道 verdict ok=false（脚本报告失败）→ G3-exec 拒绝 → passed=false（通道已完整执行）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner({
        invoke: (async () => ({ ok: true, value: { ok: false, detail: 'verification failed' } })) as never,
      });
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RUNNER }), {
        baselinePolicyDir,
        candidateRoot,
        dynamicRunner: runner,
      });
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(false);
      expect(r.gates.g3Exec?.runner?.verdict).toEqual({ ok: false, detail: 'verification failed' });
      expect(r.passed).toBe(false);
      expect(r.reason).toContain('验证失败');
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 通道失败（run 拒绝）→ 降级回退受限子进程路径 + 记录（注入沙盒不可用 → kind=degraded，G1/G3-replay 照常）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner({
        run: (async () => ({ ok: false, reason: 'host-half-failed', message: 'script crashed' })) as never,
      });
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }), {
        baselinePolicyDir,
        candidateRoot,
        dynamicRunner: runner,
        sandboxStatus: async () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        // 本用例聚焦"runner 失败 → 回退受限路径"的降级记录（非降级放行语义）
        requireExecutionVerification: false,
      });
      expect(r.passed).toBe(true); // 部署方显式接受降级时不阻塞门禁语义
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.ok).toBe(true);
      // 回退记录：runner 通道失败 → 回退受限子进程路径（受限通道也不可用 → D5 降级）
      expect(r.gates.g3Exec?.degraded).toMatch(/回退|dynamicCordisRunner/);
      expect(r.gates.g3Exec?.detail).toMatch(/降级|跳过/);
      expect(r.gates.g1?.ok).toBe(true);
      expect(r.gates.g3?.ok).toBe(true);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 通道失败 → 降级回退受限子进程路径成功（真实受限执行；kind=exec + runnerFallback 记录）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner({
        run: (async () => ({ ok: false, reason: 'host-half-failed', message: 'script crashed' })) as never,
      });
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }), {
        baselinePolicyDir,
        candidateRoot,
        dynamicRunner: runner,
      });
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(true);
      // 回退后受限子进程真实执行（结果文件回传 + 沙盒语义验证）
      expect(r.gates.g3Exec?.exec?.code).toBe(0);
      expect(r.gates.g3Exec?.detail).toMatch(/回退|dynamicCordisRunner/);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('runner 部分缺失（define 缺失）→ 守卫降级 → 受限子进程路径（注入沙盒不可用 → kind=degraded，reason 点名 define）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const { runner } = makeFakeRunner();
      delete (runner as Partial<DynamicCordisRunnerLike>).define;
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }), {
        baselinePolicyDir,
        candidateRoot,
        dynamicRunner: runner,
        sandboxStatus: async () => ({ available: false, reason: 'koffi 缺失（模拟）' }),
        requireExecutionVerification: false,
      });
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('degraded');
      expect(r.gates.g3Exec?.degraded).toMatch(/define/);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  fixtureIt('不注入 dynamicRunner → 既有受限子进程路径零变化（无 runner 字段；kind=exec 受限执行）', async () => {
    const candidateRoot = buildCandidateRoot();
    try {
      const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', await evolveTweakContent(), { verify: SCRIPT_RESTRICTED_OK }), {
        baselinePolicyDir,
        candidateRoot,
      });
      expect(r.passed).toBe(true);
      expect(r.gates.g3Exec?.kind).toBe('exec');
      expect(r.gates.g3Exec?.ok).toBe(true);
      expect(r.gates.g3Exec?.exec?.code).toBe(0);
      expect(r.gates.g3Exec?.runner).toBeUndefined();
      expect(r.gates.g3Exec?.detail).not.toMatch(/dynamicCordisRunner/);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
  });
});
