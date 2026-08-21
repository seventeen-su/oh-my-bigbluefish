// M5 整体连通测试共享工具（非测试文件）：tests/m5/milestone-loop.test.ts 的常量/工厂/deps 注入装配。
// 单文件 LOC 预算（CONVENTIONS §9 ≤ 400）：数据与工具归本模块，行为断言归 milestone-loop.test.ts。
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMutableId, type Fingerprint } from '../../kernel/schemas/base.js';
import type { EvolutionObject, Memory, RuntimeSnapshot } from '../../kernel/schemas/m.js';
import type { CapabilityVector, DimensionFact, EvaluationSignal } from '../../runtime/evaluator.js';
import { classify } from '../../runtime/evolution-evaluator.js';
import type { ActivationDeps } from '../../supervisor/activation.js';
import { CandidatePool, type CandidateRecord } from '../../supervisor/candidates.js';
import { createSnapshot, type ComponentHashes, type SnapshotRegistry } from '../../supervisor/versioning.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

// ---- 常量 ----

/** 预设根（runVerification workspace；G2/G3 子进程与 fixture 解析基准） */
export const WS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 测试环境指纹（§4.4） */
export const ENV: Fingerprint = { os: 'test', node: 'v24', dsh_version: '0.5.0', project: 'omb-v2' };

/** fake switchStableHead 的"切换前 stable_head"（Recovery Root 语义，T0.4） */
export const STABLE_HEAD = 'stable-head-0001';

/** consolidate 固定时钟（2026-08-21；链内记忆 updated 早于此 → decay 不触发） */
export const NOW = Date.parse(TS);

/** 组件 sha256 清单（versioning.createSnapshot 六键校验要求） */
export const COMPONENTS: ComponentHashes = {
  scheduler: 'a'.repeat(64),
  memory: 'b'.repeat(64),
  verifier: 'c'.repeat(64),
  renderer: 'd'.repeat(64),
  capability: 'e'.repeat(64),
  philosophy: 'f'.repeat(64),
};

// ---- 工厂 ----

/** RuntimeSnapshot 工厂（不同 gitRevision → 不同 id） */
export function mkSnapshot(gitRevision: string): RuntimeSnapshot {
  return createSnapshot({ components: COMPONENTS, gitRevision });
}

let seq = 0;
/** 确定性候选 id（sha256:<64hex>；共享 .evolution 下全文件唯一——调用方不得重置 seq） */
export function nextId(): string {
  return `sha256:${String(seq++).padStart(64, '0')}`;
}

/** CandidateRecord 工厂（缺省：process / untrusted / 无父 / G1+G2 已过） */
export function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: nextId(),
    kind: 'process',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1', 'G2'],
    created: Date.now(),
    provenance: 'test/fixture',
    ...over,
  };
}

/** M1 Memory 工厂（T5.4 同款）：provenance.event 每次唯一（幂等键）；updated 控制 consolidate 判定 */
export function makeMemory(over: { payload: string; updated?: string }): Memory {
  const updated = over.updated ?? TS;
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: updated,
    updated,
    provenance: { ...PROV, event: makeMutableId('evt'), timestamp: updated },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: over.payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}

/** 信号序列：L1 成功率高 + L2 bench_score（样本 30 ≥ MIN_SAMPLES） */
export function mkSignals(target: string, bench: number): EvaluationSignal[] {
  return [
    { layer: 'L1', kind: 'tool_success', target, count: 98, window: { from: 0, to: 1000 } },
    { layer: 'L1', kind: 'tool_failure', target, count: 2, window: { from: 0, to: 1000 } },
    { layer: 'L2', kind: 'bench_score', target, value: bench, sample_size: 30, bench_ref: 'bench/frozen-loop' },
  ];
}

/** DimensionFact 工厂（缺省：L2 统计源、样本 30 ≥ MIN_SAMPLES） */
export function fact(dim: DimensionFact['dimension'], value: number | null, over: Partial<DimensionFact> = {}): DimensionFact {
  return {
    dimension: dim,
    value,
    signal_sources: ['L2_statistical'],
    evidence_refs: [],
    sample_size: 30,
    ...over,
  };
}

/** CapabilityVector 工厂（classification 占位；classify 只读 facts） */
export function mkVector(facts: DimensionFact[], over: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    id: 'vector:00000000-0000-4000-8000-000000000001',
    target: 'sha256:t',
    facts,
    classification: 'Unknown',
    classification_confidence: 0,
    environment: ENV,
    created: 0,
    provenance: { source: 'test', events: [] },
    ...over,
  };
}

/** 达标基线（correctness 0.9，样本 30 ≥ MIN_SAMPLES；classify → Stable，过门禁） */
export const OK_BASELINE = mkVector([fact('correctness', 0.9)]);

/** EvolutionObject 盘上文件名（id 的 ':' 在 Windows 目录名非法 → 归一） */
export function evoFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9-]/g, '_')}.json`;
}

// ---- deps 注入装配（T5.5 模式） ----

/** deps 工厂：记录 switch/write 调用；writeEvolutionObject 写真实临时库（storeDir）；
 *  evaluate 缺省返回达标向量（classify → Stable）；checkLineage 可注入真实信任池 */
export function mkDeps(
  registry: SnapshotRegistry,
  nextSnap: RuntimeSnapshot,
  storeDir: string,
  over: Partial<ActivationDeps> = {},
): { deps: ActivationDeps; switched: string[]; written: EvolutionObject[] } {
  const switched: string[] = [];
  const written: EvolutionObject[] = [];
  const deps: ActivationDeps = {
    switchStableHead: async (h: string) => {
      switched.push(h);
      return { previous: STABLE_HEAD, new: h };
    },
    writeEvolutionObject: async (o: EvolutionObject) => {
      written.push(o);
      await writeFile(join(storeDir, evoFileName(o.id)), JSON.stringify(o), 'utf8');
    },
    snapshotRegistry: registry,
    nextSnapshot: () => nextSnap,
    evaluate: () => mkVector([fact('correctness', 0.9)]),
    classify,
    checkLineage: () => ({ ok: true }),
    ...over,
  };
  return { deps, switched, written };
}

/** 注册 + 晋升 + load 盘上最新记录（返回 trusted 记录；消费方入口 = load-before-guard） */
export async function mkTrusted(pool: CandidatePool, over: Partial<CandidateRecord> = {}): Promise<CandidateRecord> {
  const r = mkRec(over);
  await pool.registerCandidate(r);
  await pool.promote(mkRec({ id: r.id }));
  return pool.load(r.id);
}
