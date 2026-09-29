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

  /** 是否存在任何受限（非 normal）的会话或受限基线。 */
  restricted(): boolean {
    return this.#anyRestricted()
  }

  /** 是否存在任何受限（非 normal）的会话或受限基线。 */
  #anyRestricted(): boolean {
    try {
      if (this.#deps.baselineRestricted()) return true
      for (const entry of this.#deps.state.overrides()) {
        if (entry.mode !== 'normal') return true
      }
      return false
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
