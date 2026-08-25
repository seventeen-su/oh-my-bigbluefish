// P3（2026-08-25-verification-contract）：Repair 升级测试——损坏类型分类/对象验证契约种子/最小验证计划/
// 处置语义/decideVerdict 集成/runRepair 集成（计划 §P3 交付物；用户裁决 P3 范围）。
// 覆盖：
//   ① classifyRepairDamage 优先级矩阵（untrusted 最优先 → uncontrollable → env change → FAIL 细分
//     （structural vs behavior）→ UNKNOWN → PASS→null）
//   ② seedRepairContract 七类 + generic 兜底：id/goal/hard/outcome/verifiers 两枚/trust_required/schema 合法
//   ③ repairPlanForObject steps 形状（contract_id + deterministic/judge 两步骤 evidence_required）
//   ④ applyRepairDisposition 六类 + PASS：disposition/score_eligible 全映射 + reason 可审计（含 kind/objectId）
//   ⑤ decideVerdict 集成：memory getById 命中 → UNKNOWN（outcome 无证据）；未命中 → FAIL；
//     全证据注入（含 judge pass 补缺）→ PASS
//   ⑥ runRepair 集成（createCognitiveRuntime + fixture 布局，参照 tests/m8/predictive-invalidation.test.ts）：
//     decay 记录 → 受影响对象 → RepairRecord.objects 条目（verdict/disposition/score_eligible）、missing、
//     memory 对象 PASS 路径清 suspicious（judgeChecks 注入 → lifecycle 恢复 Active）、
//     UNKNOWN 保持 Suspicious、环境变化 → local_regression、'experience'→'memory' kind 映射
//   ⑦ 确定性：同输入同输出（种子/计划/分类/处置/decideVerdict 全链 deep equal + JSON 字节一致）
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint } from '../../kernel/schemas/base.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Memory } from '../../kernel/schemas/m.js';
import type { CapabilityDecayRecord } from '../../kernel/schemas/evolution.js';
import { createCognitiveRuntime } from '../../runtime/assembly.js';
import {
  VerificationContractSchema,
  VerificationPlanSchema,
  type VerificationContract,
  type VerificationEvidence,
  type VerificationResult,
  type Verdict,
} from '../../kernel/schemas/verification.js';
import { decideVerdict } from '../../kernel/verification.js';
import {
  REPAIR_CHECK_GENERIC_READABLE,
  REPAIR_CHECK_RETRIEVABLE,
  REPAIR_DAMAGE_KINDS,
  REPAIR_OBJECT_KINDS,
  applyRepairDisposition,
  classifyRepairDamage,
  repairPlanForObject,
  seedRepairContract,
  type RepairDamageKind,
  type RepairDisposition,
} from '../../kernel/repair-contract.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

// ---- 测试工具（确定性 fixture） ----

const OBJ = 'obj-repair-p3';
const STRUCTURAL = [REPAIR_CHECK_RETRIEVABLE]; // memory 契约 hard_constraints（结构面检查名）

/** 最小 VerificationResult 构造（classifyRepairDamage 输入） */
function mkResult(v: { verdict: Verdict; hard_failures?: string[] }): VerificationResult {
  return {
    contract_id: `repair:${OBJ}`,
    verdict: v.verdict,
    hard_failures: v.hard_failures ?? [],
    unknown_checks: [],
    evidence_quality: 0.5,
    reason: '测试构造',
    evidence: [],
  };
}

/** 缺省上下文（全真 = 无损坏面；各用例覆写被测维度） */
function mkCtx(over: Partial<{ environment_changed: boolean; verifier_trusted: boolean; uncontrollable: boolean; structural_checks: string[] }> = {}): {
  environment_changed: boolean;
  verifier_trusted: boolean;
  uncontrollable: boolean;
  structural_checks: string[];
} {
  return {
    environment_changed: false,
    verifier_trusted: true,
    uncontrollable: false,
    structural_checks: STRUCTURAL,
    ...over,
  };
}

/** 确定性验证器证据（memory 契约；source='runRepair:deterministic'） */
function detEvidence(contract: VerificationContract, checks: Array<{ name: string; result: 'pass' | 'fail' | 'unknown'; detail?: string }>): VerificationEvidence {
  return { verifier_id: 'repair:memory:deterministic', contract_id: contract.id, checks, ts: 1, source: 'runRepair:deterministic' };
}

