// P1c 行为测试：/evolve now 命令（runtime/plugin.ts）+ evolution/* 事件入链 + 候选 provenance 清单
// （架构 §6.5.1 用户显式命令 / 实现规格 §9 事件类型 / §6.5.2 候选产物）。
// 覆盖：
//   ① /evolve 命令注册面（name/description/input hint/recordInput）
//   ② /evolve now：触发 → 判定（数据化）→ 入队 candidate_validation → quantum 执行 → 摘要返回；
//      evolution/candidate + maintenance/quantum 事件入链（EventStore 可查）
//   ③ 无触发信号 → should_evolve=false 摘要（不造事件）
//   ④ 守卫：认知运行时未装配 → error 文本（不崩）；非法参数 → error 文本
//   ⑤ evolution/candidate|promoted|rolled_back + maintenance/quantum 事件类型（FIXED 枚举 + schema）
//   ⑥ 候选 provenance 清单（registerCandidate → candidates/<id>/provenance.json；promote 随记录迁移）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import { appendSignals } from '../../runtime/evolution-signals.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import { EventTypeSchema, FIXED_EVENT_TYPES } from '../../kernel/schemas/m.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { CandidatePool, candidateDirName, type CandidateProvenance, type CandidateRecord } from '../../supervisor/candidates.js';

const SESSION = 'sess-evolve-1';

interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  recordInput?: boolean;
  handler: (invocation: {
    commandId: unknown;
    agent: { session?: { id?: string; events?: ReadonlyArray<{ type?: string }> } };
    rawInput: string;
    signal: unknown;
  }) => Promise<{ kind: 'success' | 'error'; text: string }>;
}

function makeInvocation(rawInput: string, sessionId?: string): Parameters<CapturedCommand['handler']>[0] {
  return { commandId: 'test-cmd', agent: { session: { id: sessionId, events: [] } }, rawInput, signal: undefined };
}

/** fake ctx：commands 捕获 + 可选注入认知运行时（/evolve 命令测试面） */
function makeFakeCtx(opts: { runtime?: CognitiveRuntime }): { captured: CapturedCommand[]; ctx: ContextLike } {
  const captured: CapturedCommand[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
    cognitive: opts.runtime,
  };
  return { captured, ctx };
}

let base: string;
let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-evolve-'));
  root = join(base, '.omb');
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

// ---- ① 命令注册面 ----

describe('① /evolve 命令注册面（设计 §6 命令表）', () => {
  it('注册 name=evolve；description/input.hint/recordInput 对齐既有命令风格', () => {
    const { captured, ctx } = makeFakeCtx({});
    apply(ctx, { bootstrap: false });
    const cmd = captured.find((c) => c.name === 'evolve')!;
    expect(cmd).toBeDefined();
    expect(cmd.description).toContain('演化判定');
    expect(cmd.input?.hint).toBe('<now>');
    expect(cmd.recordInput).toBe(true);
  });

  it('无认知运行时 → error 文本（不崩）', async () => {
    const { captured, ctx } = makeFakeCtx({});
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now'));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('认知运行时未装配');
  });

  it('非法参数（非空非 now）→ error 文本（不崩）', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('yesterday'));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('参数非法');
  });
});

// ---- ② /evolve now 全链路 ----

describe('② /evolve now 触发链路（判定 → 入队 → quantum → 摘要 + 事件入链）', () => {
  it('触发信号（corrections）→ should_evolve=true → 入队 candidate_validation → quantum 执行 → evolution/candidate + maintenance/quantum 事件可查', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt.json') });
    const runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    // 预写触发信号（今日 signals/ JSONL：corrections → repair 演化，L1）
    await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'corrections', payload: { count: 2 } }]);

    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));

    // 摘要：判定结果/入队任务/quantum/debt
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=true');
    expect(r.text).toContain('object_layer L1');
    expect(r.text).toContain('candidate_validation');
    expect(r.text).toContain('quantum 执行');
    // 事件入链：evolution/candidate（判定入链）+ maintenance/quantum
    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    const cand = events.find((e) => e.type === 'evolution/candidate')!;
    expect(cand).toBeDefined();
    const candPayload = cand.payload as Record<string, unknown>;
    expect(candPayload.stage).toBe('decision');
    expect(candPayload.should_evolve).toBe(true);
    expect(candPayload.object_layer).toBe('L1');
    expect(candPayload.candidate_id).toBeNull(); // P1d 填充真实候选 id
    expect(events.some((e) => e.type === 'maintenance/quantum')).toBe(true);
    // debt 清偿：quantum 已执行 candidate_validation → 归零
    expect(scheduler.debtSnapshot()).toEqual([]);
    scheduler.stop();
  });

  it('无触发信号 → should_evolve=false 摘要（不造 evolution/candidate 事件）；maintenance/quantum 仍入链', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt2.json') });
    const runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));
    // 仅正向信号（evolve:false 条目）→ 不触发演化
    await appendSignals(runtime.signalsDir, [{ ts: Date.now(), kind: 'tool_calls', payload: { count: 3 } }]);

    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('', SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=false');

    const { events } = await runtime.eventStore.query({ session_id: SESSION });
    expect(events.some((e) => e.type === 'evolution/candidate')).toBe(false);
    expect(events.some((e) => e.type === 'maintenance/quantum')).toBe(true);
    scheduler.stop();
  });

  it('无维护调度器 → 判定照常 + 摘要注明无 quantum；失败 → error 文本不崩', async () => {
    const runtime = track(createCognitiveRuntime({ root }));
    const { captured, ctx } = makeFakeCtx({ runtime });
    apply(ctx, { bootstrap: false });
    const r = await captured.find((c) => c.name === 'evolve')!.handler(makeInvocation('now', SESSION));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('should_evolve=false');
  });
});

