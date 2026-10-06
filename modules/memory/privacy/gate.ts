/**
 * 隐私闸门：**库访问边界的判定实现**（`SERVICES.privacy` 的值）。
 *
 * ## 形状为什么在这里又写一遍
 *
 * `modules/**` 之间禁止互相 import（ESLint 分层规则）。记忆模块在自己的
 * `store.ts` 里声明 `PrivacyGatePort`，本文件声明**同一形状**——双方只认结构，
 * 与 `SecondaryChannelRegistry<T>` 的处理方式一致。名字写错在类型上暴露不出来，
 * 因此有一条测试用**真的 store 服务**（不是假件）证明"sealed 下直接调库也被拒"。
 *
 * ## 判定语义
 *
 * - `decide(sessionId)`：按会话解析（本会话显式 → 沿血缘向上 → 基线）。
 *   - `mode === 'sealed'` → 读、写都拒
 *   - `mode === 'read-only'` → 写拒，读允许
 *   - `mode === 'normal'` → 都允许
 * - `decideUnattributed()`：**禁写不禁读**。归属未知时无法证明这次访问不受隐私
 *   约束；写不可逆、读可恢复，所以只堵不可逆的那边（详见 `modes.ts` 的文件头）。
 *   注意：**只有在真的存在受限会话（或基线本身就是受限档）时才禁写**——
 *   否则"从没用过隐私模式"的用户会连向量编码都用不了，那是把安全做成了功能故障。
 *   而"存在受限会话"的判据是**本进程内真的活跃过**（`isActive` 端口），
 *   不是"状态文件里还留着某条历史记录"——理由见 `#anyRestricted()` 与
 *   `state.ts` 的 `isActive()`。
 *
 * ## 计数
 *
 * 每次拒绝都计数并在状态面显示。理由：一个"永远拒绝"的闸门与"闸门根本没生效"
 * 在外部表现上都是"没有数据"，只有计数能把两者分开。
 */
import type { PrivacyMode, ResolvedPrivacy } from './modes.js'
import {
  allowsRead,
  allowsWrite,
  readDeniedDetail,
  UNATTRIBUTED_WRITE_DENIED,
  writeDeniedDetail,
} from './modes.js'
import type { PrivacyState } from './state.js'

/** 与 `modules/memory/store.ts` 的 `PrivacyDecisionPort` **结构一致**（不 import）。 */
export interface PrivacyDecision {
  readonly allowRead: boolean
  readonly allowWrite: boolean
  readonly readReason: string
  readonly writeReason: string
}

/** 与 `modules/memory/store.ts` 的 `PrivacyGatePort` **结构一致**（不 import）。 */
export interface PrivacyGatePort {
  decide(sessionId: string): PrivacyDecision
  decideUnattributed(): PrivacyDecision
}

export interface PrivacyGateStats {
  readonly decisions: number
  readonly readDenials: number
  readonly writeDenials: number
  readonly unattributedWriteDenials: number
  readonly lastDeniedSession: string | null
  readonly lastDeniedReason: string | null
}

export interface PrivacyGateDeps {
  readonly state: PrivacyState
  /** 基线是否受限（fail-closed 兜底时为真）——`decideUnattributed` 用。 */
  readonly baselineRestricted: () => boolean
  /**
   * 该会话在**本进程内**是否真的活跃过（`index.ts` 用会话运行态回答，
   * 判据见 `state.ts` 的 `isActive()`）。
   *
   * 用途：状态面逐条标注"活跃/已结束"，以及 `restrictedCounts()` 里的活跃条数。
   *
   * **必填**：漏传等于把 G1 那个 P0（历史受限记录永久粘住全进程）留在原地，
   * 因此不设默认值、不靠调用方自觉。
   */
  readonly isActive: (sessionId: string) => boolean
  /**
   * 本进程内是否存在**活跃且生效模式受限**的会话（含继承）——`#anyRestricted()` 的判据。
   *
   * 为什么需要独立于 `isActive` 的第二个端口：受限会话未必有自己的显式设置
   * （子代理**继承**父会话的模式，而继承不写回子会话），因此"有没有受限的活会话"
   * 不能靠"遍历 overrides() 再逐个问是否活跃"回答。由 `PrivacyState`
   * 的 `hasRestrictedActiveSession()` 提供，与 `decide()` 共用同一套解析。
   */
  readonly hasRestrictedActiveSession: () => boolean
}

export class PrivacyGate implements PrivacyGatePort {
  readonly #deps: PrivacyGateDeps
  #decisions = 0
  #readDenials = 0
  #writeDenials = 0
  #unattributedWriteDenials = 0
  #lastDeniedSession: string | null = null
  #lastDeniedReason: string | null = null

  constructor(deps: PrivacyGateDeps) {
    this.#deps = deps
  }

