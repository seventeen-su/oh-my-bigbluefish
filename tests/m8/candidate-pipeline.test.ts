// P1d 候选管线生产路径测试（supervisor/candidate-pipeline.ts，架构 §3.2 演化事务 + §6.5.3 验证链 + §6.5.4 Evolution Object）。
// 真实 git 操作（禁 mock）：独立临时 fixture 布局（buildLayoutFixture——含 policy/processes/trusted-latest）。
// 覆盖：
//   ① G1 拒非法 YAML / 越界值 / 未知 target；G2 skipped 标记（数据候选 N/A）
//   ② G3：fitness 不降通过（可加载微调候选）；成本劣化拒绝（明显越界参数）
//   ③ G4 shadow 记录（.evolution/shadows/ exposure log 契约接线）
//   ④ 晋升：txn 提交到 main + trusted-latest 指针推进 + 线内容含新 policy（resolveLineCommit / 物化可读）
//   ⑤ 重复候选幂等拒绝（candidate_id 幂等键）
//   ⑥ Evolution Object：内容寻址、落 main 提交内 .evolution-objects/、parent 链、evolution/promoted 事件可查
//   ⑦ 防误删（ls-tree 比对：覆盖式 diff 不删除其余文件）
//   ⑧ 失败即 rejected（commit/update-ref 失败 → rejected/ 留痕）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { loadPolicy } from '../../kernel/policy-loader.js';
import { makeImmutableId, canonicalJson } from '../../kernel/schemas/base.js';
import { EvolutionObjectSchema } from '../../kernel/schemas/m.js';
import { ensureLineSnapshot, resolveLineCommit } from '../../substrate/lines.js';
import type { VersionLayout } from '../../substrate/snapshot.js';
import {
  CandidatePool,
  candidateDirName,
  type CandidateProvenance,
  type CandidateRecord,
} from '../../supervisor/candidates.js';
import { EventStore } from '../../supervisor/event-store.js';
import {
  promoteDataCandidate,
  runCandidatePipeline,
  validateDataCandidate,
  type CandidateOutcome,
} from '../../supervisor/candidate-pipeline.js';
// P4：候选验证契约门禁（真实内核门禁注入路径集成——同一契约语义覆盖管线）
import { runCandidateGate } from '../../kernel/candidate-contract.js';
import type { CandidateDraft } from '../../kernel/schemas/evolution.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

const SESSION = 'sess-pipeline-1';

/** fixture 构建/真实 git 超时（buildLayoutFixture：2 提交 + 3 worktree + 2 icacls；全量套件并行时
 *  git/icacls 饱和（已知 flake 类：rollback/boot/txn-capability/line-snapshot 同款）→ 放宽防环境超时） */
const FIXTURE_TIMEOUT = 30000;

/** fixture 重测试包装（全量套件并行 git/icacls 饱和 → 放宽超时防 flake） */
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

// ---- 工具 ----

function makeLayout(fx: LayoutFixture): VersionLayout {
  return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
}

/** 物化线快照 → policy 目录（P1a 目录注入同款） */
async function baselinePolicyDirOf(fx: LayoutFixture): Promise<string> {
  const snap = ensureLineSnapshot(makeLayout(fx), 'latest');
  return join(snap.dir, 'kernel', 'policy');
}

function poolRootOf(fx: LayoutFixture): string {
  return join(fx.root, 'workspace', '.omb', '.evolution');
}

function draft(target: string, content: string, signal = 'corrections'): CandidateDraft {
  return {
    id: `sha256:${createHash('sha256').update(`${target}\u0000${content}`).digest('hex').slice(0, 12)}`,
    seq: 0,
    kind: 'policy',
    target,
    content,
    diff: `${target}: 测试变更`,
    motivation: `signal ${signal} 测试`,
    signal,
    change: { path: 'test.path', old: 0, new: 1 },
  };
}

/** 可加载微调候选：evolve.yaml strength 0.9→0.95 */
async function evolveTweakContent(strength: number): Promise<string> {
  const p = await loadPolicy();
  const evolve = {
    ...p.evolve,
    signal_triggers: {
      ...p.evolve.signal_triggers,
      corrections: { ...p.evolve.signal_triggers.corrections!, strength },
    },
  };
  return dumpYaml(evolve);
}

