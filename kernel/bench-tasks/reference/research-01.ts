// kernel/bench-tasks/reference/research-01.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// research-01：文档总结规范答案 { answer: string }，覆盖 rubric.required_terms（动机/方法/结论）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { assertRubricCovered, findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const task = requireRecord(
    findArtifact(input, 'task').content,
    'research-01 reference: task 输入工件 content 必须为对象',
  );
  const answer =
    '该文档依次阐述了研究动机、方法设计与结论：动机源于现有方案覆盖不足，方法采用模块化架构与分层实现，结论通过基准验证了可行性。';
  assertRubricCovered(task, answer, 'research-01');
  return { answer };
}
