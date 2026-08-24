// T8.2 行为测试：/mode 内部版本线切换（单模式）+ /bench 注册（runtime/plugin.ts，research-dsh.md §2）。
// - /mode = OMB 内部版本线切换（单模式）：load 校验 + 空白会话守卫 + onSwitch 记账（激活记录落盘）；
//   不涉及 DSH 预设切换——ctx 提供 agentPresets.recompose 也不会被调用（recompose 能力已从插件移除）。
// - /bench（T2.3 起默认 v2 契约基准）：注册 bench 命令；handler 默认走 supervisor/bench-v2.ts runBenchV2
//  （20 契约 + 回放执行器，明细 replay-v2-<line>-<ts>.jsonl）；`config.benchVersion: 'v1'` 切回 legacy
//  （supervisor/bench.ts runBench，明细 replay-<line>-<ts>.jsonl——v1 语义原样保留）。
// - /bench × P4（D6 全任务双判）：modelAdapter 存在 → v2 分支注入 LLM judge（makeJudgeV2，同一 adapter
//   ——exec 与 judge 双路调用；20 任务全部 judge）；无 modelAdapter → 回放无 judge（文本说明 + JSONL judge=null）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import type { VersionLine } from '../../substrate/snapshot.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';
import { loadBenchContractsV2 } from '../../supervisor/bench-v2.js';
import { getReference } from '../../kernel/bench-tasks/reference/index.js';
import type { ModelAdapter, ModelGenerateResult } from '../../kernel/schemas/model-adapter.js';
import type { BenchContractV2 } from '../../kernel/schemas/bench.js';

interface FakeSessionEvent {
  type?: string;
}

interface CapturedCommand {
  name: string;
  description: string;
  input?: { hint?: string };
  recordInput?: boolean;
  handler: (invocation: {
    commandId: unknown;
    agent: { session?: { id?: string; events?: ReadonlyArray<FakeSessionEvent> } };
    rawInput: string;
    signal: unknown;
  }) => Promise<{ kind: 'success' | 'error'; text: string }>;
}

function makeInvocation(
  rawInput: string,
  events?: ReadonlyArray<FakeSessionEvent>,
  sessionId?: string,
): Parameters<CapturedCommand['handler']>[0] {
  return {
    commandId: 'test-cmd',
    agent: { session: { id: sessionId, events: events ?? [] } },
    rawInput,
    signal: undefined,
  };
}

interface FakeCtxResult {
  captured: CapturedCommand[];
  ctx: ContextLike;
}

/** fake ctx：仅 commands 注册面（/mode 为 OMB 内部版本线切换，无需 agentPresets 面；register 捕获 def） */
function makeFakeCtx(): FakeCtxResult {
  const captured: CapturedCommand[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
  };
  return { captured, ctx };
}

const mode = (c: FakeCtxResult): CapturedCommand => c.captured.find((x) => x.name === 'mode')!;
const bench = (c: FakeCtxResult): CapturedCommand => c.captured.find((x) => x.name === 'bench')!;

