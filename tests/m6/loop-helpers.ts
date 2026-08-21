// M6 整体连通测试共享工具（非测试文件）：tests/m6/milestone-loop.test.ts 的常量/工厂/真实 absorb deps。
// 单文件 LOC 预算（CONVENTIONS §9）：数据与工具归本模块，行为断言归 milestone-loop.test.ts。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalJson, makeImmutableId, makeMutableId, type Fingerprint, type Provenance } from '../../kernel/schemas/base.js';
import type { ActivationContract, EvolutionObject, Memory } from '../../kernel/schemas/m.js';
import type { CapabilityContract, CapabilityProvider, CapabilityResult } from '../../kernel/capability-abi.js';
import type { Intent } from '../../runtime/intent.js';
import type { Resolution } from '../../runtime/broker.js';
import type { CandidateRecord } from '../../supervisor/candidates.js';
import { ReplayRunner, type ReplayFixture, type ReplayProcessDef } from '../../supervisor/replay.js';
import { packObject, unpackObject, type AbsorbDeps } from '../../supervisor/share.js';
import { runVerification } from '../../supervisor/validate.js';
import { base, TS } from '../m1/ir-samples.js';

// ---- 常量 ----

/** 预设根（runVerification workspace；fixture 解析基准） */
export const WS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 测试环境指纹（§4.4） */
const ENV: Fingerprint = { os: 'win32', node: 'v24', dsh_version: '0.6.0', project: 'omb-v2' };

/** m5 回放 fixture 目录（G3 真实确定性回放用，§9.2） */
const FIXTURES_DIR = join(WS, 'tests', 'm5', 'fixtures');

// ---- provider/intent 工厂（同 tests/m6a fixture 形态） ----

export function makeContract(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    id: `capability:${crypto.randomUUID()}`,
    name: 'read-file',
    input: z.object({ path: z.string() }),
    output: z.object({ text: z.string() }),
    cost: { tokens: 10, latency_ms: 5 },
    side_effect: 'read_only',
    reversibility: { declared: false },
    reliability: 'high',
    evidence_quality: 'verified',
    idempotency: 'idempotent',
    concurrency: 'safe',
    authority_scope: 'user',
    ...overrides,
  };
}

type ExecuteFn = (input: unknown) => Promise<CapabilityResult>;

export function makeProvider(overrides: Partial<CapabilityContract> = {}, execute?: ExecuteFn): CapabilityProvider {
  const manifest = makeContract(overrides);
  const fn: ExecuteFn =
    execute ??
    (async (input) => ({
      ok: true,
      output: { text: `ok:${JSON.stringify(input)}` },
      metrics: { tokens: 1, latency_ms: 1 },
    }));
  return {
    manifest,
    async createHandle() {
      return { contract: manifest, execute: fn };
    },
  };
}

export function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    verb: 'read',
    object: 'file',
    scope: 'user',
    effects: 'read_only',
    constraints: [],
    required_verification: 'v:1',
    ...overrides,
  };
}

/** resolve 成功分支提取（失败 → fail-loud） */
export function expectOk(res: Resolution): Extract<Resolution, { ok: true }> {
  if (!res.ok) {
    throw new Error(`resolve 失败: ${res.error.code} ${res.error.reason}`);
  }
  return res;
}

// ---- M4/M6 对象工厂（内容寻址，同 tests/m6b fixture 形态） ----

/** EvolutionObject id 的 64hex 部分（objects/<hex>.json 文件名；Windows 目录名不允许 ':'） */
export const hexOf = (id: string): string => id.slice('sha256:'.length);

/** Provenance 工厂（§4.4，M4/M6 对象通用） */
export function mkProvenance(event: string): Provenance {
  return {
    source: 'test/m6loop',
    event,
    actor: 'm6-loop-test',
    environment: ENV,
    runtime_snapshot: 'rs:snapshot-001',
    timestamp: TS,
    transformation_chain: [],
    verification: 'v:fixture',
  };
}

let evoSeq = 0;

/** 确定性 EvolutionObject 工厂：id = sha256(canonical(body))——内容寻址（M4）；seq 单调不重置（共享 registry 下 id 唯一） */
export function mkEvo(over: Partial<Omit<EvolutionObject, 'id'>> = {}): EvolutionObject {
  const body: Omit<EvolutionObject, 'id'> = {
    ir_version: '2.0',
    schema: 'omb/M4',
    scope: 'Project',
    lifecycle: 'active',
    immutable: true,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: mkProvenance(`evolution/m6loop-${evoSeq}`),
    refs: [],
    protocol_version: '2.0',
    parent: null,
    diff: `diff --git a/kernel/x.ts b/kernel/x.ts\n+line-${evoSeq}`,
    compat: 'omb/2.0',
    bench: 'bench/frozen-001',
    spdx: 'MIT',
    verifications: ['cert/t6b-1'],
    ...over,
  };
  evoSeq += 1;
  return { ...body, id: makeImmutableId(canonicalJson(body)) };
}

