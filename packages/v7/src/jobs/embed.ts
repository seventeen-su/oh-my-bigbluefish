import type { Embedder } from '../ports/embedding.js'
import type { JobQueue } from '../ports/jobs.js'
import type { Store } from '../ports/store.js'

export interface EmbedJob {
  readonly entityId: string
  readonly text: string
}

export function isEmbedJob(value: unknown): value is EmbedJob {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)['entityId'] === 'string'
    && typeof (value as Record<string, unknown>)['text'] === 'string'
}

export async function handleEmbedJob(payload: unknown, deps: { store: Store; embedder: Embedder }): Promise<void> {
  if (!isEmbedJob(payload)) throw new Error('omb.embed 载荷非法')
  const entity = await deps.store.get(payload.entityId, { includeArchived: true })
  if (entity === undefined) return
  const vectors = await deps.embedder.embed([payload.text])
  const vector = vectors[0]
  if (vector === undefined) throw new Error('嵌入器没有返回向量')
  await deps.store.upsertEmbedding(payload.entityId, deps.embedder.model, deps.embedder.dims, vector)
}

export async function registerEmbedJob(queue: JobQueue, deps: { store: Store; embedder: Embedder }): Promise<void> {
  await queue.work('omb.embed', payload => handleEmbedJob(payload, deps))
}
