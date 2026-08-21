// T1.4+ 链级集成测试：Event → State → Checkpoint → Replay 重建链（M1 出口「回放可重建」的真实实现者）。
// 背景：主会话 M1 出口核对发现缺口——此前仅各模块独立单测（T1.3 event-store / T1.4 state-reducer / T1.5 checkpoint），
//       无链级集成测试。本文件以真实模块 + 真实 SQLite + 真实 fs 验证整条重建链（禁 mock，CONVENTIONS §6 fixture 用 mkdtemp）。
// 覆盖：
//   ① 写→归约→检查点→恢复→重放全程一致：append 全量事件 → reduce(带 initial) → save → restore → 从存储重读重放，
//      三态深度相等（JSON 相等）+ snapshot_hash 一致 + S2 schema 合规断言；
//   ② 部分事件重放：只回放前 N 条 → 状态 = 全量回放对应前缀（后续事件不泄漏，Event 为唯一事实源）；
//   ③ 损坏检查点拒绝：篡改落盘 state → restore 抛错（链的鲁棒性，复用 T1.5 hash 校验语义）。
// 契约（T1.4 裁决）：schema 合规的 State 必须来自带 initial 的完整回放或 checkpoint 恢复——本测试 reduce 一律带 initial。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '../../kernel/schemas/m.js';
import { StateSchema, type State } from '../../kernel/schemas/s.js';
import { makeMutableId } from '../../kernel/schemas/base.js';
import { EventStore } from '../../supervisor/event-store.js';
import { EVENTS_HANDLED, reduce } from '../../supervisor/state-reducer.js';
import { restore, save } from '../../supervisor/checkpoint.js';
import { PROV, S2_VALID, TS } from './ir-samples.js';

const NOW = Date.parse(TS);
const SESSION_ID = 'sess-chain-1';
/** 合法 S3 working 种子（goal/next_best_action 非空、world/self 字符串引用 → S2 schema 合规） */
const INITIAL = S2_VALID as unknown as State;

const dirs: string[] = [];
const stores: EventStore[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omb-chain-'));
  dirs.push(dir);
  return dir;
}

function openStore(dbPath: string): EventStore {
  const store = new EventStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 重建链 M3 Event 工厂：seq 递增（1..N）、timestamp 递增（NOW + seq 秒）、session_id 恒定（单一会话链） */
function evt(type: string, payload: Record<string, unknown>, seq: number): Event & { seq: number } {
  const t = new Date(NOW + seq * 1000).toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: t,
    updated: t,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: SESSION_ID,
    runtime_snapshot: 'rs:1',
    parent_event: null,
    causality: `c:${seq}`,
    payload,
    timestamp: t,
    seq,
  };
}

/** 重建链事件序列：覆盖 EVENTS_HANDLED 全部已注册类型（session/start → … → session/end，单一会话；新增类型须同步进链） */
function chainEvents(): (Event & { seq: number })[] {
  return [
    evt('session/start', { goal: '端到端重建链验证' }, 1),
    evt('claim/update', { claim_id: 'c:1', text: 'IR 定义完整', epistemic: 'supported', confidence: 0.8 }, 2),
    evt('claim/update', { claim_id: 'c:2', text: 'Zod 选型合理', epistemic: 'unresolved', confidence: 0.5 }, 3),
    evt('hypothesis/transition', { hypothesis_id: 'h:1', claim_id: 'c:1', status: 'active' }, 4),
    evt('hypothesis/transition', { hypothesis_id: 'h:1', claim_id: 'c:1', status: 'confirmed' }, 5), // active→confirmed
    evt('contradiction/found', { contradiction_id: 'x:1', left_claim: 'c:1', right_claim: 'c:2' }, 6),
    evt('decision/made', { decision_id: 'd:1', question: '选 zod?', chosen: 'zod', evidence_used: ['e:1'] }, 7),
    evt('tool/call', { tool_id: 't:1' }, 8),
    evt('tool/result', { tool_id: 't:1' }, 9),
    evt('process/operator/retrieve', { operator_id: 'op:1' }, 10),
    evt('memory/admitted', { memory_id: 'm:1' }, 11),
    evt('memory/consolidated', { memory_id: 'm:1' }, 12),
    // context/injected（T8.26.2 新增固定类型；投影注入为 no-op 不改 State）
    evt('context/injected', { projection_id: 'p:1', total_tokens: 12 }, 13),
    // 宪法②链（§14.1）：活动假设 + contradictory 观测 → 降级（active→discriminated）
    evt('hypothesis/transition', { hypothesis_id: 'h:2', claim_id: 'c:2', status: 'active' }, 14),
    evt(
      'observation/contradictory',
      { observation_id: 'o:1', claim_id: 'c:2', hypothesis_id: 'h:2', status: 'discriminated' },
      15,
    ),
    evt('session/end', {}, 16),
  ];
}

