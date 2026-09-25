/**
 * 画像落盘：**通过 `omb-memory` 的服务读写，不自己开数据库**。
 *
 * 存储形态：每个 scope 一份**确定性 id 的 JSON 文档**
 * （`omb-profile/user`、`omb-profile/project`）。
 * 为什么是文档而不是每条目一条记录：冻结的 `MemoryStore` 只有 `get`/`put`，
 * **没有枚举接口**，逐条写入后无法读回全部条目。用一份文档 + 确定性 id，
 * 只需 `get`/`put` 两个方法，不依赖任何未冻结的接口。
 *
 * 路由（§5.8 + 任务约定）：
 * - `intent` 轴 → **项目库**（意图是项目相关的）
 * - 显式陈述（declared）→ **跨项目库**（用户可编辑的稳定事实）
 * - 推断条目（inferred，非能力轴）→ **项目库**（推断不外溢到"关于你的一切"）
 * - `capability` 轴 → **结构性拒绝落盘**（D4）
 *
 * 一切失败都返回可读错误，**绝不抛异常**（热插拔 + 工具执行体约束）。
 */
import type { Clock, Logger, MemoryKind, MemoryRecord, MemoryScope } from '../../kernel/abi/index.js'
import { MEMORY_SCOPES, RESERVED_SOURCE_PREFIX } from '../../kernel/abi/index.js'
import type { ProfileEntry } from './entries.js'
import { decodeDocument, fnv1a, serializeDocument } from './entries.js'

/**
 * 只用到 `get`/`put` 的窄端口。
 * 真实的 `StoreSet`（`kernel/abi/storage.ts`）在结构上可直接传入
 * （`projectScope` 是可选读取项：有就用它当记录的项目来源标注）。
 */
export interface ProfileStorePort {
  put(record: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | undefined>
}

export interface ProfileStoresPort {
  store(scope: MemoryScope): ProfileStorePort | undefined
  /** 项目库对应的规范化 cwd（ABI 的 `StoreSet.projectScope`）；用户库专属套件为 null。 */
  readonly projectScope?: string | null
}

/**
 * 服务可以按需解析（兼容热插拔：记忆模块可能在画像之后加载，或被卸载后重载）。
 */
export type ProfileStoresProvider =
  | ProfileStoresPort
  | (() => ProfileStoresPort | undefined)
  | undefined

export const PROFILE_DOC_ID_PREFIX = 'omb-profile'

/** 文档 id：确定性、每个 scope 唯一。 */
export function profileDocId(scope: MemoryScope): string {
  return `${PROFILE_DOC_ID_PREFIX}/${scope}`
}

/**
 * `source_ref`：**必须带 ABI 的保留前缀**（`kernel/abi/catalog.ts` 的
 * `RESERVED_SOURCE_PREFIX`）。
 *
 * 画像文档不是"经验痕迹"，是结构化状态：确定性 id + 整体覆盖写。
 * 若被离线整合当成经验参与去重/回响合并/衰减排序，会被错误地塌缩或降权，
 * 所以 `consolidate`/`retrieve` 按这个前缀一处跳过即可（ABI 级约定，不是各模块私约）。
 */
export function profileSourceRef(scope: MemoryScope): string {
  return `${RESERVED_SOURCE_PREFIX}${PROFILE_DOC_ID_PREFIX}/${scope}`
}

/**
 * 条目该落哪个库。**位置即权威**，不存在可漂移的 scope 标签。
 */
export function scopeOfEntry(entry: ProfileEntry): MemoryScope {
  if (entry.axis === 'capability') return 'project' // 只会被 storage 拒绝，不产生写入
  if (entry.axis === 'intent') return 'project'
  if (entry.provenance === 'inferred') return 'project'
  return 'user'
}

export interface ProfileStorageDeps {
  readonly stores: ProfileStoresProvider
  readonly clock: Clock
  readonly logger: Logger
  /** 项目名（来源标注）；未知传 null。可用 `setProject` 在会话建立后补齐。 */
  readonly project?: string | null
}

export interface ProfileLoadResult {
  readonly entries: readonly ProfileEntry[]
  /** 可读的降级原因；全部正常时为 null。 */
  readonly error: string | null
}

export interface ProfileSaveResult {
  readonly ok: boolean
  /** 真正写下的文档份数（内容未变则不写——避免无意义写入与 WAL 增长）。 */
  readonly documentsWritten: number
  /** 被 D4 结构性拒绝的能力轴条目数。 */
  readonly capabilitySkipped: number
  readonly error: string | null
}

export interface ProfileAvailability {
  readonly ok: boolean
  readonly detail: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ProfileStorage {
  /**
   * scope → 记忆类型。必须与 `SCOPE_BY_KIND` 一致（有测试断言），
   * 否则会出现"记录自称的 scope 与实际所在库不符"。
   */
  static readonly KIND_BY_SCOPE: Readonly<Record<MemoryScope, MemoryKind>> = {
    user: 'semantic',
    project: 'episodic',
  }

  readonly #deps: ProfileStorageDeps
  #project: string | null

  constructor(deps: ProfileStorageDeps) {
    this.#deps = deps
    this.#project = deps.project ?? null
  }

  setProject(project: string | null): void {
    this.#project = project
  }

  /** 记忆库是否可用。**取不到时给出可读原因**，不抛。 */
  availability(): ProfileAvailability {
    const stores = this.#resolveStores()
    if (stores === undefined) {
      return { ok: false, detail: '内核服务 stores 不可用（omb-memory 未加载或已卸载）' }
    }
    const missing: MemoryScope[] = []
    for (const scope of MEMORY_SCOPES) {
      if (stores.store(scope) === undefined) missing.push(scope)
    }
    if (missing.length > 0) {
      return { ok: false, detail: `记忆库缺少 ${missing.join('、')} 库（该库未打开）` }
    }
    return { ok: true, detail: `记忆库可用（${MEMORY_SCOPES.join('、')} 双库）` }
  }

  /** 读取两个库里的画像文档。任何失败都变成可读错误。 */
  async load(): Promise<ProfileLoadResult> {
    const entries: ProfileEntry[] = []
    const errors: string[] = []
    for (const scope of MEMORY_SCOPES) {
      const store = this.#storeFor(scope)
      if (store === undefined) {
        errors.push(`${scope} 库不可用：${this.#missingReason(scope)}`)
        continue
      }
      let record: MemoryRecord | undefined
      try {
        record = await store.get(profileDocId(scope))
      } catch (error) {
        errors.push(`${scope} 库读取失败：${messageOf(error)}`)
        continue
      }
      if (record === undefined) continue
      const decoded = decodeDocument(record.text)
      if (decoded.error !== null) errors.push(`${scope} 库画像文档无法解析：${decoded.error}`)
      if (decoded.dropped > 0) {
        this.#deps.logger.warn(`画像：${scope} 库文档丢弃 ${decoded.dropped} 条非法条目`)
      }
      entries.push(...decoded.entries)
    }
    return { entries, error: errors.length > 0 ? errors.join('；') : null }
  }

  /**
   * 全量保存（按 scope 分文档；内容未变的文档不写）。
   *
   * 能力轴条目在这里被**拒绝**：丢弃 + warn + 计数。这不是策略开关，
   * 是 D4 的结构性边界——调用方即使误传也不会落盘。
   */
  async save(entries: readonly ProfileEntry[]): Promise<ProfileSaveResult> {
    const admitted = entries.filter(entry => entry.axis !== 'capability')
    const capabilitySkipped = entries.length - admitted.length
    if (capabilitySkipped > 0) {
      this.#deps.logger.warn(
        `画像：拒绝写入 ${capabilitySkipped} 条能力轴条目（D4：能力轴只在会话内存，永不落盘）`,
      )
    }

    const errors: string[] = []
    let documentsWritten = 0
    for (const scope of MEMORY_SCOPES) {
      const scoped = admitted.filter(entry => scopeOfEntry(entry) === scope)
      const store = this.#storeFor(scope)
      if (store === undefined) {
        if (scoped.length > 0) errors.push(`${scope} 库不可用：${this.#missingReason(scope)}`)
        continue
      }

      let existing: MemoryRecord | undefined
      try {
        existing = await store.get(profileDocId(scope))
      } catch (error) {
        errors.push(`${scope} 库读取失败：${messageOf(error)}`)
        continue
      }

      const text = serializeDocument(scoped)
      if (existing !== undefined && existing.text === text) continue
      if (existing === undefined && scoped.length === 0) continue

      try {
        await store.put(this.#toRecord(scope, scoped, text))
        documentsWritten += 1
      } catch (error) {
        errors.push(`${scope} 库写入失败：${messageOf(error)}`)
      }
    }

    return {
      ok: errors.length === 0,
      documentsWritten,
      capabilitySkipped,
      error: errors.length > 0 ? errors.join('；') : null,
    }
  }

  #resolveStores(): ProfileStoresPort | undefined {
    const provider = this.#deps.stores
    if (provider === undefined) return undefined
    try {
      return typeof provider === 'function' ? provider() : provider
    } catch (error) {
      this.#deps.logger.warn(`画像：解析记忆库服务失败——${messageOf(error)}`)
      return undefined
    }
  }

