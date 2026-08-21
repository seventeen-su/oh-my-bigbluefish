// layer 2：Cordis function plugin 入口（DSH preset 挂载；agent.cordis.yml 指向编译产物 lib/runtime/plugin.js）。
// 不 import '@deepseek-ai/cordis'（harness 依赖，preset 内 tsc/vitest 无此包）：
// 用结构化最小接口类型化 ctx，运行时以 ctx.commands?.register?.(...) 守卫。
// M0：注册 /mode 命令（handler 纯逻辑在 substrate/mode-command.ts）。
// T8.2：/mode 真实 recompose 接线——ctx.agentPresets.recompose 存在时 handler 真实调用
// （目标 preset id = omb-v2-<line>，版本线 → 子 preset 命名约定）；调用失败 → 明确受限
// （mode-command 返回 error 文本文档化平台限制），降级为会话内当前线状态。
//      注册 /bench 命令（supervisor/bench.ts runBench 真实冻结基准集，回放执行器）。
import { loadVersion, type VersionLine } from '../substrate/snapshot.js';
import { modeCommandHandler } from '../substrate/mode-command.js';
import { loadBenchTasks, makeReplayExecutor, runBench } from '../supervisor/bench.js';
import { makeRealExecutor } from '../supervisor/real-executor.js';
import { createCognitiveRuntime } from './assembly.js';
import { createDshModelAdapter, type LlmStreamLike } from './model-adapter.js';
import { buildRequestFromSession, lastUserMessageText, projectionToText, recordDegradation } from './loop-hooks.js';
import { initialTraceState, mapLiveToolResult, mapSessionEvent } from './loop-hooks.js';
import type { ContextProjection } from '../kernel/schemas/a.js';
import type { ModelAdapter } from '../kernel/schemas/model-adapter.js';
import type { BenchLine } from '../kernel/schemas/bench.js';
import type { GovernorDecision } from './governor.js';
import type { PromptWorkingState } from './prompt.js';

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

/** DSH agentPresets 服务的最小结构（真实类型见 @deepseek-ai/dsh-agent-presets；recompose 空白会话重链） */
export interface AgentPresetsLike {
  recompose?(agentCtx: unknown, id: string): Promise<unknown>;
}

/** 认知运行时最小结构（T8.3 装配；T8.26.2 三能力拆分后含 prepareTurn/observeEvent/finalizeTurn/snapshotHash） */
export interface CognitiveRuntimeLike {
  eventStore: { append(e: unknown): Promise<void> };
  memory: { ingest(m: unknown): Promise<string> };
  snapshotHash: string;
  /** T8.26.3：turn 开始认知准备（prepareTurn §3.1）；inject 提供时注入投影并记 context/injected（Model-visible ⟺ logged） */
  prepareTurn(
    req: unknown,
    opts?: { inject?(projection: ContextProjection): void | Promise<void> },
  ): Promise<{
    decision: GovernorDecision;
    working_state: PromptWorkingState;
    projection: ContextProjection;
    events_appended: number;
  }>;
  /** T8.26.4：运行中事实入链（observeEvent §3.2） */
  observeEvent(e: unknown): Promise<{ appended: boolean; degraded: string | null }>;
  /** T8.26.5：turn 收尾（finalizeTurn §3.3） */
  finalizeTurn(input: unknown): Promise<{ decision_event_id: string; events_appended: number }>;
  handleRequest(req: unknown): Promise<{
    decision: { decision: string };
    retrieval: { items: unknown[]; channel_used: string };
    prompt: { system: string; total_tokens: number };
    events_appended: number;
  }>;
  close(): Promise<void>;
}

/** DSH assembleContextFor 的结构最小面（真实类型见 @deepseek-ai/dsh-system-prompt AssembleContext：{ agent, scope, signal }） */
export interface AssembleContextLike {
  agent?: { session?: { id?: string; events?: ReadonlyArray<{ type?: string; data?: unknown }> } };
  scope?: unknown;
  signal?: unknown;
}

