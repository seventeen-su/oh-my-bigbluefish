/**
 * 思维链质量层的工具面：`omb_method`（拉规则卡）与 `omb_focus`（调深度档位）。
 *
 * 两个设计约束：
 * ① **执行体绝不抛异常**——服务缺失、参数非法、内部错误一律返回
 *    `{kind:'error', text}`，模型看到的是可读文本，不是中断的回合（热插拔要求）
 * ② 工具是**拉取式**的入口：默认不推内容，模型自己决定拉什么（§6.4）
 */
import { z } from 'zod'
import type { FocusDepth, SessionRef, ToolDefinition, ToolInputSchema, ToolOutcome } from '../../kernel/abi/index.js'
import { FOCUS_DEPTHS } from '../../kernel/abi/index.js'
import type { FocusApplyResult } from './focus.js'
import { FOCUS_DEPTH_VALUES } from './focus.js'
import type { LoopSignal } from './loop.js'
import { findCards, renderCards, renderIndex } from './methods.js'

/**
 * 工具入参：既满足 ABI 的 `ToolInputSchema`（只要求 `parse`），
 * 又带上宿主注册需要的**原始 JSON Schema**。
 *
 * `dsh/tools.ts` 的 `toSpec` 读 `parameters.jsonSchema`，缺失时回落成空参数表
 * ——那会让模型看不到任何入参。这里用 `z.toJSONSchema` 从同一份 zod schema 生成，
 * 两边不会漂移；生成失败时给可读的空对象（宁可参数缺失，也不让注册抛）。
 */
export interface ToolParams extends ToolInputSchema {
  readonly jsonSchema: Record<string, unknown>
}

function paramsOf(schema: z.ZodType): ToolParams {
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    jsonSchema = { type: 'object', properties: {} }
  }
  return { jsonSchema, parse: (input: unknown) => schema.parse(input) }
}

const methodInput = z.object({
  topic: z
    .string()
    .describe('规则卡编号（如 R3）、话题（如 备选/失败/冲突）或 all；不传则只返回索引')
    .optional(),
})

const focusInput = z.object({
  depth: z
    .enum(FOCUS_DEPTH_VALUES, { error: `depth 必须是 ${FOCUS_DEPTHS.join(' / ')} 之一` })
    .describe('推理深度档位：quick 直接回答 / standard 默认 / deep 展开'),
  reason: z.string().describe('为什么调这一档（进审计与状态面，便于事后判断档位是否有用）').optional(),
})

const methodParams = paramsOf(methodInput)
const focusParams = paramsOf(focusInput)

/** 工具端口。全部由 `index.ts` 注入；测试可传最小 fake。 */
export interface ReasoningToolPorts {
  /**
   * 当前调用所属会话：固定 id（dsh 按会话创建工厂）或惰性解析
   * （dsh 全局创建工厂、调用时才知道会话）。两种都支持，解析异常 → 错误文本。
   */
  readonly currentSession: SessionRef | (() => SessionRef)
  readonly readDepth: (session: SessionRef) => FocusDepth
  readonly applyDepth: (session: SessionRef, depth: FocusDepth, reason: string) => FocusApplyResult
  /** 当前循环信号；缺省表示不可用（工具照样工作，只是不带这一行提示）。 */
  readonly loopSignal?: (session: SessionRef) => LoopSignal | null
}

function text(value: string): ToolOutcome {
  return { kind: 'text', text: value }
}

