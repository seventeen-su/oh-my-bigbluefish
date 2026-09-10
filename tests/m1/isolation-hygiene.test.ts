// 会话隔离与数据体积治理行为测试
// （对应 docs/known-issues.md《工作状态未按会话隔离》《检查点无轮转且自 09-09 起停写》
//   《事件库体积增长》《事实库小文件》《制品索引未建立》修复判定）：
//   ① 会话隔离：检查点带 session_id；按会话取最新（不再拿"目录内最新"——别的会话的状态不串台）；
//      无会话归属的旧检查点不被任何会话命中
//   ② 轮转：每会话保留最近 N 个 + 全局上限 + 时间上限；保留位不受清理影响；幂等
//   ③ 事件库整理：体积阈值触发 VACUUM（低于阈值不动作）；整理后库可继续读写
//   ④ 事实库分片：小文件 → 分片；键仍可寻址（单键读命中分片）；列全量不重不漏；幂等
//   ⑤ 制品发现根：根集合逐根尝试；全部未命中 → 记为不可恢复制品（不再丢弃）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prune, latestForSession, list, save } from '../../supervisor/checkpoint.js';
import { EventStore } from '../../supervisor/event-store.js';
import { createVerificationStores, STORE_SHARD_COUNT } from '../../supervisor/verification-stores.js';
import { discoverArtifactsFromEvents } from '../../supervisor/artifact-index.js';
import type { State } from '../../kernel/schemas/s.js';

let base: string;
const stores: EventStore[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-isolation-'));
});

afterEach(async () => {
  for (const s of stores.splice(0)) {
    await s.close().catch(() => undefined);
  }
  await rm(base, { recursive: true, force: true });
});

/** 最小合规 State（checkpoint 只需 M7 字段 + state.id 自洽；此处用精简结构过 schema） */
function makeState(id: string, goal: string): State {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    ir_version: '2.0',
    id,
    schema: 'omb/S1',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: {
      source: 'test',
      event: `test/${id}`,
      actor: 'test',
      environment: { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' },
      runtime_snapshot: 'rs:test',
      timestamp: ts,
      transformation_chain: [],
      verification: 'test',
    },
    refs: [],
    working: { goal, confirmed_facts: [], active_hypotheses: [], contradictions: [], open_questions: [], evidence_gaps: [], next_best_action: '', environment: 'test' },
    world: null,
    self: null,
  } as unknown as State;
}

