import { describe, expect, it } from 'vitest'
import { contentFingerprint } from '../../../packages/v7/src/domain/content-key.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { normalizeWrite } from '../../../packages/v7/src/domain/validation.js'

function normalized(input: WriteEntityInput) {
  const result = normalizeWrite(input)
  if (!result.ok) throw new Error(`输入非法：${JSON.stringify(result.errors)}`)
  return result.value
}

function memory(overrides: Partial<WriteEntityInput> = {}): WriteEntityInput {
  return {
    kind: 'memory',
    category: 'fact',
    scope: { kind: 'project', projectKey: 'D:/Project/omb' },
    attrs: { title: 'Postgres 配置', body: '连接串走 127.0.0.1:5432' },
    ...overrides,
  } as WriteEntityInput
}

describe('contentFingerprint（内容幂等第一层口径）', () => {
  it('相同 kind/scope/category/关键属性得到同一指纹', () => {
    expect(contentFingerprint(normalized(memory()))).toBe(contentFingerprint(normalized(memory())))
  })

  it('易失溯源属性（evidence/artifactId/promotedAt 等）不参与指纹：新证据并入原实体', () => {
    const base = contentFingerprint(normalized(memory()))
    const withProvenance = contentFingerprint(normalized(memory({
      attrs: {
        title: 'Postgres 配置',
        body: '连接串走 127.0.0.1:5432',
        evidence: ['session:a', 'session:b'],
        artifactId: 'art_1',
        promotedAt: '2026-11-29T00:00:00.000Z',
        verified: true,
      },
    })))
    expect(withProvenance).toBe(base)
  })

  it('不同 scope 不合并：同内容在两个项目里是两条事实', () => {
    const global = memory({ scope: { kind: 'global' } })
    const projectA = memory({ scope: { kind: 'project', projectKey: 'D:/A' } })
    const projectB = memory({ scope: { kind: 'project', projectKey: 'D:/B' } })
    const fingerprints = [global, projectA, projectB].map(input => contentFingerprint(normalized(input)))
    expect(new Set(fingerprints).size).toBe(3)
  })

  it('不同 category/正文/时间属性的内容不合并', () => {
    const fact = contentFingerprint(normalized(memory()))
    const clue = contentFingerprint(normalized(memory({ category: 'clue' })))
    const otherBody = contentFingerprint(normalized(memory({
      attrs: { title: 'Postgres 配置', body: '连接串走 10.0.0.1:5432' },
    })))
    const timed = contentFingerprint(normalized(memory({
      attrs: { title: '部署时间', body: '完成部署', observedAt: '2026-11-28T00:00:00.000Z' },
    })))
    const timedLater = contentFingerprint(normalized(memory({
      attrs: { title: '部署时间', body: '完成部署', observedAt: '2026-11-29T00:00:00.000Z' },
    })))
    expect(new Set([fact, clue, otherBody, timed, timedLater]).size).toBe(5)
    expect(timed).not.toBe(timedLater)
  })

  it('空白/全角差异按 NFKC+trim 归一：同一内容不因排版产生第二条', () => {
    const plain = contentFingerprint(normalized(memory({
      attrs: { title: 'Postgres 配置', body: '连接串走 127.0.0.1:5432' },
    })))
    const padded = contentFingerprint(normalized(memory({
      attrs: { title: '  Postgres 配置  ', body: '连接串走 127.0.0.1:5432\n' },
    })))
    expect(padded).toBe(plain)
  })

  it('状态机/思维链不参与实体级内容去重（各有收敛键）', () => {
    expect(contentFingerprint(normalized({
      kind: 'state',
      scope: { kind: 'global' },
      title: '目标：完成重构',
      status: 'in_progress',
      time: '2026-11-29T00:00:00.000Z',
      attrs: { body: '按计划推进' },
    }))).toBeUndefined()
    expect(contentFingerprint(normalized({
      kind: 'chain',
      scope: { kind: 'global' },
      title: '自动分组',
      group: ['mem_018f2a00-0000-7000-8000-000000000001'],
    }))).toBeUndefined()
  })
})
