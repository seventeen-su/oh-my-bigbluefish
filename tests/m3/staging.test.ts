// T3.2 行为测试：记忆 staging 与准入（架构 §7.2 / §11.3）。
// 覆盖：stage 成功与 event_id 幂等 no-op、TTL 过期回收、admission 通过/重复拒绝/来源最低要求/
// 新信息判定/priority 排序/稳定门槛/非法候选、幂等重跑。
// fixture：mkdtemp 临时 db（T3.1 backend + staging 表，StagingManager 自持唯一连接——单写者）。
// Windows 注意（T1.3 经验）：WAL 侧车文件在连接未关闭时被锁 → afterEach 先 close 再 rm。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Event } from '../../kernel/schemas/m.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { SqliteMemoryBackend } from '../../memory/backend.js';
import { StagingManager, DEFAULT_PRIORITY_BY_TYPE, DEFAULT_TTL_MS } from '../../memory/staging.js';
import { PROV, TS, base } from '../m1/ir-samples.js';

const dbPaths: string[] = [];
const backends: SqliteMemoryBackend[] = [];
const stagings: StagingManager[] = [];

async function tmpDb(): Promise<string> {
  const db = join(await mkdtemp(join(tmpdir(), 'omb-stg-')), 'memory.db');
  dbPaths.push(db);
  return db;
}

function openBackend(dbPath: string): SqliteMemoryBackend {
  const b = new SqliteMemoryBackend(dbPath);
  backends.push(b);
  return b;
}

function openStaging(dbPath: string): StagingManager {
  const s = new StagingManager(dbPath);
  stagings.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(stagings.splice(0).map((s) => s.close()));
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await Promise.all(dbPaths.splice(0).map((p) => rm(join(p, '..'), { recursive: true, force: true })));
});

/** M3 Event 工厂：provenance.event 每次唯一（幂等键语义）；over 覆盖任意字段 */
function makeEvent(over: Record<string, unknown> = {}): Event {
  return {
    ...base({ id: makeMutableId('evt'), schema: 'omb/M3' }),
    provenance: { ...PROV, event: makeMutableId('evt') },
    type: 'claim/update',
    session_id: 's:1',
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: 'c:1',
    payload: { memory: { payload: '默认记忆内容', prov_class: 'Observation' } },
    timestamp: TS,
    ...over,
  } as unknown as Event;
}

type StagingRow = {
  id: string;
  event_id: string;
  priority: number;
  ttl_until: number;
  payload: string;
  created: number;
};

/** 只读检查 staging 表（测试自开连接，即开即关；不进 StagingManager API） */
function stagingRows(dbPath: string): StagingRow[] {
  const conn = new DatabaseSync(dbPath);
  try {
    return conn.prepare('SELECT id, event_id, priority, ttl_until, payload, created FROM staging').all() as unknown as StagingRow[];
  } finally {
    conn.close();
  }
}

function stagingCount(dbPath: string): number {
  return stagingRows(dbPath).length;
}

describe('stage（§7.2 Event → staging）', () => {
  it('stage 成功：事件入 staging，priority 按类型默认映射、TTL 按默认值写入', async () => {
    const db = await tmpDb();
    const s = openStaging(db);
    const e = makeEvent();
    const r = await s.stage(e);
    expect(r).toEqual({ admitted: true, id: expect.any(String) });
    const rows = stagingRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_id).toBe(e.provenance.event);
    expect(row.priority).toBe(DEFAULT_PRIORITY_BY_TYPE['claim/update']);
    expect(row.ttl_until - row.created).toBe(DEFAULT_TTL_MS);
    expect(JSON.parse(row.payload)).toMatchObject({ id: e.id });
  });

  it('同 event_id 重复 stage → no-op（admitted:false reason:duplicate），行数不变', async () => {
    const db = await tmpDb();
    const s = openStaging(db);
    const e = makeEvent();
    await s.stage(e);
    const r2 = await s.stage(e);
    expect(r2).toEqual({ admitted: false, reason: 'duplicate' });
    expect(stagingCount(db)).toBe(1);
  });

  it('来源最低要求：prov_class 低于 minProvClass → rejected（记录并丢弃，不入 staging）', async () => {
    const db = await tmpDb();
    const s = openStaging(db);
    const low = makeEvent({ payload: { memory: { payload: '低来源内容', prov_class: 'Model-inferred' } } });
    const r = await s.stage(low, { minProvClass: 'Observation' });
    expect(r).toEqual({ admitted: false, reason: 'below-min-prov-class' });
    expect(stagingCount(db)).toBe(0);
    // 达标来源 → 正常入 staging
    const ok = makeEvent({ payload: { memory: { payload: '达标来源内容', prov_class: 'Observation' } } });
    const r2 = await s.stage(ok, { minProvClass: 'Observation' });
    expect(r2.admitted).toBe(true);
    expect(stagingCount(db)).toBe(1);
  });
});

describe('sweepExpired（TTL 过期回收）', () => {
  it('短 TTL 行过期被删、未过期保留；返回删除数', async () => {
    const db = await tmpDb();
    const s = openStaging(db);
    const exp = makeEvent();
    const keep = makeEvent();
    await s.stage(exp, { ttlMs: 10 });
    await s.stage(keep); // 默认 TTL
    expect(stagingCount(db)).toBe(2);
    const n = await s.sweepExpired({ now: Date.now() + 50 });
    expect(n).toBe(1);
    const rows = stagingRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toBe(keep.provenance.event);
  });
});