/** DSH systemPrompt 服务的最小结构（真实类型见 @deepseek-ai/dsh-system-prompt SystemPrompt.context；text 支持按请求求值） */
export interface SystemPromptLike {
  context?(def: {
    name: string;
    order: number;
    text: string | ((assembleCtx: AssembleContextLike) => string);
  }): unknown;
}

export interface ContextLike {
  commands?: CommandsLike;
  /** T8.2：preset recompose 服务（平台提供时 /mode 真实接线；缺失 → 降级会话内状态） */
  agentPresets?: AgentPresetsLike;
  /** T8.3：注入的认知运行时（装配经 deps 注入，组合根模式）；未注入且提供装配根 → 组合根缺省装配 */
  cognitive?: CognitiveRuntimeLike;
  /** T8.3：认知装配根（用户态目录，架构 §3 workspace/.omb；缺省装配路径） */
  cognitiveRoot?: string;
  /** DSH 插件配置面（agent.cordis.yml config；生产装配经 config.cognitiveRoot） */
  config?: { cognitiveRoot?: string; model?: { provider?: string; model?: string } };
  /** T8.12：DSH llm 服务（LlmRuntime.stream 的结构最小接口；真实类型 @deepseek-ai/dsh-llm）。
   *  存在 + config.model 齐备 → 组合根装配 ModelAdapter 注入认知运行时；缺失 → 缺省受限（LLM 路径不装配）。 */
  llm?: LlmStreamLike;
  /** T8.12：注入的 ModelAdapter（组合根显式注入优先；未注入且 llm+config.model 齐备 → 自动装配） */
  modelAdapter?: ModelAdapter;
  /** T8.26.3：DSH systemPrompt 服务（context 贡献注册面；真实类型 @deepseek-ai/dsh-system-prompt） */
  systemPrompt?: SystemPromptLike;
  /** T8.26.4：DSH 事件注册面（session/event 会话事实 + tools/result 工具结果 live；真实类型 Cordis Context.on） */
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

/**
 * 空白会话检查：会话事件流中尚无 turn/start。
 * 与 DSH api-proxy 的 sessionBlank 同款语义（api-proxy.ts:476：turn = 一次模型循环执行，
 * 无 turn/start 即空白；命令生命周期记录不打开 turn，运行 /mode 本身不会破坏空白）。
 */
function isBlankSession(events: ReadonlyArray<{ readonly type?: string }> | undefined): boolean {
  return !(events ?? []).some((event) => event.type === 'turn/start');
}

/** 版本线 → 子 preset id（recompose 目标命名约定：omb-v2-<line>；初始无对应 preset 时 recompose 明确受限） */
export function presetIdForLine(line: VersionLine): string {
  return `omb-v2-${line}`;
}

export function apply(ctx: ContextLike): void {
  // T8.3：认知系统装配进插件生命周期——经 deps 注入（ctx.cognitive，组合根模式）或
  // 组合根缺省装配（runtime/assembly.ts；装配根 = ctx.cognitiveRoot ?? ctx.config.cognitiveRoot）。
  // 未提供装配根 → 仅注册命令（认知装配为可选配置面，生产经 agent.cordis.yml config 接线）。
  if (ctx.cognitive === undefined) {
    const root = ctx.cognitiveRoot ?? ctx.config?.cognitiveRoot;
    if (root !== undefined) {
      // T8.12：组合根装配 ModelAdapter——显式注入优先；否则 llm 服务 + config.model 齐备时自动装配
      //（真实 DSH 会话经 ctx.llm 提供；缺失 → 缺省受限，LLM 路径不装配，纯规则阶梯）。
      if (ctx.modelAdapter === undefined && ctx.llm !== undefined) {
        const provider = ctx.config?.model?.provider;
        const model = ctx.config?.model?.model;
        if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
          ctx.modelAdapter = createDshModelAdapter(ctx.llm, { provider, model });
        }
      }
      ctx.cognitive = createCognitiveRuntime({ root, modelAdapter: ctx.modelAdapter });
    }
  }

