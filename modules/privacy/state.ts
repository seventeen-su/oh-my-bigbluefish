/**
 * 隐私状态的**存放处**：挂在会话运行态上，按会话键控。
 *
 * ## 为什么不是模块私有变量
 *
 * `Map<sessionId, mode>` 这种形状本身没问题，但**放在模块的模块级变量里**会重蹈
 * `lastActiveSession` 的覆辙（`kernel/sessionRuntime.ts` 的文件头记录了那次代价：
 * "最近一个会话"在多会话交错时把状态写进别人家）。因此这里把每个会话的模式
 * 放进 `SessionRuntime.slot('privacy:mode')`——容器的契约保证 `for(A)` 永远拿不到
 * B 的槽，且槽名必须带模块前缀（`privacy:`）。
 *
 * ## 子代理继承：**读时解析**，不落盘
 *
 * 子会话有**自己的** sessionId。血缘来自宿主会话头
 * `session.header.parentSession`（`packages/core/session/src/types.ts:107`），
 * 由本模块订阅宿主 `session/event` 时登记进 `SessionRuntimeTable`
 * （`kernel/sessionRuntime.ts` 的 `note({ parentSessionId })`）。
 *
 * 解析顺序：**本会话显式设置 → 沿血缘向上找第一个显式设置 → 基线**。
 * 关键点：继承结果**不写回子会话**。写回会制造一份会漂移的副本（父会话改模式后
 * 子会话还是旧值），而本项目已经为"同一事实存两遍"付过代价。读时解析的代价是一次
 * 深度受限的向上查找（上限 8 层 + 环检测），换来的是"父改子立刻跟着改"。
 *
 * ## 基线（没有记录时的模式）
 *
 * - `failClosedAt === null` → `normal`（**从未配置过**，不是"读不出来"）
 * - `failClosedAt !== null` → 配置项 `failClosedMode`（默认 `sealed`，可选 `read-only`）
 *
 * 这条区分是 fail-closed 的全部要害：把"文件不存在"当成"读不出来"会让首次安装的
 * 用户记忆直接不可用；把"读不出来"当成"不存在"则会让损坏悄悄放宽隐私。
 */
import type { Clock } from '../../kernel/abi/index.js'
import type { SessionRuntime, SessionRuntimeTable, TurnSource } from '../../kernel/sessionRuntime.js'
import type { PrivacyMode } from './modes.js'
import { modeTitle, originTitle, type PrivacyOrigin, type ResolvedPrivacy } from './modes.js'

/** 槽名：必须带模块前缀（`SessionRuntime.slot` 的契约）。 */
export const PRIVACY_SLOT = 'privacy:mode'

/** 向上的最大层数（子代理委派深度有限；环检测另算一道保险）。 */
export const MAX_INHERIT_DEPTH = 8

export interface PrivacyOverride {
  readonly mode: PrivacyMode
  readonly updatedAt: number
}

export interface PrivacyBaseline {
  readonly mode: PrivacyMode
  readonly origin: Extract<PrivacyOrigin, 'default' | 'fail-closed'>
  readonly detail: string
}

export interface PrivacyStateDeps {
  readonly sessions: SessionRuntimeTable
  readonly clock: Clock
  /** 基线（由文档的 `failClosedAt` 与配置共同决定）。 */
  readonly baseline: () => PrivacyBaseline
  readonly maxDepth?: number
}

/** 供持久化与状态面用的只读条目。 */
export interface PrivacyOverrideEntry {
  readonly sessionId: string
  readonly mode: PrivacyMode
  readonly updatedAt: number
}

/** 槽里放的**可变持有者**：`SessionRuntime.slot()` 只在首次创建时用 init， */
/** 因此要"改"一个已存在的槽，只能改它里面的对象（不给容器加删除语义）。 */
interface OverrideHolder {
  current?: PrivacyOverride
}

export class PrivacyState {
  readonly #deps: PrivacyStateDeps
  readonly #maxDepth: number

  constructor(deps: PrivacyStateDeps) {
    this.#deps = deps
    this.#maxDepth = Math.max(1, deps.maxDepth ?? MAX_INHERIT_DEPTH)
  }