  #storeFor(scope: MemoryScope): ProfileStorePort | undefined {
    const stores = this.#resolveStores()
    if (stores === undefined) return undefined
    try {
      return stores.store(scope)
    } catch (error) {
      this.#deps.logger.warn(`画像：取 ${scope} 库失败——${messageOf(error)}`)
      return undefined
    }
  }

  #missingReason(scope: MemoryScope): string {
    const stores = this.#resolveStores()
    if (stores === undefined) return '内核服务 stores 不可用（omb-memory 未加载或已卸载）'
    return `${scope} 库未打开`
  }

  #toRecord(scope: MemoryScope, entries: readonly ProfileEntry[], text: string): MemoryRecord {
    const now = this.#deps.clock.now()
    return {
      id: profileDocId(scope),
      scope,
      kind: ProfileStorage.KIND_BY_SCOPE[scope],
      text,
      contentHash: fnv1a(text),
      sourceRef: profileSourceRef(scope),
      // 断言来源可核对：文档里有显式陈述就是 user，否则是模型推断。
      assertedBy: entries.some(entry => entry.provenance === 'declared') ? 'user' : 'model',
      observedAt: now,
      // 画像文档在结构上没有"失效时间"：它是一份可编辑清单，不是一个会过期的事实。
      validTo: null,
      supersededBy: null,
      lastUsedAt: now,
      useCount: 0,
      project: scope === 'project' ? this.#projectName() : null,
    }
  }

  /** 项目来源标注：显式设置优先；否则取记忆套件声明的 `projectScope`（规范化 cwd）。 */
  #projectName(): string | null {
    if (this.#project !== null) return this.#project
    const stores = this.#resolveStores()
    const projectScope = stores?.projectScope
    return typeof projectScope === 'string' && projectScope.length > 0 ? projectScope : null
  }
}