  // 当前生效版本线（默认 stable，架构 §11.1）；recompose 失败/缺失时保持会话内状态
  let current: VersionLine = 'stable';

  // T8.26.3：systemPrompt.context 钩子——按请求求值 → prepareTurn → 投影注入（Model-visible ⟺ logged）。
  // 守卫（计划 §2 应对策略 2）：systemPrompt.context 缺失 → 记录降级（无认知注入，命令仍可用）；
  // 认知运行时未装配 → 记录降级、不注册（无注入面）。
  // 求值语义：DSH 的 context text 提供器为同步求值，而 prepareTurn 为异步——故采用「缓存 + 异步预热」：
  //   首请求触发 prepareTurn（fire-and-forget，防重入），返回空串（空文本不贡献）；prepareTurn 的 inject
  //   回调把投影文本写入缓存并触发 context/injected 事件入链（投影摘要：id/total_tokens/views）；后续请求
  //   同步返回缓存投影文本——每次注入的文本都有对应 context/injected 事件（Model-visible ⟺ logged）。
  if (ctx.systemPrompt?.context !== undefined) {
    if (ctx.cognitive !== undefined) {
      const projectionTexts = new Map<string, string>();
      const preparing = new Set<string>();
      const kickPrepare = (assembleCtx: AssembleContextLike): void => {
        const runtime = ctx.cognitive;
        if (runtime === undefined) {
          return; // 防御：注册时已守卫运行时存在；并发装配变化时静默降级
        }
        const agent = assembleCtx?.agent;
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return; // 无会话身份 → 无可注入
        }
        if (preparing.has(sessionId)) {
          return; // 防重入：同一会话的并发 assembly 只跑一次 prepare
        }
        preparing.add(sessionId);
        const goal = lastUserMessageText(agent?.session?.events);
        const request = buildRequestFromSession(sessionId, goal);
        runtime
          .prepareTurn(request, {
            inject: (projection) => {
              projectionTexts.set(sessionId, projectionToText(projection));
            },
          })
          .then((result) => {
            projectionTexts.set(sessionId, projectionToText(result.projection));
          })
          .catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            recordDegradation('context-provider', `prepareTurn 失败（${detail}）——本轮无投影注入`);
          })
          .finally(() => {
            preparing.delete(sessionId);
          });
      };
      ctx.systemPrompt.context({
        name: 'cognitive:projection',
        order: 90,
        text: (assembleCtx) => {
          const sessionId = assembleCtx?.agent?.session?.id;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return '';
          }
          kickPrepare(assembleCtx);
          return projectionTexts.get(sessionId) ?? '';
        },
      });
    } else {
      recordDegradation('cognitive-runtime', '认知运行时未装配——无认知投影注入（命令仍可用）');
    }
  } else {
    recordDegradation('systemPrompt.context', '接口缺失（ctx.systemPrompt.context 不存在）——无认知投影注入（命令仍可用）');
  }

  // T8.26.4：事件监听——session/event（turn 生命周期 + 工具事实）与 tools/result（live 工具结果）→ observeEvent
  // （EventSchema 校验 → append（幂等）→ state-reducer 增量归约，P7：Event 唯一事实源）。
  // 守卫（计划 §2 应对策略 2）：ctx.on 缺失 → 记录降级（事件不采集，其余功能不受影响）；认知运行时未装配 → 不注册。
  // 双路径幂等：tools/result live 与 session/event tool/result 对同一 callId 产出同一确定性事件 id → observeEvent
  // 重复 id 幂等（只入链一次；live 零延迟信号 + session 耐久事实，先到者胜）。
  // 异步观察 fire-and-forget（append 为同步写，不阻塞 DSH 事件派发；失败记录降级不抛）。
  if (typeof ctx.on === 'function') {
    if (ctx.cognitive !== undefined) {
      const traces = new Map<string, ReturnType<typeof initialTraceState>>();
      ctx.on('session/event', (session, dshEvent) => {
        const runtime = ctx.cognitive;
        if (runtime === undefined) {
          return; // 防御：注册时已守卫；并发装配变化时静默降级
        }
        const sessionId = (session as { id?: unknown } | undefined)?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return; // 无会话身份 → 无可入链
        }
        const prev = traces.get(sessionId) ?? initialTraceState();
        const mapped = mapSessionEvent(sessionId, dshEvent as never, runtime.snapshotHash, prev);
        traces.set(sessionId, mapped.state);
        for (const ev of mapped.events) {
          void runtime.observeEvent(ev).catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            recordDegradation('session/event', `observeEvent 失败（${detail}）——事件已记录降级`);
          });
        }
      });
      ctx.on('tools/result', (exec, result) => {
        const runtime = ctx.cognitive;
        if (runtime === undefined) {
          return;
        }
        const sessionId = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return;
        }
        const ev = mapLiveToolResult(sessionId, exec, result, runtime.snapshotHash);
        void runtime.observeEvent(ev).catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordDegradation('tools/result', `observeEvent 失败（${detail}）——工具结果 live 信号降级`);
        });
      });
    } else {
      recordDegradation('cognitive-runtime', '认知运行时未装配——事件不采集（命令仍可用）');
    }
  } else {
    recordDegradation('ctx.on', '接口缺失（ctx.on 不存在）——事件不采集（其余功能不受影响）');
  }

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
        // T8.2 真实 recompose 接线：平台提供 agentPresets.recompose 才尝试；目标 preset id 按线映射
        recompose: ctx.agentPresets?.recompose
          ? async (line) => {
              try {
                const r = await ctx.agentPresets!.recompose!(invocation.agent, presetIdForLine(line));
                // 平台返回 {ok:false} 形状（如目标 preset 未安装）→ 明确受限
                if (r !== null && typeof r === 'object' && (r as { ok?: unknown }).ok === false) {
                  const detail = (r as { detail?: unknown }).detail;
                  return { ok: false, detail: detail === undefined ? 'recompose 返回失败' : String(detail) };
                }
                return { ok: true, detail: `已重链到 preset ${presetIdForLine(line)}` };
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                return {
                  ok: false,
                  detail: `preset recompose 不可用（${detail}）——平台限制文档化：当前无 ${presetIdForLine(line)} 预设，降级为会话内版本线状态`,
                };
              }
            }
          : undefined,
        onSwitch: async (line) => {
          current = line;
        },
      });
    },
  });

  // T8.2：/bench 命令——触发冻结基准集运行（supervisor/bench.ts runBench；当前版本线）。
  // T8.18：真实执行器接线——ctx.modelAdapter（T8.12 装配，需真实 DSH 会话）存在 → 真实 DSH 执行
  //（三线真实分化）；无真实会话 → 降级回放执行器（数字可复现，平台限制文档化）。
  ctx.commands?.register?.({
    name: 'bench',
    description: '运行冻结基准集（当前版本线；真实 DSH 执行或回放降级）',
    recordInput: true,
    handler: async () => {
      try {
        const tasks = await loadBenchTasks();
        const line = current as BenchLine;
        const executor = ctx.modelAdapter !== undefined ? makeRealExecutor(ctx.modelAdapter) : makeReplayExecutor();
        const report = await runBench({ tasks, line, executor });
        const passed = report.results.filter((r) => r.passed).length;
        const mode = ctx.modelAdapter !== undefined ? '真实执行' : '回放执行（无 DSH 会话，降级）';
        return {
          kind: 'success',
          text: `基准完成：${report.line} ${passed}/${report.results.length} 通过（${report.results.length} 任务，${mode}）`,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { kind: 'error', text: `基准运行失败：${detail}` };
      }
    },
  });
}
