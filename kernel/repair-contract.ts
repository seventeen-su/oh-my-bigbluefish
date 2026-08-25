// layer 2（kernel/）：P3 Repair 升级——损坏类型分类 + 对象验证契约种子 + 最小验证计划 + 处置语义
// （计划 .omb/plans/2026-08-25-verification-contract.md；用户裁决 P3 范围）。
// 零 I/O、零副作用、零随机、零墙钟：同输入 → 同输出（确定性；测试锚定）。
// 依赖：仅契约层 kernel/schemas/verification.js（类型 + 枚举）——层 DAG 合规
//（kernel 不 import supervisor/runtime 任何东西；runtime/assembly.ts 消费本模块并注入组合 decideVerdict）。
//
// 语义（用户裁决 P3 范围）：
//   classifyRepairDamage：先判定损坏类型再处置（不可协商优先级）——① 验证器不可信（禁止据此修复）→
//     ② 外部不可控失败（不污染能力评分）→ ③ 环境变化（局部回归）→ ④ FAIL（硬约束命中 = 结构损坏，
//     否则行为回归）→ ⑤ UNKNOWN（证据不足 → 保持怀疑）→ ⑥ PASS（无损坏）；
//   seedRepairContract：七类对象（memory/process/skill/policy/capability/projection/version）各自挂载
//     验证契约（hard = 结构面硬约束不可被 LLM judge 覆盖；outcome = 语义面结果条件）；未列 kind 走
//     generic 兜底——统一契约驱动，避免 per-object repair 函数模块爆炸（裁决要点④）；
//   repairPlanForObject：对象契约 → 最小验证计划（deterministic 权威一级 + structured_llm 语义补充一级）；
//   applyRepairDisposition：损坏类型 → 处置语义（行为回归→降级/回滚、证据不足→UNKNOWN/保持怀疑、
//     环境变化→局部回归、验证器不可信→禁止据此修复、不可控失败→不污染能力评分、验证通过→清除存疑）。
import type { VerificationContract, VerificationPlan, VerificationResult } from './schemas/verification.js';

// ---- 六类损坏类型（裁决要点②：先判定再处置；不可协商优先级见 classifyRepairDamage） ----

/** 六类损坏类型（environment_change/behavior_regression/structural_damage/insufficient_evidence/
 * verifier_untrusted/external_uncontrollable） */
export const REPAIR_DAMAGE_KINDS = [
  'environment_change',
  'behavior_regression',
  'structural_damage',
  'insufficient_evidence',
  'verifier_untrusted',
  'external_uncontrollable',
] as const;
export type RepairDamageKind = (typeof REPAIR_DAMAGE_KINDS)[number];

// ---- 七类可 repair 对象（未列 kind → seedRepairContract generic 兜底） ----

/** 七类对象（memory/process/skill/policy/capability/projection/version；generic 兜底未列 kind） */
export const REPAIR_OBJECT_KINDS = [
  'memory',
  'process',
  'skill',
  'policy',
  'capability',
  'projection',
  'version',
] as const;
export type RepairObjectKind = (typeof REPAIR_OBJECT_KINDS)[number];

// ---- 检查名常量（契约种子与 runRepair 执行器共用——防字符串漂移） ----

/** memory 契约硬约束：对象可检索（getById 命中）——runRepair 当前可执行（确定性） */
export const REPAIR_CHECK_RETRIEVABLE = '对象可检索（getById 命中）';

/** generic 契约硬约束：对象存在且可读——runRepair 当前可执行（确定性，同 getById 命中判定） */
export const REPAIR_CHECK_GENERIC_READABLE = '对象存在且可读';

// ---- 分类上下文（runRepair 注入：环境变化标志 / 验证器可信 / 可控性 / 结构面检查名） ----

/** classifyRepairDamage 上下文（全部由调用方注入——纯函数不读墙钟不读环境） */
export interface RepairDamageContext {
  /** 所属 decay 记录 environment_delta 非空 → true（环境变化） */
  environment_changed: boolean;
  /** 内部确定性验证器可信（trust ≥ trust_required，经 trustGate 校验）——false 则禁止据此修复 */
  verifier_trusted: boolean;
  /** 外部不可控失败（如验证码阻塞）→ true 则不污染能力评分 */
  uncontrollable: boolean;
  /** 结构面检查名（= 契约 hard_constraints；FAIL 时 hard_failures 命中任一 → 结构损坏） */
  structural_checks: string[];
}

