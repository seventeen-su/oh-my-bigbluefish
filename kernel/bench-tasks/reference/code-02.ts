// kernel/bench-tasks/reference/code-02.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// code-02：isPalindrome(s) 参考解（忽略大小写与非字母数字字符）+ 静态推演 test-cases → { passed, failed, total }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, runTestCases } from './_helpers.js';

/** isPalindrome 参考解：小写化并去除非字母数字字符后两端比较 */
function isPalindrome(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  let left = 0;
  let right = normalized.length - 1;
  while (left < right) {
    if (normalized[left] !== normalized[right]) {
      return false;
    }
    left++;
    right--;
  }
  return true;
}

export function reference(input: InputArtifactV2[]): unknown {
  const cases = findArtifact(input, 'test-cases');
  const language = findArtifact(input, 'language');
  if (typeof language.content !== 'string' || language.content.length === 0) {
    throw new Error('code-02 reference: language 输入工件 content 必须为非空字符串');
  }
  return runTestCases(cases.content, (value) => {
    if (typeof value !== 'string') {
      throw new Error('code-02 reference: 用例 input 必须为字符串（isPalindrome 的 s）');
    }
    return isPalindrome(value);
  });
}
