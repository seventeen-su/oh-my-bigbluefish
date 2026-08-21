// T8.4 行为测试：已知过程调度器（runtime/scheduler.ts，架构 §3 ③ scheduler.ts / §5.3）。
// 已知过程（Applicability Strong/Partial）选择 + 过程实例化；OOD 交 Generator（T4.2）；
// 调度结果 → process-adapter → executeGraph（T4.1/M4 loop 先例）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProcesses, type ProcessDef } from '../../kernel/policy-loader.js';
import { ProcessGenerator } from '../../runtime/generator.js';
import { toOperatorGraph } from '../../runtime/process-adapter.js';
import { executeGraph } from '../../runtime/operator.js';
import { ProcessScheduler, type ScheduleTask } from '../../runtime/scheduler.js';

const PROCESSES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../kernel/processes');
const OOD_GOAL = '量子引力 全息对偶';
const DEFAULT_BUDGET = 20000;

let processes: readonly ProcessDef[];

beforeAll(async () => {
  processes = await loadProcesses(PROCESSES_DIR);
  expect(processes.map((p) => p.id).sort()).toEqual(['hypothesize-test', 'retrieve-verify']);
});

afterAll(() => {
  // 进程库为深冻结内存数据，无资源需释放
});

/** 调度任务工厂（缺省空白工作状态） */
function task(over: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    goal: OOD_GOAL,
    state: {},
    ...over,
  };
}

describe('T8.4 已知过程调度（Applicability 选择 + 过程实例化）', () => {
  it('已知过程正确调度：goal 命中 retrieve-verify → kind=known + 过程实例（method=reuse）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: '命中查询' }));

    expect(res.kind).toBe('known');
    expect(res.process?.id).toBe('retrieve-verify');
    expect(res.applicability).toBe('Strong'); // 关键词全覆盖 → Strong
    expect(res.method).toBe('reuse');
    expect(res.reason).toContain('retrieve-verify');
  });

  it('Strong/Partial 选择：两个过程均命中时按库序取首个 Strong/Partial（hypothesize-test 在前）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: '假设 观测' }));

    expect(res.kind).toBe('known');
    expect(res.process?.id).toBe('hypothesize-test'); // 库序（hypothesize-test < retrieve-verify）首个命中
    expect(res.applicability).toBe('Strong'); // 关键词全覆盖 → Strong
  });

  it('Partial 也调度：goal 部分命中 → kind=known + applicability=Partial', async () => {
    const sched = new ProcessScheduler({ processes });
    // 关键词 ['命中查询','无关词']：仅 '命中查询' 命中 retrieve-verify 文本 → 覆盖 0.5（≥0.4 <0.8 → Partial）
    const res = await sched.schedule(task({ goal: '命中查询 无关词' }));

    expect(res.kind).toBe('known');
    expect(res.process?.id).toBe('retrieve-verify');
    expect(res.applicability).toBe('Partial');
  });

  it('已知过程成本超预算 → none + budget reason（不执行超预算过程）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: '命中查询', budget: 1 }));

    expect(res.kind).toBe('none');
    expect(res.reason).toMatch(/budget|预算/);
  });

  it('调度结果 → process-adapter → executeGraph：已知过程经适配器成图并执行成功（M4 loop 先例）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: '命中查询' }));
    expect(res.kind).toBe('known');

    const graph = toOperatorGraph(res.process!);
    const exec = await executeGraph(graph, {
      inputs: { goal: '命中查询', working: { confirmed_facts: ['事实X'], evidence_gaps: [] } },
      budget: DEFAULT_BUDGET,
      registry: {
        VERIFY: {
          async run(ctx) {
            const pack = ctx.inputs['pack'] as { items?: unknown[] } | undefined;
            const items = Array.isArray(pack?.items) ? pack.items : [];
            return { verdict: items.length > 0 ? 'confirmed' : 'refuted', evidence_count: items.length };
          },
        },
      },
      retrieveFn: async () => ({ items: [{ id: 'm1', payload: '记忆1' }] }),
    });

    expect(exec.ok).toBe(true);
    expect(exec.completed).toEqual(['RETRIEVE', 'VERIFY', 'STOP']);
  });
});

describe('T8.4 OOD 交 Generator（未知过程生成路径）', () => {
  it('无已知过程（OOD）→ 交 Generator：注入 llmGenerate → kind=generated + 生成过程（method=generate）', async () => {
    let llmCalls = 0;
    const gen = new ProcessGenerator({
      processes,
      budget: DEFAULT_BUDGET,
      llmGenerate: async () => {
        llmCalls++;
        return {
          id: 'generated-ood',
          version: '1.0.0',
          entry: 'RETRIEVE',
          exit: 'STOP',
          budget: { tokens: 5000, time_ms: 5000 },
          operators: [
            { id: 'retrieve', op: 'RETRIEVE', input_binding: { q: '$.goal', scope: 'Project', kind: 'Semantic' }, output: 'memory_pack', cost: { tokens: 100 }, verification: '检索命中', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' } },
            { id: 'stop', op: 'STOP', input_binding: { state: '$.working', reason: '$.memory_pack' }, output: 'stop_report', cost: { tokens: 100 }, verification: '停止报告', error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '无' } },
          ],
        };
      },
    });
    const sched = new ProcessScheduler({ processes, generator: gen });
    const res = await sched.schedule(task({ goal: OOD_GOAL }));

    expect(llmCalls).toBe(1);
    expect(res.kind).toBe('generated');
    expect(res.process?.id).toBe('generated-ood');
    expect(res.method).toBe('generate');
  });

  it('无已知过程且无 LLM → kind=none + 明确 reason（生成路径受控失败）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: OOD_GOAL }));

    expect(res.kind).toBe('none');
    expect(res.process).toBeNull();
    expect(res.reason.length).toBeGreaterThan(0);
  });

  it('非 OOD 且无已知过程（requires 不满足 → Failed）→ none + reason 指明不触发生成（Governor 决策域）', async () => {
    const sched = new ProcessScheduler({ processes });
    const res = await sched.schedule(task({ goal: '任意目标', requires: ['UNKNOWN_OP'] }));

    expect(res.kind).toBe('none');
    expect(res.reason).toMatch(/Failed|requires|不触发/);
  });
});
