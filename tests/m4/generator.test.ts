// T4.2 行为测试：过程生成器阶梯（runtime/generator.ts，架构 §5.3）。
// 严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
// 九组：① Reuse（检索命中 → 直接复用；fake llm 断言未调用）
//       ② 已知过程不走 Generator（applicability=Strong 核心验收；Strong 无匹配也不生成）
//       ③ Compose（首尾算子兼容：输出类型 ⊇ 输入类型；图含两过程全部算子）
//       ④ Mutate（最相似过程单算子替换；算子序列变化 ≤1；短于 canonical 链的 2-op 进程无变异位 → 降级非 no-op）
//       ⑤ Generate 最后手段（注入 → generate；未注入 → none；非法产物拒绝；产物超预算 → none/budget）
//       ⑥ OOD 才生成（OOD 走完整阶梯；Strong 只复用不生成）
//       ⑦ 预算约束（预算 < 最小图成本 → none reason:budget；组合产物超预算 → none reason:budget）
//       ⑧ 产物校验（validateProcess 合法/非法；非法 compose/mutate 产物拒绝并降级）
//       ⑨ assessApplicability 五分类（Strong/Partial/Failed/Contradictory/OOD）
import { describe, expect, it } from 'vitest';
import { ProcessGenerator, assessApplicability, validateProcess, type WorkingState } from '../../runtime/generator.js';
import { BUILTIN_OPERATORS, type ProcessDef } from '../../kernel/policy-loader.js';

// ---- 测试工具 ----

type BuiltinOp = (typeof BUILTIN_OPERATORS)[number];

interface OpFixture {
  id: string;
  op: BuiltinOp;
  output: string;
  cost?: { tokens?: number; time_ms?: number };
  verification?: string;
  input_binding?: Record<string, unknown>;
}

/** ProcessDef 工厂（缺省 cost 100 tokens；error/verification 满足 schema min(1)） */
function mkProcess(
  id: string,
  entry: BuiltinOp,
  exit: BuiltinOp,
  ops: OpFixture[],
  budget?: { tokens?: number; time_ms?: number },
): ProcessDef {
  return {
    id,
    version: '1.0.0',
    entry,
    exit,
    budget: budget ?? { tokens: ops.reduce((s, o) => s + (o.cost?.tokens ?? 100), 0) },
    operators: ops.map((o) => ({
      id: o.id,
      op: o.op,
      input_binding: o.input_binding ?? {},
      output: o.output,
      cost: o.cost ?? { tokens: 100 },
      verification: o.verification ?? '默认校验',
      error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' },
    })),
  };
}

