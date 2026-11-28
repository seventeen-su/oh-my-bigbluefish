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
  /**
   * 宿主工具调用的稳定 call id（DSH `ToolExecution.callId`）。
   * 工具写路径用它合成重试复用的稳定 commandId；旧宿主/测试替身没有时退回内容稳定键。
   */
  readonly callId?: string
  /** 工具调用的轮次/步号（可诊断用；不参与幂等键）。 */
  readonly turn?: number
  readonly step?: number
}
