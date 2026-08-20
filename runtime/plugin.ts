// layer 2：Cordis function plugin 入口（DSH preset 挂载；agent.cordis.yml 指向编译产物 lib/runtime/plugin.js）。
// 不 import '@deepseek-ai/cordis'（harness 依赖，preset 内 tsc/vitest 无此包）：
// 用结构化最小接口类型化 ctx，运行时以 ctx.commands?.register?.(...) 守卫。
// M0：注册 /mode 命令（handler 纯逻辑在 substrate/mode-command.ts）；真实 recompose
// （ctx.agentPresets.recompose）接线记录为 M0 后集成项——本插件只维护本地当前线状态。
import { loadVersion, type VersionLine } from '../substrate/snapshot.js';
import { modeCommandHandler } from '../substrate/mode-command.js';

export const name = 'omb-v2';
export const inject = ['commands'];

/** DSH 命令注册的最小结构接口（真实类型见 @deepseek-ai/dsh-commands，不引包） */
export interface CommandsLike {
  register(def: {
    name: string;
    description: string;
    input?: { hint: string };
    recordInput?: boolean;
    handler: (invocation: CommandInvocationLike) => unknown;
  }): unknown;
}

/** DSH CommandInvocation 的最小结构（真实类型含 commandId/agent/rawInput/signal） */
export interface CommandInvocationLike {
  readonly commandId: unknown;
  readonly agent: {
    readonly session?: { readonly events?: ReadonlyArray<{ readonly type?: string }> };
  };
  readonly rawInput: string;
  readonly signal: unknown;
}

export interface ContextLike {
  commands?: CommandsLike;
}

/**
 * 空白会话检查：会话事件流中尚无 turn/start。
 * 与 DSH api-proxy 的 sessionBlank 同款语义（api-proxy.ts:476：turn = 一次模型循环执行，
 * 无 turn/start 即空白；命令生命周期记录不打开 turn，运行 /mode 本身不会破坏空白）。
 */
function isBlankSession(events: ReadonlyArray<{ readonly type?: string }> | undefined): boolean {
  return !(events ?? []).some((event) => event.type === 'turn/start');
}

export function apply(ctx: ContextLike): void {
  // 当前生效版本线（默认 stable，架构 §11.1）；M0 内为本地状态，真实 recompose 留集成
  let current: VersionLine = 'stable';

  ctx.commands?.register?.({
    name: 'mode',
    description: '切换版本线（initial | stable | latest；空白会话才能切换）',
    input: { hint: '<initial|stable|latest>' },
    recordInput: true,
    handler: async (invocation) => {
      const events = invocation.agent.session?.events;
      return modeCommandHandler(invocation.rawInput ?? '', {
        load: async (line) => loadVersion(line),
        currentLine: () => current,
        isBlankSession: async () => isBlankSession(events),
        onSwitch: async (line) => {
          current = line;
        },
      });
    },
  });
}