/** 非法过程（含非内置算子 NOPE；entry/exit 仍合法 → 仅算子集非法） */
function invalidProcess(): ProcessDef {
  return {
    id: 'invalid-x',
    version: '1.0.0',
    entry: 'RETRIEVE',
    exit: 'STOP',
    budget: { tokens: 400 },
    operators: [
      { id: 'retrieve', op: 'RETRIEVE', input_binding: {}, output: 'memory_pack', cost: { tokens: 100 }, verification: '记忆检索', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' } },
      { id: 'verify', op: 'VERIFY', input_binding: {}, output: 'verdict', cost: { tokens: 100 }, verification: '校验', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' } },
      { id: 'nope', op: 'NOPE', input_binding: {}, output: 'whatever', cost: { tokens: 100 }, verification: '非法算子', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' } },
      { id: 'stop', op: 'STOP', input_binding: {}, output: 'stop_report', cost: { tokens: 100 }, verification: '停止报告', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无副作用' } },
    ],
  } as unknown as ProcessDef;
}

/** OOD 任务 goal（关键词不与任何 fixture 过程文本重合） */
const OOD_GOAL = '量子引力 全息对偶';

// 过程库 fixtures（中文 verification 承载 goal 关键词，供 assessApplicability 关键词覆盖）
const PROC_HT = mkProcess('hypothesize-test', 'HYPOTHESIZE', 'STOP', [
  { id: 'hypothesize', op: 'HYPOTHESIZE', output: 'hypotheses', verification: '假设派生 规则模板', cost: { tokens: 3000 } },
  { id: 'discriminate', op: 'DISCRIMINATE', output: 'experiment_plan', verification: '判别实验 覆盖假设', cost: { tokens: 2000 } },
  { id: 'execute', op: 'EXECUTE', output: 'tool_results', verification: '能力执行 结果', cost: { tokens: 4000 } },
  { id: 'observe', op: 'OBSERVE', output: 'observations', verification: '观测转换 证据', cost: { tokens: 1500 } },
  { id: 'update', op: 'UPDATE', output: 'state_patch', verification: '状态补丁 更新', cost: { tokens: 1500 } },
  { id: 'stop', op: 'STOP', output: 'stop_report', verification: '结论 停止报告', cost: { tokens: 200 } },
]);

const PROC_A = mkProcess('retrieve-hypothesize', 'RETRIEVE', 'HYPOTHESIZE', [
  { id: 'retrieve', op: 'RETRIEVE', output: 'memory_pack', verification: '记忆检索 假设覆盖', cost: { tokens: 2000 } },
  { id: 'hypothesize', op: 'HYPOTHESIZE', output: 'hypotheses', verification: '假设派生 模板', cost: { tokens: 3000 } },
]);

const PROC_B = mkProcess('discriminate-stop', 'DISCRIMINATE', 'STOP', [
  { id: 'discriminate', op: 'DISCRIMINATE', output: 'experiment_plan', verification: '判别实验 设计', cost: { tokens: 2000 } },
  { id: 'execute', op: 'EXECUTE', output: 'tool_results', verification: '能力执行', cost: { tokens: 4000 } },
  { id: 'stop', op: 'STOP', output: 'stop_report', verification: '停止报告 结论', cost: { tokens: 200 } },
]);

const PROC_RV = mkProcess('retrieve-verify', 'RETRIEVE', 'STOP', [
  { id: 'retrieve', op: 'RETRIEVE', output: 'memory_pack', verification: '记忆检索', cost: { tokens: 2000 } },
  { id: 'verify', op: 'VERIFY', output: 'verdict', verification: '校验 结论判定', cost: { tokens: 1000 } },
  { id: 'stop', op: 'STOP', output: 'stop_report', verification: '停止报告', cost: { tokens: 200 } },
]);

const oodTask = (state: WorkingState = {}): Parameters<ProcessGenerator['generate']>[0] => ({
  goal: OOD_GOAL,
  state,
  applicability: 'OOD',
});

// ---- ① Reuse ----

describe('① Reuse（检索命中 → 直接复用，llmGenerate 不调用）', () => {
  it('过程库含匹配过程且注入 retrieveProcess → method: reuse，fake llm 未被调用', async () => {
    let llmCalls = 0;
    let sawQuery: { goal: string } | undefined;
    const gen = new ProcessGenerator({
      processes: [PROC_HT],
      budget: 20000,
      retrieveProcess: (q) => {
        sawQuery = q;
        return [PROC_HT];
      },
      llmGenerate: async () => {
        llmCalls++;
        return PROC_HT;
      },
    });
    const res = await gen.generate({ goal: '假设 判别', state: {}, applicability: 'OOD' });
    expect(res.method).toBe('reuse');
    expect(res.process?.id).toBe('hypothesize-test');
    expect(res.reason).toContain('reuse');
    expect(sawQuery?.goal).toBe('假设 判别');
    expect(llmCalls).toBe(0);
  });

  it('未注入 retrieveProcess → 默认关键词检索命中 → 复用', async () => {
    const gen = new ProcessGenerator({ processes: [PROC_HT], budget: 20000 });
    const res = await gen.generate({ goal: '假设 判别', state: {}, applicability: 'OOD' });
    expect(res.method).toBe('reuse');
    expect(res.process?.id).toBe('hypothesize-test');
  });
});

// ---- ② 已知过程不走 Generator（核心验收） ----

describe('② 已知过程不走 Generator（applicability=Strong）', () => {
  it('Strong 任务 + 库中含匹配过程 → 直接复用（核心验收）', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [PROC_HT],
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return PROC_HT;
      },
    });
    const res = await gen.generate({ goal: '假设 判别', state: {}, applicability: 'Strong' });
    expect(res.method).toBe('reuse');
    expect(llmCalls).toBe(0);
  });

  it('Strong 任务但库中无匹配 → method: none（不生成），fake llm 未被调用', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [PROC_HT],
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return PROC_HT;
      },
    });
    const res = await gen.generate({ goal: OOD_GOAL, state: {}, applicability: 'Strong' });
    expect(res.method).toBe('none');
    expect(res.reason).toContain('OOD');
    expect(llmCalls).toBe(0);
  });
});

