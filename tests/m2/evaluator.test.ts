// T2.6 行为测试：评估数据结构定义（runtime/evaluator.ts，架构 §10.1 能力向量 + P5 三层信号）。
// 七类：① 维度完备性（facts 可含全部 9 维 / 缺维合法 / 每维一条拒绝重复 / id 必须 vector:<uuid>）
//       ② 分类枚举（7 种分类均可校验；非法分类拒绝）
//       ③ 序列化往返（vector/signal JSON.stringify → parse → zod 校验 → 深度相等；非法 JSON 拒绝）
//       ④ 区间表达（confidence_interval low ≤ high；low > high 拒绝）
//       ⑤ 三层信号（L1/L2/L3 各构造一例校验通过；kind 枚举非法拒绝；window from ≤ to）
//       ⑥ fromUtilityCounts（M1 Memory.utility_counts 六计数器 → L1 信号数组，计数映射）
//       ⑦ 无数据维（value null 合法，Unknown 依据）
import { describe, expect, it } from 'vitest';
import {
  CapabilityVectorSchema,
  EvaluationSignalSchema,
  fromUtilityCounts,
  makeVectorId,
  signalFromJSON,
  signalToJSON,
  vectorFromJSON,
  vectorToJSON,
  type CapabilityVector,
  type DimensionFact,
  type EvaluationSignal,
} from '../../runtime/evaluator.js';
import { FingerprintSchema } from '../../kernel/schemas/base.js';

const TEST_FINGERPRINT = FingerprintSchema.parse({
  os: 'win32',
  node: 'v24.0.0',
  dsh_version: '0.2.0',
  project: 'omb-v2',
});

const TARGET = 'capability:6f9619ff-8b86-d011-b42d-00cf4fc964ff';

/** 合法维度事实工厂（overrides 覆盖单字段，便于造非法样例） */
function fact(overrides: Partial<DimensionFact> = {}): DimensionFact {
  return {
    dimension: 'correctness',
    value: 0.9,
    signal_sources: ['L1_mechanical'],
    evidence_refs: ['evt:1'],
    sample_size: 10,
    ...overrides,
  };
}

/** 合法能力向量工厂（overrides 覆盖单字段，便于造非法样例） */
function vector(overrides: Partial<CapabilityVector> = {}): CapabilityVector {
  return {
    id: makeVectorId(),
    target: TARGET,
    facts: [fact()],
    classification: 'Stable',
    classification_confidence: 0.8,
    environment: TEST_FINGERPRINT,
    created: 1_700_000_000_000,
    provenance: { source: 'evaluator-test', events: ['evt:1'] },
    ...overrides,
  };
}

describe('① 维度完备性（§10.1 九维独立事实，无总裁判）', () => {
  const ALL_DIMS: DimensionFact[] = [
    fact({ dimension: 'correctness', value: 0.9 }),
    fact({ dimension: 'cost', value: 0.4 }),
    fact({ dimension: 'robustness', value: 0.7 }),
    fact({ dimension: 'generalization', value: 0.6 }),
    fact({ dimension: 'interpretability', value: 0.8 }),
    fact({ dimension: 'regression', value: 0.1 }),
    fact({ dimension: 'transferability', value: 0.5 }),
    fact({ dimension: 'maintenance_cost', value: 0.3 }),
    fact({ dimension: 'contamination_risk', value: 0.2 }),
  ];

  it('facts 可含全部 9 维（每维一条）→ 校验通过', () => {
    const r = CapabilityVectorSchema.safeParse(vector({ facts: ALL_DIMS }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.facts).toHaveLength(9);
    }
  });

  it('缺维合法：仅含 2 维子集 → 校验通过', () => {
    const r = CapabilityVectorSchema.safeParse(vector({ facts: ALL_DIMS.slice(0, 2) }));
    expect(r.success).toBe(true);
  });

  it('facts 空数组（全缺维，Unknown 语义）→ 校验通过', () => {
    const r = CapabilityVectorSchema.safeParse(vector({ facts: [] }));
    expect(r.success).toBe(true);
  });

  it('重复维度（违反"每维一条"）→ 拒绝', () => {
    const r = CapabilityVectorSchema.safeParse(
      vector({ facts: [fact(), fact({ value: 0.5 })] }), // 两条 correctness
    );
    expect(r.success).toBe(false);
  });

  it('id 必须为 vector:<uuid>（非法 id 拒绝）', () => {
    expect(CapabilityVectorSchema.safeParse(vector({ id: 'capability:xxx' })).success).toBe(false);
    expect(CapabilityVectorSchema.safeParse(vector({ id: 'vector:not-a-uuid' })).success).toBe(false);
  });
});

