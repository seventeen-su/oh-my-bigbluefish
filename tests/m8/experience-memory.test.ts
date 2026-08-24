// R4（P0）闭环验证：Experience → staging（准入）→ 维护期 consolidation → memory/relation 可检索。
// 覆盖：
//   ① finalizeTurn（含 experience 产出）→ staging 有记录（priority/TTL 按 admission 语义写入，
//      payload 承载记忆候选——Episodic/Project/System-derived）
//   ② 准入过滤：无 provenance → 不入 staging（no-provenance）；量级守卫超限 → skip limit
//   ③ 重复去重：同内容经验重复 finalizeTurn → staging 不重复（stage no-op duplicate，内容哈希幂等键）
//   ④ 维护量子执行 memory_consolidation → memory 表可检索（backend.query 命中 + retrieve 命中）
//      + relation 建立（KIND_LINK_RULES：Decision → Episodic informs）+ 成功清债
//   ⑤ 幂等：重复 consolidation 不重复写入（memory 行数/relation 边不变、staging 空）
//   ⑥ 失败语义：consolidation 异常 → 任务失败 → debt 不清零（R5 DeferredMaintenanceError 最小落地）
// fixture：mkdtemp 临时 root（events.db/memory.db 落 .omb/）；Windows WAL 先 close 再 rm。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeMutableId } from '../../kernel/schemas/base.js';
import type { Event, Memory, MemoryKind, MemoryProvClass } from '../../kernel/schemas/m.js';
import type { Experience } from '../../kernel/schemas/c.js';
import { retrieve } from '../../memory/retrieve.js';
import { DEFAULT_TTL_MS } from '../../memory/staging.js';
import { MaintenanceScheduler } from '../../supervisor/maintenance.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import {
  buildExperienceCandidate,
  EXPERIENCE_STAGE_PRIORITY,
  experienceStageKey,
  MAX_EXPERIENCES_STAGED_PER_TURN,
} from '../../runtime/turn-helpers.js';
import { PROV, TS } from '../m1/ir-samples.js';

const SESSION = 'sess-r4-1';
const GOAL = '量子引力 全息对偶 判别实验';

let base: string;
let root: string;
let runtime: CognitiveRuntime;
let runtimes: CognitiveRuntime[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'omb-r4-'));
  root = join(base, '.omb');
  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close();
  }
  runtimes = [];
  await rm(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtime = rt;
  runtimes.push(rt);
  return rt;
}

const memoryDb = (): string => join(root, 'memory.db');

/** Governor 决策 fixture（与 turn-pipeline 同款） */
const decision = {
  decision: 'GenerateProcess',
  reason: 'rule: applicability=OOD, evidence_gaps=some, budget_ok=true → GenerateProcess',
  budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
  expected_gain: 0.5,
  snapshot: 'rs:assembly',
};

/** PromptWorkingState fixture */
const working = {
  goal: GOAL,
  confirmed_facts: [],
  active_hypotheses: [],
  contradictions: [],
  open_questions: ['全息对偶是否成立'],
  evidence_gaps: ['判别观测'],
  next_best_action: '',
  environment: 'test',
};

/** M3 Event 工厂（observeEvent 输入） */
function evt(type: string, payload: Record<string, unknown>, sessionId = SESSION): Event {
  const ts = new Date().toISOString();
  return {
    ir_version: '2.0',
    id: makeMutableId('evt'),
    schema: 'omb/M3',
    scope: 'Session',
    lifecycle: 'active',
    immutable: false,
    owner: 'kernel',
    created: ts,
    updated: ts,
    provenance: PROV,
    refs: [],
    type: type as Event['type'],
    session_id: sessionId,
    runtime_snapshot: 'rs:test',
    parent_event: null,
    payload,
    timestamp: ts,
  };
}

/** M1 Memory 工厂（relation/dedup 素材） */
function makeMemory(payload: string, kind: MemoryKind, prov_class: MemoryProvClass = 'Observation'): Memory {
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
    kind,
    prov_class,
    payload,
    value_score: 0.5,
    utility_counts: { retrieval: 0, hit: 0, miss: 0, inject: 0, decay: 0, promote: 0 },
  } as unknown as Memory;
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
function stagingRows(): StagingRow[] {
  const conn = new DatabaseSync(memoryDb());
  try {
    return conn.prepare('SELECT id, event_id, priority, ttl_until, payload, created FROM staging').all() as unknown as StagingRow[];
  } finally {
    conn.close();
  }
}

function stagingCount(): number {
  return stagingRows().length;
}