/** 成本劣化候选：budget.yaml context_budget_tokens 翻倍（相对当前值，如 500→1000） */
async function budgetInflateContent(): Promise<string> {
  const p = await loadPolicy();
  return dumpYaml({ ...p.budget, context_budget_tokens: p.budget.context_budget_tokens * 2 });
}

function rec(id: string): CandidateRecord {
  return {
    id,
    kind: 'policy',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1', 'G3'],
    created: 12345,
    provenance: 'evolution/generator',
  };
}

/** 从提交读取文件内容（fixture bare；缺失 → null） */
function showFile(fx: LayoutFixture, commit: string, path: string): string | null {
  try {
    return runGit(['show', `${commit}:${path}`], { gitDir: fx.bare });
  } catch {
    return null;
  }
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

describe('① G1 静态门 + G2 skipped（数据候选）', () => {
  fixtureIt('G1 拒非法 YAML（js-yaml 解析失败 → 判定拒绝）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(draft('kernel/policy/evolve.yaml', 'evolve.yaml: [unclosed'), {
      baselinePolicyDir: await baselinePolicyDirOf(fx),
    });
    expect(r.passed).toBe(false);
    expect(r.gates.g1?.ok).toBe(false);
    expect(r.gates.g1?.detail).toMatch(/YAML|解析|parse/i);
  });

  fixtureIt('G1 拒越界值（strength 2.5 超 schema 值域 0..1 → zod 判定拒绝）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(2.5)),
      { baselinePolicyDir: await baselinePolicyDirOf(fx) },
    );
    expect(r.passed).toBe(false);
    expect(r.gates.g1?.ok).toBe(false);
    expect(r.gates.g1?.detail).toMatch(/strength|0\.\.1|signal_triggers/i);
  });

  fixtureIt('G1 拒未知 target 文件（非四策略文件）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(draft('kernel/policy/unknown.yaml', dumpYaml({ a: 1 })), {
      baselinePolicyDir: await baselinePolicyDirOf(fx),
    });
    expect(r.passed).toBe(false);
    expect(r.gates.g1?.ok).toBe(false);
  });

  fixtureIt('G2 skipped：数据候选 N/A（注释说明，不阻断）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      { baselinePolicyDir: await baselinePolicyDirOf(fx) },
    );
    expect(r.gates.g2?.ok).toBe(true);
    expect(r.gates.g2?.detail).toMatch(/skip|N\/A|数据候选/i);
  });
});

describe('② G3 冻结基准回放 fitness（数据候选）', () => {
  fixtureIt('G3 通过：可加载微调候选 → loadPolicy(临时目录) OK + 回放 fitness 不降（passed 等于基线 + 成本代理无劣化）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      { baselinePolicyDir: await baselinePolicyDirOf(fx) },
    );
    expect(r.passed).toBe(true);
    expect(r.gates.g1?.ok).toBe(true);
    expect(r.gates.g3?.ok).toBe(true);
    expect(r.gates.g3?.detail).toMatch(/passed|fitness|回放/i);
    expect(r.reason).toContain('通过');
  });

  fixtureIt('G3 拒绝：成本显著劣化候选（context_budget_tokens 翻倍 → 成本代理劣化 > 容忍）', async () => {
    fx = buildLayoutFixture();
    const r = await validateDataCandidate(draft('kernel/policy/budget.yaml', await budgetInflateContent()), {
      baselinePolicyDir: await baselinePolicyDirOf(fx),
    });
    expect(r.gates.g1?.ok).toBe(true); // G1 值域合法（schema 正数）
    expect(r.gates.g3?.ok).toBe(false); // G3 成本劣化拒绝
    expect(r.passed).toBe(false);
    expect(r.gates.g3?.detail).toMatch(/成本|劣化|context_budget/i);
  });

  fixtureIt('G3 拒绝：候选使策略捆绑无法加载（临时目录 loadPolicy 失败）', async () => {
    fx = buildLayoutFixture();
    // governor.yaml 删除默认规则 → 单文件 schema refine 拒绝（捆绑加载失败路径）
    const broken = dumpYaml({ rules: [{ id: 'only', decision: 'Stop' }] });
    const r = await validateDataCandidate(draft('kernel/policy/governor.yaml', broken), {
      baselinePolicyDir: await baselinePolicyDirOf(fx),
    });
    expect(r.passed).toBe(false);
    expect(r.gates.g1?.ok ?? r.gates.g3?.ok).toBe(false);
  });
});

