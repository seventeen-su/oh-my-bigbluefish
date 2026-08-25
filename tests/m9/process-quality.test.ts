// S2（2026-08-25-verification-contract 第二阶段裁决 S2/S7）：机械过程质量向量测试（kernel/process-quality.ts）。
// 覆盖：
//   ① 向量各字段边界：decision_made（false/true）/ claims_count（0/3/5/10 饱和）/ degradations（0/2/5/8
//      clamp）/ corrections（0/1/3/6 clamp）/ tool_calls（0/10/40/1000 递减）
//   ② normalizeProcessQuality：权重和 = 1（占位常量 §17 观测标定）/ 加权和（progress+evidence → 0.50）/
//      边界 clamp（权重注入超界 → [0,1]）/ 全 1 → 1.00、全 0 → 0.00
//   ③ 确定性：同输入同输出（deep equal + JSON 相等）
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_WEIGHTS,
  PROCESS_QUALITY_VECTOR_KEYS,
  normalizeProcessQuality,
  qualityVectorFromSignals,
  type ProcessQualityVector,
} from '../../kernel/process-quality.js';

describe('① 质量向量字段边界（qualityVectorFromSignals）', () => {
  it('progress_gain：decision_made=false → 0；true → 1（二元信号，诚实不细分）', () => {
    expect(qualityVectorFromSignals({ decision_made: false, claims_count: 0, tool_calls: 0, corrections: 0, degradations: 0 }).progress_gain).toBe(0);
    expect(qualityVectorFromSignals({ decision_made: true, claims_count: 0, tool_calls: 0, corrections: 0, degradations: 0 }).progress_gain).toBe(1);
  });

  it('evidence_gain：claims_count 0 → 0；3 → 0.6；5 → 1（饱和）；10 → 1（clamp）', () => {
    const base = { decision_made: true, tool_calls: 0, corrections: 0, degradations: 0 };
    expect(qualityVectorFromSignals({ ...base, claims_count: 0 }).evidence_gain).toBe(0);
    expect(qualityVectorFromSignals({ ...base, claims_count: 3 }).evidence_gain).toBeCloseTo(0.6, 10);
    expect(qualityVectorFromSignals({ ...base, claims_count: 5 }).evidence_gain).toBe(1);
    expect(qualityVectorFromSignals({ ...base, claims_count: 10 }).evidence_gain).toBe(1);
  });

  it('recovery：degradations 0 → 1；2 → 0.6；5 → 0；8 → 0（clamp——无恢复计数面，以降级数近似成功恢复）', () => {
    const base = { decision_made: true, claims_count: 0, tool_calls: 0, corrections: 0 };
    expect(qualityVectorFromSignals({ ...base, degradations: 0 }).recovery).toBe(1);
    expect(qualityVectorFromSignals({ ...base, degradations: 2 }).recovery).toBeCloseTo(0.6, 10);
    expect(qualityVectorFromSignals({ ...base, degradations: 5 }).recovery).toBe(0);
    expect(qualityVectorFromSignals({ ...base, degradations: 8 }).recovery).toBe(0);
  });

  it('redundancy：corrections 0 → 1；1 → 2/3；3 → 0；6 → 0（clamp——以纠正数近似冗余度）', () => {
    const base = { decision_made: true, claims_count: 0, tool_calls: 0, degradations: 0 };
    expect(qualityVectorFromSignals({ ...base, corrections: 0 }).redundancy).toBe(1);
    expect(qualityVectorFromSignals({ ...base, corrections: 1 }).redundancy).toBeCloseTo(2 / 3, 10);
    expect(qualityVectorFromSignals({ ...base, corrections: 3 }).redundancy).toBe(0);
    expect(qualityVectorFromSignals({ ...base, corrections: 6 }).redundancy).toBe(0);
  });

  it('tool_efficiency：tool_calls 0 → 1（满分）；10 → 0.5；40 → 0.2；1000 → 1/101（边际递减）', () => {
    const base = { decision_made: true, claims_count: 0, corrections: 0, degradations: 0 };
    expect(qualityVectorFromSignals({ ...base, tool_calls: 0 }).tool_efficiency).toBe(1);
    expect(qualityVectorFromSignals({ ...base, tool_calls: 10 }).tool_efficiency).toBe(0.5);
    expect(qualityVectorFromSignals({ ...base, tool_calls: 40 }).tool_efficiency).toBe(0.2);
    expect(qualityVectorFromSignals({ ...base, tool_calls: 1000 }).tool_efficiency).toBeCloseTo(1 / 101, 10);
  });

  it('branch_efficiency：恒 0.5（无分支数据——中性占位，不假装精确）', () => {
    expect(
      qualityVectorFromSignals({ decision_made: true, claims_count: 0, tool_calls: 0, corrections: 0, degradations: 0 }).branch_efficiency,
    ).toBe(0.5);
  });

  it('向量键序与定义一致（PROCESS_QUALITY_VECTOR_KEYS 穷举 Record 键）', () => {
    const v = qualityVectorFromSignals({ decision_made: true, claims_count: 1, tool_calls: 1, corrections: 1, degradations: 1 });
    for (const key of PROCESS_QUALITY_VECTOR_KEYS) {
      expect(typeof v[key]).toBe('number');
    }
    expect(Object.keys(v).sort()).toEqual([...PROCESS_QUALITY_VECTOR_KEYS].sort());
  });
});

