import type { Clock } from '../ports/clock.js'
import type { WriteOptions, WriteResult } from '../ports/store.js'
import type { WriteEntityInput } from '../domain/entity.js'
import { validationError } from '../domain/validation-result.js'
import { err, ok, type Result, type OmbError } from '../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, normalizeWrite } from '../domain/validation.js'
import { populateEmbedding, type EmbeddingDeps, type EmbeddingStatus } from './embedding.js'

export type { EmbeddingStatus } from './embedding.js'

export interface RememberOutput extends WriteResult {
  readonly embedding: EmbeddingStatus
}

export interface RememberDeps extends EmbeddingDeps {
  readonly clock: Clock
}

/**
 * 写入的幂等/证据参数：`commandId` 由工具运行时按调用身份生成（同一调用重试复用）；
 * `evidence` 是本次观察的来源证据（写事务内落证据账本，内容去重时并入原实体）。
 * `actor`/`source` 是服务端派生的审计身份（工具路径为 assistant:<session> + tool:*），
 * 与实体内容 origin 分开。
 */
export type RememberOptions = Pick<
  WriteOptions,
  'commandId' | 'correlationId' | 'evidence' | 'actor' | 'source'
>

export class RememberService {
  constructor(private readonly deps: RememberDeps) {}

  async remember(input: WriteEntityInput, options: RememberOptions = {}): Promise<Result<RememberOutput>> {
    const normalized = normalizeWrite(input)
    if (!normalized.ok) return err(validationError(normalized.errors))
    const derived = {
      searchText: deriveSearchText(normalized.value.attributes),
      triggers: deriveTriggers(normalized.value.attributes),
      references: deriveReferences(normalized.value.attributes),
    }
    const written = await this.deps.store.write(normalized.value, derived, options)
    // 内容复用没有新文本/新实体：原实体已有向量，不重复入队嵌入。
    const embedding: EmbeddingStatus = written.deduped !== undefined
      ? 'reused'
      : await populateEmbedding(this.deps, normalized.value.id, derived.searchText)
    return ok({ ...written, embedding })
  }
}

export type RememberError = OmbError
