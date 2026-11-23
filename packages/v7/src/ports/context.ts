/** 运行时上下文：application/recall 只依赖这个窄结构，不依赖 DSH 适配器。 */
export interface RuntimeContext {
  readonly sessionId: string
  readonly cwd?: string
  readonly projectKey?: string
  readonly agentPath?: string
}
