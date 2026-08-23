// kernel/bench-tasks/reference/web-01.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// web-01：页面规格（title/nav_items）→ 首页页面模型 { title, nav: { items }, count }（满足 v1 同语义谓词）。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact, requireRecord } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const spec = requireRecord(
    findArtifact(input, 'page_spec').content,
    'web-01 reference: page_spec 输入工件 content 必须为对象',
  );
  const title = spec.title;
  const navItems = spec.nav_items;
  if (typeof title !== 'string' || !Array.isArray(navItems) || !navItems.every((x) => typeof x === 'string')) {
    throw new Error('web-01 reference: page_spec 缺 title（string）或 nav_items（string[]）');
  }
  const items: string[] = navItems.map((x) => x as string);
  return { title, nav: { items }, count: items.length };
}