/** 语义补充验证器证据（memory 契约 judge；source='runRepair:judge'） */
function judgeEvidence(contract: VerificationContract, checks: Array<{ name: string; result: 'pass' | 'fail' | 'unknown'; detail?: string }>): VerificationEvidence {
  return { verifier_id: 'repair:memory:judge', contract_id: contract.id, checks, ts: 1, source: 'runRepair:judge' };
}

// ---- ① 损坏类型分类优先级矩阵 ----

describe('① classifyRepairDamage：优先级矩阵（不可协商顺序）', () => {
  it('verifier_untrusted 最优先（即使 uncontrollable/env_changed/FAIL 同时为真）', () => {
    expect(
      classifyRepairDamage(mkResult({ verdict: 'FAIL', hard_failures: [REPAIR_CHECK_RETRIEVABLE] }), {
        ...mkCtx(),
        environment_changed: true,
        uncontrollable: true,
        verifier_trusted: false,
      }),
    ).toBe('verifier_untrusted');
  });

  it('external_uncontrollable 次之（uncontrollable=true 优先于 env_changed 与 FAIL）', () => {
    expect(
      classifyRepairDamage(mkResult({ verdict: 'FAIL', hard_failures: [REPAIR_CHECK_RETRIEVABLE] }), {
        ...mkCtx(),
        environment_changed: true,
        uncontrollable: true,
      }),
    ).toBe('external_uncontrollable');
  });

  it('environment_change 第三（优先于 verdict 细分——即使 PASS 也判环境变化）', () => {
    expect(classifyRepairDamage(mkResult({ verdict: 'PASS' }), { ...mkCtx(), environment_changed: true })).toBe(
      'environment_change',
    );
    expect(
      classifyRepairDamage(mkResult({ verdict: 'UNKNOWN' }), { ...mkCtx(), environment_changed: true }),
    ).toBe('environment_change');
  });

  it('FAIL 且 hard_failures 命中结构面检查 → structural_damage', () => {
    expect(
      classifyRepairDamage(mkResult({ verdict: 'FAIL', hard_failures: [REPAIR_CHECK_RETRIEVABLE] }), mkCtx()),
    ).toBe('structural_damage');
  });

  it('FAIL 但 hard_failures 不含结构面（outcome 被权威判 fail）→ behavior_regression', () => {
    expect(
      classifyRepairDamage(mkResult({ verdict: 'FAIL', hard_failures: ['检索一致性（同查询同结果）'] }), mkCtx()),
    ).toBe('behavior_regression');
  });

  it('UNKNOWN → insufficient_evidence（证据不足 → 保持怀疑）', () => {
    expect(classifyRepairDamage(mkResult({ verdict: 'UNKNOWN' }), mkCtx())).toBe('insufficient_evidence');
  });

  it('PASS → null（无损坏）', () => {
    expect(classifyRepairDamage(mkResult({ verdict: 'PASS' }), mkCtx())).toBeNull();
  });

  it('损坏类型枚举值域固定（六类，顺序即优先级文档序）', () => {
    expect(REPAIR_DAMAGE_KINDS).toEqual([
      'environment_change',
      'behavior_regression',
      'structural_damage',
      'insufficient_evidence',
      'verifier_untrusted',
      'external_uncontrollable',
    ]);
  });
});

// ---- ② 对象验证契约种子（七类 + generic 兜底） ----

/** 七类对象契约规格（与 kernel/repair-contract.ts 同表；测试锚定防漂移） */
const SPEC: Record<(typeof REPAIR_OBJECT_KINDS)[number], { hard: string[]; outcome: string[] }> = {
  memory: {
    hard: [REPAIR_CHECK_RETRIEVABLE],
    outcome: ['检索一致性（同查询同结果）', '无矛盾（contradiction 检查通过）'],
  },
  process: {
    hard: ['过程定义结构合法（schema 校验）'],
    outcome: ['重放一致（replay + state_delta 匹配）'],
  },
  skill: {
    hard: ['技能定义结构合法'],
    outcome: ['代表任务可执行（representative task + output contract）'],
  },
  policy: {
    hard: ['策略 schema 合法'],
    outcome: ['冻结回归集通过（frozen regression set）'],
  },
  capability: {
    hard: ['组件健康检查通过'],
    outcome: ['能力契约满足（capability contract）'],
  },
  projection: {
    hard: ['投影 schema 校验通过'],
    outcome: ['必填字段齐全（required fields）', '可恢复（restore）'],
  },
  version: {
    hard: ['快照物化完整可读'],
    outcome: ['冒烟套件通过（smoke suite）'],
  },
};

