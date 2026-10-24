import { OMB_VERSION } from '../../kernel/version.js'
/**
 * `omb-profile` 模块注册入口：显式条目读写 + 冲突呈现。
 *
 * 对外服务名 `profile`（供 `dsh/` 侧投影与状态面消费）；
 * 另提供 `prompt:omb-profile` 提示贡献——**只**输出未裁决冲突（R8 的呈现路径）。
 *
 * 三条不可动摇的设计（§5.8 / §4.3 R8 / D4）：
 * ① 只存显式陈述 + 用户可编辑；推断是低等级来源，不参与投票
 * ② 冲突只呈现不裁决：`conflicts()` / `renderConflicts()` 把矛盾摆出来；
 *    唯一的"推"就是冲突本身（无冲突时贡献空串，不占任何上下文）
 * ③ 能力轴默认关闭且**永不落盘**：即使 `inferCapabilityAxis: true`，
 *    观察也只进当前会话内存（`CapabilityMemory`），不产生任何存储写入。
 *    `health().detail` 如实写明当前处于哪种状态。
 *
 * ## 写入面的**事实**（S3-e）
 *
 * `declare` / `infer` / `clearDeduced` / `observeCapability` 在当前生产代码里
 * **零消费点**：全仓 grep 的命中只在 `tests/modules/profile/**`。
 * 于是"显式条目 0 条"有两种可能——**没人写过**与**没有写入口**——
 * 状态面必须把它们分开说（见 {@link PROFILE_WRITE_FACE_NOTE}），
 * 否则读者会把"服务已声明、等待消费方"读成"用户没有偏好"。
 */
import { z } from 'zod'
import type { Clock, Kernel, Logger, ModuleHealth, ModuleManifest, ModuleRegistration } from '../../kernel/abi/index.js'
import { SERVICES, derivedCapabilities, derivedRequires } from '../../kernel/abi/index.js'
import type { PromptContribution } from '../../kernel/abi/index.js'
import type { ProfileAxis, ProfileConflict, ProfileEntry, ProfileOutcome } from './entries.js'
import {
  applyEntry,
  listConflicts,
  PROFILE_AXES,
  renderConflicts as renderConflictsText,
  renderDeclared as renderDeclaredText,
} from './entries.js'
import { CAPABILITY_ENTRIES_PER_SESSION, CapabilityMemory } from './capability.js'
import type { ProfileStoresServicePort } from './storage.js'
import { ProfileStorage } from './storage.js'
import type { ClearResult } from './clear.js'
import { clearDeduced as clearDeducedFrom } from './clear.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const PROFILE_MODULE_ID = 'omb-profile'
/** 服务名取 ABI 契约里的 `SERVICES.profile`（不是本地约定）。 */
export const PROFILE_SERVICE = SERVICES.profile
/** 提示贡献服务名：`prompt:<模块 id>`（只输出未裁决冲突，见 `conflictDigest`）。 */
export const PROFILE_PROMPT_SERVICE = `prompt:${PROFILE_MODULE_ID}`
export const PROFILE_VERSION = OMB_VERSION

/** 记忆模块提供的服务名（**ABI 契约**，不是本地约定）。 */
export const MEMORY_STORES_SERVICE = SERVICES.stores

/**
 * 「写入面暂无调用方」的**固定说法**（S3-e）。
 *
 * 用词必须与事实一致：服务的**声明**是真的（`kernel.provide(PROFILE_SERVICE, …)`
 * 在 `apply` 里同步完成），缺的只是**消费方**（`declare`/`infer`/`clearDeduced`
 * 在生产代码里零调用点）。所以这句写"暂无调用方（服务已声明，等待消费方）"，
 * 不写"功能不可用"——后者会把"没接上"说成"坏了"。
 *
 * 它是**动态文案的一半**：`writeFaceNote()` 在这个基础上按实际收到的调用数
 * 切换说法（0 次 = 本条；>0 次 = 如实报请求数），因此接线之后这句话会自动消失，
 * 不会变成过期承诺。
 */
export const PROFILE_WRITE_FACE_NOTE = '写入面暂无调用方（服务已声明，等待消费方）'

