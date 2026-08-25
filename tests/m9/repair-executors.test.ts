// P3.5（2026-08-25-verification-contract）：Repair 真实验证执行器测试（runtime/repair-executors.ts）。
// 覆盖：
//   ① 真实执行器逐项（fake services 注入）：检索一致性（稳定两次 → pass / 构造变化 → fail / 抛错 → unknown /
//     无能力 → unknown）；过程定义结构合法（真实加载面命中 pass / 损坏定义解析失败 fail / 未定位 unknown /
//     加载抛错 fail）；技能定义结构合法（合法 pass / 非法 fail / 无 payload unknown）；策略 schema 合法（合法 fixture pass /
//     坏 YAML fail / 无 dir unknown）；组件健康（匹配+ok → pass / ok=false → fail / 不匹配 → unknown）；
//     能力契约满足（合法契约 pass / 非法 fail / 无契约字段 unknown）；投影 schema（合法 pass / 非法 fail）；
//     必填字段齐全（复用投影 pass / 非投影 unknown）；快照物化（存在 pass / 缺失 fail / 无快照 unknown）；
//     冒烟套件（policy+processes 可加载 pass / 坏 policy fail）；generic JSON 校验（对象/JSON 字符串 pass /
//     数组/非 JSON 字符串 fail）；对象可检索（命中 pass / 未命中 fail）
//   ② 诚实 unknown 路径：无矛盾/重放一致/代表任务/冻结回归集/可恢复 → unknown + detail 非空；未注册检查名 → unknown
//   ③ 集成（createCognitiveRuntime + fixture 布局，参照 tests/m9/repair-contract.test.ts）：decay 记录 →
//     runRepair → RepairRecord.objects 条目含多检查证据（evidence_quality 提高 0.67）、verdict/disposition 正确、
//     detail 聚合检查结果；检索一致性真实走 memory retrieve（episode=false 只读）；generic 契约 PASS 路径
//     （对象存在且可读 + 对象结构 schema 校验 → PASS → reverified）；幂等（重复执行同结果）
//   ④ 确定性：同输入同输出（executeCheck 两次 → deep equal）
//   ⑤ P3.6 数据面执行器（只读事实库/基线库）：无矛盾（无事实 unknown / 任一 valid=false fail / 全 valid pass）；
//     重放一致（无基线 unknown / 全匹配 pass / 环境指纹不匹配 unknown / current 缺失 unknown）；
//     代表任务（无基线 unknown / 匹配 pass）；冻结回归集（无基线 unknown / 全等 pass / 差异 case fail——
//     真实 decideEvolution 重跑 / 占位注册 unknown）；可恢复（无基线 unknown / 重建输入齐备 pass / 占位 unknown）；
//     真实数据面 duck-typed 注入（supervisor 实例）；确定性
//   ⑥ P3.6 runRepair 集成：policy 对象结构全 pass 且无基线 → 基线自动注册（版本化字段齐备）；第二次有基线
//     分支不重复注册；回归集覆写注册后重跑全等 → PASS；幂等
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';
import type { CapabilityDecayRecord } from '../../kernel/schemas/evolution.js';
import { loadPolicy, loadProcesses } from '../../kernel/policy-loader.js';
import { decideEvolution } from '../../kernel/evolve-decision.js';
import type { EvolvePolicy } from '../../kernel/schemas/policy.js';
import type { SignalSummary } from '../../kernel/schemas/evolution.js';
import { BaselineStore, FactStore, type BaselineRecord, type FactRecord } from '../../supervisor/verification-stores.js';
import {
  createRepairExecutors,
  VERIFIER_VERSION,
  type RepairExecutorServices,
} from '../../runtime/repair-executors.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { A3_VALID, P3_VALID, P5_VALID, PROV, TS, base, omit } from '../m1/ir-samples.js';

// ---- 测试工具 ----

const REPO_POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));
const REPO_PROCESSES_DIR = fileURLToPath(new URL('../../kernel/processes', import.meta.url));

const FP_V22: Fingerprint = { os: 'win32', node: 'v22.0.0', dsh_version: '0.1.0', project: 'omb-v2' };

/** fake 服务缺省（memory 命中 + 无其它面；over 覆盖被测面） */
function fakeServices(over: Partial<RepairExecutorServices> = {}): RepairExecutorServices {
  return {
    memory: { getById: async () => ({ id: 'm-1', payload: 'fixture payload' }) },
    ...over,
  };
}

/**
 * P3.6：fake 验证数据面（facts/baselines duck-typed 最小形状——未注入 → 对应检查 unknown；
 * over.facts.factsFor / over.baselines.getBaseline 覆写被测面）。
 */
function fakeStores(
  over: {
    facts?: { factsFor?: () => Promise<FactRecord[]> };
    baselines?: { getBaseline?: (id: string, kind: string) => Promise<BaselineRecord | null> };
  } = {},
): RepairExecutorServices {
  return {
    memory: { getById: async () => ({ id: 'm-1', payload: 'fixture payload' }) },
    stores: {
      facts: {
        factsFor: over.facts?.factsFor ?? (async () => []),
      },
      baselines: {
        getBaseline: over.baselines?.getBaseline ?? (async () => null),
      },
    },
  };
}

const roots: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

async function tmpRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function trackRuntime(rt: ReturnType<typeof createCognitiveRuntime>): ReturnType<typeof createCognitiveRuntime> {
  runtimes.push(rt);
  return rt;
}

