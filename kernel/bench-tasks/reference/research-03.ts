// kernel/bench-tasks/reference/research-03.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// research-03：架构问答规范答案 { answer: string }，覆盖 rubric.required_terms（SQLite/FTS5）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { assertRubricCovered, findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const task = requireRecord(
    findArtifact(input, 'task').content,
    'research-03 reference: task 输入工件 content 必须为对象',
  );
  const answer =
    'OMB v2 的记忆存储默认后端采用 SQLite（WAL 模式单写者），全文检索方案采用 FTS5（BM25 相关性排序）。';
  assertRubricCovered(task, answer, 'research-03');
  return { answer };
}
