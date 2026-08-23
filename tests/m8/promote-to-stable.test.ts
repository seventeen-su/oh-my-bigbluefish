// P1e 晋升执行与回滚契约测试（supervisor/promotion.ts，架构 §3.2 promote / §6.5.3 门禁执行 /
// §6.5.4 晋升决策 / §17.2 Activation Contract / 实现规格 §5.4 RollbackContract + §10 Activation 事务）。
// 真实 git 操作（禁 mock）：独立临时 fixture 布局（buildLayoutFixture——trusted-latest 分支 ≠ stable 分支）。
// 覆盖（brief 测试清单 2/3/4）：
//   ① 门禁通过 → stable 指针 = trusted-latest commit；activation-log completed 落盘（scope='project'）；
//      activation/committed + evolution/promoted 事件可查；worktree best-effort（只读 ACL → degraded 常态）
//   ② 幂等：同 commit 对重复推进 → 拒绝（duplicate），stable 不变
//   ③ 门禁失败 → 不推进、reasons 返回（候选保持 trusted-latest，等待下次检查）
//   ④ rollbackPromotion：stable 回退旧 commit、rolled_back 事件、activation-log rolled_back 记录、
//      error 池留痕（record.json + reason.txt + payload/provenance 保留）
//   ⑤ 竞态守卫：stable 已前进（≠ 预期 predecessor）→ 拒绝（不覆盖）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLineCommit } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { CandidatePool, candidateDirName } from '../../supervisor/candidates.js';
import { EventStore } from '../../supervisor/event-store.js';
import { loadCompleted, loadRolledBack } from '../../supervisor/activation-log.js';
import {
  promoteToStable,
  rollbackPromotion,
  promotionActivationId,
  type PromoteToStableDeps,
  type PromoteToStableInput,
} from '../../supervisor/promotion.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

const SESSION = 'sess-promote-1';
/** fixture 构建/真实 git 超时（buildLayoutFixture：2 提交 + 3 worktree + 2 icacls；全量套件并行 git/icacls 饱和） */
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

function makeLayout(fx: LayoutFixture): VersionLayout {
  return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
}

function poolRootOf(fx: LayoutFixture): string {
  return join(fx.root, 'workspace', '.omb', '.evolution');
}

/** 默认输入（fixture：stable = initialHash、trusted-latest = latestHash；门禁通过；over 覆盖） */
function mkInput(fx: LayoutFixture, over: Partial<PromoteToStableInput> = {}): PromoteToStableInput {
  return {
    gate: { ok: true, reasons: ['L1 硬门: fitness 不降', 'L2: 无 shadow 数据不阻塞', 'L3: judge 未接入'] },
    candidate_commit: fx.latestHash,
    stable_commit: fx.initialHash,
    bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
    object_id: `sha256:${'o'.repeat(64)}`,
    candidate_id: `sha256:${'c'.repeat(64)}`,
    activation_scope: 'project', // D3 裁决：作用域显式字段（调用方传入，不写死）
    ...over,
  } satisfies PromoteToStableInput;
}

function mkDeps(fx: LayoutFixture, over: Partial<PromoteToStableDeps> = {}): PromoteToStableDeps {
  return {
    layout: makeLayout(fx),
    activationLogDir: join(poolRootOf(fx), 'activations'),
    ...over,
  };
}

let fx: LayoutFixture | null;
let stores: EventStore[];

beforeEach(() => {
  fx = null;
  stores = [];
});

afterEach(async () => {
  for (const s of stores) {
    await s.close();
  }
  stores = [];
  if (fx) {
    teardownLayoutFixture(fx);
  }
});

function trackStore(store: EventStore): EventStore {
  stores.push(store);
  return store;
}

