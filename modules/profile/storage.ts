/**
 * 画像落盘：**通过 `omb-memory` 的服务读写，不自己开数据库**。
 *
 * 存储形态：每个 scope 一份**确定性 id 的 JSON 文档**
 * （`omb-profile/user`、`omb-profile/project`）。
 * 为什么是文档而不是每条目一条记录：`MemoryStore` 只有 `get`/`put`，
 * **没有枚举接口**，逐条写入后无法读回全部条目。用一份文档 + 确定性 id，
 * 只需 `get`/`put` 两个方法，不依赖任何未冻结的接口。
 *
 * 取库方式遵循 ABI（`kernel/abi/storage.ts` 的 `StoresService`）：
 * `forSession(sessionId)` / `forProject(cwd)` → `StoreSet | undefined`，**异步且可能未就绪**。
 * 本项目画像因此不假设"库一定在"：解析失败一律降级为可读原因。
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

/** 只用到 `get`/`put` 的窄端口（`MemoryStore` 的形状子集）。 */
export interface ProfileStorePort {
  put(record: MemoryRecord): Promise<void>
  get(id: string): Promise<MemoryRecord | undefined>
}

/** 一套库的窄端口（ABI `StoreSet` 的形状子集）。 */
export interface ProfileStoreSetPort {
  store(scope: MemoryScope): ProfileStorePort | undefined
  /** 项目库对应的规范化 cwd（ABI 的 `StoreSet.projectScope`）；用户库专属套件为 null。 */
  readonly projectScope?: string | null
}

/**
 * `stores` 服务的窄端口（ABI `StoresService` 的形状子集）。
 *
 * **异步**是契约的一部分：`apply` 里只能同步 provide，真正打开库是异步的，
 * 因此 `forSession`/`forProject` 可能返回 undefined——调用方必须能降级。
 */
export interface ProfileStoresServicePort {
  forSession(sessionId: string): Promise<ProfileStoreSetPort | undefined>
  forProject?(cwd: string): Promise<ProfileStoreSetPort | undefined>
}

/** 服务可以按需解析（兼容热插拔：记忆模块可能在画像之后加载，或被卸载后重载）。 */
export type ProfileStoresProvider =
  | ProfileStoresServicePort
  | (() => ProfileStoresServicePort | undefined)
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
}

export interface ProfileLoadResult {
  readonly entries: readonly ProfileEntry[]
  /** 可读的读取失败原因（异常/损坏）；正常为 null。 */
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
  /** 当前会话（由模块订阅 `turn/start` 维护）。 */
  #sessionId = ''
  /** 显式 cwd 覆盖（可选）；设置后优先于会话映射。 */
  #project: string | null = null
  /** 最近一次取库结果，供**同步**的健康面读取（取库本身是异步的）。null = 尚未解析完成。 */
  #lastResolve: ProfileAvailability | null = null

  constructor(deps: ProfileStorageDeps) {
    this.#deps = deps
  }

  /** 记下当前会话：取库走 `stores.forSession(sessionId)`。 */
  setSession(sessionId: string): void {
    this.#sessionId = sessionId
  }

  /** 显式指定项目 cwd（优先于会话映射；null = 回到按会话解析）。 */
  setProject(project: string | null): void {
    this.#project = project
  }

