// OMB v2 ProcessDef → OperatorGraph 适配器（M4 出口接缝：generator 产物 → executeGraph 可执行图）。
// layer 2（runtime/）：仅 import node: 内置 + kernel/（同层）+ runtime/ 内文件（CONVENTIONS §4）。
// 接缝（主会话裁决 + T4.1 review）：OperatorGraph.edges 在 ProcessDef 无对应——需从 input_binding
// 引用派生（op A 的 output 被 op B 的 input_binding 消费 → 边 A→B）；schema→ABI 需收窄转换。
//
// 派生规则（toOperatorGraph，纯函数，fail-loud）：
// 1. 算子 id 规范化：按 ProcessDef.operators 顺序编号——op 名单次出现 → 裸名（RETRIEVE）；
//    重复出现 → 序号后缀（RETRIEVE-1/RETRIEVE-2）。执行器按内置名/基名解析（registry → 内置 → 基名）。
// 2. input_binding 收窄（unknown → OperatorBinding）：
//    - 字符串 '$.name[.seg…]'：name 命中唯一算子 output → { ref: 生产者 id[, path] }（数据流引用，派生边）；
//      命中多个 output → fail-loud（引用不明确）；无生产者 → { ref: name[, path] }（图上下文输入引用，
//      执行期由 executeGraph 经 ctx.inputs 解析——T4.3-loop 实证的执行器最小扩展）。
//    - 已收窄形状：{ref} 原算子 id → 规范化 id；{ref} 输出名 → 生产者 id；{const}/数组 原样。
//    - 其他值（裸常量）→ { const: value }。
// 3. 边派生：算子间 {ref} 引用 → 边（去重）；图输入引用不产生边；自引用 → fail-loud。
//    无任何派生边（无算子间引用）→ 按 operators 顺序链 fallback（operators[i] → operators[i+1]）。
// 4. entry/exit：取 process.entry/exit 并校验首/末算子 op 一致（schema 已保证，防御性再校验）。
// 5. 字段缺省：side_effect（EXECUTE → mutate，其余 read_only；ProcessDef 无此字段）、
//    transaction=false（ProcessDef 无此字段）；version 取 process.version。
import type { ProcessDef } from '../kernel/policy-loader.js';
import type { GraphEdge, OperatorBinding, OperatorGraph, OperatorSpec } from './operator.js';

// ---- 适配上下文（输出名 → 生产者索引 + 原 id → 规范化 id 映射） ----

interface AdapterContext {
  /** 原算子 id → 规范化 id（执行器可解析） */
  idMap: Map<string, string>;
  /** 输出名 → 原算子 id 列表（歧义检测） */
  outputIndex: Map<string, string[]>;
}

/** 输出名解析：唯一生产者 → 原 id；无 → null；多个 → fail-loud（引用不明确） */
function resolveOutput(target: string, ctx: AdapterContext): string | null {
  const producers = ctx.outputIndex.get(target);
  if (producers === undefined) {
    return null;
  }
  if (producers.length > 1) {
    throw new Error(`process-adapter: 输出名 "${target}" 由多个算子产出，引用不明确（${producers.join(', ')}）`);
  }
  return producers[0]!;
}

