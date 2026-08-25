// W4（未接线审计修复第 4 项）：ProcessSchema 形态修复测试（runtime/repair-executors.ts）。
// 覆盖：
//   ① 真实形态单元（fake services 注入）：
//     - process：processesDir 放真实 ProcessDef（YAML，以 kernel/policy-loader.ts 的解析契约为准——
//       拷贝仓库 kernel/processes）→ loadProcesses 命中对象 → pass（单一事实源：loadProcesses 成功 =
//       真实结构校验，不再叠加形状不匹配的 P1 ProcessSchema）；损坏定义（解析失败抛错 = 结构非法）→ fail；
//       未定位 → unknown；ProcessDef 形态（非 P1 Process irBase 形态）fake 定义 → pass
//     - skill：memory 记录（含 lifecycle 等包装字段）内层 payload 为 SkillSchema 合法形状 → pass；
//       非法（缺必填字段）→ fail；无 payload → unknown；内层不可解析（非 JSON 字符串）→ unknown
//     - projection：memory 记录内层 payload 为合法 ContextProjection（复用 tests/m1/ir-samples.ts 的
//       A3_VALID 形状）→ pass；非法 → fail；无 payload → unknown；必填字段齐全同样校验内层 payload
//   ② 基线注册解锁集成（runRepair fixture 布局，参照 tests/m9/repair-executors.test.ts ③）：
//     - skill 对象：hard 检查（技能定义结构合法）内层 payload 校验 pass → 首次基线自动注册
//       （BaselineStore 可查 kind='skill-task'，版本化字段齐备）→ 第二次 runRepair 走版本化对比分支
//       （代表任务全匹配 pass）→ PASS；不重复注册
//     - projection 对象：hard 检查（投影 schema 校验通过）+ 必填字段齐全 pass → 首次基线自动注册
//       （kind='projection-rebuild'）→ 第二次有基线分支（可恢复仍 unknown——占位注册无重建输入，诚实）
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';
import type { CapabilityDecayRecord } from '../../kernel/schemas/evolution.js';
import { loadProcesses } from '../../kernel/policy-loader.js';
import {
  createRepairExecutors,
  type RepairExecutorServices,
} from '../../runtime/repair-executors.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import { A3_VALID, P5_VALID, PROV, TS, base, omit } from '../m1/ir-samples.js';

// ---- 测试工具（与 tests/m9/repair-executors.test.ts 同款） ----

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

/** M1 Memory 工厂（最小 fixture：id 唯一 + 合法 schema；payload 内层承载技能/投影定义 JSON） */
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

// ---- ① 真实形态单元（fake services 注入） ----

