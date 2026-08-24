// S7（2026-08-24-completion-sweep）：Shadow/Canary 真实放量路由测试（per-session shadow 路由）。
// 覆盖（计划 §S7 交付物 5）：
//   路由纯函数（kernel/shadow-route.ts）：桶确定性/与 shadow.ts bucketFor 对齐/分叉判定/rate 边界/
//     配置缺省与非法（exposure_rate 0..100 fail-loud）
//   per-session 生效（fixture 两线分叉）：shadow 桶会话 prepareTurn 快照含 latest commit（= line:'latest'
//     运行时装配哈希——快照身份真实不同）；policy/processes 按 latest 线加载（两线内容不同 → 加载内容不同）；
//     非桶会话不变（装配线快照/策略）
//   exposure/outcome：首请求落盘 .evolution/shadows/exposure-<date>.jsonl（格式对齐 readShadowSignals：
//     candidate_id/bucket/session_id/task_domain/exposure_ts/outcome 占位）；finalizeTurn 回写 success/degraded；
//     同会话二次 prepareTurn 不重复写 exposure
//   L2 消费：readShadowSignals 目录扫描（exposure.log + exposure-<date>.jsonl 双格式并存不重复计数）；
//     outcome 数据 → shouldPromoteToStable 失败率统计真实纳入（拒晋升）
//   零开销：无 trusted-latest 差异 / 未启用 / trusted-latest 缺失 → 默认路径（快照=装配线、无 exposure 落盘）
//   WorldModel：worldModelFor 反映生效线（shadow 会话 latest / 非桶 stable）；运行时级 worldModel 不变
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from '../../kernel/policy-loader.js';
import { shadowBucket, shouldRouteShadow, type ShadowRouteInput } from '../../kernel/shadow-route.js';
import { shouldPromoteToStable } from '../../kernel/promotion-gate.js';
import { S4Schema } from '../../kernel/schemas/s.js';
import { bucketFor } from '../../supervisor/shadow.js';
import { readShadowSignals } from '../../supervisor/promotion.js';
import { createCognitiveRuntime, type CognitiveRuntime } from '../../runtime/assembly.js';
import { clearDegradations } from '../../runtime/loop-hooks.js';
import { ensureLineSnapshot } from '../../substrate/lines.js';
import { buildLayoutFixture, runGit, teardownLayoutFixture, type LayoutFixture } from '../helpers/git.js';

/** fixture 构建超时（全量并行 git/icacls 饱和——与其他 m8 fixture 测试同款放宽） */
const FIXTURE_TIMEOUT = 30000;
const fixtureIt = (name: string, fn: (() => void) | (() => Promise<void>)) => it(name, fn, FIXTURE_TIMEOUT);

/** 桶会话（bucket < exposure_rate=10，candidate_id='latest'）与非桶会话（bucket ≥ 10）——预计算固定 id */
const BUCKET_SESSION = 's7-6'; // bucket 3
const BUCKET_SESSION_2 = 's7-9'; // bucket 9
const NON_BUCKET_SESSION = 's8-6'; // bucket 69
const GOAL = 'retrieve verify'; // 命中 retrieve-verify 过程（Strong——decision.process 可观测预算）

function layoutFor(fx: LayoutFixture): { bareRepo: string; stableWorktree: string; latestWorktree: string } {
  return { bareRepo: fx.bare, stableWorktree: fx.stable, latestWorktree: fx.latest };
}

/** 最小请求（prepareTurn 输入；session 可注入） */
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

const POLICY_DIR = path.join(process.cwd(), 'kernel', 'policy');

let base: string;
let fx: LayoutFixture;
let runtimes: CognitiveRuntime[];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-shadow-route-'));
  fx = buildLayoutFixture();
  runtimes = [];
  clearDegradations();
});

afterEach(async () => {
  for (const rt of runtimes) {
    await rt.close().catch(() => undefined);
  }
  runtimes = [];
  teardownLayoutFixture(fx);
  fs.rmSync(base, { recursive: true, force: true });
});

