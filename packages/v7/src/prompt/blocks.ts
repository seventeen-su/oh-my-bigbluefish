import type { Entity, Scope } from '../domain/entity.js'
import { scopeOf } from '../domain/entity-access.js'
import type { ArtifactRecord } from '../ports/observability.js'
import {
  createTrustPolicy,
  entityContentText,
  type ContextSource,
  type InjectionRisk,
  type Provenance,
  type TrustPolicy,
} from '../security/trust.js'

/**
 * ContextBlock：进入提示词的**内容单位**（Phase 4 Task 19，ADR-0010）。
 *
 * 关键不变量：
 * - 只有 `data` 与 `instruction` 两种 kind，但只有 `data` 会由 PromptAssembler 拼进注入文本；
 *   记忆/工件/工具输出即使自称 instruction，也必须先降级为 data（降级会写进 receipt）。
 * - `trust` 与 `risk` 由 `security/trust.ts` 按写入者 + 来源上限 + 内容风险算出来，
 *   不由内容自己声明；块工厂只负责把实体/工件/工具输出映射成统一形状。
 * - `scope`、`refs`、`provenance` 保留可追溯信息：注入内容永远能回答“它是谁写的、写在哪”。
 */

export type ContextBlockKind = 'data' | 'instruction'

export interface ContextBlock {
  /** 稳定 id（实体 id / 工件 id / `tool:<name>`）；去重与 receipt 都用它。 */
  readonly id: string
  readonly kind: ContextBlockKind
  readonly source: ContextSource
  /** 0..1，见 `security/trust.ts`。 */
  readonly trust: number
  readonly risk: InjectionRisk
  readonly riskScore: number
  readonly riskReasons: readonly string[]
  readonly provenance: Provenance
  readonly scope: Scope
  readonly text: string
  readonly refs: readonly string[]
}

export interface BlockOptions {
  readonly policy?: TrustPolicy
  /** 声明块类型；只有 `data` 会被原样接受，`instruction` 会在装配时被降级。 */
  readonly kind?: ContextBlockKind
  readonly origin?: string
  readonly scope?: Scope
  readonly refs?: readonly string[]
  readonly entityIds?: readonly string[]
}

export interface DataBlockInput extends BlockOptions {
  readonly id: string
  readonly text: string
  readonly source: ContextSource
}

const defaultPolicy = createTrustPolicy()

/** 通用块工厂：分类 → ContextBlock。 */
export function dataBlock(input: DataBlockInput): ContextBlock {
  const policy = input.policy ?? defaultPolicy
  const classification = policy.classify({
    text: input.text,
    source: input.source,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.entityIds === undefined ? {} : { entityIds: input.entityIds }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  })
  return {
    id: input.id,
    kind: input.kind ?? 'data',
    source: input.source,
    trust: classification.trust,
    risk: classification.injectionRisk,
    riskScore: classification.riskScore,
    riskReasons: classification.riskReasons,
    provenance: classification.provenance,
    scope: classification.scope,
    text: input.text,
    refs: input.refs ?? [],
  }
}

/** 记忆实体 → data 块；文本用标题 + 属性值（与风险扫描同一份文本）。 */
export function memoryBlock(entity: Entity, options: BlockOptions & { readonly text?: string } = {}): ContextBlock {
  const policy = options.policy ?? defaultPolicy
  const text = options.text ?? entityContentText(entity)
  const classification = policy.classifyEntity(entity, text)
  return {
    id: entity.id,
    kind: options.kind ?? 'data',
    source: 'memory',
    trust: classification.trust,
    risk: classification.injectionRisk,
    riskScore: classification.riskScore,
    riskReasons: classification.riskReasons,
    provenance: classification.provenance,
    scope: options.scope ?? scopeOf(entity),
    text,
    refs: options.refs ?? [],
  }
}

/** 会话工件 → data 块：工件是外部/工具原文的常见载体，信任上限 0.5。 */
export function artifactBlock(artifact: ArtifactRecord, options: BlockOptions = {}): ContextBlock {
  return dataBlock({
    id: artifact.id,
    text: artifact.content,
    source: 'artifact',
    origin: options.origin ?? artifact.source,
    entityIds: options.entityIds ?? [artifact.id],
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
  })
}

/** 工具输出 → data 块：工具结果可被被调资源污染，信任上限 0.4。 */
export function toolBlock(name: string, text: string, options: BlockOptions = {}): ContextBlock {
  return dataBlock({
    id: `tool:${name}`,
    text,
    source: 'tool',
    origin: options.origin ?? 'tool',
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
  })
}

/** 外部内容（网页/子代理报告）→ data 块：信任上限 0.3。 */
export function externalBlock(id: string, text: string, options: BlockOptions = {}): ContextBlock {
  return dataBlock({
    id,
    text,
    source: 'external',
    origin: options.origin ?? 'external',
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
    ...(options.entityIds === undefined ? {} : { entityIds: options.entityIds }),
  })
}
