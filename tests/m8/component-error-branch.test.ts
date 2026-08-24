// S6 组件级 error 分支测试（supervisor/candidates.ts + supervisor/promotion.ts，
// 架构 §3.3 错误分支组件级 / §9.3 信任池；清扫计划 S6）。
// 严格 TDD：本文件先于实现编写并确认失败（markError 组件级目录/listError/errorCounts 缺失）。
// 覆盖：
//   ① markError 组件级目录：error/<component>/<id>/（record.json status=error + reason.txt +
//      payload/provenance 保留，源区移除）
//   ② 缺省 component → error/kernel/<id>/（非组件候选）
//   ③ 兼容旧形态：error/<id>/ 归档可被 listError/errorCounts 读取（归属 kernel）+ markError 幂等 no-op
//   ④ listError(component) 按组件过滤；errorCounts() 按组件统计（组件级独立走线可观测性）
//   ⑤ 组件归属从候选 provenance.component 解析（最小实现——无注册表注入；缺省 kernel）
//   ⑥ 幂等：重复 markError no-op；未注册候选 → fail-loud
//   ⑦ rollbackPromotion 回滚路径传组件（deps.component → error/<component>/<id>）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveLineCommit } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import { CandidatePool, candidateDirName, type CandidateRecord } from '../../supervisor/candidates.js';
import { EventStore } from '../../supervisor/event-store.js';
import {
  promoteToStable,
  rollbackPromotion,
  type PromoteToStableDeps,
  type PromoteToStableInput,
} from '../../supervisor/promotion.js';
import { buildLayoutFixture, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

let seq = 0;
/** 确定性候选 id（sha256:<64hex>，与 M5 Evolution Object id 同风格） */
function nextId(): string {
  return `sha256:${String(seq++).padStart(64, '0')}`;
}

function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: nextId(),
    kind: 'policy',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1', 'G3'],
    created: Date.now(),
    provenance: 'evolution/generator',
    ...over,
  };
}