function track(rt: CognitiveRuntime): CognitiveRuntime {
  runtimes.push(rt);
  return rt;
}

function rootOf(name: string): string {
  return path.join(base, name, 'workspace', '.omb');
}

function shadowsDirOf(root: string): string {
  return path.join(root, '.evolution', 'shadows');
}

/** 读取 shadows 目录全部 exposure-*.jsonl 条目（按行解析） */
function readExposureEntries(shadowsDir: string): Array<Record<string, unknown>> {
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

describe('S7 路由纯函数（kernel/shadow-route.ts）', () => {
  it('shadowBucket：确定性（同输入同桶）+ 范围 [0,100) + 与 supervisor/shadow.ts bucketFor 对齐', () => {
    const a = shadowBucket('sess-1', 'cand-1');
    const b = shadowBucket('sess-1', 'cand-1');
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    // 对齐先例：shadowBucket(session, candidate) === bucketFor(session + candidate)（同 sha256 前 2 字节 % 100）
    expect(shadowBucket('sess-1', 'cand-1')).toBe(bucketFor('sess-1cand-1'));
    expect(shadowBucket('s7-6', 'latest')).toBe(bucketFor('s7-6latest'));
    // 不同输入（大概率）不同桶
    expect(shadowBucket('sess-1', 'cand-2')).not.toBe(shadowBucket('sess-2', 'cand-1'));
  });

  it('shouldRouteShadow：未启用 → 不路由；无 commit → 不路由；两线未分叉 → 不路由（零开销）', () => {
    const policy = { enabled: true, exposure_rate: 10 };
    const base: ShadowRouteInput = {
      session_id: BUCKET_SESSION,
      candidate_id: 'latest',
      trusted_latest_commit: 'b'.repeat(40),
      stable_commit: 'a'.repeat(40),
      policy,
    };
    // 未启用（即使分叉 + 桶内）→ 不路由
    expect(shouldRouteShadow({ ...base, policy: { enabled: false, exposure_rate: 10 } }).route).toBe(false);
    // 无线状态（commit 缺省 null）→ 不路由
    expect(shouldRouteShadow({ ...base, trusted_latest_commit: null }).route).toBe(false);
    expect(shouldRouteShadow({ ...base, stable_commit: null }).route).toBe(false);
    // 两线未分叉 → 不路由
    const noDivergence = shouldRouteShadow({ ...base, trusted_latest_commit: 'a'.repeat(40) });
    expect(noDivergence.route).toBe(false);
    expect(noDivergence.reason).toContain('未分叉');
  });

  it('shouldRouteShadow：桶 < exposure_rate → 路由；≥ → 不路由（rate 边界 + reason 可审计）', () => {
    const policy = { enabled: true, exposure_rate: 10 };
    const base: ShadowRouteInput = {
      session_id: BUCKET_SESSION,
      candidate_id: 'latest',
      trusted_latest_commit: 'b'.repeat(40),
      stable_commit: 'a'.repeat(40),
      policy,
    };
    // s7-6 bucket=3 < 10 → 路由
    const routed = shouldRouteShadow({
      ...base,
      session_id: BUCKET_SESSION,
      candidate_id: 'latest',
    });
    expect(routed.route).toBe(true);
    expect(routed.bucket).toBe(shadowBucket(BUCKET_SESSION, 'latest'));
    expect(routed.reason).toContain('shadow 分流');
    // s8-6 bucket=69 ≥ 10 → 不路由
    const notRouted = shouldRouteShadow({
      ...base,
      session_id: NON_BUCKET_SESSION,
      candidate_id: 'latest',
    });
    expect(notRouted.route).toBe(false);
    expect(notRouted.bucket).toBe(shadowBucket(NON_BUCKET_SESSION, 'latest'));
    expect(notRouted.reason).toContain('不曝光');
    // exposure_rate=0 → 恒不路由（桶 ≥ 0）；=100 → 恒路由（桶 < 100）
    expect(shouldRouteShadow({ ...base, policy: { enabled: true, exposure_rate: 0 } }).route).toBe(false);
    expect(shouldRouteShadow({ ...base, policy: { enabled: true, exposure_rate: 100 } }).route).toBe(true);
  });

  it('配置缺省：evolve.yaml 无 shadow 段 → 出厂缺省（enabled=true、exposure_rate=10）', async () => {
    const dir = path.join(base, 'cfg-default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'evolve.yaml'),
      'daily_evolution_cost: 100\nroi_min: 1.0\nmaintenance_rate: 0.5\nsignal_triggers: {}\n',
      'utf8',
    );
    for (const f of ['governor.yaml', 'budget.yaml', 'context.yaml']) {
      fs.copyFileSync(path.join(POLICY_DIR, f), path.join(dir, f));
    }
    const policy = await loadPolicy(dir);
    expect(policy.evolve.shadow).toEqual({ enabled: true, exposure_rate: 10 });
  });

  it('配置非法：exposure_rate 越界（101 / -1 / 非整数）→ loadPolicy fail-loud', async () => {
    for (const bad of ['101', '-1', '2.5']) {
      const dir = path.join(base, `cfg-bad-${bad.replace('.', '-')}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ['governor.yaml', 'budget.yaml', 'context.yaml']) {
        fs.copyFileSync(path.join(POLICY_DIR, f), path.join(dir, f));
      }
      fs.writeFileSync(
        path.join(dir, 'evolve.yaml'),
        `daily_evolution_cost: 100\nroi_min: 1.0\nmaintenance_rate: 0.5\nshadow:\n  enabled: true\n  exposure_rate: ${bad}\n`,
        'utf8',
      );
      await expect(loadPolicy(dir)).rejects.toThrow();
    }
  });
});

describe('S7 per-session 生效（fixture 两线分叉：stable=initialHash ≠ trusted-latest=latestHash）', () => {
  fixtureIt('shadow 桶会话 prepareTurn 快照含 latest commit（= line:latest 运行时装配哈希）；非桶会话不变', async () => {
    const layout = layoutFor(fx);
    const rtStable = track(createCognitiveRuntime({ root: rootOf('stable'), layout, line: 'stable' }));
    const rtLatest = track(createCognitiveRuntime({ root: rootOf('latest'), layout, line: 'latest' }));

    // 桶会话（s7-6 bucket 3 < 10）→ 快照 = latest 线身份（≠ 装配线 stable 快照）
    const pShadow = await rtStable.prepareTurn(req(BUCKET_SESSION) as never);
    expect(pShadow.snapshot).toBe(rtLatest.snapshotHash); // 与 line:'latest' 运行时装配哈希一致（含 latest commit）
    expect(pShadow.snapshot).not.toBe(rtStable.snapshotHash); // 快照身份真实不同（线 commit 纳入哈希）

    // 非桶会话（s8-6 bucket 69 ≥ 10）→ 装配线快照（默认路径不变）
    const pStable = await rtStable.prepareTurn(req(NON_BUCKET_SESSION) as never);
    expect(pStable.snapshot).toBe(rtStable.snapshotHash);
  });

  fixtureIt('policy/processes 按线加载：latest 线内容不同 → shadow 会话用 latest 线过程预算；非桶会话用装配线', async () => {
    const layout = layoutFor(fx);
    // 物化 latest 线快照 → 改写其 processes/retrieve-verify.yaml budget.tokens（两线内容不同）
    const latestSnap = ensureLineSnapshot(layout, 'latest');
    const target = path.join(latestSnap.dir, 'kernel', 'processes', 'retrieve-verify.yaml');
    const raw = fs.readFileSync(target, 'utf8');
    expect(raw).toContain('tokens: 8000');
    fs.writeFileSync(target, raw.replace('tokens: 8000', 'tokens: 9876'), 'utf8');

    const rt = track(createCognitiveRuntime({ root: rootOf('r'), layout }));
    // shadow 桶会话 → 过程预算来自 latest 线（9876）
    const pShadow = await rt.prepareTurn(req(BUCKET_SESSION) as never);
    expect(pShadow.decision.process?.process_id).toBe('retrieve-verify');
    expect(pShadow.decision.process?.budget_tokens).toBe(9876);
    // 非桶会话 → 装配线（stable）过程预算（8000）
    const pStable = await rt.prepareTurn(req(NON_BUCKET_SESSION) as never);
    expect(pStable.decision.process?.process_id).toBe('retrieve-verify');
    expect(pStable.decision.process?.budget_tokens).toBe(8000);
  });

  fixtureIt('exposure 落盘：shadow 桶会话首请求写 exposure-<date>.jsonl（格式对齐 readShadowSignals）；非桶会话不落盘', async () => {
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));

    // 桶会话首请求 → exposure 条目（outcome 占位 'pending'）
    await rt.prepareTurn(req(BUCKET_SESSION) as never);
    const shadowsDir = shadowsDirOf(root);
    const entries = readExposureEntries(shadowsDir);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.candidate_id).toBe('latest'); // 无演化对象 → 'latest' 标记
    expect(e.bucket).toBe(shadowBucket(BUCKET_SESSION, 'latest'));
    expect(e.session_id).toBe(BUCKET_SESSION);
    expect(e.task_domain).toBe('general');
    expect(typeof e.exposure_ts).toBe('number');
    expect(e.outcome).toBe('pending');

    // 同会话二次请求 → 不重复写（首请求只写一次）
    await rt.prepareTurn(req(BUCKET_SESSION) as never);
    expect(readExposureEntries(shadowsDir)).toHaveLength(1);
  });

  fixtureIt('非桶会话（未启用分流）→ 零 exposure 落盘（shadows 目录不产生）', async () => {
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));
    await rt.prepareTurn(req(NON_BUCKET_SESSION) as never);
    expect(fs.existsSync(shadowsDirOf(root))).toBe(false);
  });
});

describe('S7 exposure/outcome 与 L2 消费', () => {
  fixtureIt('finalizeTurn 回写 outcome：success（正常决策）/ degraded（决策链降级代理）；readShadowSignals 同键最后一条胜出', async () => {
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));
    const shadowsDir = shadowsDirOf(root);

    // 桶会话 A：正常决策 → outcome 'success'
    const pA = await rt.prepareTurn(req(BUCKET_SESSION) as never);
    await rt.finalizeTurn({ session_id: BUCKET_SESSION, decision: pA.decision, working_state: pA.working_state });
    // 桶会话 B：决策链降级代理（process.degraded 非空）→ outcome 'degraded'
    const pB = await rt.prepareTurn(req(BUCKET_SESSION_2) as never);
    const degradedDecision = {
      ...pB.decision,
      process: {
        kind: 'none' as const,
        process_id: null,
        name: null,
        steps: [],
        method: 'none' as const,
        applicability: null,
        budget_tokens: null,
        degraded: 'process/schedule: 测试降级',
      },
    };
    await rt.finalizeTurn({ session_id: BUCKET_SESSION_2, decision: degradedDecision, working_state: pB.working_state });

    // 每条会话 2 条（exposure pending + outcome）→ 同 (session,candidate) 键最后一条胜出
    const entries = readExposureEntries(shadowsDir);
    expect(entries).toHaveLength(4);
    const outcomes = entries.filter((e) => e.outcome === 'success' || e.outcome === 'degraded');
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((e) => e.session_id === BUCKET_SESSION)?.outcome).toBe('success');
    expect(outcomes.find((e) => e.session_id === BUCKET_SESSION_2)?.outcome).toBe('degraded');

    // L2 读取：目录扫描（含按日分片文件）→ n=2、failures=1（degraded 计入失败）
    const signals = await readShadowSignals(shadowsDir);
    expect(signals).toEqual({ n: 2, failures: 1 });
  });

  it('readShadowSignals：双格式并存不重复计数（G4 decision 条目 + S7 per-session 条目）；文件模式兼容', async () => {
    const dir = path.join(base, 'shadows');
    fs.mkdirSync(dir, { recursive: true });
    // 既有 G4/T5.3 格式（decision 字段）——exposure.log
    fs.writeFileSync(
      path.join(dir, 'exposure.log'),
      [
        JSON.stringify({ ts: 1, candidate_id: 'c:1', seed: 's', bucket: 3, layer: 'L0', decision: 'shadow' }),
        JSON.stringify({ ts: 2, candidate_id: 'c:1', seed: 's', bucket: 3, layer: 'L0', decision: 'shadow' }),
        JSON.stringify({ ts: 3, candidate_id: 'c:2', seed: 's', bucket: 7, layer: 'tier1', decision: 'canary_rollback', outcome: 'ok' }),
        JSON.stringify({ ts: 4, candidate_id: 'c:3', seed: 's', bucket: 9, layer: 'tier1', decision: 'canary_rollback', outcome: 'restore_failed' }),
        'not-json-line\n', // 单行损坏跳过
      ].join('\n'),
      'utf8',
    );
    // S7 per-session 格式——按日分片（同键 pending → success 覆盖；degraded 计入失败）
    fs.writeFileSync(
      path.join(dir, 'exposure-2026-08-24.jsonl'),
      [
        JSON.stringify({ candidate_id: 'latest', bucket: 3, session_id: 'a1', task_domain: 'general', exposure_ts: 1, outcome: 'pending' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 3, session_id: 'a1', task_domain: 'general', exposure_ts: 2, outcome: 'success' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 9, session_id: 'b2', task_domain: 'general', exposure_ts: 3, outcome: 'pending' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 9, session_id: 'b2', task_domain: 'general', exposure_ts: 4, outcome: 'degraded' }),
        JSON.stringify({ candidate_id: 'latest', bucket: 5, session_id: 'c3', task_domain: 'general', exposure_ts: 5, outcome: 'pending' }), // 仅曝光未收尾 → n 计入、失败不计
      ].join('\n'),
      'utf8',
    );
    const signals = await readShadowSignals(dir);
    // G4：shadow×2 → n+2；canary_rollback ok → n+1 失败+1；canary_rollback restore_failed → n+1 失败+1 → n=4 failures=2
    // S7：a1/b2/c3 三键 → n+3；b2 degraded → 失败+1 → n=3 failures=1
    // 合计 n=7 failures=3
    expect(signals).toEqual({ n: 7, failures: 3 });
    // 文件模式兼容（旧契约：单文件路径）
    const fileSignals = await readShadowSignals(path.join(dir, 'exposure-2026-08-24.jsonl'));
    expect(fileSignals).toEqual({ n: 3, failures: 1 });
    // 缺失目录 → 空
    expect(await readShadowSignals(path.join(base, 'no-such-dir'))).toEqual({ n: 0, failures: 0 });
  });

  it('L2 门禁：有 outcome 数据 → shadow 失败率统计真实纳入（超限拒晋升）', () => {
    const policy = { min_shadow_samples: 1, max_shadow_failure_rate: 0.1, cost_degradation_tolerance: 0.1 };
    const base = {
      baseline: { stable_commit: 'a'.repeat(40), stable_bench: { passed: 10, total: 10 } },
      candidate: { latest_commit: 'b'.repeat(40), latest_bench: { passed: 10, total: 10 } },
      cost_degradation_ratio: 0,
      policy,
    };
    // 全部 success → L2 通过
    const ok = shouldPromoteToStable({ ...base, shadow_signals: { n: 5, failures: 0 } });
    expect(ok.ok).toBe(true);
    // degraded 超限（1/2 = 50% > 10%）→ 拒晋升（L2 拒绝原因）
    const reject = shouldPromoteToStable({ ...base, shadow_signals: { n: 2, failures: 1 } });
    expect(reject.ok).toBe(false);
    expect(reject.reasons.some((r) => r.includes('L2 统计') && r.includes('拒绝'))).toBe(true);
  });
});

describe('S7 零开销（默认路径不变）', () => {
  fixtureIt('无 trusted-latest 差异（stable == trusted-latest）→ 桶会话仍走装配线快照，无 exposure', async () => {
    // 推进 stable = trusted-latest（无分叉）——桶会话也不路由
    runGit(['update-ref', 'refs/heads/stable', fx.latestHash], { cwd: fx.bare });
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));
    const p = await rt.prepareTurn(req(BUCKET_SESSION) as never); // 桶 3 但无分叉
    expect(p.snapshot).toBe(rt.snapshotHash);
    expect(fs.existsSync(shadowsDirOf(root))).toBe(false);
  });

  fixtureIt('shadow 未启用（装配线 evolve.yaml enabled=false）→ 分叉存在仍不路由，无 exposure', async () => {
    // 改写装配线（stable）物化快照 evolve.yaml → shadow.enabled=false
    const layout = layoutFor(fx);
    const stableSnap = ensureLineSnapshot(layout, 'stable');
    const evolvePath = path.join(stableSnap.dir, 'kernel', 'policy', 'evolve.yaml');
    const raw = fs.readFileSync(evolvePath, 'utf8');
    expect(raw).toContain('shadow:');
    fs.writeFileSync(evolvePath, raw.replace('  enabled: true', '  enabled: false'), 'utf8');

    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));
    const p = await rt.prepareTurn(req(BUCKET_SESSION) as never); // 分叉 + 桶内但禁用
    expect(p.snapshot).toBe(rt.snapshotHash);
    expect(fs.existsSync(shadowsDirOf(root))).toBe(false);
  });

  fixtureIt('trusted-latest 缺失 → 不路由（旧种子布局降级路径），无 exposure', async () => {
    runGit(['update-ref', '-d', 'refs/heads/trusted-latest'], { cwd: fx.bare });
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));
    const p = await rt.prepareTurn(req(BUCKET_SESSION) as never);
    expect(p.snapshot).toBe(rt.snapshotHash);
    expect(fs.existsSync(shadowsDirOf(root))).toBe(false);
    // 快路径判定可审计（不崩）：effectiveLineFor 仍可用且返回当前线
    await expect(rt.effectiveLineFor(BUCKET_SESSION)).resolves.toBe('stable');
  });
});

describe('S7 WorldModel/状态显示（effectiveLine 反映到 per-request 模型视图）', () => {
  fixtureIt('worldModelFor：shadow 桶会话 → latest 线视图（line/commit）；非桶会话 → 当前线；运行时级模型不变', async () => {
    const layout = layoutFor(fx);
    const root = rootOf('r');
    const rt = track(createCognitiveRuntime({ root, layout }));

    const wmShadow = await rt.worldModelFor(BUCKET_SESSION);
    expect(wmShadow.line).toBe('latest');
    expect(wmShadow.commit).toBe(fx.latestHash); // latest 线 commit（快照身份真实）
    expect(wmShadow.line_snapshot?.line).toBe('latest');
    expect(S4Schema.safeParse(wmShadow).success).toBe(true);

    const wmStable = await rt.worldModelFor(NON_BUCKET_SESSION);
    expect(wmStable.line).toBe('stable');
    expect(wmStable.commit).toBe(fx.initialHash);

    // 运行时级 worldModel（既有缓存）不受 per-request 影响——仍为装配线
    expect(rt.worldModel.line).toBe('stable');

    // effectiveLineFor：桶会话 → latest；非桶 → 当前线
    await expect(rt.effectiveLineFor(BUCKET_SESSION)).resolves.toBe('latest');
    await expect(rt.effectiveLineFor(NON_BUCKET_SESSION)).resolves.toBe('stable');
  });
});