describe('R4 Experience Admission（finalizeTurn → staging）', () => {
  it('finalizeTurn（含 experience 产出）→ staging 有记录：priority/TTL 按准入语义写入，payload 承载记忆候选', async () => {
    runtime = track(createCognitiveRuntime({ root }));

    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });

    expect(res.experience).not.toBeNull();
    expect(res.experience_admission).toEqual({ staged: 1, skipped: [] });
    // staging 行：priority = EXPERIENCE_STAGE_PRIORITY、TTL = 默认 7 天
    const rows = stagingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priority).toBe(EXPERIENCE_STAGE_PRIORITY);
    expect(rows[0]!.ttl_until - rows[0]!.created).toBe(DEFAULT_TTL_MS);
    // 幂等键 = 内容哈希（experienceStageKey）
    expect(rows[0]!.event_id).toBe(experienceStageKey(res.experience!));
    // payload 承载记忆候选（admit 的 memoryCandidate 输入面：Episodic/Project/System-derived）
    const payloadEvent = JSON.parse(rows[0]!.payload) as { payload: { memory: Record<string, unknown> } };
    expect(payloadEvent.payload.memory.kind).toBe('Episodic');
    expect(payloadEvent.payload.memory.scope).toBe('Project');
    expect(payloadEvent.payload.memory.prov_class).toBe('System-derived');
    expect(String(payloadEvent.payload.memory.payload)).toContain(GOAL);
  });

  it('准入过滤：无 provenance 的 experience 不入 staging（no-provenance）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const baseExp = buildExperienceCandidate(SESSION, decision as never, working as never)!;
    const noSource = { ...baseExp, provenance: { ...baseExp.provenance, source: '' } } as unknown as Experience;

    const res = await runtime.stageExperiences([noSource], SESSION);

    expect(res).toEqual({ staged: 0, skipped: [{ id: noSource.id, reason: 'no-provenance' }] });
    expect(stagingCount()).toBe(0);
  });

  it('重复去重：同内容经验重复 finalizeTurn → staging 不重复（stage no-op duplicate，内容哈希幂等键）', async () => {
    runtime = track(createCognitiveRuntime({ root }));

    const r1 = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });
    expect(r1.experience_admission.staged).toBe(1);

    // 同内容（同 goal/decision/reason；时间戳不同不参与幂等键）→ 第二次 stage no-op
    const r2 = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });
    expect(r2.experience_admission.staged).toBe(0);
    expect(r2.experience_admission.skipped).toHaveLength(1);
    expect(r2.experience_admission.skipped[0]!.reason).toBe('duplicate');
    expect(stagingCount()).toBe(1); // staging 不重复
  });

  it('量级守卫：每 finalizeTurn 最多 staging MAX_EXPERIENCES_STAGED_PER_TURN 条（超出 → skip limit）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    // 内容互异的批候选（不同 goal → 不同幂等键）
    const batch: Experience[] = Array.from({ length: MAX_EXPERIENCES_STAGED_PER_TURN + 1 }, (_, i) =>
      buildExperienceCandidate(SESSION, { ...decision, reason: `reason-${i}` } as never, {
        ...working,
        goal: `${GOAL} 变体${i}`,
      } as never)!,
    );

    const res = await runtime.stageExperiences(batch, SESSION);

    expect(res.staged).toBe(MAX_EXPERIENCES_STAGED_PER_TURN);
    expect(res.skipped).toEqual([
      { id: batch[MAX_EXPERIENCES_STAGED_PER_TURN]!.id, reason: 'limit' },
    ]);
    expect(stagingCount()).toBe(MAX_EXPERIENCES_STAGED_PER_TURN);
  });
});