describe('① 会话隔离：按会话取最新检查点', () => {
  it('两个会话各自写入 → 各取各的（不再串台）', async () => {
    const dir = join(base, 'checkpoints');
    const a1 = await save(makeState('state:a1', '会话A的目标'), { dir, session_id: 'sess-A' });
    const b1 = await save(makeState('state:b1', '会话B的目标'), { dir, session_id: 'sess-B' });
    // 目录内最新是 b1，但 sess-A 必须取到 a1
    const forA = await latestForSession('sess-A', { dir });
    const forB = await latestForSession('sess-B', { dir });
    expect(forA?.id).toBe(a1.id);
    expect(forB?.id).toBe(b1.id);
    expect(forA?.session_id).toBe('sess-A');
  });

  it('同会话多个检查点 → 取最近一个', async () => {
    const dir = join(base, 'checkpoints');
    await save(makeState('state:x1', '第一次'), { dir, session_id: 'sess-X' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await save(makeState('state:x2', '第二次'), { dir, session_id: 'sess-X' });
    expect((await latestForSession('sess-X', { dir }))?.id).toBe(second.id);
  });

  it('无会话归属的旧检查点 → 不被任何会话命中（不误恢复）', async () => {
    const dir = join(base, 'checkpoints');
    await save(makeState('state:legacy', '旧检查点无会话标识'), { dir }); // 不传 session_id
    expect(await latestForSession('sess-any', { dir })).toBeNull();
    expect((await list({ dir })).length).toBe(1); // 文件仍在（可恢复性不破坏）
  });
});

describe('② 检查点轮转与清理', () => {
  it('每会话保留最近 N 个；超出全局上限的旧检查点被清理；保留位不受影响', async () => {
    const dir = join(base, 'checkpoints');
    // 会话 S：5 个（perSessionKeep 默认 3 → 只保留最近 3）
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cp = await save(makeState(`state:s${i}`, `S-${i}`), { dir, session_id: 'sess-S' });
      ids.push(cp.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    // 无会话归属：10 个（只在全局上限下参与保留）
    for (let i = 0; i < 10; i++) {
      await save(makeState(`state:free${i}`, `free-${i}`), { dir });
      await new Promise((r) => setTimeout(r, 3));
    }
    const before = await list({ dir });
    expect(before.length).toBe(15);
    const r = await prune({ dir, perSessionKeep: 3, maxFiles: 6 });
    expect(r.removed).toBe(15 - 6);
    const after = await list({ dir });
    expect(after.length).toBe(6);
    // 会话 S 的最近 3 个必须还在
    expect(after.filter((c) => c.session_id === 'sess-S').length).toBe(3);
    // 幂等：再清理一次不删（已在上限内）
    const r2 = await prune({ dir, perSessionKeep: 3, maxFiles: 6 });
    expect(r2.removed).toBe(0);
  });

  it('时间上限：超龄且不在保留位的被清理；会话保留位受保护', async () => {
    const dir = join(base, 'checkpoints');
    const old = await save(makeState('state:old', '很久以前'), { dir, session_id: 'sess-O' });
    const other = await save(makeState('state:other', '别的会话'), { dir, session_id: 'sess-P' });
    // maxAgeMs=0 → 任何早于"现在"的时间戳都算超龄（不需要改文件：改 timestamp 会破坏 hash 自洽）。
    // 会话保留位保护：sess-O 的唯一（最近）检查点即便超龄也不删；无归属条目不在保留位 → 超龄删。
    const r = await prune({ dir, perSessionKeep: 1, maxFiles: 100, maxAgeMs: 0 });
    expect(r.removed).toBe(0); // 两条都属于各自会话的保留位
    expect(fs.existsSync(join(dir, `${old.id.slice('checkpoint:'.length)}.json`))).toBe(true);
    expect(fs.existsSync(join(dir, `${other.id.slice('checkpoint:'.length)}.json`))).toBe(true);
  });

  it('时间上限：滑出保留位的超龄检查点被清理（原因可读）', async () => {
    const dir = join(base, 'checkpoints');
    // 造 4 条同会话检查点：会话保留位只留最近 3 条 → 最旧的 1 条滑出保留位，再按时间上限判定
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await save(makeState(`state:h${i}`, `H-${i}`), { dir, session_id: 'sess-H' })).id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const before = await list({ dir });
    expect(before).toHaveLength(4);
    const oldestTs = Date.parse(before[3]!.timestamp);
    // 注入"未来时钟"使其按超龄删除（不改文件——改 timestamp 会破坏 hash 自洽被 list 跳过）
    const r = await prune({ dir, perSessionKeep: 3, maxFiles: 3, maxAgeMs: 0, now: () => oldestTs + 1000 });
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(r.reasons.some((x) => x.includes('超龄') || x.includes('超限'))).toBe(true);
    expect((await list({ dir })).length).toBe(3);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(r.reasons.some((x) => x.includes('超龄'))).toBe(true);
    expect((await list({ dir })).length).toBe(3);
  });
});

describe('③ 事件库整理', () => {
  it('体积阈值：低于阈值不动作；超阈值 VACUUM 后库可继续读写且体积不增', async () => {
    const store = new EventStore(join(base, 'events.db'));
    stores.push(store);
    // 写入若干事件 → 产生页占用
    for (let i = 0; i < 50; i++) {
      await store.append({
        ir_version: '2.0',
        id: `evt:${i}`,
        schema: 'omb/M3',
        scope: 'Session',
        lifecycle: 'active',
        immutable: false,
        owner: 'kernel',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        provenance: {
          source: 'test',
          event: `test/${i}`,
          actor: 'test',
          environment: { os: 'win32', node: 'v24', dsh_version: '0.1.3-alpha.2', project: 'omb-v2' },
          runtime_snapshot: 'rs:test',
          timestamp: '2026-01-01T00:00:00.000Z',
          transformation_chain: [],
          verification: 'test',
        },
        refs: [],
        type: 'decision/made',
        session_id: 's1',
        runtime_snapshot: 'rs:test',
        parent_event: null,
        payload: { i, filler: 'x'.repeat(500) },
        timestamp: '2026-01-01T00:00:00.000Z',
      } as never);
    }
    expect(store.sizeBytes()).toBeGreaterThan(0);
    expect(await store.count()).toBe(50);
    const after = store.vacuum();
    expect(after).toBeGreaterThan(0);
    expect(await store.count()).toBe(50); // VACUUM 不动数据
    expect((await store.query({ session_id: 's1', limit: 5 })).events.length).toBe(5);
  });
});

describe('④ 事实库分片合并', () => {
  it('小文件 → 分片；键仍可寻址；列全量不重不漏；幂等', async () => {
    const root = join(base, 'verification');
    const { facts } = createVerificationStores(root);
    for (let i = 0; i < 40; i++) {
      await facts.registerFact({ id: `claim:${i}`, text: `事实 ${i}`, provenance: `evt:${i}`, valid: true });
    }
    const dir = join(root, 'facts');
    expect((await readdir(dir)).filter((f) => f.endsWith('.json')).length).toBe(40); // 一键一文件
    const r = await facts.compact();
    expect(r.records).toBe(40);
    expect(r.removedFiles).toBe(40);
    expect(r.shards).toBeLessThanOrEqual(STORE_SHARD_COUNT);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files.every((f) => f.startsWith('shard-'))).toBe(true);
    expect(files.length).toBe(r.shards);
    // 键仍可寻址（单键读命中分片）
    expect((await facts.get('claim:7'))?.provenance).toBe('evt:7');
    expect(await facts.get('claim:nope')).toBeNull();
    // 列全量不重不漏
    expect((await facts.all()).length).toBe(40);
    // 唯一命中：用完整 provenance（'evt:3' 会子串命中 evt:30..39，故用 'evt:37'）
    expect((await facts.factsFor({ provenanceContains: 'evt:37' })).length).toBe(1);
    // 幂等
    const r2 = await facts.compact();
    expect(r2).toEqual({ shards: 0, records: 0, removedFiles: 0 });
  });

  it('合并后再写入 + 再合并：新旧记录都在（无丢失）', async () => {
    const root = join(base, 'verification');
    const { facts } = createVerificationStores(root);
    await facts.registerFact({ id: 'claim:a', text: '事实甲', provenance: 'evt:a', valid: true });
    await facts.compact();
    await facts.registerFact({ id: 'claim:b', text: '事实乙', provenance: 'evt:b', valid: false });
    expect((await facts.all()).length).toBe(2);
    await facts.compact();
    expect((await facts.all()).length).toBe(2);
    expect((await facts.get('claim:a'))?.valid).toBe(true);
    expect((await facts.get('claim:b'))?.valid).toBe(false);
  });
});

describe('⑤ 制品发现根集合', () => {
  it('根集合逐根尝试命中真实文件；全部未命中 → 记为不可恢复制品（不再丢弃）', async () => {
    const rootA = join(base, 'projA');
    const rootB = join(base, 'projB');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    fs.writeFileSync(join(rootB, 'report.md'), '# 报告', 'utf8');
    const events = [
      {
        id: 'evt:1',
        type: 'tool/result',
        payload: { text: `写好了 ${join(rootB, 'report.md')} 与 ${join(base, 'missing', 'ghost.md')}` },
      },
    ];
    const manifests = await discoverArtifactsFromEvents(events, { roots: [rootA, rootB], environment: {} });
    expect(manifests.length).toBe(2);
    const real = manifests.find((m) => m.path.includes('report.md'));
    expect(real?.restorable).toBe(true);
    expect(real?.hash).not.toBe('unavailable'); // 真实内容哈希
    const ghost = manifests.find((m) => m.path.includes('ghost.md'));
    expect(ghost).toBeDefined(); // 不再丢弃
    expect(ghost?.restorable).toBe(false);
    expect(ghost?.hash).toBe('unavailable');
  });

  it('未提供根 → 仍索引（hash=unavailable、restorable=false 诚实缺省）', async () => {
    const manifests = await discoverArtifactsFromEvents(
      [{ id: 'evt:2', type: 'tool/result', payload: { text: '看到 /tmp/whatever.json 这个文件' } }],
      { environment: {} },
    );
    expect(manifests.length).toBe(1);
    expect(manifests[0]?.restorable).toBe(false);
  });
});

describe('数据清理任务节流', () => {
  it('每小时一次：连续两轮收尾只入队一次（避免每轮重复入队）', async () => {
    const { createCognitiveRuntime } = await import('../../runtime/assembly.js');
    const { MaintenanceScheduler } = await import('../../supervisor/maintenance.js');
    const root = join(base, '.omb');
    const scheduler = new MaintenanceScheduler({ debtFile: join(root, '.evolution', 'debt.json'), batchSize: 32 });
    const rt = createCognitiveRuntime({ root, maintenance: scheduler, checkpointDir: join(root, 'checkpoints'), hostVersion: '0.1.3-alpha.2' });
    const decision = { decision: 'Stop', reason: 'test', budget_allocation: {}, expected_gain: 0, snapshot: 'rs:test' };
    const ws = {
      goal: '目标',
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: '',
      environment: 'test',
    };
    await rt.finalizeTurn({ session_id: 's1', decision: decision as never, working_state: ws });
    await rt.finalizeTurn({ session_id: 's1', decision: decision as never, working_state: ws });
    const report = await scheduler.tick();
    // 三个清理任务恰好各执行一次
    for (const id of ['checkpoint_prune', 'event_store_vacuum', 'fact_store_compact']) {
      expect(report.ran.filter((x) => x === id).length).toBeLessThanOrEqual(1);
    }
    await rt.close();
  });
});
