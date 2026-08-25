// W2（未接线审计修复 2026-08-25）：TaskStore（任务库）写入接线测试——S1 建的 TaskStore
// （supervisor/verification-stores.ts）registerTask 原无生产调用点（存储就绪、无人写入）；
// 本次接线：writeShadowOutcome 契约种子后登记会话任务契约（runtime/assembly.ts）。
// 覆盖：
//   ① shadow 会话 finalizeTurn（经 FinalizeTurnInput.task 传 criteria）→ taskStore.getTask(`shadow:<id>`)
//     存在且字段齐全（task_id / contract_ref=契约 id / success_criteria 透传 / verifier_refs 两枚）+ 物理落盘
//     （缺省 <root>/.evolution/verification/tasks——不注入 verificationRoot）
//   ② 非 shadow 会话（无路由）→ 无登记（getTask null + tasks 目录不产生）
//   ③ 重复 finalize（同键覆写不重复）→ tasks 目录单文件、记录为最新
//   ④ criteria 空数组 → 仍登记（登记的是会话任务契约本身，与验证债务（criteria 非空才入队）路径独立）
//   ⑤ stores 未装配（白盒注入 fake 缺 tasks：registerTask 抛错）→ 不抛、outcome 正常、降级记录可审计
//   ⑥ 真实路由集成（git fixture，参照 tests/m8/shadow-route.test.ts 构造）：prepareTurn 真实分流 →
//     finalizeTurn → 登记存在且字段齐全
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHADOW_JUDGE_VERIFIER_ID,
  SHADOW_PROXY_VERIFIER_ID,
} from '../../kernel/shadow-contract.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import {
  buildLayoutFixture,
  teardownLayoutFixture,
  type LayoutFixture,
} from '../helpers/git.js';

/** fixture 构建超时（全量并行 git/icacls 饱和——与其他 m8 fixture 测试同款放宽） */
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

/** 桶会话（bucket 3 < exposure_rate=10——真实路由集成测试用；与 shadow-route.test.ts 同款固定 id） */
const BUCKET_SESSION = 's7-6';
const GOAL = 'retrieve verify'; // 命中 retrieve-verify 过程（与 shadow-route.test.ts 同款）

let root: string;
let runtimes: CognitiveRuntime[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-task-store-'));
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close().catch(() => undefined);
  }
  runtimes = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

/** 任务库物理目录（缺省 verificationRoot = <root>/.evolution/verification） */
function tasksDirOf(rootDir: string): string {
  return path.join(rootDir, '.evolution', 'verification', 'tasks');
}

/** 读取 shadows 目录全部 exposure-*.jsonl 条目（按行解析——outcome 断言面） */
function readOutcomeEntries(shadowsDir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(shadowsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(shadowsDir)
    .filter((f) => f.startsWith('exposure-') && f.endsWith('.jsonl'))
    .sort();
  const entries: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(shadowsDir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length > 0) {
        entries.push(JSON.parse(t) as Record<string, unknown>);
      }
    }
  }
  return entries;
}

/** 白盒注入 shadow 会话路由（形状与 computeShadowRoute 产出一致——finalizeTurn 回写前置条件） */
function pokeShadowSession(rt: CognitiveRuntime, sessionId: string): void {
  (
    rt as unknown as {
      shadowSessions: Map<string, { route: boolean; bucket: number; candidate_id: string; reason: string; task_domain: string }>;
    }
  ).shadowSessions.set(sessionId, {
    route: true,
    bucket: 3,
    candidate_id: 'latest',
    reason: 'test 注入',
    task_domain: 'general',
  });
}

/** 白盒替换任务库为 fake 缺 tasks（registerTask 抛错——模拟任务库未装配/损坏面） */
function pokeMissingTaskStore(rt: CognitiveRuntime): void {
  (
    rt as unknown as {
      taskStore: { registerTask: (task: unknown) => Promise<void>; getTask: (id: string) => Promise<unknown>; list: () => Promise<unknown[]> };
    }
  ).taskStore = {
    registerTask: async () => {
      throw new Error('任务库未装配（测试注入 fake）');
    },
    getTask: async () => {
      throw new Error('任务库未装配（测试注入 fake）');
    },
    list: async () => {
      throw new Error('任务库未装配（测试注入 fake）');
    },
  };
}

