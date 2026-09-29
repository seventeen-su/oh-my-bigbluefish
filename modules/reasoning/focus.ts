/**
 * 推理深度档位的投影层（规划 §4.4，v3.1 按用户判断改造）。
 *
 * **状态不在我们这里**：读写在 `kernel.focus()` / `kernel.setFocus()`，
 * 本文件只做三件事——把 depth 投影成"给模型看什么"、安全地读、安全地写。
 *
 * v3.1 的关键变化：档位差异的载体从"注入多少卡片文本"换成
 * **`control.ts` 里的结构化控制参数**（验证预算 / 证据要求 / 分支 / 复核 / 收尾）。
 * 自动注入的卡片被钉死在 ≤1 张（`AUTO_INJECT_CARD_CAP`），
 * 且只有偏离默认基线的档位会多读一行控制参数——文本量不随档位线性增长。
 */
import type { FocusDepth, Kernel, SessionRef } from '../../kernel/abi/index.js'
import { FOCUS_DEPTHS } from '../../kernel/abi/index.js'
import type { DepthControl } from './control.js'
import { AUTO_INJECT_CARD_CAP, controlLine, controlOf, describeControl } from './control.js'
import type { MethodCard, RuleId } from './methods.js'
import { CARDS_BY_DEPTH, cardById } from './methods.js'

/** `quick` 档注入的动作指令：抑制过度推理（§4.4 表格原文）。 */
export const QUICK_DIRECTIVE = '本轮不要展开，直接回答。'

/**
 * 档位取值元组。与 `kernel/abi/kinds.ts` 的 `FOCUS_DEPTHS` 是同一集合，
 * 这里用元组形式是因为 zod 的 `z.enum` 需要元组类型；
 * `satisfies` 保证任何一个都不是新造的词，测试再断言两处一致。
 */
export const FOCUS_DEPTH_VALUES = ['quick', 'standard', 'deep'] as const satisfies readonly FocusDepth[]

/**
 * 哪些档位需要把控制读数读给模型。
 *
 * 只有 `deep`：它偏离默认基线，模型需要知道本轮被要求多少验证、允许几个分支、
 * 收尾门槛是什么。`standard` 是基线本身（读数没有新信息，纯属占字符），
 * `quick` 的动作是"别展开"，一行抑制指令足够。
 */
const ANNOUNCE_CONTROL: Readonly<Record<FocusDepth, boolean>> = {
  quick: false,
  standard: false,
  deep: true,
}

export interface DepthProjection {
  readonly depth: FocusDepth
  /** 本档位的动作指令；`quick` 之外为空串。 */
  readonly directive: string
  /** 本档位的**结构化控制参数**——档位差异的真正载体。 */
  readonly control: DepthControl
  /** 控制读数一行（`ANNOUNCE_CONTROL` 为 false 的档位是空串）。 */
  readonly controlText: string
  /**
   * 本档位**声明需要**的规则卡 id（§4.6 的反向接口，拉取建议）。
   *
   * 声明 ≠ 注入：注入的是 `cards`（≤1 张），其余由模型按需用 `omb_method` 拉。
   */
  readonly needs: readonly RuleId[]
  /** 本档位**自动注入**的卡片（受 `AUTO_INJECT_CARD_CAP` 约束，至多一张）。 */
  readonly cards: readonly MethodCard[]
}

/**
 * 深度 → 投影。**纯函数**：同一 `(depth, verifyUsed)` 永远同结果。
 *
 * `verifyUsed` 只影响控制读数里的"已用/预算"，不影响任何卡片。
 */
export function projectFocus(depth: FocusDepth, verifyUsed = 0): DepthProjection {
  const control = controlOf(depth)
  const declared: RuleId | null = control.injectCard
  const card = declared === null ? undefined : cardById(declared)
  return {
    depth,
    directive: depth === 'quick' ? QUICK_DIRECTIVE : '',
    control,
    controlText: ANNOUNCE_CONTROL[depth] ? controlLine(depth, verifyUsed) : '',
    needs: CARDS_BY_DEPTH[depth] ?? [],
    // 上限在代码里强制，而不只是写在注释里：任何档位都不得注入超过 AUTO_INJECT_CARD_CAP 张
    cards: card === undefined ? [] : [card].slice(0, AUTO_INJECT_CARD_CAP),
  }
}

/**
 * 渲染投影：指令 + 控制读数 + 自动注入的卡片。
 *
 * `includeCards=false` 时不给卡片正文（紧张档：内容转工具拉取，读数与指令保留）。
 */