describe('① W4 真实形态单元（process 真实加载面 + skill/projection 内层 payload 解包）', () => {
  it('process：真实 ProcessDef YAML 目录 → loadProcesses 命中 → pass；损坏定义（解析失败）→ fail；未定位 → unknown', async () => {
    // 真实目录：拷贝仓库 kernel/processes（真实 ProcessDef YAML）→ 真实 loadProcesses 解析成功 = 结构合法
    const dir = await tmpRoot('omb-w4-proc-');
    await cp(REPO_PROCESSES_DIR, dir, { recursive: true });
    const ex = createRepairExecutors(fakeServices({ processesDir: dir, loadProcesses }));
    const ok = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'retrieve-verify', kind: 'process' });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('真实加载面');
    // 未定位 → unknown（既有语义）
    const miss = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'nope', kind: 'process' });
    expect(miss.result).toBe('unknown');
    expect(miss.detail).toContain('未定位到过程');
    // 损坏定义：破坏其中一个 YAML → loadProcesses 解析失败抛错 = 结构非法 → fail
    await writeFile(join(dir, 'retrieve-verify.yaml'), 'id: retrieve-verify\nentry: [unclosed\n', 'utf8');
    const bad = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'retrieve-verify', kind: 'process' });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('过程加载抛错');
  });

  it('process：ProcessDef 形态（非 P1 Process irBase 形态）fake 定义直接 pass——不再叠加 P1 ProcessSchema 误判', async () => {
    const procDef = {
      id: 'proc-1',
      version: '1.0.0',
      entry: 'RETRIEVE',
      exit: 'STOP',
      budget: { tokens: 100 },
      operators: [
        {
          id: 'r',
          op: 'RETRIEVE',
          input_binding: { q: '$' },
          output: 'pack',
          cost: { tokens: 10 },
          verification: 'v',
          error: { retryable: true, timeout_ms: 1, cancelable: true, rollback: 'rb' },
        },
        {
          id: 's',
          op: 'STOP',
          input_binding: { state: '$' },
          output: 'report',
          cost: { tokens: 10 },
          verification: 'v',
          error: { retryable: false, timeout_ms: 1, cancelable: false, rollback: 'rb' },
        },
      ],
    };
    const ex = createRepairExecutors(fakeServices({ processesDir: '/fixture', loadProcesses: async () => [procDef] }));
    const ok = await ex.executeCheck('过程定义结构合法（schema 校验）', { objectId: 'proc-1', kind: 'process' });
    expect(ok.result).toBe('pass');
  });

  it('skill：memory 记录（lifecycle 包装）内层 payload 合法 Skill → pass；非法 → fail；无 payload → unknown；内层不可解析 → unknown', async () => {
    const ex = createRepairExecutors(fakeServices());
    // 整条 memory 记录（含 lifecycle/scope 等包装字段）+ 内层 payload = JSON 序列化的 Skill 定义 → 解包校验 pass
    const ok = await ex.executeCheck('技能定义结构合法', {
      objectId: 'sk-1',
      kind: 'skill',
      payload: makeMemory(JSON.stringify(P5_VALID)),
    });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('内层定义 payload');
    // 内层 payload 为对象（非字符串）同样取实际定义内容 → pass
    const okObj = await ex.executeCheck('技能定义结构合法', {
      objectId: 'sk-1b',
      kind: 'skill',
      payload: { ...makeMemory('x'), payload: P5_VALID } as unknown,
    });
    expect(okObj.result).toBe('pass');
    // 非法：内层 payload 缺必填字段（name）→ SkillSchema 校验失败 → fail
    const bad = await ex.executeCheck('技能定义结构合法', {
      objectId: 'sk-2',
      kind: 'skill',
      payload: makeMemory(JSON.stringify(omit(P5_VALID, 'name'))),
    });
    expect(bad.result).toBe('fail');
    expect(bad.detail).toContain('校验失败');
    // 无 payload → unknown
    const none = await ex.executeCheck('技能定义结构合法', { objectId: 'sk-3', kind: 'skill' });
    expect(none.result).toBe('unknown');
    // 内层不可解析（非 JSON 字符串）→ unknown（诚实无定义可校验）
    const noParse = await ex.executeCheck('技能定义结构合法', {
      objectId: 'sk-4',
      kind: 'skill',
      payload: makeMemory('not json'),
    });
    expect(noParse.result).toBe('unknown');
  });

  it('projection：memory 记录内层 payload 合法 ContextProjection（A3_VALID）→ pass；非法 → fail；无 payload → unknown；必填字段同样校验内层', async () => {
    const ex = createRepairExecutors(fakeServices());
    const ok = await ex.executeCheck('投影 schema 校验通过', {
      objectId: 'prj-1',
      kind: 'projection',
      payload: makeMemory(JSON.stringify(A3_VALID)),
    });
    expect(ok.result).toBe('pass');
    expect(ok.detail).toContain('内层定义 payload');
    const bad = await ex.executeCheck('投影 schema 校验通过', {
      objectId: 'prj-2',
      kind: 'projection',
      payload: makeMemory(JSON.stringify(omit(A3_VALID, 'sections'))),
    });
    expect(bad.result).toBe('fail');
    const none = await ex.executeCheck('投影 schema 校验通过', { objectId: 'prj-3', kind: 'projection' });
    expect(none.result).toBe('unknown');
    // 必填字段齐全：同样校验内层 payload（A3 形状 → pass；非投影形态 → unknown）
    const req = await ex.executeCheck('必填字段齐全（required fields）', {
      objectId: 'prj-4',
      kind: 'projection',
      payload: makeMemory(JSON.stringify(A3_VALID)),
    });
    expect(req.result).toBe('pass');
    const notProj = await ex.executeCheck('必填字段齐全（required fields）', {
      objectId: 'prj-5',
      kind: 'projection',
      payload: makeMemory(JSON.stringify({ a: 1 })),
    });
    expect(notProj.result).toBe('unknown');
    expect(notProj.detail).toContain('非投影形态');
  });
});

// ---- ② 基线注册解锁集成（runRepair fixture 布局） ----

