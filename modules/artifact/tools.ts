/**
 * `omb_files` 工具：返回**索引条目**（路径/类型/时间），**不含内容**。
 *
 * 内容由模型用读取类工具按需取——这是拉取式设计的核心（§6.4）：
 * 索引极廉价，内容按需拉，因此"注入了但没被使用"这个类别不存在。
 *
 * 两条硬约束：
 * ① 参数解析与执行体**绝不抛异常**（服务缺失、参数非法一律走 error 分支）
 * ② 返回值里没有文件内容，也没有"最近制品"的兜底列表
 */
import type { ToolDefinition, ToolInputSchema, ToolOutcome } from '../../kernel/abi/index.js'
import type { ArtifactEntry } from './index.js'
import { ARTIFACT_TOP_MAX, type ArtifactIndex } from './index.js'

export const FILES_TOOL_NAME = 'omb_files'

export const FILES_TOOL_DESCRIPTION =
  '列出本会话索引到的制品（路径/类型/时间），不含内容。需要找文件时用；可选 query 按路径相关性筛选，' +
  `最多返回 ${ARTIFACT_TOP_MAX} 条。要读内容请再用读取类工具打开对应路径。`

export interface FilesToolInput {
  readonly query?: string
  readonly limit?: number
}

/**
 * 解析参数。**绝不抛**：非法输入降级为"无筛选"，而不是中断回合。
 */
export function parseFilesInput(raw: unknown): FilesToolInput {
  if (raw === null || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const query = input['query']
  const limit = input['limit']
  const parsed: { query?: string; limit?: number } = {}
  if (typeof query === 'string' && query.trim().length > 0) parsed.query = query.trim()
  if (typeof limit === 'number' && Number.isFinite(limit)) parsed.limit = limit
  return parsed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  try {
    return new Date(at).toISOString()
  } catch {
    return '时间未知'
  }
}

/** 渲染索引条目。**只有路径/类型/时间**——不含任何文件内容。 */
export function formatFilesResult(entries: readonly ArtifactEntry[], query?: string): string {
  if (entries.length === 0) {
    return query === undefined || query.trim().length === 0
      ? '制品索引为空：本会话还没有观察到任何制品。'
      : `制品索引没有匹配「${query.trim()}」的条目（最近 ≠ 相关：宁可空手，也不塞无关路径）。`
  }
  const header = `制品索引命中 ${entries.length} 条（上限 ${ARTIFACT_TOP_MAX} 条；只有路径/类型/时间，内容请用读取类工具按需取）：`
  const lines = entries.map(
    entry => `- ${entry.path}（${entry.kind}，${formatTime(entry.at)}）`,
  )
  return [header, ...lines].join('\n')
}

export interface FilesToolDeps {
  readonly index: ArtifactIndex
}

/** 构造 `omb_files`。由 `dsh/` 侧注册到宿主工具面。 */
export function createFilesTool(deps: FilesToolDeps): ToolDefinition {
  const parameters: ToolInputSchema = {
    parse: (input: unknown) => parseFilesInput(input),
  }
  return {
    name: FILES_TOOL_NAME,
    description: FILES_TOOL_DESCRIPTION,
    parameters,
    execute(args: unknown): ToolOutcome {
      try {
        const input = parseFilesInput(args)
        return { kind: 'text', text: formatFilesResult(deps.index.topFor(input.query, input.limit), input.query) }
      } catch (error) {
        // 执行体绝不抛异常：模型看到的是可读文本，不是中断的回合。
        return { kind: 'error', text: `制品索引读取失败：${messageOf(error)}` }
      }
    },
  }
}
