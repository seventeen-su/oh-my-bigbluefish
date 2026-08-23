// kernel/bench-tasks/reference/index.ts —— v2 reference 注册表（契约 id → 纯函数；T2.2 全量 20 任务）。
// 生成器与测试共用同一映射（单一权威）；reference 模块只 import 类型，无 I/O。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { reference as code01 } from './code-01.js';
import { reference as code02 } from './code-02.js';
import { reference as code03 } from './code-03.js';
import { reference as code04 } from './code-04.js';
import { reference as data01 } from './data-01.js';
import { reference as data02 } from './data-02.js';
import { reference as data03 } from './data-03.js';
import { reference as data04 } from './data-04.js';
import { reference as research01 } from './research-01.js';
import { reference as research02 } from './research-02.js';
import { reference as research03 } from './research-03.js';
import { reference as research04 } from './research-04.js';
import { reference as sys01 } from './sys-01.js';
import { reference as sys02 } from './sys-02.js';
import { reference as sys03 } from './sys-03.js';
import { reference as sys04 } from './sys-04.js';
import { reference as web01 } from './web-01.js';
import { reference as web02 } from './web-02.js';
import { reference as web03 } from './web-03.js';
import { reference as web04 } from './web-04.js';

/** reference 函数签名：固定 input（契约 input_artifacts）→ expected（v2 ground truth 权威） */
export type ReferenceFn = (input: InputArtifactV2[]) => unknown;

/** 契约 id → reference 实现（全量 20；与冻结集 5 类 × 4 对齐） */
export const references: ReadonlyMap<string, ReferenceFn> = new Map([
  ['code-01', code01],
  ['code-02', code02],
  ['code-03', code03],
  ['code-04', code04],
  ['data-01', data01],
  ['data-02', data02],
  ['data-03', data03],
  ['data-04', data04],
  ['web-01', web01],
  ['web-02', web02],
  ['web-03', web03],
  ['web-04', web04],
  ['sys-01', sys01],
  ['sys-02', sys02],
  ['sys-03', sys03],
  ['sys-04', sys04],
  ['research-01', research01],
  ['research-02', research02],
  ['research-03', research03],
  ['research-04', research04],
]);

/** 取契约 id 的 reference；缺失 → fail-loud（契约与实现数据完整性守卫） */
export function getReference(id: string): ReferenceFn {
  const fn = references.get(id);
  if (fn === undefined) {
    throw new Error(`bench v2: 缺少契约 ${id} 的 reference 实现`);
  }
  return fn;
}