describe('① promoteToStable：门禁通过 → stable ← trusted-latest + Activation Contract 持久化', () => {
  fixtureIt('推进后 stable 指针 = trusted-latest commit；activation-log completed 落盘（scope=project）；事件可查', async () => {
    fx = buildLayoutFixture();
    const store = trackStore(new EventStore(join(fx.root, 'events.db')));
    const input = mkInput(fx);
    const r = await promoteToStable(input, mkDeps(fx, { eventStore: store, sessionId: SESSION, snapshotHash: 'rs:test' }));

    expect(r.promoted).toBe(true);
    expect(r.activation_id).toBe(promotionActivationId(fx.initialHash, fx.latestHash));
    expect(r.stable_commit).toBe(fx.latestHash);

    // stable 指针 = trusted-latest commit（原子切换）
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.latestHash);
    // trusted-latest 未动（晋升不动候选线）
    expect(resolveLineCommit(makeLayout(fx), 'latest')).toBe(fx.latestHash);

    // activation-log completed 落盘（scope='project'——显式字段）
    const contract = loadCompleted(mkDeps(fx).activationLogDir!, r.activation_id!);
    expect(contract).not.toBeNull();
    expect(contract!.predecessor).toBe(fx.initialHash);
    expect(contract!.candidate).toBe(fx.latestHash);
    expect(contract!.activation_scope).toBe('project');
    expect(contract!.evidence_certificate).toBe('promotion-gate');
    expect(contract!.required_capabilities).toEqual([]);
    expect(contract!.rollback_snapshot).toBe(fx.initialHash);

    // activation/committed + evolution/promoted 事件可查
    const { events } = await store.query({ session_id: SESSION });
    const committed = events.find((e) => e.type === 'activation/committed');
    expect(committed).toBeDefined();
    expect((committed!.payload as Record<string, unknown>).activation_id).toBe(r.activation_id);
    const promoted = events.find((e) => e.type === 'evolution/promoted');
    expect(promoted).toBeDefined();
    const pp = promoted!.payload as Record<string, unknown>;
    expect(pp.object_id).toBe(input.object_id);
    expect(pp.commit).toBe(fx.latestHash);
    expect(pp.predecessor).toBe(fx.initialHash);

    // worktree best-effort：稳定线 worktree 只读 ACL → ref 切换成功 + 降级状态（degraded 常态）或已同步
    expect(['synced', 'degraded']).toContain(r.worktree_status);
  });

  fixtureIt('幂等：同 commit 对重复推进 → 拒绝（duplicate），stable 不再变化', async () => {
    fx = buildLayoutFixture();
    const store = trackStore(new EventStore(join(fx.root, 'events.db')));
    const deps = mkDeps(fx, { eventStore: store, sessionId: SESSION });
    const first = await promoteToStable(mkInput(fx), deps);
    expect(first.promoted).toBe(true);
    const stableAfterFirst = resolveLineCommit(makeLayout(fx), 'stable');

    const second = await promoteToStable(mkInput(fx), deps);
    expect(second.promoted).toBe(false);
    expect(second.reason).toMatch(/duplicate|已晋升|重复/i);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(stableAfterFirst);
  });

  fixtureIt('门禁失败 → 不推进、reasons 返回（候选保持 trusted-latest，等待下次检查）', async () => {
    fx = buildLayoutFixture();
    const input = mkInput(fx, {
      gate: { ok: false, reasons: ['L1 硬门: fitness 下降（19/20 < 20/20）', 'L2: 失败率超限'] },
    });
    const r = await promoteToStable(input, mkDeps(fx));
    expect(r.promoted).toBe(false);
    expect(r.reason).toMatch(/门禁|拒绝/i);
    expect(r.reason).toContain('L1 硬门'); // reasons 返回（可审计）
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.initialHash); // 未推进
  });

  fixtureIt('竞态守卫：stable 已前进（≠ 预期 predecessor）→ 拒绝（不覆盖已分叉状态）', async () => {
    fx = buildLayoutFixture();
    // 制造第三 commit（commit-tree 孤儿提交，不挂任何分支）→ stable 推进到它（模拟另一晋升者已推进）
    const raceTarget = runGit(['commit-tree', `${fx.latestHash}^{tree}`, '-m', 'race-target'], { cwd: fx.bare });
    runGit(['update-ref', 'refs/heads/stable', raceTarget], { cwd: fx.bare });
    const r = await promoteToStable(mkInput(fx), mkDeps(fx)); // stable_commit 输入仍 = initialHash（过期）
    expect(r.promoted).toBe(false);
    expect(r.reason).toMatch(/竞态|已前进|已变化|≠/);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(raceTarget); // 未被覆盖
  });
});

