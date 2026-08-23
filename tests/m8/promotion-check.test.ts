// P1e promotion_check 维护任务与 /evolve 摘要扩展测试（runtime/assembly.ts runEvolutionNow +
// runtime/plugin.ts /evolve 命令面）。
// 覆盖（brief 测试清单 5）：
//   ① /evolve 摘要含晋升检查结果：触发信号 → 候选晋升 trusted-latest → 晋升检查通过 → stable 推进
//   ② 无 trusted-latest 待晋升（stable == trusted-latest）→ 晋升检查跳过（记录）
//   ③ 生产旧布局（显式 policyDir 注入、无线快照）→ 晋升检查降级跳过（记录）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { appendSignals } from '../../runtime/evolution-signals.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import { resolveLineCommit, ensureLineSnapshot } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { buildLayoutFixture, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

const SESSION = 'sess-promotion-check';
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

interface CapturedCommand {
  name: string;
  handler: (invocation: {
    commandId: unknown;
    agent: { session?: { id?: string; events?: ReadonlyArray<{ type?: string }> } };
    rawInput: string;
    signal: unknown;
  }) => Promise<{ kind: 'success' | 'error'; text: string }>;
}

function makeInvocation(rawInput: string, sessionId?: string): Parameters<CapturedCommand['handler']>[0] {
  return { commandId: 'test-cmd', agent: { session: { id: sessionId, events: [] } }, rawInput, signal: undefined };
}

function makeFakeCtx(opts: { runtime?: CognitiveRuntime }): { captured: CapturedCommand[]; ctx: ContextLike } {
  const captured: CapturedCommand[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
    cognitive: opts.runtime,
  };
  return { captured, ctx };
}

let fx: LayoutFixture | null;
let scheduler: MaintenanceScheduler | null;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  fx = null;
  scheduler = null;
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  scheduler?.stop();
  scheduler = null;
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  if (fx) {
    teardownLayoutFixture(fx);
  }
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

describe('promotion_check 维护任务与 /evolve 摘要扩展（P1e）', () => {
  fixtureIt('① 触发信号 → 候选晋升 trusted-latest → 晋升检查通过 → stable 推进 + 摘要含晋升结果', async () => {
    fx = buildLayoutFixture();
    const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
    const root = join(fx.root, 'workspace', '.omb');
    const evolutionRoot = join(root, '.evolution');
    scheduler = new MaintenanceScheduler({ debtFile: join(root, 'debt.json') });
    const runtime = track(
      createCognitiveRuntime({
        root,
        layout,
        maintenance: scheduler,
        signalsDir: join(evolutionRoot, 'signals'),
      }),
    );
    // 单触发信号（corrections×3）→ 确定性单一候选（strength 0.9→1.0）→ 晋升 trusted-latest
    await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'corrections', payload: { count: 3 } }]);

    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));

    // 摘要：判定 + 候选晋升 + 晋升检查
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=true');
    expect(r.text).toContain('晋升检查');

    // 晋升检查通过 → stable 推进到 trusted-latest commit（闭环最后一环）
    const latest = resolveLineCommit(layout, 'latest');
    const stable = resolveLineCommit(layout, 'stable');
    expect(stable).toBe(latest);
    expect(stable).toMatch(/^[0-9a-f]{40}$/);

    // 线内容含新策略（物化 stable 快照 → 新 strength 生效）
    const snap = ensureLineSnapshot(layout, 'stable');
    const policy = parseYaml(await readFile(join(snap.dir, 'kernel', 'policy', 'evolve.yaml'), 'utf8')) as {
      signal_triggers: { corrections: { strength: number } };
    };
    expect(policy.signal_triggers.corrections.strength).toBeGreaterThan(0.9);

    // activation/committed + evolution/promoted（stable 晋升）事件入链
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    expect(events.some((e) => e.type === 'activation/committed')).toBe(true);
    const promoted = events.filter((e) => e.type === 'evolution/promoted');
    expect(promoted.length).toBeGreaterThanOrEqual(2); // trusted-latest 晋升 + stable 晋升
  });

  fixtureIt('② 无待晋升（stable == trusted-latest）→ 晋升检查跳过（记录，不推进）', async () => {
    fx = buildLayoutFixture();
    const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
    const root = join(fx.root, 'workspace', '.omb');
    const evolutionRoot = join(root, '.evolution');
    // 直接推进 stable = trusted-latest（模拟已晋升状态——无待晋升内容）
    execFileSync('git', ['--git-dir=' + fx.bare, 'update-ref', 'refs/heads/stable', fx.latestHash], { encoding: 'utf8' });
    const runtime = track(createCognitiveRuntime({ root, layout, signalsDir: join(evolutionRoot, 'signals') }));
    // 无触发信号（tool_calls 为记账型 evolve:false）→ 候选管线不跑 → trusted-latest 不动 == stable → 晋升检查跳过
    await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'tool_calls', payload: { count: 3 } }]);
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));

    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=false');
    expect(r.text).toContain('晋升检查');
    expect(r.text).toContain('跳过'); // stable == trusted-latest → 无待晋升，跳过
    expect(resolveLineCommit(layout, 'stable')).toBe(fx.latestHash); // 未推进
  });

  fixtureIt('③ 生产旧布局（显式 policyDir 注入、无线快照）→ 晋升检查降级跳过（记录）', async () => {
    // 旧布局：显式 policyDir/processesDir → resolveLineDirs 短路 → lineSnapshot=null（生产降级路径）。
    // 不需要 git fixture——独立临时目录作认知根（不触碰真实 versions.git）。
    const base = await mkdtemp(join(tmpdir(), 'omb-old-layout-'));
    let runtime: CognitiveRuntime | null = null;
    try {
      const root = join(base, 'workspace', '.omb');
      const evolutionRoot = join(root, '.evolution');
      runtime = track(
        createCognitiveRuntime({
          root,
          policyDir: join(process.cwd(), 'kernel', 'policy'),
          processesDir: join(process.cwd(), 'kernel', 'processes'),
          signalsDir: join(evolutionRoot, 'signals'),
        }),
      );
      await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'corrections', payload: { count: 3 } }]);
      const { captured, ctx } = makeFakeCtx({ runtime });
      apply(ctx, { bootstrap: false });
      const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('晋升检查');
      expect(r.text).toContain('跳过');
    } finally {
      // 先关库（SQLite WAL 句柄释放）再删目录（防 EBUSY）
      if (runtime !== null) {
        await runtime.close();
      }
      await rm(base, { recursive: true, force: true });
    }
  });
});