describe('③ G4 shadow 记录（exposure log 契约接线）', () => {
  fixtureIt('G1+G3 通过 → shadow 条目写入 .evolution/shadows/（候选 id/时间/域）', async () => {
    fx = buildLayoutFixture();
    const shadowPath = join(poolRootOf(fx), 'shadows', 'exposure.log');
    const r = await validateDataCandidate(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      { baselinePolicyDir: await baselinePolicyDirOf(fx), shadowLogPath: shadowPath },
    );
    expect(r.passed).toBe(true);
    expect(r.gates.g4?.ok).toBe(true);
    const lines = (await readFile(shadowPath, 'utf8')).trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!) as { candidate_id: string; ts: number; layer: string; decision: string };
    expect(entry.candidate_id).toMatch(/^sha256:/);
    expect(entry.decision).toBe('shadow');
    expect(entry.layer).toBe('L0');
    expect(typeof entry.ts).toBe('number');
  });
});

describe('④ 晋升与合并（txn → main → trusted-latest → 线内容）', () => {
  fixtureIt('晋升成功：提交到 main → trusted-latest 原子推进 → 线内容含新 policy → 对象 + 事件', async () => {
    fx = buildLayoutFixture();
    const poolRoot = poolRootOf(fx);
    const pool = new CandidatePool(poolRoot);
    const d = draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95));

    // 验证（G1/G2/G3 通过）
    const vr = await validateDataCandidate(d, { baselinePolicyDir: await baselinePolicyDirOf(fx) });
    expect(vr.passed).toBe(true);

    // 注册 + 晋升
    await pool.registerCandidate(rec(d.id), d.content, {
      source_events: ['ev:test:1'],
      motivation: d.motivation,
      diff: d.diff,
      created: 12345,
    } satisfies CandidateProvenance);
    const store = trackStore(new EventStore(join(fx.root, 'events.db')));
    const pr = await promoteDataCandidate(d, {
      layout: makeLayout(fx),
      evolutionRoot: poolRoot,
      record: rec(d.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: ['G1', 'G3'],
      sourceEvents: ['ev:test:1'],
      motivation: d.motivation,
      eventStore: store,
      sessionId: SESSION,
      snapshotHash: 'rs:test',
    });
    expect(pr.promoted).toBe(true);
    expect(pr.commit_hash).toMatch(/^[0-9a-f]{40}$/);

    // trusted-latest 推进到新 commit（D1⑤：latest = trusted head）
    expect(resolveLineCommit(makeLayout(fx), 'latest')).toBe(pr.commit_hash);
    // main 同步推进（同基快进）
    expect(runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: fx.bare })).toBe(pr.commit_hash);

    // 提交内容：新 policy + .evolution-objects/（覆盖式，未删除其余文件）
    const newPolicy = showFile(fx, pr.commit_hash!, 'kernel/policy/evolve.yaml')!;
    expect(parseYaml(newPolicy) as { signal_triggers: { corrections: { strength: number } } })
      .toMatchObject({ signal_triggers: { corrections: { strength: 0.95 } } });
    expect(showFile(fx, pr.commit_hash!, 'manifest.json')).not.toBeNull(); // 其余文件未删
    expect(showFile(fx, pr.commit_hash!, `.evolution-objects/${candidateDirName(pr.object_id!)}.json`)).not.toBeNull();

    // 线内容可读（物化新快照读新策略）
    const snap = ensureLineSnapshot(makeLayout(fx), 'latest');
    expect(snap.commit).toBe(pr.commit_hash);
    const materialized = parseYaml(
      await readFile(join(snap.dir, 'kernel', 'policy', 'evolve.yaml'), 'utf8'),
    ) as { signal_triggers: { corrections: { strength: number } } };
    expect(materialized.signal_triggers.corrections.strength).toBe(0.95);

    // 信任池：候选已 trusted
    const loaded = await pool.load(d.id);
    expect(loaded.status).toBe('trusted');

    // evolution/promoted 事件入链（payload 含 object id/candidate id/commit）
    const { events } = await store.query({ session_id: SESSION });
    const promoted = events.find((e) => e.type === 'evolution/promoted')!;
    expect(promoted).toBeDefined();
    const payload = promoted.payload as Record<string, unknown>;
    expect(payload.object_id).toBe(pr.object_id);
    expect(payload.candidate_id).toBe(d.id);
    expect(payload.commit).toBe(pr.commit_hash);
  });

  fixtureIt('防误删：晋升提交为覆盖式 diff（ls-tree 比对——基线全部路径仍在，无删除）', async () => {
    fx = buildLayoutFixture();
    const pool = new CandidatePool(poolRootOf(fx));
    const base = resolveLineCommit(makeLayout(fx), 'latest');
    const basePaths = runGit(['ls-tree', '-r', '--name-only', base], { cwd: fx.bare })
      .split('\n')
      .filter((l) => l.length > 0);
    expect(basePaths.length).toBeGreaterThan(0);

    const d = draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95));
    await pool.registerCandidate(rec(d.id), d.content);
    const pr = await promoteDataCandidate(d, {
      layout: makeLayout(fx),
      evolutionRoot: poolRootOf(fx),
      record: rec(d.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: [],
      sourceEvents: [],
      motivation: d.motivation,
    });
    expect(pr.promoted).toBe(true);

    const newPaths = runGit(['ls-tree', '-r', '--name-only', pr.commit_hash!], { cwd: fx.bare })
      .split('\n')
      .filter((l) => l.length > 0);
    for (const p of basePaths) {
      expect(newPaths).toContain(p); // 基线文件全部保留
    }
    expect(newPaths).toContain('kernel/policy/evolve.yaml');
    expect(newPaths).toContain(`.evolution-objects/${candidateDirName(pr.object_id!)}.json`);
  });
});