export interface ProfileConfig {
  /**
   * 能力轴开关。**默认 false**；即使为 true，能力观察也只存在于会话内存
   * （`CapabilityMemory`，**没有** `sessionProjections` 投影），绝不写入任何存储（D4）。
   */
  readonly inferCapabilityAxis: boolean
}

export const PROFILE_DEFAULT_CONFIG: ProfileConfig = { inferCapabilityAxis: false }

export const profileConfigSchema = z
  .object({ inferCapabilityAxis: z.boolean().default(false) })
  .default(PROFILE_DEFAULT_CONFIG)

export interface ProfileDeclareInput {
  readonly axis: ProfileAxis
  readonly key: string
  readonly value: string
  readonly evidence?: readonly string[]
}

/**
 * 手动删除的定位键（v4.19.0）：**同轴同键**才算同一条槽位。
 *
 * 不给 `value`：删除是针对"这个槽位上的显式条目"的，不是针对某个取值——
 * 用户说"别再记住我的语气偏好"时，两条矛盾的显式声明都应该一起消失。
 */
export interface ProfileRetractInput {
  readonly axis: ProfileAxis
  readonly key: string
}

/** 可推断的轴：`capability` 被类型排除（它走 `observeCapability`，只进会话内存）。 */
export type ProfileInferAxis = Exclude<ProfileAxis, 'capability'>

export interface ProfileInferInput {
  readonly axis: ProfileInferAxis
  readonly key: string
  readonly value: string
  readonly evidence?: readonly string[]
}

export interface ProfileMutation {
  readonly ok: boolean
  /**
   * `ProfileOutcome` 是**条目消解**的结果（写入路径的词汇）；
   * `'rejected'` 与 `'retracted'` 是**手动操作面**的结果——删除没有"消解"这回事，
   * 塞进 `added/merged` 里会让回执说谎。两个词都只出现在本类型上，
   * `applyEntry` 的取值域不受影响。
   */
  readonly outcome: ProfileOutcome | 'rejected' | 'retracted'
  /** 此次操作后是否仍有未裁决冲突（有则调用方必须呈现）。 */
  readonly conflict: boolean
  readonly error: string | null
}

export interface ProfileStatus {
  readonly available: boolean
  readonly detail: string
  /** 能力轴的**实际**生效形态：关闭 / 仅会话内。 */
  readonly capabilityAxis: 'off' | 'on-session-only'
  readonly declared: number
  readonly inferred: number
  readonly conflicts: number
}

export interface ProfileService {
  /**
   * 全部条目（含互相矛盾的多条：冲突在返回值里就是"两条都在"）。
   *
   * `sessionId` 决定**项目库**那一份读哪个会话的项目；不给就只读用户库
   * （项目条目如实报"项目库不可用"）——**不挑"最近一个会话"**。
   */
  entries(sessionId?: string): Promise<readonly ProfileEntry[]>
  /** 未裁决冲突（R8：呈现用，不裁决）。 */
  conflicts(sessionId?: string): Promise<readonly ProfileConflict[]>
  /** 冲突渲染成给用户看的文本；无冲突返回空串。 */
  renderConflicts(sessionId?: string): Promise<string>
  /** 显式条目渲染（**是否注入由上下文层裁决**，这里只渲染）。 */
  renderDeclared(limit?: number, sessionId?: string): Promise<string>
  /** 用户可编辑路径：写入一条显式声明。 */
  declare(input: ProfileDeclareInput, sessionId?: string): Promise<ProfileMutation>
  /**
   * 用户可编辑路径：**删除一条显式条目**（v4.19.0，与 `declare` 对称）。
   *
   * 语义边界（三者刻意分开，不互相代替）：
   * - 只删 `provenance === 'declared'` 的条目；**`inferred` 不删**——推断型由
   *   `clearDeduced` 整体清空（`retract` 删一条推断等于"让系统悄悄忘掉一个事实"，
   *   而用户从未声明过它，无从谈起）。
   * - `capability` 轴拒绝（它永不落盘，D4）：清会话内存走 `clearDeduced`。
   * - 同轴同键的**所有**显式条目一起删（冲突的两条都消失），因为删除的单位是"槽位"。
   * - 找不到匹配 → `ok:false` + 可读 `error`（不假装删成功；调用方据此给用户回执）。
   *
   * 写后**查回验证**：重新 `load` 并确认该轴该键的显式条目已不存在；仍在则 `ok:false`。
   */
  retract(input: ProfileRetractInput, sessionId?: string): Promise<ProfileMutation>
  /** 记录一条推断（低等级来源；同键若有显式声明则进不来）。 */
  infer(input: ProfileInferInput, sessionId?: string): Promise<ProfileMutation>
  /**
   * 记录一条能力观察。**只有开关开启时才接受**，且只进会话内存。
   * @returns 是否真的记录（false = 开关关闭或参数非法）
   */
  observeCapability(sessionId: string, observation: { key: string; value: string; evidence?: readonly string[] }): boolean
  /**
   * 会话能力快照。内容未变时返回**同一引用**（重复观察不该让消费者引用抖动；
   * **当前没有任何消费者**——这是留给将来消费者的稳定契约，见 `capability.ts`）。
   */
  capability(sessionId: string): readonly ProfileEntry[]
  /** 一键清空全部**推断型**条目（含会话能力观察）；显式条目不动。 */
  clearDeduced(sessionId?: string): Promise<ClearResult>
  /** 项目名（intent 轴与推断条目的来源标注）。 */
  setProject(project: string | null): void
  status(): ProfileStatus
}

