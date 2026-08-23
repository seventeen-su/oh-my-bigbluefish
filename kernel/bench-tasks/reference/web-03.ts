// kernel/bench-tasks/reference/web-03.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// web-03：搜索规格（query/result_ids）→ 结果页模型 { query, results: { count, items } }（满足 results.count = 3 谓词）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const spec = requireRecord(
    findArtifact(input, 'page_spec').content,
    'web-03 reference: page_spec 输入工件 content 必须为对象',
  );
  const query = spec.query;
  const resultIds = spec.result_ids;
  if (typeof query !== 'string' || !Array.isArray(resultIds) || !resultIds.every((x) => typeof x === 'string')) {
    throw new Error('web-03 reference: page_spec 缺 query（string）或 result_ids（string[]）');
  }
  const items: string[] = resultIds.map((x) => x as string);
  return { query, results: { count: items.length, items } };
}
