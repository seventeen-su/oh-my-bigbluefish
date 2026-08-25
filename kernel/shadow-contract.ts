// layer 2（kernel/）：P2 Shadow 真实判定——验证契约种子 + 证据构造 + 判定映射（计划
// .omb/plans/2026-08-25-verification-contract.md；用户裁决 P2 范围）。零 I/O、零副作用、零随机
//（ts 由调用方注入——同输入同输出，测试锚定）。
// 依赖：仅契约层 kernel/schemas/verification.ts（类型）——层 DAG 合规（kernel 不 import 上层；
// decideVerdict 由消费方（runtime/assembly.ts）注入组合，本模块不 import 逻辑只消费类型）。
//
// 语义（用户裁决 P2 范围）：
//   seedShadowContract：Shadow 契约种子 = 会话 task_contract（goal + success_criteria）+ 默认硬约束——
//     · 硬约束（不可被 LLM judge 覆盖）：会话过程无降级（decision.process.degraded 为空）；
//     · 结果条件：会话产生决策（decision/made 事件入链）兜底 + 成功标准逐项并入——成功条件无确定性
//       证据时诚实 UNKNOWN（不强行裁决）；
//     · 过程条件：通用会话无默认过程约束——诚实空（P3 起由 process_quality 注入面覆盖）；
//     · 验证器两枚恒声明（展示完整验证阶梯）：确定性代理（L1 权威）+ 结构化 LLM judge（L2 补充）——
//       judge 执行与否由调用方注入（P2 生产默认不调用 judge；真实 LLM judge 调用留 P2.5 文档化）。
//   buildShadowEvidence：确定性证据（proxy，source='finalizeTurn:proxy'）+ 可选 judge 补充证据
//     （judgeChecks 注入面，source='finalizeTurn:judge'——非空才产出）。
//   shadowOutcomeFromResult：三态判定 → S7 outcome 三值（success/degraded/unknown）——兼容既有消费面
//     （success/degraded 语义不变；unknown = UNKNOWN 独立档，L2 不计失败不污染评分）。
import type { Verdict, VerificationContract, VerificationEvidence } from './schemas/verification.js';

/** P2：Shadow 会话任务契约种子输入（task_contract 最小视图：goal + success_criteria） */
export interface ShadowTaskContract {
  goal: string;
  success_criteria: string[];
}

/** P2：buildShadowEvidence 信号输入（finalizeTurn 可观测信号；judgeChecks = LLM judge 注入面） */
export interface ShadowEvidenceSignals {
  /** 会话过程是否降级（decision.process.degraded 非空） */
  degraded: boolean;
  /** 会话是否产生决策（decision/made 事件入链） */
  decision_made: boolean;
  /** LLM judge 结构化检查结果（可选；提供且非空 → 补充证据——P2 生产默认不调用，留 P2.5） */
  judgeChecks?: Array<{ name: string; result: 'pass' | 'fail' | 'unknown'; detail?: string }>;
}

/** 默认硬约束（不可被 LLM judge 覆盖）——常量防漂移（契约种子与证据构造共用） */
export const SHADOW_HARD_CONSTRAINT = '会话过程无降级（decision.process.degraded 为空）';

/** 结果条件兜底（会话产生决策）——常量防漂移 */
export const SHADOW_DECISION_CONDITION = '会话产生决策（decision/made 事件入链）';

/** 确定性代理验证器 id（权威一级；source='finalizeTurn:proxy'） */
export const SHADOW_PROXY_VERIFIER_ID = 'shadow:proxy:deterministic';

/** 结构化 LLM judge 验证器 id（补充三级；source='finalizeTurn:judge'——恒声明，执行由调用方注入） */
export const SHADOW_JUDGE_VERIFIER_ID = 'shadow:judge:semantic';

