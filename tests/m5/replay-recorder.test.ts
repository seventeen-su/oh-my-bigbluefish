// S4 Replay fixture 录制工具（scripts/replay-recorder-core.ts 纯逻辑 + scripts/replay-recorder.ts CLI，
// 架构 §14.6 开放项「Replay Fixture 录制工具」/ §5.2 replay_fixture {event_id → canned_result}；
// 清扫计划 2026-08-24-completion-sweep S4）。严格 TDD：本文件先于实现编写并确认失败（功能缺失）。
//
// 覆盖（S4 测试清单）：
//   配对：call→result 正常映射（tool/input_hash/result + generated 完整）；input_hash 独立复算一致；
//         无 result 的 call → non-replayable（stub 偏差说明）；孤儿 result → non-replayable；
//         result 缺内容（仅签名）→ non-replayable；跨会话隔离（同 callId 不同会话不串）；
//         同 callId 多 result（修正）→ 最新胜出；非确定性源冲突（同 tool+input_hash 不同结果）→ 后者 non-replayable；
//         非确定性内容（时间戳）→ 原样录制；确定性（同输入两次 → 字节一致）。
//   字节级对齐：录制产物 canned 直接被 ReplayRunner 消费（runReplay ok）。
//   CLI：JSONL 源 / events.db 源 → 产物落盘（退出码 0）；坏输入（非法 JSONL 行 / 源不存在 / 缺 --out）→ 退出码 1；
//         import 无副作用（防破坏）。
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from '../../kernel/schemas/base.js';
import type { Event } from '../../kernel/schemas/m.js';
import { EventStore } from '../../supervisor/event-store.js';
import {
  computeReplayStateHash,
  ReplayRunner,
  type ReplayFixture,
  type ReplayProcessDef,
  type ReplayTraceEntry,
} from '../../supervisor/replay.js';
import { recordFixtures, ReplayFixtureFileSchema, serializeReplayFixtureFile } from '../../scripts/replay-recorder.js';

const PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(PRESET_ROOT, 'scripts', 'replay-recorder.ts');

const TS = '2026-08-21T00:00:00.000Z';
/** 固定生成时间戳（确定性断言用） */
const FIXED_TS = '2026-08-24T00:00:00.000Z';

// ---- 契约复算工具（独立于实现，防自证） ----

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** 输入哈希契约（与 ReplayRunner 同：sha256(canonicalJson(inputs))） */
const inputHash = (input: unknown): string => sha256hex(canonicalJson(input));

// ---- Event 工厂（M3 合法样例；确定性 id） ----

let evtSeq = 0;
function makeEvent(over: Record<string, unknown> = {}): Event {
  return {
    ir_version: '2.0',
    id: `evt:${String(evtSeq++).padStart(4, '0')}`,
    schema: 'omb/M3',
    scope: 'Project',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: TS,
    updated: TS,
    provenance: {
      source: 'test',
      event: `evt:${evtSeq}`,
      actor: 'kernel',
      environment: { os: 'test', node: 'v24', dsh_version: '0.5.0', project: 'omb-v2' },
      runtime_snapshot: 'rs:1',
      timestamp: TS,
      transformation_chain: [],
      verification: 'v:1',
    },
    refs: [],
    type: 'session/start',
    session_id: 'sess-1',
    runtime_snapshot: 'rs:1',
    parent_event: null,
    payload: {},
    timestamp: TS,
    ...over,
  } as unknown as Event;
}

/** tool/call 事件（DSH mapper 形状：arguments 为 JSON 字符串） */
function toolCall(session: string, callId: string, name: string, args: unknown): Event {
  return makeEvent({
    id: `evt:call-${session}-${callId}`,
    type: 'tool/call',
    session_id: session,
    payload: {
      call_id: callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      turn: 1,
      step: 1,
    },
  });
}

