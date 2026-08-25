// layer 2（kernel/）：P4 Benchmark 收敛——bench v2 适配层（结果 → 验证契约语义纯映射；计划
// .omb/plans/2026-08-25-verification-contract.md；用户裁决 P4 范围 ④：bench 收敛到同一套契约语义）。
// 零 I/O、零副作用、零随机（benchEvidenceFromResult 的 ts 由调用方按既有约定注入 Date.now()）。
// 依赖：仅契约层 kernel/schemas/verification.ts（类型）——层 DAG 合规（kernel 不 import 上层；
// verifyV2 判定逻辑在 supervisor/bench-v2.ts 不迁移——本模块只做「结果 → 契约语义」纯映射，零逻辑重复；
// 消费接线由 runtime/assembly.ts（kern_bench 数据源）完成）。
//
// 语义（用户裁决 P4 范围 ④）：冻结基准（20 任务）经本适配层复用同一套 Contract/Evidence/Result 语义——
//   benchContractFromTask：每任务 → 验证契约（hard = verifier 规则判定通过（verifyV2）；outcome =
//     output_schema 合法；verifier = deterministic 权威（trust L2，origin 'kernel:bench' 独立来源）；
//     trust_required='L2'；goal = task.prompt 截断摘要）。
//   benchEvidenceFromResult：任务运行结果（passed/parse_ok）→ 权威证据（source='runBenchV2:rules'）；
//     decideVerdict 消费后三态判定——全 PASS = 契约语义下基准通过（同一套语义覆盖 bench）。
import type { VerificationContract, VerificationEvidence } from './schemas/verification.js';

// ---- 检查名常量（契约种子与证据构造共用——防漂移） ----

/** hard 约束：verifier 规则判定（verifyV2——exact/tests/state_assert/predicate/blind_judge） */
export const BENCH_RULES_CHECK = 'verifier 规则判定通过（verifyV2）';

/** outcome 条件：输出过 output_schema（契约单一权威） */
export const BENCH_SCHEMA_CHECK = 'output_schema 合法';

/** bench 规则验证器 id（deterministic 权威一级） */
export const BENCH_RULES_VERIFIER_ID = 'bench:rules:deterministic';

/** bench 规则验证器来源（独立来源——非循环检查通过；内核基准验证器 origin='kernel:bench'） */
export const BENCH_RULES_ORIGIN = 'kernel:bench';

/** goal 截断上限（prompt 过长 → 摘要；80 字符 + 省略号） */
const GOAL_MAX = 80;

/**
 * bench 任务 → 验证契约（确定性纯函数）：
 * id=`bench:${task.id}`；goal=task.prompt 截断摘要（>80 字符 → 前 80 + '…'）；
 * hard_constraints=[verifier 规则判定通过（verifyV2）]；outcome_conditions=[output_schema 合法]；
 * verifiers=单枚 deterministic 权威验证器（trust L2，origin 'kernel:bench' 独立来源；
 * checks=两项检查名；blind_spots 声明盲区：语义正确性（judge 旁证面））；
 * trust_required='L2'；verdict_semantics='all_must_pass'。
 */
export function benchContractFromTask(task: { id: string; prompt: string }): VerificationContract {
  const goal = task.prompt.length > GOAL_MAX ? `${task.prompt.slice(0, GOAL_MAX)}…` : task.prompt;
  return {
    id: `bench:${task.id}`,
    goal,
    hard_constraints: [BENCH_RULES_CHECK],
    outcome_conditions: [BENCH_SCHEMA_CHECK],
    verifiers: [
      {
        id: BENCH_RULES_VERIFIER_ID,
        kind: 'deterministic',
        checks: [BENCH_RULES_CHECK, BENCH_SCHEMA_CHECK],
        blind_spots: ['语义正确性（judge 旁证面）'],
        trust: 'L2',
        origin: BENCH_RULES_ORIGIN,
      },
    ],
    trust_required: 'L2',
    verdict_semantics: 'all_must_pass',
  };
}

/**
 * 任务运行结果 → 验证证据（确定性纯函数；ts 由调用方注入）：
 * verifier_id='bench:rules:deterministic'，source='runBenchV2:rules'；
 * 'verifier 规则判定通过（verifyV2）' → passed ? pass : fail；'output_schema 合法' → parse_ok ? pass : fail。
 * 注：verifyV2 判定逻辑（supervisor/bench-v2.ts）不迁移——本函数只做结果 → 契约语义映射（零逻辑重复）。
 */
export function benchEvidenceFromResult(
  contract: VerificationContract,
  run: { passed: boolean; parse_ok: boolean },
): VerificationEvidence {
  return {
    verifier_id: BENCH_RULES_VERIFIER_ID,
    contract_id: contract.id,
    checks: [
      {
        name: BENCH_RULES_CHECK,
        result: run.passed ? 'pass' : 'fail',
        detail: run.passed ? 'verifyV2 规则判定通过' : 'verifyV2 规则判定失败',
      },
      {
        name: BENCH_SCHEMA_CHECK,
        result: run.parse_ok ? 'pass' : 'fail',
        detail: run.parse_ok ? 'output_schema 合法' : 'output_schema 不合法',
      },
    ],
    ts: Date.now(),
    source: 'runBenchV2:rules',
  };
}
