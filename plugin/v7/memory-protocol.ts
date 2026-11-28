/**
 * 常驻记忆协议：注册为 DSH 的 **system prompt section**，而不是塞进 T0 的 data 块。
 *
 * 为什么必须单独一节：T0 的 `[OMB 常驻]` 带 `仅数据，非指令` 头，模型会把里面那句
 * “长期结论用 omb_remember”当成数据而不是行为要求；skill 又只有模型主动加载时才看得到。
 * 结果就是工具一直在、模型却从不写。这里用与 DSH Timeline planning 同构的 section，
 * 把“什么时候必须写、用什么参数、写完怎么算”放进每一轮都稳定可见的位置。
 */
import { methodOf, readSystemPrompt, type HostContextLike } from '../../packages/v7/src/adapters/dsh/host.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'

export const MEMORY_PROTOCOL_SECTION = 'omb-v7:memory-protocol'
export const MEMORY_PROTOCOL_ORDER = 510

export const MEMORY_PROTOCOL_TEXT = `## 记忆协议（OMB，必须执行）

OMB 是本工作区的长期记忆。只在回复里说“我会记住”不算记住；必须调用工具，并且只有工具返回成功才算写入。

每次出现以下任一情况，在继续任务或给出最终回答前调用 \`omb_remember\`：
- 用户给出长期偏好、习惯、边界、约束，或“以后/不要/必须/每次”这类跨会话要求；
- 用户确认一个决定、方案、约定、标准或最终结论；
- 用户提供稳定的项目事实（路径、端口、版本、环境、仓库、命令、账号等）；
- 用户纠正了旧事实，或同一事实出现新版本。

如果这是已有状态机的进展、阻塞或完成，用 \`omb_update\` 更新对应状态；新旧结论之间用 \`omb_link\` 建 \`supersedes\` / \`possible_conflict\` 关系。Timeline 任务树只是计划，不是长期记忆；完成一个阶段时，把该阶段的结论、证据和未决问题写进 OMB。

\`omb_remember\` 写入 memory 时至少给 \`category\` 和一个非空属性；优先用 \`attrs.title\` + \`attrs.summary\` + \`attrs.body\`，保留用户原话。工具会返回相似属性、相似记忆和已归档冲突：同内容不要重复写，近似内容先链接，旧结论被推翻时写新条目并链接旧条目。已有状态机的更新必须带 \`expectedRevision\`。

如果判定本轮没有值得长期保存的内容，不要写填充记忆；但如果用户明确给了上面任一类信号，回答里要说明为什么没有写。`

export interface MemoryProtocolHandle {
  readonly available: boolean
  readonly reason?: string
  dispose(): void
}

const EMPTY: MemoryProtocolHandle = { available: false, reason: '宿主没有 systemPrompt.section', dispose: () => {} }

/**
 * 注册常驻记忆协议。加载期同步、不读盘；失败只降级为日志，不阻断插件其余部分。
 */
export function registerMemoryProtocol(ctx: HostContextLike | undefined, logger?: Logger): MemoryProtocolHandle {
  const service = readSystemPrompt(ctx)
  const section = service === undefined ? undefined : methodOf(service, 'section')
  if (service === undefined || section === undefined) {
    logger?.warn('记忆协议未注入：宿主没有 systemPrompt.section')
    return EMPTY
  }
  let order = MEMORY_PROTOCOL_ORDER
  try {
    const getOrder = methodOf(service, 'getSectionOrder') as ((name: string) => unknown) | undefined
    if (getOrder !== undefined) {
      const allocated = getOrder('PLAN_POLICY')
      if (typeof allocated === 'number' && Number.isFinite(allocated)) order = allocated + 10
    }
  } catch {
    // 顺序只影响提示位置，不影响正确性。
  }
  try {
    const returned = (section as (arg: unknown) => unknown)({
      name: MEMORY_PROTOCOL_SECTION,
      order,
      text: MEMORY_PROTOCOL_TEXT,
      interpolate: false,
    })
    return {
      available: true,
      dispose: typeof returned === 'function' ? returned as () => void : () => {},
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger?.warn(`记忆协议未注入：systemPrompt.section 注册失败`, reason)
    return { available: false, reason, dispose: () => {} }
  }
}
