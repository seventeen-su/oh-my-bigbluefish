/**
 * OMB v7 公共入口：只导出宿主装配需要的能力，保持窄接口。
 * 业务内部按 domain/ports/app/adapters 分层，不在这里做巨型 barrel。
 */
export { PostgresStore, migrateDatabase, ensureDatabase } from './adapters/postgres/index.js'
export { PostgresMaintenance } from './adapters/postgres/maintenance.js'
export { DefaultDynamicResolver, resolveRawValue } from './adapters/dynamic/index.js'
export { QuickJsSandbox } from './adapters/quickjs/index.js'
export { OnnxEmbedder, HashEmbedder } from './adapters/embedding/index.js'
export { PgBossQueue } from './adapters/pg-boss/index.js'
export { DynamicService } from './app/dynamic.js'
export { RecallService, formatRecall, type RecallInjection, type RecallToolInput } from './app/recall.js'
export { RecallEngine } from './retrieval/engine.js'
export { buildEventRecallText, buildResidentText } from './recall/resident.js'
export { RememberService, type RememberOutput, type RememberDeps } from './app/remember.js'
export { UpdateService, type UpdateServiceDeps } from './app/update.js'
export {
  normalizeWrite,
  deriveSearchText,
  deriveTriggers,
  shouldAutoArchive,
  type NormalizedWrite,
} from './domain/validation.js'
export {
  CATEGORIES,
  CATEGORY_LABELS,
  STATE_STATUSES,
  STATUS_LABELS,
  isCategory,
  isStateStatus,
  scopeKey,
  type Attribute,
  type Category,
  type DynamicSpec,
  type Entity,
  type EntityKind,
  type PatchEntityInput,
  type Scope,
  type StateStatus,
  type StateVersion,
  type WriteEntityInput,
} from './domain/entity.js'
export { validationError } from './domain/entity.js'
export type { JsonValue } from './domain/json.js'
export type { Link, LinkInput, Expansion } from './domain/link.js'
export type { Store, WriteResult, PatchResult, EntitySummary, ChannelHit } from './ports/store.js'
export type { Embedder } from './ports/embedding.js'
export type { Clock } from './ports/clock.js'
export type { JobQueue, Logger } from './ports/jobs.js'
export type { DynamicResolver, DynamicContext, CodeSandbox } from './ports/dynamic.js'
