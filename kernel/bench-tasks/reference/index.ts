// kernel/bench-tasks/reference/index.ts —— v2 reference 注册表（契约 id → 纯函数；T2.1 两样例，其余 18 个任务留 T2.2）。
// 生成器与测试共用同一映射（单一权威）；reference 模块只 import 类型，无 I/O。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { reference as data01 } from './data-01.js';
import { reference as sys01 } from './sys-01.js';

/** reference 函数签名：固定 input（契约 input_artifacts）→ expected（v2 ground truth 权威） */
export type ReferenceFn = (input: InputArtifactV2[]) => unknown;

/** 契约 id → reference 实现 */
export const references: ReadonlyMap<string, ReferenceFn> = new Map([
  ['data-01', data01],
  ['sys-01', sys01],
]);

/** 取契约 id 的 reference；缺失 → fail-loud（T2.2 前不应引用未实现契约） */
export function getReference(id: string): ReferenceFn {
  const fn = references.get(id);
  if (fn === undefined) {
    throw new Error(`bench v2: 缺少契约 ${id} 的 reference 实现`);
  }
  return fn;
}