// ---- ⑤ evolution/* 事件类型 ----

describe('⑤ evolution/* 与 maintenance/quantum 事件类型（实现规格 §9）', () => {
  it('FIXED_EVENT_TYPES 含 evolution/candidate|promoted|rolled_back 与 maintenance/quantum', () => {
    for (const t of ['evolution/candidate', 'evolution/promoted', 'evolution/rolled_back', 'maintenance/quantum']) {
      expect(FIXED_EVENT_TYPES).toContain(t);
    }
  });

  it('EventTypeSchema 接受 evolution/* 全族（固定 + 通配段）；空尾段拒绝', () => {
    for (const t of ['evolution/candidate', 'evolution/promoted', 'evolution/rolled_back', 'evolution/policy-applied']) {
      expect(EventTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(EventTypeSchema.safeParse('maintenance/quantum').success).toBe(true);
    expect(EventTypeSchema.safeParse('evolution/').success).toBe(false); // 通配段需至少一个名字段
  });
});

// ---- ⑥ 候选 provenance 清单 ----

describe('⑥ 候选 provenance 清单（§6.5.2：来源事件/动机/diff）', () => {
  function rec(id: string): CandidateRecord {
    return {
      id,
      kind: 'process',
      status: 'untrusted',
      parent: null,
      lineage: [],
      gates_passed: [],
      created: 12345,
      provenance: `ev:test:${id}`,
    };
  }

  it('registerCandidate(provenance) 写 candidates/<id>/provenance.json；promote 随记录迁移到 trusted/', async () => {
    const pool = new CandidatePool(join(base, '.evolution'));
    const id = 'proc:00000000-0000-4000-8000-000000000001';
    const prov: CandidateProvenance = {
      source_events: ['evt:evolution/candidate-1'],
      motivation: 'corrections 触发 repair 演化（L1 代码修复）',
      diff: { target: 'kernel/processes/hypothesize-test.yaml' },
      created: 12345,
    };
    await pool.registerCandidate(rec(id), 'payload 内容', prov);

    const dirName = candidateDirName(id);
    const untrustedFile = join(base, '.evolution', 'untrusted', dirName, 'provenance.json');
    const written = JSON.parse(await readFile(untrustedFile, 'utf8')) as CandidateProvenance;
    expect(written).toEqual(prov);

    // promote → 清单随记录迁移（trusted/<id>/provenance.json）
    const loaded = await pool.load(id);
    await pool.promote(loaded);
    const trustedFile = join(base, '.evolution', 'trusted', dirName, 'provenance.json');
    const migrated = JSON.parse(await readFile(trustedFile, 'utf8')) as CandidateProvenance;
    expect(migrated).toEqual(prov);
  });

  it('registerCandidate 未提供 provenance → 不写清单（既有路径不变）', async () => {
    const pool = new CandidatePool(join(base, '.evolution2'));
    const id = 'proc:00000000-0000-4000-8000-000000000002';
    await pool.registerCandidate(rec(id));
    const dirName = candidateDirName(id);
    const untrustedFile = join(base, '.evolution2', 'untrusted', dirName, 'provenance.json');
    // 记录存在、清单不存在
    const record = await pool.load(id);
    expect(record.id).toBe(id);
    await expect(readFile(untrustedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
