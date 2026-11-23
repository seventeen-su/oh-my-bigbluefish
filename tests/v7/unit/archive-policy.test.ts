import { describe, expect, it } from 'vitest'
import { buildViewValues } from '../../../packages/v7/src/adapters/postgres/rows.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../../../packages/v7/src/domain/validation.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'

const NOW = '2026-11-22T16:00:00.000Z'
const SCOPE = { kind: 'project' as const, projectKey: 'D:\\Program\\Oh-My-BigBlueFish' }

function viewOf(input: WriteEntityInput): { archivedAt: string | null } {
  const normalized = normalizeWrite(input)
  if (!normalized.ok) throw new Error(JSON.stringify(normalized.errors))
  const attributes = normalized.value.attributes
  return buildViewValues(normalized.value, {
    searchText: deriveSearchText(attributes),
    triggers: deriveTriggers(attributes),
  }, { now: NOW })
}

function state(status: 'completed' | 'in_progress' | 'waiting' | 'blocked' | 'not_started' | 'discarded'): WriteEntityInput {
  return {
    kind: 'state',
    scope: SCOPE,
    title: `状态 ${status}`,
    status,
    time: NOW,
    attrs: { body: `状态矩阵 ${status}` },
  }
}

describe('auto archive policy', () => {
  it.each(['in_progress', 'waiting', 'blocked', 'not_started'] as const)(
    '不自动归档进行中的状态：%s',
    status => expect(viewOf(state(status)).archivedAt).toBeNull(),
  )

  it.each(['completed', 'discarded'] as const)(
    '状态机完成/丢弃时自动归档：%s',
    status => expect(viewOf(state(status)).archivedAt).toBe(NOW),
  )

  it('记忆里出现 status 可选属性时不能被当成状态机自动归档', () => {
    const view = viewOf({
      kind: 'memory',
      category: 'fact',
      scope: SCOPE,
      attrs: { body: '记忆也可以有 status 标签', status: 'completed' },
    })
    expect(view.archivedAt).toBeNull()
  })

  it('思维链里出现 status 可选属性时不能被当成状态机自动归档', () => {
    const view = viewOf({
      kind: 'chain',
      scope: SCOPE,
      title: '链',
      group: ['mem_00000000-0000-4000-8000-000000000001'],
      attrs: { status: 'discarded' },
    })
    expect(view.archivedAt).toBeNull()
  })
})