  /** 按会话判定。同步、**绝不抛**（库访问路径上不允许异常穿透判定本身）。 */
  decide(sessionId: string): PrivacyDecision {
    let resolved: ResolvedPrivacy
    try {
      resolved = this.#deps.state.resolve(sessionId)
    } catch {
      return {
        allowRead: false,
        allowWrite: false,
        readReason: '隐私状态解析失败：按最严处理，拒绝读',
        writeReason: '隐私状态解析失败：按最严处理，拒绝写',
      }
    }
    this.#decisions += 1
    const read = allowsRead(resolved.mode)
    const write = allowsWrite(resolved.mode)
    const readReason = read ? '' : readDeniedDetail(resolved)
    const writeReason = write ? '' : writeDeniedDetail(resolved)
    if (!read) {
      this.#readDenials += 1
      this.#lastDeniedSession = sessionId
      this.#lastDeniedReason = readReason
    }
    if (!write) {
      this.#writeDenials += 1
      this.#lastDeniedSession = sessionId
      this.#lastDeniedReason = writeReason
    }
    return { allowRead: read, allowWrite: write, readReason, writeReason }
  }

  /**
   * 归属未知：禁写不禁读。
   *
   * 只有"确实存在受限会话（或基线受限）"时才禁写：`normal` 世界里这条判定必须放行，
   * 否则向量编码队列（`memory/written` 载荷不带会话）会永远写不进去——
   * 那不是安全，是把隐私模块变成一个静默的功能故障。
   */
  decideUnattributed(): PrivacyDecision {
    this.#decisions += 1
    const restricted = this.#anyRestricted()
    if (!restricted) {
      return { allowRead: true, allowWrite: true, readReason: '', writeReason: '' }
    }
    this.#unattributedWriteDenials += 1
    this.#lastDeniedSession = null
    this.#lastDeniedReason = UNATTRIBUTED_WRITE_DENIED
    return {
      allowRead: true,
      allowWrite: false,
      readReason: '',
      writeReason: UNATTRIBUTED_WRITE_DENIED,
    }
  }

  /** 是否存在**本进程内活跃**的受限会话或受限基线。 */
  restricted(): boolean {
    return this.#anyRestricted()
  }

  /**
   * 受限会话的两个数：**历史记录**条数（状态文件里全部非 normal 的条目）
   * 与**本进程活跃**条数（`#anyRestricted()` 真正看的那一部分）。
   *
   * 为什么要分开报：`overrides()` 里既有本进程设的，也有启动时从状态文件
   * 重放进来的已结束会话。把两者混成一个数，等于让状态面替读者承诺
   * "这些限制都在生效"——而 G1 那个 P0 正是这么长出来的（见 `#anyRestricted`）。
   *
   * 返回 `null` = **未测量**（读会话状态失败）：此时不许写 0，
   * 否则"读不出来"会被渲染成"一条都没有"（硬不变量：区分未测量与测到 0）。
   */
  restrictedCounts(): { readonly history: number; readonly active: number } | null {
    try {
      let history = 0
      let active = 0
      for (const entry of this.#deps.state.overrides()) {
        if (entry.mode === 'normal') continue
        history += 1
        if (this.#deps.isActive(entry.sessionId)) active += 1
      }
      return { history, active }
    } catch {
      return null
    }
  }

  /**
   * 是否存在任何**本进程内活跃**的受限会话，或受限基线。
   *
   * 为什么按活跃判定、而不是遍历全部历史记录（G1，P0）：
   * `overrides()` 里有启动时从状态文件重放进来的条目。只要用户**曾经**在任何一个
   * 会话里设过一次 `read-only`/`sealed`，那条记录就永久留在文件里，每次启动都被
   * 重放进运行态表，于是本判据从此恒真——此后**每一个**新会话的"归属未知写"
   * （向量编码队列经 `stores.snapshot()` 落盘 `putEmbedding`）都被拒，
   * 语义召回静默退化成词法召回，而健康面仍是 ok。
   *
   * 已结束的会话不可能再产生新内容，它的限制不该继续掐住全进程；
   * 而**真的活着**的受限会话仍然必须拒绝——fail-closed 没有放宽：
   * - 本进程内设过模式的会话（命令面走 `noteLineage()` → `note()`）→ 活跃 → 拒；
   * - 从文件重放进来、随后又真的活跃起来的会话 → 重新武装 → 拒；
   * - **继承**了受限档的活跃子会话（父会话可能已结束）→ 拒（判据含继承）。
   * 判定不了时按受限处理（安全方向）。
   */
  #anyRestricted(): boolean {
    try {
      if (this.#deps.baselineRestricted()) return true
      return this.#deps.hasRestrictedActiveSession()
    } catch {
      // 判定不了 → 按受限处理（安全方向）
      return true
    }
  }

  stats(): PrivacyGateStats {
    return {
      decisions: this.#decisions,
      readDenials: this.#readDenials,
      writeDenials: this.#writeDenials,
      unattributedWriteDenials: this.#unattributedWriteDenials,
      lastDeniedSession: this.#lastDeniedSession,
      lastDeniedReason: this.#lastDeniedReason,
    }
  }
}

/** 供状态面显示模式与来源的一行。 */
export function describeMode(mode: PrivacyMode): string {
  switch (mode) {
    case 'normal': return 'normal（可读可写）'
    case 'read-only': return 'read-only（可读不可写）'
    case 'sealed': return 'sealed（不可读不可写）'
  }
}
