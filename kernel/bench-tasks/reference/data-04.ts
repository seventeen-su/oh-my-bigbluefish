// kernel/bench-tasks/reference/data-04.ts —— v2 基准 ground truth 权威（施工计划 2026-08-23-bench-v2-contract.md T2.2）。
// 纯函数：固定 input（契约 input_artifacts）→ expected（确定性计算，无 I/O、无随机，只 import 类型与 _helpers）。
// data-04：产品列表 → 过滤 price < 50，按 price 升序（同价按 id 升序）→ { products: [{ id, price }] }。
import type { InputArtifactV2 } from '../../schemas/bench.js';
import { findArtifact } from './_helpers.js';

export function reference(input: InputArtifactV2[]): unknown {
  const artifact = findArtifact(input, 'products');
  const products = artifact.content;
  if (!Array.isArray(products)) {
    throw new Error('data-04 reference: products 输入工件 content 必须为数组');
  }
  const normalized: { id: string; price: number }[] = [];
  for (const product of products) {
    if (product === null || typeof product !== 'object' || Array.isArray(product)) {
      throw new Error('data-04 reference: 产品元素必须为对象 { id, price, ... }');
    }
    const record = product as Record<string, unknown>;
    const id = record.id;
    const price = record.price;
    if (typeof id !== 'string' || typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error('data-04 reference: 产品必须含 string id 与 number price');
    }
    if (price < 50) {
      normalized.push({ id, price });
    }
  }
  normalized.sort((a, b) => (a.price !== b.price ? a.price - b.price : a.id.localeCompare(b.id)));
  return { products: normalized };
}