/** input_binding 值收窄（unknown → OperatorBinding）；'$.x' 引用 / 已收窄绑定 / 裸常量 */
function convertBinding(value: unknown, ctx: AdapterContext): OperatorBinding {
  if (typeof value === 'string' && value.startsWith('$.')) {
    const segs = value.slice(2).split('.');
    const target = segs[0];
    if (target === undefined || target.length === 0) {
      throw new Error('process-adapter: 空引用 "$."（引用目标缺失）');
    }
    const path = segs.length > 1 ? segs.slice(1).join('.') : undefined;
    const producer = resolveOutput(target, ctx);
    if (producer !== null) {
      const ref = ctx.idMap.get(producer)!;
      return path !== undefined ? { ref, path } : { ref };
    }
    // 图上下文输入引用（无生产者；执行期经 ctx.inputs 解析）
    return path !== undefined ? { ref: target, path } : { ref: target };
  }
  if (Array.isArray(value)) {
    return value.map((v) => convertBinding(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.ref === 'string') {
      // 已收窄 {ref}：原算子 id → 规范化 id；输出名 → 生产者 id；否则图输入引用
      const target = obj.ref;
      const mapped = ctx.idMap.get(target);
      if (mapped !== undefined) {
        return typeof obj.path === 'string' ? { ref: mapped, path: obj.path } : { ref: mapped };
      }
      const producer = resolveOutput(target, ctx);
      if (producer !== null) {
        const ref = ctx.idMap.get(producer)!;
        return typeof obj.path === 'string' ? { ref, path: obj.path } : { ref };
      }
      return typeof obj.path === 'string' ? { ref: target, path: obj.path } : { ref: target };
    }
    if ('const' in obj) {
      return { const: obj.const };
    }
  }
  return { const: value };
}

/** 边派生：递归收集算子间 {ref} 引用 → 边（去重）；自引用 fail-loud；图输入引用忽略 */
function collectEdges(
  binding: OperatorBinding,
  opId: string,
  opIds: Set<string>,
  edges: GraphEdge[],
  seen: Set<string>,
): void {
  if (Array.isArray(binding)) {
    for (const b of binding) {
      collectEdges(b as OperatorBinding, opId, opIds, edges, seen);
    }
    return;
  }
  if (binding !== null && typeof binding === 'object' && typeof (binding as { ref?: unknown }).ref === 'string') {
    const ref = (binding as { ref: string }).ref;
    if (ref === opId) {
      throw new Error(`process-adapter: 算子 ${opId} 的 input_binding 自引用自身输出（${ref}）`);
    }
    if (opIds.has(ref)) {
      const key = `${ref}>${opId}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ from: ref, to: opId });
      }
    }
  }
}

/**
 * ProcessDef → OperatorGraph（纯函数；非法形状 fail-loud）。
 * 详见模块头派生规则：id 规范化、绑定收窄、边派生（无引用 → 顺序链 fallback）、entry/exit 校验。
 */
export function toOperatorGraph(process: ProcessDef): OperatorGraph {
  const ops = process.operators;
  if (ops.length === 0) {
    throw new Error('process-adapter: operators 为空（无算子可执行）');
  }
  if (process.entry !== ops[0]!.op) {
    throw new Error(`process-adapter: entry=${process.entry} 必须等于首算子 op=${ops[0]!.op}`);
  }
  if (process.exit !== ops[ops.length - 1]!.op) {
    throw new Error(`process-adapter: exit=${process.exit} 必须等于末算子 op=${ops[ops.length - 1]!.op}`);
  }

  // 原 id 唯一性（OperatorGraph 要求；重复 → fail-loud）
  const seenIds = new Set<string>();
  for (const o of ops) {
    if (seenIds.has(o.id)) {
      throw new Error(`process-adapter: 重复算子 id "${o.id}"`);
    }
    seenIds.add(o.id);
  }

  // id 规范化 + 输出名索引（歧义检测）
  const counts = new Map<string, number>();
  for (const o of ops) {
    counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const idMap = new Map<string, string>();
  const outputIndex = new Map<string, string[]>();
  for (const o of ops) {
    const k = (seen.get(o.op) ?? 0) + 1;
    seen.set(o.op, k);
    idMap.set(o.id, counts.get(o.op) === 1 ? o.op : `${o.op}-${k}`);
    const producers = outputIndex.get(o.output);
    if (producers === undefined) {
      outputIndex.set(o.output, [o.id]);
    } else {
      producers.push(o.id);
    }
  }
  const ctx: AdapterContext = { idMap, outputIndex };

  // 算子映射（绑定收窄）
  const operators: OperatorSpec[] = ops.map((o) => ({
    id: idMap.get(o.id)!,
    version: process.version,
    input_binding: Object.fromEntries(Object.entries(o.input_binding).map(([k, v]) => [k, convertBinding(v, ctx)])),
    output: o.output,
    cost: { ...o.cost },
    side_effect: o.op === 'EXECUTE' ? 'mutate' : 'read_only',
    verification: o.verification,
    error: { ...o.error },
    transaction: false,
  }));

  // 边派生（算子间 ref 引用；自引用已 fail-loud；图输入引用忽略）
  const opIds = new Set(operators.map((o) => o.id));
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const op of operators) {
    for (const binding of Object.values(op.input_binding)) {
      collectEdges(binding, op.id, opIds, edges, seenEdges);
    }
  }
  // 无任何派生边 → 按 operators 顺序链 fallback（记录注释：无算子间引用时的确定性缺省）
  if (edges.length === 0) {
    for (let i = 0; i < operators.length - 1; i++) {
      edges.push({ from: operators[i]!.id, to: operators[i + 1]!.id });
    }
  }

  return { operators, edges, entry: process.entry, exit: process.exit };
}
