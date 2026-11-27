/**
 * retrieval/providers 的公共面：统一 provider 契约、阶段一/阶段二工厂与 runner。
 *
 * engine/channels 只从这里取 provider 执行能力；单个 provider 类不直接对外，
 * 避免调用方绕过 deadline/失败隔离自己调 store。
 */
export { createExpansionProviders, runExpansionProviders } from './graph.js'
export type { ExpansionRunOptions, ExpansionRunResult } from './graph.js'
export { providerLimit, runProvider, runProviderSet, searchBase } from './run.js'
export type { ProviderRunOptions, ProviderRunServices } from './run.js'
export { createStageOneProviders, FulltextProvider, SingleCharProvider, StateBoardProvider, TimeProvider, TriggerProvider, VectorProvider } from './stage-one.js'
export type { ProviderChannel } from '../compiler.js'
export type {
  IndexProvider,
  ProviderContext,
  ProviderIssue,
  ProviderOutcome,
  ProviderResult,
  ProviderResultStatus,
  ProviderStatus,
} from './types.js'