describe('② normalizeProcessQuality（加权和 → clamp [0,1] → 保留两位）', () => {
  it('权重和 = 1.0（占位常量 §17 观测标定）', () => {
    const total = PROCESS_QUALITY_VECTOR_KEYS.reduce((acc, k) => acc + DEFAULT_QUALITY_WEIGHTS[k]!, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('全 1 向量 → 1.00；全 0 向量 → 0.00', () => {
    const ones: ProcessQualityVector = {
      progress_gain: 1, evidence_gain: 1, recovery: 1, redundancy: 1, tool_efficiency: 1, branch_efficiency: 1,
    };
    const zeros: ProcessQualityVector = {
      progress_gain: 0, evidence_gain: 0, recovery: 0, redundancy: 0, tool_efficiency: 0, branch_efficiency: 0,
    };
    expect(normalizeProcessQuality(ones)).toBe(1);
    expect(normalizeProcessQuality(zeros)).toBe(0);
  });

  it('加权和：progress+evidence 满值（其余 0）→ 0.3+0.2 = 0.50', () => {
    const v: ProcessQualityVector = {
      progress_gain: 1, evidence_gain: 1, recovery: 0, redundancy: 0, tool_efficiency: 0, branch_efficiency: 0,
    };
    expect(normalizeProcessQuality(v)).toBe(0.5);
  });

  it('边界 clamp：权重注入超界 → [0,1]（progress_gain 权重 2 → 2 钳到 1.00；-1 → 0.00）', () => {
    const v: ProcessQualityVector = {
      progress_gain: 1, evidence_gain: 0, recovery: 0, redundancy: 0, tool_efficiency: 0, branch_efficiency: 0,
    };
    const heavy: ProcessQualityVector = { progress_gain: 2, evidence_gain: 0, recovery: 0, redundancy: 0, tool_efficiency: 0, branch_efficiency: 0 };
    const negative: ProcessQualityVector = { progress_gain: -1, evidence_gain: 0, recovery: 0, redundancy: 0, tool_efficiency: 0, branch_efficiency: 0 };
    expect(normalizeProcessQuality(v, heavy)).toBe(1);
    expect(normalizeProcessQuality(v, negative)).toBe(0);
  });

  it('保留两位：0.65 精确档（0.3+0.2+0.15）', () => {
    const v: ProcessQualityVector = {
      progress_gain: 1, evidence_gain: 0, recovery: 1, redundancy: 0, tool_efficiency: 1, branch_efficiency: 0,
    };
    expect(normalizeProcessQuality(v)).toBe(0.65);
  });
});

describe('③ 确定性', () => {
  it('同输入同输出（deep equal + JSON 相等）', () => {
    const input = { decision_made: true, claims_count: 4, tool_calls: 12, corrections: 2, degradations: 3 };
    const v1 = qualityVectorFromSignals(input);
    const v2 = qualityVectorFromSignals(input);
    expect(v1).toEqual(v2);
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
    expect(normalizeProcessQuality(v1)).toBe(normalizeProcessQuality(v2));
  });
});
