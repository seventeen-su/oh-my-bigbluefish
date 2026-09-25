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
 */
import { z } from 'zod'
import type { Clock, Kernel, Logger, ModuleHealth, ModuleManifest, ModuleRegistration } from '../../kernel/abi/index.js'
import { SERVICES } from '../../kernel/abi/index.js'
import type { PromptContribution } from '../../kernel/abi/index.js'
import type { ProfileAxis, ProfileConflict, ProfileEntry, ProfileOutcome } from './entries.js'
import {
  applyEntry,
  listConflicts,
  renderConflicts as renderConflictsText,
  renderDeclared as renderDeclaredText,
} from './entries.js'
import { CapabilityMemory } from './capability.js'
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
export const PROFILE_VERSION = '3.0.0'

/** 记忆模块提供的服务名（**ABI 契约**，不是本地约定）。 */
export const MEMORY_STORES_SERVICE = SERVICES.stores

export interface ProfileConfig {
  /**
   * 能力轴开关。**默认 false**；即使为 true，能力观察也只存在于会话内存与
   * `sessionProjections`，绝不写入任何存储（D4）。
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
  readonly outcome: ProfileOutcome | 'rejected'
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
  /** 全部条目（含互相矛盾的多条：冲突在返回值里就是"两条都在"）。 */
  entries(): Promise<readonly ProfileEntry[]>
  /** 未裁决冲突（R8：呈现用，不裁决）。 */
  conflicts(): Promise<readonly ProfileConflict[]>
  /** 冲突渲染成给用户看的文本；无冲突返回空串。 */
  renderConflicts(): Promise<string>
  /** 显式条目渲染（**是否注入由上下文层裁决**，这里只渲染）。 */
  renderDeclared(limit?: number): Promise<string>
  /** 用户可编辑路径：写入一条显式声明。 */
  declare(input: ProfileDeclareInput): Promise<ProfileMutation>
  /** 记录一条推断（低等级来源；同键若有显式声明则进不来）。 */
  infer(input: ProfileInferInput): Promise<ProfileMutation>
  /**
   * 记录一条能力观察。**只有开关开启时才接受**，且只进会话内存。
   * @returns 是否真的记录（false = 开关关闭或参数非法）
   */
  observeCapability(sessionId: string, observation: { key: string; value: string; evidence?: readonly string[] }): boolean
  /** 会话能力快照（内容未变时返回同一引用，供 sessionProjections 使用）。 */
  capability(sessionId: string): readonly ProfileEntry[]
  /** 一键清空全部**推断型**条目（含会话能力观察）；显式条目不动。 */
  clearDeduced(): Promise<ClearResult>
  /** 项目名（intent 轴与推断条目的来源标注）。 */
  setProject(project: string | null): void
  /** 当前会话 id（正常由模块订阅 `turn/start` 自动维护；这里供 dsh 侧显式指定）。 */
  setSession(sessionId: string): void
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

  function health(): ModuleHealth {
    const availability = storage.availability()
    const capabilityState = config.inferCapabilityAxis
      ? '能力轴已开启：观察只存在于当前会话内存与 sessionProjections，不写任何存储（D4）'
      : '能力轴关闭（默认，D4）：不产生任何能力相关条目'
    const metrics: Record<string, number> = {
      declared,
      inferred,
      conflicts,
      capabilitySessionEntries: capability.entryCount(),
    }
    if (!availability.ok) {
      return {
        state: 'degraded',
        detail: `显式条目读写不可用——${availability.detail}；${capabilityState}`,
        metrics,
      }
    }
    if (lastError !== null) {
      return { state: 'degraded', detail: `最近一次画像操作失败：${lastError}；${capabilityState}`, metrics }
    }
    return {
      state: 'ok',
      detail: `显式条目 ${declared} 条、推断条目 ${inferred} 条、未裁决冲突 ${conflicts} 组；${capabilityState}`,
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

  async function mutate(entry: ProfileEntry): Promise<ProfileMutation> {
    if (disposed) {
      return { ok: false, outcome: 'rejected', conflict: false, error: '画像模块已卸载' }
    }
    const loaded = await storage.load()
    const resolution = applyEntry(entry, loaded.entries)
    const found = refresh(resolution.entries)

    // 等级边界：推断进不来不是错误，但必须如实报告（不静默）。
    if (resolution.outcome === 'inferred-blocked-by-declared') {
      lastError = loaded.error
      report()
      return { ok: loaded.error === null, outcome: resolution.outcome, conflict: found.length > 0, error: loaded.error }
    }

    const saved = await storage.save(resolution.entries)
    lastError = combineErrors(loaded.error, saved.error)
    report()
    return {
      ok: saved.ok && loaded.error === null,
      outcome: resolution.outcome,
      conflict: found.length > 0,
      error: lastError,
    }
  }

  async function loadEntries(): Promise<readonly ProfileEntry[]> {
    if (disposed) return []
    const loaded = await storage.load()
    lastError = loaded.error
    refresh(loaded.entries)
    return loaded.entries
  }

  const service: ProfileService = {
    entries: () => loadEntries(),

    async conflicts() {
      return listConflicts(await loadEntries())
    },

    async renderConflicts() {
      return renderConflictsText(listConflicts(await loadEntries()))
    },

    async renderDeclared(limit = 5) {
      return renderDeclaredText(await loadEntries(), limit)
    },

    declare(input) {
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
      })
    },

    infer(input) {
      // 类型层已排除 capability，但运行期调用方可能绕过类型——这里是结构性兜底。
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
      })
    },

    observeCapability(sessionId, observation) {
      if (disposed) return false
      // 开关关闭 → 不产生任何观察。开启 → 只进内存，**没有任何存储调用**（D4）。
      if (!config.inferCapabilityAxis) return false
      if (sessionId.length === 0 || observation.key.trim().length === 0) return false
      capability.observe(sessionId, observation)
      report()
      return true
    },

    capability: sessionId => capability.list(sessionId),

    async clearDeduced(): Promise<ClearResult> {
      if (disposed) return { ok: false, removed: 0, error: '画像模块已卸载' }
      const capabilityRemoved = capability.entryCount()
      capability.clearAll()
      const result = await clearDeducedFrom(storage)
      refresh((await storage.load()).entries)
      if (result.ok) lastError = null
      else lastError = result.error
      report()
      return { ok: result.ok, removed: result.removed + capabilityRemoved, error: result.error }
    },

    setProject(project) {
      storage.setProject(project)
    },

    setSession(sessionId) {
      storage.setSession(sessionId)
    },

    status() {
      const availability = storage.availability()
      return {
        available: availability.ok,
        detail: availability.detail,
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
    requires: ['omb-memory'],
    capabilities: ['profile.declared'],
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
      // 会话 id 来自内核事件（dsh 侧把宿主会话事件转成 `turn/start`），
      // 因此画像不需要 dsh 额外接线就能定位"哪个项目的库"。
      const unsubscribe = kernel.on('turn/start', payload => {
        storage.setSession(payload.sessionId)
      })
      // 预热缓存：只填内部状态，不注册任何东西（H-2 允许异步填状态）
      void created.service.entries()
      kernel.report(created.health())

      return () => {
        // 热插拔：dispose 绝不抛异常（宿主 reconcileProfilePatches 会 await 旧 fiber）
        try {
          unsubscribe()
        } catch (error) {
          kernel.logger.warn(`画像：注销事件订阅失败（已隔离）——${messageOf(error)}`)
        }
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