/** 读 error/<component>/<id>/ 下文件（不存在 → null） */
async function readOpt(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

describe('S6 组件级 error 分支（candidates.ts markError/listError/errorCounts）', () => {
  let evo: string;
  let pool: CandidatePool;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-err-branch-'));
    evo = join(base, '.evolution');
    await mkdir(evo, { recursive: true });
    pool = new CandidatePool(evo);
    seq = 0;
  });

  afterEach(async () => {
    await rm(dirname(evo), { recursive: true, force: true });
  });

  /** 注册 + 晋升（error 池标记前置状态：候选须存在于 trusted/） */
  async function registerAndPromote(rec: CandidateRecord, payload = 'payload: 组件级 error 测试内容'): Promise<void> {
    await pool.registerCandidate(rec, payload, {
      source_events: ['ev:s6:1'],
      motivation: 'S6 组件级 error 分支测试',
      created: Date.now(),
    });
    await pool.promote(rec);
  }

  it('① markError 组件级目录：error/<component>/<id>/（record+reason+payload/provenance 保留，源区移除）', async () => {
    const rec = mkRec();
    await registerAndPromote(rec);
    await pool.markError(rec.id, '组件级归档原因', { component: 'memory-retrieval' });

    const dir = join(evo, 'error', 'memory-retrieval', candidateDirName(rec.id));
    const record = JSON.parse((await readOpt(join(dir, 'record.json')))!) as CandidateRecord;
    expect(record.status).toBe('error');
    expect(record.id).toBe(rec.id);
    expect(await readOpt(join(dir, 'reason.txt'))).toBe('组件级归档原因');
    expect(await readOpt(join(dir, 'payload.txt'))).toContain('组件级 error 测试内容'); // 对象内容保留
    expect(await readOpt(join(dir, 'provenance.json'))).toContain('ev:s6:1'); // provenance 保留
    // 原 trusted 区不再存在（terminal 归档——消费方/晋升/拒绝/撤销均不可见）
    await expect(pool.load(rec.id)).rejects.toThrow(/未注册/);
  });

  it('② 缺省 component → error/kernel/<id>/（非组件候选）', async () => {
    const rec = mkRec();
    await registerAndPromote(rec);
    await pool.markError(rec.id, '缺省 kernel 归档');

    expect(existsSync(join(evo, 'error', 'kernel', candidateDirName(rec.id), 'record.json'))).toBe(true);
    expect(existsSync(join(evo, 'error', candidateDirName(rec.id)))).toBe(false); // 无旧形态残留
  });

  it('③ 兼容旧形态：error/<id>/ 归档可读（归属 kernel）+ markError 幂等 no-op', async () => {
    // 手工构造 S6 前布局 error/<id>/（terminal 归档，record+reason+payload）
    const legacyId = nextId();
    const legacyDir = join(evo, 'error', candidateDirName(legacyId));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'record.json'),
      JSON.stringify(
        { ...mkRec({ id: legacyId }), status: 'error' },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(legacyDir, 'reason.txt'), '旧形态归档原因', 'utf8');

    // 读取双形态：listError 返回该旧归档（归属 kernel）
    const all = await pool.listError();
    const legacy = all.find((e) => e.rec.id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy!.component).toBe('kernel');
    expect(legacy!.rec.status).toBe('error');
    expect(legacy!.reason).toBe('旧形态归档原因');
    // errorCounts 计入 kernel
    const counts = await pool.errorCounts();
    expect(counts['kernel']).toBeGreaterThanOrEqual(1);

    // markError 幂等：已归档（旧形态）→ no-op（不抛、不新建新形态目录、原目录不变）
    await pool.markError(legacyId, '再归档应 no-op');
    expect(await readOpt(join(legacyDir, 'reason.txt'))).toBe('旧形态归档原因');
    expect(existsSync(join(evo, 'error', 'kernel', candidateDirName(legacyId)))).toBe(false);
  });

  it('④ listError(component) 按组件过滤；errorCounts() 按组件统计（独立走线可观测性）', async () => {
    const a = mkRec();
    const b = mkRec();
    const c = mkRec();
    await registerAndPromote(a);
    await registerAndPromote(b);
    await registerAndPromote(c);
    await pool.markError(a.id, '组件 A 退化', { component: 'memory-retrieval' });
    await pool.markError(b.id, '组件 B 退化', { component: 'scheduler-probe' });
    await pool.markError(c.id, '内核候选退化'); // 缺省 kernel

    const all = await pool.listError();
    expect(all).toHaveLength(3);
    const byComp = new Map(all.map((e) => [e.component, e.rec.id]));
    expect(byComp.get('memory-retrieval')).toBe(a.id);
    expect(byComp.get('scheduler-probe')).toBe(b.id);
    expect(byComp.get('kernel')).toBe(c.id);

    const memOnly = await pool.listError('memory-retrieval');
    expect(memOnly).toHaveLength(1);
    expect(memOnly[0]!.rec.id).toBe(a.id);

    const counts = await pool.errorCounts();
    expect(counts).toEqual({ 'memory-retrieval': 1, 'scheduler-probe': 1, kernel: 1 });

    // 独立走线：一组件 error 不影响其它（分区互不干扰）
    expect(existsSync(join(evo, 'error', 'memory-retrieval', candidateDirName(b.id)))).toBe(false);
    expect(existsSync(join(evo, 'error', 'scheduler-probe', candidateDirName(a.id)))).toBe(false);
  });

  it('⑤ 组件归属从候选 provenance.component 解析（调用方未传 → 读 provenance，缺省 kernel）', async () => {
    const rec = mkRec();
    await pool.registerCandidate(rec, 'payload p', {
      source_events: ['ev:s6:5'],
      motivation: '带组件声明的候选',
      created: Date.now(),
      component: 'scheduler-probe', // S6：provenance 组件归属声明
    });
    await pool.promote(rec);
    await pool.markError(rec.id, 'provenance 解析组件');

    expect(existsSync(join(evo, 'error', 'scheduler-probe', candidateDirName(rec.id), 'record.json'))).toBe(true);
    expect(existsSync(join(evo, 'error', 'kernel', candidateDirName(rec.id)))).toBe(false);
  });

  it('⑥ 幂等：重复 markError no-op；未注册候选 → fail-loud', async () => {
    const rec = mkRec();
    await registerAndPromote(rec);
    await pool.markError(rec.id, '第一次归档', { component: 'memory-retrieval' });
    const dir = join(evo, 'error', 'memory-retrieval', candidateDirName(rec.id));
    // 重复归档（同组件）→ no-op：reason 不覆写、不抛
    await expect(pool.markError(rec.id, '第二次归档', { component: 'memory-retrieval' })).resolves.toBeUndefined();
    expect(await readOpt(join(dir, 'reason.txt'))).toBe('第一次归档');
    // 未注册候选 → fail-loud（不静默）
    await expect(pool.markError(nextId(), '未注册')).rejects.toThrow(/未注册|不存在/);
  });
});