/** M1 Memory 工厂（最小 fixture：id 唯一 + 合法 schema；环境声明面 repair 不消费） */
function makeMemory(payload: string): Memory {
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt'), environment: FP_V22 },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}

/** decay 记录落盘（.evolution/decay/<file>.json；over 覆写缺省字段） */
async function writeDecay(root: string, file: string, over: Partial<CapabilityDecayRecord>): Promise<void> {
  const record: CapabilityDecayRecord = {
    ts: Date.now(),
    environment_delta: {},
    affected_objects: [],
    regression_set: [],
    capability_vector_before: {},
    capability_vector_after: {},
    attribution: {},
    fingerprint_before: FP_V22,
    fingerprint_after: FP_V22,
    ...over,
  };
  const dir = join(root, '.evolution', 'decay');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(record), 'utf8');
}

/** 线快照 fixture：<dir>/kernel/policy + <dir>/kernel/processes（真实仓库文件拷贝） */
async function makeLineSnapshotFixture(): Promise<string> {
  const dir = await tmpRoot('omb-repair-snap-');
  await cp(REPO_POLICY_DIR, join(dir, 'kernel', 'policy'), { recursive: true });
  await cp(REPO_PROCESSES_DIR, join(dir, 'kernel', 'processes'), { recursive: true });
  return dir;
}

// ---- ① 真实执行器逐项（fake services 注入） ----

