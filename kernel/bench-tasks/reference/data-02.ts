// kernel/bench-tasks/reference/data-02.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// data-02：CSV 文本 → { rows: [{ id, name, price }] }（首行表头、字段均为字符串、空行忽略）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const csv = findArtifact(input, 'csv');
  if (typeof csv.content !== 'string') {
    throw new Error('data-02 reference: csv 输入工件 content 必须为字符串');
  }
  // 按行拆分；空行（trim 后为空，含结尾换行产生的空段）忽略
  const nonEmpty = csv.content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmpty.length === 0) {
    throw new Error('data-02 reference: CSV 无数据行');
  }
  const header = nonEmpty[0]!.split(',').map((cell) => cell.trim());
  const rows = nonEmpty.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const record: Record<string, string> = {};
    header.forEach((field, index) => {
      record[field] = cells[index] ?? '';
    });
    return record;
  });
  return { rows };
}