  /**
   * 记忆库最近一次解析结果。**同步**，原因必填。
   *
   * 解析尚未完成（异步取库在飞行中）时只做**同步探测**（服务在不在），
   * 不假装知道库是否就绪，也不用"还没有请求"这类不实描述。
   */
  availability(): ProfileAvailability {
    if (this.#lastResolve !== null) return this.#lastResolve
    return this.#resolveService() === undefined
      ? { ok: false, detail: '内核服务 stores 不可用（omb-memory 未加载或已卸载）' }
      : { ok: true, detail: '记忆库服务已就绪（首次取库尚未完成，库状态未探明）' }
  }

  /** 读取两个库里的画像文档。任何读取失败都变成可读错误。 */
  async load(): Promise<ProfileLoadResult> {
    const set = await this.#resolveSet()
    if (set === undefined) return { entries: [], error: this.#lastResolve.detail }

    const entries: ProfileEntry[] = []
    const errors: string[] = []
    for (const scope of MEMORY_SCOPES) {
      const store = this.#storeOf(set, scope)
      if (store === undefined) continue // 缺库不算读失败：由 availability() 如实说明
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

    const set = await this.#resolveSet()
    if (set === undefined) {
      return {
        ok: false,
        documentsWritten: 0,
        capabilitySkipped,
        error: this.#lastResolve.detail,
      }
    }

    const errors: string[] = []
    let documentsWritten = 0
    for (const scope of MEMORY_SCOPES) {
      const scoped = admitted.filter(entry => scopeOfEntry(entry) === scope)
      const store = this.#storeOf(set, scope)
      if (store === undefined) {
        if (scoped.length > 0) errors.push(`${scope} 库不可用：${this.#lastResolve.detail}`)
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
        await store.put(this.#toRecord(scope, scoped, text, set))
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

  #resolveService(): ProfileStoresServicePort | undefined {
    const provider = this.#deps.stores
    if (provider === undefined) return undefined
    try {
      return typeof provider === 'function' ? provider() : provider
    } catch (error) {
      this.#deps.logger.warn(`画像：解析记忆库服务失败——${messageOf(error)}`)
      return undefined
    }
  }

  /** 取库。**绝不抛**：失败写进 `#lastResolve` 并返回 undefined。 */
  async #resolveSet(): Promise<ProfileStoreSetPort | undefined> {
    const service = this.#resolveService()
    if (service === undefined) {
      this.#lastResolve = {
        ok: false,
        detail: '内核服务 stores 不可用（omb-memory 未加载或已卸载）',
      }
      return undefined
    }

    try {
      let set: ProfileStoreSetPort | undefined
      if (this.#project !== null && typeof service.forProject === 'function') {
        set = await service.forProject(this.#project)
      } else {
        // 会话未登记 cwd 时，记忆侧会降级为"仅用户库"（projectScope = null）——
        // 显式条目仍可读写，项目条目会如实报"项目库不可用"。
        set = await service.forSession(this.#sessionId)
      }
      if (set === undefined) {
        this.#lastResolve = {
          ok: false,
          detail:
            this.#project !== null
              ? `项目库打开失败或未就绪（cwd=${this.#project}）`
              : '记忆库尚未就绪（stores.forSession 返回 undefined）',
        }
        return undefined
      }
      this.#noteSet(set)
      return set
    } catch (error) {
      this.#lastResolve = { ok: false, detail: `取记忆库失败：${messageOf(error)}` }
      return undefined
    }
  }

  #noteSet(set: ProfileStoreSetPort): void {
    const missing: MemoryScope[] = []
    for (const scope of MEMORY_SCOPES) {
      if (this.#storeOf(set, scope) === undefined) missing.push(scope)
    }
    if (missing.length === 0) {
      this.#lastResolve = { ok: true, detail: `记忆库可用（${MEMORY_SCOPES.join('、')} 双库）` }
      return
    }
    this.#lastResolve = {
      ok: false,
      detail:
        `记忆库缺少 ${missing.join('、')} 库` +
        (missing.includes('project')
          ? '：宿主尚未告知该会话的 cwd（记忆侧按契约降级为仅用户库）'
          : '（该库未打开）'),
    }
  }

  #storeOf(set: ProfileStoreSetPort, scope: MemoryScope): ProfileStorePort | undefined {
    try {
      return set.store(scope)
    } catch (error) {
      this.#deps.logger.warn(`画像：取 ${scope} 库失败——${messageOf(error)}`)
      return undefined
    }
  }

  #toRecord(
    scope: MemoryScope,
    entries: readonly ProfileEntry[],
    text: string,
    set: ProfileStoreSetPort,
  ): MemoryRecord {
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
      project: scope === 'project' ? this.#projectName(set) : null,
    }
  }

  /** 项目来源标注：显式 cwd 优先；否则取套件声明的 `projectScope`。 */
  #projectName(set: ProfileStoreSetPort): string | null {
    if (this.#project !== null) return this.#project
    const projectScope = set.projectScope
    return typeof projectScope === 'string' && projectScope.length > 0 ? projectScope : null
  }
}
