// T2.1 行为测试：策略与过程数据层（P3 机制即数据，架构 §5.1 Fast Governor / §5.3 过程数据化 / §4.2 P1 / §17 参数标定）。
// 七类：① 默认策略加载 ② 默认过程加载 ③ 策略改动即生效（无硬编码） ④ 非法策略拒绝（fail-loud）
//       ⑤ 决策表完整性（防漂移） ⑥ 预算初值合理性 ⑦ 公共 API 导出面（re-export 完整，防漂移）。
// fixture：mkdtemp 临时目录 + 复制真实 kernel/policy（不动真实目录，CONVENTIONS §6）。
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLICABILITY,
  BUILTIN_OPERATORS,
  DEFAULT_MAINTENANCE_COSTS,
  EVIDENCE_GAPS,
  loadPolicy,
  loadProcesses,
} from '../../kernel/policy-loader.js';

const KERNEL_DIR = fileURLToPath(new URL('../../kernel', import.meta.url));
const POLICY_DIR = join(KERNEL_DIR, 'policy');
const PROCESSES_DIR = join(KERNEL_DIR, 'processes');

const roots: string[] = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-policy-'));
  roots.push(root);
  return root;
}

/** 复制真实 policy 目录到临时 fixture；overrides: 文件名 → 覆盖内容 */
async function policyFixture(overrides: Record<string, string> = {}): Promise<string> {
  const root = await tmpRoot();
  await cp(POLICY_DIR, join(root, 'policy'), { recursive: true });
  for (const [file, content] of Object.entries(overrides)) {
    await writeFile(join(root, 'policy', file), content, 'utf8');
  }
  return join(root, 'policy');
}