// ---- ③ Compose ----

describe('③ Compose（首尾算子兼容：输出类型 ⊇ 输入类型）', () => {
  it('PROC_A(RETRIEVE→HYPOTHESIZE) + PROC_B(DISCRIMINATE→STOP) → method: compose，图含两过程全部算子', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [PROC_A, PROC_B],
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return PROC_HT;
      },
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('compose');
    expect(res.process).not.toBeNull();
    const p = res.process!;
    expect(p.entry).toBe('RETRIEVE');
    expect(p.exit).toBe('STOP');
    expect(p.operators).toHaveLength(PROC_A.operators.length + PROC_B.operators.length);
    expect(p.operators.map((o) => o.op)).toEqual(['RETRIEVE', 'HYPOTHESIZE', 'DISCRIMINATE', 'EXECUTE', 'STOP']);
    expect(validateProcess(p)).toBe(true);
    expect(llmCalls).toBe(0);
  });
});

// ---- ④ Mutate ----

describe('④ Mutate（最相似过程单算子替换，序列变化 ≤1）', () => {
  it('无直接匹配且无可组合对 → 最相似过程变异（method: mutate）', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [PROC_RV],
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return PROC_RV;
      },
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('mutate');
    expect(res.process).not.toBeNull();
    const p = res.process!;
    const sourceSeq = PROC_RV.operators.map((o) => o.op);
    const mutatedSeq = p.operators.map((o) => o.op);
    // 单算子替换：VERIFY → HYPOTHESIZE，其余不变
    expect(mutatedSeq).toEqual(['RETRIEVE', 'HYPOTHESIZE', 'STOP']);
    const diffCount = mutatedSeq.filter((op, i) => op !== sourceSeq[i]).length;
    expect(diffCount).toBeLessThanOrEqual(1);
    expect(validateProcess(p)).toBe(true);
    expect(llmCalls).toBe(0);
  });

  it('短于 canonical 链的 2-op 进程（无可变异位）→ 降级下一阶梯，不产生 no-op mutate', async () => {
    let llmCalls = 0;
    const llm2 = mkProcess('llm-2op', 'RETRIEVE', 'STOP', [
      { id: 'r', op: 'RETRIEVE', output: 'memory_pack', verification: 'LLM 产物' },
      { id: 's', op: 'STOP', output: 'stop_report', verification: 'LLM 产物' },
    ]);
    const gen = new ProcessGenerator({
      processes: [PROC_A], // [RETRIEVE, HYPOTHESIZE] 是 canonical 链前缀 → firstDiff at idx 2（=进程长度，越界）
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return llm2;
      },
    });
    const res = await gen.generate(oodTask());
    // 无变异位 → 降级 Generate（llm 产物成本 200 ≤ budget）；禁止把"与源相同"的产物报为 mutate
    expect(res.method).not.toBe('mutate');
    expect(res.method).toBe('generate');
    expect(res.process?.id).toBe('llm-2op');
    expect(llmCalls).toBe(1);
  });
});

// ---- ⑤ Generate 最后手段 ----

