// kernel/bench-tasks/reference/code-04.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// code-04：deepClone(obj) 参考解（复用 _helpers.deepClone，JSON 兼容深拷贝）+ 静态推演 test-cases → { passed, failed, total }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { deepClone, findArtifact, runTestCases } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const cases = findArtifact(input, 'test-cases');
  const language = findArtifact(input, 'language');
  if (typeof language.content !== 'string' || language.content.length === 0) {
    throw new Error('code-04 reference: language 输入工件 content 必须为非空字符串');
  }
  return runTestCases(cases.content, (value) => deepClone(value));
}
