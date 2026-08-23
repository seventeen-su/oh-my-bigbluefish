// T8.2 行为测试：/mode 内部版本线切换（单模式）+ /bench 注册（runtime/plugin.ts，research-dsh.md §2）。
// - /mode = OMB 内部版本线切换（单模式）：load 校验 + 空白会话守卫 + onSwitch 记账（激活记录落盘）；
//   不涉及 DSH 预设切换——ctx 提供 agentPresets.recompose 也不会被调用（recompose 能力已从插件移除）。
// - /bench（T2.3 起默认 v2 契约基准）：注册 bench 命令；handler 默认走 supervisor/bench-v2.ts runBenchV2
//  （20 契约 + 回放执行器，明细 replay-v2-<line>-<ts>.jsonl）；`config.benchVersion: 'v1'` 切回 legacy
//  （supervisor/bench.ts runBench，明细 replay-<line>-<ts>.jsonl——v1 语义原样保留）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, type ContextLike } from '../../runtime/plugin.js';
import type { VersionLine } from '../../substrate/snapshot.js';
import { clearDegradations, degradationLog } from '../../runtime/loop-hooks.js';

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
  it('切换成功：fake ctx（无 agentPresets 面）→ /mode latest → success 文案含 git_revision/tree_root，不含 recompose/受限', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    const r = await mode(c).handler(makeInvocation('latest'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('latest');
    expect(r.text).toMatch(/git_revision [0-9a-f]{8}/);
    expect(r.text).toContain('tree_root');
    // 语义移除：成功文案固定为「已切换到版本线 X（git_revision …，tree_root …）」，无 recompose/受限 字样
    expect(r.text).not.toContain('recompose');
    expect(r.text).not.toContain('受限');
    // 内部版本线状态切换生效（当前线已更新）
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('当前版本线：latest');
  });

  it('recompose 零调用：ctx 提供 agentPresets.recompose → 切换成功且 recompose 从未被调用（证明语义移除）', async () => {
    const c = makeFakeCtx();
    const recompose = vi.fn(async () => ({ ok: true, detail: 'should-not-be-called' }));
    // ContextLike 已无 agentPresets 面（recompose 能力已从插件移除）——经宽化引用注入，断言插件零接触
    (c.ctx as { agentPresets?: { recompose: typeof recompose } }).agentPresets = { recompose };
    apply(c.ctx, { bootstrap: false });

    const r = await mode(c).handler(makeInvocation('latest'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('latest');
    expect(recompose).not.toHaveBeenCalled();
  });

  it('空白会话守卫仍生效：非空白会话拒绝切换（当前线不变）', async () => {
    const c = makeFakeCtx();
    apply(c.ctx, { bootstrap: false });

    const r = await mode(c).handler(makeInvocation('latest', [{ type: 'turn/start' }]));
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

  it('/mode 切换到 latest 记录版本激活（activationLogDir → completed/<activation_id>.json 含 activation_id/candidate/predecessor；pending 已清空）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-act-latest-'));
    try {
      const c = makeFakeCtx();
      apply(c.ctx, { activationLogDir: join(base, 'act'), bootstrap: false });

      // 空白会话前置条件（无 turn/start 事件）+ 会话 id → 确定性 activation_id
      const r = await mode(c).handler(makeInvocation('latest', [], 'sess-act-2'));
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
      expect(contract.candidate).toMatch(/^[0-9a-f]{40}$/); // 切换后 latest revision
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