/** 最小 GovernorDecision（process.degraded 可注入——degraded 非空 → 契约硬约束 fail → FAIL） */
function decision(degraded?: string | null): Parameters<CognitiveRuntime['finalizeTurn']>[0]['decision'] {
  return {
    decision: 'Verify',
    reason: '测试决策',
    budget_allocation: { depth: 1, breadth: 1, tools: 1, retrieval: 1, branches: 1, context: 1 },
    expected_gain: 0.5,
    snapshot: 'rs:test',
    process: {
      kind: 'none',
      process_id: null,
      name: null,
      steps: [],
      method: 'none',
      applicability: null,
      budget_tokens: null,
      degraded: degraded ?? null,
    },
  };
}

/** 最小 PromptWorkingState */
function workingState(goal: string): Parameters<CognitiveRuntime['finalizeTurn']>[0]['working_state'] {
  return {
    goal,
    confirmed_facts: [],
    active_hypotheses: [],
    contradictions: [],
    open_questions: [],
    evidence_gaps: [],
    next_best_action: '',
    environment: 'test',
  };
}

/** 最小请求（真实路由集成测试的 prepareTurn 输入；session 可注入——shadow-route.test.ts 同款形状） */
function req(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    goal: GOAL,
    success_criteria: ['验证检索闭环'],
    constraints: [],
    working_state: {
      goal: GOAL,
      confirmed_facts: [],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: ['判别观测'],
      next_best_action: '',
      environment: 'test',
    },
  };
}

// ---- ①-⑤ 白盒集成（finalizeTurn 真实回写链；writeShadowOutcome 私有——shadowSessions 注入） ----

describe('W2 任务库写入接线 ①：shadow 会话 finalizeTurn → 任务登记（字段齐全 + 物理落盘）', () => {
  it('task 传 criteria → getTask(`shadow:<id>`) 存在：contract_ref=契约 id / success_criteria 透传 / verifier_refs 两枚', async () => {
    const rt = track(createCognitiveRuntime({ root })); // 不注入 verificationRoot → 缺省 <root>/.evolution/verification
    pokeShadowSession(rt, 'w2-session-1');
    const criteria = ['标准 1', '标准 2'];

    await rt.finalizeTurn({
      session_id: 'w2-session-1',
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: criteria },
    });

    const rec = await rt.taskStore.getTask('shadow:w2-session-1');
    expect(rec).not.toBeNull();
    expect(rec!.task_id).toBe('shadow:w2-session-1');
    // contract_ref 匹配验证契约 id（seedShadowContract 产物——契约判定可回溯）
    expect(rec!.contract_ref).toBe('shadow:w2-session-1');
    expect(rec!.success_criteria).toEqual(criteria); // 经 FinalizeTurnInput.task 透传
    expect(rec!.verifier_refs).toEqual([SHADOW_PROXY_VERIFIER_ID, SHADOW_JUDGE_VERIFIER_ID]);
    // 物理落盘（缺省 verificationRoot）：tasks 目录单 JSON、无 .tmp 残留（原子写）
    const files = fs.readdirSync(tasksDirOf(root));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('非 shadow 会话（未注入路由）→ 无登记（getTask null + tasks 目录不产生）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    await rt.finalizeTurn({
      session_id: 'not-shadow',
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: ['标准 1'] },
    });
    expect(await rt.taskStore.getTask('shadow:not-shadow')).toBeNull();
    expect(fs.existsSync(tasksDirOf(root))).toBe(false); // 首写才建目录——无登记零副作用
  });

  it('重复 finalize（同键覆写不重复）→ tasks 目录单文件、记录为最新', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, 'w2-session-2');
    const finalize = (criteria: string[]) =>
      rt.finalizeTurn({
        session_id: 'w2-session-2',
        decision: decision(null),
        working_state: workingState('目标 X'),
        task: { goal: '目标 X', success_criteria: criteria },
      });

    await finalize(['标准 1']);
    await finalize(['标准 1', '标准 2（覆写后）']);
    const files = fs.readdirSync(tasksDirOf(root));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1); // 同键覆写不新增
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect((await rt.taskStore.getTask('shadow:w2-session-2'))!.success_criteria).toEqual([
      '标准 1',
      '标准 2（覆写后）',
    ]);
    expect(await rt.taskStore.list()).toHaveLength(1);
  });

  it('criteria 空数组 → 仍登记（会话任务契约存在性；与验证债务（criteria 非空才入队）路径独立）', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, 'w2-session-3');
    await rt.finalizeTurn({
      session_id: 'w2-session-3',
      decision: decision(null),
      working_state: workingState('目标 X'),
      task: { goal: '目标 X', success_criteria: [] },
    });
    const rec = await rt.taskStore.getTask('shadow:w2-session-3');
    expect(rec).not.toBeNull();
    expect(rec!.success_criteria).toEqual([]);
    expect(rec!.verifier_refs).toHaveLength(2);
  });

  it('stores 未装配（注入 fake 缺 tasks：registerTask 抛错）→ 不抛、outcome 正常、降级记录可审计', async () => {
    const rt = track(createCognitiveRuntime({ root }));
    pokeShadowSession(rt, 'w2-session-4');
    pokeMissingTaskStore(rt);

    await expect(
      rt.finalizeTurn({
        session_id: 'w2-session-4',
        decision: decision('ETIMEDOUT 网络超时'), // 硬约束 fail → FAIL（outcome 回写路径仍走）
        working_state: workingState('目标 X'),
        task: { goal: '目标 X', success_criteria: ['标准 1'] },
      }),
    ).resolves.toBeDefined(); // 登记失败不阻塞 outcome 落盘
    // outcome 正常落盘（尽力而为：任务库缺失不污染 shadow 收尾）
    const entries = readOutcomeEntries(path.join(root, '.evolution', 'shadows'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.verdict).toBe('FAIL');
    expect(entries[0]!.contract_id).toBe('shadow:w2-session-4');
    // 降级记录可审计（hook=verification/tasks）
    expect(degradationLog().some((d) => d.hook === 'verification/tasks' && d.reason.includes('任务库登记失败'))).toBe(
      true,
    );
  });
});

