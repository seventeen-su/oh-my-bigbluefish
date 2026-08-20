// T1.3 行为测试：Event Store（WAL 追加写，架构 §12.1 Event / §11.3 事务模型）。
// 覆盖：追加+读取、appendMany 原子性（非法事件整批回滚）、类型枚举（M3 schema 校验）、
// query 过滤（type/session_id/时间范围/limit/seq 游标分页）、投影派生（独立 projections 表 + 自动派生）、
// compaction 不丢投影（31 天前事件删除、投影永久）、compact 幂等、重复 id 拒绝。
// fixture：mkdtemp 临时 db 文件（不动真实 workspace/.omb/events.db，CONVENTIONS §6）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Event } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { EventStore, deriveProjection } from '../../supervisor/event-store.js';
import { PROV, TS } from './ir-samples.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse(TS);

const dbPaths: string[] = [];
const stores: EventStore[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-events-')), 'events.db');
  dbPaths.push(db);
  return db;
}

/** 创建 store 并注册（afterEach 先 close 再删目录——Windows 上未关闭的 WAL 连接锁住 -shm/-wal 文件，rm 会 EBUSY） */
function openStore(dbPath: string): EventStore {
  const store = new EventStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** ISO 时间：NOW 偏移 offsetMs */
function ts(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

/** M3 Event 工厂（over 覆盖任意字段）；id 默认唯一 evt:uuid */
function makeEvent(over: Record<string, unknown> = {}): Event {
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: PROV,
    refs: [],
    type: 'session/start',
    session_id: 'sess-1',
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: 'c:1',
    payload: { note: 'x' },
    timestamp: TS,
    ...over,
  } as unknown as Event;
}

describe('追加 + 读取（WAL 追加写）', () => {
  it('append 若干事件 → read/count 正确；db 文件落盘且为 WAL 模式', async () => {
    const dbPath = await tmpDb();
    const store = openStore(dbPath);
    const e1 = makeEvent({ type: 'session/start', session_id: 'sess-1' });
    const e2 = makeEvent({ type: 'tool/call', session_id: 'sess-1' });
    await store.append(e1);
    await store.append(e2);

    expect(await store.count()).toBe(2);
    expect(await store.read(e1.id)).toEqual(e1);
    expect(await store.read(e2.id)).toEqual(e2);
    expect(await store.read('no-such-id')).toBeNull();
    expect(existsSync(dbPath)).toBe(true);

    // WAL 模式是持久 pragma：store 关闭后新连接读 journal_mode 仍为 wal
    await store.close();
    const check = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      expect(check.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    } finally {
      check.close();
    }
  });

  it('close 幂等：连调两次不抛错', async () => {
    const store = openStore(await tmpDb());
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe('appendMany 原子性（事务回滚）', () => {
  it('批量中一个非法事件 → 整批拒绝，count 不变，投影也不写入', async () => {
    const store = openStore(await tmpDb());
    const good1 = makeEvent({ type: 'session/start' });
    const bad = makeEvent({ type: 'bogus/type' });
    const good2 = makeEvent({ type: 'tool/call' });

    await expect(store.appendMany([good1, bad, good2])).rejects.toThrow();
    expect(await store.count()).toBe(0);
    expect((await store.queryProjections()).projections).toHaveLength(0);
  });

  it('批量内含重复 id → 整批拒绝（UNIQUE 冲突回滚）', async () => {
    const store = openStore(await tmpDb());
    const e = makeEvent({ type: 'claim/update' });
    const other = makeEvent({ type: 'decision/made' });
    await expect(store.appendMany([e, other, e])).rejects.toThrow();
    expect(await store.count()).toBe(0);
  });
});

describe('类型枚举（M3 schema 校验）', () => {
  it('合法类型全部通过：固定段 + 通配段', async () => {
    const store = openStore(await tmpDb());
    const legal = [
      'session/start',
      'session/end',
      'tool/call',
      'tool/result',
      'claim/update',
      'hypothesis/transition',
      'decision/made',
      'contradiction/found',
      'memory/admitted',
      'memory/consolidated',
      'checkpoint/saved',
      'activation/committed',
      'maintenance/quantum',
      'process/operator/retrieve',
      'evolution/commit',
    ];
    for (const type of legal) {
      await expect(store.append(makeEvent({ type }))).resolves.toBeUndefined();
    }
    expect(await store.count()).toBe(legal.length);
  });

  it('非法类型拒绝且不落库：未知段 / 多段 / 大写 / 空尾段', async () => {
    const store = openStore(await tmpDb());
    const illegal = [
      'bogus/type',
      'session/foo',
      'tool/call/x',
      'Evolution/commit',
      'evolution/',
      'process/operator/9x',
    ];
    for (const type of illegal) {
      await expect(store.append(makeEvent({ type }))).rejects.toThrow();
    }
    expect(await store.count()).toBe(0);
  });
});

describe('query 过滤与游标分页', () => {
  // 5 个事件：2 个 sess-1 + 3 个 sess-2；type 混合；时间 NOW..NOW+4h（seq 顺序 = 追加顺序）
  let events: Event[];
  let store: EventStore;

  async function setup(): Promise<EventStore> {
    store = openStore(await tmpDb());
    events = [
      makeEvent({ type: 'session/start', session_id: 'sess-1', timestamp: ts(0) }),
      makeEvent({ type: 'tool/call', session_id: 'sess-1', timestamp: ts(1 * 3600_000) }),
      makeEvent({ type: 'tool/call', session_id: 'sess-2', timestamp: ts(2 * 3600_000) }),
      makeEvent({ type: 'decision/made', session_id: 'sess-2', timestamp: ts(3 * 3600_000) }),
      makeEvent({ type: 'tool/call', session_id: 'sess-1', timestamp: ts(4 * 3600_000) }),
    ];
    await store.appendMany(events);
    return store;
  }

  it('按 type 过滤', async () => {
    const s = await setup();
    const r = await s.query({ type: 'tool/call' });
    expect(r.events.map((e) => e.id)).toEqual([events[1]!.id, events[2]!.id, events[4]!.id]);
    expect(r.next_cursor).toBeUndefined();
  });

  it('按 session_id 过滤', async () => {
    const s = await setup();
    const r = await s.query({ session_id: 'sess-2' });
    expect(r.events.map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
  });

  it('按时间范围过滤（from_ts/to_ts 闭区间）', async () => {
    const s = await setup();
    const r = await s.query({ from_ts: NOW + 1.5 * 3600_000, to_ts: NOW + 3.5 * 3600_000 });
    expect(r.events.map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
  });

  it('组合过滤（type + session_id + 范围）', async () => {
    const s = await setup();
    const r = await s.query({
      type: 'tool/call',
      session_id: 'sess-1',
      from_ts: NOW + 0.5 * 3600_000,
      to_ts: NOW + 4.5 * 3600_000,
    });
    expect(r.events.map((e) => e.id)).toEqual([events[1]!.id, events[4]!.id]);
  });

  it('limit + seq 游标分页：next_cursor 指示下一页，末页无 next_cursor', async () => {
    const s = await setup();
    const p1 = await s.query({ limit: 2 });
    expect(p1.events.map((e) => e.id)).toEqual([events[0]!.id, events[1]!.id]);
    expect(p1.next_cursor).toBeTypeOf('number');

    const p2 = await s.query({ limit: 2, cursor: p1.next_cursor });
    expect(p2.events.map((e) => e.id)).toEqual([events[2]!.id, events[3]!.id]);
    expect(p2.next_cursor).toBeTypeOf('number');

    const p3 = await s.query({ limit: 2, cursor: p2.next_cursor });
    expect(p3.events.map((e) => e.id)).toEqual([events[4]!.id]);
    expect(p3.next_cursor).toBeUndefined();
  });

  it('limit 恰好等于剩余行数 → 无 next_cursor（无更多页）', async () => {
    const s = await setup();
    const r = await s.query({ limit: 5 });
    expect(r.events).toHaveLength(5);
    expect(r.next_cursor).toBeUndefined();
  });

  it('无过滤 query 返回全部（追加顺序）', async () => {
    const s = await setup();
    const r = await s.query({});
    expect(r.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });
});

describe('投影派生（独立 projections 表，永久）', () => {
  it('deriveProjection 纯函数：type 前缀 projection/，summary 去 payload 细节', async () => {
    const e = makeEvent({ type: 'memory/admitted', session_id: 'sess-9', payload: { secret: 'full' } });
    const proj = deriveProjection(e);
    expect(proj.type).toBe('projection/memory/admitted');
    expect(proj.session_id).toBe('sess-9');
    expect(proj.timestamp).toBe(NOW);
    expect(proj.summary).not.toHaveProperty('payload'); // 精简：去 payload 细节
    expect(proj.summary).not.toHaveProperty('provenance');
    expect(proj.summary).toMatchObject({ id: e.id, type: 'memory/admitted', session_id: 'sess-9' });
  });

  it('append 原始事件 → 自动派生投影写入 projections；queryProjections 正确', async () => {
    const store = openStore(await tmpDb());
    const e1 = makeEvent({ type: 'session/start', session_id: 'sess-a' });
    const e2 = makeEvent({ type: 'tool/call', session_id: 'sess-b' });
    await store.append(e1);
    await store.append(e2);

    const all = await store.queryProjections();
    expect(all.projections).toHaveLength(2);
    expect(all.projections.map((p) => p.type)).toEqual(['projection/session/start', 'projection/tool/call']);
    const p1 = all.projections[0]!;
    expect(p1.session_id).toBe('sess-a');
    expect(p1.timestamp).toBe(NOW);
    expect(p1.summary.id).toBe(e1.id);

    // 过滤查询
    const filtered = await store.queryProjections({ type: 'projection/tool/call' });
    expect(filtered.projections).toHaveLength(1);
    expect(filtered.projections[0]!.summary.id).toBe(e2.id);
  });
});

describe('compaction（retention 原始 30 天 + 投影永久）', () => {
  it('31 天前事件被删、投影仍在；30 天内事件保留', async () => {
    const store = openStore(await tmpDb());
    const old = makeEvent({ type: 'session/start', session_id: 'sess-old', timestamp: ts(-31 * DAY_MS) });
    const recent = makeEvent({ type: 'session/end', session_id: 'sess-new', timestamp: ts(-1 * DAY_MS) });
    await store.append(old);
    await store.append(recent);

    const r = await store.compact(NOW, 30);
    expect(r.removed).toBe(1);
    expect(r.projections_kept).toBe(2);

    expect(await store.read(old.id)).toBeNull();
    expect(await store.read(recent.id)).not.toBeNull();
    expect(await store.count()).toBe(1);
    // 投影表不受 compaction 影响
    const projs = await store.queryProjections();
    expect(projs.projections).toHaveLength(2);
    expect(projs.projections.map((p) => p.summary.id)).toEqual([old.id, recent.id]);
  });

  it('compact 幂等：重跑无重复删除，投影计数一致', async () => {
    const store = openStore(await tmpDb());
    const old = makeEvent({ timestamp: ts(-40 * DAY_MS) });
    const fresh = makeEvent({ timestamp: ts(-2 * DAY_MS) });
    await store.append(old);
    await store.append(fresh);

    const r1 = await store.compact(NOW, 30);
    const r2 = await store.compact(NOW, 30);
    expect(r1.removed).toBe(1);
    expect(r2.removed).toBe(0); // 幂等：第二次无删除
    expect(r2.projections_kept).toBe(r1.projections_kept);
    expect(await store.count()).toBe(1);
    expect((await store.queryProjections()).projections).toHaveLength(2);
  });
});

describe('重复 id 拒绝（§11.3 幂等键 event_id）', () => {
  it('同 id append 两次 → 第二次抛错，count 不变', async () => {
    const store = openStore(await tmpDb());
    const e = makeEvent({ type: 'decision/made' });
    await store.append(e);
    await expect(store.append(e)).rejects.toThrow();
    expect(await store.count()).toBe(1);
  });
});
