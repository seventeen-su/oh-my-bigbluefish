/**
 * retrieval 的公共面：只导出调用方（recall/app/jobs）真正需要的构造与契约。
 * 融合/重排/图扩展的内部纯函数留在各自文件里，避免把实现细节变成永久契约。
 */
export { DEFAULT_RETRIEVAL_CONFIG, createRetrievalConfig } from './config.js'
export type { RetrievalConfig, RetrievalConfigOverrides } from './config.js'
export { RecallEngine } from './engine.js'
export type { RecallEngineDeps } from './engine.js'
export type {
  ChannelError,
  ChannelReport,
  EmptyReason,
  ExpansionMode,
  RecallHit,
  RecallRequest,
  RecallResult,
  RecallScenario,
} from './types.js'
