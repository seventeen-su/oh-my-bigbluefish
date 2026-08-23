// kernel/bench-tasks/reference/code-01.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// code-01：fib(n) 参考解（迭代，n ≤ 40 不爆栈）+ 静态推演 test-cases → { passed, failed, total }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, runTestCases } from './_helpers.js';

/** fib 参考解：迭代实现，fib(0)=0，fib(1)=1 */
function fib(n: number): number {
  if (n < 0) {
    throw new Error('code-01 reference: n 必须 ≥ 0');
  }
  if (n <= 1) {
    return n;
  }
  let prev = 0;
  let curr = 1;
  for (let i = 2; i <= n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}

export function reference(input: InputArtifactV2[]): unknown {
  const cases = findArtifact(input, 'test-cases');
  const language = findArtifact(input, 'language');
  if (typeof language.content !== 'string' || language.content.length === 0) {
    throw new Error('code-01 reference: language 输入工件 content 必须为非空字符串');
  }
  return runTestCases(cases.content, (value) => {
    if (typeof value !== 'number') {
      throw new Error('code-01 reference: 用例 input 必须为数字（fib 的 n）');
    }
    return fib(value);
  });
}