describe('② seedRepairContract：七类对象契约 + generic 兜底', () => {
  it('对象枚举值域固定（七类）', () => {
    expect(REPAIR_OBJECT_KINDS).toEqual([
      'memory',
      'process',
      'skill',
      'policy',
      'capability',
      'projection',
      'version',
    ]);
  });

  it.each(REPAIR_OBJECT_KINDS)('kind=%s：id/goal/hard/outcome/trust_required/语义', (kind) => {
    const c = seedRepairContract(kind, OBJ);
    expect(c.id).toBe(`repair:${OBJ}`);
    expect(c.goal).toBe(`对象重验证（${kind}：${OBJ}）`);
    expect(c.hard_constraints).toEqual(SPEC[kind].hard); // 结构面硬约束（不可被 LLM judge 覆盖）
    expect(c.outcome_conditions).toEqual(SPEC[kind].outcome); // 语义面结果条件
    expect(c.process_conditions).toEqual([]); // 诚实空
    expect(c.trust_required).toBe('L1');
    expect(c.verdict_semantics).toBe('all_must_pass');
  });

  it.each(REPAIR_OBJECT_KINDS)('kind=%s：verifiers 恒两枚（deterministic L1 权威 + structured_llm L2 补充）', (kind) => {
    const c = seedRepairContract(kind, OBJ);
    expect(c.verifiers).toHaveLength(2);
    const det = c.verifiers[0]!;
    expect(det.id).toBe(`repair:${kind}:deterministic`);
    expect(det.kind).toBe('deterministic');
    expect(det.trust).toBe('L1');
    expect(det.origin).toBeUndefined(); // 外部/独立来源（非循环检查面）
    expect(det.checks).toEqual([...SPEC[kind].hard, ...SPEC[kind].outcome]); // 覆盖声明 = 全部应查
    expect(det.blind_spots).toEqual(['语义面（如行为/语义达成）需语义验证器']);
    const judge = c.verifiers[1]!;
    expect(judge.id).toBe(`repair:${kind}:judge`);
    expect(judge.kind).toBe('structured_llm');
    expect(judge.trust).toBe('L2');
    expect(judge.origin).toBeUndefined();
    expect(judge.checks).toEqual(SPEC[kind].outcome); // 恒声明——展示完整验证阶梯（执行由调用方注入）
    expect(judge.blind_spots).toEqual(['确定性面由确定性验证器覆盖']);
  });

  it('generic 兜底：未列 kind → 对象存在且可读 + 结构 schema 校验', () => {
    const c = seedRepairContract('custom_kind', OBJ);
    expect(c.id).toBe(`repair:${OBJ}`);
    expect(c.goal).toBe(`对象重验证（custom_kind：${OBJ}）`);
    expect(c.hard_constraints).toEqual([REPAIR_CHECK_GENERIC_READABLE]);
    expect(c.outcome_conditions).toEqual(['对象结构 schema 校验通过']);
    expect(c.verifiers[0]!.id).toBe('repair:custom_kind:deterministic');
    expect(c.verifiers[1]!.id).toBe('repair:custom_kind:judge');
  });

  it('全部七类 + generic 契约过 schema（zod fail-loud 面）', () => {
    for (const kind of [...REPAIR_OBJECT_KINDS, 'custom_kind']) {
      expect(VerificationContractSchema.safeParse(seedRepairContract(kind, OBJ)).success).toBe(true);
    }
  });
});

// ---- ③ 最小验证计划形状 ----

