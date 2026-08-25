// P1（2026-08-25-verification-contract）：统一验证基础设施核心测试（验证契约语义纯函数 + schema）。
// 覆盖（计划 §P1 交付物）：
//   ① decideVerdict 三态：全权威 pass → PASS；权威 hard fail → FAIL（即使补充证据全 pass——hard 优先）；
//      权威 outcome fail → FAIL（hard_failures 记录）；权威 unknown → UNKNOWN；LLM（structured_llm）判 hard fail
//      但无权威证据 → UNKNOWN（不能定 FAIL）；LLM pass 补缺 → PASS；人工/多模型（human_multi）同属补充证据
//   ② evidence_quality：全查 → 1；半查 → 0.5；无证据 → 0；unknown 检查不计入有结果
//   ③ trustGate：L0<L2 / L2>=L2（equal）/ L4>=L2 等边界 + 全序单调（枚举遍历）
//   ④ nonCircularityCheck：未声明 origin → ok；origin==candidateId → 拒绝；外部 origin → ok；相似 id 不误拒
//   ⑤ schema 校验：合法契约/计划/证据/结果通过；非法枚举 / 空数组 / 越界 fail-loud
//   ⑥ 确定性：同输入同输出（deep equal + JSON 字节一致）；契约隔离（错 contract_id / 未声明 verifier 忽略）
import { describe, expect, it } from 'vitest';
import { decideVerdict, nonCircularityCheck, trustGate } from '../../kernel/verification.js';
import {
  TRUST_LEVELS,
  VERDICTS,
  VERIFIER_KINDS,
  VerificationContractSchema,
  VerificationEvidenceSchema,
  VerificationPlanSchema,
  VerificationResultSchema,
  type CheckResult,
  type VerificationContract,
  type VerificationEvidence,
} from '../../kernel/schemas/verification.js';

// ---- 测试工具（确定性 fixture） ----

const CONTRACT_ID = 'vc-db-migrate';

/** 最小合法契约：2 硬约束 + 2 结果条件 + 三级验证器（确定性/外部 = 权威，结构化 LLM = 补充） */
function baseContract(over: Partial<VerificationContract> = {}): VerificationContract {
  return {
    id: CONTRACT_ID,
    goal: '完成数据库迁移（PostgreSQL 16 → 17）',
    hard_constraints: ['数据库可正常启动', '原有数据不丢失'],
    outcome_conditions: ['迁移后 schema 与目标一致', '核心查询全部通过'],
    verifiers: [
      {
        id: 'db_check',
        kind: 'deterministic',
        checks: ['数据库可正常启动', '原有数据不丢失'],
        blind_spots: ['性能退化'],
        trust: 'L2',
      },
      {
        id: 'query_test',
        kind: 'external',
        checks: ['迁移后 schema 与目标一致', '核心查询全部通过'],
        blind_spots: ['未覆盖边界用例'],
        trust: 'L2',
      },
      {
        id: 'llm_judge',
        kind: 'structured_llm',
        checks: ['数据库可正常启动', '原有数据不丢失', '迁移后 schema 与目标一致', '核心查询全部通过'],
        blind_spots: [],
        trust: 'L3',
      },
    ],
    trust_required: 'L2',
    verdict_semantics: 'all_must_pass',
    ...over,
  };
}

/** 最小证据工厂（check 名 = 契约应查检查名；可选 detail） */
function ev(
  verifierId: string,
  entries: Array<[string, CheckResult, string?]>,
  over: Partial<VerificationEvidence> = {},
): VerificationEvidence {
  return {
    verifier_id: verifierId,
    contract_id: CONTRACT_ID,
    checks: entries.map(([name, result, detail]) =>
      detail === undefined ? { name, result } : { name, result, detail },
    ),
    ts: 1_700_000_000_000,
    source: 'test',
    ...over,
  };
}

// ---- ① decideVerdict 三态 ----