/**
 * 损坏类型分类（确定性纯函数；优先级不可协商）：
 *   ① verifier_trusted=false → 'verifier_untrusted'（验证器不可信——禁止据此修复对象，最高优先）；
 *   ② uncontrollable=true → 'external_uncontrollable'（外部不可控失败——不污染能力评分）；
 *   ③ environment_changed=true → 'environment_change'（输入/环境变化 → 局部回归）；
 *   ④ verdict=FAIL → hard_failures 任一 ∈ structural_checks → 'structural_damage'（结构损坏），
 *      否则 'behavior_regression'（行为回归——hard/outcome 被权威判 fail 但非结构面）；
 *   ⑤ verdict=UNKNOWN → 'insufficient_evidence'（证据不足 → UNKNOWN/保持怀疑）；
 *   ⑥ verdict=PASS → null（无损坏）。
 */
export function classifyRepairDamage(
  result: VerificationResult,
  ctx: RepairDamageContext,
): RepairDamageKind | null {
  if (!ctx.verifier_trusted) {
    return 'verifier_untrusted';
  }
  if (ctx.uncontrollable) {
    return 'external_uncontrollable';
  }
  if (ctx.environment_changed) {
    return 'environment_change';
  }
  if (result.verdict === 'FAIL') {
    const structural = result.hard_failures.some((f) => ctx.structural_checks.includes(f));
    return structural ? 'structural_damage' : 'behavior_regression';
  }
  if (result.verdict === 'UNKNOWN') {
    return 'insufficient_evidence';
  }
  return null; // PASS → 无损坏
}

// ---- 七类对象契约规格（hard = 结构面硬约束；outcome = 语义面结果条件；中文检查名可审计） ----

/** 单类对象契约规格（hard/outcome 检查名） */
interface RepairContractSpec {
  hard: string[];
  outcome: string[];
}

