// P3.5（2026-08-25-verification-contract）：Repair 真实验证执行器测试（runtime/repair-executors.ts）。
// 覆盖：
//   ① 真实执行器逐项（fake services 注入）：检索一致性（稳定两次 → pass / 构造变化 → fail / 抛错 → unknown /
//     无能力 → unknown）；过程定义结构合法（合法定义 pass / 非法 fail / 未定位 unknown / 加载抛错 fail）；
//     技能定义结构合法（合法 pass / 非法 fail / 无 payload unknown）；策略 schema 合法（合法 fixture pass /
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
import { createRepairExecutors, type RepairExecutorServices } from '../../runtime/repair-executors.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { A3_VALID, P1_VALID, P3_VALID, P5_VALID, PROV, TS, base, omit } from '../m1/ir-samples.js';

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

  it('过程定义结构合法：合法定义（P1 Process）→ pass；非法 → fail；未定位（真实目录）→ unknown；加载抛错 → fail；无 dir → unknown', async () => {
    // 合法定义：loadProcesses 返回 P1 Process（ProcessSchema 结构合法——irBase + operator_graph）
    const p1 = { ...P1_VALID, id: 'proc-ok' };
    const ex = createRepairExecutors(
      fakeServices({ processesDir: '/fixture', loadProcesses: async () => [p1] }),
    );
    const ok = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'proc-ok', kind: 'process' });
    expect(ok.result).toBe('pass');
    // 非法：返回非 P1 Process 形态（缺 operator_graph/irBase 字段）→ ProcessSchema 校验失败
    const exBad = createRepairExecutors(
      fakeServices({ processesDir: '/fixture', loadProcesses: async () => [{ id: 'proc-bad' }] }),
    );
    const bad = await exBad.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'proc-bad', kind: 'process' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('校验失败');
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
