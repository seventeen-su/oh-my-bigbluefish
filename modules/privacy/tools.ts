/**
 * `omb_privacy` —— 模型可调用的**隐私模式控制面**。
 *
 * ## 为什么会有这条工具（与模块原来的设计意图不同，理由必须写清楚）
 *
 * `modules/privacy/index.ts` 原本刻意**不提供工具**，注释写着：
 *
 * > 控制面是一条斜杠命令（`/omb-privacy`），不是模型可调用的工具——
 * > **隐私模式是"用户"的决定，不该由模型自己改。**
 *
 * 那个意图是**对的**。但它建立在一个不成立的前提上：**命令在 Web 界面里够不着**。
 * 实测证据（2026-09-30，真实 GUI）：
 *
 * 1. 在会话里发出 `/omb-privacy normal`；
 * 2. 读 `omb_status` → `显式设置 0 个会话`、状态文件从未被创建 → **命令没被执行**；
 * 3. grep 整个 DSH Web 客户端：**没有斜杠命令处理**（无 `commandPalette` /
 *    无 `slashCommand` / 无命令探测）。
 *
 * 于是"命令是唯一入口"等于**这个功能对 Web 用户不可用**。所以补一条工具，
 * 但**必须用设计手段保住原意图**——见下。
 *
 * ## 边界：模型只能**收紧**，不能放宽
 *
 * | 动作 | 模型可否 |
 * | --- | --- |
 * | `normal` → `read-only` / `sealed`（收紧） | ✅ 可直接调用 |
 * | `read-only` → `sealed`（收紧） | ✅ 可直接调用 |
 * | 放宽（`sealed` → `normal` 等） | ❌ **拒绝**，并告知"这需要用户明确要求" |
 * | `trust`（清 fail-closed 粘性） | ❌ **根本不提供**——那是人类动作 |
 *
 * 这样"隐私是用户的决定"这条意图仍然成立：**模型无法把自己放出来**。
 * 用户在对话里明确说"改成 normal"时，模型可以在**同一轮**用 `allowLoosen: true`
 * 放宽——这个参数是**记录在案的授权痕迹**，回执里会写明是谁要求放宽的。
 *
 * ## 为什么放宽要单独一个参数而不是自动允许
 *
 * 自动允许等于把"是否放宽"交给模型的判断。而放宽隐私**没有任何技术手段可以撤销**
 * （记忆一旦被读出就已经出去了）。所以把它做成一个**显式、可审计、需要理由**的动作，
 * 代价是多传一个字段，收益是"模型悄悄放宽"在结构上不可能。
 */
import type { ModuleHealth } from '../../kernel/abi/index.js'
import type { ToolDefinition } from '../../kernel/abi/index.js'
import type { PrivacyMode } from './modes.js'
import { PRIVACY_MODES, modeTitle, rankOf } from './modes.js'

/** 工具名。 */
export const PRIVACY_TOOL = 'omb_privacy'

/** 工具要用到的那部分能力（由模块 `apply` 注入）。 */
export interface PrivacyToolDeps {
  /** 读当前会话（或指定会话）的模式与来源。 */
  readonly statusText: (sessionId: string | null) => string
  /** 设置模式（返回可读回执）。 */
  readonly setMode: (sessionId: string, mode: PrivacyMode) => { kind: string; text: string }
  /**
   * 取某会话当前的有效模式。
   *
   * 用于"只能收紧"的判定：必须拿**当前生效的**模式比较，
   * 而不是拿模型以为的模式——后者可以被谎报。
   */
  readonly modeOf: (sessionId: string | null) => PrivacyMode
  /** 取本会话 id；拿不到返回 null（**不猜**）。 */
  readonly currentSession: () => string | null
}

/**
 * 桥传给工具执行体的第二个参数（`dsh/tools.ts` 从宿主 `exec.agent` 取）。
 *
 * **为什么不用全局变量记"当前会话"**：工具可能被并发调用，全局变量会把
 * 两个会话的归属串起来——那正是第 4 项要修的那类缺陷。每次调用自己的
 * `call.sessionId` 才是正确来源。
 */
export interface ToolCallContextLike {
  readonly sessionId?: string | null
}

/** 参数形状（供模型阅读）。 */
export const privacyParameters = {
  jsonSchema: {
    type: 'object' as const,
    properties: {
      mode: {
        type: 'string',
        enum: [...PRIVACY_MODES],
        description:
          '要设置的模式。read-only=可读不可写；sealed=不可读不可写；normal=可读可写。'
          + '未指定则只查询当前模式（不修改）。',
      },
      session: {
        type: 'string',
        description: '要操作的会话 id。省略 = 本次调用所属的会话。',
      },
      allowLoosen: {
        type: 'boolean',
        description:
          '放宽（变成更宽松的模式）必须显式置 true，且只有用户在同一轮明确要求时才可置。'
          + '收紧不需要它。',
      },
      reason: {
        type: 'string',
        description: '放宽时的理由（用户的哪句话要求的）。写入回执，作为审计痕迹。',
      },
    },
    required: [],
  },
} as const

interface PrivacyArgs {
  readonly mode?: unknown
  readonly session?: unknown
  readonly allowLoosen?: unknown
  readonly reason?: unknown
}