/** 七类对象契约映射（统一契约驱动——避免 per-object repair 函数模块爆炸，裁决要点④） */
const REPAIR_CONTRACT_SPECS: Record<RepairObjectKind, RepairContractSpec> = {
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

/** generic 兜底规格（未列 kind：对象存在可读 + 结构 schema 校验） */
const REPAIR_CONTRACT_GENERIC: RepairContractSpec = {
  hard: [REPAIR_CHECK_GENERIC_READABLE],
  outcome: ['对象结构 schema 校验通过'],
};

/** 确定性验证器盲区声明（覆盖声明：能证明结构面，证明不了语义达成） */
export const REPAIR_DETERMINISTIC_BLIND_SPOTS = ['语义面（如行为/语义达成）需语义验证器'] as const;

/** 结构化 LLM judge 盲区声明（覆盖声明：语义面；证明不了确定性面） */
export const REPAIR_JUDGE_BLIND_SPOTS = ['确定性面由确定性验证器覆盖'] as const;

/**
 * 对象验证契约种子（确定性纯函数）：
 * id=`repair:${objectId}`；goal=对象重验证；process_conditions=[]（诚实空）；trust_required='L1'；
 * verdict_semantics='all_must_pass'；verifiers 恒两枚：
 *   · deterministic（id=`repair:${kind}:deterministic`，trust L1，origin undefined，checks=hard+outcome——
 *     权威一级，盲区=语义面）；
 *   · structured_llm（id=`repair:${kind}:judge`，trust L2，origin undefined，checks=outcome——补充一级，
 *     盲区=确定性面；执行与否由调用方注入，不提供 → 诚实 UNKNOWN）。
 * kind 未列 REPAIR_OBJECT_KINDS → generic 兜底（hard=对象存在且可读）。
 */
export function seedRepairContract(kind: string, objectId: string): VerificationContract {
  // kind 未列 REPAIR_OBJECT_KINDS → generic 兜底（noUncheckedIndexedAccess 下索引返回 | undefined）
  const spec: RepairContractSpec =
    (REPAIR_CONTRACT_SPECS as Record<string, RepairContractSpec>)[kind] ?? REPAIR_CONTRACT_GENERIC;
  return {
    id: `repair:${objectId}`,
    goal: `对象重验证（${kind}：${objectId}）`,
    hard_constraints: [...spec.hard],
    outcome_conditions: [...spec.outcome],
    process_conditions: [],
    verifiers: [
      {
        id: `repair:${kind}:deterministic`,
        kind: 'deterministic',
        checks: [...spec.hard, ...spec.outcome],
        blind_spots: [...REPAIR_DETERMINISTIC_BLIND_SPOTS],
        trust: 'L1',
      },
      {
        id: `repair:${kind}:judge`,
        kind: 'structured_llm',
        checks: [...spec.outcome],
        blind_spots: [...REPAIR_JUDGE_BLIND_SPOTS],
        trust: 'L2',
      },
    ],
    trust_required: 'L1',
    verdict_semantics: 'all_must_pass',
  };
}

/**
 * 最小验证计划（确定性纯函数）：对象契约 → 本次实际执行哪些验证——
 * 第一步 deterministic 权威（evidence_required=hard+outcome 全部应查），第二步 judge 语义补充
 * （evidence_required=outcome）；当前 runRepair 只执行确定性 getById 检查（其余无执行器 → 不产证据 →
 * 诚实 UNKNOWN）。
 */
export function repairPlanForObject(kind: string, objectId: string): VerificationPlan {
  const contract = seedRepairContract(kind, objectId);
  return {
    contract_id: contract.id,
    steps: [
      {
        verifier_id: `repair:${kind}:deterministic`,
        evidence_required: [...contract.hard_constraints, ...contract.outcome_conditions],
      },
      {
        verifier_id: `repair:${kind}:judge`,
        evidence_required: [...contract.outcome_conditions],
      },
    ],
  };
}

// ---- 处置语义（裁决要点③：损坏类型 → 处置动作 + 能力评分资格） ----

/** 处置动作：no_repair（禁止修复）/ degrade_or_rollback（行为回归→降级/回滚）/ local_regression
 * （环境变化→局部回归）/ keep_suspicious（证据不足→UNKNOWN/保持怀疑）/ quarantine（结构损坏→隔离标记）/
 * clear_suspicious（验证通过→清除存疑） */
export type RepairDisposition =
  | 'no_repair'
  | 'degrade_or_rollback'
  | 'local_regression'
  | 'keep_suspicious'
  | 'quarantine'
  | 'clear_suspicious';

/** 处置结果（disposition + 是否计入能力评分 + 中文可审计理由） */
export interface RepairDispositionResult {
  disposition: RepairDisposition;
  /** true = 可计入能力评分；false = 不污染评分（验证器不可信/外部不可控失败） */
  score_eligible: boolean;
  reason: string;
}

/**
 * 损坏类型 → 处置语义（确定性纯函数；reason 中文可审计，含 kind/objectId/损坏类型）：
 *   verifier_untrusted → no_repair, score_eligible:false（禁止据此修复对象——验证器不可信）；
 *   external_uncontrollable → no_repair, score_eligible:false（不可控失败——不污染能力评分）；
 *   environment_change → local_regression, true（环境变化 → 局部回归）；
 *   behavior_regression → degrade_or_rollback, true（行为回归 → 降级/回滚）；
 *   structural_damage → quarantine, true（结构损坏 → 隔离标记）；
 *   insufficient_evidence → keep_suspicious, true（证据不足 → UNKNOWN/保持怀疑）；
 *   null（PASS）→ clear_suspicious, true（验证通过 → 清除存疑）。
 */
export function applyRepairDisposition(
  kind: string,
  objectId: string,
  damage: RepairDamageKind | null,
): RepairDispositionResult {
  switch (damage) {
    case 'verifier_untrusted':
      return {
        disposition: 'no_repair',
        score_eligible: false,
        reason: `损坏类型=验证器不可信（${kind}：${objectId}）——禁止据此修复对象，不产生可修复动作，不污染能力评分`,
      };
    case 'external_uncontrollable':
      return {
        disposition: 'no_repair',
        score_eligible: false,
        reason: `损坏类型=外部不可控失败（${kind}：${objectId}）——不污染能力评分，不产生可修复动作`,
      };
    case 'environment_change':
      return {
        disposition: 'local_regression',
        score_eligible: true,
        reason: `损坏类型=环境变化（${kind}：${objectId}）——执行局部回归验证，能力评分计入`,
      };
    case 'behavior_regression':
      return {
        disposition: 'degrade_or_rollback',
        score_eligible: true,
        reason: `损坏类型=行为回归（${kind}：${objectId}）——降级/回滚处置，能力评分计入`,
      };
    case 'structural_damage':
      return {
        disposition: 'quarantine',
        score_eligible: true,
        reason: `损坏类型=结构损坏（${kind}：${objectId}）——隔离标记处置，能力评分计入`,
      };
    case 'insufficient_evidence':
      return {
        disposition: 'keep_suspicious',
        score_eligible: true,
        reason: `损坏类型=证据不足（${kind}：${objectId}，UNKNOWN）——保持存疑，能力评分计入`,
      };
    case null:
      return {
        disposition: 'clear_suspicious',
        score_eligible: true,
        reason: `验证通过（${kind}：${objectId}，PASS）——清除存疑（lifecycle 恢复 Active），能力评分计入`,
      };
  }
}
