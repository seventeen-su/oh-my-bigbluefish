/**
 * `omb-artifact` 模块注册入口。
 *
 * 文件名用 `module.ts` 而不是 `index.ts`：`index.ts` 是索引**逻辑**，
 * 两者混在一个名字下会让"逻辑"与"装配"分不清。
 *
 * 模块只做三件事：
 * ① 建内存索引（**不注入清单**）
 * ② 订阅 `evidence/observed`（**不臆造路径**：载荷没有路径时索引不变）
 * ③ 把服务与 `omb_files` 工具声明出去，由 `dsh/` 侧注册到宿主
 */
import { z } from 'zod'
import { SERVICES, derivedCapabilities, derivedRequires, toolsServiceFor } from '../../kernel/abi/index.js'
import type { Clock, Kernel, ModuleHealth, ModuleManifest, ModuleRegistration, StatusRegistry } from '../../kernel/abi/index.js'
import type { ToolDefinition } from '../../kernel/abi/index.js'
import type { ArtifactEntry, ArtifactKind, ArtifactPrivacyPort } from './index.js'
import { ARTIFACT_DEFAULT_MAX, ARTIFACT_TOP_MAX, ArtifactIndex } from './index.js'
import { createFilesTool } from './tools.js'
import { toHostPlugin } from '../../kernel/hostEntry.js'

export const ARTIFACT_MODULE_ID = 'omb-artifact'
/** 服务名取 ABI 契约（不是本地约定）。 */
export const ARTIFACT_SERVICE = SERVICES.artifact
/**
 * 工具声明服务名：`tools:<模块 id>`（ABI `SERVICES.toolsPrefix` + `toolsServiceFor`）。
 * 模块**不自己注册宿主工具**——只声明，由 `dsh/` 侧在正确的生命周期里注册（ABI host.ts）。
 */
export const ARTIFACT_TOOLS_SERVICE = toolsServiceFor(ARTIFACT_MODULE_ID)
export const ARTIFACT_VERSION = '3.3.0'

export interface ArtifactConfig {
  /** 索引簿记上限（不是上下文预算）。 */
  readonly maxEntries: number
}

export const ARTIFACT_DEFAULT_CONFIG: ArtifactConfig = { maxEntries: ARTIFACT_DEFAULT_MAX }

export const artifactConfigSchema = z
  .object({ maxEntries: z.number().int().positive().default(ARTIFACT_DEFAULT_MAX) })
  .default(ARTIFACT_DEFAULT_CONFIG)

export interface ArtifactRecordOptions {
  readonly kind?: ArtifactKind
  readonly contentHash?: string
}

export interface ArtifactService {
  /**
   * **唯一入口**：记录一条制品路径（同路径 upsert，不产生重复条目）。
   *
   * 由 `dsh/hooks.ts` 从宿主会话事件（`tool/call` 参数）提取路径后调用；
   * 模块自身**不从 `evidence/observed` 推导**（该载荷没有路径，Lead 已裁决不扩展 ABI）。
   *
   * @param sessionId 写入的会话归属（能拿到就传；拿不到＝归属未知，隐私侧按最严处理）
   * @returns 写入的条目；路径为空时返回 undefined（不臆造条目）
   * @throws 隐私模式禁止写入时抛**可读**错误（`dsh/hooks.ts` 逐条隔离，不影响其余）
   */
  record(path: string, options?: ArtifactRecordOptions, sessionId?: string): ArtifactEntry | undefined
  /**
   * 按需查询：最多 3 条，不含内容。
   * @param sessionId 本次读取的会话归属；判定在索引这一层（数据边界）
   */
  topFor(query?: string, limit?: number, sessionId?: string): readonly ArtifactEntry[]
  /**
   * 全量快照（状态面/审计用，不用于注入）——**返回路径清单，因此同样过读判定**。
   * 状态面只读 `size()`/`status()`（计数），所以 sealed 下它不会把路径泄给模型。
   */
  list(sessionId?: string): readonly ArtifactEntry[]
  size(): number
  clear(): void
  status(): { readonly available: boolean; readonly detail: string }
}

