// T3.3 行为测试：记忆整合批处理 consolidation（架构 §7.2 空闲期 consolidation / §7.4 八算子
// Condense=dedup+merge、Associate=relation、Decay=Forget 数值机制 / §7.1 更新局部化 Contract 四问）。
// 覆盖：dedup→Frozen、merge+Link、relation 邻接表、decay 阈值迁移、幂等重跑、影响域标记、
// 经 scheduler 接口入队、空库。
// fixture：mkdtemp 临时 db（T3.1 backend）；now 显式传入（consolidate opts.now）使阈值判定
// 与墙钟解耦——fixture 时间戳以 NOW=2026-08-21 为锚。
// Windows 注意（T1.3 经验）：WAL 侧车文件在连接未关闭时被锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Memory, MemoryKind, MemoryLifecycle, MemoryProvClass } from '../../kernel/schemas/m.js';
import { makeMutableId, type Scope } from '../../kernel/schemas/base.js';
import { SqliteMemoryBackend } from '../../memory/backend.js';
import {
  consolidate,
  createDirectScheduler,
  type MaintenanceScheduler,
} from '../../memory/consolidate.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const dbPaths: string[] = [];
const backends: SqliteMemoryBackend[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-con-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): SqliteMemoryBackend {
  const b = new SqliteMemoryBackend(dbPath);
  backends.push(b);
  return b;
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** M1 Memory 工厂：provenance.event 每次唯一（幂等键）；over 覆盖字段（updated 控制衰减/保留顺序） */
function makeMemory(over: {
  payload: string;
  updated?: string;
  kind?: MemoryKind;
  prov_class?: MemoryProvClass;
  scope?: Scope;
  lifecycle?: MemoryLifecycle;
}): Memory {
  const updated = over.updated ?? TS;
  return {
    ...base({ id: makeMutableId('memory'), schema: 'omb/M1' }),
    scope: over.scope ?? 'Project',
    lifecycle: over.lifecycle ?? 'Active',
    immutable: false,
    owner: 'kernel',
    created: updated,
    updated,
    provenance: { ...PROV, event: makeMutableId('evt'), timestamp: updated },
    refs: [],
    kind: over.kind ?? 'Semantic',
    prov_class: over.prov_class ?? 'Observation',
    payload: over.payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
}

/** 只读检查 memory_relation 表（测试自开连接，即开即关） */
function relationRows(dbPath: string): [string, string, string][] {
  const conn = new DatabaseSync(dbPath);
  try {
    const rows = conn.prepare('SELECT from_id, to_id, type FROM memory_relation').all() as unknown as {
      from_id: string;
      to_id: string;
      type: string;
    }[];
    return rows.map((r) => [r.from_id, r.to_id, r.type] as [string, string, string]).sort();
  } finally {
    conn.close();
  }
}

describe('consolidate（§7.2 空闲期批处理）', () => {
  it('dedup：同 scope+kind 规范化内容相同 → 保留最新（updated），其余 Frozen', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const old = makeMemory({ payload: '重复 内容', updated: '2026-08-01T00:00:00.000Z' });
    const fresh = makeMemory({ payload: '重复  内容', updated: '2026-08-20T00:00:00.000Z' }); // 折叠空白后与 old 相同
    await b.ingest(old);
    await b.ingest(fresh);
    const report = await consolidate(b, { now: NOW });
    expect(report.deduped).toBe(1);
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(page.total).toBe(2);
    const active = page.items.filter((m) => m.lifecycle === 'Active');
    const frozen = page.items.filter((m) => m.lifecycle === 'Frozen');
    expect(active).toHaveLength(1);
    expect(frozen).toHaveLength(1);
    expect(active[0]?.id).toBe(fresh.id); // 保留最新
    expect(frozen[0]?.id).toBe(old.id);
  });

  it('merge：同 scope/kind/prov_class 包含关系文本 → 合并新记忆 + relation Link，旧项 Frozen', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const a = makeMemory({ payload: '核心结论', updated: '2026-08-10T00:00:00.000Z' });
    const bm = makeMemory({ payload: '核心结论 补充细节', updated: '2026-08-15T00:00:00.000Z' });
    await b.ingest(a);
    await b.ingest(bm);
    const report = await consolidate(b, { now: NOW });
    expect(report.merged).toBe(2); // 两个源记忆被并入（Frozen）
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(page.total).toBe(3); // 合并新记忆 + 2 Frozen 旧项
    const active = page.items.filter((m) => m.lifecycle === 'Active');
    expect(active).toHaveLength(1);
    const merged = active[0]!;
    expect(merged.payload).toContain('核心结论');
    expect(merged.payload).toContain('补充细节');
    const frozen = page.items.filter((m) => m.lifecycle === 'Frozen');
    expect(frozen).toHaveLength(2);
    // relation Link：merged → 被合并项（type 'merged'）
    const walk = await b.relationTraverse(merged.id, ['merged'], 1);
    const toIds = walk.nodes.find((n) => n.id === merged.id)?.relations.map((r) => r.to_id).sort() ?? [];
    expect(toIds).toEqual([a.id, bm.id].sort());
  });

  it('relation 构建：按邻接表为同 scope 记忆建 relation（Decision→Experience）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const dec = makeMemory({ payload: '采用 SQLite 存储', kind: 'Decision' });
    const exp = makeMemory({ payload: 'SQLite 实测通过', kind: 'Episodic' }); // 经验记忆维度 = Episodic（brief 示例 'Experience' 不在 MemoryKindEnum）
    await b.ingest(dec);
    await b.ingest(exp);
    const report = await consolidate(b, { now: NOW });
    expect(report.related).toBe(1);
    const walk = await b.relationTraverse(dec.id, ['informs'], 1);
    const toIds = walk.nodes.find((n) => n.id === dec.id)?.relations.map((r) => r.to_id) ?? [];
    expect(toIds).toContain(exp.id);
  });

  it('decay：Active 超 90 天 → Dormant；超 365 天 → Frozen；新鲜记忆不变', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    // 三素材 payload 两两互不包含（避免 merge 包含规则误吞 decay 素材）
    const dormant = makeMemory({ payload: '百天前的经验总结', updated: new Date(NOW - 100 * DAY).toISOString() });
    const frozen = makeMemory({ payload: '久远时代的工具记录', updated: new Date(NOW - 400 * DAY).toISOString() });
    const fresh = makeMemory({ payload: '最新确认的配置', updated: new Date(NOW - 10 * DAY).toISOString() });
    await b.ingest(dormant);
    await b.ingest(frozen);
    await b.ingest(fresh);
    const report = await consolidate(b, { now: NOW });
    expect(report.decayed).toBe(2);
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    const byId = new Map(page.items.map((m) => [m.id, m.lifecycle]));
    expect(byId.get(dormant.id)).toBe('Dormant');
    expect(byId.get(frozen.id)).toBe('Frozen');
    expect(byId.get(fresh.id)).toBe('Active');
  });

  it('幂等：consolidate 跑两次 → 第二次全 0 报告，DB 状态不变', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await b.ingest(makeMemory({ payload: '重复内容', updated: '2026-08-01T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '重复内容', updated: '2026-08-20T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '核心结论', updated: '2026-08-10T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '核心结论 补充', updated: '2026-08-15T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '决策 A', kind: 'Decision' }));
    await b.ingest(makeMemory({ payload: '经验 A', kind: 'Episodic' }));
    await b.ingest(makeMemory({ payload: '久远时代的工具记录', updated: new Date(NOW - 400 * DAY).toISOString() }));

    const r1 = await consolidate(b, { now: NOW });
    expect(r1.deduped + r1.merged + r1.related + r1.decayed).toBeGreaterThan(0);

    const page1 = await b.query({ scope: 'Project', limit: 100, budget: 1e9 });
    const life1 = page1.items.map((m) => [m.id, m.lifecycle] as [string, string]).sort();
    const rel1 = relationRows(db);

    const r2 = await consolidate(b, { now: NOW });
    expect(r2).toEqual({ deduped: 0, merged: 0, related: 0, decayed: 0, affected_scopes: [], impact: [] });

    const page2 = await b.query({ scope: 'Project', limit: 100, budget: 1e9 });
    const life2 = page2.items.map((m) => [m.id, m.lifecycle] as [string, string]).sort();
    const rel2 = relationRows(db);
    expect(life2).toEqual(life1);
    expect(rel2).toEqual(rel1);
  });

  it('影响域标记：report.impact 含受影响查询路由（scope+kind 推断）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await b.ingest(makeMemory({ payload: '重复A', updated: '2026-08-01T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '重复A', updated: '2026-08-20T00:00:00.000Z' }));
    const report = await consolidate(b, { now: NOW });
    expect(report.affected_scopes).toContain('Project');
    expect(report.impact.length).toBeGreaterThan(0);
    const routes = report.impact.flatMap((r) => r.query_affected);
    expect(routes).toContain('Project/Semantic');
    for (const rec of report.impact) {
      expect(rec.scope).toBe('Project');
      expect(Array.isArray(rec.modules_affected)).toBe(true);
      expect(rec.modules_affected.length).toBeGreaterThan(0);
      expect(typeof rec.regression_needed).toBe('boolean');
      expect(typeof rec.note).toBe('string');
    }
  });

  it('经 scheduler 接口：记录型 scheduler 验证入队并执行；createDirectScheduler 直接执行', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await b.ingest(makeMemory({ payload: '重复X', updated: '2026-08-01T00:00:00.000Z' }));
    await b.ingest(makeMemory({ payload: '重复X', updated: '2026-08-20T00:00:00.000Z' }));
    const enqueued: string[] = [];
    const scheduler: MaintenanceScheduler = {
      async enqueue(task) {
        enqueued.push(task.id);
        await task.run();
      },
    };
    const report = await consolidate(b, { now: NOW, scheduler });
    expect(enqueued).toEqual(['memory-consolidation']);
    expect(report.deduped).toBe(1);

    // 最小实现 createDirectScheduler 同样可用
    const db2 = await tmpDb();
    const b2 = openBackend(db2);
    await b2.ingest(makeMemory({ payload: '重复Y', updated: '2026-08-01T00:00:00.000Z' }));
    await b2.ingest(makeMemory({ payload: '重复Y', updated: '2026-08-20T00:00:00.000Z' }));
    const r2 = await consolidate(b2, { now: NOW, scheduler: createDirectScheduler() });
    expect(r2.deduped).toBe(1);
  });

  it('空库：全 0 报告，无异常', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const report = await consolidate(b, { now: NOW });
    expect(report).toEqual({ deduped: 0, merged: 0, related: 0, decayed: 0, affected_scopes: [], impact: [] });
  });
});

