// kernel/bench-tasks/reference/code-03.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// code-03：fizzbuzz(n) 参考解（1..n，3→Fizz / 5→Buzz / 15→FizzBuzz）+ 静态推演 test-cases → { passed, failed, total }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, runTestCases } from './_helpers.js';

/** fizzbuzz 参考解：返回 1..n 的字符串数组（3/5/15 倍数替换） */
function fizzbuzz(n: number): string[] {
  if (n < 1) {
    throw new Error('code-03 reference: n 必须 ≥ 1');
  }
  const result: string[] = [];
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) {
      result.push('FizzBuzz');
    } else if (i % 3 === 0) {
      result.push('Fizz');
    } else if (i % 5 === 0) {
      result.push('Buzz');
    } else {
      result.push(String(i));
    }
  }
  return result;
}

export function reference(input: InputArtifactV2[]): unknown {
  const cases = findArtifact(input, 'test-cases');
  const language = findArtifact(input, 'language');
  if (typeof language.content !== 'string' || language.content.length === 0) {
    throw new Error('code-03 reference: language 输入工件 content 必须为非空字符串');
  }
  return runTestCases(cases.content, (value) => {
    if (typeof value !== 'number') {
      throw new Error('code-03 reference: 用例 input 必须为数字（fizzbuzz 的 n）');
    }
    return fizzbuzz(value);
  });
}
