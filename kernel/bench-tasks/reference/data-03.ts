// kernel/bench-tasks/reference/data-03.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// data-03：交易数组 → { by_category: { 类别: 金额合计 } }，类别键按字典序排列。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const artifact = findArtifact(input, 'transactions');
  const transactions = artifact.content;
  if (!Array.isArray(transactions)) {
    throw new Error('data-03 reference: transactions 输入工件 content 必须为数组');
  }
  const totals: Record<string, number> = {};
  for (const tx of transactions) {
    if (tx === null || typeof tx !== 'object' || Array.isArray(tx)) {
      throw new Error('data-03 reference: 交易元素必须为对象 { category, amount }');
    }
    const record = tx as Record<string, unknown>;
    const category = record.category;
    const amount = record.amount;
    if (typeof category !== 'string' || typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error('data-03 reference: 交易必须含 string category 与 number amount');
    }
    totals[category] = (totals[category] ?? 0) + amount;
  }
  const byCategory: Record<string, number> = {};
  for (const key of Object.keys(totals).sort()) {
    byCategory[key] = totals[key]!;
  }
  return { by_category: byCategory };
}
