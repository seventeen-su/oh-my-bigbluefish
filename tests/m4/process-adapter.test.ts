// T4.3-loop 行为测试：ProcessDef → OperatorGraph 适配器（runtime/process-adapter.ts，M4 出口接缝）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失：模块不存在 → import 报错）。
// 八组：① 字段收窄映射（OperatorSpec 字段；op 名规范化 id；side_effect/transaction 缺省）
//       ② 绑定转换（$.输出名 → {ref: 生产者 id}；$.图输入 → {ref: 输入名(+path)}；裸常量 → {const}；
//          已收窄绑定原样透传并重映射 op id 引用）
//       ③ 边派生（output 消费链 → 边；图输入引用不产生边；去重）
//       ④ 无 ref 派生边 → 按 operators 顺序链 fallback
//       ⑤ entry/exit 校验（通过；不一致 fail-loud）
//       ⑥ fail-loud：重复算子 id / 歧义输出引用 / 自引用 / 空 '$.' 引用
//       ⑦ 确定性：同输入两次全图深相等
//       ⑧ 执行兼容（接缝实证）：ProcessDef 的 '$.图输入' 引用经 ctx.inputs 解析 → executeGraph 成功
import { describe, expect, it } from 'vitest';
import { toOperatorGraph } from '../../runtime/process-adapter.js';
import { executeGraph, type OperatorBinding, type OperatorGraph } from '../../runtime/operator.js';
import { type OperatorDef, type ProcessDef } from '../../kernel/policy-loader.js';

// ---- 测试工具 ----

type BuiltinOp = OperatorDef['op'];

interface OpFixture {
  id: string;
  op: BuiltinOp;
  output: string;
  input_binding?: Record<string, unknown>;
  cost?: { tokens?: number; time_ms?: number };
  verification?: string;
}

/** ProcessDef 工厂（error 缺省：非重试/无超时/不可取消/无回滚；verification 满足 schema min(1)） */
function mkDef(id: string, entry: BuiltinOp, exit: BuiltinOp, ops: OpFixture[], version = '1.0.0'): ProcessDef {
  return {
    id,
    version,
    entry,
    exit,
    budget: { tokens: 1000, time_ms: 1000 },
    operators: ops.map((o) => ({
      id: o.id,
      op: o.op,
      input_binding: o.input_binding ?? {},
      output: o.output,
      cost: o.cost ?? { tokens: 100 },
      verification: o.verification ?? '默认校验',
      error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' },
    })),
  };
}

/** 强制类型转换（构造非法形状用；ProcessDef 类型仅编译期，运行时形状由适配器自校验） */
function asDef(v: unknown): ProcessDef {
  return v as ProcessDef;
}

