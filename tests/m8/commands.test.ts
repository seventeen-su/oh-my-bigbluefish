// T8.2 行为测试：/mode 真实 recompose 接线 + /bench 注册（runtime/plugin.ts，research-dsh.md §2）。
// - /mode：ctx.agentPresets.recompose 存在 → handler 真实调用 recompose（目标 preset id 按线映射
//   omb-v2-<line>）；失败 → 明确受限（error 文本文档化平台限制），本地线状态不切换；
//   ctx 无 agentPresets → 降级为会话内当前线状态（既有 m0 行为不变）。
// - /bench：注册 bench 命令；handler 经 supervisor/bench.ts 真实 runBench（冻结基准集 20 任务，
//   回放执行器）产出报告文本。
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, type ContextLike } from '../../runtime/plugin.js';

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
    agent: { session?: { events?: ReadonlyArray<FakeSessionEvent> } };
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
  recomposed: string[];
}

/** fake ctx：commands + 可选 agentPresets.recompose（记录目标 preset id） */
function makeFakeCtx(over: {
  recompose?: (id: string) => Promise<unknown> | unknown;
  noAgentPresets?: boolean;
} = {}): FakeCtxResult {
  const captured: CapturedCommand[] = [];
  const recomposed: string[] = [];
  const ctx: ContextLike = {
    commands: {
      register: (def: unknown) => {
        captured.push(def as CapturedCommand);
      },
    },
  };
  if (!over.noAgentPresets) {
    ctx.agentPresets = {
      recompose: async (agentCtx: unknown, id: string) => {
        recomposed.push(id);
        if (over.recompose !== undefined) {
          return over.recompose(id);
        }
        return { ok: true };
      },
    };
  }
  return { captured, ctx, recomposed };
}

const mode = (c: FakeCtxResult): CapturedCommand => c.captured.find((x) => x.name === 'mode')!;
const bench = (c: FakeCtxResult): CapturedCommand => c.captured.find((x) => x.name === 'bench')!;

describe('T8.2 /mode 真实 recompose 接线', () => {
  it('ctx 提供 agentPresets.recompose → /mode 切换时 handler 真实调用 recompose（目标 preset id=omb-v2-<line>）且成功', async () => {
    const c = makeFakeCtx();
    apply(c.ctx);

    const r = await mode(c).handler(makeInvocation('latest'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('latest');
    // 真实调用 recompose：目标 preset id 按线映射
    expect(c.recomposed).toEqual(['omb-v2-latest']);
    // 本地线状态同步更新
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('latest');
  });

  it('recompose 调用抛错 → 降级切换：success（会话内状态）+ 受限说明，本地线状态已更新', async () => {
    const c = makeFakeCtx({ recompose: () => Promise.reject(new Error('preset omb-v2-latest 不存在')) });
    apply(c.ctx);

    const r = await mode(c).handler(makeInvocation('latest'));
    expect(r.kind).toBe('success');
    expect(r.text).toMatch(/受限/);
    expect(r.text).toContain('omb-v2-latest');
    expect(r.text).toContain('latest');
    // 降级语义：recompose 受限 → 会话内版本线状态切换仍生效
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('latest');
  });

  it('recompose 返回 {ok:false} → 降级切换：success（会话内状态）+ detail 明示', async () => {
    const c = makeFakeCtx({ recompose: () => ({ ok: false, detail: '目标 preset 未安装' }) });
    apply(c.ctx);

    const r = await mode(c).handler(makeInvocation('initial'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('目标 preset 未安装');
    expect(r.text).toContain('initial');
    expect(c.recomposed).toEqual(['omb-v2-initial']);
    const current = await mode(c).handler(makeInvocation(''));
    expect(current.text).toContain('initial');
  });

  it('ctx 无 agentPresets → 降级为会话内当前线状态（recompose 不被调，切换仍成功——既有 m0 行为保持）', async () => {
    const c = makeFakeCtx({ noAgentPresets: true });
    apply(c.ctx);

    const r = await mode(c).handler(makeInvocation('latest'));
    expect(r.kind).toBe('success');
    expect(r.text).toContain('latest');
    expect(c.recomposed).toEqual([]); // 无 recompose 可调
  });

  it('空白会话守卫仍生效：非空白会话拒绝切换（recompose 不被调）', async () => {
    const c = makeFakeCtx();
    apply(c.ctx);

    const r = await mode(c).handler(makeInvocation('latest', [{ type: 'turn/start' }]));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('空白会话');
    expect(c.recomposed).toEqual([]);
  });
});

describe('T8.2 /bench 注册与触发', () => {
  it('注册 bench 命令：name=bench、description 非空、recordInput=true', () => {
    const c = makeFakeCtx({ noAgentPresets: true });
    apply(c.ctx);

    expect(bench(c)).toBeDefined();
    expect(bench(c).name).toBe('bench');
    expect(bench(c).description.length).toBeGreaterThan(0);
    expect(bench(c).recordInput).toBe(true);
  });

  it('handler 触发基准：真实 runBench（冻结基准集 20 任务 + 回放执行器）→ success + 报告文本（含通过数）；明细落盘临时目录（测试隔离，不污染真实 bench 目录）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omb-cmd-bench-'));
    try {
      const c = makeFakeCtx({ noAgentPresets: true });
      apply(c.ctx, { benchPersistDir: join(base, 'bench') });

      const r = await bench(c).handler(makeInvocation(''));
      expect(r.kind).toBe('success');
      expect(r.text).toContain('基准完成');
      expect(r.text).toMatch(/20/); // 冻结基准集 20 任务
      expect(r.text).toMatch(/通过/);
      // 明细已落盘（回放模式单文件 20 条）
      const files = readdirSync(join(base, 'bench'));
      expect(files.some((f: string) => f.startsWith('replay-stable-') && f.endsWith('.jsonl'))).toBe(true);
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
      const c = makeFakeCtx({ noAgentPresets: true });
      apply(c.ctx, { activationLogDir: join(base, 'act') });

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