export function renderProjection(projection: DepthProjection, includeCards = true): string {
  const parts = [projection.directive, projection.controlText]
  if (includeCards) {
    for (const card of projection.cards) parts.push(`【${card.id} ${card.title}】${card.text}`)
  }
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
 * 内核档位读数（**不回落**）：读不到或读到非法值时返回 `null`。
 *
 * 与 `readFocus` 的分工是刻意分开的：`readFocus` 把"读失败"伪装成 `standard`
 * （渲染路径要的是能用的档位，不是错误），而**写入回读**与**渲染档位裁决**
 * 必须分清"内核说是 standard"与"内核读不出来"——混为一谈就会把
 * "档位没落地"变成静默事实。
 */
export function peekFocus(kernel: Kernel, session: SessionRef): FocusDepth | null {
  try {
    const raw = kernel.focus(session)
    return isFocusDepth(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * 读当前档位。**绝不抛**：内核服务异常时回落 `standard`（默认档），
 * 并在 `projection` 里如实反映——降级不隐藏。
 */
export function readFocus(kernel: Kernel, session: SessionRef): FocusSnapshot {
  const depth: FocusDepth = peekFocus(kernel, session) ?? 'standard'
  return { depth, projection: projectFocus(depth) }
}

/** 写档位的结果；`text` 直接可以作为工具回执给模型看。 */
export interface FocusApplyResult {
  readonly ok: boolean
  readonly depth: FocusDepth
  readonly text: string
}

/**
 * 设档位。**绝不抛**：非法取值不改变状态并说明可用取值；内核异常也只回错误文本。
 *
 * 写入后**回读核实**：`setFocus` 不抛不等于档位真的落地（内核可能收敛、丢弃或
 * 写进了别的会话）。回执照回读值说——三态各自如实：
 * ① 回读 == 请求：`ok`，并写明已核实
 * ② 回读 != 请求：`ok=false`，把"请求 X / 读回 Y"都摆出来（模型能自行重试）
 * ③ 读不回来：不假装成功，明说无法核实
 *
 * 自检报告抓的正是这里：写入路径若不回读，"设了 deep 却没生效"就只能靠猜。
 */
export function applyFocus(
  kernel: Kernel,
  session: SessionRef,
  rawDepth: unknown,
  rawReason: unknown,
): FocusApplyResult {
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.trim() : '模型未给理由'
  if (!isFocusDepth(rawDepth)) {
    const current = peekFocus(kernel, session) ?? 'standard'
    return {
      ok: false,
      depth: current,
      text: `depth 必须是 ${FOCUS_DEPTHS.join(' / ')} 之一，收到 ${JSON.stringify(rawDepth ?? null)}；当前档位仍为 ${current}。`,
    }
  }
  try {
    kernel.setFocus(session, rawDepth, reason)
  } catch (error) {
    return {
      ok: false,
      depth: rawDepth,
      text: `设置深度失败：${error instanceof Error ? error.message : String(error)}；本次调用未改变档位。`,
    }
  }
  const actual = peekFocus(kernel, session)
  if (actual === null) {
    return {
      ok: true,
      depth: rawDepth,
      text: `已请求把推理深度设为 ${rawDepth}（理由：${reason}），但内核读不回档位，无法核实是否生效。${describeDepthEffect(rawDepth)}`,
    }
  }
  if (actual !== rawDepth) {
    return {
      ok: false,
      depth: actual,
      text: `档位未生效：请求 ${rawDepth}，内核读回 ${actual}；本次调用按 ${actual} 继续。可用取值 ${FOCUS_DEPTHS.join(' / ')}。`,
    }
  }
  return {
    ok: true,
    depth: actual,
    text: `已把推理深度设为 ${actual}（理由：${reason}；已回读核实）。${describeDepthEffect(actual)}`,
  }
}

/**
 * 一句话说明该档位**接下来会请求什么**（回执里给模型的自解释）。
 *
 * 措辞必须是**意图**，不能是完成态：注入发生在下一轮渲染
 * `PromptContribution.context` 时，且上下文紧张时卡片会降级成索引
 * （见 `index.ts` 的渲染分支）。回执若说"本轮会带上规则卡全文"，
 * 就是替渲染路径承诺了一件它可能做不到的事。
 *
 * v3.1 起回执的主语是**控制参数**（验证预算 / 证据要求 / 分支 / 复核 / 收尾），
 * 不再是"给你更多规则文本"：档位换的是行为门槛，不是字数。
 */
export function describeDepthEffect(depth: FocusDepth): string {
  if (depth === 'quick') {
    return `此后每轮请求注入"不要展开、直接回答"的指令。控制：${describeControl(depth)}。`
  }
  if (depth === 'deep') {
    const card = controlOf(depth).injectCard
    return [
      `此后每轮请求注入控制读数与规则卡 ${card ?? '（无）'}；控制：${describeControl(depth)}。`,
      `其余声明的规则卡（${(CARDS_BY_DEPTH.deep ?? []).filter(id => id !== card).join('/')}）用 omb_method 取；上下文紧张时只给读数、不给卡片。`,
    ].join('')
  }
  return `此后每轮不再主动注入规则卡正文；控制：${describeControl(depth)}。需要规则卡时用 omb_method 取。`
}