describe('⑤ 幂等（candidate_id 幂等键：同候选重复提交拒绝）', () => {
  fixtureIt('同候选再次晋升 → 拒绝（duplicate），trusted-latest 不再推进', async () => {
    fx = buildLayoutFixture();
    const pool = new CandidatePool(poolRootOf(fx));
    const d = draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95));
    await pool.registerCandidate(rec(d.id), d.content);
    const deps = {
      layout: makeLayout(fx),
      evolutionRoot: poolRootOf(fx),
      record: rec(d.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: [],
      sourceEvents: [],
      motivation: d.motivation,
    };
    const first = await promoteDataCandidate(d, deps);
    expect(first.promoted).toBe(true);
    const headAfterFirst = resolveLineCommit(makeLayout(fx), 'latest');

    const second = await promoteDataCandidate(d, deps);
    expect(second.promoted).toBe(false);
    expect(second.reason).toMatch(/duplicate|重复|已/);
    expect(resolveLineCommit(makeLayout(fx), 'latest')).toBe(headAfterFirst); // 指针未动
  });
});

describe('⑥ Evolution Object 记录（§6.5.4 → git）', () => {
  fixtureIt('对象 id 内容寻址、落 main 提交内 .evolution-objects/、parent 链（首个 parent=null）', async () => {
    fx = buildLayoutFixture();
    const pool = new CandidatePool(poolRootOf(fx));
    const d1 = draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95));
    await pool.registerCandidate(rec(d1.id), d1.content);
    const p1 = await promoteDataCandidate(d1, {
      layout: makeLayout(fx),
      evolutionRoot: poolRootOf(fx),
      record: rec(d1.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: ['G1', 'G3'],
      sourceEvents: ['ev:test:1'],
      motivation: d1.motivation,
    });
    expect(p1.promoted).toBe(true);

    // 对象内容寻址：id = sha256(canonical(除 id 外全字段))
    const raw1 = showFile(fx, p1.commit_hash!, `.evolution-objects/${candidateDirName(p1.object_id!)}.json`)!;
    const obj1 = EvolutionObjectSchema.parse(JSON.parse(raw1));
    expect(obj1.id).toBe(p1.object_id);
    const body1: Record<string, unknown> = { ...obj1 };
    delete body1.id;
    expect(makeImmutableId(canonicalJson(body1))).toBe(obj1.id);
    expect(obj1.parent).toBeNull(); // 首个晋升 parent=null
    expect(obj1.diff).toContain(d1.target);
    expect(obj1.provenance.event).toBe('evolution/promoted');
    expect(obj1.verifications).toContain('G1');
    expect(obj1.verifications).toContain('G3');

    // 第二个不同候选 → parent 链接上一个对象（context.yaml 检索重获取成本 40→44 微调）
    const p2bundle = await loadPolicy();
    const ctx2 = {
      ...p2bundle.context,
      kind_costs: {
        ...p2bundle.context.kind_costs,
        reacquisition: { ...p2bundle.context.kind_costs.reacquisition, retrieval: 44 },
      },
    };
    const d2 = draft('kernel/policy/context.yaml', dumpYaml(ctx2), 'scope_miss');
    await pool.registerCandidate(rec(d2.id), d2.content);
    const p2 = await promoteDataCandidate(d2, {
      layout: makeLayout(fx),
      evolutionRoot: poolRootOf(fx),
      record: rec(d2.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: ['G1', 'G3'],
      sourceEvents: ['ev:test:2'],
      motivation: d2.motivation,
    });
    expect(p2.promoted).toBe(true);
    const raw2 = showFile(fx, p2.commit_hash!, `.evolution-objects/${candidateDirName(p2.object_id!)}.json`)!;
    const obj2 = EvolutionObjectSchema.parse(JSON.parse(raw2));
    expect(obj2.parent).toBe(obj1.id);
    expect(obj2.id).not.toBe(obj1.id);
  });
});

