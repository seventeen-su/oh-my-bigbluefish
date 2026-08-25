// S2（2026-08-25-verification-contract 第二阶段裁决 S3）：单次结构化 Judge 纯函数测试（kernel/structured-judge.ts）。
// 覆盖：
//   ① buildJudgePrompt：含裁判身份/材料摘要/成功标准逐条/JSON-only 指令（只输出一个 JSON 对象、
//      不调用工具）/schema 字段 0~1 语义说明
//   ② parseJudgeOutput 容错：干净 JSON / ```json 围栏 / 前后缀杂文（首个 { 到末个 }）/ 坏 JSON →
//      null / 无轮廓 → null / schema 越界 → null
//   ③ calibrateJudgeOutput 阈值矩阵：0.8/0.1 → PASS high；0.2/0.2 → FAIL high；0.5/0.5 → UNKNOWN low；
//      0.7/0.4 → UNKNOWN（uncertainty 超限）；边界 0.7/0.3 → PASS、0.3/0.3 → FAIL
//   ④ 确定性：同输入同输出
import { describe, expect, it } from 'vitest';
import {
  JudgeOutputSchema,
  buildJudgePrompt,
  calibrateJudgeOutput,
  parseJudgeOutput,
  type JudgeOutput,
} from '../../kernel/structured-judge.js';

/** 构造合法 JudgeOutput（over 覆写被测字段） */
function out(over: Partial<JudgeOutput> = {}): JudgeOutput {
  return {
    result_quality: 0.5,
    evidence_quality: 0.5,
    process_quality: 0.5,
    controllability: 'unknown',
    uncertainty: 0.5,
    ...over,
  };
}

const TASK = {
  goal: '验证检索闭环',
  success_criteria: ['标准 1：检索命中', '标准 2：结果稳定'],
  materials: '材料摘要：两次检索 top-5 一致',
};

describe('① buildJudgePrompt（中文裁判提示词）', () => {
  it('含裁判身份（独立验证裁判/空白上下文）', () => {
    const p = buildJudgePrompt(TASK);
    expect(p).toContain('独立验证裁判');
    expect(p).toContain('空白上下文');
  });

  it('含材料摘要 + 成功标准逐条', () => {
    const p = buildJudgePrompt(TASK);
    expect(p).toContain(TASK.materials);
    expect(p).toContain('1. 标准 1：检索命中');
    expect(p).toContain('2. 标准 2：结果稳定');
  });

  it('含 JSON-only 指令（只输出一个 JSON 对象/不调用工具）', () => {
    const p = buildJudgePrompt(TASK);
    expect(p).toContain('只输出一个 JSON 对象');
    expect(p).toContain('不调用工具');
  });

  it('含 schema 字段与 0~1 语义说明（result_quality/evidence_quality/process_quality/controllability/uncertainty）', () => {
    const p = buildJudgePrompt(TASK);
    for (const field of ['result_quality', 'evidence_quality', 'process_quality', 'controllability', 'uncertainty']) {
      expect(p).toContain(field);
    }
    expect(p).toContain('controllable | partially_controllable | external | unknown');
  });

  it('确定性：同 task 同提示词文本', () => {
    expect(buildJudgePrompt(TASK)).toBe(buildJudgePrompt(TASK));
  });
});

describe('② parseJudgeOutput 容错提取', () => {
  it('干净 JSON → 解析成功（全字段）', () => {
    const raw = JSON.stringify(out({ result_quality: 0.8, uncertainty: 0.1 }));
    const parsed = parseJudgeOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.result_quality).toBe(0.8);
    expect(parsed!.uncertainty).toBe(0.1);
    expect(parsed!.controllability).toBe('unknown');
  });

  it('```json 围栏包裹 → 解析成功', () => {
    const raw = '```json\n' + JSON.stringify(out()) + '\n```';
    expect(parseJudgeOutput(raw)).not.toBeNull();
  });

  it('前后缀杂文（首个 { 到末个 } 提取）→ 解析成功', () => {
    const raw = `好的，这是判定：\n${JSON.stringify(out({ result_quality: 0.9 }))}\n以上是我的结论。`;
    const parsed = parseJudgeOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.result_quality).toBe(0.9);
  });

  it('坏 JSON（语法错误）→ null', () => {
    expect(parseJudgeOutput('{result_quality: 0.8,}')).toBeNull();
  });

  it('无 JSON 对象轮廓（无 { 或 }）→ null；空串 → null', () => {
    expect(parseJudgeOutput('')).toBeNull();
    expect(parseJudgeOutput('没有 JSON')).toBeNull();
    expect(parseJudgeOutput('{')).toBeNull();
  });

  it('schema 越界（result_quality 1.5）→ null（fail-loud 不合规输出不进入校准）', () => {
    expect(parseJudgeOutput(JSON.stringify(out({ result_quality: 1.5 })))).toBeNull();
  });

  it('controllability 非法枚举 → null', () => {
    expect(
      parseJudgeOutput(JSON.stringify({ ...out(), controllability: 'maybe' })),
    ).toBeNull();
  });

  it('确定性：同 raw 同结果', () => {
    const raw = JSON.stringify(out());
    expect(parseJudgeOutput(raw)).toEqual(parseJudgeOutput(raw));
  });
});

describe('③ calibrateJudgeOutput 阈值矩阵（SAJA 式本地校准）', () => {
  it('0.8/0.1 → PASS/high（result_quality≥0.7 且 uncertainty≤0.3）', () => {
    const r = calibrateJudgeOutput(out({ result_quality: 0.8, uncertainty: 0.1 }));
    expect(r.verdict).toBe('PASS');
    expect(r.confidence).toBe('high');
    expect(typeof r.reason).toBe('string');
  });

  it('0.2/0.2 → FAIL/high（result_quality≤0.3 且 uncertainty≤0.3）', () => {
    const r = calibrateJudgeOutput(out({ result_quality: 0.2, uncertainty: 0.2 }));
    expect(r.verdict).toBe('FAIL');
    expect(r.confidence).toBe('high');
  });

  it('0.5/0.5 → UNKNOWN/low（中间带 + 裁判不确定——合法终态不强迫猜）', () => {
    const r = calibrateJudgeOutput(out({ result_quality: 0.5, uncertainty: 0.5 }));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.confidence).toBe('low');
  });

  it('0.7/0.4 → UNKNOWN（result_quality 达标但 uncertainty 超限——低置信不裁决）', () => {
    const r = calibrateJudgeOutput(out({ result_quality: 0.7, uncertainty: 0.4 }));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.confidence).toBe('low');
  });

  it('边界：0.7/0.3 → PASS/high；0.3/0.3 → FAIL/high（含等号）', () => {
    expect(calibrateJudgeOutput(out({ result_quality: 0.7, uncertainty: 0.3 })).verdict).toBe('PASS');
    expect(calibrateJudgeOutput(out({ result_quality: 0.3, uncertainty: 0.3 })).verdict).toBe('FAIL');
  });

  it('确定性：同 out 同校准结果', () => {
    const o = out({ result_quality: 0.8, uncertainty: 0.1 });
    expect(calibrateJudgeOutput(o)).toEqual(calibrateJudgeOutput(o));
  });
});

describe('④ schema 形状（JudgeOutputSchema）', () => {
  it('五字段全部 0~1 数字 + controllability 枚举', () => {
    expect(JudgeOutputSchema.safeParse(out()).success).toBe(true);
    expect(JudgeOutputSchema.safeParse(out({ result_quality: -0.1 })).success).toBe(false);
    expect(JudgeOutputSchema.safeParse(out({ uncertainty: 1.1 })).success).toBe(false);
  });
});