/**
 * Shadow 验证契约种子（确定性纯函数）：
 * id=`shadow:${sessionId}`；goal=task.goal；硬约束=默认过程无降级；结果条件=决策兜底 + success_criteria
 * 逐项并入（无确定性证据 → 诚实 UNKNOWN）；process_conditions=[]（诚实空）；verifiers 恒声明两枚
 *（deterministic L1 权威 + structured_llm L2 补充——完整验证阶梯展示，judge 执行与否由调用方注入）；
 * trust_required='L1'；verdict_semantics='all_must_pass'。
 * 注：success_criteria 为空时 judge verifier 的 checks 为空数组（decideVerdict 不读取 verifier.checks——
 * 仅按 id→kind 分层，功能不受影响；schema 校验面由消费方负责）。
 */
export function seedShadowContract(sessionId: string, task: ShadowTaskContract): VerificationContract {
  return {
    id: `shadow:${sessionId}`,
    goal: task.goal,
    hard_constraints: [SHADOW_HARD_CONSTRAINT],
    outcome_conditions: [SHADOW_DECISION_CONDITION, ...task.success_criteria],
    process_conditions: [],
    verifiers: [
      {
        id: SHADOW_PROXY_VERIFIER_ID,
        kind: 'deterministic',
        checks: [SHADOW_HARD_CONSTRAINT, SHADOW_DECISION_CONDITION],
        blind_spots: ['任务语义成功（success_criteria 达成）——需语义验证器'],
        trust: 'L1',
      },
      {
        id: SHADOW_JUDGE_VERIFIER_ID,
        kind: 'structured_llm',
        checks: task.success_criteria,
        blind_spots: ['确定性/外部可验证面'],
        trust: 'L2',
      },
    ],
    trust_required: 'L1',
    verdict_semantics: 'all_must_pass',
  };
}

/**
 * Shadow 验证证据构造（确定性纯函数，ts 由调用方注入）：
 * ① 确定性证据（verifier_id=shadow:proxy:deterministic，source='finalizeTurn:proxy'）：过程无降级 →
 *   degraded ? fail : pass；决策产生 → decision_made ? pass : fail（均带 detail 可审计）；
 * ② judgeChecks 提供且非空 → 补充证据（verifier_id=shadow:judge:semantic，source='finalizeTurn:judge'）：
 *   逐条透传 name/result/detail（LLM judge 注入面——生产默认不提供，留 P2.5 真实调用）；
 * contract_id 均填 contract.id（契约隔离键）。
 */
export function buildShadowEvidence(
  contract: VerificationContract,
  signals: ShadowEvidenceSignals,
): VerificationEvidence[] {
  const evidence: VerificationEvidence[] = [
    {
      verifier_id: SHADOW_PROXY_VERIFIER_ID,
      contract_id: contract.id,
      checks: [
        {
          name: SHADOW_HARD_CONSTRAINT,
          result: signals.degraded ? 'fail' : 'pass',
          detail: signals.degraded
            ? 'decision.process.degraded 非空——过程降级'
            : 'decision.process.degraded 为空——过程无降级',
        },
        {
          name: SHADOW_DECISION_CONDITION,
          result: signals.decision_made ? 'pass' : 'fail',
          detail: signals.decision_made
            ? 'finalizeTurn 路径已入链 decision/made'
            : 'finalizeTurn 路径未入链 decision/made',
        },
      ],
      ts: Date.now(),
      source: 'finalizeTurn:proxy',
    },
  ];
  if (signals.judgeChecks !== undefined && signals.judgeChecks.length > 0) {
    evidence.push({
      verifier_id: SHADOW_JUDGE_VERIFIER_ID,
      contract_id: contract.id,
      checks: signals.judgeChecks.map((c) => ({ name: c.name, result: c.result, detail: c.detail })),
      ts: Date.now(),
      source: 'finalizeTurn:judge',
    });
  }
  return evidence;
}

/**
 * 三态判定 → S7 outcome 三值映射（确定性纯函数）：
 * PASS → 'success'（与既有代理判定语义一致）；FAIL → 'degraded'（既有语义不变）；
 * UNKNOWN → 'unknown'（P2 新增独立档——L2 单列 unknowns 计数，不计 failures、不污染失败率评分）。
 */
export function shadowOutcomeFromResult(result: { verdict: Verdict }): 'success' | 'degraded' | 'unknown' {
  if (result.verdict === 'PASS') {
    return 'success';
  }
  if (result.verdict === 'FAIL') {
    return 'degraded';
  }
  return 'unknown';
}
