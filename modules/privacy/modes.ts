/**
 * 隐私模式的**语义**（纯函数，零 I/O）。
 *
 * ## 三种模式，语义一字不差
 *
 * | 模式 | 读记忆 | 写记忆 |
 * |---|---|---|
 * | `normal`（默认） | ✅ | ✅ |
 * | `read-only`（只读） | ✅ 允许 | ❌ **禁止**（omb_remember / 整合 / 向量落盘 / 任何写库路径） |
 * | `sealed`（禁读禁写） | ❌ 禁止 | ❌ 禁止 |
 *
 * ## 为什么模式取值只有三个、且**有序**
 *
 * "更严的一档"是 fail-closed 的判据基础（读不到持久化状态时按更严的来），
 * 因此模式必须能比较：`normal < read-only < sealed`。这不是审美排序——
 * 它把"降级时往哪边倒"变成一条可测的规则（`stricterOf`）。
 *
 * ## 为什么"归属未知"禁写不禁读
 *
 * 拿不到会话归属时（`ToolContext.attribution === 'unknown'`）无法判定任何会话的模式。
 * 两条路都会错：放行可能把隐私会话的内容写进库（**不可逆**），全禁会让库彻底不可用
 * （**可恢复**）。因此取不可逆的那一边：**禁写、不禁读**，并把每次命中计数进状态面。
 * 这也是与 `kernel/sessionRuntime.ts` 的"拿不到就不猜"一致的做法。
 */

/** 隐私模式。取值与语义见文件头表格。 */
export type PrivacyMode = 'normal' | 'read-only' | 'sealed'

export const PRIVACY_MODES: readonly PrivacyMode[] = ['normal', 'read-only', 'sealed']

/**
 * 模式的**来源**。`omb_status` 必须能回答"这条模式是用户设的还是继承来的"，
 * 因此来源是判定结果的一部分，不是附注。
 */
export type PrivacyOrigin =
  /** 用户用命令显式设置本会话。 */
  | 'command'
  /** 继承自祖先会话（子代理）。 */
  | 'inherited'
  /** 没有任何记录 —— 按基线（默认 normal）。 */
  | 'default'
  /** 持久化状态读不出/解析失败 —— 按更严的一档兜底（fail-closed）。 */
  | 'fail-closed'

/** 一次判定结果：模式 + 来源 + 可读说明。 */
export interface ResolvedPrivacy {
  readonly mode: PrivacyMode
  readonly origin: PrivacyOrigin
  /** `origin === 'inherited'` 时，实际提供模式的那个祖先会话 id。 */
  readonly inheritedFrom: string | null
  /** 可读说明（状态面与拒绝原因都用它，保证"拒绝理由可读"）。 */
  readonly detail: string
}

/** 严格度排序：数值越大越严。fail-closed 的"更严"就靠这条。 */
export function rankOf(mode: PrivacyMode): number {
  switch (mode) {
    case 'normal': return 0
    case 'read-only': return 1
    case 'sealed': return 2
  }
}

/** 取两者中更严的一档。 */
export function stricterOf(a: PrivacyMode, b: PrivacyMode): PrivacyMode {
  return rankOf(a) >= rankOf(b) ? a : b
}

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === 'string' && PRIVACY_MODES.includes(value as PrivacyMode)
}

/**
 * 解析命令输入里的模式名。
 *
 * 接受少量等价写法（`readonly` / `readOnly` / `ro`），因为用户手打的是命令；
 * 但**不接受**任何含糊的中间态：解析不出来就是解析不出来（给用法而不是猜）。
 */
export function parseMode(raw: string): PrivacyMode | undefined {
  const text = raw.trim().toLowerCase()
  switch (text) {
    case 'normal':
    case 'off':
    case 'none':
      return 'normal'
    case 'read-only':
    case 'readonly':
    case 'ro':
      return 'read-only'
    case 'sealed':
    case 'seal':
      return 'sealed'
    default:
      return undefined
  }
}

/** 中文标签（状态面与命令回执共用一处，避免两处措辞漂移）。 */
export function modeTitle(mode: PrivacyMode): string {
  switch (mode) {
    case 'normal': return 'normal（可读可写）'
    case 'read-only': return 'read-only（可读不可写）'
    case 'sealed': return 'sealed（不可读不可写）'
  }
}

/** 来源标签。 */
export function originTitle(origin: PrivacyOrigin): string {
  switch (origin) {
    case 'command': return '命令设置'
    case 'inherited': return '继承'
    case 'default': return '默认'
    case 'fail-closed': return 'fail-closed 兜底'
  }
}

/** 读是否允许。**只有 sealed 禁止读。** */
export function allowsRead(mode: PrivacyMode): boolean {
  return mode !== 'sealed'
}

/** 写是否允许。**只有 normal 允许写。** */
export function allowsWrite(mode: PrivacyMode): boolean {
  return mode === 'normal'
}

/** 拒绝读的可读原因（必填语义：调用方拿到的是给人/模型看的句子）。 */
export function readDeniedDetail(resolved: ResolvedPrivacy): string {
  return (
    `该会话处于 ${modeTitle(resolved.mode)} 隐私模式（来源：${originTitle(resolved.origin)}`
    + `${resolved.inheritedFrom === null ? '' : `，继承自 ${resolved.inheritedFrom}`}）：`
    + '禁止读取记忆。用 /omb-privacy normal 或 /omb-privacy read-only 解除读限制。'
  )
}

/** 拒绝写的可读原因。 */
export function writeDeniedDetail(resolved: ResolvedPrivacy): string {
  return (
    `该会话处于 ${modeTitle(resolved.mode)} 隐私模式（来源：${originTitle(resolved.origin)}`
    + `${resolved.inheritedFrom === null ? '' : `，继承自 ${resolved.inheritedFrom}`}）：`
    + '禁止写入记忆（omb_remember / 整合 / 向量落盘等一切写库路径）。'
    + '用 /omb-privacy normal 解除写限制。'
  )
}

/**
 * 归属未知时的拒绝写原因。
 *
 * 措辞必须说明"为什么禁"（拿不到会话，无法证明它不受隐私模式约束），
 * 否则用户会以为是自己设错了模式。
 */
export const UNATTRIBUTED_WRITE_DENIED =
  '无法确定本次调用的会话归属（宿主未提供 agent），因此无法证明它不受隐私模式约束：'
  + '按最严处理，禁止写入记忆。读不受影响。'