  /**
   * 登记会话血缘（由宿主 `session/event` 与命令 invocation 调用）。
   *
   * 只登记**拿到的事实**：`parentSessionId` 为空就不写血缘（顶层会话），
   * 绝不用"最近看到的父会话"顶替（那正是 `lastActiveSession` 的坑）。
   */
  noteLineage(input: {
    readonly sessionId: string
    readonly parentSessionId?: string | null
    readonly delegationDepth?: number | null
    readonly source: TurnSource
  }): SessionRuntime | null {
    const sessionId = input.sessionId.trim()
    if (sessionId.length === 0) return null
    try {
      this.#deps.sessions.note({
        sessionId,
        parentSessionId: input.parentSessionId ?? undefined,
        delegationDepth: input.delegationDepth ?? undefined,
        source: input.source,
      })
    } catch {
      // 登记失败不得影响会话（H-3）：血缘缺失时解析会退回基线，方向是安全的
      return null
    }
    return this.#deps.sessions.for(sessionId) ?? null
  }

  /** 本会话的**显式**设置（不含继承）。 */
  overrideOf(sessionId: string): PrivacyOverride | undefined {
    const runtime = this.#deps.sessions.for(sessionId)
    return runtime === undefined ? undefined : this.#currentOf(runtime)
  }

  /** 显式设置本会话的模式（命令路径）。 */
  setOverride(sessionId: string, mode: PrivacyMode): PrivacyOverride | null {
    const id = sessionId.trim()
    if (id.length === 0) return null
    const runtime = this.#deps.sessions.ensure(id)
    if (runtime === null) return null
    const next: PrivacyOverride = { mode, updatedAt: this.#deps.clock.now() }
    runtime.slot<OverrideHolder>(PRIVACY_SLOT, () => ({} as OverrideHolder)).current = next
    return next
  }

  /** 清除本会话的显式设置（回到继承/基线）。 */
  clearOverride(sessionId: string): boolean {
    const runtime = this.#deps.sessions.for(sessionId)
    const holder = runtime?.peekSlot<OverrideHolder>(PRIVACY_SLOT)
    if (holder === undefined) return false
    holder.current = undefined
    return true
  }

  /** 全部显式设置（持久化与状态面用；按 sessionId 稳定排序）。 */
  overrides(): readonly PrivacyOverrideEntry[] {
    const out: PrivacyOverrideEntry[] = []
    for (const runtime of this.#deps.sessions.list()) {
      const current = this.#currentOf(runtime)
      if (current === undefined) continue
      out.push({ sessionId: runtime.sessionId, mode: current.mode, updatedAt: current.updatedAt })
    }
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }

  /**
   * 判定某会话当前生效的模式。
   *
   * 顺序：本会话显式 → 沿血缘向上第一个显式 → 基线。
   * **绝不抛**：容器或时钟异常都退化为基线（安全方向）。
   */
  resolve(sessionId: string): ResolvedPrivacy {
    try {
      return this.#resolve(sessionId)
    } catch {
      const baseline = this.#safeBaseline()
      return {
        mode: baseline.mode,
        origin: 'fail-closed',
        inheritedFrom: null,
        detail: `解析隐私状态时出错，已按 ${modeTitle(baseline.mode)} 兜底`,
      }
    }
  }

  #resolve(sessionId: string): ResolvedPrivacy {
    const id = sessionId.trim()
    if (id.length === 0) {
      const baseline = this.#safeBaseline()
      return {
        mode: baseline.mode,
        origin: baseline.origin,
        inheritedFrom: null,
        detail: `${baseline.detail}（未提供会话 id）`,
      }
    }

    const seen = new Set<string>()
    let current: string | null = id
    for (let depth = 0; depth < this.#maxDepth && current !== null; depth += 1) {
      if (seen.has(current)) break // 环（伪造的血缘）：停止向上，回基线
      seen.add(current)

      const runtime = this.#deps.sessions.for(current)
      const override = runtime === undefined ? undefined : this.#currentOf(runtime)
      if (override !== undefined) {
        const inherited = current !== id
        return {
          mode: override.mode,
          origin: inherited ? 'inherited' : 'command',
          inheritedFrom: inherited ? current : null,
          detail: inherited
            ? `继承自 ${current} 的显式设置（${modeTitle(override.mode)}）`
            : `本会话由命令显式设置为 ${modeTitle(override.mode)}`,
        }
      }
      const parent: string | null = runtime?.parentSessionId ?? null
      current = parent !== null && parent.trim().length > 0 ? parent : null
    }

    const baseline = this.#safeBaseline()
    return {
      mode: baseline.mode,
      origin: baseline.origin,
      inheritedFrom: null,
      detail: baseline.detail,
    }
  }

  /** 取某运行态的**当前**显式设置（槽里放的是可变持有者）。 */
  #currentOf(runtime: SessionRuntime): PrivacyOverride | undefined {
    return runtime.peekSlot<OverrideHolder>(PRIVACY_SLOT)?.current
  }

  #safeBaseline(): PrivacyBaseline {
    try {
      return this.#deps.baseline()
    } catch {
      return { mode: 'sealed', origin: 'fail-closed', detail: '基线解析出错，已按 sealed 兜底' }
    }
  }
}

/** 供状态面显示来源的一句话（含继承出处）。 */
export function describeResolved(resolved: ResolvedPrivacy): string {
  const inherited = resolved.inheritedFrom === null ? '' : `（继承自 ${resolved.inheritedFrom}）`
  return `${modeTitle(resolved.mode)}·${originTitle(resolved.origin)}${inherited}`
}
