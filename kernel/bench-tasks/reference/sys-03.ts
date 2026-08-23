// kernel/bench-tasks/reference/sys-03.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// sys-03：删除文件变更规格 → 前后状态断言 { before, after }（目标路径 exists → absent）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const changes = requireRecord(
    findArtifact(input, 'changes').content,
    'sys-03 reference: changes 输入工件 content 必须为对象',
  );
  if (changes.operation !== 'delete') {
    throw new Error(`sys-03 reference: 不支持的 operation ${String(changes.operation)}（仅 delete）`);
  }
  const path = changes.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('sys-03 reference: changes.path 必须为非空字符串');
  }
  return {
    before: { [path]: 'exists' },
    after: { [path]: 'absent' },
  };
}