describe('③ repairPlanForObject：最小验证计划', () => {
  it('steps 形状：deterministic 权威（hard+outcome 全应查）+ judge 语义补充（outcome）', () => {
    const plan = repairPlanForObject('memory', OBJ);
    expect(plan.contract_id).toBe(`repair:${OBJ}`);
    expect(plan.steps).toEqual([
      {
        verifier_id: 'repair:memory:deterministic',
        evidence_required: [
          REPAIR_CHECK_RETRIEVABLE,
          '检索一致性（同查询同结果）',
          '无矛盾（contradiction 检查通过）',
        ],
      },
      {
        verifier_id: 'repair:memory:judge',
        evidence_required: ['检索一致性（同查询同结果）', '无矛盾（contradiction 检查通过）'],
      },
    ]);
    expect(VerificationPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('generic kind 计划同样两步骤', () => {
    const plan = repairPlanForObject('custom_kind', OBJ);
    expect(plan.contract_id).toBe(`repair:${OBJ}`);
    expect(plan.steps[0]!.verifier_id).toBe('repair:custom_kind:deterministic');
    expect(plan.steps[1]!.verifier_id).toBe('repair:custom_kind:judge');
    expect(VerificationPlanSchema.safeParse(plan).success).toBe(true);
  });
});

// ---- ④ 处置语义全映射 ----

describe('④ applyRepairDisposition：六类损坏 + PASS 处置映射', () => {
  it.each<[RepairDamageKind | null, RepairDisposition, boolean]>([
    ['verifier_untrusted', 'no_repair', false],
    ['external_uncontrollable', 'no_repair', false],
    ['environment_change', 'local_regression', true],
    ['behavior_regression', 'degrade_or_rollback', true],
    ['structural_damage', 'quarantine', true],
    ['insufficient_evidence', 'keep_suspicious', true],
    [null, 'clear_suspicious', true],
  ])('damage=%s → disposition=%s, score_eligible=%s', (damage, disposition, scoreEligible) => {
    const r = applyRepairDisposition('memory', OBJ, damage);
    expect(r.disposition).toBe(disposition);
    expect(r.score_eligible).toBe(scoreEligible);
    expect(r.reason).toContain('memory'); // 中文可审计（含 kind）
    expect(r.reason).toContain(OBJ); // 中文可审计（含 objectId）
  });

  it('处置语义理由可审计：禁止据此修复 / 不污染评分 / 保持存疑 / 清除存疑', () => {
    expect(applyRepairDisposition('memory', OBJ, 'verifier_untrusted').reason).toContain('禁止据此修复');
    expect(applyRepairDisposition('memory', OBJ, 'external_uncontrollable').reason).toContain('不污染能力评分');
    expect(applyRepairDisposition('memory', OBJ, 'insufficient_evidence').reason).toContain('保持存疑');
    expect(applyRepairDisposition('memory', OBJ, null).reason).toContain('清除存疑');
    expect(applyRepairDisposition('memory', OBJ, null).reason).toContain('PASS');
  });
});

// ---- ⑤ decideVerdict 集成（memory 契约：最小证据 → 诚实三态） ----

describe('⑤ decideVerdict 集成：memory 契约最小验证证据', () => {
  it('getById 命中（hard pass 证据）→ UNKNOWN（outcome 无证据——诚实不强行裁决）', () => {
    const contract = seedRepairContract('memory', OBJ);
    const r = decideVerdict(contract, [detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'pass' }])]);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.hard_failures).toEqual([]);
    expect(r.unknown_checks).toEqual(['检索一致性（同查询同结果）', '无矛盾（contradiction 检查通过）']);
    expect(r.evidence_quality).toBe(0.33); // 1/3 应查检查有结果
  });

  it('getById 未命中（hard fail 证据）→ FAIL（硬约束被权威判 fail）', () => {
    const contract = seedRepairContract('memory', OBJ);
    const r = decideVerdict(contract, [detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'fail' }])]);
    expect(r.verdict).toBe('FAIL');
    expect(r.hard_failures).toEqual([REPAIR_CHECK_RETRIEVABLE]);
    expect(r.evidence_quality).toBe(0.33);
  });

  it('全证据注入（deterministic pass + judge pass 补缺）→ PASS', () => {
    const contract = seedRepairContract('memory', OBJ);
    const r = decideVerdict(contract, [
      detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'pass' }]),
      judgeEvidence(contract, [
        { name: '检索一致性（同查询同结果）', result: 'pass', detail: '同查询同结果' },
        { name: '无矛盾（contradiction 检查通过）', result: 'pass', detail: '无矛盾' },
      ]),
    ]);
    expect(r.verdict).toBe('PASS');
    expect(r.unknown_checks).toEqual([]);
    expect(r.evidence_quality).toBe(1); // 3/3 应查检查有结果
  });
});

