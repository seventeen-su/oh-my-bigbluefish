// kernel/bench-tasks/reference/research-02.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// research-02：方案比较规范答案 { answer: string }，覆盖 rubric.required_terms（方案A/方案B/取舍）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { assertRubricCovered, findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const task = requireRecord(
    findArtifact(input, 'task').content,
    'research-02 reference: task 输入工件 content 必须为对象',
  );
  const answer =
    '方案A 与方案B 各有侧重：方案A 成本更低，方案B 可靠性更高；综合对比后给出取舍结论——优先选择方案A。';
  assertRubricCovered(task, answer, 'research-02');
  return { answer };
}
