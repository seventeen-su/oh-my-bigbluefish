// T8.19 行为测试：首个机制组件（组件化闭环验证；架构 §11.3 Component registration + 施工计划 T8.19）。
// 组件注册表 ABI：manifest（声明）/ inject（注入依赖）/ effect（激活后能力）/ disposer（清理）。
// 复用 T8.6 ComponentRegistrationTransaction 语义：注册集原子性（任一激活失败 → 全部 dispose 回滚）、
// 幂等键 manifest_id 唯一、dispose 幂等。
// 验收（brief）：组件注册/激活/回滚测试通过（复用 T8.6 事务语义）；组件经装配可被调用（effect 生效）。
// fixture：mkdtemp 临时 db（不动真实 workspace/.omb/memory.db，CONVENTIONS §6）。
// Windows 注意：WAL 侧车文件锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { RetrievalBackend } from '../../memory/backend-retrieval.js';
import { ComponentRegistry } from '../../components/registry.js';
import { memoryRetrievalComponent, type MemoryRetrievalEffect } from '../../components/memory-retrieval.js';
import { PROV, TS } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: RetrievalBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-t819-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

/** 创建 backend 并注册（afterEach 先 close 再删目录——Windows WAL 文件锁） */
function openBackend(dbPath: string): RetrievalBackend {
  const b = new RetrievalBackend(dbPath);
  backends.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** M1 Memory 工厂（六计数器默认全 0；provenance.event 每次唯一——幂等键） */
function makeMemory(over: Record<string, unknown> = {}): Memory {
  return {
    ir_version: '2.0',
    id: makeMutableId('memory'),
    schema: 'omb/M1',
    scope: 'Project',
    lifecycle: 'Active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: { ...PROV, event: makeMutableId('evt') },
    refs: [],
    kind: 'Semantic',
    prov_class: 'Observation',
    payload: '默认记忆内容',
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
    ...over,
  } as unknown as Memory;
}

describe('T8.19 组件注册表 ABI（manifest/inject/effect/disposer；复用 T8.6 事务语义）', () => {
  it('未激活时 get → null（effect 不提前泄露）', () => {
    const registry = new ComponentRegistry();
    expect(registry.get<MemoryRetrievalEffect>('component:memory-retrieval')).toBeNull();
  });

  it('重复 manifest_id 注册 → fail-loud（幂等键唯一，T8.6 语义）', () => {
    const registry = new ComponentRegistry();
    // 占位 deps（register 阶段 create 仅捕获注入，不触碰 backend 实例）
    const deps = { memory: {} as RetrievalBackend };
    registry.register(memoryRetrievalComponent, deps);
    expect(() => registry.register(memoryRetrievalComponent, deps)).toThrow(/重复|manifest_id/);
  });
});

describe('T8.19 记忆检索组件（首个机制组件：inject=memory backend，effect=检索能力，disposer=关闭）', () => {
  it('组件注册/激活 → effect.retrieve 经装配可被调用（检索到已摄入记忆）', async () => {
    const backend = openBackend(await tmpDb());
    await backend.ingest(makeMemory({ payload: 'zebra-config-77 组件配置' }));

    const registry = new ComponentRegistry();
    registry.register(memoryRetrievalComponent, { memory: backend });
    expect(registry.get<MemoryRetrievalEffect>('component:memory-retrieval')).toBeNull(); // 激活前不可用

    await registry.activate();

    const effect = registry.get<MemoryRetrievalEffect>('component:memory-retrieval');
    expect(effect).not.toBeNull();
    const result = await effect!.retrieve(
      { scope: 'Project', text: 'zebra', limit: 5, budget: 1000 },
      { episode: false },
    );
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.memory.payload).toContain('zebra-config-77');
    expect(effect!.isActive()).toBe(true);
  });

  it('激活失败回滚：A 激活 ok + B 激活抛错 → activate 拒绝 → 已注册全部 dispose（批量回滚，不残留半激活）且无 effect 泄露', async () => {
    const registry = new ComponentRegistry();
    const disposed: string[] = [];
    registry.register(
      {
        manifest: { manifest_id: 'comp:ok', name: 'ok', version: '1.0.0', inject: [], provides: [] },
        create: () => ({ effect: { id: 'ok' }, disposer: () => { disposed.push('ok'); } }),
      },
      {},
    );
    registry.register(
      {
        manifest: { manifest_id: 'comp:fail', name: 'fail', version: '1.0.0', inject: [], provides: [] },
        create: () => ({
          activate: () => { throw new Error('B 激活失败'); },
          effect: { id: 'fail' },
          disposer: () => { disposed.push('fail'); },
        }),
      },
      {},
    );

    await expect(registry.activate()).rejects.toThrow(/B 激活失败/);
    expect(disposed.sort()).toEqual(['fail', 'ok']); // 批量回滚：A 也被 dispose（不留下半激活状态）
    expect(registry.get('comp:ok')).toBeNull();
    expect(registry.get('comp:fail')).toBeNull(); // 失败 → 不暴露任何 effect
  });

  it('disposeAll 幂等：每个 disposer 至多一次；释放后 effect 调用 fail-loud', async () => {
    const registry = new ComponentRegistry();
    const backend = openBackend(await tmpDb());
    let disposed = 0;
    registry.register(
      {
        manifest: { manifest_id: 'comp:once', name: 'once', version: '1.0.0', inject: [], provides: [] },
        create: () => ({
          effect: { ping: () => 'pong' },
          disposer: () => { disposed += 1; },
        }),
      },
      {},
    );
    await registry.activate();
    expect(registry.get('comp:once')).not.toBeNull();

    await registry.disposeAll();
    await registry.disposeAll(); // 幂等
    expect(disposed).toBe(1);
    expect(registry.get('comp:once')).toBeNull(); // 释放后不可再取

    // 记忆检索组件：dispose 后 effect 调用 fail-loud（句柄已关闭）
    const reg2 = new ComponentRegistry();
    reg2.register(memoryRetrievalComponent, { memory: backend });
    await reg2.activate();
    const effect = reg2.get<MemoryRetrievalEffect>('component:memory-retrieval')!;
    await reg2.disposeAll();
    expect(effect.isActive()).toBe(false);
    await expect(
      effect.retrieve({ scope: 'Project', text: 'zebra', limit: 5, budget: 1000 }, { episode: false }),
    ).rejects.toThrow(/未激活|dispose|释放/);
  });
});
