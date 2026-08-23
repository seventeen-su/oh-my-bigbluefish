// kernel/bench-tasks/reference/sys-01.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.1）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机、只 import 类型）。
import type { InputArtifactV2 } from '../../schemas/bench.js';

/** sys-01 reference：文件系统变更规格 → 前后状态断言 { before, after }。
 *  operation=create 表示目标文件当前不存在（before 对应路径 = null），执行后创建并写入 content（after 对应路径 = 内容）。 */
export function reference(input: InputArtifactV2[]): unknown {
  const artifact = input.find((a) => a.name === 'changes');
  if (artifact === undefined) {
    throw new Error('sys-01 reference: 缺少 changes 输入工件');
  }
  const spec = artifact.content;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('sys-01 reference: changes 输入工件 content 必须为对象');
  }
  const record = spec as Record<string, unknown>;
  if (record.operation !== 'create') {
    throw new Error(`sys-01 reference: 不支持的 operation ${String(record.operation)}（仅 create）`);
  }
  const path = typeof record.path === 'string' ? record.path : '';
  const content = typeof record.content === 'string' ? record.content : '';
  if (path.length === 0) {
    throw new Error('sys-01 reference: changes.path 缺失或非字符串');
  }
  return {
    before: { [path]: null },
    after: { [path]: content },
  };
}
