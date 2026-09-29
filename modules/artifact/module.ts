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
import type { Clock, Kernel, ModuleHealth, ModuleManifest, ModuleRegistration } from '../../kernel/abi/index.js'
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
export const ARTIFACT_VERSION = '3.1.0'

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
        index.clear()
        runtime = undefined
      }
    },
  }
}

export const artifactModule = createArtifactModule()

export default toHostPlugin(artifactModule)
