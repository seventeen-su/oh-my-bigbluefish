// kernel/bench-tasks/reference/data-01.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.1）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机、只 import 类型）。
// 与 v1 的差别：expected 由本函数生成，而非从 v1 录制 expected 反推 input（防 ground truth 循环依赖）。
import type { InputArtifactV2 } from '../../schemas/bench.js';

/** data-01 reference：用户记录数组 → 规范化输出 { users: [{ id, name, email }] }。
 *  去除缺 id 或 email 的无效行；保留行字段顺序固定为 id/name/email。 */
export function reference(input: InputArtifactV2[]): unknown {
  const artifact = input.find((a) => a.name === 'users');
  if (artifact === undefined) {
    throw new Error('data-01 reference: 缺少 users 输入工件');
  }
  const rows = artifact.content;
  if (!Array.isArray(rows)) {
    throw new Error('data-01 reference: users 输入工件 content 必须为数组');
  }
  const valid = rows.filter((row): boolean => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return false;
    }
    const record = row as Record<string, unknown>;
    return (
      typeof record.id === 'string' &&
      (record.id as string).length > 0 &&
      typeof record.email === 'string' &&
      (record.email as string).length > 0
    );
  });
  return {
    users: valid.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: record.id as string,
        name: typeof record.name === 'string' ? (record.name as string) : '',
        email: record.email as string,
      };
    }),
  };
}
