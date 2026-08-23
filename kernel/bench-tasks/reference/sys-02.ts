// kernel/bench-tasks/reference/sys-02.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// sys-02：启动服务变更规格 → 前后状态断言 { before, after }（服务状态 from_status → to_status，键形如 '<service>.status'）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const changes = requireRecord(
    findArtifact(input, 'changes').content,
    'sys-02 reference: changes 输入工件 content 必须为对象',
  );
  if (changes.operation !== 'start') {
    throw new Error(`sys-02 reference: 不支持的 operation ${String(changes.operation)}（仅 start）`);
  }
  const service = changes.service;
  const fromStatus = changes.from_status;
  const toStatus = changes.to_status;
  if (typeof service !== 'string' || typeof fromStatus !== 'string' || typeof toStatus !== 'string') {
    throw new Error('sys-02 reference: changes 缺 service/from_status/to_status（string）');
  }
  return {
    before: { [`${service}.status`]: fromStatus },
    after: { [`${service}.status`]: toStatus },
  };
}
