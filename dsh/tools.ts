/**
 * 工具注册适配。
 *
 * **DSH 0.1.7 的工具契约与 0.1.3 不同**：`tools.register()` 现在要求
 * `output { schema, render }`，缺失会抛
 * `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`
 * （`packages/core/tools/src/index.ts:1066-1070`）。
 * 旧的 v2 插件只提供 `{name, description, parameters}`，在 0.1.7 上注册必然失败。
 *
 * 本文件用**结构化最小接口**声明该契约（本仓库解析不到 `@deepseek-ai/*`，
 * 顶层 import 会让插件加载失败），并在运行时校验形状，
 * 使契约漂移变成一条可读的降级记录而不是一次崩溃。
 */
import type { Logger } from '../kernel/abi/index.js'
import type { ToolOutcome } from '../kernel/abi/index.js'
import type { ToolCallContext } from '../kernel/sessionRuntime.js'
import { toolCallContext } from '../kernel/sessionRuntime.js'

export interface ToolsLike {
  register(definition: unknown): unknown
}

/** 工具执行结果：本插件一律返回 ContentBlock 数组（`{type:'text', text}`）。 */
export interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** 工具定义的结构化形状。字段名与 DSH 的 `ToolDefinition` 一致。 */
export interface HostToolDefinition {
  readonly name: string
  readonly description: string
  /** 参数 JSON Schema（原始 JSON Schema，非 schemastery）。 */
  readonly parameters: Record<string, unknown>
  readonly output: {
    /** 规范值的 JSON Schema。 */
    readonly schema: Record<string, unknown>
    /** 纯投影：把已验证的参数与规范值渲染成模型可见内容。 */
    readonly render: (args: unknown, value: unknown) => readonly ContentBlockLike[]
  }
  /**
   * 执行体。
   *
   * **第二个参数是宿主的 `ToolRunContext`**（`packages/core/tools/src/index.ts:236`
   * 的 `execute(args, exec)`，由 `:1581` 的 `tool.execute(exec.arguments, exec)` 传入）。
   * 它里面**有会话身份**：`exec.agent`（`:326-339` 声明、`:1391-1417` 运行时填上）。
   * 曾经这里只声明一个参数，于是那条信息在 OMB 边界上被丢掉——工具因此只能用
   * "最近看到的会话"猜归属，交错会话时会把状态写进别人的会话。
   */
  readonly execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

/**
 * 从宿主 `exec` 投影出 OMB 的调用归属（**唯一**的宿主形状读取点）。
 *
 * 取值路径（DSH 0.2.0-rc.2）：
 * - `exec.agent.id` → 会话 id（`packages/core/agent/src/types.ts:15-18` 声明为 `SessionId`）
 * - `exec.agent.session.header.id` → 同一 id 的佐证/兜底
 *   （`packages/core/agent/src/runtime-types.ts:163-168`；`SessionHeader.id` 见
 *   `packages/core/session/src/types.ts:101`）
 * - `exec.agent.session.header.parentSession` / `delegationDepth` → 子代理血统（`:107` / `:123`）
 * - `exec.callId` → 调用关联 id
 *
 * 形状漂移一律退化为"归属未知"，**绝不抛**、**绝不改用"最近一个"**。
 */
export function toolCallContextFromHostExec(exec: unknown): ToolCallContext {
  try {
    const record = (exec ?? {}) as {
      readonly callId?: unknown
      readonly agent?: {
        readonly id?: unknown
        readonly session?: {
          readonly header?: {
            readonly id?: unknown
            readonly parentSession?: unknown
            readonly delegationDepth?: unknown
          }
        }
      }
    }
    const header = record.agent?.session?.header
    const fromAgentId = typeof record.agent?.id === 'string' ? record.agent.id : undefined
    return toolCallContext({
      sessionId: fromAgentId ?? header?.id,
      callId: record.callId,
      parentSessionId: header?.parentSession,
      delegationDepth: header?.delegationDepth,
    })
  } catch {
    return toolCallContext({})
  }
}

/** 所有工具共用的输出契约：一个可读文本。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' } as Record<string, unknown>,
  render: (_args: unknown, value: unknown): readonly ContentBlockLike[] => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
}

/**
 * 把 schema 洗成"只剩可枚举字符串键的普通记录"。
 *
 * **为什么必须洗**：`z.toJSONSchema()` 的返回对象自带一个**非枚举**键
 * `~standard`（zod v4 的 Standard Schema 标记）。宿主要求参数 schema
 * "只有可枚举字符串键"
 * （`isJsonSchemaRecord` → `hasOnlyEnumerableStringKeys`，
 * `packages/core/tools/src/json-schema.ts:152`），于是**每一个用 zod 生成
 * 参数的工具都被拒绝**：
 *
 * ```
 * tool "omb_remember" parameters must be lossless JSON before schema projection
 * ```
 *
 * 而手写 JSON Schema 的工具（如 `omb_status`）恰好通过——所以症状是
 * "有的工具有、有的没有"，极易误判成个别模块的问题。
 *
 * 清洗用重建而不是 `delete`：`~standard` 不可枚举，`delete` 也能去掉，
 * 但重建同时保证原型是 `Object.prototype`、没有多余装饰。
 */
export function cleanJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return cleanValue(value) as Record<string, unknown>
}