describe('② 分类枚举（§10.1 七分类）', () => {
  const SEVEN_CLASSIFICATIONS = [
    'Stable',
    'Candidate',
    'Better-in-domain',
    'Cheaper-but-weaker',
    'More-robust',
    'Unknown',
    'Regressed',
  ] as const;

  it('7 种分类均可校验', () => {
    for (const c of SEVEN_CLASSIFICATIONS) {
      expect(CapabilityVectorSchema.safeParse(vector({ classification: c })).success, c).toBe(true);
    }
  });

  it('非法分类拒绝', () => {
    const bad = vector() as unknown as { classification: string };
    bad.classification = 'Super';
    expect(CapabilityVectorSchema.safeParse(bad).success).toBe(false);
  });
});

describe('③ 序列化往返（JSON.stringify → parse → zod 校验 → 深度相等）', () => {
  it('CapabilityVector 往返一致', () => {
    const v = vector({
      facts: [fact({ confidence_interval: { low: 0.8, high: 0.9 } }), fact({ dimension: 'cost', value: null })],
    });
    expect(vectorFromJSON(vectorToJSON(v))).toEqual(v);
  });

  it('EvaluationSignal（L1/L2/L3 三层各一）往返一致', () => {
    const signals: EvaluationSignal[] = [
      { layer: 'L1', kind: 'tool_success', target: TARGET, count: 3, window: { from: 0, to: 100 } },
      {
        layer: 'L2',
        kind: 'bench_score',
        target: TARGET,
        value: 0.85,
        sample_size: 30,
        bench_ref: 'bench:1',
      },
      {
        layer: 'L3',
        kind: 'blinded_judge',
        target: TARGET,
        dimension: 'interpretability',
        verdict: 'supported',
        note: 'ok',
      },
    ];
    for (const s of signals) {
      expect(signalFromJSON(signalToJSON(s))).toEqual(s);
    }
  });

  it('非法 JSON / 非法字段拒绝', () => {
    expect(() => vectorFromJSON('not-json')).toThrow();
    expect(() => signalFromJSON('{"layer":"L9"}')).toThrow();
  });
});

describe('④ 区间表达（L2 不确定性：不伪装无参数）', () => {
  it('confidence_interval low ≤ high → 通过', () => {
    const r = CapabilityVectorSchema.safeParse(
      vector({ facts: [fact({ confidence_interval: { low: 0.8, high: 0.9 } })] }),
    );
    expect(r.success).toBe(true);
  });

  it('low = high（点区间）→ 通过', () => {
    const r = CapabilityVectorSchema.safeParse(
      vector({ facts: [fact({ confidence_interval: { low: 0.8, high: 0.8 } })] }),
    );
    expect(r.success).toBe(true);
  });

  it('low > high → 拒绝', () => {
    const r = CapabilityVectorSchema.safeParse(
      vector({ facts: [fact({ confidence_interval: { low: 0.9, high: 0.8 } })] }),
    );
    expect(r.success).toBe(false);
  });

  it('L2 信号同样校验区间（low > high 拒绝）', () => {
    const s = {
      layer: 'L2',
      kind: 'bench_score',
      target: TARGET,
      value: 0.85,
      sample_size: 30,
      bench_ref: 'bench:1',
      confidence_interval: { low: 0.9, high: 0.8 },
    };
    expect(EvaluationSignalSchema.safeParse(s).success).toBe(false);
  });
});