// ---- ⑥ runRepair 集成（契约化重验证 + 处置执行） ----

const roots: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-repair-p3-'));
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

const FP_V22: Fingerprint = { os: 'win32', node: 'v22.0.0', dsh_version: '0.1.0', project: 'omb-v2' };

/** decay 记录落盘（.evolution/decay/<file>.json；over 覆写缺省字段——environment_delta/affected_objects 按场景注入） */
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

describe('⑥ runRepair 集成：契约化重验证 + 处置执行', () => {
  it('UNKNOWN 保持 Suspicious + 环境变化 → local_regression + 缺失对象 → missing + kind 映射', async () => {
    const root = await tmpRoot();
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    // memA：无环境变化 → UNKNOWN → keep_suspicious（保持存疑）
    const memA = await runtime.memory.ingest(makeMemory('受影响对象 A'));
    await runtime.memory.update(memA, { lifecycle: 'Suspicious' });
    // memC：所属 decay 记录带 environment_delta → environment_change → local_regression
    const memC = await runtime.memory.ingest(makeMemory('受影响对象 C'));
    await runtime.memory.update(memC, { lifecycle: 'Suspicious' });
    // memE：decay 记录 kind='experience' → 映射 memory 契约（generic 兜底之外的一等映射）
    const memE = await runtime.memory.ingest(makeMemory('受影响对象 E'));
    await runtime.memory.update(memE, { lifecycle: 'Suspicious' });
    // memGone：对象已删除 → missing（不进入契约执行）
    const memGone = makeMutableId('memory');
    await writeDecay(root, 'a.json', { affected_objects: [{ id: memA, kind: 'memory' }] });
    await writeDecay(root, 'c.json', {
      environment_delta: { node: { from: 'v22.0.0', to: 'v24.0.0' } },
      affected_objects: [{ id: memC, kind: 'memory' }],
    });
    await writeDecay(root, 'e.json', { affected_objects: [{ id: memE, kind: 'experience' }] });
    await writeDecay(root, 'm.json', { affected_objects: [{ id: memGone, kind: 'memory' }] });

    const rec = await runtime.runRepair();
    expect(rec.task).toBe('repair');
    expect(rec.decay_records).toBe(4);
    // objects：A（UNKNOWN/keep_suspicious）、C（UNKNOWN 判定 + local_regression 处置）、E（kind 映射 memory）
    expect(rec.objects).toEqual([
      {
        id: memA,
        kind: 'memory',
        contract_id: `repair:${memA}`,
        verdict: 'UNKNOWN',
        evidence_quality: 0.33,
        disposition: 'keep_suspicious',
        score_eligible: true,
        reason: expect.stringContaining('证据不足'),
      },
      {
        id: memC,
        kind: 'memory',
        contract_id: `repair:${memC}`,
        verdict: 'UNKNOWN',
        evidence_quality: 0.33,
        disposition: 'local_regression',
        score_eligible: true,
        reason: expect.stringContaining('环境变化'),
      },
      {
        id: memE,
        kind: 'memory', // 'experience' → 'memory'（契约化 kind 映射）
        contract_id: `repair:${memE}`,
        verdict: 'UNKNOWN',
        evidence_quality: 0.33,
        disposition: 'keep_suspicious',
        score_eligible: true,
        reason: expect.stringContaining('证据不足'),
      },
    ]);
    expect(rec.missing).toEqual([{ id: memGone, kind: 'memory' }]); // missing 语义不变（跳过留痕）
    expect(rec.reverified).toEqual([]); // 无 PASS 对象
    expect(rec.affected_objects).toHaveLength(4);
    // 处置执行：keep_suspicious/local_regression 仅记录 → 保持 Suspicious（lifecycle 不动）
    expect((await runtime.memory.getById(memA))!.lifecycle).toBe('Suspicious');
    expect((await runtime.memory.getById(memC))!.lifecycle).toBe('Suspicious');
    expect((await runtime.memory.getById(memE))!.lifecycle).toBe('Suspicious');
  });

  it('PASS 路径（judgeChecks 补缺）→ clear_suspicious → lifecycle 恢复 Active', async () => {
    const root = await tmpRoot();
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    const memB = await runtime.memory.ingest(makeMemory('受影响对象 B'));
    await runtime.memory.update(memB, { lifecycle: 'Suspicious' });
    await writeDecay(root, 'b.json', { affected_objects: [{ id: memB, kind: 'memory' }] });

    // judgeChecks 注入面（P3 语义补充验证器证据——真实 LLM judge 调用留待注记）
    const rec = await runtime.runRepair([
      { name: '检索一致性（同查询同结果）', result: 'pass', detail: '同查询同结果' },
      { name: '无矛盾（contradiction 检查通过）', result: 'pass', detail: '无矛盾' },
    ]);
    expect(rec.objects).toEqual([
      {
        id: memB,
        kind: 'memory',
        contract_id: `repair:${memB}`,
        verdict: 'PASS',
        evidence_quality: 1,
        disposition: 'clear_suspicious',
        score_eligible: true,
        reason: expect.stringContaining('PASS'),
      },
    ]);
    expect(rec.reverified).toEqual([{ id: memB, kind: 'memory' }]); // PASS = 契约化重验证通过
    expect(rec.missing).toEqual([]);
    // 处置执行：clear_suspicious → lifecycle 恢复 Active（清除存疑）
    expect((await runtime.memory.getById(memB))!.lifecycle).toBe('Active');
  });

  it('空任务（无受影响对象）→ 合法完成 + objects 空 + 清债语义不依赖（直接调用幂等）', async () => {
    const root = await tmpRoot();
    const runtime = trackRuntime(createCognitiveRuntime({ root }));
    await writeDecay(root, 'empty.json', { affected_objects: [] });
    const rec = await runtime.runRepair();
    expect(rec.decay_records).toBe(1);
    expect(rec.affected_objects).toEqual([]);
    expect(rec.objects).toEqual([]);
    expect(rec.missing).toEqual([]);
    expect(rec.reverified).toEqual([]);
    // 幂等：重复执行同结果
    const again = await runtime.runRepair();
    expect(again.objects).toEqual([]);
    expect(again.decay_records).toBe(1);
  });
});

