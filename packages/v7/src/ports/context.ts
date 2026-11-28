import type { ProjectIdentity } from '../domain/project-identity.js'

/**
 * 运行时上下文：application/recall 只依赖这个窄结构，不依赖 DSH 适配器。
 *
 * `projectKey` 是兼容别名，值等于 `projectIdentity.projectId`（新解析器）；
 * 旧调用/旧测试没有 identity 时仍按 `projectKey ?? cwd` 工作。
 */
export interface RuntimeContext {
  readonly sessionId: string
  readonly cwd?: string
  readonly projectKey?: string
  /** 稳定项目身份（projectId/workspaceId/repositoryId/branchId + 路径锚点）。 */
  readonly projectIdentity?: ProjectIdentity
  readonly agentPath?: string
}
