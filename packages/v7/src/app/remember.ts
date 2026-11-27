import type { Clock } from '../ports/clock.js'
import type { WriteResult } from '../ports/store.js'
import type { WriteEntityInput } from '../domain/entity.js'
import { validationError } from '../domain/entity.js'
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
    const embedding = await populateEmbedding(this.deps, normalized.value.id, derived.searchText)
    return ok({ ...written, embedding })
  }
}

export type RememberError = OmbError
