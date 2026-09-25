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
  readonly execute: (args: unknown) => Promise<unknown>
}

/** 所有工具共用的输出契约：一个可读文本。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' } as Record<string, unknown>,
  render: (_args: unknown, value: unknown): readonly ContentBlockLike[] => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  /**
   * 执行体。**绝不抛异常**——返回 `ToolOutcome` 的错误分支，
   * 模型看到的是可读文本而不是中断的回合（热插拔要求）。
   */
  readonly run: (args: unknown) => Promise<ToolOutcome> | ToolOutcome
}

/**
 * 把一个 `ToolSpec` 包成宿主可注册的定义。
 *
 * 执行体返回的 `ToolOutcome` 被转成纯字符串——这是本插件的规范输出值，
 * `render` 再把它渲染成 ContentBlock。这样"业务返回值"与"模型可见内容"
 * 在类型上分开，`render` 保持纯函数。
 */
export function toHostTool(spec: ToolSpec): HostToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: TEXT_OUTPUT,
    async execute(args: unknown): Promise<unknown> {
      try {
        const outcome = await spec.run(args)
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
