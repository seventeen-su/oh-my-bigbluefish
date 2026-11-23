import { describe, expect, it, vi } from 'vitest'
import { handleExtract } from '../../../packages/v7/src/jobs/consolidate.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import type { Store } from '../../../packages/v7/src/ports/store.js'

describe('extract failure policy', () => {
  it('候选写失败时不标记 artifact processed，让队列重试', async () => {
    const markProcessed = vi.fn(async () => {})
    const store = {
      listArtifacts: async () => [{
        id: 'art_fail',
        kind: 'goal/change',
        content: JSON.stringify({ cwd: 'D:\\Project', goal: { objective: '不能丢的目标' } }),
        source: 'test',
        metadata: { cwd: 'D:\\Project' },
        createdAt: '2026-11-22T00:00:00.000Z',
      }],
      markArtifactProcessed: markProcessed,
      write: async () => { throw new Error('pg write failed') },
    } as unknown as Store
    const deps = {
      store,
      queries: {},
      updateService: {},
      clock: { now: () => new Date(), iso: () => '2026-11-22T00:00:00.000Z' },
    } as unknown as ConsolidationDeps

    await expect(handleExtract(deps)).rejects.toThrow('pg write failed')
    expect(markProcessed).not.toHaveBeenCalled()
  })
})
