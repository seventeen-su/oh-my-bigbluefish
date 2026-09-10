// 向量编码装配接线测试（对应 docs/known-issues.md《新增向量检索》修复判定）：
//   - 闭环：记忆写入 → 空闲期批量编码（memory_vector_encode 维护任务）→ 向量通道生效（双通道检索）
//   - 观测：状态面 memory_vector 段如实报告 已编码 / 待编码 / 维度 / 嵌入器
//   - CPU 约束：编码路径不发起任何模型调用（无 GPU 依赖、纯 JS；用零调用断言钉住）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import type { Memory } from '../../kernel/schemas/m.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-vec-asm-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

const TS = '2026-01-01T00:00:00.000Z';

function memory(id: string, payload: string, kind = 'Semantic') {
  return {
    ir_version: '2.0',
    id: `memory:${id}`,
    schema: 'omb/M1',
    scope: 'Project',
    kind,
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    prov_class: 'Observation',
    provenance: {
      source: 'test',
      event: `test/${id}`,
      actor: 'test',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: TS,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    payload,
    value_score: 0.5,
    utility_counts: {},
  } as unknown as Memory;
}

describe('向量编码闭环（写入 → 空闲期批量编码 → 向量通道生效）', () => {
  it('写入后待编码 → runVectorEncode 批量编码 → 状态面归零且维度就绪', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000001', '验证契约的边界说明'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000002', '校验约定的范围界定'));
    const before = await rt.status();
    expect(before.memory_vector).toMatchObject({ encoded: 0, pending: 2, dim: null, embedder: 'hash-bow-v1' });

    const r = await rt.runVectorEncode();
    expect(r).toEqual({ encoded: 2, remaining: 0 });
    const after = await rt.status();
    expect(after.memory_vector).toMatchObject({ encoded: 2, pending: 0, dim: 256 });
  });

  it('编码后向量通道参与融合检索（channels_used 含 vector，主通道报告 semantic）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000003', '验证契约的边界说明'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000004', '校验约定的范围界定'));
    await rt.runVectorEncode();
    const hits = await rt.retrieveMemory({ text: '契约边界', scope: 'Project', limit: 5 });
    expect(hits.ok).toBe(true);
    expect(hits.items.length).toBeGreaterThan(0);
    expect(hits.channels_used).toContain('lexical');
    expect(hits.channels_used).toContain('vector');
    expect(hits.channel_used).toBe('semantic');
  });

  it('finalizeTurn 在存在待编码记忆时入队 memory_vector_encode；维护量子消费后待编码归零', async () => {
    const scheduler = new MaintenanceScheduler({
      debtFile: join(root, '.evolution', 'debt.json'),
      batchSize: 16,
    });
    const rt = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000005', '待编码记忆'));
    expect((await rt.status()).memory_vector?.pending).toBe(1);
    await rt.finalizeTurn({
      session_id: 's1',
      decision: { decision: 'Stop', reason: 'test', budget_allocation: {}, expected_gain: 0, snapshot: 'rs:test' } as never,
      working_state: {
        goal: '目标',
        confirmed_facts: [],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: '',
        environment: 'test',
      },
    });
    // 待编码 → 入队 memory_vector_encode；批量消费（本 tick 的入队数 ≤ batchSize）
    const report = await scheduler.tick();
    expect(report.ran).toContain('memory_vector_encode');
    expect((await rt.status()).memory_vector?.pending).toBe(0);
  });

  it('编码路径不发起模型调用（CPU 纯 JS；零调用断言钉住"不占显卡/不争并发"）', async () => {
    let calls = 0;
    const rt = track(
      createCognitiveRuntime({
        root,
        modelAdapter: {
          provider: 'test',
          model: 'fake',
          generate: async () => {
            calls++;
            return { text: 'x' };
          },
        },
      }),
    );
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000006', '向量编码不得调用模型'));
    await rt.runVectorEncode();
    expect(calls).toBe(0);
    expect((await rt.status()).memory_vector).toMatchObject({ encoded: 1, pending: 0 });
  });
});