describe('① 真实执行器逐项（fake services 注入）', () => {
  it('对象可检索（getById 命中）：命中 → pass；未命中 → fail；抛错 → fail', async () => {
    const ex = createRepairExecutors(fakeServices({ memory: { getById: async () => ({ id: 'm-1' }) } }));
    const hit = await ex.executeCheck('对象可检索（getById 命中）', { objectId: 'm-1', kind: 'memory' });
    expect(hit.result).toBe('pass');
    expect(hit.detail).toContain('命中');
    const exMiss = createRepairExecutors(fakeServices({ memory: { getById: async () => undefined } }));
    expect((await exMiss.executeCheck('对象可检索（getById 命中）', { objectId: 'gone', kind: 'memory' })).result).toBe('fail');
    const exThrow = createRepairExecutors(fakeServices({ memory: { getById: async () => { throw new Error('db boom'); } } }));
    expect((await exThrow.executeCheck('对象可检索（getById 命中）', { objectId: 'm-1', kind: 'memory' })).result).toBe('fail');
  });

  it('检索一致性：稳定两次 → pass（retrieve 恰好调用两次）', async () => {
    let calls = 0;
    const ex = createRepairExecutors(
      fakeServices({
        memory: {
          getById: async () => ({ id: 'm-1' }),
          retrieve: async () => {
            calls += 1;
            return { items: [{ memory: { id: 'm-1' } }, { memory: { id: 'm-2' } }] };
          },
        },
      }),
    );
    const out = await ex.executeCheck('检索一致性（同查询同结果）', { objectId: 'm-1', kind: 'memory', payload: '查询文本 abc' });
    expect(out.result).toBe('pass');
    expect(calls).toBe(2); // 两次检索（只读语义）
    expect(out.detail).toContain('检索一致性通过');
  });

  it('检索一致性：构造变化（两次 top-5 不同）→ fail', async () => {
    let calls = 0;
    const ex = createRepairExecutors(
      fakeServices({
        memory: {
          getById: async () => ({ id: 'm-1' }),
          retrieve: async () => {
            calls += 1;
            return {
              items:
                calls === 1
                  ? [{ memory: { id: 'm-1' } }]
                  : [{ memory: { id: 'm-1' } }, { memory: { id: 'm-2' } }],
            };
          },
        },
      }),
    );
    const out = await ex.executeCheck('检索一致性（同查询同结果）', { objectId: 'm-1', kind: 'memory', payload: { payload: '带 空 格 的查询' } });
    expect(out.result).toBe('fail');
    expect(out.detail).toContain('不一致');
  });

  it('检索一致性：retrieve 抛错 → unknown；无 retrieve 能力 → unknown；无查询文本 → unknown', async () => {
    const exThrow = createRepairExecutors(
      fakeServices({ memory: { getById: async () => ({ id: 'm-1' }), retrieve: async () => { throw new Error('retrieve boom'); } } }),
    );
    const threw = await exThrow.executeCheck('检索一致性（同查询同结果）', { objectId: 'm-1', kind: 'memory', payload: 'q' });
    expect(threw.result).toBe('unknown');
    expect(threw.detail).toContain('retrieve 抛错');
    const exNoRetrieve = createRepairExecutors(fakeServices({ memory: { getById: async () => ({ id: 'm-1' }) } }));
    const noCap = await exNoRetrieve.executeCheck('检索一致性（同查询同结果）', { objectId: 'm-1', kind: 'memory', payload: 'q' });
    expect(noCap.result).toBe('unknown');
    expect(noCap.detail).toContain('无检索能力');
    const exNoText = createRepairExecutors(
      fakeServices({ memory: { getById: async () => ({ id: 'm-1' }), retrieve: async () => ({ items: [] }) } }),
    );
    const noText = await exNoText.executeCheck('检索一致性（同查询同结果）', { objectId: 'm-1', kind: 'memory', payload: 42 });
    expect(noText.result).toBe('unknown');
    expect(noText.detail).toContain('无可提取的查询文本');
  });

  it('过程定义结构合法：真实加载面命中（真实 ProcessDef）→ pass；损坏定义（解析失败）→ fail；未定位 → unknown；加载抛错 → fail；无 dir → unknown', async () => {
    // 合法定义：真实 loadProcesses + 仓库过程目录（真实 ProcessDef YAML 解析成功 = 结构合法，单一事实源——
    // W4 不再叠加形状不匹配的 P1 ProcessSchema），objectId 命中 → pass
    const ex = createRepairExecutors(fakeServices({ processesDir: REPO_PROCESSES_DIR, loadProcesses }));
    const ok = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'retrieve-verify', kind: 'process' });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('真实加载面');
    // 非法：真实加载面解析失败（损坏 YAML = 结构非法）→ loadProcesses 抛错 → fail
    const badDir = await tmpRoot('omb-repair-badproc-');
    await cp(REPO_PROCESSES_DIR, badDir, { recursive: true });
    await writeFile(join(badDir, 'retrieve-verify.yaml'), 'id: retrieve-verify\noperators: [unclosed\n', 'utf8');
    const exBad = createRepairExecutors(fakeServices({ processesDir: badDir, loadProcesses }));
    const bad = await exBad.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'retrieve-verify', kind: 'process' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('过程加载抛错');
    // 未定位：真实 loadProcesses + 仓库过程目录（合法 ProcessDef 文件），objectId 不在其中 → unknown
    const exMiss = createRepairExecutors(fakeServices({ processesDir: REPO_PROCESSES_DIR, loadProcesses }));
    const miss = await exMiss.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'nope', kind: 'process' });
    expect(miss.result).toBe('unknown');
    expect(miss.detail).toContain('未定位到过程');
    // 加载抛错 → fail
    const exThrow = createRepairExecutors(
      fakeServices({ processesDir: '/fixture', loadProcesses: async () => { throw new Error('proc boom'); } }),
    );
    const threw = await exThrow.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'proc-ok', kind: 'process' });
    expect(threw.result).toBe('fail');
    // 无 processesDir → unknown
    const exNoDir = createRepairExecutors(fakeServices());
    const noDir = await exNoDir.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'proc-ok', kind: 'process' });
    expect(noDir.result).toBe('unknown');
  });

  it('技能定义结构合法：合法 → pass；非法 → fail；无 payload → unknown', async () => {
    const ex = createRepairExecutors(fakeServices());
    const ok = await ex.executeCheck('技能定义结构合法', { objectId: 'sk-1', kind: 'skill', payload: P5_VALID });
    expect(ok.result).toBe('pass');
    const bad = await ex.executeCheck('技能定义结构合法', { objectId: 'sk-2', kind: 'skill', payload: omit(P5_VALID, 'name') });
    expect(bad.result).toBe('fail');
    const none = await ex.executeCheck('技能定义结构合法', { objectId: 'sk-3', kind: 'skill' });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无 payload');
  });

  it('策略 schema 合法：合法 fixture（真实 loadPolicy）→ pass；坏 YAML → fail；无 policyDir → unknown', async () => {
    const ex = createRepairExecutors(fakeServices({ policyDir: REPO_POLICY_DIR, loadPolicy }));
    const ok = await ex.executeCheck('策略 schema 合法', { objectId: 'p-1', kind: 'policy' });
    expect(ok.result).toBe('pass');
    // 坏 YAML：拷贝真实策略目录后破坏 governor.yaml
    const badDir = await tmpRoot('omb-repair-badpol-');
    await cp(REPO_POLICY_DIR, badDir, { recursive: true });
    await writeFile(join(badDir, 'governor.yaml'), 'governor: [unclosed\n', 'utf8');
    const exBad = createRepairExecutors(fakeServices({ policyDir: badDir, loadPolicy }));
    const bad = await exBad.executeCheck('策略 schema 合法', { objectId: 'p-2', kind: 'policy' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('策略加载抛错');
    const exNoDir = createRepairExecutors(fakeServices());
    const noDir = await exNoDir.executeCheck('策略 schema 合法', { objectId: 'p-3', kind: 'policy' });
    expect(noDir.result).toBe('unknown');
  });

  it('组件健康检查：匹配 + ok → pass；ok=false → fail；不匹配 → unknown；服务面缺失 → unknown', async () => {
    const exOk = createRepairExecutors(
      fakeServices({
        components: {
          list: () => [{ manifest_id: 'comp-a', status: 'active' }],
          healthCheck: async () => ({ 'comp-a': { ok: true, detail: 'ok' } }),
        },
      }),
    );
    const ok = await exOk.executeCheck('组件健康检查通过', { objectId: 'comp-a', kind: 'capability' });
    expect(ok.result).toBe('pass');
    const exFail = createRepairExecutors(
      fakeServices({
        components: {
          list: () => [{ manifest_id: 'comp-a', status: 'suspicious' }],
          healthCheck: async () => ({ 'comp-a': { ok: false, detail: 'down' } }),
        },
      }),
    );
    const fail = await exFail.executeCheck('组件健康检查通过', { objectId: 'comp-a', kind: 'capability' });
    expect(fail.result).toBe('fail');
    expect(fail.detail).toContain('健康检查失败');
    const exMiss = createRepairExecutors(
      fakeServices({ components: { list: () => [{ manifest_id: 'comp-a', status: 'active' }], healthCheck: async () => ({}) } }),
    );
    const miss = await exMiss.executeCheck('组件健康检查通过', { objectId: 'not-a-component', kind: 'capability' });
    expect(miss.result).toBe('unknown');
    expect(miss.detail).toContain('非组件');
    const exNoComps = createRepairExecutors(fakeServices());
    const noComps = await exNoComps.executeCheck('组件健康检查通过', { objectId: 'comp-a', kind: 'capability' });
    expect(noComps.result).toBe('unknown');
  });

  it('能力契约满足：合法契约 → pass；非法 → fail；无契约字段 → unknown；非组件 → unknown', async () => {
    const exOk = createRepairExecutors(
      fakeServices({ components: { manifests: () => [{ manifest_id: 'cap-a', contract: P3_VALID.contract }] } }),
    );
    const ok = await exOk.executeCheck('能力契约满足（capability contract）', { objectId: 'cap-a', kind: 'capability' });
    expect(ok.result).toBe('pass');
    const exBad = createRepairExecutors(
      fakeServices({
        components: {
          manifests: () => [{ manifest_id: 'cap-b', contract: omit(P3_VALID.contract as Record<string, unknown>, 'side_effect') }],
        },
      }),
    );
    const bad = await exBad.executeCheck('能力契约满足（capability contract）', { objectId: 'cap-b', kind: 'capability' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('校验失败');
    const exNoContract = createRepairExecutors(
      fakeServices({ components: { manifests: () => [{ manifest_id: 'cap-c', capabilities: ['memory.retrieve'] }] } }),
    );
    const noContract = await exNoContract.executeCheck('能力契约满足（capability contract）', { objectId: 'cap-c', kind: 'capability' });
    expect(noContract.result).toBe('unknown');
    expect(noContract.detail).toContain('无契约字段');
    const exMiss = createRepairExecutors(fakeServices({ components: { manifests: () => [] } }));
    const miss = await exMiss.executeCheck('能力契约满足（capability contract）', { objectId: 'nope', kind: 'capability' });
    expect(miss.result).toBe('unknown');
  });

  it('投影 schema 校验通过：合法投影 → pass；非法 → fail；无 payload → unknown', async () => {
    const ex = createRepairExecutors(fakeServices());
    const ok = await ex.executeCheck('投影 schema 校验通过', { objectId: 'prj-1', kind: 'projection', payload: A3_VALID });
    expect(ok.result).toBe('pass');
    const bad = await ex.executeCheck('投影 schema 校验通过', { objectId: 'prj-2', kind: 'projection', payload: omit(A3_VALID, 'sections') });
    expect(bad.result).toBe('fail');
    const none = await ex.executeCheck('投影 schema 校验通过', { objectId: 'prj-3', kind: 'projection' });
    expect(none.result).toBe('unknown');
  });

  it('必填字段齐全：投影形态 → pass（复用投影校验）；非投影形态 → unknown；无 payload → unknown', async () => {
    const ex = createRepairExecutors(fakeServices());
    const ok = await ex.executeCheck('必填字段齐全（required fields）', { objectId: 'prj-1', kind: 'projection', payload: A3_VALID });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('复用');
    const notProjection = await ex.executeCheck('必填字段齐全（required fields）', { objectId: 'prj-2', kind: 'projection', payload: { a: 1 } });
    expect(notProjection.result).toBe('unknown');
    expect(notProjection.detail).toContain('非投影形态');
    const none = await ex.executeCheck('必填字段齐全（required fields）', { objectId: 'prj-3', kind: 'projection' });
    expect(none.result).toBe('unknown');
  });

  it('快照物化完整可读：子目录存在 → pass；缺失 → fail；无线快照 → unknown', async () => {
    const snapDir = await makeLineSnapshotFixture();
    const ex = createRepairExecutors(fakeServices({ lineSnapshot: { line: 'stable', commit: 'c0', dir: snapDir } }));
    const ok = await ex.executeCheck('快照物化完整可读', { objectId: 'v-1', kind: 'version' });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('物化完整');
    // 缺失：无 kernel/processes 子目录
    const missDir = await tmpRoot('omb-repair-missing-');
    const exMiss = createRepairExecutors(fakeServices({ lineSnapshot: { line: 'stable', commit: 'c0', dir: missDir } }));
    const miss = await exMiss.executeCheck('快照物化完整可读', { objectId: 'v-2', kind: 'version' });
    expect(miss.result).toBe('fail');
    const exNull = createRepairExecutors(fakeServices({ lineSnapshot: null }));
    const none = await exNull.executeCheck('快照物化完整可读', { objectId: 'v-3', kind: 'version' });
    expect(none.result).toBe('unknown');
  });

  it('冒烟套件：policy+processes 可加载 → pass；坏 policy → fail；无线快照 → unknown', async () => {
    const snapDir = await makeLineSnapshotFixture();
    const ex = createRepairExecutors(
      fakeServices({ lineSnapshot: { line: 'stable', commit: 'c0', dir: snapDir }, loadPolicy, loadProcesses }),
    );
    const ok = await ex.executeCheck('冒烟套件通过（smoke suite）', { objectId: 'v-1', kind: 'version' });
    expect(ok.result).toBe('pass');
    // 坏 policy：破坏快照内 governor.yaml
    await writeFile(join(snapDir, 'kernel', 'policy', 'governor.yaml'), 'governor: [unclosed\n', 'utf8');
    const bad = await ex.executeCheck('冒烟套件通过（smoke suite）', { objectId: 'v-2', kind: 'version' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('冒烟套件失败');
    const exNull = createRepairExecutors(
      fakeServices({ lineSnapshot: null, loadPolicy, loadProcesses }),
    );
    const none = await exNull.executeCheck('冒烟套件通过（smoke suite）', { objectId: 'v-3', kind: 'version' });
    expect(none.result).toBe('unknown');
  });

  it('generic 对象结构 schema 校验：JSON 对象 → pass；JSON 字符串对象 → pass；数组/非 JSON 字符串/无 payload → fail', async () => {
    const ex = createRepairExecutors(fakeServices());
    expect((await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g-1', kind: 'custom', payload: { a: 1 } })).result).toBe('pass');
    expect((await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g-2', kind: 'custom', payload: '{"a":1}' })).result).toBe('pass');
    expect((await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g-3', kind: 'custom', payload: [1, 2] })).result).toBe('fail');
    expect((await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g-4', kind: 'custom', payload: 'not json' })).result).toBe('fail');
    expect((await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g-5', kind: 'custom' })).result).toBe('fail');
  });

  it('generic 硬约束别名：对象存在且可读（REPAIR_CHECK_GENERIC_READABLE）≡ getById 命中判定', async () => {
    const ex = createRepairExecutors(fakeServices({ memory: { getById: async () => ({ id: 'g-1' }) } }));
    const ok = await ex.executeCheck('对象存在且可读', { objectId: 'g-1', kind: 'custom' });
    expect(ok.result).toBe('pass');
    const exMiss = createRepairExecutors(fakeServices({ memory: { getById: async () => undefined } }));
    const miss = await exMiss.executeCheck('对象存在且可读', { objectId: 'gone', kind: 'custom' });
    expect(miss.result).toBe('fail');
  });
});

// ---- ② 诚实 unknown 路径 ----

describe('② 诚实 unknown 路径（detail 注明依赖面，不臆造证据）', () => {
  const HONEST_UNKNOWN = [
    '无矛盾（contradiction 检查通过）',
    '重放一致（replay + state_delta 匹配）',
    '代表任务可执行（representative task + output contract）',
    '冻结回归集通过（frozen regression set）',
    '可恢复（restore）',
  ] as const;

  it.each(HONEST_UNKNOWN)('检查名=%s → unknown + detail 非空（注明依赖面）', async (name) => {
    const ex = createRepairExecutors(fakeServices());
    const out = await ex.executeCheck(name, { objectId: 'x', kind: 'k' });
    expect(out.result).toBe('unknown');
    expect(out.detail).toBeTruthy();
  });

  it('未注册检查名 → unknown + detail 注明无执行器', async () => {
    const ex = createRepairExecutors(fakeServices());
    const out = await ex.executeCheck('不存在的检查名', { objectId: 'x', kind: 'k' });
    expect(out.result).toBe('unknown');
    expect(out.detail).toContain('无执行器');
  });
});

// ---- ⑤ P3.6：数据面执行器（只读事实库/基线库；duck-typed fake 注入） ----

describe('⑤ P3.6 数据面执行器（只读事实库/基线库）', () => {
  const FP: Record<string, unknown> = { os: 'win32', node: 'v22.0.0', dsh_version: '0.1.0', project: 'omb-v2' };
  const CURRENT = { environment_fingerprint: FP, runtime_snapshot: 'rs:same', verifier_version: VERIFIER_VERSION };
  const BASE: BaselineRecord = {
    id: 'obj-1',
    kind: 'process',
    input: { in: 1 },
    environment_fingerprint: FP,
    runtime_snapshot: 'rs:same',
    expected_result: { verdict: 'PASS' },
    verifier_version: VERIFIER_VERSION,
  };

  it('无矛盾：无相关事实 → unknown；任一 valid=false → fail；全 valid → pass', async () => {
    const exNone = createRepairExecutors(fakeStores());
    const none = await exNone.executeCheck('无矛盾（contradiction 检查通过）', { objectId: 'obj-1', kind: 'memory' });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无相关事实');
    const exFail = createRepairExecutors(
      fakeStores({ facts: { factsFor: async () => [{ id: 'c1', text: '已推翻', provenance: 'obj-1', valid: false }] } }),
    );
    const fail = await exFail.executeCheck('无矛盾（contradiction 检查通过）', { objectId: 'obj-1', kind: 'memory' });
    expect(fail.result).toBe('fail');
    expect(fail.detail).toContain('矛盾');
    const exPass = createRepairExecutors(
      fakeStores({
        facts: {
          factsFor: async () => [
            { id: 'c1', text: 't1', provenance: 'obj-1', valid: true },
            { id: 'c2', text: 't2', provenance: 'obj-1', valid: true },
          ],
        },
      }),
    );
    const pass = await exPass.executeCheck('无矛盾（contradiction 检查通过）', { objectId: 'obj-1', kind: 'memory' });
    expect(pass.result).toBe('pass');
    expect(pass.detail).toContain('全部有效');
  });

  it('无矛盾：数据面未注入（stores 缺省）→ unknown（诚实不臆造）', async () => {
    const ex = createRepairExecutors(fakeServices());
    const out = await ex.executeCheck('无矛盾（contradiction 检查通过）', { objectId: 'obj-1', kind: 'memory' });
    expect(out.result).toBe('unknown');
    expect(out.detail).toContain('事实库不可用');
  });

  it('重放一致：无 process 基线 → unknown（建议首次验证后注册）；全匹配 → pass；环境指纹不匹配 → unknown', async () => {
    const exNone = createRepairExecutors(fakeStores());
    const none = await exNone.executeCheck('重放一致（replay + state_delta 匹配）', {
      objectId: 'obj-1',
      kind: 'process',
      current: CURRENT,
    });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无 process 基线');
    const exPass = createRepairExecutors(fakeStores({ baselines: { getBaseline: async () => BASE } }));
    const pass = await exPass.executeCheck('重放一致（replay + state_delta 匹配）', {
      objectId: 'obj-1',
      kind: 'process',
      current: CURRENT,
    });
    expect(pass.result).toBe('pass');
    expect(pass.detail).toContain('全匹配');
    // 环境指纹不匹配 → unknown（基线过期需重放确认）
    const exFp = createRepairExecutors(
      fakeStores({ baselines: { getBaseline: async () => ({ ...BASE, environment_fingerprint: { os: 'linux' } }) } }),
    );
    const fp = await exFp.executeCheck('重放一致（replay + state_delta 匹配）', {
      objectId: 'obj-1',
      kind: 'process',
      current: CURRENT,
    });
    expect(fp.result).toBe('unknown');
    expect(fp.detail).toContain('基线过期');
  });

  it('重放一致：ctx.current 缺失 → unknown（版本化对比无法执行，不臆造 pass）', async () => {
    const ex = createRepairExecutors(fakeStores({ baselines: { getBaseline: async () => BASE } }));
    const out = await ex.executeCheck('重放一致（replay + state_delta 匹配）', { objectId: 'obj-1', kind: 'process' });
    expect(out.result).toBe('unknown');
  });

  it('代表任务：无 skill-task 基线 → unknown；版本化对比匹配 → pass', async () => {
    const exNone = createRepairExecutors(fakeStores());
    const none = await exNone.executeCheck('代表任务可执行（representative task + output contract）', {
      objectId: 'sk-1',
      kind: 'skill',
      current: CURRENT,
    });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无 skill-task 基线');
    const exPass = createRepairExecutors(
      fakeStores({ baselines: { getBaseline: async () => ({ ...BASE, id: 'sk-1', kind: 'skill-task' }) } }),
    );
    const pass = await exPass.executeCheck('代表任务可执行（representative task + output contract）', {
      objectId: 'sk-1',
      kind: 'skill',
      current: CURRENT,
    });
    expect(pass.result).toBe('pass');
  });

  it('冻结回归集：无基线 → unknown；全等 → pass（真实 decideEvolution 重跑）；任一不等 → fail（detail 列差异 case）', async () => {
    const policy = {
      signal_triggers: { memory_ops: { evolve: true, strength: 1, object_layer: 'L2' } },
      debt_thresholds: { soft: 100, hard: 1000, critical: 5000 },
      daily_evolution_cost: 10000,
    } as unknown as EvolvePolicy;
    const signals: SignalSummary = { window: { from: 0, to: 0 }, counts: { memory_ops: 3 } };
    // 期望判定用真实 kernel 纯函数算出（以真实导入优先——冻结回归集重跑与期望同源）
    const expected = decideEvolution({ summary: signals, policy });
    const exNone = createRepairExecutors(fakeStores());
    const none = await exNone.executeCheck('冻结回归集通过（frozen regression set）', { objectId: 'pol-1', kind: 'policy' });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无 policy-regression 基线');
    const exPass = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({ ...BASE, id: 'pol-1', kind: 'policy-regression', input: { policy, cases: [{ signals, expected_decision: expected }] } }),
        },
      }),
    );
    const pass = await exPass.executeCheck('冻结回归集通过（frozen regression set）', { objectId: 'pol-1', kind: 'policy' });
    expect(pass.result).toBe('pass');
    expect(pass.detail).toContain('全部与基线期望一致');
    const exFail = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({
            ...BASE,
            id: 'pol-1',
            kind: 'policy-regression',
            input: { policy, cases: [{ signals, expected_decision: { ...expected, strength: 0 } }] },
          }),
        },
      }),
    );
    const fail = await exFail.executeCheck('冻结回归集通过（frozen regression set）', { objectId: 'pol-1', kind: 'policy' });
    expect(fail.result).toBe('fail');
    expect(fail.detail).toContain('case[0]');
    // 占位注册（input = 对象 payload，无回归 case）→ unknown
    const exPh = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({ ...BASE, id: 'pol-1', kind: 'policy-regression', input: 'policy yaml payload' }),
        },
      }),
    );
    const ph = await exPh.executeCheck('冻结回归集通过（frozen regression set）', { objectId: 'pol-1', kind: 'policy' });
    expect(ph.result).toBe('unknown');
    expect(ph.detail).toContain('占位注册');
  });

  it('可恢复：无基线 → unknown；重建输入齐备 + payload 合法投影 → pass；占位注册（无重建输入）→ unknown', async () => {
    const exNone = createRepairExecutors(fakeStores());
    const none = await exNone.executeCheck('可恢复（restore）', { objectId: 'prj-1', kind: 'projection' });
    expect(none.result).toBe('unknown');
    expect(none.detail).toContain('无 projection-rebuild 基线');
    const exPass = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({ ...BASE, id: 'prj-1', kind: 'projection-rebuild', input: { rebuild_input: 'source' } }),
        },
      }),
    );
    const pass = await exPass.executeCheck('可恢复（restore）', { objectId: 'prj-1', kind: 'projection', payload: A3_VALID });
    expect(pass.result).toBe('pass');
    // memory 包装（payload JSON 字符串）也可解析为合法投影
    const exWrapper = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({ ...BASE, id: 'prj-1', kind: 'projection-rebuild', input: { rebuild_input: 'source' } }),
        },
      }),
    );
    const wrapper = await exWrapper.executeCheck('可恢复（restore）', {
      objectId: 'prj-1',
      kind: 'projection',
      payload: { payload: JSON.stringify(A3_VALID) },
    });
    expect(wrapper.result).toBe('pass');
    // 占位注册（input = 对象 payload，无 rebuild_input）→ unknown
    const exPh = createRepairExecutors(
      fakeStores({
        baselines: {
          getBaseline: async () => ({ ...BASE, id: 'prj-1', kind: 'projection-rebuild', input: 'raw payload' }),
        },
      }),
    );
    const ph = await exPh.executeCheck('可恢复（restore）', { objectId: 'prj-1', kind: 'projection', payload: A3_VALID });
    expect(ph.result).toBe('unknown');
    expect(ph.detail).toContain('无重建输入');
  });

  it('真实数据面 duck-typed 注入（supervisor 实例 → 执行器只读判定）', async () => {
    const root = await tmpRoot('omb-repair-stores-');
    const facts = new FactStore({ root });
    const baselines = new BaselineStore({ root });
    await facts.registerFact({ id: 'c1', text: '已推翻', provenance: 'obj-1', valid: false });
    await baselines.registerBaseline({ ...BASE, id: 'obj-1', kind: 'process' });
    const ex = createRepairExecutors(fakeServices({ stores: { facts, baselines } }));
    const contradiction = await ex.executeCheck('无矛盾（contradiction 检查通过）', { objectId: 'obj-1', kind: 'memory' });
    expect(contradiction.result).toBe('fail'); // 事实库真实只读 → 命中已推翻事实
    const replay = await ex.executeCheck('重放一致（replay + state_delta 匹配）', {
      objectId: 'obj-1',
      kind: 'process',
      current: CURRENT,
    });
    expect(replay.result).toBe('pass'); // 版本化对比全匹配（真实基线库只读）
  });

  it('确定性：数据面执行器同输入同输出（两次执行 deep equal）', async () => {
    const ex = createRepairExecutors(fakeStores({ baselines: { getBaseline: async () => BASE } }));
    const ctx = { objectId: 'obj-1', kind: 'process', current: CURRENT } as const;
    const r1 = await ex.executeCheck('重放一致（replay + state_delta 匹配）', { ...ctx });
    const r2 = await ex.executeCheck('重放一致（replay + state_delta 匹配）', { ...ctx });
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---- ③ 集成（createCognitiveRuntime + fixture 布局） ----

describe('③ 集成：runRepair 真实验证执行器接线（检索一致性真实走 memory retrieve）', () => {
  it('decay 记录 → runRepair → objects 条目含多检查证据（evidence_quality 提高）、verdict/disposition 正确、detail 聚合', async () => {
    const root = await tmpRoot('omb-repair-ex-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory('受影响对象 X'));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'a.json', { affected_objects: [{ id: memId, kind: 'memory' }] });

    const rec = await runtime.runRepair();
    expect(rec.objects).toHaveLength(1);
    const o = rec.objects[0]!;
    expect(o.id).toBe(memId);
    expect(o.kind).toBe('memory');
    expect(o.contract_id).toBe(`repair:${memId}`);
    // 真实验证执行器：对象可检索 pass + 检索一致性 pass（真实 memory retrieve 两次）→ 无矛盾 unknown
    //（语义面需 P3.6/judge）→ UNKNOWN（诚实），evidence_quality = 2/3 = 0.67（较旧「仅 getById」0.33 提高）
    expect(o.verdict).toBe('UNKNOWN');
    expect(o.evidence_quality).toBe(0.67);
    expect(o.disposition).toBe('keep_suspicious');
    expect(o.score_eligible).toBe(true);
    expect(o.reason).toContain('证据不足');
    // detail 聚合逐检查结果（审计可回溯；检索一致性真实走 memory retrieve → pass）
    expect(o.detail).toContain('对象可检索（getById 命中）=pass');
    expect(o.detail).toContain('检索一致性（同查询同结果）=pass');
    expect(o.detail).toContain('无矛盾（contradiction 检查通过）=unknown');
    // keep_suspicious → lifecycle 保持 Suspicious
    expect((await runtime.memory.getById(memId))!.lifecycle).toBe('Suspicious');
    // 幂等/确定性：重复执行同结果（objects 相等）
    const again = await runtime.runRepair();
    expect(again.objects).toEqual(rec.objects);
    expect(again.objects[0]!.detail).toBe(o.detail);
  });

  it('环境变化路径：environment_delta 非空 → local_regression（处置不变，detail 仍聚合全部检查）', async () => {
    const root = await tmpRoot('omb-repair-ex2-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory('受影响对象 Y'));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'c.json', {
      environment_delta: { node: { from: 'v22.0.0', to: 'v24.0.0' } },
      affected_objects: [{ id: memId, kind: 'memory' }],
    });

    const rec = await runtime.runRepair();
    const o = rec.objects[0]!;
    expect(o.verdict).toBe('UNKNOWN');
    expect(o.evidence_quality).toBe(0.67);
    expect(o.disposition).toBe('local_regression');
    expect(o.detail).toContain('检索一致性（同查询同结果）=pass');
  });

  it('generic 契约 PASS 路径：对象存在且可读 + 对象结构 schema 校验通过 → PASS → reverified（仅 memory kind 恢复 lifecycle）', async () => {
    const root = await tmpRoot('omb-repair-ex3-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory('generic 对象'));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'g.json', { affected_objects: [{ id: memId, kind: 'custom' }] });

    const rec = await runtime.runRepair();
    expect(rec.objects).toEqual([
      {
        id: memId,
        kind: 'custom', // 未列 kind → generic 契约（对象存在且可读 + 对象结构 schema 校验）
        contract_id: `repair:${memId}`,
        verdict: 'PASS',
        evidence_quality: 1, // 2/2 应查检查全有结果（真实执行器）
        disposition: 'clear_suspicious',
        score_eligible: true,
        reason: expect.stringContaining('PASS'),
        detail: '对象存在且可读=pass；对象结构 schema 校验通过=pass',
      },
    ]);
    expect(rec.reverified).toEqual([{ id: memId, kind: 'custom' }]); // PASS = 契约化重验证通过
    expect(rec.missing).toEqual([]);
    // 处置执行：clear_suspicious 仅 memory kind 恢复 lifecycle——generic 仅记录（保持 Suspicious）
    expect((await runtime.memory.getById(memId))!.lifecycle).toBe('Suspicious');
  });

  it('P3.6 集成：policy 对象结构检查全 pass 且无基线 → 基线自动注册（版本化字段齐备）；第二次 runRepair 走有基线分支；回归集注册后重跑全等 → PASS', async () => {
    // 注：经真实 runRepair（payload=Memory 包装）只有 policy 硬检查（策略 schema 合法——目录级校验，
    // 与对象载荷无关）可真实 pass；process/skill/projection 硬检查受既有接线形状（ProcessSchema vs
    // ProcessDef / SkillSchema vs Memory 包装 / ContextProjectionSchema vs Memory 包装）约束无法过——
    // 版本化对比（环境指纹/快照/版本全匹配 → pass）由 ⑤ 单元 + duck-type 覆盖，此处钉住自动注册主链。
    const root = await tmpRoot('omb-repair-bl-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory('policy fixture payload'));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'bl.json', { affected_objects: [{ id: memId, kind: 'policy' }] });

    // 首次：结构检查（策略 schema 合法）pass + 冻结回归集无基线 unknown → UNKNOWN；判定后自动注册基线
    const rec = await runtime.runRepair();
    expect(rec.objects).toHaveLength(1);
    const o = rec.objects[0]!;
    expect(o.verdict).toBe('UNKNOWN');
    expect(o.evidence_quality).toBe(0.5); // 策略 schema 合法 pass（1/2 有结果）+ 回归集 unknown
    expect(o.detail).toContain('策略 schema 合法=pass');
    expect(o.detail).toContain('冻结回归集通过（frozen regression set）=unknown');
    expect(o.detail).toContain('基线已注册，下次可版本化对比');
    // 基线可查且版本化字段全量齐备（环境指纹/运行时快照/期望结果/验证器版本）
    const base = await runtime.baselineStore.getBaseline(memId, 'policy-regression');
    expect(base).not.toBeNull();
    expect(base!.id).toBe(memId);
    expect(base!.kind).toBe('policy-regression');
    expect(base!.verifier_version).toBe('1');
    expect(base!.environment_fingerprint).toHaveProperty('os');
    expect(base!.environment_fingerprint).toHaveProperty('node');
    expect(base!.runtime_snapshot).toMatch(/^rs:/);
    expect(base!.expected_result).toEqual({ verdict: 'UNKNOWN', evidence_quality: 0.5, disposition: 'keep_suspicious' });

    // 第二次：基线已存在 → 不重复注册（list 仍 1；对象 detail 不再含「基线已注册」）；
    // 冻结回归集仍 unknown（占位注册——input=payload 无回归 case，证据 detail 承载，对象 detail 只聚合
    // 检查名=result）——「有基线」分支与版本化对比路径由 ⑤ 单元 + duck-type 覆盖
    const rec2 = await runtime.runRepair();
    const o2 = rec2.objects[0]!;
    expect(o2.detail).toContain('冻结回归集通过（frozen regression set）=unknown');
    expect(o2.detail).not.toContain('基线已注册');
    expect(await runtime.baselineStore.list('policy-regression')).toHaveLength(1);

    // 回归集注册（覆写同 id+kind 基线：冻结策略 + 期望 case）→ 第三次重跑 → 全等 pass → 结构+语义全过 → PASS
    const policy = {
      signal_triggers: { memory_ops: { evolve: true, strength: 1, object_layer: 'L2' } },
      debt_thresholds: { soft: 100, hard: 1000, critical: 5000 },
      daily_evolution_cost: 10000,
    } as unknown as EvolvePolicy;
    const signals: SignalSummary = { window: { from: 0, to: 0 }, counts: { memory_ops: 2 } };
    await runtime.baselineStore.registerBaseline({
      ...base!,
      input: { policy, cases: [{ signals, expected_decision: decideEvolution({ summary: signals, policy }) }] },
    });
    const rec3 = await runtime.runRepair();
    const o3 = rec3.objects[0]!;
    expect(o3.detail).toContain('冻结回归集通过（frozen regression set）=pass');
    expect(o3.verdict).toBe('PASS');
    expect(o3.evidence_quality).toBe(1);
    // 确定性/幂等：第三次重复执行同结果
    const rec3again = await runtime.runRepair();
    expect(rec3again.objects).toEqual(rec3.objects);
  });
});

// ---- ④ 确定性（同输入同输出） ----

describe('④ 确定性：executeCheck 同输入同输出', () => {
  it('检索一致性两次执行 → deep equal（同服务状态）', async () => {
    const ex = createRepairExecutors(
      fakeServices({
        memory: {
          getById: async () => ({ id: 'm-1' }),
          retrieve: async () => ({ items: [{ memory: { id: 'm-1' } }] }),
        },
      }),
    );
    const ctx = { objectId: 'm-1', kind: 'memory', payload: '同查询' } as const;
    const r1 = await ex.executeCheck('检索一致性（同查询同结果）', { ...ctx });
    const r2 = await ex.executeCheck('检索一致性（同查询同结果）', { ...ctx });
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('组件健康与 generic 校验确定性', async () => {
    const ex = createRepairExecutors(
      fakeServices({
        components: {
          list: () => [{ manifest_id: 'comp-a', status: 'active' }],
          healthCheck: async () => ({ 'comp-a': { ok: true, detail: 'ok' } }),
        },
      }),
    );
    const c1 = await ex.executeCheck('组件健康检查通过', { objectId: 'comp-a', kind: 'capability' });
    const c2 = await ex.executeCheck('组件健康检查通过', { objectId: 'comp-a', kind: 'capability' });
    expect(c1).toEqual(c2);
    const g1 = await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g', kind: 'custom', payload: { a: 1 } });
    const g2 = await ex.executeCheck('对象结构 schema 校验通过', { objectId: 'g', kind: 'custom', payload: { a: 1 } });
    expect(g1).toEqual(g2);
  });
});
