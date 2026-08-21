// T8.21 行为测试：能力向量三维真实化（施工计划 T8.21；依赖 T8.14 Verification Synthesis + T8.19 组件）。
// generalization / interpretability / contamination_risk 由 L3 占位（blinded_judge）→ 真实采集路径：
// - generalization：检索 episode 统计（跨 scope 命中率；真实来源 = retrieval_episode 表，§7.4 归因）；
// - interpretability：oracle 可复现性（T8.14 reproduction oracle 判定；真实来源 = OracleVerdict 执行产物）；
// - contamination_risk：信任池来源审计（T5.1 CandidatePool；真实来源 = .evolution trusted/untrusted/rejected）。
// 验收（brief）：三维独立事实有真实来源（信号 kind 从 L3 占位改为真实采集路径）；测试证明来源接入。
// fixture：mkdtemp 临时 db + .evolution（不动真实目录，CONVENTIONS §6）。
// Windows 注意：WAL 侧车文件锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { recordEpisode, reportEpisodeOutcome } from '../../memory/utility.js';
import { CandidatePool } from '../../supervisor/candidates.js';
import {
  runReproductionOracle,
  type OracleSpec,
  type OracleTask,
  type OracleVerdict,
  type SandboxLike,
} from '../../supervisor/oracle.js';
import { evaluate, getFact } from '../../runtime/evolution-evaluator.js';
import {
  collectContaminationSignals,
  collectGeneralizationSignals,
  collectInterpretabilitySignals,
} from '../../runtime/signal-collectors.js';
import { PROV, TS } from '../m1/ir-samples.js';

