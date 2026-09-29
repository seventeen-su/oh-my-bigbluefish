/**
 * 宿主会话事件 → 认知层的**接线层**。
 *
 * ## 为什么必须有这个文件
 *
 * 自检报告发现 `omb_files` 的索引恒为 0，并正确地标为"无法区分"本会话没观察过制品"
 * 与"索引没在工作"。
 *
 * 实测答案是后者，而且是**接线缺失**：`ArtifactService.record()` 的注释写着
 * 「由 `dsh/hooks.ts` 从宿主会话事件（`tool/call` 参数）提取路径后调用」——
 * 但那个文件**不存在**，全仓库也没有任何地方调用 `record()`。
 *
 * 于是这个组件：模块正常挂载、健康面全绿、工具可调用、返回"制品索引为空"，
 * **而它永远不会有任何内容**。这是本项目最难自察的一类失败——
 * 每一层单独看都对，只是中间少了一根线。
 *
 * ## 只做一件事：从工具调用参数里提取路径
 *
 * 不臆造：载荷里**没有路径就不记录**（`record()` 自己会拒绝空路径）。
 * 不做猜测（不从自然语言里"理解"出文件名），只认工具参数里明确给出的字段。
 */
import type { Kernel } from '../kernel/abi/index.js'
import { SERVICES } from '../kernel/abi/index.js'

/** `ArtifactService` 中本层用到的那一部分。 */
interface ArtifactRecorder {
  record(path: string, options?: { readonly kind?: string }): unknown
}

/**
 * 工具名 → 哪些参数是**路径**。
 *
 * 只列真的带路径的工具。用白名单而不是"扫所有参数找像路径的字符串"：
 * 后者会把 `command: "Get-Content x.ts"` 里的片段、`pattern: "**\/*.ts"`
 * 甚至正文里的文件名都当成制品——**那正是本项目反复踩的"形态匹配当语义"**。
 */
const PATH_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['read', ['file_path']],
  ['write', ['file_path']],
  ['edit', ['file_path']],
  ['read_image', ['file_path']],
  ['glob', ['path']],
  ['grep', ['path']],
  // 结果里可能带路径，但 `command` 是自由文本——**不收**（见上面的理由）
])

/** 从工具调用参数里取路径。取不到返回空数组（不猜）。 */
export function pathsFromToolCall(toolName: string, args: unknown): readonly string[] {
  const keys = PATH_PARAMETERS.get(toolName)
  if (keys === undefined) return []
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const out: string[] = []
  for (const key of keys) {
    const value = record[key]
    // 只认非空字符串；空串/undefined/数字都不是路径
    if (typeof value === 'string' && value.trim().length > 0) out.push(value.trim())
  }
  return out
}

/**
 * 订阅宿主的 `tool/call`，把参数里的路径喂给制品索引。
 *
 * @returns 幂等 disposer；**绝不抛**（H-1）。
 */
export function wireArtifactIndex(options: {
  readonly ctx: { on?(event: string, fn: (...args: never[]) => void): unknown }
  readonly kernel: Kernel
}): () => void {
  const { ctx, kernel } = options
  if (typeof ctx.on !== 'function') return () => {}

  let off: (() => void) | undefined
  try {
    /**
     * ⚠️ **必须订 `session/event`，不能订 `tool/call`。**
     *
     * 实测（DSH `0.2.0-rc.2`）：`tool/call` 只是一个**会话事件类型**
     * （`packages/core/session/src/known-event-types.ts:73`），**不是 ctx 层事件**。
     * ctx 层只发 `session/event` 与 `session/disposed`
     * （`packages/core/session/src/index.ts:405,757-764`）；DSH 自己的 agent-loop
     * 也是用 `ctx.on('session/event')` 观察工具调用
     * （`packages/core/agent-loop/src/runtime-context.ts:134`）。
     *
     * 这里原本写的是 `ctx.on('tool/call', …)`——**订阅语法上成功，但事件永不到来**，
     * 于是制品索引恒为空。这个缺陷被"订阅存在"的测试放过去了：**断言了线接上了，
     * 没断言电会来**。所以下面每条路径都有对应的测试用**真实事件形状**喂进来。
     *
     * 载荷形状（`packages/core/session/src/types.ts:361`）：
     * `session/event` 是 `(session, event)`；`tool/call` 的 `event.data` 是
     * `{turn, step, callId, name, arguments}`，其中 **`arguments` 是 JSON 字符串**，
     * 不是对象——所以要 `JSON.parse`，且解析失败必须静默跳过（不猜）。
     */
    const returned = ctx.on('session/event', ((...args: unknown[]) => {
      try {
        const event = args[1] as { type?: unknown; data?: unknown } | undefined
        if (event?.type !== 'tool/call') return
        const data = event.data as { name?: unknown; arguments?: unknown } | undefined
        const name = typeof data?.name === 'string' ? data.name : undefined
        if (name === undefined) return

        // `arguments` 是 JSON 字符串；解析失败 = 拿不到参数 = 不记录（不猜）
        let parsed: unknown
        if (typeof data?.arguments === 'string') {
          try {
            parsed = JSON.parse(data.arguments)
          } catch {
            return
          }
        } else {
          parsed = data?.arguments
        }

        const paths = pathsFromToolCall(name, parsed)
        if (paths.length === 0) return
        const artifact = kernel.service<ArtifactRecorder>(SERVICES.artifact)
        if (artifact === undefined || typeof artifact.record !== 'function') return
        for (const path of paths) {
          try {
            artifact.record(path)
          } catch {
            // 单条失败不得影响其余，也不得把异常带回事件总线
          }
        }
      } catch {
        // 观察者绝不抛：宿主事件总线不该因为索引失败而受影响
      }
    }) as (...args: never[]) => void)
    if (typeof returned === 'function') off = returned as () => void
  } catch (error) {
    kernel.logger.warn(`OMB：订阅 session/event 失败（制品索引不会有内容）——${String(error)}`)
  }

  return () => {
    try {
      off?.()
    } catch {
      // H-1：disposer 绝不抛
    }
  }
}
