// kernel/bench-tasks/reference/sys-04.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// sys-04：目录复制变更规格 + file-list 源文件清单（ChatGPT 意见 4 确定性说明位：constraints.path/sorted/recursive）
//   → 前后状态断言 { before, after }（目标目录 empty → 含全部源文件；文件清单类按 path 有序遍历）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const changes = requireRecord(
    findArtifact(input, 'changes').content,
    'sys-04 reference: changes 输入工件 content 必须为对象',
  );
  if (changes.operation !== 'copy') {
    throw new Error(`sys-04 reference: 不支持的 operation ${String(changes.operation)}（仅 copy）`);
  }
  const source = changes.source;
  const target = changes.target;
  if (typeof source !== 'string' || typeof target !== 'string') {
    throw new Error('sys-04 reference: changes 缺 source/target（string）');
  }
  const fileList = findArtifact(input, 'src_files');
  const constraints = fileList.constraints;
  if (
    constraints === undefined ||
    typeof constraints.path !== 'string' ||
    typeof constraints.sorted !== 'boolean' ||
    typeof constraints.recursive !== 'boolean'
  ) {
    throw new Error('sys-04 reference: src_files 工件必须声明 constraints.path/sorted/recursive（确定性说明位）');
  }
  if (constraints.path !== source) {
    throw new Error('sys-04 reference: src_files constraints.path 必须等于 changes.source');
  }
  if (!Array.isArray(fileList.content)) {
    throw new Error('sys-04 reference: src_files 输入工件 content 必须为数组');
  }
  const paths: string[] = [];
  for (const entry of fileList.content) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('sys-04 reference: src_files 元素必须为对象 { path }');
    }
    const p = (entry as Record<string, unknown>).path;
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('sys-04 reference: src_files 元素缺非空 path');
    }
    paths.push(p);
  }
  // sorted=true → 按 path 有序遍历（跨平台确定性）
  if (constraints.sorted) {
    paths.sort((a, b) => a.localeCompare(b));
  }
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const p of paths) {
    before[`${source}/${p}`] = 'exists';
    after[`${target}/${p}`] = 'exists';
  }
  before[target] = 'empty';
  return { before, after };
}
