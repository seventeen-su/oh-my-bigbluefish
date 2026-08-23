// P1b 行为测试：提交级运行时快照生产接入（D1⑤：请求运行于「线 stable + commit a81f + 快照 rs:7c91」）。
// 覆盖：
//   按线哈希确定性：同 fixture 同线两次装配 → 同 snapshotHash；不同线（stable vs latest）→ 不同哈希
//   请求级锁定（§6.5.7）：prepareTurn 绑定快照 → rebuildSnapshotForLine('latest') promote →
//     进行中请求不受影响（finalize 的 decision/made provenance 用绑定快照）；下一请求用新快照
//   /mode 切换重建（plugin 级 fakeCtx）：onSwitch → rebuildSnapshotForLine → snapshotHash 变化（下一请求生效）；
//     物化失败 → 降级记录 + 快照保持
//   降级路径：lines 不可用（stable 引用缺失）→ 装配不崩，快照仍可计算（回退 git HEAD + 内容哈希）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

/** 把 fixture 布局映射为 lines 的 VersionLayout（与 tests/m0/lines.test.ts 同款） */
function layoutFor(fx: LayoutFixture): { bareRepo: string; stableWorktree: string; latestWorktree: string } {
  return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
}

/** 最小请求（prepareTurn 输入） */
function req(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    goal: 'P1b 快照测试目标',
    success_criteria: ['c1'],
    constraints: [],
    working_state: {
      goal: 'P1b 快照测试目标',
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
let fx: LayoutFixture;
let runtimes: CognitiveRuntime[];

/** fixture 构建超时（buildLayoutFixture：2 提交 + 3 worktree + 2 icacls；全量套件并行时 git/icacls 饱和
 *  （已知 flake 类：rollback/boot/txn-capability 同款，见 commands.test.ts 注释）→ 放宽防环境超时） */
const FIXTURE_TIMEOUT = 20000;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-lsnap-'));
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close().catch(() => undefined);
  }
  runtimes = [];
  if (fx !== undefined) {
    teardownLayoutFixture(fx);
    fx = undefined as unknown as LayoutFixture;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

describe('P1b 按线快照哈希（装配期：线 commit + 目录内容 + 组件哈希）', () => {
  it('确定性：同 fixture 同线两次装配 → 同 snapshotHash（rs:<16hex> 格式）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const a = track(createCognitiveRuntime({ root: path.join(base, 'a'), line: 'stable', layout: lay }));
    const b = track(createCognitiveRuntime({ root: path.join(base, 'b'), line: 'stable', layout: lay }));
    expect(a.snapshotHash).toMatch(/^rs:[0-9a-f]{16}$/);
    expect(b.snapshotHash).toBe(a.snapshotHash);
  }, FIXTURE_TIMEOUT);

  it('不同版本线（不同 commit）→ 不同 snapshotHash（stable=initial 基线 vs latest=latest 基线）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    const stable = track(createCognitiveRuntime({ root: path.join(base, 'stable'), line: 'stable', layout: lay }));
    const latest = track(createCognitiveRuntime({ root: path.join(base, 'latest'), line: 'latest', layout: lay }));
    expect(stable.snapshotHash).not.toBe(latest.snapshotHash);
    // 线快照信息就绪（P1a 装配注入衔接：lineSnapshot.commit 纳入哈希）
    expect(stable.lineSnapshot?.commit).toBe(fx.initialHash);
    expect(latest.lineSnapshot?.commit).toBe(fx.latestHash);
  }, FIXTURE_TIMEOUT);

  it('降级路径：lines 不可用（stable 引用缺失）→ 装配不崩，快照仍可计算（回退既有实现 git HEAD + 内容哈希）', () => {
    fx = buildLayoutFixture();
    const lay = layoutFor(fx);
    runGit(['update-ref', '-d', 'refs/heads/stable'], { cwd: fx.bare });
    const runtime = track(createCognitiveRuntime({ root: path.join(base, 'r'), line: 'stable', layout: lay }));
    expect(runtime.lineSnapshot).toBeNull();
    expect(runtime.lineDegraded).not.toBeNull();
    // 快照仍可计算（非 'rs:assembly' 全降级；回退路径正常产出）
    expect(runtime.snapshotHash).toMatch(/^rs:[0-9a-f]{16}$/);
    expect(runtime.snapshotHash).not.toBe('rs:assembly');
  }, FIXTURE_TIMEOUT);
});

