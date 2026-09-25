/**
 * 推理深度档位的投影层（规划 §4.4）。
 *
 * **状态不在我们这里**：读写在 `kernel.focus()` / `kernel.setFocus()`，
 * 本文件只做三件事——把 depth 投影成"给模型看什么"、安全地读、安全地写。
 *
 * 我们只做两件事（§4.4）：①把深度选择变成一次**显式动作**
 * ②**测量它**（`reasoningTokens` 按 depth 分层，记账在上下文层）。
 */
import type { FocusDepth, Kernel, SessionRef } from '../../kernel/abi/index.js'
import { FOCUS_DEPTHS } from '../../kernel/abi/index.js'
import type { MethodCard, RuleId } from './methods.js'
import { CARDS_BY_DEPTH, cardsFor, renderCards } from './methods.js'

/** `quick` 档注入的动作指令：抑制过度推理（§4.4 表格原文）。 */
export const QUICK_DIRECTIVE = '本轮不要展开，直接回答。'

/**
 * 档位取值元组。与 `kernel/abi/kinds.ts` 的 `FOCUS_DEPTHS` 是同一集合，
 * 这里用元组形式是因为 zod 的 `z.enum` 需要元组类型；
 * `satisfies` 保证任何一个都不是新造的词，测试再断言两处一致。
 */
export const FOCUS_DEPTH_VALUES = ['quick', 'standard', 'deep'] as const satisfies readonly FocusDepth[]

/**
 * `deep` 档注入的抬头。三条全文由 `cards` 给出，这里只说明本轮的强制动作。
 */
export const DEEP_DIRECTIVE = '本轮按深档展开：先列互斥备选，再给可检验的结论，并锚定具体事实。'

export interface DepthProjection {
  readonly depth: FocusDepth
  /** 本档位的动作指令；`standard` 为空串（默认档不加戏）。 */
  readonly directive: string
  /**
   * 本档位**声明需要**的规则卡 id（§4.6 的反向接口）。
   *
   * 声明 ≠ 注入：思维链层提需求，上下文层按压力档位裁决是否与如何给。
   */
  readonly needs: readonly RuleId[]
  /** `needs` 解析出的卡片全文；上下文层据此渲染，不推的时候直接不用。 */
  readonly cards: readonly MethodCard[]
}

/** 深度 → 投影。**纯函数**：同档位永远同结果。 */
export function projectFocus(depth: FocusDepth): DepthProjection {
  const needs = CARDS_BY_DEPTH[depth] ?? []
  return {
    depth,
    directive: depth === 'quick' ? QUICK_DIRECTIVE : depth === 'deep' ? DEEP_DIRECTIVE : '',
    needs,
    cards: cardsFor(depth),
  }
}

/**
 * 渲染投影。`includeCards=false` 时只给指令——
 * 这是上下文层在紧张档位下的用法（内容转工具拉取，指令保留）。
 */
export function renderProjection(projection: DepthProjection, includeCards = true): string {
  const parts = [projection.directive]
  if (includeCards && projection.cards.length > 0) parts.push(renderCards(projection.cards))
  return parts.filter(part => part !== '').join('\n')
}

/** 档位合法性判定（`omb_focus` 的入参校验用）。 */
export function isFocusDepth(value: unknown): value is FocusDepth {
  return typeof value === 'string' && (FOCUS_DEPTH_VALUES as readonly string[]).includes(value)
}

/**
 * 有效档位：模型显式设过就用显式的，否则用配置的默认档。
 *
 * 纯函数。`explicit` 为 undefined 表示"本会话尚未显式设置"。
 */
export function resolveDepth(configuredDefault: FocusDepth, explicit: FocusDepth | undefined): FocusDepth {
  return explicit ?? configuredDefault
}

/** 读档位的结果。`depth` 一定是合法值（读失败回落 `standard`）。 */
export interface FocusSnapshot {
  readonly depth: FocusDepth
  readonly projection: DepthProjection
}

/**
 * 读当前档位。**绝不抛**：内核服务异常时回落 `standard`（默认档），
 * 并在 `projection` 里如实反映——降级不隐藏。
 */
export function readFocus(kernel: Kernel, session: SessionRef): FocusSnapshot {
  let depth: FocusDepth = 'standard'
  try {
    const raw = kernel.focus(session)
    if (isFocusDepth(raw)) depth = raw
  } catch {
    depth = 'standard'
  }
  return { depth, projection: projectFocus(depth) }
}

/** 写档位的结果；`text` 直接可以作为工具回执给模型看。 */
export interface FocusApplyResult {
  readonly ok: boolean
  readonly depth: FocusDepth
  readonly text: string
}

/**
 * 设档位。**绝不抛**：非法取值不改变状态并说明可用取值；
 * 内核异常也只回错误文本。
 */
export function applyFocus(
  kernel: Kernel,
  session: SessionRef,
  rawDepth: unknown,
  rawReason: unknown,
): FocusApplyResult {
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.trim() : '模型未给理由'
  if (!isFocusDepth(rawDepth)) {
    let current: FocusDepth = 'standard'
    try {
      const seen = kernel.focus(session)
      if (isFocusDepth(seen)) current = seen
    } catch {
      current = 'standard'
    }
    return {
      ok: false,
      depth: current,
      text: `depth 必须是 ${FOCUS_DEPTHS.join(' / ')} 之一，收到 ${JSON.stringify(rawDepth ?? null)}；当前档位仍为 ${current}。`,
    }
  }
  try {
    kernel.setFocus(session, rawDepth, reason)
    return { ok: true, depth: rawDepth, text: `已把推理深度设为 ${rawDepth}（理由：${reason}）。${describeDepthEffect(rawDepth)}` }
  } catch (error) {
    return {
      ok: false,
      depth: rawDepth,
      text: `设置深度失败：${error instanceof Error ? error.message : String(error)}；本次调用未改变档位。`,
    }
  }
}

/** 一句话说明该档位会带来什么（回执里给模型的自解释）。 */
export function describeDepthEffect(depth: FocusDepth): string {
  if (depth === 'quick') return '本轮只给直接答案，不展开推理。'
  if (depth === 'deep') return `本轮会带上规则卡全文：${CARDS_BY_DEPTH.deep.join('、')}。`
  return '默认档：规则卡按需用 omb_method 拉取。'
}