/** 从参数里取出合法模式；缺失/非法返回 undefined。 */
function modeFrom(raw: unknown): PrivacyMode | undefined {
  return typeof raw === 'string' && (PRIVACY_MODES as readonly string[]).includes(raw)
    ? (raw as PrivacyMode)
    : undefined
}

/**
 * 建工具。
 *
 * **绝不抛**：任何输入都得到一条可读结果（与模块的 H-1/H-3 一致）。
 */
export function createPrivacyTool(deps: PrivacyToolDeps): ToolDefinition {
/** 未指定 `session` 时用的会话（拿不到就不猜，见下面各分支）。 */
  const resolveSession = (
    raw: unknown,
    call: ToolCallContextLike | undefined,
  ): { id: string | null; explicit: boolean } => {
    if (typeof raw === 'string' && raw.trim().length > 0) return { id: raw.trim(), explicit: true }
    // 本次调用自己的会话优先；拿不到才回落到注入的兜底（通常也是 null）
    const fromCall = typeof call?.sessionId === 'string' && call.sessionId.length > 0 ? call.sessionId : null
    return { id: fromCall ?? deps.currentSession(), explicit: false }
  }

  return {
    name: PRIVACY_TOOL,
    description:
      '查看或设置本会话的记忆隐私模式。read-only=可读不可写；sealed=不可读不可写；'
      + 'normal=可读可写。按会话生效、子代理继承、重启不丢。'
      + '**收紧可以直接设；放宽必须由用户明确要求并传 allowLoosen**。',
    parameters: privacyParameters,
    execute: (input: unknown, call?: ToolCallContextLike): { kind: string; text: string } => {
      try {
        const args = (input ?? {}) as PrivacyArgs
        const { id: sessionId, explicit } = resolveSession(args.session, call)

        if (sessionId === null) {
          // 归属未知：**不猜**。查询可以（如实说不知道是哪个会话），修改不行。
          const wanted = modeFrom(args.mode)
          if (wanted === undefined) {
            return {
              kind: 'success',
              text: `${deps.statusText(null)}\n（本次调用拿不到会话归属：只能查看全局状态，无法修改。`
                + '请在会话回合内调用，或显式给出 session。）',
            }
          }
          return {
            kind: 'error',
            text: '无法修改隐私模式：本次调用没有会话归属，且未显式给出 session。'
              + '**不猜**——猜错会把状态写进别人的会话。请显式给出 session，或在会话回合内调用。',
          }
        }

        const current = deps.modeOf(sessionId)
        const wanted = modeFrom(args.mode)

        /**
         * **非法 `mode` 必须报错，不能当成"没给"。**
         *
         * 这条是测试抓出来的真缺陷：`{ mode: 'trust' }` 原先返回 `success`——
         * 因为 `modeFrom` 对未知值返回 `undefined`，代码把它当成"只查询"。
         * 于是**一个打错的或不该存在的模式名会被静默当成查询**，
         * 使用者以为设置成功了。
         *
         * 这正是本项目反复踩的"**形态匹配当语义**"：`undefined` 同时表示
         * "没给"和"给了但非法"，两者含义完全相反，不能共用一条分支。
         */
        if (args.mode !== undefined && wanted === undefined) {
          return {
            kind: 'error',
            text:
              `不认识的隐私模式「${String(args.mode)}」。可选：${PRIVACY_MODES.join(' / ')}。`
              + '\n（想只查询当前模式，请不要传 mode。）',
          }
        }

        // 只查询
        if (wanted === undefined) {
          return {
            kind: 'success',
            text: `${deps.statusText(sessionId)}`
              + `${explicit ? '' : '\n（未显式给出 session，用的是本次调用所属会话。）'}`,
          }
        }

        const tightening = rankOf(wanted) > rankOf(current)
        const same = wanted === current

        if (same) {
          return {
            kind: 'success',
            text: `会话 ${sessionId} 已经是 ${modeTitle(wanted)}，未做修改。`,
          }
        }

        if (!tightening && args.allowLoosen !== true) {
          return {
            kind: 'error',
            text:
              `拒绝放宽隐私：会话 ${sessionId} 当前是 ${modeTitle(current)}，`
              + `改成 ${modeTitle(wanted)} 是**放宽**。`
              + '\n模型不能自行放宽隐私——这是刻意的设计：'
              + '放宽后读出的内容**无法收回**，没有技术手段可以撤销。'
              + '\n如果用户在本次对话里明确要求放宽，请带 `allowLoosen: true` 与 `reason` 重试；'
              + '否则请让用户自己在插件页或命令里改。',
          }
        }

        const applied = deps.setMode(sessionId, wanted)
        const audit = args.allowLoosen === true
          ? `\n（**放宽**由用户要求触发${typeof args.reason === 'string' && args.reason.trim().length > 0 ? `：${args.reason.trim()}` : '（未给理由）'}）`
          : '\n（**收紧**，模型可直接执行。）'
        return { kind: applied.kind, text: applied.text + audit }
      } catch (error) {
        return {
          kind: 'error',
          text: `隐私工具内部错误（已隔离，不影响其它功能）——${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  } as unknown as ToolDefinition
}

/** 供健康面用：工具是否可用（模块 apply 时上报）。 */
export function privacyToolHealth(available: boolean): ModuleHealth {
  return available
    ? { state: 'ok', detail: `隐私控制面：命令 + 工具 ${PRIVACY_TOOL}` }
    : { state: 'degraded', detail: '隐私控制面：工具未注册' }
}