/** T2.1 retrieve-verify 过程（真实 YAML 形状：'$.x' 引用 + 裸常量；键名 = 内置算子输入契约键） */
const PROC_RV = mkDef('retrieve-verify', 'RETRIEVE', 'STOP', [
  { id: 'retrieve', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal', scope: 'Project', kind: 'Semantic' } },
  { id: 'verify', op: 'VERIFY', output: 'verdict', input_binding: { pack: '$.memory_pack' } },
  { id: 'stop', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working', reason: '$.verdict' } },
]);

/** 规范链（含 EXECUTE 与图输入路径引用 '$.working.evidence_gaps'） */
const PROC_CANON = mkDef('canonical', 'RETRIEVE', 'STOP', [
  { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
  { id: 'h', op: 'HYPOTHESIZE', output: 'hypotheses', input_binding: { state: '$.memory_pack', n: 2 } },
  { id: 'd', op: 'DISCRIMINATE', output: 'experiment_plan', input_binding: { h: '$.hypotheses', s: '$.working', gaps: '$.working.evidence_gaps' } },
  { id: 'x', op: 'EXECUTE', output: 'tool_results', input_binding: { plan: '$.experiment_plan' } },
  { id: 'o', op: 'OBSERVE', output: 'observations', input_binding: { results: '$.tool_results', plan: '$.experiment_plan' } },
  { id: 'u', op: 'UPDATE', output: 'state_patch', input_binding: { state: '$.working', obs: '$.observations' } },
  { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working', reason: '$.state_patch' } },
]);

/** 全常量绑定（无任何 ref → 顺序链 fallback 路径） */
const PROC_CONST = mkDef('all-const', 'RETRIEVE', 'STOP', [
  { id: 'a', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '常量查询', scope: 'Project' } },
  { id: 'b', op: 'HYPOTHESIZE', output: 'hypotheses', input_binding: { n: 1 } },
  { id: 'c', op: 'STOP', output: 'stop_report', input_binding: { reason: 'done' } },
]);

function bindingOf(g: OperatorGraph, opId: string, name: string): OperatorBinding {
  const spec = g.operators.find((o) => o.id === opId);
  expect(spec).toBeDefined();
  return spec!.input_binding[name] as OperatorBinding;
}

// ---- ① 字段收窄映射 ----

describe('① 字段收窄映射（ProcessDef Operator → OperatorSpec）', () => {
  it('id 规范化为内置算子名（单次出现 → 裸名）；version/cost/verification/error 保真；side_effect/transaction 缺省', () => {
    const g = toOperatorGraph(PROC_RV);
    expect(g.operators.map((o) => o.id)).toEqual(['RETRIEVE', 'VERIFY', 'STOP']);
    const r = g.operators[0]!;
    expect(r.version).toBe('1.0.0');
    expect(r.output).toBe('memory_pack');
    expect(r.cost).toEqual({ tokens: 100 });
    expect(r.verification).toBe('默认校验');
    expect(r.error).toEqual({ retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' });
    expect(r.side_effect).toBe('read_only');
    expect(r.transaction).toBe(false);
  });

  it('EXECUTE 算子 side_effect 映射为 mutate（副作用算子）', () => {
    const g = toOperatorGraph(PROC_CANON);
    const x = g.operators.find((o) => o.id === 'EXECUTE')!;
    expect(x.side_effect).toBe('mutate');
  });

  it('重复 op 的算子按序编号（NAME-1/NAME-2），ref 引用重映射到编号 id', () => {
    const p = mkDef('dup', 'RETRIEVE', 'STOP', [
      { id: 'r1', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 'r2', op: 'RETRIEVE', output: 'memory_pack_2', input_binding: { q: '$.goal' } },
      { id: 'h', op: 'HYPOTHESIZE', output: 'hypotheses', input_binding: { state: '$.memory_pack_2' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    const g = toOperatorGraph(p);
    expect(g.operators.map((o) => o.id)).toEqual(['RETRIEVE-1', 'RETRIEVE-2', 'HYPOTHESIZE', 'STOP']);
    // '$.memory_pack_2'（r2 的输出）→ 重映射到 'RETRIEVE-2'
    expect(bindingOf(g, 'HYPOTHESIZE', 'state')).toEqual({ ref: 'RETRIEVE-2' });
    expect(g.edges).toContainEqual({ from: 'RETRIEVE-2', to: 'HYPOTHESIZE' });
  });
});

// ---- ② 绑定转换 ----

describe('② 绑定转换（ProcessDef unknown → OperatorBinding）', () => {
  it('$.输出名 → {ref: 生产者 id}；$.图输入 → {ref: 输入名}；$.图输入.路径 → {ref, path}', () => {
    const g = toOperatorGraph(PROC_RV);
    expect(bindingOf(g, 'RETRIEVE', 'q')).toEqual({ ref: 'goal' }); // 图输入（无生产者）
    expect(bindingOf(g, 'VERIFY', 'pack')).toEqual({ ref: 'RETRIEVE' }); // 输出 memory_pack 的生产者
    expect(bindingOf(g, 'STOP', 'state')).toEqual({ ref: 'working' });
    expect(bindingOf(g, 'STOP', 'reason')).toEqual({ ref: 'VERIFY' });
  });

  it('裸常量（字符串/数字）→ {const}；已收窄 {const}/{ref} 原样透传', () => {
    const g = toOperatorGraph(PROC_RV);
    expect(bindingOf(g, 'RETRIEVE', 'scope')).toEqual({ const: 'Project' });
    expect(bindingOf(g, 'RETRIEVE', 'kind')).toEqual({ const: 'Semantic' });

    const p = mkDef('passthrough', 'RETRIEVE', 'STOP', [
      { id: 'a', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: { const: '直接常量' }, scope: { const: 'Project' } } },
      { id: 'b', op: 'STOP', output: 'stop_report', input_binding: { state: { ref: 'a' } } },
    ]);
    const g2 = toOperatorGraph(p);
    expect(bindingOf(g2, 'RETRIEVE', 'q')).toEqual({ const: '直接常量' });
    // 透传 {ref: 'a'}（ProcessDef 算子 id）→ 重映射为规范化 id 'RETRIEVE'
    expect(bindingOf(g2, 'STOP', 'state')).toEqual({ ref: 'RETRIEVE' });
    expect(g2.edges).toContainEqual({ from: 'RETRIEVE', to: 'STOP' });
  });

  it('图输入路径引用：$.working.evidence_gaps → {ref: working, path: evidence_gaps}', () => {
    const g = toOperatorGraph(PROC_CANON);
    expect(bindingOf(g, 'DISCRIMINATE', 'gaps')).toEqual({ ref: 'working', path: 'evidence_gaps' });
  });
});

// ---- ③ 边派生 ----

describe('③ 边派生（output 消费链；图输入引用不产生边；去重）', () => {
  it('PROC_RV：memory_pack/verdict 消费链 → RETRIEVE→VERIFY→STOP；图输入 ref 无边', () => {
    const g = toOperatorGraph(PROC_RV);
    expect(g.edges).toEqual([
      { from: 'RETRIEVE', to: 'VERIFY' },
      { from: 'VERIFY', to: 'STOP' },
    ]);
    expect(g.entry).toBe('RETRIEVE');
    expect(g.exit).toBe('STOP');
  });

  it('PROC_CANON：全链边正确（含 DISCRIMINATE→OBSERVE 与 DISCRIMINATE→EXECUTE 分支）', () => {
    const g = toOperatorGraph(PROC_CANON);
    expect(g.edges).toEqual([
      { from: 'RETRIEVE', to: 'HYPOTHESIZE' },
      { from: 'HYPOTHESIZE', to: 'DISCRIMINATE' },
      { from: 'DISCRIMINATE', to: 'EXECUTE' },
      { from: 'EXECUTE', to: 'OBSERVE' },
      { from: 'DISCRIMINATE', to: 'OBSERVE' },
      { from: 'OBSERVE', to: 'UPDATE' },
      { from: 'UPDATE', to: 'STOP' },
    ]);
  });

  it('重复消费同一输出 → 边去重（同一 from→to 仅一条）', () => {
    const p = mkDef('dedupe', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.memory_pack', pack: '$.memory_pack' } },
    ]);
    const g = toOperatorGraph(p);
    expect(g.edges).toEqual([{ from: 'RETRIEVE', to: 'STOP' }]);
  });
});

// ---- ④ 顺序链 fallback ----

describe('④ 无 ref 派生边 → 按 operators 顺序链 fallback', () => {
  it('全常量绑定（无任何算子引用）→ edges = 顺序链 a→b→c', () => {
    const g = toOperatorGraph(PROC_CONST);
    expect(g.edges).toEqual([
      { from: 'RETRIEVE', to: 'HYPOTHESIZE' },
      { from: 'HYPOTHESIZE', to: 'STOP' },
    ]);
  });

  it('全部绑定为图输入引用（无算子间引用）→ 同样顺序链 fallback', () => {
    const p = mkDef('graph-inputs', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    const g = toOperatorGraph(p);
    expect(g.edges).toEqual([{ from: 'RETRIEVE', to: 'STOP' }]);
  });
});

// ---- ⑤ entry/exit 校验 ----

describe('⑤ entry/exit 校验（首/末算子 op 一致性，fail-loud）', () => {
  it('合法过程通过（PROC_RV entry=首 RETRIEVE，exit=末 STOP）', () => {
    expect(() => toOperatorGraph(PROC_RV)).not.toThrow();
  });

  it('entry ≠ 首算子 op → fail-loud', () => {
    const p = mkDef('bad-entry', 'HYPOTHESIZE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/entry/);
  });

  it('exit ≠ 末算子 op → fail-loud', () => {
    const p = mkDef('bad-exit', 'RETRIEVE', 'HYPOTHESIZE', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/exit/);
  });
});

// ---- ⑥ fail-loud：不合法形状 ----

describe('⑥ 不合法形状 fail-loud（不静默产出坏图）', () => {
  it('重复算子 id → fail-loud', () => {
    const p = mkDef('dup-id', 'RETRIEVE', 'STOP', [
      { id: 'same', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 'same', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/重复|id/);
  });

  it('输出名歧义（多算子同 output 且被引用）→ fail-loud', () => {
    const p = mkDef('ambig', 'RETRIEVE', 'STOP', [
      { id: 'r1', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 'r2', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.memory_pack' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/不明确|歧义|memory_pack/);
  });

  it('自引用（input_binding 引用自身输出）→ fail-loud', () => {
    const p = mkDef('self', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.memory_pack' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/自引用|自身/);
  });

  it('空引用 "$." → fail-loud', () => {
    const p = mkDef('empty-ref', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    expect(() => toOperatorGraph(asDef(p))).toThrow(/引用|ref/);
  });
});

// ---- ⑦ 确定性 ----

describe('⑦ 确定性：同输入两次全图深相等', () => {
  it('toOperatorGraph 两次 → JSON 深相等', () => {
    const a = toOperatorGraph(PROC_CANON);
    const b = toOperatorGraph(PROC_CANON);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

// ---- ⑧ 执行兼容（接缝实证：图输入引用经 ctx.inputs 解析） ----

describe('⑧ 执行兼容（接缝实证：ProcessDef "$.x" 图输入引用可执行）', () => {
  it('RETRIEVE 绑定 "$.goal" → 图输入引用 → executeGraph 经 ctx.inputs 解析成功', async () => {
    const p = mkDef('graph-in', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', input_binding: { q: '$.goal', scope: 'Project' } },
      { id: 's', op: 'STOP', output: 'stop_report', input_binding: { state: '$.working' } },
    ]);
    const g = toOperatorGraph(p);
    const res = await executeGraph(g, {
      inputs: { goal: '图输入查询', working: { confirmed_facts: ['事实A'], evidence_gaps: [] } },
      budget: 1000,
      retrieveFn: async () => ({ items: [{ id: 'm1', payload: '记忆1' }], channel_used: 'lexical' }),
    });
    expect(res.ok).toBe(true);
    expect(res.completed).toEqual(['RETRIEVE', 'STOP']); // 顺序链 fallback 边
    const pack = res.outputs['RETRIEVE'] as { query: string };
    expect(pack.query).toBe('图输入查询'); // ctx.inputs.goal 流入算子输入
    const stop = res.outputs['STOP'] as { summary: { confirmed_facts: number } };
    expect(stop.summary.confirmed_facts).toBe(1);
  });
});