/** M6 ActivationContract 工厂（软接管审计记录形态；M6 schema，⑦ 抽查） */
export function mkActivation(over: Partial<ActivationContract> = {}): ActivationContract {
  return {
    id: makeMutableId('ac'),
    ir_version: '2.0',
    schema: 'omb/M6',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: mkProvenance('evolution/takeover-audit'),
    refs: [],
    predecessor: 'capability:third-party',
    candidate: 'capability:platform',
    required_capabilities: ['read-file'],
    evidence_certificate: 'cert/takeover-1',
    compatible_schema: 'omb/2.0',
    activation_scope: 'Project',
    rollback_snapshot: `sha256:${'0'.repeat(64)}`,
    ...over,
  };
}

/** M1 Memory 工厂（候选对象，同 m5 loop-helpers 形态） */
export function makeMemory(payload: string): Memory {
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: mkProvenance(makeMutableId('evt')),
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}

let candSeq = 0;

/** CandidateRecord 工厂（确定性 id：sha256:<64hex>；共享 .evolution 下全文件唯一——调用方不得重置 seq） */
export function mkRec(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id: `sha256:${String(candSeq++).padStart(64, '0')}`,
    kind: 'memory',
    status: 'untrusted',
    parent: null,
    lineage: [],
    gates_passed: ['G1'],
    created: Date.now(),
    provenance: 'test/m6loop',
    ...over,
  };
}

// ---- absorb 真实依赖（全过；禁 mock——真实模块 + 真实 fixture） ----

/** G3 回放过程（与 tests/m5/fixtures/chain.fixture.json 对应：单 EXECUTE，常量输入 { q: 'hello' }，同 m5 validate.test.ts） */
const CHAIN_PROCESS: ReplayProcessDef = {
  id: 'p:m6-replay',
  version: '1.0.0',
  entry: 'EXECUTE',
  exit: 'EXECUTE',
  operators: [{ id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'result' }],
};

/**
 * absorb 管线真实依赖（全过）：
 *   verifyChain  = 真实 T5.2 验证链（runVerification G1 schema:M4 静态门，对象过盘上候选目录）；
 *   replayBench  = 真实 G3 确定性回放（ReplayRunner + 真实 frozen fixture tests/m5/fixtures/chain.fixture.json）；
 *   contractTests= 真实共享协议契约（packObject/unpackObject 往返一致）。
 * root 为临时目录（verifyChain 的 G1 候选目录落盘根）。
 */
export function realDeps(root: string, over: { instance?: string; diversity?: number } = {}): AbsorbDeps {
  return {
    verifyChain: async (o) => {
      const dir = join(root, 'g1', hexOf(o.id).slice(0, 16));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'object.json'), JSON.stringify(o), 'utf8');
      const results = await runVerification(
        { candidate_id: o.id, gates: [{ gate: 'G1', checks: ['schema:M4'] }] },
        { candidateDir: dir, workspace: WS },
      );
      const r = results[0]!;
      return r.ok ? { ok: true, detail: `G1 验证链通过: ${r.detail}` } : { ok: false, detail: `G1 拒绝: ${r.detail}` };
    },
    replayBench: async (o) => {
      const fixture = JSON.parse(await readFile(join(FIXTURES_DIR, 'chain.fixture.json'), 'utf8')) as ReplayFixture;
      const r = await new ReplayRunner(fixture).run(CHAIN_PROCESS, {
        execute: async () => {
          throw new Error('真实执行器不参与回放（canned 未命中即 fail-loud）');
        },
      });
      return r.ok ? { ok: true, detail: `回放 bench（${o.bench}）确定性通过` } : { ok: false, detail: r.detail ?? '回放失败' };
    },
    contractTests: async (o) => {
      try {
        const back = unpackObject(packObject(o, 'contract-test'));
        return JSON.stringify(back.obj) === JSON.stringify(o)
          ? { ok: true, detail: '共享协议契约测试通过（pack/unpack 往返一致）' }
          : { ok: false, detail: 'pack/unpack 往返不一致' };
      } catch (err) {
        return { ok: false, detail: `契约测试失败: ${String(err)}` };
      }
    },
    instance: over.instance ?? 'm6-loop-instance',
    diversity: over.diversity ?? 1,
  };
}