describe('⑤ Generate 最后手段（全部规则阶梯失败后）', () => {
  const llmProc = mkProcess('llm-generated', 'RETRIEVE', 'STOP', [
    { id: 'r', op: 'RETRIEVE', output: 'memory_pack', verification: 'LLM 产物' },
    { id: 's', op: 'STOP', output: 'stop_report', verification: 'LLM 产物' },
  ]);

  it('llmGenerate 注入 → method: generate', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      llmGenerate: async () => {
        llmCalls++;
        return llmProc;
      },
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('generate');
    expect(res.process?.id).toBe('llm-generated');
    expect(llmCalls).toBe(1);
  });

  it('未注入 llmGenerate → method: none（reason 无 LLM 生成器）', async () => {
    const gen = new ProcessGenerator({ processes: [], budget: 1000 });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.process).toBeNull();
    expect(res.reason).toContain('LLM');
  });

  it('llmGenerate 返回非法产物 → 拒绝：method: none（reason validation）', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [],
      budget: 1000,
      llmGenerate: async () => {
        llmCalls++;
        return invalidProcess();
      },
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toContain('validation');
    expect(llmCalls).toBe(1);
  });

  it('LLM 产物成本超预算（库空跳过 precheck，仍须守卫）→ 拒绝：method: none（reason budget）', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [], // 库空 → minCost===null → 预算 precheck 跳过，唯一防线在 Generate 步
      budget: 1, // llmProc 成本 200 > 1
      llmGenerate: async () => {
        llmCalls++;
        return llmProc;
      },
    });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.process).toBeNull();
    expect(res.reason).toContain('budget');
    expect(llmCalls).toBe(1);
  });
});

// ---- ⑥ OOD 才生成 ----

describe('⑥ OOD 才生成（仅 OOD 触发 Generator 完整阶梯）', () => {
  it('applicability=OOD → 走完整阶梯（compose 命中）；applicability=Strong → 只复用不生成', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes: [PROC_A, PROC_B],
      budget: 20000,
      llmGenerate: async () => {
        llmCalls++;
        return PROC_HT;
      },
    });
    const ood = await gen.generate(oodTask());
    expect(ood.method).toBe('compose');

    const strong = await gen.generate({ goal: '假设 检索', state: {}, applicability: 'Strong' });
    expect(strong.method).toBe('reuse');
    expect(llmCalls).toBe(0);
  });
});

// ---- ⑦ 预算约束 ----

describe('⑦ 预算约束（每一步前检查；超预算 → none reason:budget）', () => {
  it('预算小于最小过程图成本 → method: none reason:budget', async () => {
    const gen = new ProcessGenerator({ processes: [PROC_RV], budget: 1000 });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.process).toBeNull();
    expect(res.reason).toContain('budget');
  });

  it('预算足够复用但不足以组合 → compose 产物超预算 → method: none reason:budget', async () => {
    const gen = new ProcessGenerator({ processes: [PROC_A, PROC_B], budget: 6000 });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toContain('budget');
  });
});

// ---- ⑧ 产物校验 ----

describe('⑧ 产物校验（ProcessDef schema + 算子名 ∈ 内置集合）', () => {
  it('validateProcess：合法过程 true；含非内置算子 false', () => {
    expect(validateProcess(PROC_HT)).toBe(true);
    expect(validateProcess(invalidProcess())).toBe(false);
  });

  it('非法库过程：compose/mutate 产物校验失败 → 降级 → method: none（reason validation）', async () => {
    const gen = new ProcessGenerator({ processes: [invalidProcess()], budget: 10000 });
    const res = await gen.generate(oodTask());
    expect(res.method).toBe('none');
    expect(res.reason).toContain('validation');
  });
});

// ---- ⑨ assessApplicability 五分类 ----

describe('⑨ assessApplicability 五分类（§5.1；初值规则标注待标定 §17）', () => {
  it('Strong：goal 关键词覆盖 ≥0.8（全覆盖）', () => {
    expect(assessApplicability(PROC_HT, { goal: '假设 判别' })).toBe('Strong');
  });

  it('Partial：goal 关键词覆盖 ≥0.4 且 <0.8（1/2 = 0.5）', () => {
    expect(assessApplicability(PROC_HT, { goal: '假设 检索' })).toBe('Partial');
  });

  it('Failed：显式算子需求不满足', () => {
    expect(assessApplicability(PROC_RV, { goal: '假设 判别', requires: ['EXECUTE'] })).toBe('Failed');
  });

  it('Contradictory：已知矛盾且过程无判别/观测能力', () => {
    expect(
      assessApplicability(PROC_RV, { goal: '假设 判别', state: { contradictions: ['事实A与事实B矛盾'] } }),
    ).toBe('Contradictory');
  });

  it('OOD：无关键词覆盖（检索无匹配）', () => {
    expect(assessApplicability(PROC_HT, { goal: OOD_GOAL })).toBe('OOD');
  });
});