export interface ArtifactRuntimeDeps {
  readonly index: ArtifactIndex
  /** 时钟由内核注入（模块不直接读 Date.now）。 */
  readonly clock: Clock
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createArtifactService(deps: ArtifactRuntimeDeps): ArtifactService {
  const { index, clock } = deps
  return {
    // 会话归属一路透传到索引：判定只在数据边界做一次（服务本身不做判定，
    // 因此不存在"服务与工具判定不一致"的分叉）。
    record: (path, options, sessionId) =>
      index.record({ path, kind: options?.kind, contentHash: options?.contentHash, at: clock.now() }, sessionId),
    topFor: (query, limit, sessionId) => index.topFor(query, limit, sessionId),
    list: sessionId => index.list(sessionId),
    size: () => index.size(),
    clear: () => index.clear(),
    status: () => ({
      available: true,
      detail: `内存索引 ${index.size()}/${index.maxEntries()} 条；**不注入清单**（无提示段贡献），只有 omb_files 按需拉取，单次最多 ${ARTIFACT_TOP_MAX} 条且不含内容`,
    }),
  }
}

export function createArtifactModule(): ModuleRegistration<ArtifactConfig> {
  let runtime: { index: ArtifactIndex; service: ArtifactService } | undefined

  /** 同步健康函数：既能进清单，也能直接 `report`（清单的 health 允许返回 Promise）。 */
  const health = (): ModuleHealth => {
    if (runtime === undefined) {
      return { state: 'ok', detail: `模块未启动（内核未 apply）：暂无制品索引；不注入任何清单` }
    }
    const { index } = runtime
    return {
      state: 'ok',
      detail: `制品索引 ${index.size()}/${index.maxEntries()} 条（仅内存，**不注入上下文**；内容由读取类工具按需取）`,
      metrics: { indexed: index.size(), maxEntries: index.maxEntries(), topLimit: ARTIFACT_TOP_MAX },
    }
  }

  const manifest: ModuleManifest<ArtifactConfig> = {
    id: ARTIFACT_MODULE_ID,
    version: ARTIFACT_VERSION,
    requires: derivedRequires(ARTIFACT_MODULE_ID),
    capabilities: derivedCapabilities(ARTIFACT_MODULE_ID),
    configSchema: artifactConfigSchema,
    health,
  }

  return {
    manifest,
    apply(kernel: Kernel, config: ArtifactConfig) {
      const index = new ArtifactIndex({
        maxEntries: config.maxEntries,
        logger: kernel.logger,
        // **隐私闸门的注入处**（惰性解析：`omb-privacy` 可能后于本模块挂载）。
        // 判定发生在索引这一层（数据边界），因此工具与服务两个入口都逃不掉。
        privacy: () => kernel.service<ArtifactPrivacyPort>(SERVICES.privacy),
      })
      const service = createArtifactService({ index, clock: kernel.clock })
      const tools: readonly ToolDefinition[] = [createFilesTool({ index })]
      runtime = { index, service }

      const unprovideService = kernel.provide(ARTIFACT_SERVICE, service)
      const unprovideTools = kernel.provide(ARTIFACT_TOOLS_SERVICE, tools)
      // 不订阅 evidence/observed：该事件是"动作与证据的指纹"，载荷没有路径，
      // 从它推导路径只能靠猜。路径由 dsh/hooks.ts 提取后经 service.record(path) 喂入。
      kernel.report(health())

      /**
       * **状态段 + 渲染前自报**：让模块行不再停在启动那一刻。
       *
       * ## 实测过的症状
       *
       * 同一次 `omb_status` 输出里：
       *
       * ```
       * 模块行    omb-artifact：正常——制品索引 0/500 条
       * 组件自述  已索引 2 条
       * ```
       *
       * ## 根因：**快照 vs 实时**
       *
       * 模块行的文字来自内核健康面保存的**上报快照**（`kernel/health.ts:12-37`），
       * 而这里原来只在 `apply` 时报一次（那时索引还空着）；组件自述与 `omb_files`
       * 读的是实时索引。两者必然分叉。
       *
       * **这一类为什么危险**：同一次输出里，一个"正常"的模块行配一个说"0 条"的
       * 组件自述（或反过来：模块行说"宿主未安装"、组件自述说"已接上"），
       * 读者无法判断该信哪个。`omb_status` 是**唯一的模型可见诊断入口**，
       * 两个面互相矛盾会让整个状态面一起失去可信度——改文案只能掩盖，不能消除。
       *
       * ## 修法：自报 + **渲染顺序**，两件事缺一不可
       *
       * ① 这里登记一个状态段，并在 `render` 的**第一句**自报一次健康：
       *    `omb_status` **不会调用模块的 health 函数**，它只渲染已登记的「组件自述」段
       *    （`dsh/status-tool.ts` 的 `registry.list()`），所以 `render` 是模块唯一能
       *    刷新自己那一行的地方。
       * ② `dsh/status-tool.ts` 在取健康面快照**之前**先把全部贡献者渲染一遍
       *    （见那里的"组件自述：必须先渲染"）。少了②，刷新发生在模块行已经印好之后：
       *    亮的是下一个面、旧的是上一个面——**实测复发的那一次**（同一条注释早先
       *    写过"结构上不可能再分叉"，那句判断当时是错的，因为它假设了调用顺序）。
       *
       * 因此本段必须保持"**先自报、后读实时**"的顺序。它也顺带解决了可观测性：
       * 制品索引原先**没有任何**状态面出口（索引条目数只在冻死的模块行里出现），
       * 索引有没有在工作只能靠调 `omb_files` 猜。
       */
      let statusUnregister: (() => void) | undefined
      try {
        const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
        statusUnregister = registry?.register({
          name: '制品索引（omb-artifact）',
          render: (): string => {
            try {
              // 第一句：把这一行刷新到"现在"（顺序不能挪，见上面②）
              kernel.report(health())
            } catch {
              // 自报失败不得影响状态面渲染
            }
            const size = index.size()
            return size === 0
              ? '制品索引为空（本会话还没有观察到任何制品；制品路径由工具调用参数提取）'
              : `已索引 ${String(size)} 条；最近见 omb_files，内容请用读取类工具按需取`
          },
        })
      } catch {
        // 状态面登记失败不得影响索引可用性（对齐 notify 的处理）
      }

      return () => {
        // 热插拔：每个注销步骤单独隔离，dispose 绝不抛异常。
        try {
          unprovideTools()
        } catch (error) {
          kernel.logger.warn(`制品：注销工具声明失败（已隔离）——${messageOf(error)}`)
        }
        try {
          unprovideService()
        } catch (error) {
          kernel.logger.warn(`制品：注销服务失败（已隔离）——${messageOf(error)}`)
        }
        /**
         * **状态段也要注销**，否则热插拔会留下一个指向已 dispose 实例的悬空段落
         * （它闭包捕获了 `index`，而下一行就把索引清空了）。
         * 这条是 lint 抓出来的：`statusUnregister` 被赋值却从未使用——
         * 那正是"注册了但忘了注销"的形态。
         */
        try {
          statusUnregister?.()
        } catch (error) {
          kernel.logger.warn(`制品：注销状态段失败（已隔离）——${messageOf(error)}`)
        }
        index.clear()
        runtime = undefined
      }
    },
  }
}

export const artifactModule = createArtifactModule()

export default toHostPlugin(artifactModule)