describe('T8.2 /mode 内部版本线切换（单模式；不涉及 DSH 预设切换）', () => {
  it('切换成功：fake ctx（无 agentPresets 面）→ /mode stable → success 文案含 git_revision/tree_root，不含 recompose/受限', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    // R1：latest 解析 = trusted-latest（真实 versions.git 为旧种子无 trusted-latest → /mode latest fail-loud，
    // 待启动 ensureThreeLineLayout 自动迁移重建）→ 切换冒烟用 stable（任何种子形态均可加载）
    const r = await mode(c).handler(makeInvocation('stable'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('stable');
    expect(r.text).toMatch(/git_revision [0-9a-f]{8}/);
    expect(r.text).toContain('tree_root');
    // 语义移除：成功文案固定为「已切换到版本线 X（git_revision …，tree_root …）」，无 recompose/受限 字样
    expect(r.text).not.toContain('recompose');
    expect(r.text).not.toContain('受限');
    // 内部版本线状态切换生效（当前线已更新）
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('当前版本线：stable');
  });

  it('recompose 零调用：ctx 提供 agentPresets.recompose → 切换成功且 recompose 从未被调用（证明语义移除）', async () => {
    const c = makeFakeCtx();
    const recompose = vi.fn(async () => ({ ok: true, detail: 'should-not-be-called' }));
    // ContextLike 已无 agentPresets 面（recompose 能力已从插件移除）——经宽化引用注入，断言插件零接触
    (c.ctx as { agentPresets?: { recompose: typeof recompose } }).agentPresets = { recompose };
    apply(c.ctx, { bootstrap: false });

    const r = await mode(c).handler(makeInvocation('stable'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('stable');
    expect(recompose).not.toHaveBeenCalled();
  });

  it('空白会话守卫仍生效：非空白会话拒绝切换（当前线不变）', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    const r = await mode(c).handler(makeInvocation('stable', [{ type: 'turn/start' }]));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('空白会话');
    // 未切换：当前线保持 stable
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('当前版本线：stable');
  });

  it('激活记录：activationLogDir 配置 → /mode 切换后 completed/<id>.json 幂等落盘（M6 契约字段来自真实 revision）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-act-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { activationLogDir: join(base, 'act'), bootstrap: false });

      const r = await mode(c).handler(makeInvocation('stable', [], 'sess-act-1'));
      expect(r.kind).toBe('success');

      const completedDir = join(base, 'act', 'completed');
      // 超时放宽：全量套件并行时真实 versions.git 有 git 竞争（m0 真实布局冒烟同仓操作），记录链可能变慢
      await vi.waitFor(
        () => {
          expect(readdirSync(completedDir).length).toBeGreaterThan(0);
        },
        { timeout: 15000, interval: 20 },
      );
      const files = readdirSync(completedDir);
      expect(files).toHaveLength(1);
      const contract = JSON.parse(readFileSync(join(completedDir, files[0]!), 'utf8')) as {
        predecessor: string;
        candidate: string;
        activation_scope: string;
        schema: string;
      };
      expect(contract.predecessor).toMatch(/^[0-9a-f]{40}$/); // 切换前 stable revision
      expect(contract.candidate).toMatch(/^[0-9a-f]{40}$/); // 切换后 stable revision
      expect(contract.activation_scope).toBe('session');
      expect(contract.schema).toBe('omb/M6');
      // pending 标记已清理（完成路径：目录为空或不存在）
      const pendingDir = join(base, 'act', 'pending');
      let pendingFiles: string[] = [];
      try {
        pendingFiles = readdirSync(pendingDir);
      } catch {
        pendingFiles = [];
      }
      expect(pendingFiles).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('T8.2 /bench 注册与触发', () => {
  it('注册 bench 命令：name=bench、description 含默认 v2 说明、recordInput=true', () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    expect(bench(c)).toBeDefined();
    expect(bench(c).name).toBe('bench');
    expect(bench(c).description.length).toBeGreaterThan(0);
    expect(bench(c).description).toContain('v2'); // 默认 v2 契约基准（config.benchVersion 可切回 v1 legacy）
    expect(bench(c).recordInput).toBe(true);
  });

  it('handler 默认 v2 契约基准（无 DSH 会话 → 回放 v2）：文本含「v2 契约基准」标识与 20/20；明细 replay-v2-stable-*.jsonl', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-cmd-bench-v2-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { benchPersistDir: join(base, 'bench'), bootstrap: false });

      const r = await bench(c).handler(makeInvocation(''));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('v2 契约基准'); // v2 标识
      expect(r.text).toContain('基准完成');
      expect(r.text).toMatch(/20\/20/); // 冻结基准集 20 任务全过（回放构造保证）
      expect(r.text).toMatch(/通过/);
      // 明细已落盘（v2 回放模式单文件 20 条：replay-v2-<line>-<ts>.jsonl）
      const files = readdirSync(join(base, 'bench'));
      expect(files.some((f: string) => f.startsWith('replay-v2-stable-') && f.endsWith('.jsonl'))).toBe(true);
      expect(files.some((f: string) => f.startsWith('replay-stable-'))).toBe(false); // 默认不落 v1 命名
      const records = readFileSync(join(base, 'bench', files.find((f: string) => f.startsWith('replay-v2-stable-'))!), 'utf8')
        .trim().split('\n');
      expect(records).toHaveLength(20);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('config.benchVersion: "v1" → 走 v1 legacy 路径（runBench v1；明细 replay-stable-*.jsonl；文本无 v2 标识）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-cmd-bench-v1-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { benchPersistDir: join(base, 'bench'), benchVersion: 'v1', bootstrap: false });

      const r = await bench(c).handler(makeInvocation(''));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('基准完成');
      expect(r.text).not.toContain('v2 契约基准'); // v1 文本无 v2 标识
      expect(r.text).toMatch(/20/); // 冻结基准集 20 任务
      // 明细落盘沿用 v1 命名（replay-<line>-<ts>.jsonl），不产生 v2 文件
      const files = readdirSync(join(base, 'bench'));
      expect(files.some((f: string) => f.startsWith('replay-stable-') && f.endsWith('.jsonl'))).toBe(true);
      expect(files.some((f: string) => f.startsWith('replay-v2-'))).toBe(false);
      const records = readFileSync(join(base, 'bench', files.find((f: string) => f.startsWith('replay-stable-'))!), 'utf8')
        .trim().split('\n');
      expect(records).toHaveLength(20);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('/mode 切换记录版本激活（activationLogDir 配置 → completed/<id>.json 幂等落盘，M6 契约字段来自真实 revision）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-act-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { activationLogDir: join(base, 'act'), bootstrap: false });

      const r = await mode(c).handler(makeInvocation('stable', [], 'sess-act-1'));
      expect(r.kind).toBe('success');

      const completedDir = join(base, 'act', 'completed');
      // 超时放宽：全量套件并行时真实 versions.git 有 git 竞争（m0 真实布局冒烟同仓操作），记录链可能变慢
      await vi.waitFor(
        () => {
          expect(readdirSync(completedDir).length).toBeGreaterThan(0);
        },
        { timeout: 15000, interval: 20 },
      );
      const files = readdirSync(completedDir);
      expect(files).toHaveLength(1);
      const contract = JSON.parse(readFileSync(join(completedDir, files[0]!), 'utf8')) as {
        predecessor: string;
        candidate: string;
        activation_scope: string;
        schema: string;
      };
      expect(contract.predecessor).toMatch(/^[0-9a-f]{40}$/); // 切换前 stable revision
      expect(contract.candidate).toMatch(/^[0-9a-f]{40}$/); // 切换后 stable revision
      expect(contract.activation_scope).toBe('session');
      expect(contract.schema).toBe('omb/M6');
      // pending 标记已清理（完成路径：目录为空或不存在）
      const pendingDir = join(base, 'act', 'pending');
      let pendingFiles: string[] = [];
      try {
        pendingFiles = readdirSync(pendingDir);
      } catch {
        pendingFiles = [];
      }
      expect(pendingFiles).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('/mode 切换记录版本激活（activationLogDir → completed/<activation_id>.json 含 activation_id/candidate/predecessor；pending 已清空）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-act-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { activationLogDir: join(base, 'act'), bootstrap: false });

      // R1：真实 versions.git 为旧种子（无 trusted-latest）→ /mode latest fail-loud；激活记录用 stable
      // （任何种子形态可加载；latest 的 trusted-latest 解析语义由 lines.test.ts/loader.test.ts 覆盖）
      const r = await mode(c).handler(makeInvocation('stable', [], 'sess-act-2'));
      expect(r.kind).toBe('success');

      const completedDir = join(base, 'act', 'completed');
      // 超时放宽：全量套件并行时真实 versions.git 有 git 竞争（m0 真实布局冒烟同仓操作），记录链可能变慢
      await vi.waitFor(
        () => {
          expect(readdirSync(completedDir).length).toBeGreaterThan(0);
        },
        { timeout: 15000, interval: 20 },
      );
      const files = readdirSync(completedDir);
      expect(files).toHaveLength(1);
      const contract = JSON.parse(readFileSync(join(completedDir, files[0]!), 'utf8')) as {
        id: string;
        predecessor: string;
        candidate: string;
        activation_scope: string;
        schema: string;
      };
      expect(contract.id).toMatch(/^dsh:evt:[0-9a-f]{64}$/); // activation_id（确定性派生）
      expect(contract.candidate).toMatch(/^[0-9a-f]{40}$/); // 切换后 stable revision
      expect(contract.predecessor).toMatch(/^[0-9a-f]{40}$/); // 切换前 stable revision
      expect(contract.activation_scope).toBe('session');
      expect(contract.schema).toBe('omb/M6');
      // pending 标记已清理（完成路径：目录为空或不存在）
      const pendingDir = join(base, 'act', 'pending');
      let pendingFiles: string[] = [];
      try {
        pendingFiles = readdirSync(pendingDir);
      } catch {
        pendingFiles = [];
      }
      expect(pendingFiles).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('modelAdapter 存在 → v2 分支传 judge（真实模式 20 任务全部 judge 调用；JSONL 含 judge 段）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-cmd-bench-judge-'));
    try {
      const contracts = await loadBenchContractsV2();
      const byId = new Map(contracts.map((c): [string, BenchContractV2] => [c.id, c]));
      const counter = { judgeCalls: 0 };
      // 同一 adapter 双路：exec prompt（# 基准任务…）→ reference 输出（20/20）；judge prompt（JSON 对象）→ 判词
      const adapter: ModelAdapter = {
        provider: 'test',
        model: 'fake-bench-judge',
        async generate(prompt: string): Promise<ModelGenerateResult> {
          if (prompt.trimStart().startsWith('{')) {
            counter.judgeCalls++;
            return { text: JSON.stringify({ verdict: 'pass', reason: 'ok' }), usage: { inputTokens: 5, outputTokens: 2 } };
          }
          const m = /^# 基准任务 (\S+)/m.exec(prompt);
          const id = m?.[1];
          const contract = id === undefined ? undefined : byId.get(id);
          if (contract === undefined) {
            throw new Error(`fake adapter: prompt 缺任务 id（${prompt.slice(0, 40)}…）`);
          }
          const expected = getReference(contract.id)(contract.input_artifacts);
          return { text: JSON.stringify(expected), usage: { inputTokens: 10, outputTokens: 20 } };
        },
      };
      const c = makeFakeCtx();
      (c.ctx as { modelAdapter?: ModelAdapter }).modelAdapter = adapter;
      apply(c.ctx, { benchPersistDir: join(base, 'bench'), bootstrap: false });

      const r = await bench(c).handler(makeInvocation(''));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('真实执行');
      expect(r.text).toContain('judge'); // 文本含 judge 对照摘要
      expect(counter.judgeCalls).toBe(20); // 全任务双判（D6）：20 任务全部 judge
      // 落盘 real-v2-*.jsonl：逐条含 judge 段（判词非 null）
      const files = readdirSync(join(base, 'bench'));
      const file = files.find((f: string) => f.startsWith('real-v2-stable-') && f.endsWith('.jsonl'))!;
      const lines = readFileSync(join(base, 'bench', file), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(20);
      for (const l of lines) {
        const rec = JSON.parse(l) as { judge: { verdict: string } | null };
        expect(rec.judge).not.toBeNull();
        expect(rec.judge!.verdict).toBe('pass');
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('无 modelAdapter → v2 回放 + 无 judge（文本说明 judge 未启用；JSONL 记录 judge=null）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-cmd-bench-nojudge-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { benchPersistDir: join(base, 'bench'), bootstrap: false });

      const r = await bench(c).handler(makeInvocation(''));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('回放执行');
      expect(r.text).toContain('judge'); // 文本说明 judge 未启用（回放模式无 LLM judge）
      const files = readdirSync(join(base, 'bench'));
      const file = files.find((f: string) => f.startsWith('replay-v2-stable-') && f.endsWith('.jsonl'))!;
      const first = readFileSync(join(base, 'bench', file), 'utf8').trim().split('\n')[0]!;
      const rec = JSON.parse(first) as { judge: unknown };
      expect(rec.judge).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('T8.30 config.line 固定初始版本线（后备机制 deploy-lines：per-line 预设 omb-v2-<line> 注入本配置）', () => {
  beforeEach(() => {
    clearDegradations();
  });

  it('line: "latest" → apply 后 /mode 空输入返回「当前版本线：latest」（固定初始线生效）', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false, line: 'latest' });

    const current = await mode(c).handler(makeInvocation(''));
    expect(current.kind).toBe('success');
    expect(current.text).toContain('当前版本线：latest');
    expect(degradationLog().some((r) => r.hook === 'config/line')).toBe(false);
  });

  it('非法 line（如 "foo"）→ 回退 stable 且记录 config/line 降级', async () => {
    const c = makeFakeCtx();
    // 模拟配置被写坏（非法 line 值）——运行时应回退 stable 并记录降级（守卫式接入，不阻塞挂载）
    apply(c.ctx, { bootstrap: false, line: 'foo' as VersionLine });

    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('当前版本线：stable');
    expect(degradationLog().some((r) => r.hook === 'config/line')).toBe(true);
  });

  it('line 缺省 → stable（既有行为不变，不记录 config/line 降级）', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('当前版本线：stable');
    expect(degradationLog().some((r) => r.hook === 'config/line')).toBe(false);
  });
});
