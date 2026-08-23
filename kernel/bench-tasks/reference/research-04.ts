// kernel/bench-tasks/reference/research-04.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// research-04：风险清单规范答案 { answer: string }，覆盖 rubric.required_terms（性能/安全/维护）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { assertRubricCovered, findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const task = requireRecord(
    findArtifact(input, 'task').content,
    'research-04 reference: task 输入工件 content 必须为对象',
  );
  const answer =
    '该技术方案的主要风险覆盖三个维度：性能（高并发下延迟与吞吐瓶颈）、安全（输入校验与权限边界）、维护（模块耦合与升级成本）。';
  assertRubricCovered(task, answer, 'research-04');
  return { answer };
}