describe('P1b 请求级快照锁定（§6.5.7：请求开始解析快照，整个请求只读该快照，晋升只影响后续请求）', () => {
  it('prepareTurn 绑定 → rebuildSnapshotForLine("latest") promote → 进行中请求不受影响（finalize 用绑定快照）；下一请求用新快照', async () => {
    fx = buildLayoutFixture();
    const runtime = track(createCognitiveRuntime({ root: path.join(base, 'r'), line: 'stable', layout: layoutFor(fx) }));
    const v1 = runtime.snapshotHash;

    // 请求 A：prepareTurn 绑定快照（整个请求锁定 v1）
    const pA = await runtime.prepareTurn(req('sess-A') as never);
    expect(pA.snapshot).toBe(v1);

    // /mode 切换：重建快照 → promote（只影响后续请求）
    const r = runtime.rebuildSnapshotForLine('latest');
    expect(r.promoted).toBe(true);
    expect(r.degraded).toBeNull();
    const v2 = runtime.snapshotHash;
    expect(v2).not.toBe(v1);

    // 请求 B（后续请求）→ 新快照 v2
    const pB = await runtime.prepareTurn(req('sess-B') as never);
    expect(pB.snapshot).toBe(v2);

    // 进行中请求 A 不受 promote 影响：finalize A 的 decision/made provenance = 绑定快照 v1
    await runtime.finalizeTurn({ session_id: 'sess-A', decision: pA.decision, working_state: pA.working_state });
    const eventsA = (await runtime.eventStore.query({ session_id: 'sess-A' })).events;
    const madeA = eventsA.find((e) => e.type === 'decision/made')!;
    expect(madeA.runtime_snapshot).toBe(v1);

    // 请求 B finalize → v2
    await runtime.finalizeTurn({ session_id: 'sess-B', decision: pB.decision, working_state: pB.working_state });
    const eventsB = (await runtime.eventStore.query({ session_id: 'sess-B' })).events;
    const madeB = eventsB.find((e) => e.type === 'decision/made')!;
    expect(madeB.runtime_snapshot).toBe(v2);
  }, FIXTURE_TIMEOUT);

  it('重建失败降级：新线引用缺失 → promoted=false + 降级原因，当前快照与目录保持（切换状态仍生效，快照不变）', () => {
    fx = buildLayoutFixture();
    const runtime = track(createCognitiveRuntime({ root: path.join(base, 'r'), line: 'stable', layout: layoutFor(fx) }));
    const v1 = runtime.snapshotHash;
    const stablePolicyDir = runtime.policyDir;
    // 破坏 latest 线（trusted-latest 与 main 均不可解析）→ 物化失败
    runGit(['update-ref', '-d', 'refs/heads/trusted-latest'], { cwd: fx.bare });
    runGit(['update-ref', '-d', 'refs/heads/main'], { cwd: fx.bare });
    const r = runtime.rebuildSnapshotForLine('latest');
    expect(r.promoted).toBe(false);
    expect(r.degraded).not.toBeNull();
    expect(runtime.snapshotHash).toBe(v1); // 快照保持
    expect(runtime.policyDir).toBe(stablePolicyDir); // 目录未切换
    expect(runtime.lineSnapshot?.line).toBe('stable');
  }, FIXTURE_TIMEOUT);
});

describe('P1b /mode 切换 → 快照重建（plugin.ts onSwitch 生产接线）', () => {
  interface CapturedCommand {
    name: string;
    handler: (inv: {
      commandId: unknown;
      agent: { session?: { id?: string; events?: ReadonlyArray<{ type?: string }> } };
      rawInput: string;
      signal: unknown;
    }) => Promise<{ kind: string; text: string }>;
  }

  function makeModeCtx(runtime: CognitiveRuntime): {
    ctx: ContextLike;
    modeCmd: () => CapturedCommand | undefined;
  } {
    let captured: CapturedCommand | undefined;
    const ctx: ContextLike = {
      cognitive: runtime,
      commands: {
        register: (def: unknown) => {
          const d = def as CapturedCommand;
          if (d.name === 'mode') {
            captured = d;
          }
        },
      },
    };
    return { ctx, modeCmd: () => captured };
  }

  it('/mode latest → onSwitch 重建快照（下一请求生效）：注入 runtime 的 snapshotHash 变化，prepareTurn 用新快照', async () => {
    fx = buildLayoutFixture();
    const runtime = track(createCognitiveRuntime({ root: path.join(base, 'r'), line: 'stable', layout: layoutFor(fx) }));
    const v1 = runtime.snapshotHash;
    const { ctx, modeCmd } = makeModeCtx(runtime);
    apply(ctx, { bootstrap: false });
    expect(modeCmd()).toBeDefined();

    await modeCmd()!.handler({ commandId: 'c', agent: { session: { id: 'sess-mode', events: [] } }, rawInput: 'latest', signal: undefined });
    expect(runtime.snapshotHash).not.toBe(v1); // 重建 + promote（下一请求生效）

    // 下一请求 → 新快照（与当前一致）
    const p = await runtime.prepareTurn(req('sess-mode') as never);
    expect(p.snapshot).toBe(runtime.snapshotHash);
    expect(p.snapshot).not.toBe(v1);
  }, FIXTURE_TIMEOUT);

  it('/mode 切换但物化失败 → 降级记录（lines/rebuild）+ 快照保持', async () => {
    fx = buildLayoutFixture();
    const runtime = track(createCognitiveRuntime({ root: path.join(base, 'r'), line: 'stable', layout: layoutFor(fx) }));
    const v1 = runtime.snapshotHash;
    const { ctx, modeCmd } = makeModeCtx(runtime);
    apply(ctx, { bootstrap: false });
    // 破坏 latest 线 → onSwitch 的 rebuildSnapshotForLine 降级
    runGit(['update-ref', '-d', 'refs/heads/trusted-latest'], { cwd: fx.bare });
    runGit(['update-ref', '-d', 'refs/heads/main'], { cwd: fx.bare });
    const res = await modeCmd()!.handler({ commandId: 'c', agent: { session: { id: 'sess-mode', events: [] } }, rawInput: 'latest', signal: undefined });
    expect(res.kind).toBe('success'); // 切换本身成功（降级只影响快照）
    expect(runtime.snapshotHash).toBe(v1); // 快照保持
    expect(degradationLog().some((rec) => rec.hook === 'lines/rebuild')).toBe(true);
  }, FIXTURE_TIMEOUT);
});