/**
 * 批次上限与可中断（已知问题《记忆整合没有真实批次上限》/《12 个维护任务里只有 1 个真正可被中断》）。
 * 取向：**保持单次调用原子**（一个事务、要么全提交要么全回滚），但单次处理量受预算封顶
 * （超出部分留给下一次），且整合链的每个处理单元之间检查中断信号。
 */
describe('整合批次上限与可中断（有界事务 / 逐单元中断）', () => {
  /** 构造 N 条需要 dedup 的同内容重复记忆（每条都可独立观测是否被处理） */
  async function seedDuplicates(b: SqliteMemoryBackend, n: number, scope: Scope = 'Project'): Promise<void> {
    for (let i = 0; i < n; i++) {
      await b.ingest(
        makeMemory({
          payload: `重复内容-批次`,
          updated: new Date(NOW - (n - i) * DAY).toISOString(),
          scope,
        }),
      );
    }
  }

  it('预算生效：单次只处理预算内的记忆（有界事务），被截断时如实上报', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await seedDuplicates(b, 6);
    const outcome: Array<{ processed: number; budget_exhausted: boolean; dirty: boolean }> = [];
    const report = await consolidate(b, {
      now: NOW,
      budget: { maxMemoriesPerRun: 2, scopeOffset: 0 },
      onOutcome: (o) =>
        outcome.push({ processed: o.processed, budget_exhausted: o.budget_exhausted, dirty: o.dirty }),
    });
    // 预算 2 → 本次"整条载入"最多 2 条（Project），超出的留给下一次调用；被截断 → 如实上报
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.processed).toBe(2);
    expect(outcome[0]!.budget_exhausted).toBe(true);
    // dedup 走轻量键列（不占批预算，且是收敛所必需的）→ 本次把 6 条里的 5 条重复冻结
    expect(report.deduped).toBe(5);
    expect(outcome[0]!.dirty).toBe(true);
    // 报告形状仍是稳定契约（不含预算元数据）
    expect(Object.keys(report).sort()).toEqual(
      ['affected_scopes', 'decayed', 'deduped', 'impact', 'merged', 'related'].sort(),
    );
  });

  it('预算截断后继续推进：反复调用收敛到终态（不永停在一批，也不重复计数）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await seedDuplicates(b, 6);
    let offset = 0;
    let processedTotal = 0;
    let dedupedTotal = 0;
    // 预算小于库容 → 单次只能看到一部分；反复调用（轮转推进）直到不再产生新改动
    for (let round = 0; round < 10; round++) {
      const report = await consolidate(b, {
        now: NOW,
        budget: { maxMemoriesPerRun: 3, scopeOffset: offset },
        onOutcome: (o) => {
          offset = o.next_scope_offset;
          processedTotal += o.processed;
          if (!o.dirty) return;
        },
      });
      dedupedTotal += report.deduped;
      if (report.deduped === 0 && report.merged === 0) break;
    }
    // 全部 6 条都被读到过（轮转 + 预算不导致饿死）
    expect(processedTotal).toBeGreaterThanOrEqual(6);
    const page = await b.query({ scope: 'Project', limit: 50, budget: 1000 });
    // 收敛终态：同内容只留最新 1 条 Active，其余 Frozen（不会重复冻结同一条）
    expect(page.items.filter((m) => m.lifecycle === 'Active')).toHaveLength(1);
    expect(dedupedTotal).toBe(5);
  });

  it('可中断：整合链中途 abort → 抛 AbortError 且事务回滚（不留半整合状态）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await seedDuplicates(b, 6);
    const controller = new AbortController();
    // 一进入整合就中断（在 scope 循环的第一个断言点触发）
    controller.abort();
    await expect(
      consolidate(b, {
        now: NOW,
        budget: { maxMemoriesPerRun: 100, scopeOffset: 0, signal: controller.signal },
      }),
    ).rejects.toThrow(/interrupt|中断/u);
    // 事务回滚：没有任何记忆被冻结（"要么全做要么全不做"的单次原子语义保持）
    const page = await b.query({ scope: 'Project', limit: 50, budget: 1000 });
    expect(page.items.filter((m) => m.lifecycle === 'Frozen')).toHaveLength(0);
    expect(page.items.filter((m) => m.lifecycle === 'Active')).toHaveLength(6);
  });

  it('中断后重跑收敛一致：幂等不变量不受中断影响（重跑得到与从未中断相同的终态）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await seedDuplicates(b, 6);
    const controller = new AbortController();
    controller.abort();
    await consolidate(b, {
      now: NOW,
      budget: { maxMemoriesPerRun: 100, signal: controller.signal },
    }).catch(() => undefined);
    // 重跑（无 signal）→ 收敛到应有终态
    const report = await consolidate(b, { now: NOW, budget: { maxMemoriesPerRun: 100 } });
    expect(report.deduped).toBe(5);
    const page = await b.query({ scope: 'Project', limit: 50, budget: 1000 });
    expect(page.items.filter((m) => m.lifecycle === 'Frozen')).toHaveLength(5);
    expect(page.items.filter((m) => m.lifecycle === 'Active')).toHaveLength(1);
  });

  it('无预算参数 → 缺省预算（2000）下的行为与旧实现一致（小库不受影响）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    await seedDuplicates(b, 4);
    const report = await consolidate(b, { now: NOW });
    expect(report.deduped).toBe(3);
    const page = await b.query({ scope: 'Project', limit: 50, budget: 1000 });
    expect(page.items.filter((m) => m.lifecycle === 'Active')).toHaveLength(1);
  });
});