describe('① decideVerdict 三态（权威/补充证据分层）', () => {
  it('全权威证据 pass → PASS（hard + outcome 全部应查覆盖；evidence_quality=1）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.contract_id).toBe(CONTRACT_ID);
    expect(r.verdict).toBe('PASS');
    expect(r.hard_failures).toEqual([]);
    expect(r.unknown_checks).toEqual([]);
    expect(r.evidence_quality).toBe(1);
    expect(r.reason).toContain('判定 PASS');
  });

  it('权威 hard fail → FAIL（即使补充证据全 pass——hard 优先，LLM 不能覆盖硬约束）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'fail'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
      ev('llm_judge', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.verdict).toBe('FAIL');
    expect(r.hard_failures).toEqual(['数据库可正常启动']);
    expect(r.unknown_checks).toEqual([]);
    expect(r.evidence_quality).toBe(1);
    expect(r.reason).toContain('判定 FAIL');
  });

  it('权威 outcome fail → FAIL（outcome 也记入 hard_failures——裁决要点①）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'fail'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.verdict).toBe('FAIL');
    expect(r.hard_failures).toEqual(['迁移后 schema 与目标一致']);
  });

  it('权威 unknown 且无 fail → UNKNOWN（证据不足不强行裁决；unknown_checks 记录）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'unknown'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.hard_failures).toEqual([]);
    expect(r.unknown_checks).toEqual(['原有数据不丢失']);
    expect(r.evidence_quality).toBe(0.75);
  });

  it('LLM（structured_llm）判 hard fail 但无权威证据 → UNKNOWN（不能定 FAIL）', () => {
    const r = decideVerdict(baseContract(), [
      ev('llm_judge', [
        ['数据库可正常启动', 'fail'],
        ['原有数据不丢失', 'pass'],
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.hard_failures).toEqual([]);
    expect(r.unknown_checks).toEqual(['数据库可正常启动']);
    expect(r.reason).toContain('hard 仅补充证据判 fail（LLM 不能定 FAIL）：数据库可正常启动');
  });

  it('LLM pass 补缺 → PASS（权威无覆盖项由语义补充验证器兜底）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('llm_judge', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.verdict).toBe('PASS');
    expect(r.unknown_checks).toEqual([]);
    expect(r.evidence_quality).toBe(1);
  });

  it('人工/多模型（human_multi）同属补充证据：可补缺 PASS、不能独立定 FAIL', () => {
    const c = baseContract({
      verifiers: [
        ...baseContract().verifiers,
        {
          id: 'human_review',
          kind: 'human_multi',
          checks: ['迁移后 schema 与目标一致', '核心查询全部通过'],
          blind_spots: [],
          trust: 'L4',
        },
      ],
    });
    const pass = decideVerdict(c, [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('human_review', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(pass.verdict).toBe('PASS');
    const failOnlyByHuman = decideVerdict(c, [
      ev('human_review', [
        ['迁移后 schema 与目标一致', 'fail'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(failOnlyByHuman.verdict).toBe('UNKNOWN'); // 无权威证据 → 不能定 FAIL
    expect(failOnlyByHuman.hard_failures).toEqual([]);
  });

  it('无任何证据 → UNKNOWN 且 evidence_quality=0（证据不足不强行裁决）', () => {
    const r = decideVerdict(baseContract(), []);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.hard_failures).toEqual([]);
    expect(r.unknown_checks).toEqual(['数据库可正常启动', '原有数据不丢失', '迁移后 schema 与目标一致', '核心查询全部通过']);
    expect(r.evidence_quality).toBe(0);
  });

  it('契约隔离：contract_id 不匹配 / 未声明 verifier 的证据被忽略（不参与判定与质量）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ], { contract_id: 'other-contract' }),
      ev('rogue_verifier', [['数据库可正常启动', 'pass']]),
    ]);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.evidence_quality).toBe(0);
    expect(r.evidence).toEqual([]);
  });
});

// ---- ② evidence_quality ----

describe('② evidence_quality（有结果检查数 / 全部应查检查数，0~1 保留两位）', () => {
  it('全查 → 1（应查 4 项全部有 pass/fail 结果）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'fail'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'pass'],
      ]),
    ]);
    expect(r.evidence_quality).toBe(1);
  });

  it('半查 → 0.5（仅权威覆盖 2 项 hard，outcome 无证据）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
    ]);
    expect(r.evidence_quality).toBe(0.5);
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('unknown 结果不计入有结果（4 项中 1 项 unknown → 0.75）', () => {
    const r = decideVerdict(baseContract(), [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'pass'],
        ['核心查询全部通过', 'unknown'],
      ]),
    ]);
    expect(r.evidence_quality).toBe(0.75);
  });

  it('无证据 → 0', () => {
    const r = decideVerdict(baseContract(), []);
    expect(r.evidence_quality).toBe(0);
  });
});

// ---- ③ trustGate ----

describe('③ trustGate（序号 >= required 才放行，含 equal）', () => {
  it('边界：L0<L2 / L1<L2 拒；L2>=L2 equal 放行；L3/L4>=L2 放行', () => {
    expect(trustGate('L0', 'L2')).toBe(false);
    expect(trustGate('L1', 'L2')).toBe(false);
    expect(trustGate('L2', 'L2')).toBe(true);
    expect(trustGate('L3', 'L2')).toBe(true);
    expect(trustGate('L4', 'L2')).toBe(true);
  });

  it('边界：L0>=L0 equal 放行；L4>=L4 equal 放行', () => {
    expect(trustGate('L0', 'L0')).toBe(true);
    expect(trustGate('L4', 'L4')).toBe(true);
  });

  it('全序单调：任意 (t, required) 组合均满足序号比较（枚举遍历防漂移）', () => {
    const order = (l: (typeof TRUST_LEVELS)[number]) => TRUST_LEVELS.indexOf(l);
    for (const required of TRUST_LEVELS) {
      for (const t of TRUST_LEVELS) {
        expect(trustGate(t, required)).toBe(order(t) >= order(required));
      }
    }
  });
});

// ---- ④ nonCircularityCheck ----

