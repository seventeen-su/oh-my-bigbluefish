/**
 * 内核 ABI 聚合出口。模块只从 `kernel/abi` 取类型。
 *
 * ABI 版本：任何破坏性改动必须递增 `CORE_ABI_VERSION`，
 * 并由 `tests/kernel/abi.contract.test.ts` 的符号清单测试强制。
 */

export const CORE_ABI_VERSION = 1

export type {
  MemoryKind,
  MemoryScope,
  AssertedBy,
  EdgeType,
  FocusDepth,
  PressureBand,
} from './kinds.js'
export { MEMORY_KINDS, MEMORY_SCOPES, ASSERTED_BY, EDGE_TYPES, FOCUS_DEPTHS } from './kinds.js'

export type {
  MemoryRecord,
  Edge,
  ScoredHit,
  LexicalQuery,
  GraphQuery,
  GraphWalk,
  StoreStats,
  MemoryStore,
  Embedder,
  Clock,
  Logger,
  ContextPressure,
  ContextNodeCost,
  FocusState,
} from './ports.js'

export type { ConfigSchema, ModuleManifest, ModuleHealth, ModuleRegistration } from './manifest.js'

export type {
  TaggedStore,
  StoreSet,
  StorageHostPort,
  StoresService,
  SqliteLike,
  SqliteStatementLike,
} from './storage.js'
export { STORES_SERVICE, SCHEMA_VERSION } from './storage.js'

export type { ModuleId, CatalogEntry, ServiceName, StatusContributor, ToolFactory } from './catalog.js'
export { MODULE_IDS, MODULE_CATALOG, SCOPE_BY_KIND, SERVICES, STATUS_TOOL, validateCatalog } from './catalog.js'

export type {
  Kernel,
  ModuleEvents,
  ModuleEventName,
  SessionRef,
  BudgetKind,
  BudgetGrant,
} from './kernel.js'

export type {
  ToolDefinition,
  ToolInputSchema,
  ToolOutcome,
  PromptContribution,
  ContextRenderInput,
} from './host.js'
export { RESIDENT_HINT_MAX } from './host.js'