/** 临时 processes 目录（写入指定文件内容；不复制真实目录） */
async function processesFixture(files: Record<string, string>): Promise<string> {
  const root = await tmpRoot();
  const dir = join(root, 'processes');
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('① 默认策略加载', () => {
  it('loadPolicy 返回 governor/budget/context 三策略且 zod 校验通过', async () => {
    const p = await loadPolicy(POLICY_DIR);
    expect(p.governor.rules.length).toBeGreaterThan(0);
    expect(p.governor.rules.some((r) => r.id === 'default')).toBe(true);
    expect(p.budget.context_budget_tokens).toBe(500);
    expect(p.context.working_state_never_compress).toBe(true);
    for (const w of Object.values(p.context.marginal_weights)) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it('加载结果深冻结（机制即数据：运行期不可变）', async () => {
    const p = await loadPolicy(POLICY_DIR);
    expect(Object.isFrozen(p.governor)).toBe(true);
    expect(Object.isFrozen(p.governor.rules)).toBe(true);
    expect(Object.isFrozen(p.budget)).toBe(true);
    expect(Object.isFrozen(p.context)).toBe(true);
  });
});

describe('② 默认过程加载', () => {
  it('两个过程文件 schema 校验通过；operators 引用合法算子', async () => {
    const processes = await loadProcesses(PROCESSES_DIR);
    expect(processes.map((p) => p.id).sort()).toEqual(['hypothesize-test', 'retrieve-verify']);
    for (const proc of processes) {
      expect(proc.operators.length).toBeGreaterThan(0);
      for (const op of proc.operators) {
        expect(BUILTIN_OPERATORS).toContain(op.op);
      }
    }
  });

  it('retrieve-verify 为 RETRIEVE→VERIFY→STOP；hypothesize-test 为六步假设-检验闭环', async () => {
    const processes = await loadProcesses(PROCESSES_DIR);
    const byId = new Map(processes.map((p) => [p.id, p]));
    const rv = byId.get('retrieve-verify');
    const ht = byId.get('hypothesize-test');
    expect(rv).toBeDefined();
    expect(ht).toBeDefined();
    expect(rv!.operators.map((o) => o.op)).toEqual(['RETRIEVE', 'VERIFY', 'STOP']);
    expect(ht!.operators.map((o) => o.op)).toEqual([
      'HYPOTHESIZE',
      'DISCRIMINATE',
      'EXECUTE',
      'OBSERVE',
      'UPDATE',
      'STOP',
    ]);
    // entry/exit 与图端点一致（schema refine 不变量，此处验证数据本身）
    expect(rv!.entry).toBe('RETRIEVE');
    expect(rv!.exit).toBe('STOP');
    expect(ht!.entry).toBe('HYPOTHESIZE');
    expect(ht!.exit).toBe('STOP');
  });
});

describe('③ 策略改动即生效（机制即数据，代码不感知内容）', () => {
  it('改动版 budget.yaml 的 context_budget_tokens 与 depth → loadPolicy 返回新值', async () => {
    const dir = await policyFixture({
      'budget.yaml': [
        'context_budget_tokens: 4321',
        'depth: 3',
        'breadth: 2',
        'tools: 5',
        'retrieval: 4',
        'branches: 3',
        'context: 9000',
      ].join('\n'),
    });
    const p = await loadPolicy(dir);
    expect(p.budget.context_budget_tokens).toBe(4321);
    expect(p.budget.depth).toBe(3);
    // 其余策略文件不受影响，仍正常加载
    expect(p.governor.rules.length).toBeGreaterThan(0);
    expect(p.context.working_state_never_compress).toBe(true);
  });
});

describe('④ 非法策略拒绝（fail-loud）', () => {
  it('applicability 枚举非法（Maybe）→ loadPolicy 抛错', async () => {
    const dir = await policyFixture({
      'governor.yaml': [
        'rules:',
        '  - id: bad-rule',
        '    when: { applicability: Maybe, evidence_gaps: none, budget_ok: true }',
        '    decision: RunProcess',
        '  - id: default',
        '    decision: Stop',
      ].join('\n'),
    });
    // zod v4 枚举错误消息不回显收到值，断言字段路径（fail-loud 且指明问题字段）
    await expect(loadPolicy(dir)).rejects.toThrow(/applicability/);
  });

  it('budget.yaml 缺字段（无 depth）→ loadPolicy 抛错', async () => {
    const dir = await policyFixture({
      'budget.yaml': [
        'breadth: 4',
        'tools: 12',
        'retrieval: 6',
        'branches: 8',
        'context: 16000',
        'context_budget_tokens: 4000',
      ].join('\n'),
    });
    await expect(loadPolicy(dir)).rejects.toThrow(/depth/);
  });

  it('算子名不在内置集合（FOO）→ loadProcesses 抛错', async () => {
    const dir = await processesFixture({
      'bad-process.yaml': [
        'id: bad-process',
        'version: 1.0.0',
        'entry: FOO',
        'exit: STOP',
        'budget: { tokens: 100 }',
        'operators:',
        '  - id: o1',
        '    op: FOO',
        '    input_binding: {}',
        '    output: x',
        '    cost: { tokens: 10 }',
        '    verification: v',
        '    error: { retryable: false, timeout_ms: 1, cancelable: false, rollback: none }',
        '  - id: o2',
        '    op: STOP',
        '    input_binding: {}',
        '    output: report',
        '    cost: { tokens: 1 }',
        '    verification: v',
        '    error: { retryable: false, timeout_ms: 1, cancelable: false, rollback: none }',
      ].join('\n'),
    });
    await expect(loadProcesses(dir)).rejects.toThrow(/Invalid option/);
  });

  it('entry 与图首算子不一致 → loadProcesses 抛错', async () => {
    const dir = await processesFixture({
      'bad-entry.yaml': [
        'id: bad-entry',
        'version: 1.0.0',
        'entry: RETRIEVE',
        'exit: STOP',
        'budget: { tokens: 100 }',
        'operators:',
        '  - id: o1',
        '    op: STOP',
        '    input_binding: {}',
        '    output: report',
        '    cost: { tokens: 1 }',
        '    verification: v',
        '    error: { retryable: false, timeout_ms: 1, cancelable: false, rollback: none }',
      ].join('\n'),
    });
    await expect(loadProcesses(dir)).rejects.toThrow(/entry/);
  });
});

describe('⑤ 决策表完整性（防漂移：规则集 = 预期组合全集）', () => {
  it('规则集覆盖 applicability × evidence_gaps × budget_ok 全 20 组合，且恰有一条默认规则', async () => {
    const { governor } = await loadPolicy(POLICY_DIR);
    const expected = new Set<string>();
    for (const a of APPLICABILITY) {
      for (const g of EVIDENCE_GAPS) {
        for (const ok of [true, false]) {
          expected.add(`${a}|${g}|${ok}`);
        }
      }
    }
    const covered = new Set(
      governor.rules.filter((r) => r.when).map((r) => `${r.when!.applicability}|${r.when!.evidence_gaps}|${r.when!.budget_ok}`),
    );
    expect(covered).toEqual(expected);

    const defaults = governor.rules.filter((r) => !r.when);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe('default');
  });

  it('5 种 applicability × 缺口状态的 2D 投影全覆盖（每种恰好 budget_ok true/false 两条）', async () => {
    const { governor } = await loadPolicy(POLICY_DIR);
    for (const a of APPLICABILITY) {
      for (const g of EVIDENCE_GAPS) {
        const rules = governor.rules.filter(
          (r) => r.when?.applicability === a && r.when?.evidence_gaps === g,
        );
        expect(rules).toHaveLength(2);
      }
    }
  });

  it('关键语义映射：Strong→RunProcess；缺口→Verify；OOD→GenerateProcess；Failed→ExpandSearch；Contradictory→RetrieveMemory；预算不足→Delegate；默认→Stop', async () => {
    const { governor } = await loadPolicy(POLICY_DIR);
    const decision = (a: string, g: string, ok: boolean): string | undefined =>
      governor.rules.find(
        (r) => r.when?.applicability === a && r.when?.evidence_gaps === g && r.when?.budget_ok === ok,
      )?.decision;
    // 语义五条 + 默认规则（架构 §5.1 / brief）
    expect(decision('Strong', 'none', true)).toBe('RunProcess');
    expect(decision('Strong', 'some', true)).toBe('Verify');
    expect(decision('Partial', 'some', true)).toBe('Verify');
    expect(decision('Partial', 'none', true)).toBe('Stop'); // 候选已现且缺口空 → Stop
    expect(decision('OOD', 'none', true)).toBe('GenerateProcess');
    expect(decision('OOD', 'some', true)).toBe('GenerateProcess');
    expect(decision('Failed', 'none', true)).toBe('ExpandSearch');
    expect(decision('Failed', 'some', true)).toBe('ExpandSearch');
    expect(decision('Contradictory', 'none', true)).toBe('RetrieveMemory');
    expect(decision('Contradictory', 'some', true)).toBe('RetrieveMemory');
    // 预算不足 → Delegate；默认 → Stop
    expect(decision('Strong', 'none', false)).toBe('Delegate');
    expect(decision('OOD', 'some', false)).toBe('Delegate');
    expect(governor.rules.find((r) => r.id === 'default')!.decision).toBe('Stop');
  });
});

describe('⑥ 预算初值合理性', () => {
  it('六维全为正整数；context_budget_tokens > 0', async () => {
    const { budget } = await loadPolicy(POLICY_DIR);
    for (const dim of ['depth', 'breadth', 'tools', 'retrieval', 'branches', 'context'] as const) {
      expect(Number.isInteger(budget[dim])).toBe(true);
      expect(budget[dim]).toBeGreaterThan(0);
    }
    expect(budget.context_budget_tokens).toBeGreaterThan(0);
  });
});

describe('⑦ 公共 API 导出面（防漂移：policy-loader re-export 完整）', () => {
  it('re-export GovernorRuleSchema（值导出，非 undefined）且与契约层同一绑定', async () => {
    const loader = await import('../../kernel/policy-loader.js');
    const contract = await import('../../kernel/schemas/policy.js');
    // T7.2 迁移后 re-export 曾遗漏 GovernorRuleSchema：编译 JS 消费者 import 它得到 undefined → 运行时 TypeError。
    // 测试锁死该导出面：值必须存在，且与契约层为同一绑定（re-export 原样透传，防改名/重定义漂移）。
    expect(loader.GovernorRuleSchema).toBeDefined();
    expect(loader.GovernorRuleSchema).toBe(contract.GovernorRuleSchema);
  });

  it('re-export 的 GovernorRuleSchema 与契约层 GovernorPolicySchema 语义一致（同合法/非法样例同结果）', async () => {
    const loader = await import('../../kernel/policy-loader.js');
    const contract = await import('../../kernel/schemas/policy.js');
    const defaultRule = { id: 'default', decision: 'Stop' };
    const validRule = {
      id: 'semantic-ok',
      when: { applicability: 'Strong', evidence_gaps: 'none', budget_ok: true },
      decision: 'RunProcess',
    };
    const invalidRule = {
      id: 'semantic-bad',
      when: { applicability: 'Strong', evidence_gaps: 'none', budget_ok: true },
      decision: 'NoSuchDecision',
    };
    // 同一合法样例：GovernorRuleSchema 与 GovernorPolicySchema（内嵌规则 schema）均接受
    expect(loader.GovernorRuleSchema.safeParse(validRule).success).toBe(true);
    expect(
      contract.GovernorPolicySchema.safeParse({ rules: [validRule, defaultRule] }).success,
    ).toBe(true);
    // 同一非法样例（decision 越界）：两者均拒绝
    expect(loader.GovernorRuleSchema.safeParse(invalidRule).success).toBe(false);
    expect(
      contract.GovernorPolicySchema.safeParse({ rules: [invalidRule, defaultRule] }).success,
    ).toBe(false);
  });
});

describe('⑧ maintenance_costs（S2 成本数据化：§10.1 estimated_cost 初值 + 观测积累后标定）', () => {
  it('真实 evolve.yaml 含 maintenance_costs 七任务初值（memory+4/candidate+10/repair+25/检查类+2/gc+2）', async () => {
    const p = await loadPolicy(POLICY_DIR);
    expect(p.evolve.maintenance_costs).toEqual({
      memory_consolidation: 4,
      candidate_validation: 10,
      repair: 25,
      promotion_check: 2,
      environment_check: 2,
      evolution_decision: 2,
      gc: 2,
    });
    expect(p.evolve.maintenance_costs).toEqual(DEFAULT_MAINTENANCE_COSTS);
  });

  it('缺省兼容旧形状：无 maintenance_costs 段（仅 §9.5 三字段）→ 出厂初值', async () => {
    const dir = await policyFixture({
      'evolve.yaml': ['daily_evolution_cost: 100', 'roi_min: 1.0', 'maintenance_rate: 0.5'].join('\n'),
    });
    const p = await loadPolicy(dir);
    expect(p.evolve.maintenance_costs).toEqual(DEFAULT_MAINTENANCE_COSTS);
  });

  it('部分键合法：未列任务缺省 = 出厂初值（段内逐键缺省兼容）', async () => {
    const dir = await policyFixture({
      'evolve.yaml': [
        'daily_evolution_cost: 100',
        'roi_min: 1.0',
        'maintenance_rate: 0.5',
        'maintenance_costs:',
        '  gc: 99',
      ].join('\n'),
    });
    const p = await loadPolicy(dir);
    expect(p.evolve.maintenance_costs.gc).toBe(99);
    expect(p.evolve.maintenance_costs.repair).toBe(25);
    expect(p.evolve.maintenance_costs.memory_consolidation).toBe(4);
  });

  it('非法值拒绝（fail-loud）：负数 / 非数值 → loadPolicy 抛错并指明字段', async () => {
    const dirNeg = await policyFixture({
      'evolve.yaml': [
        'daily_evolution_cost: 100',
        'roi_min: 1.0',
        'maintenance_rate: 0.5',
        'maintenance_costs:',
        '  gc: -1',
      ].join('\n'),
    });
    await expect(loadPolicy(dirNeg)).rejects.toThrow(/gc/);
    const dirStr = await policyFixture({
      'evolve.yaml': [
        'daily_evolution_cost: 100',
        'roi_min: 1.0',
        'maintenance_rate: 0.5',
        'maintenance_costs:',
        '  gc: nope',
      ].join('\n'),
    });
    await expect(loadPolicy(dirStr)).rejects.toThrow(/gc/);
  });

  it('改动即生效：evolve.yaml 改 repair 成本 → loadPolicy 返回新值（机制即数据）', async () => {
    const dir = await policyFixture({
      'evolve.yaml': [
        'daily_evolution_cost: 100',
        'roi_min: 1.0',
        'maintenance_rate: 0.5',
        'maintenance_costs:',
        '  repair: 7',
      ].join('\n'),
    });
    const p = await loadPolicy(dir);
    expect(p.evolve.maintenance_costs.repair).toBe(7);
  });

  it('MAINTENANCE_TASK_IDS / DEFAULT_MAINTENANCE_COSTS 公共 API 导出面（policy-loader re-export 完整）', async () => {
    const loader = await import('../../kernel/policy-loader.js');
    const contract = await import('../../kernel/schemas/policy.js');
    expect(loader.DEFAULT_MAINTENANCE_COSTS).toBeDefined();
    expect(loader.DEFAULT_MAINTENANCE_COSTS).toEqual(contract.DEFAULT_MAINTENANCE_COSTS);
    expect(loader.MAINTENANCE_TASK_IDS).toEqual(contract.MAINTENANCE_TASK_IDS);
    expect(loader.MAINTENANCE_TASK_IDS).toEqual([
      'memory_consolidation',
      'candidate_validation',
      'repair',
      'promotion_check',
      'environment_check',
      'evolution_decision',
      'gc',
    ]);
  });
});
