// S2（2026-08-25-verification-contract 第二阶段裁决 S3）：单次结构化 Judge 执行器测试（runtime/judge-executor.ts）。
// 覆盖：
//   ① fake spawnJudge 合法 JSON → 本地校准判定（verdict/confidence/reason）
//   ② 坏输出（不可解析）→ null（降级不抛——债务保留重试）
//   ③ spawnJudge 抛错 → null（降级不抛）
//   ④ 无 spawnJudge → available=false；judge 恒 null（诚实降级）
//   ⑤ spawnJudge 收到完整裁判提示词（含材料/成功标准/JSON-only 指令）与 signal 透传
import { describe, expect, it } from 'vitest';
import { createJudgeExecutor } from '../../runtime/judge-executor.js';
import { buildJudgePrompt } from '../../kernel/structured-judge.js';

const TASK = {
  goal: '验证检索闭环',
  success_criteria: ['标准 1'],
  materials: '材料摘要',
};

describe('① fake spawnJudge 合法 JSON → 判定', () => {
  it('PASS 档（0.8/0.1）→ {verdict:PASS, confidence:high}', async () => {
    const ex = createJudgeExecutor({
      spawnJudge: async () =>
        JSON.stringify({ result_quality: 0.8, evidence_quality: 0.6, process_quality: 0.7, controllability: 'controllable', uncertainty: 0.1 }),
    });
    expect(ex.available).toBe(true);
    const r = await ex.judge(TASK);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('PASS');
    expect(r!.confidence).toBe('high');
    expect(typeof r!.reason).toBe('string');
  });

  it('FAIL 档（0.2/0.2）→ {verdict:FAIL, confidence:high}', async () => {
    const ex = createJudgeExecutor({
      spawnJudge: async () =>
        JSON.stringify({ result_quality: 0.2, evidence_quality: 0.2, process_quality: 0.3, controllability: 'external', uncertainty: 0.2 }),
    });
    expect((await ex.judge(TASK))!.verdict).toBe('FAIL');
  });

  it('UNKNOWN 档（0.5/0.5）→ {verdict:UNKNOWN, confidence:low}', async () => {
    const ex = createJudgeExecutor({
      spawnJudge: async () =>
        JSON.stringify({ result_quality: 0.5, evidence_quality: 0.5, process_quality: 0.5, controllability: 'unknown', uncertainty: 0.5 }),
    });
    const r = await ex.judge(TASK);
    expect(r!.verdict).toBe('UNKNOWN');
    expect(r!.confidence).toBe('low');
  });
});

describe('② 坏输出 → null（降级不抛）', () => {
  it('不可解析文本 → null', async () => {
    const ex = createJudgeExecutor({ spawnJudge: async () => '这不是 JSON 输出' });
    expect(await ex.judge(TASK)).toBeNull();
  });

  it('schema 越界（result_quality 1.5）→ null', async () => {
    const ex = createJudgeExecutor({
      spawnJudge: async () => JSON.stringify({ result_quality: 1.5, evidence_quality: 0.5, process_quality: 0.5, controllability: 'unknown', uncertainty: 0.5 }),
    });
    expect(await ex.judge(TASK)).toBeNull();
  });
});

describe('③ spawnJudge 抛错 → null（降级不抛）', () => {
  it('spawn 抛错（宿主异常/超时）→ null', async () => {
    const ex = createJudgeExecutor({
      spawnJudge: async () => {
        throw new Error('subagents spawn failed');
      },
    });
    expect(await ex.judge(TASK)).toBeNull();
  });
});

describe('④ 无 spawnJudge → available=false；judge 恒 null', () => {
  it('未注入 → available=false；judge 返回 null（不调用）', async () => {
    const ex = createJudgeExecutor({});
    expect(ex.available).toBe(false);
    expect(await ex.judge(TASK)).toBeNull();
  });
});

describe('⑤ 提示词与 signal 透传', () => {
  it('spawnJudge 收到完整裁判提示词（buildJudgePrompt 产物）', async () => {
    let received = '';
    const ex = createJudgeExecutor({
      spawnJudge: async (prompt) => {
        received = prompt;
        return JSON.stringify({ result_quality: 0.8, evidence_quality: 0.5, process_quality: 0.5, controllability: 'unknown', uncertainty: 0.1 });
      },
    });
    await ex.judge(TASK);
    expect(received).toBe(buildJudgePrompt(TASK));
    expect(received).toContain('材料摘要');
    expect(received).toContain('标准 1');
    expect(received).toContain('只输出一个 JSON 对象');
  });

  it('signal 透传（spawnJudge 收到 AbortSignal）', async () => {
    const ac = new AbortController();
    let gotSignal: AbortSignal | undefined;
    const ex = createJudgeExecutor({
      spawnJudge: async (_prompt, signal) => {
        gotSignal = signal;
        return JSON.stringify({ result_quality: 0.8, evidence_quality: 0.5, process_quality: 0.5, controllability: 'unknown', uncertainty: 0.1 });
      },
    });
    await ex.judge(TASK, ac.signal);
    expect(gotSignal).toBe(ac.signal);
  });
});