/** tool/result 事件（含 result 内容 → 可录制） */
function toolResult(session: string, callId: string, result: unknown, seq: number): Event {
  return makeEvent({
    id: `evt:result-${session}-${callId}-${seq}`,
    type: 'tool/result',
    session_id: session,
    payload: { call_id: callId, result, turn: 1, step: 1 },
  });
}

/** tool/result 事件（仅签名无内容 → stub 偏差，不可录制） */
function toolResultSignatureOnly(session: string, callId: string, seq: number): Event {
  return makeEvent({
    id: `evt:result-sig-${session}-${callId}-${seq}`,
    type: 'tool/result',
    session_id: session,
    payload: { call_id: callId, result_signature: 'deadbeef', turn: 1, step: 1 },
  });
}

// ---- spawn CLI 工具（与 bench-report.test.ts 同风格：node --import tsx；
// --disable-warning=ExperimentalWarning：CLI 导入 EventStore(node:sqlite) 会触发 Node 实验性警告，
// 属环境噪声而非错误——禁用后 stderr 断言才有意义） ----

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', SCRIPT, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runNodeEval(code: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '-e', code], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout, stderr }));
  });
}

// ---- 配对（录制核心纯函数） ----

describe('录制核心配对（scripts/replay-recorder-core.ts）', () => {
  it('call→result 正常映射：fixture 含 1 条 canned（tool/input_hash/result 正确 + generated 完整）；input_hash 独立复算一致', () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true, answer: 'hello world' }, 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    // schema 校验（机制即数据）
    expect(ReplayFixtureFileSchema.safeParse(file).success).toBe(true);
    expect(file.non_replayable).toEqual([]);
    const keys = Object.keys(file.fixture);
    expect(keys).toEqual(['evt:result-s1-c1-1']); // 键 = tool/result 事件 id（跨会话唯一）
    const entry = file.fixture['evt:result-s1-c1-1']!;
    expect(entry.tool).toBe('EXECUTE');
    expect(entry.input_hash).toBe(inputHash({ q: 'hello' })); // 独立复算（与 ReplayRunner 同契约）
    expect(entry.result).toEqual({ ok: true, answer: 'hello world' });
    // generated 元数据
    expect(file.generated).toEqual({ name: 'rec', version: '1.0.0', source: expect.stringContaining('2 events'), ts: FIXED_TS });
  });

  it('无 result 的 call → non-replayable（stub 偏差说明；fixture 无该 call 条目）', () => {
    const file = recordFixtures([toolCall('s1', 'c1', 'read', { path: 'x' })], { name: 'rec', ts: FIXED_TS });
    expect(Object.keys(file.fixture)).toEqual([]);
    expect(file.non_replayable).toHaveLength(1);
    const n = file.non_replayable[0]!;
    expect(n.call_id).toBe('c1');
    expect(n.session_id).toBe('s1');
    expect(n.tool).toBe('read');
    expect(n.reason).toContain('缺结果');
  });

  it('孤儿 result（无 tool/call 配对）→ non-replayable（缺输入参数无法计算 input_hash）', () => {
    const file = recordFixtures([toolResult('s1', 'c9', { ok: true }, 1)], { name: 'rec', ts: FIXED_TS });
    expect(Object.keys(file.fixture)).toEqual([]);
    expect(file.non_replayable[0]!.reason).toContain('孤儿');
  });

  it('result 缺内容（仅 result_signature）→ non-replayable（stub 偏差：结果不可重建）', () => {
    const events = [
      toolCall('s1', 'c1', 'read', { path: 'x' }),
      toolResultSignatureOnly('s1', 'c1', 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    expect(Object.keys(file.fixture)).toEqual([]);
    const n = file.non_replayable[0]!;
    expect(n.reason).toContain('stub');
    expect(n.reason).toContain('缺 result 内容');
  });

  it('跨会话隔离：两个会话同 callId、不同 arguments/result → 各自配对不串（两条 canned，键为各自 result 事件 id）', () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true, answer: 'hello world' }, 1),
      toolCall('s2', 'c1', 'EXECUTE', { q: 'bye' }),
      toolResult('s2', 'c1', { ok: true, answer: 'bye world' }, 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    expect(file.non_replayable).toEqual([]);
    const keys = Object.keys(file.fixture).sort();
    expect(keys).toEqual(['evt:result-s1-c1-1', 'evt:result-s2-c1-1']);
    // s1 的 result 与 s1 的 call 配对（input_hash 按 s1 参数；不串到 s2）
    expect(file.fixture['evt:result-s1-c1-1']!.input_hash).toBe(inputHash({ q: 'hello' }));
    expect(file.fixture['evt:result-s1-c1-1']!.result).toEqual({ ok: true, answer: 'hello world' });
    expect(file.fixture['evt:result-s2-c1-1']!.input_hash).toBe(inputHash({ q: 'bye' }));
    expect(file.fixture['evt:result-s2-c1-1']!.result).toEqual({ ok: true, answer: 'bye world' });
  });

  it('同 callId 多次 result（修正/重试）→ 最新 result 胜出（fixture 仅 1 条，内容为最新）', () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true, answer: 'old' }, 1),
      toolResult('s1', 'c1', { ok: true, answer: 'new' }, 2),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    expect(Object.keys(file.fixture)).toEqual(['evt:result-s1-c1-2']); // 最新事件 id
    expect(file.fixture['evt:result-s1-c1-2']!.result).toEqual({ ok: true, answer: 'new' });
  });

  it('非确定性源冲突：不同调用同 tool+arguments（同 input_hash）不同结果 → 后者 non-replayable（保留首次）', () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true, answer: 'first' }, 1),
      toolCall('s2', 'c2', 'EXECUTE', { q: 'hello' }), // 跨会话同工具同参数
      toolResult('s2', 'c2', { ok: true, answer: 'second' }, 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    expect(Object.keys(file.fixture)).toEqual(['evt:result-s1-c1-1']); // 首次保留
    expect(file.non_replayable).toHaveLength(1);
    expect(file.non_replayable[0]!.reason).toContain('非确定性');
    expect(file.non_replayable[0]!.reason).toContain('同 tool+input_hash');
  });

  it('非确定性内容（时间戳等）→ 原样录制（不归一化、不剔除）', () => {
    const result = { ok: true, ts: 1_752_000_000_000, data: 'x' };
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', result, 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    expect(file.fixture['evt:result-s1-c1-1']!.result).toEqual(result); // 原样
  });

  it('确定性：同输入两次 → 同对象 + 序列化字节一致（固定 ts）', () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true }, 1),
      toolCall('s2', 'c2', 'read', { path: 'x' }), // 无结果 → non-replayable
    ];
    const a = recordFixtures(events, { name: 'rec', ts: FIXED_TS, source: 'test' });
    const b = recordFixtures(events, { name: 'rec', ts: FIXED_TS, source: 'test' });
    expect(b).toEqual(a);
    expect(serializeReplayFixtureFile(b)).toBe(serializeReplayFixtureFile(a));
  });

  it('字节级对齐：录制产物 canned 直接组装 ReplayFixture → ReplayRunner 消费 ok（与 replay.ts 同契约）', async () => {
    const events = [
      toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
      toolResult('s1', 'c1', { ok: true, answer: 'hello world' }, 1),
    ];
    const file = recordFixtures(events, { name: 'rec', ts: FIXED_TS });
    const entry = file.fixture['evt:result-s1-c1-1']!;
    const trace: ReplayTraceEntry[] = [{ tool: 'EXECUTE', input_hash: entry.input_hash, result: entry.result }];
    const fixture: ReplayFixture = {
      name: 'rec-replay',
      input: { state_hash: 'input-state', task: { q: 'hello' } },
      canned: Object.values(file.fixture), // 录制产物直接作为 canned
      expected: {
        final_state_hash: computeReplayStateHash(trace),
        events: [`EXECUTE:${entry.input_hash}`],
      },
    };
    const process: ReplayProcessDef = {
      id: 'p:rec',
      version: '1.0.0',
      entry: 'EXECUTE',
      exit: 'EXECUTE',
      operators: [{ id: 'EXECUTE', op: 'EXECUTE', input_binding: { q: 'hello' }, output: 'result' }],
    };
    const real = { execute: async () => { throw new Error('真实执行器不应被调用'); } };
    const r = await new ReplayRunner(fixture).run(process, real);
    expect(r.ok).toBe(true);
  });
});