describe('⑤ 三层信号（L1 机械 / L2 统计 / L3 语义）', () => {
  it('L1 构造一例校验通过', () => {
    const s = { layer: 'L1', kind: 'correction', target: TARGET, count: 2, window: { from: 0, to: 100 } };
    const r = EvaluationSignalSchema.safeParse(s);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.layer).toBe('L1');
    }
  });

  it('L2 构造一例校验通过', () => {
    const s = { layer: 'L2', kind: 'latency', target: TARGET, value: 120, sample_size: 50, bench_ref: 'bench:1' };
    expect(EvaluationSignalSchema.safeParse(s).success).toBe(true);
  });

  it('L3 构造一例校验通过', () => {
    const s = { layer: 'L3', kind: 'blinded_judge', target: TARGET, dimension: 'robustness', verdict: 'unresolved' };
    expect(EvaluationSignalSchema.safeParse(s).success).toBe(true);
  });

  it('kind 枚举非法拒绝（L1/L2/L3）', () => {
    expect(
      EvaluationSignalSchema.safeParse({
        layer: 'L1',
        kind: 'banana',
        target: TARGET,
        count: 1,
        window: { from: 0, to: 1 },
      }).success,
    ).toBe(false);
    expect(
      EvaluationSignalSchema.safeParse({ layer: 'L2', kind: 'banana', target: TARGET, value: 1, sample_size: 1, bench_ref: 'b' })
        .success,
    ).toBe(false);
    expect(
      EvaluationSignalSchema.safeParse({ layer: 'L3', kind: 'judge', target: TARGET, dimension: 'cost', verdict: 'supported' })
        .success,
    ).toBe(false);
  });

  it('L1 window from > to → 拒绝', () => {
    const s = { layer: 'L1', kind: 'retry', target: TARGET, count: 1, window: { from: 100, to: 0 } };
    expect(EvaluationSignalSchema.safeParse(s).success).toBe(false);
  });

  it('layer 判别：非法 layer 拒绝', () => {
    const s = { layer: 'L9', kind: 'correction', target: TARGET, count: 1, window: { from: 0, to: 1 } };
    expect(EvaluationSignalSchema.safeParse(s).success).toBe(false);
  });
});

describe('⑥ fromUtilityCounts（M1 Memory.utility_counts 六计数器 → L1 信号，计数映射）', () => {
  const WINDOW = { from: 0, to: 100 };

  it('六计数器 → L1 信号数组（corrections→correction、hits→memory_hit，计数透传）', () => {
    const signals = fromUtilityCounts(
      { tool_calls: 3, retrieval_calls: 1, memory_ops: 2, corrections: 4, reads: 5, hits: 2 },
      TARGET,
      WINDOW,
    );
    expect(signals).toEqual([
      { layer: 'L1', kind: 'correction', target: TARGET, count: 4, window: WINDOW },
      { layer: 'L1', kind: 'memory_hit', target: TARGET, count: 2, window: WINDOW },
    ]);
  });

  it('零计数与未映射计数器不产生信号', () => {
    expect(fromUtilityCounts({ tool_calls: 3, corrections: 0, hits: 0 }, TARGET, WINDOW)).toEqual([]);
    expect(fromUtilityCounts({ tool_calls: 5, retrieval_calls: 2, memory_ops: 1, reads: 9 }, TARGET, WINDOW)).toEqual(
      [],
    );
  });

  it('空计数输入 → 空数组', () => {
    expect(fromUtilityCounts({}, TARGET, WINDOW)).toEqual([]);
  });
});

describe('⑦ 无数据维（value null = 无数据，Unknown 依据）', () => {
  it('value null 合法', () => {
    const r = CapabilityVectorSchema.safeParse(vector({ facts: [fact({ value: null })] }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.facts[0]?.value).toBeNull();
    }
  });

  it('value 缺省非法（value 为必填字段）', () => {
    const f = fact() as Partial<DimensionFact>;
    delete f.value;
    expect(CapabilityVectorSchema.safeParse(vector({ facts: [f as DimensionFact] })).success).toBe(false);
  });
});