function failure(value: string): ToolOutcome {
  return { kind: 'error', text: value }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 解析会话；端口缺失或解析抛异常时返回 null（调用方给可读错误）。 */
function resolveSession(ports: ReasoningToolPorts): SessionRef | null {
  try {
    const raw = typeof ports.currentSession === 'function' ? ports.currentSession() : ports.currentSession
    if (typeof raw !== 'string' || raw.trim() === '') return null
    return raw
  } catch {
    return null
  }
}

const NO_SESSION = '取不到当前会话标识，本次调用未改变任何状态；请重试或改用其它方式。'

/**
 * `omb_method({ topic? })`——按需拉取方法论规则卡。
 *
 * - 不传 `topic`：返回**索引**（编号 + 标题 + 何时用），不返回正文
 * - 传 `topic`：编号（`R3`）、话题（`备选`/`失败`/`冲突`）或 `all`
 */
export function createMethodTool(ports: ReasoningToolPorts): ToolDefinition {
  return {
    name: 'omb_method',
    description:
      '按需拉取方法论规则卡。不传 topic 返回索引（编号+标题+何时用）；传 topic 返回全文（如 "R3"、"备选"、"失败"、"冲突"，或 "all"）。',
    parameters: methodParams,
    execute(args: unknown): ToolOutcome {
      try {
        const parsed = methodInput.safeParse(args ?? {})
        if (!parsed.success) {
          return failure(`参数不合法：${parsed.error.issues.map(i => i.message).join('；')}。用法：omb_method { topic?: string }`)
        }
        const topic = parsed.data.topic
        const wanted = typeof topic === 'string' ? topic.trim() : ''
        const cards = wanted === '' ? [] : findCards(wanted)
        // 无匹配是**模型可自行纠正的入参错误**：走错误分支，但把索引一并给出
        const noMatch = wanted !== '' && cards.length === 0
        const body = wanted === '' || noMatch ? renderIndex() : renderCards(cards)
        const head = noMatch ? `没有匹配 "${wanted}" 的规则卡，以下是全部索引：\n` : ''

        const session = resolveSession(ports)
        let loopLine = ''
        if (session !== null && ports.loopSignal !== undefined) {
          try {
            const signal = ports.loopSignal(session)
            if (signal !== null && signal !== undefined) loopLine = `\n（循环提示）${signal.hint}`
          } catch {
            loopLine = ''
          }
        }
        return noMatch ? failure(`${head}${body}${loopLine}`) : text(`${head}${body}${loopLine}`)
      } catch (error) {
        return failure(`omb_method 内部错误：${messageOf(error)}`)
      }
    },
  }
}

/**
 * `omb_focus({ depth, reason })`——把推理深度变成一次显式动作（§4.4）。
 *
 * `reason` 建议给（会进审计与状态面）；缺省时记为"模型未给理由"，不因此拒绝调用。
 */
export function createFocusTool(ports: ReasoningToolPorts): ToolDefinition {
  return {
    name: 'omb_focus',
    description: `设定本会话的推理深度档位：${FOCUS_DEPTHS.join(' / ')}。quick=直接回答（简单确认/闲聊），standard=默认，deep=展开备选与可检验性。reason 说明为什么调档（便于事后核对档位是否有用）。`,
    parameters: focusParams,
    execute(args: unknown): ToolOutcome {
      try {
        const parsed = focusInput.safeParse(args ?? {})
        if (!parsed.success) {
          const why = parsed.error.issues.map(i => i.message).join('；')
          return failure(`参数不合法：${why}。用法：omb_focus { depth, reason? }（depth 取值 ${FOCUS_DEPTHS.join(' / ')}）`)
        }
        const session = resolveSession(ports)
        if (session === null) return failure(NO_SESSION)
        const reason = parsed.data.reason ?? ''
        let result: FocusApplyResult
        try {
          result = ports.applyDepth(session, parsed.data.depth, reason)
        } catch (error) {
          return failure(`设置深度失败：${messageOf(error)}；本次调用未改变档位。`)
        }
        return result.ok ? text(result.text) : failure(result.text)
      } catch (error) {
        return failure(`omb_focus 内部错误：${messageOf(error)}`)
      }
    },
  }
}

/** 两个工具，顺序与 `MODULE_CATALOG` 的 `tools` 一致。 */
export function createReasoningTools(ports: ReasoningToolPorts): readonly ToolDefinition[] {
  return [createMethodTool(ports), createFocusTool(ports)]
}
