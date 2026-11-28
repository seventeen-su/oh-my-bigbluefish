/**
 * 项目身份接线（组合根）：解析一次 + 缓存 + 登记身份注册表。
 *
 * 为什么在组合根：
 * - 解析器必须同时服务工具上下文、pre-step 与 `session/event` 捕获，三者只能是
 *   同一个实例，否则每个调用点各跑一遍 git（旧 `resolveProjectKey` 就这么散）；
 * - 登记需要 Store（适配器），不能塞进 domain/app。
 *
 * 身份语义在 `packages/v7/src/adapters/git/identity.ts`；旧 projectKey 的兼容匹配
 * 在 `adapters/postgres/project-key-sql.ts`。这里只负责「谁在什么时候登记、失败怎么退化」。
 */
import type { ProjectIdentity } from '../../packages/v7/src/domain/project-identity.js'
import type { ToolContext } from '../../packages/v7/src/adapters/dsh/host.js'
import { projectIdentityResolver } from '../../packages/v7/src/adapters/git/identity.js'
import { resolveToolContext } from '../../packages/v7/src/adapters/dsh/tools.js'
import type { Logger } from '../../packages/v7/src/ports/jobs.js'
import { messageOf, withTimeout } from './messages.js'

/**
 * 首次登记的最长等待：注册表只是“旧数据兼容”的辅助设施，不能让数据库抖动阻塞
 * pre-step（T0/T1 自己的预算是 1.5s）。正常插入是毫秒级；超时/失败都继续召回，
 * 下一次解析同一身份再等一次（内存里按身份去重，成功后才记已登记）。
 */
const REGISTRATION_WAIT_MS = 1_000

/** 只依赖登记能力，不把整个 Store 契约拖进接线层（便于单测/旧 fake）。 */
interface IdentityStore {
  readonly recordProjectIdentity?: (identity: ProjectIdentity) => Promise<void>
}

export interface IdentityWiringDeps {
  readonly store: IdentityStore
  readonly logger: Logger
}

export interface IdentityWiring {
  /** 工具执行 / pre-step 的运行时上下文（`projectKey` = projectId）。 */
  resolveContext(exec: unknown): Promise<ToolContext | undefined>
  /** 事件捕获只需要身份本身（写 artifact.metadata）。 */
  resolveIdentity(cwd: string, sessionId: string): Promise<ProjectIdentity | undefined>
}

function identityKeyOf(identity: ProjectIdentity): string {
  return [
    identity.workspaceId,
    identity.projectId,
    identity.repositoryId ?? '',
    identity.branchId ?? '',
    identity.legacyProjectKeys.join('|'),
  ].join('\u0000')
}

export function createIdentityWiring(deps: IdentityWiringDeps): IdentityWiring {
  // 解析器是进程级共享的：git 事实不随插件实例变化，多个实例（HMR/测试）复用同一份
  // 缓存；分支仍按 session 缓存。`recorded`/`pending` 是每个组合根实例自己的登记账本，
  // 因为卸载/重载后数据库可能被重置，必须重新登记。
  const resolver = projectIdentityResolver()
  const recorded = new Set<string>()
  const pending = new Map<string, Promise<void>>()
  const warned = new Set<string>()

  /**
   * 每个「工作区 + 项目 + 仓库 + 分支 + 旧键集合」在进程内只登记一次（并发调用共享
   * 同一个 in-flight promise，不重复写）。`legacy_keys` 在 SQL 里取并集，所以同工作区
   * 后续换了旧键/分支会再登记一次，历史别名不会丢。
   */
  const remember = (identity: ProjectIdentity): Promise<void> => {
    const record = deps.store.recordProjectIdentity
    if (typeof record !== 'function') return Promise.resolve()
    const key = identityKeyOf(identity)
    if (recorded.has(key)) return Promise.resolve()
    const inFlight = pending.get(key)
    if (inFlight !== undefined) return inFlight
    const promise = record.call(deps.store, identity).then(() => {
      recorded.add(key)
      warned.delete(key)
    }, error => {
      // 数据库未就绪/迁移未到位：只记一次日志，下次解析同一身份重试。
      if (!warned.has(key)) {
        warned.add(key)
        deps.logger.warn('项目身份登记失败（下次解析重试）', messageOf(error))
      }
    }).finally(() => {
      pending.delete(key)
    })
    pending.set(key, promise)
    return promise
  }

  /**
   * 必须等登记：同一进程里紧接着的检索要用 legacy_keys 匹配旧行，登记晚于查询就会
   * 少召回一次。但等待有上界——超过 `REGISTRATION_WAIT_MS` 视为数据库异常，先继续召回，
   * 登记仍在后台完成（成功后同样记为已登记）。
   */
  const rememberBounded = async (identity: ProjectIdentity): Promise<void> => {
    await withTimeout(remember(identity), REGISTRATION_WAIT_MS)
  }

  return {
    async resolveContext(exec: unknown): Promise<ToolContext | undefined> {
      const context = await resolveToolContext(exec, { identity: resolver })
      if (context?.projectIdentity !== undefined) await rememberBounded(context.projectIdentity)
      return context
    },
    async resolveIdentity(cwd: string, sessionId: string): Promise<ProjectIdentity | undefined> {
      const identity = await resolver.resolve(cwd, sessionId)
      if (identity !== undefined) await rememberBounded(identity)
      return identity
    },
  }
}
