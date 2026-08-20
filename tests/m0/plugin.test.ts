// T0.3 行为测试：Cordis 插件入口 runtime/plugin.ts —— apply(fakeCtx) 注册 /mode。
// fake ctx 无 cordis 依赖（结构化最小接口）；handler 的切换路径经真实 loadVersion
// 读真实 preset 布局（只读冒烟，与 git-layout.test.ts 同约定）。
import { describe, expect, it } from 'vitest';
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

/** fake ctx：仅 commands 注册面（无 agentPresets —— 顺带断言守卫生效）；register 捕获 def */
function makeFakeCtx(): { captured: CapturedCommand[]; ctx: ContextLike } {
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

function makeInvocation(
  rawInput: string,
  events?: ReadonlyArray<FakeSessionEvent>,
): Parameters<CapturedCommand['handler']>[0] {
  return {
    commandId: 'test-cmd',
    agent: { session: { events: events ?? [] } },
    rawInput,
    signal: undefined,
  };
}

describe('runtime/plugin.ts apply(fakeCtx)', () => {
  it('注册 /mode 命令：name=mode、description 非空、input hint 含合法值、recordInput=true；fake ctx 无 agentPresets 不抛错', () => {
    const { captured, ctx } = makeFakeCtx();
    expect(() => apply(ctx)).not.toThrow();
    expect(captured).toHaveLength(1);
    const def = captured[0]!;
    expect(def.name).toBe('mode');
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.input?.hint).toContain('initial|stable|latest');
    expect(def.recordInput).toBe(true);
  });

  it('handler 无参数：返回 CommandResult 结构（success + text），当前线为默认 stable', async () => {
    const again = makeFakeCtx();
    apply(again.ctx);
    const r = await again.captured[0]!.handler(makeInvocation(''));
    expect(r).toMatchObject({ kind: 'success' });
    expect(typeof r.text).toBe('string');
    expect(r.text).toContain('stable');
  });

  it('handler 未知模式 fail-loud：error + 消息含合法值', async () => {
    const again = makeFakeCtx();
    apply(again.ctx);
    const r = await again.captured[0]!.handler(makeInvocation('gamma'));
    expect(r.kind).toBe('error');
    expect(r.text).toContain('initial | stable | latest');
  });

  it('handler 切换成功（真实布局只读冒烟）：success 含新模式与 git_revision 前 8 位，且当前线已更新', async () => {
    const again = makeFakeCtx();
    apply(again.ctx);
    const def = again.captured[0]!;
    const switched = await def.handler(makeInvocation('latest'));
    expect(switched.kind).toBe('success');
    expect(switched.text).toContain('latest');
    expect(switched.text).toMatch(/git_revision [0-9a-f]{8}/);
    // 当前线已更新：无参数再查显示 latest
    const current = await def.handler(makeInvocation(''));
    expect(current.kind).toBe('success');
    expect(current.text).toContain('latest');
  });

  it('非空白会话（events 含 turn/start）拒绝切换：error + 需空白会话', async () => {
    const again = makeFakeCtx();
    apply(again.ctx);
    const r = await again.captured[0]!.handler(
      makeInvocation('latest', [{ type: 'turn/start' }]),
    );
    expect(r.kind).toBe('error');
    expect(r.text).toContain('空白会话');
  });

  it('apply 无 commands / commands 缺失：不抛错（守卫生效）', () => {
    expect(() => apply({})).not.toThrow();
    expect(() => apply({ commands: undefined })).not.toThrow();
  });
});