// ---- ⑦ 确定性（同输入同输出） ----

describe('⑦ 确定性：种子/计划/分类/处置/判定同输入同输出', () => {
  it('seedRepairContract / repairPlanForObject / classifyRepairDamage / applyRepairDisposition 全链确定', () => {
    expect(seedRepairContract('memory', OBJ)).toEqual(seedRepairContract('memory', OBJ));
    expect(JSON.stringify(seedRepairContract('process', OBJ))).toBe(JSON.stringify(seedRepairContract('process', OBJ)));
    expect(repairPlanForObject('memory', OBJ)).toEqual(repairPlanForObject('memory', OBJ));
    const res = mkResult({ verdict: 'UNKNOWN' });
    expect(classifyRepairDamage(res, mkCtx())).toBe(classifyRepairDamage(res, mkCtx()));
    expect(applyRepairDisposition('memory', OBJ, 'behavior_regression')).toEqual(
      applyRepairDisposition('memory', OBJ, 'behavior_regression'),
    );
  });

  it('decideVerdict 同证据两次 → deep equal + JSON 字节一致（UNKNOWN 与 PASS 路径均锚定）', () => {
    const contract = seedRepairContract('memory', OBJ);
    const evidence = [
      detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'pass' }]),
      judgeEvidence(contract, [
        { name: '检索一致性（同查询同结果）', result: 'pass' },
        { name: '无矛盾（contradiction 检查通过）', result: 'pass' },
      ]),
    ];
    const r1 = decideVerdict(contract, evidence);
    const r2 = decideVerdict(contract, evidence);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.verdict).toBe('PASS');
    const unknown = decideVerdict(contract, [detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'pass' }])]);
    expect(decideVerdict(contract, [detEvidence(contract, [{ name: REPAIR_CHECK_RETRIEVABLE, result: 'pass' }])])).toEqual(unknown);
  });
});