export interface ProfileRuntimeDeps {
  readonly storage: ProfileStorage
  readonly capability: CapabilityMemory
  readonly config: ProfileConfig
  readonly clock: Clock
  readonly logger: Logger
  /** 健康变化时上报（内核 `report` 绑定在模块 id 上）。 */
  readonly report?: (health: ModuleHealth) => void
}

export interface ProfileRuntime {
  readonly service: ProfileService
  readonly health: () => ModuleHealth
  /**
   * R8 的呈现路径：**只**返回未裁决冲突的文本（无冲突时为空串）。
   *
   * 为什么只有冲突会"推"：冲突是唯一必须让用户当场裁决的信息（用户自相矛盾时，
   * 静默选一个是更坏的行为）。显式偏好等其余内容一律按需拉取（§6.4）。
   * 同步返回，供宿主的易变上下文渲染函数使用（那里不能 await）。
   */
  readonly conflictDigest: () => string
  /** 卸载后一切读写降级为可读错误（不抛、也不再触碰存储）。 */
  readonly dispose: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function combineErrors(...errors: readonly (string | null)[]): string | null {
  const present = errors.filter((error): error is string => error !== null && error.length > 0)
  return present.length > 0 ? present.join('；') : null
}

/**
 * 组装画像服务。与内核解耦：测试可以直接给假 storage / 假时钟。
 * 所有方法**绝不抛异常**，失败一律走可读错误分支。
 */
export function createProfileRuntime(deps: ProfileRuntimeDeps): ProfileRuntime {
  const { storage, capability, config, clock, logger } = deps
  let disposed = false
  let declared = 0
  let inferred = 0
  let conflicts = 0
  /**
   * 能力轴的活动计数——用来把"关闭"与"没触发"分开。
   *
   * 自检报告指出：条目数为 0 时无法区分这两者，而它们的含义相反
   * （前者设计如此，后者是模块没接上调用方）。三个计数让归因永远成立。
   */
  let capabilityAttempts = 0
  let capabilityRejectedBySwitch = 0
  let capabilityRecorded = 0
  /**
   * 写入面的**实际调用计数**（`declare` / `infer` / `clearDeduced`）。
   *
   * 为什么要数：`declared = 0` 时状态面必须能回答"是没人写、还是没写入口"。
   * 全仓的生产调用点是 0（只有测试在调），但**用计数而不是硬编码结论**——
   * 一旦有真实消费者接上，文案自动变成"收到 N 次写入请求"，
   * 不会留下一句已经过期的"暂无调用方"（过期的承诺比没有承诺更坏）。
   */
  let writeFaceCalls = 0
  let declareCalls = 0
  let inferCalls = 0
  let clearCalls = 0
  /** v4.19.0：手动删除也是写面请求——不数它会让"写入面 N 次"与真实动作数对不上。 */
  let retractCalls = 0
  let lastError: string | null = null
  /**
   * 冲突文本缓存（同步可读）。R8 要求把冲突**摆出来**，而提示注入的渲染函数
   * 是同步的、存储读取是异步的——因此这里缓存最近一次的渲染结果。
   */
  let conflictText = ''

  function counts(entries: readonly ProfileEntry[]): { declared: number; inferred: number; conflicts: number } {
    let declaredCount = 0
    let inferredCount = 0
    for (const entry of entries) {
      if (entry.provenance === 'declared') declaredCount += 1
      else inferredCount += 1
    }
    return { declared: declaredCount, inferred: inferredCount, conflicts: listConflicts(entries).length }
  }

  function refresh(entries: readonly ProfileEntry[]): readonly ProfileConflict[] {
    const next = counts(entries)
    declared = next.declared
    inferred = next.inferred
    const found = listConflicts(entries)
    conflicts = found.length
    // 没有冲突时是空串：调用方据此决定不占用任何上下文（不推"可能有用"的东西）
    conflictText = renderConflictsText(found)
    return found
  }

  /**
   * 写入面的一句话（**与事实同步**）。
   *
   * 0 次调用时给 {@link PROFILE_WRITE_FACE_NOTE} 的固定说法；有调用之后
   * 换成实际请求数——`declared = 0` 的两种可能因此永远可分辨。
   */
  function writeFaceNote(): string {
    if (writeFaceCalls === 0) {
      return `${PROFILE_WRITE_FACE_NOTE}：declare/infer/clearDeduced 自本模块启动以来收到 0 次请求`
        + '——"0 条"不等于"用户没有偏好"，是**没有写入口**（observeCapability 另有自己的计数）'
    }
    return `写入面：自本模块启动以来收到 ${writeFaceCalls} 次写入请求`
      + `（declare ${declareCalls} / infer ${inferCalls} / clearDeduced ${clearCalls} / retract ${retractCalls}）`
  }

  /**
   * 能力轴的会话表口径（**有 LRU 上界**，见 `CAPABILITY_SESSION_MAX`）。
   *
   * 两个数含义不同、不合并：当前表里有几个会话 vs 已被淘汰几个会话。
   */
  function capabilityScope(): string {
    const sessions = capability.sessionCount()
    const evicted = capability.evictedSessions()
    return `能力观察会话表 ${sessions}/${capability.sessionMax()} 个会话（LRU 上界，每会话最多 ${CAPABILITY_ENTRIES_PER_SESSION} 条）`
      + (evicted > 0 ? `，已淘汰 ${evicted} 个更早的会话` : '')
  }

  function health(): ModuleHealth {
    const availability = storage.availability()
    /**
     * 能力轴的三个事实，**分开报**。
     *
     * 自检报告指出：「条目数为 0，无法区分『关闭』与『没触发』」——完全正确。
     * 原来的文案只说开关状态，于是"轴开着但一次都没被调用"与"轴关着"在状态面
     * 长得一模一样，两者对使用者的含义却相反（前者是模块没接上调用方，
     * 后者是设计如此）。
     *
     * 所以报三件事：开关状态、**被开关拦掉的次数**、**成功记录的次数**。
     * 有了后两个，`0 条目` 就永远能归因。
     */
    const capabilityState = config.inferCapabilityAxis
      ? '能力轴已开启：观察只存在于当前会话内存（**没有** sessionProjections 投影），不写任何存储（D4）'
      : '能力轴关闭（默认，D4）：不产生任何能力相关条目'
    const capabilityTraffic = capabilityAttempts === 0
      ? '能力观察：从未收到过调用（0 次请求）——这是"没触发"，不是"被关闭"'
      : `能力观察：收到 ${capabilityAttempts} 次请求，其中被开关拦掉 ${capabilityRejectedBySwitch} 次、成功记录 ${capabilityRecorded} 次`
    const metrics: Record<string, number> = {
      declared,
      inferred,
      conflicts,
      capabilitySessionEntries: capability.entryCount(),
      capabilitySessions: capability.sessionCount(),
      capabilitySessionsEvicted: capability.evictedSessions(),
      capabilityAttempts,
      capabilityRejectedBySwitch,
      capabilityRecorded,
      // 写入面的请求数（0 = 真的没有调用方，见 writeFaceNote）
      writeFaceCalls,
    }
    // 三个分支都带上写入面与能力表口径：**0 条永远可归因**，
    // 不允许出现"数字是 0，但没人知道为什么"的状态面。
    const suffix = `${capabilityState}；${capabilityTraffic}；${capabilityScope()}；${writeFaceNote()}`
    if (!availability.ok) {
      return {
        state: 'degraded',
        detail: `显式条目读写不可用——${availability.detail}；${suffix}`,
        metrics,
      }
    }
    if (lastError !== null) {
      return { state: 'degraded', detail: `最近一次画像操作失败：${lastError}；${suffix}`, metrics }
    }
    return {
      state: 'ok',
      detail: `显式条目 ${declared} 条、推断条目 ${inferred} 条、未裁决冲突 ${conflicts} 组；${suffix}`,
      metrics,
    }
  }

  function report(): void {
    try {
      deps.report?.(health())
    } catch (error) {
      logger.warn(`画像：健康上报失败（已忽略）——${messageOf(error)}`)
    }
  }

  async function mutate(entry: ProfileEntry, sessionId?: string): Promise<ProfileMutation> {
    if (disposed) {
      return { ok: false, outcome: 'rejected', conflict: false, error: '画像模块已卸载' }
    }
    const loaded = await storage.load(sessionId)
    const resolution = applyEntry(entry, loaded.entries)
    const found = refresh(resolution.entries)

    // 等级边界：推断进不来不是错误，但必须如实报告（不静默）。
    if (resolution.outcome === 'inferred-blocked-by-declared') {
      lastError = loaded.error
      report()
      return { ok: loaded.error === null, outcome: resolution.outcome, conflict: found.length > 0, error: loaded.error }
    }

    const saved = await storage.save(resolution.entries, sessionId)
    lastError = combineErrors(loaded.error, saved.error)
    report()
    return {
      ok: saved.ok && loaded.error === null,
      outcome: resolution.outcome,
      conflict: found.length > 0,
      error: lastError,
    }
  }

  async function loadEntries(sessionId?: string): Promise<readonly ProfileEntry[]> {
    if (disposed) return []
    const loaded = await storage.load(sessionId)
    lastError = loaded.error
    refresh(loaded.entries)
    return loaded.entries
  }

  const service: ProfileService = {
    entries: sessionId => loadEntries(sessionId),

    async conflicts(sessionId?: string) {
      return listConflicts(await loadEntries(sessionId))
    },

    async renderConflicts(sessionId?: string) {
      return renderConflictsText(listConflicts(await loadEntries(sessionId)))
    },

    async renderDeclared(limit = 5, sessionId?: string) {
      return renderDeclaredText(await loadEntries(sessionId), limit)
    },

    declare(input, sessionId?: string) {
      writeFaceCalls += 1
      declareCalls += 1
      // 能力轴**永不落盘**（D4）：这里必须拒绝，否则调用方会以为"声明成功"而实际什么都没写。
      if ((input.axis as string) === 'capability') {
        return Promise.resolve({
          ok: false,
          outcome: 'rejected' as const,
          conflict: false,
          error: '能力轴不接受落盘声明（D4）：请用 observeCapability 记入会话内存',
        })
      }
      return mutate({
        axis: input.axis,
        key: input.key,
        value: input.value,
        provenance: 'declared',
        evidence: input.evidence ?? [],
        updated: clock.now(),
      }, sessionId)
    },

    async retract(input, sessionId?: string) {
      writeFaceCalls += 1
      retractCalls += 1
      const rejected = (error: string, conflict = false): ProfileMutation =>
        ({ ok: false, outcome: 'rejected' as const, conflict, error })
      if (disposed) return rejected('画像模块已卸载')
      // 能力轴**永不落盘**（D4）：没有存储条目可删；清会话内存走 clearDeduced。
      if ((input.axis as string) === 'capability') {
        return rejected('能力轴不接受落盘条目（D4）：它只在会话内存里，请用 clearDeduced 清空')
      }
      // 运行期兜底：类型层已限定，但调用方可能绕过类型（与 declare/infer 同一条口径）。
      if (!PROFILE_AXES.includes(input.axis)) {
        return rejected(`未知画像轴：${String(input.axis)}（可用：${PROFILE_AXES.join(' / ')}）`)
      }
      const key = input.key.trim()
      if (key.length === 0) {
        return rejected('key 不能为空：(轴 + 键) 才能定位一条显式条目')
      }

      const loaded = await storage.load(sessionId)
      if (loaded.error !== null) {
        lastError = loaded.error
        report()
        return rejected(loaded.error)
      }
      /** 删除单位是"槽位"：同轴同键的**所有**显式条目一起删（冲突的两条都消失）。 */
      const matches = (entry: ProfileEntry): boolean =>
        entry.axis === input.axis && entry.key.trim() === key && entry.provenance === 'declared'
      const remaining = loaded.entries.filter(entry => !matches(entry))
      if (remaining.length === loaded.entries.length) {
        // 明确语义：找不到 → ok:false + 可读原因（**不假装删成功**）。
        // 推断条目在同一槽位时，错误里点名 clearDeduced，避免调用方反复重试。
        const current = refresh(loaded.entries)
        lastError = null
        report()
        return rejected(
          `没有匹配的显式条目：${input.axis}/${key}（推断条目不走 retract，请用 clearDeduced）`,
          current.length > 0,
        )
      }

      const saved = await storage.save(remaining, sessionId)
      if (!saved.ok) {
        lastError = saved.error ?? '画像写入失败'
        report()
        return rejected(lastError)
      }
      // 写后**查回验证**：存储层"内容未变则不写"，写错过滤器也会静默 ok；
      // 只有重新 load 并确认该轴该键的显式条目已不存在，才能回 ok。
      const readBack = await storage.load(sessionId)
      const stillPresent = readBack.entries.some(matches)
      const failure = combineErrors(
        readBack.error,
        stillPresent ? `写入后仍存在：${input.axis}/${key}` : null,
      )
      const found = refresh(readBack.entries)
      lastError = failure
      report()
      if (failure !== null) return rejected(failure, found.length > 0)
      return { ok: true, outcome: 'retracted' as const, conflict: found.length > 0, error: null }
    },

    infer(input, sessionId?: string) {
      writeFaceCalls += 1
      inferCalls += 1      // 类型层已排除 capability，但运行期调用方可能绕过类型——这里是结构性兜底。
      if ((input.axis as string) === 'capability') {
        return Promise.resolve({
          ok: false,
          outcome: 'rejected' as const,
          conflict: false,
          error: '能力轴不接受推断落盘（D4）：请用 observeCapability 记入会话内存',
        })
      }
      return mutate({
        axis: input.axis,
        key: input.key,
        value: input.value,
        provenance: 'inferred',
        evidence: input.evidence ?? [],
        updated: clock.now(),
      }, sessionId)
    },

    observeCapability(sessionId, observation) {
      if (disposed) return false
      // 先记账**再**判断：只有把"被开关拦掉"与"根本没触发"分开，
      // 状态面才能回答"能力轴为什么是 0 条"（见 capabilityCounters 的说明）。
      capabilityAttempts += 1
      // 开关关闭 → 不产生任何观察。开启 → 只进内存，**没有任何存储调用**（D4）。
      if (!config.inferCapabilityAxis) {
        capabilityRejectedBySwitch += 1
        return false
      }
      if (sessionId.length === 0 || observation.key.trim().length === 0) return false
      const before = capability.list(sessionId).length
      capability.observe(sessionId, observation)
      if (capability.list(sessionId).length > before) capabilityRecorded += 1
      report()
      return true
    },

    capability: sessionId => capability.list(sessionId),

    async clearDeduced(sessionId?: string): Promise<ClearResult> {
      writeFaceCalls += 1
      clearCalls += 1
      if (disposed) return { ok: false, removed: 0, error: '画像模块已卸载' }
      const capabilityRemoved = capability.entryCount()
      capability.clearAll()
      // 会话显式给出时按该会话的项目库清；没给就只清用户库（不挑"最近一个会话"）
      const target =
        sessionId === undefined
          ? storage
          : {
              load: () => storage.load(sessionId),
              save: (entries: readonly ProfileEntry[]) => storage.save(entries, sessionId),
            }
      const result = await clearDeducedFrom(target)
      refresh((await storage.load(sessionId)).entries)
      if (result.ok) lastError = null
      else lastError = result.error
      report()
      return { ok: result.ok, removed: result.removed + capabilityRemoved, error: result.error }
    },

    setProject(project) {
      storage.setProject(project)
    },

    status() {
      const availability = storage.availability()
      return {
        available: availability.ok,
        // 存储可用性 + 写入面事实：`available: true` 只说明"库能读能写"，
        // 不说明"有人在写"——两件事必须分开说（见 PROFILE_WRITE_FACE_NOTE）。
        detail: `${availability.detail}；${writeFaceNote()}`,
        capabilityAxis: config.inferCapabilityAxis ? 'on-session-only' : 'off',
        declared,
        inferred,
        conflicts,
      }
    },
  }

  return {
    service,
    health,
    conflictDigest: () => (disposed ? '' : conflictText),
    dispose: () => {
      disposed = true
      capability.clearAll()
      conflictText = ''
    },
  }
}

/** 模块注册。`requires` 只有 `omb-memory`——画像的一切落盘都经它的服务。 */
export function createProfileModule(): ModuleRegistration<ProfileConfig> {
  let runtime: ProfileRuntime | undefined
  let config: ProfileConfig = PROFILE_DEFAULT_CONFIG

  /** 同步健康函数：既能进清单，也能直接 `report`（清单的 health 允许返回 Promise）。 */
  const health = (): ModuleHealth => {
    if (runtime === undefined) {
      const capabilityState = config.inferCapabilityAxis
        ? '能力轴已开启：只进会话内存、不落盘（D4）'
        : '能力轴关闭（默认，D4）'
      return { state: 'ok', detail: `模块未启动（内核未 apply），暂无可读画像；${capabilityState}` }
    }
    return runtime.health()
  }

  const manifest: ModuleManifest<ProfileConfig> = {
    id: PROFILE_MODULE_ID,
    version: PROFILE_VERSION,
    requires: derivedRequires(PROFILE_MODULE_ID),
    capabilities: derivedCapabilities(PROFILE_MODULE_ID),
    configSchema: profileConfigSchema,
    health,
  }

  return {
    manifest,
    apply(kernel: Kernel, parsed: ProfileConfig) {
      config = parsed
      const storage = new ProfileStorage({
        // 按需解析，兼容热插拔：记忆模块可以先于/后于画像加载。
        stores: () => kernel.service<ProfileStoresServicePort>(MEMORY_STORES_SERVICE),
        clock: kernel.clock,
        logger: kernel.logger,
      })
      const capability = new CapabilityMemory({ clock: kernel.clock })
      const created = createProfileRuntime({
        storage,
        capability,
        config: parsed,
        clock: kernel.clock,
        logger: kernel.logger,
        report: next => kernel.report(next),
      })
      runtime = created

      const unprovide = kernel.provide(PROFILE_SERVICE, created.service)
      /**
       * R8 呈现（`prompt:omb-profile`，走宿主的**易变**上下文槽）：
       * 只在存在未裁决冲突时输出文本，其余时候是空串——不推"可能有用"的东西。
       * 不设 `resident`：常驻前缀必须逐字节稳定且 ≤120 字符，冲突是易变信息。
       */
      const unprovidePrompt = kernel.provide<PromptContribution>(PROFILE_PROMPT_SERVICE, {
        context: () => created.conflictDigest(),
      })
      // **不再订阅 `turn/start` 记"当前会话"**：那是"最近一个会话"，交错时会读错/写错
      // 项目库。会话只从**本次操作**的调用方来（`entries(sessionId)` / `declare(input, sessionId)`）。
      // 预热缓存：只填内部状态，不注册任何东西（H-2 允许异步填状态）
      void created.service.entries()
      kernel.report(created.health())

      return () => {
        // 热插拔：dispose 绝不抛异常（宿主 reconcileProfilePatches 会 await 旧 fiber）
        try {
          unprovidePrompt()
        } catch (error) {
          kernel.logger.warn(`画像：注销提示贡献失败（已隔离）——${messageOf(error)}`)
        }
        try {
          unprovide()
        } catch (error) {
          kernel.logger.warn(`画像：注销服务失败（已隔离）——${messageOf(error)}`)
        }
        // 能力观察只存在于内存：卸载即消失，不需要（也不能）清任何存储。
        created.dispose()
        runtime = undefined
      }
    },
  }
}

export const profileModule = createProfileModule()

/** 供 `dsh/` 侧直接引用的注册对象。 */
export default toHostPlugin(profileModule)