describe('④ nonCircularityCheck（防循环自证，裁决要点⑤）', () => {
  it('未声明 origin（外部/独立来源）→ ok', () => {
    const r = nonCircularityCheck({ origin: undefined }, 'cand-x');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('未声明来源');
  });

  it('origin === candidateId → 拒绝（循环自证）', () => {
    const r = nonCircularityCheck({ origin: 'cand-x' }, 'cand-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('循环自证拒绝');
    expect(r.reason).toContain('cand-x');
  });

  it('外部独立 origin → ok（字符串精确比较）', () => {
    const r = nonCircularityCheck({ origin: 'verifier-registry:official' }, 'cand-x');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('独立于候选');
  });

  it('相似但不同的 id 不误拒（字符串精确比较）', () => {
    expect(nonCircularityCheck({ origin: 'cand-xy' }, 'cand-x').ok).toBe(true);
    expect(nonCircularityCheck({ origin: 'cand_x' }, 'cand-x').ok).toBe(true);
  });
});

// ---- ⑤ schema 校验 ----

describe('⑤ schema 校验（合法通过 / 非法 fail-loud）', () => {
  it('合法契约通过 parse；枚举常量与既定语义一致（防漂移锚）', () => {
    expect(VerificationContractSchema.parse(baseContract()).id).toBe(CONTRACT_ID);
    expect(VERIFIER_KINDS).toEqual(['deterministic', 'external', 'structured_llm', 'human_multi']);
    expect(VERDICTS).toEqual(['PASS', 'FAIL', 'UNKNOWN']);
    expect(TRUST_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('非法 verifier kind → fail-loud', () => {
    const bad: unknown = {
      ...baseContract(),
      verifiers: [{ id: 'v1', kind: 'llm', checks: ['x'], blind_spots: [], trust: 'L2' }],
    };
    expect(() => VerificationContractSchema.parse(bad)).toThrow();
  });

  it('非法 trust_required / verdict_semantics → fail-loud', () => {
    expect(() =>
      VerificationContractSchema.parse({ ...baseContract(), trust_required: 'L9' }),
    ).toThrow();
    expect(() =>
      VerificationContractSchema.parse({ ...baseContract(), verdict_semantics: 'any_pass' }),
    ).toThrow();
  });

  it('空数组 fail-loud（hard_constraints / verifiers / plan steps 均非空）', () => {
    expect(() =>
      VerificationContractSchema.parse({ ...baseContract(), hard_constraints: [] }),
    ).toThrow();
    expect(() => VerificationContractSchema.parse({ ...baseContract(), verifiers: [] })).toThrow();
    expect(() => VerificationPlanSchema.parse({ contract_id: CONTRACT_ID, steps: [] })).toThrow();
  });

  it('证据非法 result 枚举 → fail-loud', () => {
    const bad: unknown = {
      verifier_id: 'db_check',
      contract_id: CONTRACT_ID,
      checks: [{ name: '数据库可正常启动', result: 'maybe' }],
      ts: 0,
      source: 't',
    };
    expect(() => VerificationEvidenceSchema.parse(bad)).toThrow();
  });

  it('结果 evidence_quality 越界（>1 / <0）→ fail-loud；process_quality 越界 → fail-loud', () => {
    const ok: VerificationEvidence[] = [
      ev('db_check', [['数据库可正常启动', 'pass'], ['原有数据不丢失', 'pass']]),
    ];
    expect(() =>
      VerificationResultSchema.parse({
        contract_id: CONTRACT_ID,
        verdict: 'PASS',
        hard_failures: [],
        unknown_checks: [],
        evidence_quality: 1.5,
        reason: 'r',
        evidence: ok,
      }),
    ).toThrow();
    expect(() =>
      VerificationResultSchema.parse({
        contract_id: CONTRACT_ID,
        verdict: 'PASS',
        hard_failures: [],
        unknown_checks: [],
        evidence_quality: -0.1,
        reason: 'r',
        evidence: ok,
      }),
    ).toThrow();
    expect(() =>
      VerificationResultSchema.parse({
        contract_id: CONTRACT_ID,
        verdict: 'PASS',
        hard_failures: [],
        unknown_checks: [],
        process_quality: 1.2,
        evidence_quality: 1,
        reason: 'r',
        evidence: ok,
      }),
    ).toThrow();
  });
});

// ---- ⑥ 确定性 ----

describe('⑥ 确定性（同输入同输出）', () => {
  it('decideVerdict 同输入两次 → deep equal + JSON 字节一致（含 UNKNOWN 路径）', () => {
    const c = baseContract();
    const evs = [
      ev('db_check', [
        ['数据库可正常启动', 'pass'],
        ['原有数据不丢失', 'pass'],
      ]),
      ev('query_test', [
        ['迁移后 schema 与目标一致', 'unknown'],
        ['核心查询全部通过', 'pass'],
      ]),
    ];
    const r1 = decideVerdict(c, evs);
    const r2 = decideVerdict(c, evs);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.verdict).toBe('UNKNOWN'); // 路径确实落在 UNKNOWN 分支（非恒 PASS 假阳性）
    expect(r1.evidence_quality).toBe(0.75);
  });
});
