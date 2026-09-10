// 关系建图装配接线测试（对应 docs/known-issues.md《关系图为空图》修复判定）：
//   - 闭环：记忆入库 → 空闲期建图（memory_relation_build 维护任务）→ 关系表非空、状态面可见
//   - 判据：图稠密（edges ≥ memories/2）→ needs_build 为 false（不空转）；幂等（重跑不新增重复边）
//   - 工具面：kern_memory op=relations 列出边（含权重/来源/方向）、op=unlink 删边（治理面）
//   - CPU 约束：建图路径不发起任何模型调用（纯 JS；用零调用断言钉住）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { kernMemoryTool } from '../../runtime/kern-tools.js';

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-rel-asm-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    await rt.close();
  }
  await rm(base, { recursive: true, force: true });
});

const TS = '2026-01-01T00:00:00.000Z';

function memory(id: string, payload: string) {
  return {
    ir_version: '2.0',
    id: `memory:${id}`,
    schema: 'omb/M1',
    scope: 'Project',
    kind: 'Semantic',
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

describe('关系建图闭环（入库 → 空闲期建图 → 关系通道有源）', () => {
  it('runRelationBuild 建边 → 统计面 edges > 0 且 needs_build 转 false；重跑幂等', async () => {
    const rt = createCognitiveRuntime({ root });
    runtimes.push(rt);
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000001', '验证契约的边界说明'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000002', '验证契约的边界与口径'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000003', '完全无关的另一段内容'));

    const first = await rt.runRelationBuild();
    expect(first.created).toBeGreaterThan(0);
    expect(first.edges).toBe(first.created);
    const stats = rt.relationStats();
    expect(stats).toMatchObject({ edges: first.created, memories: 3 });
    expect(Object.keys(stats.byType)).toContain('similar');
    expect(Object.keys(stats.bySource).some((s) => s === 'lexical' || s === 'both' || s === 'vector')).toBe(true);
    // 3 条记忆 1 条边 → 1 < floor(3/2)=1? 1 ≥ 1 → 图不再稀疏
    expect(stats.needs_build).toBe(false);

    const second = await rt.runRelationBuild();
    expect(second.created).toBe(0);
    expect(second.edges).toBe(first.edges);
  });

  it('建图路径零模型调用（纯 CPU；不占显卡、不阻塞主对话）', async () => {
    const rt = createCognitiveRuntime({ root });
    runtimes.push(rt);
    let calls = 0;
    // 观测面：任何模型调用都会经过注入的适配器（此处仅建图，不该被调用）
    (rt as unknown as { modelAdapter?: unknown }).modelAdapter = {
      complete: async () => {
        calls++;
        return { text: '' };
      },
    };
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000011', '验证契约的边界说明'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000012', '验证契约的边界与口径'));
    await rt.runRelationBuild();
    expect(calls).toBe(0);
  });

  it('kern_memory op=relations 列出边、op=unlink 删除边（治理面工具接线）', async () => {
    const rt = createCognitiveRuntime({ root });
    runtimes.push(rt);
    const a = 'memory:00000000-0000-4000-8000-000000000021';
    const b = 'memory:00000000-0000-4000-8000-000000000022';
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000021', '验证契约的边界说明'));
    await rt.memory.ingest(memory('00000000-0000-4000-8000-000000000022', '验证契约的边界与口径'));
    await rt.runRelationBuild();
    await rt.memory.link(a, b, 'related');

    const listTool = kernMemoryTool(rt as never);
    const listed = (await listTool.execute({ op: 'relations', id: a, limit: 10 }, {} as never)) as { ok: boolean; text: string };
    expect(listed.ok).toBe(true);
    expect(listed.text).toMatch(/关系边/);
    expect(listed.text).toMatch(/权重/);
    expect(listed.text).toMatch(/来源/);

    const unlinked = (await listTool.execute({ op: 'unlink', id: a, target_id: b, type: 'related' }, {} as never)) as {
      ok: boolean;
      text: string;
    };
    expect(unlinked.ok).toBe(true);
    expect(rt.memory.edgeOf(a, b, 'related')).toBeUndefined();

    const missing = (await listTool.execute({ op: 'unlink', id: a, target_id: b, type: 'related' }, {} as never)) as {
      ok: boolean;
      text: string;
    };
    expect(missing.ok).toBe(false);
    expect(missing.text).toMatch(/不存在/);
  });
});