describe('admit（metadata admission，§7.2）', () => {
  it('admission 通过：合法事件（Observation 新内容）→ 进 memory 表、staging 移除', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const e = makeEvent({ payload: { memory: { payload: '准入新内容', prov_class: 'Observation' } } });
    await s.stage(e);
    const res = await s.admit();
    expect(res.admitted).toEqual([e.provenance.event]);
    expect(res.rejected).toEqual([]);
    expect(stagingCount(db)).toBe(0);
    const page = await b.query({ scope: 'Project', limit: 10, budget: 100 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.payload).toBe('准入新内容');
    expect(page.items[0]?.provenance.event).toBe(e.provenance.event);
    // 记忆级 utility_counts 默认 = T3.4 定型六反馈键全 0（staging-policy 默认形状）
    expect(page.items[0]?.utility_counts).toEqual({
      retrieval: 0,
      hit: 0,
      miss: 0,
      inject: 0,
      decay: 0,
      promote: 0,
    });
  });

  it('admission 重复拒绝：同一内容两事件 → 第二个 rejected duplicate（防重复记忆）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const e1 = makeEvent({ payload: { memory: { payload: '相同内容', prov_class: 'Observation' } } });
    const e2 = makeEvent({ payload: { memory: { payload: '相同内容', prov_class: 'Observation' } } });
    // 显式 priority 保证 admit 顺序确定（同 priority 时 created 可能同毫秒，顺序未指定）
    await s.stage(e1, { priority: 10 });
    await s.stage(e2, { priority: 9 });
    const res = await s.admit();
    expect(res.admitted).toEqual([e1.provenance.event]);
    expect(res.rejected).toEqual([{ id: e2.provenance.event, reason: 'duplicate' }]);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(1);
    expect(stagingCount(db)).toBe(0); // 拒绝行记录并丢弃
  });

  it('新信息判定：内容相同（规范化哈希）→ rejected duplicate；内容不同 → admitted', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const a = makeEvent({ payload: { memory: { payload: '规范化  内容', prov_class: 'Observation' } } });
    const a2 = makeEvent({ payload: { memory: { payload: '规范化 内容', prov_class: 'Observation' } } });
    const diff = makeEvent({ payload: { memory: { payload: '完全不同内容', prov_class: 'Observation' } } });
    await s.stage(a, { priority: 10 });
    await s.stage(a2, { priority: 9 });
    await s.stage(diff, { priority: 8 });
    const res = await s.admit();
    expect(res.admitted).toEqual([a.provenance.event, diff.provenance.event]);
    expect(res.rejected).toEqual([{ id: a2.provenance.event, reason: 'duplicate' }]);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(2);
  });

  it('priority 排序：高 priority 先 admit（limit 限制时只准入高优先）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const low = makeEvent({ payload: { memory: { payload: '低优先内容', prov_class: 'Observation' } } });
    const high = makeEvent({ payload: { memory: { payload: '高优先内容', prov_class: 'Observation' } } });
    await s.stage(low, { priority: 1 });
    await s.stage(high, { priority: 10 });
    const r1 = await s.admit({ limit: 1 });
    expect(r1.admitted).toEqual([high.provenance.event]);
    expect(stagingCount(db)).toBe(1); // 低优先仍留 staging
    const r2 = await s.admit();
    expect(r2.admitted).toEqual([low.provenance.event]);
    expect(stagingCount(db)).toBe(0);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(2);
  });

  it('稳定门槛：Model-inferred 低 priority → rejected unstable；高 priority → admitted', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const low = makeEvent({ payload: { memory: { payload: '推断低优先', prov_class: 'Model-inferred' } } });
    const high = makeEvent({ payload: { memory: { payload: '推断高优先', prov_class: 'Model-inferred' } } });
    await s.stage(low, { priority: 1 });
    await s.stage(high, { priority: 9 });
    const res = await s.admit();
    expect(res.admitted).toEqual([high.provenance.event]);
    expect(res.rejected).toEqual([{ id: low.provenance.event, reason: 'unstable' }]);
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(1);
  });

  it('非法候选（scope 不在四维枚举）→ rejected invalid', async () => {
    const db = await tmpDb();
    const s = openStaging(db);
    const bad = makeEvent({ payload: { memory: { scope: 'Bogus', payload: '内容', prov_class: 'Observation' } } });
    await s.stage(bad);
    const res = await s.admit();
    expect(res.rejected).toEqual([{ id: bad.provenance.event, reason: 'invalid' }]);
    expect(stagingCount(db)).toBe(0);
  });

  it('幂等重跑：admit 连跑两次 → 第二次无副作用（无新增、无报错）', async () => {
    const db = await tmpDb();
    const b = openBackend(db);
    const s = openStaging(db);
    const e = makeEvent({ payload: { memory: { payload: '幂等内容', prov_class: 'Observation' } } });
    await s.stage(e);
    const r1 = await s.admit();
    expect(r1.admitted).toEqual([e.provenance.event]);
    const r2 = await s.admit();
    expect(r2).toEqual({ admitted: [], rejected: [] });
    expect((await b.query({ scope: 'Project', limit: 10, budget: 100 })).total).toBe(1);
    expect(stagingCount(db)).toBe(0);
  });
});