describe('④ rollbackPromotion：RollbackContract 回退 + rolled_back 事件 + error 池留痕', () => {
  fixtureIt('stable 回退旧 commit、rolled_back 事件、activation-log rolled_back 记录、error 池留痕', async () => {
    fx = buildLayoutFixture();
    const evolutionRoot = poolRootOf(fx);
    const store = trackStore(new EventStore(join(fx.root, 'events.db')));
    const input = mkInput(fx);
    const pr = await promoteToStable(input, mkDeps(fx, { eventStore: store, sessionId: SESSION, snapshotHash: 'rs:test' }));
    expect(pr.promoted).toBe(true);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.latestHash);

    // 注册候选（trusted）→ 回滚后入 error 池
    const pool = new CandidatePool(evolutionRoot);
    await pool.registerCandidate(
      { id: input.candidate_id!, kind: 'policy', status: 'untrusted', parent: null, lineage: [], gates_passed: ['G1', 'G3'], created: 12345, provenance: 'evolution/generator' },
      'payload: evolve.yaml 微调',
      { source_events: ['ev:test:1'], motivation: 'P1e 回滚测试', diff: 'evolve.yaml: 0.9→0.95', created: 12345 },
    );
    await pool.promote({ id: input.candidate_id!, kind: 'policy', status: 'untrusted', parent: null, lineage: [], gates_passed: ['G1', 'G3'], created: 12345, provenance: 'evolution/generator' });

    const rr = await rollbackPromotion(pr.activation_id!, '人工回滚：候选线上退化（P1e 测试）', {
      layout: makeLayout(fx),
      activationLogDir: mkDeps(fx).activationLogDir!,
      eventStore: store,
      sessionId: SESSION,
      snapshotHash: 'rs:test',
      evolutionRoot,
      candidate_id: input.candidate_id,
      object_id: input.object_id,
      affectedSessions: ['sess-a', 'sess-b'],
    });

    expect(rr.rolled_back).toBe(true);
    expect(rr.new_head).toBe(fx.initialHash); // stable 回退旧 commit
    expect(rr.contract.target_snapshot).toBe(fx.initialHash);
    expect(rr.contract.scope).toBe('project');
    expect(rr.contract.affected_sessions).toEqual(['sess-a', 'sess-b']);
    expect(rr.contract.restore_plan.some((x) => /update-ref refs\/heads\/stable/.test(x))).toBe(true);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.initialHash);

    // rolled_back 事件可查
    const { events } = await store.query({ session_id: SESSION });
    const rolled = events.find((e) => e.type === 'evolution/rolled_back');
    expect(rolled).toBeDefined();
    const rp = rolled!.payload as Record<string, unknown>;
    expect(rp.activation_id).toBe(pr.activation_id);
    expect(rp.from).toBe(fx.latestHash);
    expect(rp.to).toBe(fx.initialHash);
    expect(rp.reason).toContain('人工回滚');

    // activation-log rolled_back 记录
    const rec = loadRolledBack(mkDeps(fx).activationLogDir!, pr.activation_id!);
    expect(rec).not.toBeNull();
    expect(rec!.from).toBe(fx.latestHash);
    expect(rec!.to).toBe(fx.initialHash);
    expect(rec!.candidate_id).toBe(input.candidate_id);

    // error 池留痕（record.json status=error + reason.txt + payload/provenance 保留）
    const errDir = join(evolutionRoot, 'error', candidateDirName(input.candidate_id!));
    const record = JSON.parse(await readFile(join(errDir, 'record.json'), 'utf8')) as { status: string; id: string };
    expect(record.status).toBe('error');
    expect(record.id).toBe(input.candidate_id);
    const reasonText = await readFile(join(errDir, 'reason.txt'), 'utf8');
    expect(reasonText).toContain('人工回滚');
    const payload = await readFile(join(errDir, 'payload.txt'), 'utf8');
    expect(payload).toContain('evolve.yaml 微调'); // 对象内容保留
    // 原 trusted 区不再存在（已移入 error 池）
    await expect(pool.load(input.candidate_id!)).rejects.toThrow(/未注册/);
  });
});