const NOW = Date.now();
const WINDOW = { from: 0, to: NOW + 60_000 };
const TARGET = `sha256:${'t'.repeat(64)}`;

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];
const roots: string[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-t821-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-t821-root-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** M1 Memory 工厂（六计数器默认全 0；provenance.event 每次唯一——幂等键） */
function makeMemory(over: Record<string, unknown> = {}): Memory {
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: '真实采集数据样本',
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

// ---- 真实 oracle 沙箱（与 T8.14 oracle.test.ts 同款：脚本写入临时目录 → node spawn 真执行） ----

function makeNodeSandbox(): SandboxLike {
  return {
    async run(input) {
      const dir = await mkdtemp(join(tmpdir(), 'omb-t821-oracle-'));
      try {
        const scriptPath = join(dir, 'oracle-script.cjs');
        await writeFile(scriptPath, input.script, 'utf8');
        const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [scriptPath, JSON.stringify(input.input)], {
            cwd: dir,
            windowsHide: true,
          });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        });
        return { code: result.code ?? 1, output: '', stderr: result.stderr };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

const ORACLE_TASK: OracleTask = {
  task_id: 'bench:no-verifier',
  goal: '计算 6×7',
  candidate_output: { answer: 42 },
};

/** 确定性复现脚本：校验候选输出对锚（独立规范事实 spec-42）的忠实度 */
function buildScript(): string {
  return [
    `const input = JSON.parse(process.argv[2] ?? 'null');`,
    `if (input && typeof input === 'object' && input.answer === 42) {`,
    `  process.exit(0);`,
    `} else {`,
    `  console.error('MISMATCH');`,
    `  process.exit(1);`,
    `}`,
  ].join('\n');
}

function spec(over: Partial<OracleSpec> = {}): OracleSpec {
  return {
    script: buildScript(),
    anchor: { source: 'spec', ref: 'spec-42' },
    adversarial: { input: { answer: 41 }, expect_fail: true },
    ...over,
  };
}

describe('T8.21 generalization 真实化（跨 scope 检索 episode 统计 → L1 scope_hit/scope_miss）', () => {
  it('真实 retrieval_episode 数据（跨 Session/Project/Global，hit×4 + miss×2）→ 采集 → evaluate → 事实 = 4/6', async () => {
    const backend = openBackend(await tmpDb());
    // 三个 scope 的记忆（episode injected_ids 必须指向真实记忆——reportEpisodeOutcome 会 bumpUtility）
    const memSession = await backend.ingest(makeMemory({ scope: 'Session', payload: '会话级事实 alpha' }));
    const memProject = await backend.ingest(makeMemory({ scope: 'Project', payload: '项目级事实 beta' }));
    const memGlobal = await backend.ingest(makeMemory({ scope: 'Global', payload: '全局级事实 gamma' }));

    // 6 次检索 episode（跨 3 scope）：4 次归因 hit、2 次归因 miss
    const outcomes: { scope: string; memoryId: string; outcome: 'hit' | 'miss' }[] = [
      { scope: 'Session', memoryId: memSession, outcome: 'hit' },
      { scope: 'Session', memoryId: memSession, outcome: 'hit' },
      { scope: 'Project', memoryId: memProject, outcome: 'hit' },
      { scope: 'Project', memoryId: memProject, outcome: 'miss' },
      { scope: 'Global', memoryId: memGlobal, outcome: 'hit' },
      { scope: 'Global', memoryId: memGlobal, outcome: 'miss' },
    ];
    for (const o of outcomes) {
      const ep = await recordEpisode(backend, {
        query: `q-${o.scope}-${o.outcome}`,
        scope: o.scope,
        candidate_ids: [o.memoryId],
        ranked_ids: [o.memoryId],
        injected_ids: [o.memoryId],
      });
      await reportEpisodeOutcome(backend, ep.id, o.outcome);
    }

    // 采集（真实来源 = retrieval_episode 表）→ evaluate → generalization 事实
    const signals = await collectGeneralizationSignals(backend, TARGET, WINDOW);
    const v = evaluate(signals, TARGET);
    const fact = getFact(v, 'generalization');
    expect(fact).not.toBeNull();
    expect(fact!.value).toBeCloseTo(4 / 6);
    expect(fact!.sample_size).toBe(6);
    expect(fact!.signal_sources).toContain('L1_mechanical'); // 真实采集（非 L3 占位）
  });

  it('无归因 episode（outcome 全 null）→ 采集空信号 → generalization 事实 null（缺数据不出事实）', async () => {
    const backend = openBackend(await tmpDb());
    const mem = await backend.ingest(makeMemory({ payload: '无归因样本' }));
    await recordEpisode(backend, {
      query: 'q-unattributed',
      scope: 'Project',
      candidate_ids: [mem],
      ranked_ids: [mem],
      injected_ids: [mem],
    }); // 不 reportEpisodeOutcome → outcome null

    const signals = await collectGeneralizationSignals(backend, TARGET, WINDOW);
    expect(signals).toEqual([]);
    expect(getFact(evaluate(signals, TARGET), 'generalization')).toBeNull();
  });
});

describe('T8.21 interpretability 真实化（oracle 可复现性 → L1 oracle_pass/oracle_fail）', () => {
  it('真实 reproduction oracle 执行产物（1 ok + 1 fail）→ 采集 → evaluate → 事实 = 0.5', async () => {
    // T8.14 真实 oracle 执行：ok（复现通过 + 对抗按预期被拒）
    const okVerdict = await runReproductionOracle({
      task: ORACLE_TASK,
      spec: spec(),
      sandbox: makeNodeSandbox(),
    });
    expect(okVerdict.ok).toBe(true);
    // fail（对抗样本 expect_fail=false 但实际被拒 → oracle 不可信 → ok:false）
    const failVerdict = await runReproductionOracle({
      task: ORACLE_TASK,
      spec: spec({ adversarial: { input: { answer: 41 }, expect_fail: false } }),
      sandbox: makeNodeSandbox(),
    });
    expect(failVerdict.ok).toBe(false);

    const verdicts: OracleVerdict[] = [okVerdict, failVerdict];
    const signals = collectInterpretabilitySignals(verdicts, TARGET, WINDOW);
    const v = evaluate(signals, TARGET);
    const fact = getFact(v, 'interpretability');
    expect(fact).not.toBeNull();
    expect(fact!.value).toBeCloseTo(0.5); // 1 pass / (1+1)
    expect(fact!.sample_size).toBe(2);
    expect(fact!.signal_sources).toContain('L1_mechanical'); // 真实采集（非 L3 占位）
  });

  it('空 verdicts → 采集空信号 → interpretability 事实 null', () => {
    const signals = collectInterpretabilitySignals([], TARGET, WINDOW);
    expect(signals).toEqual([]);
    expect(getFact(evaluate(signals, TARGET), 'interpretability')).toBeNull();
  });
});

describe('T8.21 contamination_risk 真实化（信任池来源审计 → L1 trusted_object/untrusted_object）', () => {
  it('真实 CandidatePool（5 候选：promote 2 + reject 1）→ 采集 → evaluate → 事实 = (2+1)/5 = 0.6', async () => {
    const root = await tmpRoot();
    const evolutionRoot = join(root, '.evolution');
    await mkdir(evolutionRoot, { recursive: true });
    const pool = new CandidatePool(evolutionRoot);

    const rec = (i: number) => ({
      id: `sha256:${i.toString().padStart(64, '0')}`,
      kind: 'process' as const,
      status: 'untrusted' as const,
      parent: null,
      lineage: [],
      gates_passed: [],
      created: i,
      provenance: `evt:${i}`,
    });
    for (let i = 1; i <= 5; i++) {
      await pool.registerCandidate(rec(i));
    }
    await pool.promote(rec(1)); // trusted
    await pool.promote(rec(2)); // trusted
    await pool.reject(rec(3), '校验失败'); // rejected
    // rec(4)/rec(5) 留 untrusted

    const signals = await collectContaminationSignals(pool, TARGET, WINDOW);
    const v = evaluate(signals, TARGET);
    const fact = getFact(v, 'contamination_risk');
    expect(fact).not.toBeNull();
    expect(fact!.value).toBeCloseTo(3 / 5); // (untrusted 2 + rejected 1) / 5 —— 越高风险越大（越低越好维）
    expect(fact!.sample_size).toBe(5);
    expect(fact!.signal_sources).toContain('L1_mechanical'); // 真实采集（非 L3 占位）
  });

  it('空信任池（无记录）→ 采集空信号 → contamination_risk 事实 null', async () => {
    const root = await tmpRoot();
    const pool = new CandidatePool(join(root, '.evolution')); // 目录不存在 → 空
    const signals = await collectContaminationSignals(pool, TARGET, WINDOW);
    expect(signals).toEqual([]);
    expect(getFact(evaluate(signals, TARGET), 'contamination_risk')).toBeNull();
  });
});

describe('T8.21 L3 占位移除（三维不再由 blinded_judge 喂入；缺数据行为与 m5 既有断言一致）', () => {
  it('仅 L3 blinded_judge 信号（generalization/interpretability/contamination_risk）→ 三维事实全 null（占位已移除）', () => {
    const signals = [
      { layer: 'L3' as const, kind: 'blinded_judge' as const, target: TARGET, dimension: 'generalization' as const, verdict: 'supported' as const },
      { layer: 'L3' as const, kind: 'blinded_judge' as const, target: TARGET, dimension: 'interpretability' as const, verdict: 'supported' as const },
      { layer: 'L3' as const, kind: 'blinded_judge' as const, target: TARGET, dimension: 'contamination_risk' as const, verdict: 'supported' as const },
    ];
    const v = evaluate(signals, TARGET);
    expect(getFact(v, 'generalization')).toBeNull();
    expect(getFact(v, 'interpretability')).toBeNull();
    expect(getFact(v, 'contamination_risk')).toBeNull();
  });

  it('无任何信号 → 三维事实 null（缺信号维不出事实，与 m5/evolution.test.ts ② 一致）', () => {
    const v = evaluate([], TARGET);
    expect(getFact(v, 'generalization')).toBeNull();
    expect(getFact(v, 'interpretability')).toBeNull();
    expect(getFact(v, 'contamination_risk')).toBeNull();
  });
});