describe('⑦ 失败即 rejected（commit/update-ref 失败 → rejected/ 留痕）', () => {
  fixtureIt('git 事务失败（布局不可用）→ 候选标记 rejected（record + reason.txt），无晋升', async () => {
    fx = buildLayoutFixture();
    const poolRoot = poolRootOf(fx);
    const pool = new CandidatePool(poolRoot);
    const d = draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95));
    await pool.registerCandidate(rec(d.id), d.content);

    const badLayout: VersionLayout = {
      bareRepo: join(fx.root, 'no-such.git'),
      stableWorktree: join(fx.root, 'nope'),
      latestWorktree: join(fx.root, 'nope2'),
    };
    const pr = await promoteDataCandidate(d, {
      layout: badLayout,
      evolutionRoot: poolRoot,
      record: rec(d.id),
      bench: { baseline: { passed: 20, total: 20 }, candidate: { passed: 20, total: 20 }, cost_degradation_ratio: 0 },
      verifications: [],
      sourceEvents: [],
      motivation: d.motivation,
    });
    expect(pr.promoted).toBe(false);
    expect(pr.reason).toBeDefined();

    const rejected = await pool.load(d.id);
    expect(rejected.status).toBe('rejected');
    const reason = await readFile(join(poolRoot, 'rejected', candidateDirName(d.id), 'reason.txt'), 'utf8');
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe('⑧ runCandidatePipeline 端到端（验证 → 注册 → 晋升 → outcome）', () => {
  fixtureIt('有效候选 → validated + promoted；outcome 携带 gates/commit/object', async () => {
    fx = buildLayoutFixture();
    const outcome: CandidateOutcome = await runCandidatePipeline(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      {
        layout: makeLayout(fx),
        evolutionRoot: poolRootOf(fx),
        baselinePolicyDir: await baselinePolicyDirOf(fx),
        eventStore: trackStore(new EventStore(join(fx.root, 'events2.db'))),
        sessionId: SESSION,
        snapshotHash: 'rs:test',
      },
    );
    expect(outcome.validated).toBe(true);
    expect(outcome.promoted).toBe(true);
    expect(outcome.gates.g1?.ok).toBe(true);
    expect(outcome.gates.g3?.ok).toBe(true);
    expect(outcome.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.object_id).toMatch(/^sha256:/);
    expect(outcome.reason).toBeUndefined();
  });

  fixtureIt('未通过验证的候选 → validated=false、promoted=false、reason 含门禁失败，不落提交', async () => {
    fx = buildLayoutFixture();
    const before = resolveLineCommit(makeLayout(fx), 'latest');
    const outcome = await runCandidatePipeline(draft('kernel/policy/evolve.yaml', 'bogus: [yaml'), {
      layout: makeLayout(fx),
      evolutionRoot: poolRootOf(fx),
      baselinePolicyDir: await baselinePolicyDirOf(fx),
    });
    expect(outcome.validated).toBe(false);
    expect(outcome.promoted).toBe(false);
    expect(outcome.reason).toMatch(/G1/);
    expect(resolveLineCommit(makeLayout(fx), 'latest')).toBe(before);
  });
});

describe('⑨ P4 验证契约门禁注入（deps 回调；ok=false 不触碰版本库；ok=true 对象挂载 verification）', () => {
  fixtureIt('注入 fake gate ok=false → 不晋升（版本库无提交 / outcome.promoted=false / reason 含门禁拒绝）', async () => {
    fx = buildLayoutFixture();
    const before = resolveLineCommit(makeLayout(fx), 'latest');
    const outcome = await runCandidatePipeline(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      {
        layout: makeLayout(fx),
        evolutionRoot: poolRootOf(fx),
        baselinePolicyDir: await baselinePolicyDirOf(fx),
        verificationGate: async () => ({ ok: false, reason: 'fake 门禁拒绝（信任不足）' }),
      },
    );
    expect(outcome.validated).toBe(true); // G1-G4 验证本身通过
    expect(outcome.promoted).toBe(false);
    expect(outcome.reason).toContain('验证契约门禁拒绝');
    expect(outcome.reason).toContain('fake 门禁拒绝（信任不足）');
    expect(resolveLineCommit(makeLayout(fx), 'latest')).toBe(before); // 版本库无提交（trusted-latest 未动）
  });

  fixtureIt('注入 fake gate ok=true → 正常晋升；Evolution Object 携带 verification payload', async () => {
    fx = buildLayoutFixture();
    const outcome = await runCandidatePipeline(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      {
        layout: makeLayout(fx),
        evolutionRoot: poolRootOf(fx),
        baselinePolicyDir: await baselinePolicyDirOf(fx),
        verificationGate: async () => ({
          ok: true,
          reason: 'fake 门禁通过',
          verification: { verdict: 'PASS', verifier_trust: 'L2', contract_id: 'candidate:test' },
        }),
      },
    );
    expect(outcome.promoted).toBe(true);
    const raw = showFile(fx, outcome.commit_hash!, `.evolution-objects/${candidateDirName(outcome.object_id!)}.json`)!;
    const obj = EvolutionObjectSchema.parse(JSON.parse(raw));
    expect(obj.verification).toEqual({ verdict: 'PASS', verifier_trust: 'L2', contract_id: 'candidate:test' });
  });

  fixtureIt('注入真实 runCandidateGate（全过）→ 正常晋升；对象 verification 为内核契约判定 payload', async () => {
    fx = buildLayoutFixture();
    const outcome = await runCandidatePipeline(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      {
        layout: makeLayout(fx),
        evolutionRoot: poolRootOf(fx),
        baselinePolicyDir: await baselinePolicyDirOf(fx),
        verificationGate: async (ctx) => {
          const g = runCandidateGate(ctx.draft, {
            g1: ctx.validation.gates.g1?.ok === true,
            g3: ctx.validation.gates.g3?.ok === true,
            g4: ctx.validation.gates.g4?.ok === true,
          });
          return {
            ok: g.ok,
            reason: g.reason,
            verification: g.ok
              ? { verdict: g.result.verdict, verifier_trust: 'L2', contract_id: g.result.contract_id }
              : undefined,
          };
        },
      },
    );
    expect(outcome.promoted).toBe(true);
    const raw = showFile(fx, outcome.commit_hash!, `.evolution-objects/${candidateDirName(outcome.object_id!)}.json`)!;
    const obj = EvolutionObjectSchema.parse(JSON.parse(raw));
    expect(obj.verification?.verdict).toBe('PASS');
    expect(obj.verification?.verifier_trust).toBe('L2');
    expect(obj.verification?.contract_id).toMatch(/^candidate:sha256:/);
  });

  fixtureIt('未注入 gate → 既有行为（正常晋升；对象无 verification 字段）', async () => {
    fx = buildLayoutFixture();
    const outcome = await runCandidatePipeline(
      draft('kernel/policy/evolve.yaml', await evolveTweakContent(0.95)),
      {
        layout: makeLayout(fx),
        evolutionRoot: poolRootOf(fx),
        baselinePolicyDir: await baselinePolicyDirOf(fx),
      },
    );
    expect(outcome.promoted).toBe(true);
    const raw = showFile(fx, outcome.commit_hash!, `.evolution-objects/${candidateDirName(outcome.object_id!)}.json`)!;
    expect((JSON.parse(raw) as { verification?: unknown }).verification).toBeUndefined();
  });
});