describe('⑦ rollbackPromotion 回滚路径传组件（promotion.ts → markError）', () => {
  const FIXTURE_TIMEOUT = 30000;
  const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);
  const SESSION = 'sess-s6-rollback';

  function makeLayout(fx: LayoutFixture): VersionLayout {
    return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
  }

  function poolRootOf(fx: LayoutFixture): string {
    return join(fx.root, 'workspace', '.omb', '.evolution');
  }

  function mkInput(fx: LayoutFixture): PromoteToStableInput {
    return {
      gate: { ok: true, reasons: ['L1 硬门: fitness 不降'] },
      candidate_commit: fx.latestHash,
      stable_commit: fx.initialHash,
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      object_id: `sha256:${'o'.repeat(64)}`,
      candidate_id: `sha256:${'c'.repeat(64)}`,
      activation_scope: 'project',
    };
  }

  function mkDeps(fx: LayoutFixture, over: Partial<PromoteToStableDeps> = {}): PromoteToStableDeps {
    return { layout: makeLayout(fx), activationLogDir: join(poolRootOf(fx), 'activations'), ...over };
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

  fixtureIt('deps.component 传入 → 回滚对象归档 error/<component>/<id>/', async () => {
    fx = buildLayoutFixture();
    const evolutionRoot = poolRootOf(fx);
    const store = new EventStore(join(fx.root, 'events.db'));
    stores.push(store);
    const input = mkInput(fx);
    const pr = await promoteToStable(
      input,
      mkDeps(fx, { eventStore: store, sessionId: SESSION, snapshotHash: 'rs:test' }),
    );
    expect(pr.promoted).toBe(true);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.latestHash);

    // 注册 + 晋升候选（回滚后入 error 池）
    const pool = new CandidatePool(evolutionRoot);
    await pool.registerCandidate(
      { id: input.candidate_id!, kind: 'policy', status: 'untrusted', parent: null, lineage: [], gates_passed: ['G1', 'G3'], created: 12345, provenance: 'evolution/generator' },
      'payload: 回滚组件测试',
      { source_events: ['ev:s6:7'], motivation: 'S6 回滚组件测试', created: 12345 },
    );
    await pool.promote({ id: input.candidate_id!, kind: 'policy', status: 'untrusted', parent: null, lineage: [], gates_passed: ['G1', 'G3'], created: 12345, provenance: 'evolution/generator' });

    const rr = await rollbackPromotion(pr.activation_id!, '回滚：组件级退化（S6）', {
      layout: makeLayout(fx),
      activationLogDir: mkDeps(fx).activationLogDir!,
      eventStore: store,
      sessionId: SESSION,
      snapshotHash: 'rs:test',
      evolutionRoot,
      candidate_id: input.candidate_id,
      object_id: input.object_id,
      component: 'memory-retrieval', // S6：调用面传组件归属
      affectedSessions: ['sess-a'],
    });
    expect(rr.rolled_back).toBe(true);
    expect(resolveLineCommit(makeLayout(fx), 'stable')).toBe(fx.initialHash);

    // 组件级 error 目录留痕（record + reason + payload 保留）
    const errDir = join(evolutionRoot, 'error', 'memory-retrieval', candidateDirName(input.candidate_id!));
    const record = JSON.parse((await readOpt(join(errDir, 'record.json')))!) as CandidateRecord;
    expect(record.status).toBe('error');
    expect(record.id).toBe(input.candidate_id);
    expect((await readOpt(join(errDir, 'reason.txt')))!).toContain('回滚：组件级退化');
    expect((await readOpt(join(errDir, 'payload.txt')))!).toContain('回滚组件测试');
    // 未落缺省 kernel 区
    expect(existsSync(join(evolutionRoot, 'error', 'kernel', candidateDirName(input.candidate_id!)))).toBe(false);
    // 原 trusted 区不再存在
    await expect(pool.load(input.candidate_id!)).rejects.toThrow(/未注册/);
  });
});