describe('R4 维护期 consolidation（memory_consolidation 任务）', () => {
  it('维护量子执行 memory_consolidation → memory 表可检索 + relation 建立（Decision→Episodic informs）+ 成功清债', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt.json') });
    runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));

    // 预置决策记忆（relation 邻接表 Decision → Episodic informs 的 from 侧）
    const decisionId = await runtime.memory.ingest(makeMemory('采用 SQLite 存储方案', 'Decision'));
    // 会话事实 + 收尾：经验入 staging + memory_consolidation 债务入账
    await runtime.observeEvent(evt('session/start', { goal: GOAL }));
    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });
    expect(res.experience_admission.staged).toBe(1);
    expect(scheduler.debtSnapshot().some((d) => d.task_id === 'memory_consolidation')).toBe(true);

    // 维护量子：逐个执行直至 memory_consolidation 完成（空闲期调度面）
    const ran: string[] = [];
    for (let i = 0; i < 12 && !ran.includes('memory_consolidation'); i++) {
      const report = await scheduler.requestQuantum();
      if (report.ran.length === 0) break;
      ran.push(...report.ran);
    }
    expect(ran).toContain('memory_consolidation');

    // memory 落库（backend.query 命中新写入记忆）
    const page = await runtime.memory.query({ scope: 'Project', kind: 'Episodic', limit: 10, budget: 100 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.payload).toContain(GOAL);
    expect(page.items[0]!.provenance.event).toBe(experienceStageKey(res.experience!));
    // 生产检索面命中（自学习闭环：后续请求可检索新写入记忆）
    const retrieved = await retrieve(runtime.memory, { scope: 'Project', text: GOAL, limit: 3, budget: 1000 });
    expect(retrieved.items.some((r) => r.memory.kind === 'Episodic' && r.memory.payload.includes(GOAL))).toBe(true);
    // relation 建立（KIND_LINK_RULES：Decision → Episodic informs）
    const walk = await runtime.memory.relationTraverse(decisionId, ['informs'], 1);
    const toIds = walk.nodes.find((n) => n.id === decisionId)?.relations.map((r) => r.to_id) ?? [];
    expect(toIds).toContain(page.items[0]!.id);
    // 成功执行 → 清偿（债务归零）
    expect(scheduler.debtSnapshot().some((d) => d.task_id === 'memory_consolidation')).toBe(false);
    scheduler.stop();
  });

  it('幂等：重复 consolidation 不重复写入（memory 行数/relation 边不变、staging 空）', async () => {
    runtime = track(createCognitiveRuntime({ root }));
    const decisionId = await runtime.memory.ingest(makeMemory('采用 SQLite 存储方案', 'Decision'));
    await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });

    await runtime.runMemoryConsolidation();
    const page1 = await runtime.memory.query({ scope: 'Project', limit: 100, budget: 1e9 });
    expect(page1.total).toBe(2); // Decision + Episodic（经验）
    expect(stagingCount()).toBe(0); // admit 后 staging 清空
    const edges1 =
      (await runtime.memory.relationTraverse(decisionId, ['informs'], 1)).nodes.find((n) => n.id === decisionId)
        ?.relations.filter((r) => r.type === 'informs').length ?? 0;
    expect(edges1).toBe(1);

    // 第二次 consolidation → 无新增（admit 空 staging；dedup/merge/relation/decay 全 0 变更）
    await runtime.runMemoryConsolidation();
    const page2 = await runtime.memory.query({ scope: 'Project', limit: 100, budget: 1e9 });
    expect(page2.total).toBe(2);
    expect(page2.items.map((m) => m.id).sort()).toEqual(page1.items.map((m) => m.id).sort());
    const edges2 =
      (await runtime.memory.relationTraverse(decisionId, ['informs'], 1)).nodes.find((n) => n.id === decisionId)
        ?.relations.filter((r) => r.type === 'informs').length ?? 0;
    expect(edges2).toBe(1); // relation 不重复（hasRelation 查重）
    expect(stagingCount()).toBe(0);
  });

  it('失败语义：consolidation 异常 → 任务失败 → debt 不清零（R5 DeferredMaintenanceError 最小落地）', async () => {
    const scheduler = new MaintenanceScheduler({ debtFile: join(base, 'debt.json') });
    runtime = track(createCognitiveRuntime({ root, maintenance: scheduler }));

    // 经验入 staging → memory_consolidation 债务入账（accrueDebt）
    const res = await runtime.finalizeTurn({
      session_id: SESSION,
      decision: decision as never,
      working_state: working as never,
    });
    expect(res.experience_admission.staged).toBe(1);
    expect(scheduler.debtSnapshot().some((d) => d.task_id === 'memory_consolidation')).toBe(true);

    // 破坏执行面：staging 连接关闭 → runMemoryConsolidation 的 sweepExpired/admit 抛错
    await runtime.staging.close();
    await expect(runtime.runMemoryConsolidation()).rejects.toThrow();

    // 维护量子逐任务执行：memory_consolidation 失败 → 出队但债务保留（不清零——不再空实现假成功）
    for (let i = 0; i < 12; i++) {
      const report = await scheduler.requestQuantum();
      if (report.ran.length === 0) break;
    }
    expect(scheduler.debtSnapshot().some((d) => d.task_id === 'memory_consolidation')).toBe(true);
    scheduler.stop();
  });
});
