import type { Clock } from '../ports/clock.js'
import type { Embedder } from '../ports/embedding.js'
import type { JobQueue, Logger } from '../ports/jobs.js'
import type { Store, WriteResult } from '../ports/store.js'
import type { WriteEntityInput } from '../domain/entity.js'
import { validationError } from '../domain/entity.js'
import { err, ok, type Result, type OmbError } from '../domain/errors.js'
import { deriveReferences, deriveSearchText, deriveTriggers, normalizeWrite } from '../domain/validation.js'

export type EmbeddingStatus = 'done' | 'queued' | 'unavailable' | 'failed'

export interface RememberOutput extends WriteResult {
  readonly embedding: EmbeddingStatus
}

export interface RememberDeps {
  readonly store: Store
  readonly embedder?: Embedder
  readonly jobs?: JobQueue
  readonly clock: Clock
  readonly logger?: Logger
}

export class RememberService {
  constructor(private readonly deps: RememberDeps) {}

  async remember(input: WriteEntityInput): Promise<Result<RememberOutput>> {
    const normalized = normalizeWrite(input)
    if (!normalized.ok) return err(validationError(normalized.errors))
    const derived = {
      searchText: deriveSearchText(normalized.value.attributes),
      triggers: deriveTriggers(normalized.value.attributes),
      references: deriveReferences(normalized.value.attributes),
    }
    const written = await this.deps.store.write(normalized.value, derived)
    const embedding = await this.embed(normalized.value.id, derived.searchText)
    return ok({ ...written, embedding })
  }

  private async embed(entityId: string, text: string): Promise<EmbeddingStatus> {
    if (this.deps.embedder === undefined || text.trim().length === 0) return 'unavailable'
    const available = await this.deps.embedder.available().catch(() => false)
    if (!available) return 'unavailable'
    if (this.deps.jobs !== undefined) {
      try {
        await this.deps.jobs.enqueue('omb.embed', { entityId, text }, { singletonKey: `embed:${entityId}`, retryLimit: 3 })
        return 'queued'
      } catch (error) {
        this.deps.logger?.warn('嵌入任务入队失败，改为同步嵌入', error)
      }
    }
    try {
      const vectors = await this.deps.embedder.embed([text])
      const vector = vectors[0]
      if (vector === undefined) return 'failed'
      await this.deps.store.upsertEmbedding(entityId, this.deps.embedder.model, this.deps.embedder.dims, vector)
      return 'done'
    } catch (error) {
      this.deps.logger?.warn('同步嵌入失败', error)
      return 'failed'
    }
  }
}

export type RememberError = OmbError
