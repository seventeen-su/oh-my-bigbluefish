// T8.8 行为测试：Negative Pattern 落库（memory/sql.ts negative_pattern 表 + memory/negative-pattern.ts 存储 +
// runtime/operator-executor.ts 失败样本写入）。
// 整图失败 → 表记录：graph hash/失败算子/错误/环境/时间；provenance 链：表行 → 事件/过程引用（可回溯）。
// 供演化信号（CapabilityGap 输入，§9.2/§10.1）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, makeImmutableId } from '../../kernel/schemas/base.js';
import { NegativePatternBackend, type NegativePatternRecord } from '../../memory/negative-pattern.js';
import { executeGraph, type OperatorGraph } from '../../runtime/operator.js';

let base: string;
let dbPath: string;
let backend: NegativePatternBackend;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-t88-'));
  dbPath = join(base, 'memory.db');
  backend = new NegativePatternBackend(dbPath);
});

afterEach(async () => {
  await backend.close();
  await rm(base, { recursive: true, force: true });
});

/** 单算子图（STOP 抛错 → 整图失败） */
function failingGraph(): OperatorGraph {
  return {
    operators: [
      {
        id: 'STOP', version: '1.0.0', input_binding: {}, output: 'r',
        cost: { tokens: 10 }, side_effect: 'read_only', verification: '',
        error: { retryable: false, timeout_ms: 0, cancelable: false, rollback: '' },
        transaction: false,
      },
    ],
    edges: [],
    entry: 'STOP',
    exit: 'STOP',
  };
}

const graphHashOf = (graph: OperatorGraph): string =>
  `sha256:${createHash('sha256').update(canonicalJson(graph), 'utf8').digest('hex')}`;

describe('T8.8 Negative Pattern 落库（operator-executor → negative_pattern 表）', () => {
  it('整图失败 → 失败样本写入表：graph hash/失败算子/错误/环境/时间 齐全，provenance 可回溯（事件 + 过程引用）', async () => {
    const graph = failingGraph();
    const written: NegativePatternRecord[] = [];
    const res = await executeGraph(graph, {
      inputs: {},
      budget: 1000,
      graphId: 'process/bench-001',
      negativePatternSink: async (r) => written.push(r),
      registry: { STOP: { run: () => Promise.reject(new Error('算子执行崩溃')) } },
    });

    expect(res.failed).toBe(true);
    expect(res.code).toBe('OPERATOR_FAILED');
    // sink 已产出记录
    expect(written).toHaveLength(1);
    const rec = written[0]!;
    expect(rec.graph_hash).toBe(graphHashOf(graph)); // graph hash 一致
    expect(rec.failed_operator).toBe('STOP');
    expect(rec.code).toBe('E_OPERATOR');
    expect(rec.message).toContain('算子执行崩溃');
    expect(rec.environment).toMatchObject({ os: expect.any(String), node: expect.any(String) });
    expect(rec.created).toBeGreaterThan(0);
    // provenance 链：表行 → 事件/过程引用
    expect(rec.provenance.event).toBe('process/operator/failed:STOP');
    expect(rec.provenance.process_ref).toBe('process/bench-001');

    // 落库可查（表行 → 完整保真记录）
    await backend.write(rec);
    const rows = await backend.query({ graph_hash: rec.graph_hash });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(rec);
  });

  it('执行器经注入 sink 直写存储：executeGraph → backend 可查可回溯（provenance 链闭合）', async () => {
    const graph = failingGraph();
    const res = await executeGraph(graph, {
      inputs: {},
      budget: 1000,
      negativePatternSink: async (r) => backend.write(r),
      registry: { STOP: { run: () => Promise.reject(new Error('boom')) } },
    });
    expect(res.failed).toBe(true);

    // 表行可查：按 graph_hash / failed_operator / code 过滤
    const byGraph = await backend.query({ graph_hash: graphHashOf(graph) });
    expect(byGraph).toHaveLength(1);
    const byOp = await backend.query({ failed_operator: 'STOP' });
    expect(byOp).toHaveLength(1);
    const byCode = await backend.query({ code: 'E_OPERATOR' });
    expect(byCode).toHaveLength(1);
    // 回溯：表行 provenance 指向事件与过程
    expect(byGraph[0]!.provenance.event).toBe('process/operator/failed:STOP');
    expect(byGraph[0]!.provenance.graph_hash).toBe(graphHashOf(graph));
  });

  it('整图级失败（预算不足，无算子运行）也记录：failed_operator=graph', async () => {
    const graph = failingGraph();
    const written: NegativePatternRecord[] = [];
    const res = await executeGraph(graph, {
      inputs: {},
      budget: 1,
      negativePatternSink: async (r) => written.push(r),
    });

    expect(res.failed).toBe(true);
    expect(res.code).toBe('BUDGET_EXCEEDED');
    expect(written).toHaveLength(1);
    expect(written[0]!.failed_operator).toBe('graph');
    expect(written[0]!.code).toBe('BUDGET_EXCEEDED');
  });

  it('同失败重复 → 内容寻址幂等（同 id 不重复入库）；无 sink 注入 → 不抛错（既有行为）', async () => {
    const graph = failingGraph();
    const res1 = await executeGraph(graph, {
      inputs: {}, budget: 1000, graphId: 'p1',
      negativePatternSink: async (r) => backend.write(r),
      registry: { STOP: { run: () => Promise.reject(new Error('boom')) } },
    });
    const res2 = await executeGraph(graph, {
      inputs: {}, budget: 1000, graphId: 'p1',
      negativePatternSink: async (r) => backend.write(r),
      registry: { STOP: { run: () => Promise.reject(new Error('boom')) } },
    });
    expect(res1.failed).toBe(true);
    expect(res2.failed).toBe(true);
    expect(await backend.count()).toBe(1); // 同失败内容 → 同 id → 幂等（INSERT OR IGNORE）

    // 无 sink → 不抛错（既有行为；注册表注入失败算子仍失败）
    const res3 = await executeGraph(graph, {
      inputs: {}, budget: 1000,
      registry: { STOP: { run: () => Promise.reject(new Error('boom')) } },
    });
    expect(res3.failed).toBe(true);
  });
});
