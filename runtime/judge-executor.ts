// layer 2（runtime/）：单次结构化 Judge 执行器（S2——用户 2026-08-25 第二阶段裁决 S3/P2.5 替代）。
// 语义（裁决 S2）：空白子代理同模型单次裁判——spawn provider 全新会话（无上下文）、toolFilter: [] 纯文本
//   裁判（装配面注入 spawnJudge）；仅验证债务路径触发、正常任务 0 额外成本。SAJA 式：单次输出多维特征
//   → 本地阈值校准（kernel/structured-judge.ts 纯函数），不做多轮投票。
// 降级语义：无 spawnJudge → available=false（judge 恒 null——调用方诚实降级）；spawn 抛错 / 输出不可解析
//   → judge 返回 null（不向外抛——债务保留重试，不污染调用方）。
// 层 DAG：runtime(2) → kernel(2)（structured-judge 纯函数）✓；消费方 = runtime/assembly.ts（runVerificationReview）
//   与 runtime/plugin.ts（装配面注入 spawnJudge）。
import { buildJudgePrompt, calibrateJudgeOutput, parseJudgeOutput, type JudgeTask } from '../kernel/structured-judge.js';

/** 单次裁判结果（本地校准产物：三态 + 置信 + 中文理由） */
export interface JudgeVerdict {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  confidence: 'high' | 'low';
  reason: string;
}

/** 空白子代理 spawn 接口（宿主形状以实际为准——装配面注入；prompt 为完整裁判提示词文本） */
export type SpawnJudge = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Judge 执行器（available=false → judge 恒 null——诚实降级） */
export interface JudgeExecutor {
  /** 是否可用（spawnJudge 已注入） */
  available: boolean;
  /**
   * 单次裁判：buildJudgePrompt → spawnJudge(prompt, signal) → parseJudgeOutput → 本地校准。
   * 失败/抛错/不可解析 → null（降级，不向外抛——债务保留重试）。success → 校准产物。
   */
  judge(task: JudgeTask, signal?: AbortSignal): Promise<JudgeVerdict | null>;
}

/**
 * 执行器工厂：opts.spawnJudge 缺省 → available=false（judge 恒 null——未装配 = 诚实不可用，
 * 消费方（runVerificationReview）按不可用转人工复核，不假装判定）。
 */
export function createJudgeExecutor(opts: { spawnJudge?: SpawnJudge }): JudgeExecutor {
  const available = typeof opts.spawnJudge === 'function';
  return {
    available,
    async judge(task: JudgeTask, signal?: AbortSignal): Promise<JudgeVerdict | null> {
      if (!available) {
        return null; // 未装配 → 降级（不调用）
      }
      try {
        const prompt = buildJudgePrompt(task);
        const raw = await opts.spawnJudge!(prompt, signal);
        const parsed = parseJudgeOutput(raw);
        if (parsed === null) {
          return null; // 输出不可解析/不合规 → 降级（不抛）
        }
        return calibrateJudgeOutput(parsed);
      } catch {
        return null; // spawn 抛错（超时/中断/宿主异常）→ 降级（不向外抛）
      }
    },
  };
}