describe('② W4 基线注册解锁集成（runRepair：skill/projection 对象 hard 全 pass → 首次基线自动注册）', () => {
  it('skill 对象：内层 Skill 定义校验 pass → 首次基线自动注册（kind=skill-task）→ 第二次 runRepair 版本化对比分支 → PASS', async () => {
    const root = await tmpRoot('omb-w4-skill-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory(JSON.stringify(P5_VALID)));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'w4-skill.json', { affected_objects: [{ id: memId, kind: 'skill' }] });

    // 首次：hard（技能定义结构合法——内层 payload 校验）pass + outcome（代表任务）无基线 unknown →
    // UNKNOWN；判定后自动注册 skill-task 基线（版本化字段齐备）
    const rec = await runtime.runRepair();
    expect(rec.objects).toHaveLength(1);
    const o = rec.objects[0]!;
    expect(o.kind).toBe('skill');
    expect(o.verdict).toBe('UNKNOWN');
    expect(o.evidence_quality).toBe(0.5); // 技能定义结构合法 pass（1/2 有结果）+ 代表任务 unknown
    expect(o.detail).toContain('技能定义结构合法=pass');
    expect(o.detail).toContain('代表任务可执行（representative task + output contract）=unknown');
    expect(o.detail).toContain('基线已注册，下次可版本化对比');
    const base = await runtime.baselineStore.getBaseline(memId, 'skill-task');
    expect(base).not.toBeNull();
    expect(base!.id).toBe(memId);
    expect(base!.kind).toBe('skill-task');
    expect(base!.verifier_version).toBe('1');
    expect(base!.environment_fingerprint).toHaveProperty('os');
    expect(base!.runtime_snapshot).toMatch(/^rs:/);

    // 第二次：基线已存在 → 不重复注册；代表任务走版本化对比分支（环境指纹/快照/版本全匹配）→ pass → PASS
    const rec2 = await runtime.runRepair();
    const o2 = rec2.objects[0]!;
    expect(o2.detail).toContain('代表任务可执行（representative task + output contract）=pass');
    expect(o2.verdict).toBe('PASS');
    expect(o2.evidence_quality).toBe(1);
    expect(o2.disposition).toBe('clear_suspicious');
    expect(o2.detail).not.toContain('基线已注册');
    expect(await runtime.baselineStore.list('skill-task')).toHaveLength(1);
  });

  it('projection 对象：内层投影定义校验 pass → 首次基线自动注册（kind=projection-rebuild）→ 第二次有基线分支不重复注册', async () => {
    const root = await tmpRoot('omb-w4-prj-');
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memId = await runtime.memory.ingest(makeMemory(JSON.stringify(A3_VALID)));
    await runtime.memory.update(memId, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'w4-prj.json', { affected_objects: [{ id: memId, kind: 'projection' }] });

    // 首次：hard（投影 schema 校验通过）+ 必填字段齐全 pass + 可恢复无基线 unknown → UNKNOWN（2/3 有结果）；
    // 判定后自动注册 projection-rebuild 基线
    const rec = await runtime.runRepair();
    expect(rec.objects).toHaveLength(1);
    const o = rec.objects[0]!;
    expect(o.kind).toBe('projection');
    expect(o.verdict).toBe('UNKNOWN');
    expect(o.evidence_quality).toBe(0.67);
    expect(o.detail).toContain('投影 schema 校验通过=pass');
    expect(o.detail).toContain('必填字段齐全（required fields）=pass');
    expect(o.detail).toContain('可恢复（restore）=unknown');
    expect(o.detail).toContain('基线已注册，下次可版本化对比');
    const base = await runtime.baselineStore.getBaseline(memId, 'projection-rebuild');
    expect(base).not.toBeNull();
    expect(base!.id).toBe(memId);
    expect(base!.kind).toBe('projection-rebuild');
    expect(base!.verifier_version).toBe('1');

    // 第二次：基线已存在 → 不重复注册（占位注册 input=payload 无重建输入 → 可恢复仍 unknown，诚实）
    const rec2 = await runtime.runRepair();
    const o2 = rec2.objects[0]!;
    expect(o2.detail).toContain('投影 schema 校验通过=pass');
    expect(o2.detail).toContain('可恢复（restore）=unknown');
    expect(o2.detail).not.toContain('基线已注册');
    expect(await runtime.baselineStore.list('projection-rebuild')).toHaveLength(1);
  });
});