// ---- ⑥ 真实路由集成（git fixture：prepareTurn 真实分流 → finalizeTurn → 登记） ----

describe('W2 任务库写入接线 ⑥：真实路由集成（参照 tests/m8/shadow-route.test.ts 构造）', () => {
  fixtureIt('shadow 桶会话 prepareTurn → finalizeTurn → taskStore.getTask 存在且字段齐全', async () => {
    const fx: LayoutFixture = buildLayoutFixture();
    try {
      const rt = track(
        createCognitiveRuntime({
          root,
          layout: { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest },
        }),
      );
      // 真实路由：桶会话（s7-6 bucket 3 < 10）→ latest 线快照 + exposure 落盘
      const p = await rt.prepareTurn(req(BUCKET_SESSION) as never);
      expect(p.snapshot).not.toBe(rt.snapshotHash); // 已真实分流（latest 线身份）

      await rt.finalizeTurn({
        session_id: BUCKET_SESSION,
        decision: p.decision,
        working_state: p.working_state,
        task: { goal: GOAL, success_criteria: ['验证检索闭环'] },
      });

      const rec = await rt.taskStore.getTask(`shadow:${BUCKET_SESSION}`);
      expect(rec).not.toBeNull();
      expect(rec!.contract_ref).toBe(`shadow:${BUCKET_SESSION}`);
      expect(rec!.success_criteria).toEqual(['验证检索闭环']);
      expect(rec!.verifier_refs).toEqual([SHADOW_PROXY_VERIFIER_ID, SHADOW_JUDGE_VERIFIER_ID]);
      // exposure + outcome 均正常（登记不干扰既有 shadow 收尾链）
      const entries = readOutcomeEntries(path.join(root, '.evolution', 'shadows'));
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.outcome !== 'pending')).toHaveLength(1);
    } finally {
      teardownLayoutFixture(fx);
    }
  });
});
