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
import { z } from 'zod'
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
 * 模型看到的参数声明。**必须与 `parse` 同源**（ABI host.ts 明确要求提供
 * `jsonSchema`：模型看不到校验器，缺了它工具会"存在但无从填写"）。
 * 这里用 zod 生成 JSON Schema，校验仍走下面那个绝不抛的 `parse`。
 */
const FILES_PARAMETERS_ZOD = z.object({
  query: z
    .string()
    .optional()
    .describe('路径关键词（文件名或路径片段）；不填则按最近排序'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ARTIFACT_TOP_MAX)
    .optional()
    .describe(`返回条数，1~${ARTIFACT_TOP_MAX}，默认 ${ARTIFACT_TOP_MAX}`),
})

export interface FilesToolInputSchema extends ToolInputSchema {
  /** 原始 JSON Schema：宿主 `tools.register` 直接用它，而不是 zod 校验器。 */
  readonly jsonSchema: Record<string, unknown>
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

/** 参数 schema：`jsonSchema` 给模型看，`parse` 给运行时用。 */
export function filesParameters(): FilesToolInputSchema {
  return {
    jsonSchema: z.toJSONSchema(FILES_PARAMETERS_ZOD) as Record<string, unknown>,
    parse: (input: unknown) => parseFilesInput(input),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * epoch 毫秒 → UTC 时间串。
 *
 * **不用 `Date`**：模块层禁止直接取时间（ESLint `omb/no-direct-clock`，
 * 时钟一律经 `kernel.clock`）。这里只是把**已经记录好的**时间戳做纯算术格式化，
 * 顺带让输出确定、可零 mock 测试。
 *
 * `at <= 0` 视为"时间未知"——索引里 0 就是"未观察到时间"的哨兵值。
 */
export function formatUtc(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const ms = Math.trunc(at)
  const days = Math.floor(ms / 86_400_000)
  const rest = ms % 86_400_000
  const { year, month, day } = civilFromDays(days)
  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ` +
    `${pad(Math.floor(rest / 3_600_000), 2)}:${pad(Math.floor((rest % 3_600_000) / 60_000), 2)}Z`
  )
}

/** 天数 → 公历日期（Howard Hinnant 的 civil_from_days；1970-01-01 为 0）。 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = Math.max(0, days) + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  )
  const year = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? year + 1 : year, month, day }
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
    entry => `- ${entry.path}（${entry.kind}，${formatUtc(entry.at)}）`,
  )
  return [header, ...lines].join('\n')
}

export interface FilesToolDeps {
  readonly index: ArtifactIndex
}

/** 构造 `omb_files`。由 `dsh/` 侧注册到宿主工具面。 */
export function createFilesTool(deps: FilesToolDeps): ToolDefinition {
  return {
    name: FILES_TOOL_NAME,
    description: FILES_TOOL_DESCRIPTION,
    parameters: filesParameters(),
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