describe('Event → State → Checkpoint → Replay 重建链（M1 出口「回放可重建」）', () => {
  it('写→归约→检查点→恢复→重放全程一致：state3 == state2 == state1（snapshot_hash 一致，S2 schema 合规）', async () => {
    const root = await tmpDir();
    const store = openStore(join(root, 'events.db'));
    const cpDir = join(root, 'checkpoints');

    // 事件序列覆盖 EVENTS_HANDLED 全部已注册类型（防漂移：注册表新增类型须同步进链）
    const events = chainEvents();
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENTS_HANDLED));

    // ① 写入：真实 SQLite（WAL 追加写）
    await store.appendMany(events);
    expect(await store.count()).toBe(events.length);

    // ② 归约：带 initial 的完整回放 → schema 合规 State（T1.4 契约）
    const { state: state1, projections } = reduce(events, { initial: INITIAL });
    expect(StateSchema.safeParse(state1).success).toBe(true);

    // 事件序列语义精确落位
    expect(state1.working.goal).toBe('端到端重建链验证');
    expect(state1.working.confirmed_facts).toEqual(['c:1']); // c:1 supported；c:2 unresolved
    expect(state1.working.active_hypotheses).toEqual([]); // h:1 active→confirmed
    expect(state1.working.contradictions).toEqual(['x:1']);
    expect(projections.decision_lineage.map((d) => d.id)).toEqual(['d:1']);
    expect(projections.utility_counts).toEqual({
      tool_calls: 1,
      retrieval_calls: 1,
      memory_ops: 2,
      corrections: 0,
      reads: 0,
      hits: 0,
    });
    expect(state1.lifecycle).toBe('retired'); // session/end 终结标记

    // ③ 检查点：save → restore → 深度相等（JSON 相等）
    // （ReducedState.world 类型为 string|null，schema 合规已由上方 safeParse 断言；cast 同 checkpoint.test.ts）
    const cp = await save(state1 as unknown as State, { dir: cpDir });
    const state2 = await restore(cp.id, { dir: cpDir });
    expect(state2).toEqual(state1);
    expect(StateSchema.safeParse(state2).success).toBe(true); // 恢复出的 State 同样 schema 合规

    // ④ 重放可重建：从 EventStore 重读事件流（真实持久化，唯一事实源）再次 reduce(同 initial)
    const replayed = (await store.query({})).events;
    expect(replayed.map((e) => e.type)).toEqual(events.map((e) => e.type)); // 事件流保真（seq 序）
    const { state: state3 } = reduce(replayed, { initial: INITIAL });
    expect(state3).toEqual(state1); // 深度一致
    expect(state3.snapshot_hash).toBe(state1.snapshot_hash); // 重建一致性（P7）

    // 断言链完整：写入→归约→检查点→恢复→重放，全程一致
    expect([state2, state3].every((s) => s.snapshot_hash === state1.snapshot_hash)).toBe(true);
  });
});

describe('部分事件重放（Event 为唯一事实源）', () => {
  it('只回放前 N 条 → 状态 = 全量回放对应前缀；后续事件不泄漏', async () => {
    const root = await tmpDir();
    const store = openStore(join(root, 'events.db'));
    const events = chainEvents();
    await store.appendMany(events);

    const N = 6; // session/start … contradiction/found（不含 decision/tool/memory/session-end）
    const prefix = events.slice(0, N);
    const prefixFromStore = (await store.query({})).events.slice(0, N); // 从存储重读前缀（无 seq，按 timestamp 稳定排序）

    const { state: p, projections } = reduce(prefixFromStore, { initial: INITIAL });
    const full = reduce(events, { initial: INITIAL }).state;

    // 从存储重读的前缀重建 = 原前缀重建（唯一事实源：存储 → 重建一致）
    expect(p).toEqual(reduce(prefix, { initial: INITIAL }).state);
    // 前缀状态 = 全量回放对应前缀的 working（后续事件未进入状态）
    expect(p.working.goal).toBe(full.working.goal);
    expect(p.working.confirmed_facts).toEqual(full.working.confirmed_facts);
    expect(p.working.contradictions).toEqual(full.working.contradictions);
    // 后续事件未泄漏：前缀尚未触达 session/end 与工具/记忆事件
    expect(p.lifecycle).toBe('active');
    expect(full.lifecycle).toBe('retired');
    expect(projections.utility_counts).toEqual({
      tool_calls: 0,
      retrieval_calls: 0,
      memory_ops: 0,
      corrections: 0,
      reads: 0,
      hits: 0,
    });
    expect(p.snapshot_hash).not.toBe(full.snapshot_hash);
  });
});

describe('损坏检查点拒绝（链的鲁棒性）', () => {
  it('篡改 checkpoint 落盘 state → restore 抛错（hash 校验失败，复用 T1.5 语义）', async () => {
    const root = await tmpDir();
    const store = openStore(join(root, 'events.db'));
    const cpDir = join(root, 'checkpoints');
    const events = chainEvents();
    await store.appendMany(events);

    const { state } = reduce(events, { initial: INITIAL });
    const cp = await save(state as unknown as State, { dir: cpDir });

    // 篡改落盘 state 内容（合法 JSON、hash 不匹配）
    const file = join(cpDir, `${cp.id.slice('checkpoint:'.length)}.json`);
    const obj = JSON.parse(await readFile(file, 'utf8')) as { state: State };
    obj.state.working.goal = 'tampered-goal';
    await writeFile(file, JSON.stringify(obj), 'utf8');

    await expect(restore(cp.id, { dir: cpDir })).rejects.toThrow(/hash 校验失败|损坏|篡改/);
  });
});