/** 递归清洗任意 JSON 值：对象洗键，数组逐元素，标量原样。 */
function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => cleanValue(entry))
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = cleanValue((value as Record<string, unknown>)[key])
  }
  return out
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  /**
   * 执行体。**绝不抛异常**——返回 `ToolOutcome` 的错误分支，
   * 模型看到的是可读文本而不是中断的回合（热插拔要求）。
   *
   * `call` 是**本次调用**的归属（会话 / 调用 id / 子代理血统）。拿不到会话时
   * `call.attribution === 'unknown'`：执行体**不得**改用"最近一个会话"，
   * 要么给出可读原因拒绝，要么在输出里明说"归属未知"。
   */
  readonly run: (args: unknown, call?: ToolCallContext) => Promise<ToolOutcome> | ToolOutcome
}

/**
 * 把一个 `ToolSpec` 包成宿主可注册的定义。
 *
 * 执行体返回的 `ToolOutcome` 被转成纯字符串——这是本插件的规范输出值，
 * `render` 再把它渲染成 ContentBlock。这样"业务返回值"与"模型可见内容"
 * 在类型上分开，`render` 保持纯函数。
 *
 * **参数 schema 一律过 `cleanJsonRecord`**：这是唯一补齐宿主契约的地方，
 * 绕过它就会漏字段或带脏键（两种情况都实测踩过）。
 */
export function toHostTool(spec: ToolSpec): HostToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: cleanJsonRecord(spec.parameters),
    output: TEXT_OUTPUT,
    async execute(args: unknown, exec?: unknown): Promise<unknown> {
      try {
        // 把宿主执行上下文里的**会话归属**交给执行体（唯一不丢的接法）：
        // 工具因此能说"我属于哪个会话"，而不是去问"最近看到的是哪个会话"。
        const outcome = await spec.run(args, toolCallContextFromHostExec(exec))
        return outcome.kind === 'error' ? `错误：${outcome.text}` : outcome.text
      } catch (error) {
        // 工具执行体本身已保证不抛；这里是最后一道网
        const message = error instanceof Error ? error.message : String(error)
        return `错误：工具 ${spec.name} 执行失败——${message}`
      }
    },
  }
}

/**
 * 注册一组工具。
 *
 * 每个注册都是独立的；**单个工具注册失败不影响其余**——
 * 契约漂移（例如未来 DSH 又改了 `output` 形状）只让那一个工具缺席，
 * 并在状态面留下可读原因。
 *
 * @returns disposer（幂等，绝不抛）+ 失败清单。
 */
export function registerTools(
  tools: ToolsLike | undefined,
  specs: readonly ToolSpec[],
  logger: Logger,
): { dispose: () => void; failures: readonly string[] } {
  const disposers: (() => void)[] = []
  const failures: string[] = []

  if (tools === undefined || typeof tools.register !== 'function') {
    return {
      dispose: () => {},
      failures: ['宿主 tools 服务不可用：工具未注册（状态面已记录）'],
    }
  }

  for (const spec of specs) {
    try {
      const returned = tools.register(toHostTool(spec))
      if (typeof returned === 'function') disposers.push(returned as () => void)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${spec.name} 注册失败：${message}`)
      logger.warn(`OMB：工具 ${spec.name} 注册失败——${message}`)
    }
  }

  return {
    dispose: () => {
      for (const d of disposers.reverse()) {
        try {
          d()
        } catch {
          // disposer 绝不抛（热插拔 H-1）
        }
      }
      disposers.length = 0
    },
    failures,
  }
}

/** 常用参数 schema 片段，避免各模块各写一遍。 */
export const PARAM = {
  string: (description: string) => ({ type: 'string', description }),
  optionalString: (description: string) => ({ type: 'string', description }),
  integer: (description: string, minimum?: number, maximum?: number) => ({
    type: 'integer',
    description,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  }),
  enum: (description: string, values: readonly string[]) => ({
    type: 'string',
    description,
    enum: [...values],
  }),
} as const
