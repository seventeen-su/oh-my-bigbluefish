// layer 2（kernel/）：S2 单次结构化 LLM Judge（SAJA 式——用户裁决 2026-08-25 第二阶段 S3 替代方案）。
// 语义（裁决 S3）：**一次调用 + 结构化多维评分 + 本地校准**（SAJA 式：单次输出多维特征 → 本地阈值
//   校准）——不做多轮 Judge 投票；双模型共识只用于低频高风险（本阶段不实现）。
// 结构化输出 {result_quality, evidence_quality, process_quality, controllability, uncertainty}
//   → 本地阈值校准为 PASS/FAIL/UNKNOWN + high/low 置信；UNKNOWN 是合法终态（阶梯式验证，不强迫 LLM 猜）。
// 零 I/O、零副作用、零随机：同输入 → 同输出（测试锚定）；唯一非确定性面 = 调用方注入的 spawn（外部）。
// 层 DAG：kernel 纯函数（layer 2）→ kernel/controllability（layer 2，枚举复用）✓；消费方 =
//   runtime/judge-executor.ts（layer 2 执行器）。
import { z } from 'zod';
import { CONTROLLABILITY_VALUES } from './controllability.js';

// ---- 结构化输出 schema（裁决 S3：一次调用产出多维特征） ----

/** Judge 结构化输出（SAJA 式多维特征；0~1 语义见 buildJudgePrompt 输出要求） */
export const JudgeOutputSchema = z.object({
  /** 结果质量（0~1：结果达成成功标准的程度） */
  result_quality: z.number().min(0).max(1),
  /** 证据质量（0~1：材料中证据的充分程度） */
  evidence_quality: z.number().min(0).max(1),
  /** 过程质量（0~1：执行过程的质量） */
  process_quality: z.number().min(0).max(1),
  /** 可控性（分类枚举——与 kernel/controllability 同源） */
  controllability: z.enum(CONTROLLABILITY_VALUES),
  /** 不确定性（0~1：裁判自身的不确定程度——本地校准的阈值输入） */
  uncertainty: z.number().min(0).max(1),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/** 单次裁判任务（goal + 成功标准 + 材料摘要——均来自验证债务记录/调用方注入） */
export interface JudgeTask {
  goal: string;
  success_criteria: string[];
  materials: string;
}

/**
 * 中文裁判提示词（空白子代理同模型单次裁判——用户 2026-08-25 裁决）：
 * 独立验证裁判（空白上下文）+ 材料摘要 + 成功标准逐条 + **只输出一个 JSON 对象**
 * （schema 字段与 0~1 语义说明），不调用工具、不输出其它内容。
 * 确定性纯函数：同 task → 同提示词文本。
 */
export function buildJudgePrompt(task: JudgeTask): string {
  const criteria = task.success_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') || '（无成功标准）';
  return [
    '你是独立验证裁判（空白上下文——不带任何任务历史、偏好或先验结论）。',
    '请根据下面的执行材料摘要与成功标准，对一次任务执行做出独立判定。',
    '',
    '【任务目标】',
    task.goal,
    '',
    '【成功标准】（逐条对照）',
    criteria,
    '',
    '【执行材料摘要】',
    task.materials,
    '',
    '【输出要求】',
    '只输出一个 JSON 对象。不要输出任何其它内容，不调用工具，不解释。',
    'JSON 字段与语义（全部必填）：',
    '- result_quality: 0~1 数字——结果达成成功标准的程度（1=完全达成，0=完全未达成）；',
    '- evidence_quality: 0~1 数字——材料中证据的充分程度（1=证据充分，0=无证据）；',
    '- process_quality: 0~1 数字——执行过程的质量（1=过程良好，0=过程糟糕）；',
    '- controllability: 字符串枚举——controllable | partially_controllable | external | unknown（失败是否可控）；',
    '- uncertainty: 0~1 数字——你对上述判定的不确定程度（1=极不确定，0=完全确定）。',
  ].join('\n');
}

/**
 * 容错提取（首个 { 到末个 }，剥 ```json 围栏）→ safeParse → 失败 null。
 * 确定性纯函数：同 raw → 同结果（null 表示不可解析/不合规——调用方降级，不抛）。
 */
export function parseJudgeOutput(raw: string): JudgeOutput | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  let body = raw.trim();
  // 剥 ```json 围栏（若整体被围栏包裹）
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null; // 无 JSON 对象轮廓
  }
  const slice = body.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null; // JSON 语法错误
  }
  const result = JudgeOutputSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * 本地阈值校准（SAJA 式——单次输出 → 本地阈值定档，不做多轮投票）：
 *   result_quality >= 0.7 且 uncertainty <= 0.3 → PASS/high（结果明确达成且裁判确定）；
 *   result_quality <= 0.3 且 uncertainty <= 0.3 → FAIL/high（结果明确未达成且裁判确定）；
 *   其余 → UNKNOWN/low（中间带/裁判不确定——UNKNOWN 是合法终态，不强迫 LLM 猜）。
 * 确定性纯函数：同 out → 同校准结果。
 */
export function calibrateJudgeOutput(out: JudgeOutput): {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  confidence: 'high' | 'low';
  reason: string;
} {
  if (out.result_quality >= 0.7 && out.uncertainty <= 0.3) {
    return {
      verdict: 'PASS',
      confidence: 'high',
      reason: `本地校准：result_quality=${out.result_quality}≥0.7 且 uncertainty=${out.uncertainty}≤0.3 → PASS/high`,
    };
  }
  if (out.result_quality <= 0.3 && out.uncertainty <= 0.3) {
    return {
      verdict: 'FAIL',
      confidence: 'high',
      reason: `本地校准：result_quality=${out.result_quality}≤0.3 且 uncertainty=${out.uncertainty}≤0.3 → FAIL/high`,
    };
  }
  return {
    verdict: 'UNKNOWN',
    confidence: 'low',
    reason:
      `本地校准：result_quality=${out.result_quality} 处于中间带或 uncertainty=${out.uncertainty}>0.3 → ` +
      'UNKNOWN/low（合法终态——不强迫裁判猜测）',
  };
}