// ---- CLI（输入源 + 落盘 + 退出码） ----

describe('CLI（scripts/replay-recorder.ts）', () => {
  it('JSONL 源 → 产物落盘（<name>.replay-fixture.json，schema 校验通过，含 canned 条目）；退出码 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-jsonl-'));
    try {
      const jsonl = [toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }), toolResult('s1', 'c1', { ok: true }, 1)]
        .map((e) => JSON.stringify(e))
        .join('\n');
      const src = join(dir, 'events.jsonl');
      await writeFile(src, `${jsonl}\n`, 'utf8');
      const { code, stderr } = await runCli(['--events', src, '--out', join(dir, 'out')], PRESET_ROOT);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const raw = await readFile(join(dir, 'out', 'replay-fixture.replay-fixture.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      expect(ReplayFixtureFileSchema.safeParse(parsed).success).toBe(true);
      const file = parsed as { fixture: Record<string, { tool: string; input_hash: string; result: unknown }> };
      expect(Object.keys(file.fixture)).toHaveLength(1);
      expect(file.fixture['evt:result-s1-c1-1']!.result).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('events.db 源（EventStore 预置事件）→ 产物正确；退出码 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-db-'));
    try {
      const dbPath = join(dir, 'events.db');
      const store = new EventStore(dbPath);
      try {
        await store.appendMany([
          toolCall('s1', 'c1', 'EXECUTE', { q: 'hello' }),
          toolResult('s1', 'c1', { ok: true, answer: 'from-db' }, 1),
          toolCall('s1', 'c2', 'read', { path: 'x' }), // 无结果 → non-replayable
        ]);
      } finally {
        await store.close();
      }
      const { code, stderr } = await runCli(['--events', dbPath, '--out', join(dir, 'out'), '--name', 'from-db'], PRESET_ROOT);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const raw = await readFile(join(dir, 'out', 'from-db.replay-fixture.json'), 'utf8');
      const parsed = JSON.parse(raw) as { fixture: Record<string, { result: unknown }>; non_replayable: Array<{ call_id: string; reason: string }> };
      expect(parsed.fixture['evt:result-s1-c1-1']!.result).toEqual({ ok: true, answer: 'from-db' });
      expect(parsed.non_replayable).toHaveLength(1);
      expect(parsed.non_replayable[0]!.call_id).toBe('c2');
      expect(parsed.non_replayable[0]!.reason).toContain('缺结果');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('坏输入：JSONL 非法行 → 退出码 1（stderr 提示，不落产物）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-bad-'));
    try {
      const src = join(dir, 'events.jsonl');
      await writeFile(src, '{"not":"an event"}\n{broken json}\n', 'utf8');
      const { code, stderr } = await runCli(['--events', src, '--out', join(dir, 'out')], PRESET_ROOT);
      expect(code).toBe(1);
      expect(stderr.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('坏输入：事件源不存在 → 退出码 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-missing-'));
    try {
      const { code } = await runCli(['--events', join(dir, 'no-such-events.db'), '--out', join(dir, 'out')], PRESET_ROOT);
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('坏输入：缺 --out → 退出码 1（用法提示）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-arg-'));
    try {
      const { code } = await runCli(['--events', join(dir, 'x.jsonl')], PRESET_ROOT);
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('import 无副作用：仅 import 模块（非直接运行）→ 不写任何产物', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omb-rr-import-'));
    try {
      const before = readdirSync(dir).sort();
      const spec = pathToFileURL(SCRIPT).href;
      const { code, stderr } = await runNodeEval(`import(${JSON.stringify(spec)})`, PRESET_ROOT);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
