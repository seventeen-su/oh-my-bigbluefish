// P1d /evolve 全链测试（runtime/plugin.ts 命令面 + runtime/assembly.ts runEvolutionNow 扩展）：
// 判定（evolve.policy 数据化）→ 候选生成（信号驱动确定性生成器）→ 逐候选验证（G1/G2/G3/G4）→
// 首个通过者晋升（txn 提交 → trusted-latest 推进 → Evolution Object → evolution/promoted 事件）→ 摘要。
// 使用临时 fixture 布局（buildLayoutFixture：trusted-latest + policy/processes 种子），真实 git 操作。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { appendSignals } from '../../runtime/evolution-signals.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import { resolveLineCommit, ensureLineSnapshot } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { CandidatePool, candidateDirName } from '../../supervisor/candidates.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

const SESSION = 'sess-evolve-chain';

/** fixture 重测试包装（全量套件并行 git/icacls 饱和 → 放宽超时防 flake） */
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, 30000);

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

describe('/evolve 全链（判定 → 生成 → 验证 → 晋升 → 摘要）', () => {
  fixtureIt('触发信号（corrections×3）→ 生成候选 → G1+G3 通过 → 晋升 → trusted-latest 推进 + promoted 事件 + 对象落提交', async () => {
    fx = buildLayoutFixture();
    const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
    const root = join(fx.root, 'workspace', '.omb');
    const evolutionRoot = join(root, '.evolution');
    const before = resolveLineCommit(layout, 'latest');
    scheduler = new MaintenanceScheduler({ debtFile: join(root, 'debt.json') });
    const runtime = track(
      createCognitiveRuntime({
        root,
        layout,
        maintenance: scheduler,
        signalsDir: join(evolutionRoot, 'signals'),
      }),
    );
    // 单触发信号（corrections×3）→ 确定性单一候选（strength 0.9→1.0）
    await appendSignals(runtime.signalsDir, [
      { ts: Date.now(), kind: 'corrections', payload: { count: 3 } },
    ]);

    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));

    // 摘要：判定 + 候选数 + 晋升信息
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=true');
    expect(r.text).toContain('候选');
    expect(r.text).toContain('晋升');

    // trusted-latest 推进到新 commit（首个通过者晋升）
    const after = resolveLineCommit(layout, 'latest');
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{40}$/);

    // 线内容含新策略（物化新快照 → 新 strength 生效）
    const snap = ensureLineSnapshot(layout, 'latest');
    expect(snap.commit).toBe(after);
    const policy = parseYaml(await readFile(join(snap.dir, 'kernel', 'policy', 'evolve.yaml'), 'utf8')) as {
      signal_triggers: { corrections: { strength: number } };
    };
    expect(policy.signal_triggers.corrections.strength).toBeGreaterThan(0.9);

    // evolution/promoted 事件入链（payload 含 object id/candidate id/commit）
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    const promoted = events.find((e) => e.type === 'evolution/promoted')!;
    expect(promoted).toBeDefined();
    const payload = promoted.payload as Record<string, unknown>;
    expect(typeof payload.object_id).toBe('string');
    expect(typeof payload.candidate_id).toBe('string');
    expect(payload.commit).toBe(after);
    // evolution/candidate（stage=generated，真实候选 id）
    const generated = events.filter((e) => e.type === 'evolution/candidate');
    expect(generated.some((e) => (e.payload as Record<string, unknown>).stage === 'generated')).toBe(true);

    // 信任池：晋升候选 trusted
    const pool = new CandidatePool(evolutionRoot);
    const counts = await pool.counts();
    expect(counts.trusted).toBeGreaterThan(0);

    // Evolution Object 落提交（.evolution-objects/）
    const objId = String(payload.object_id);
    const objRaw = runGit(['show', `${after}:.evolution-objects/${candidateDirName(objId)}.json`], { gitDir: fx.bare });
    expect(objRaw).toContain('"id"');
    expect(objRaw).toContain('"evolution/promoted"');
  });

  fixtureIt('无触发信号 → 摘要 should_evolve=false，不生成候选、不推进 trusted-latest；P1e 晋升检查仍判已有 trusted-latest（stable ← trusted-latest 显式门禁推进）', async () => {
    fx = buildLayoutFixture();
    const layout: VersionLayout = { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
    const root = join(fx.root, 'workspace', '.omb');
    const evolutionRoot = join(root, '.evolution');
    const before = resolveLineCommit(layout, 'latest');
    const stableBefore = resolveLineCommit(layout, 'stable');
    const runtime = track(
      createCognitiveRuntime({ root, layout, signalsDir: join(evolutionRoot, 'signals') }),
    );
    await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'tool_calls', payload: { count: 3 } }]);

    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=false');

    // 候选管线未跑（无触发信号）→ trusted-latest 指针未动
    expect(resolveLineCommit(layout, 'latest')).toBe(before);
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    expect(events.some((e) => e.type === 'evolution/candidate')).toBe(false);
    // P1e：晋升检查独立于演化判定——fixture 基线 trusted-latest 已领先 stable → 显式门禁推进（stable = latestHash）
    const promoted = events.find((e) => e.type === 'evolution/promoted');
    expect(promoted).toBeDefined();
    expect((promoted!.payload as Record<string, unknown>).stage).toBe('stable');
    expect(resolveLineCommit(layout, 'stable')).not.toBe(stableBefore);
    expect(r.text).toContain('晋升检查');
  });
});
