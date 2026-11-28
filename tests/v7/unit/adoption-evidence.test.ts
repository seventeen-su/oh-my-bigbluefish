import { describe, expect, it } from 'vitest'
import {
  evidenceFromSessionEvent,
  findReferences,
  isVerificationTool,
  toolCallExplicitReferences,
  userConfirmationReferences,
  userRefutationReferences,
  type AdoptionHit,
} from '../../../plugin/v7/adoption-evidence.js'
import { createT1Session } from '../../../plugin/v7/t1-session.js'
import type { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import type { Logger } from '../../../packages/v7/src/ports/jobs.js'
import { FakeStore, entity } from './retrieval/fake.js'

const HIT: AdoptionHit = { id: 'mem_11111111-1111-4111-8111-111111111111', title: '迁移评审结论' }

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('采用证据纯判定', () => {
  it('完整 entity id 是强引用，标题是弱引用；ASCII 标题按词边界避免子串误判', () => {
    expect(findReferences(`使用 ${HIT.id}`, [HIT])).toEqual([{ hit: HIT, kind: 'entity-id' }])
    expect(findReferences('见迁移评审结论', [HIT])).toEqual([{ hit: HIT, kind: 'title' }])
    const config: AdoptionHit = { id: 'mem_2', title: 'config' }
    // 工具参数/路径里碰巧包含 config：不是引用；完整 ID 才是。
    expect(findReferences('cat config.json', [config])).toEqual([])
    expect(toolCallExplicitReferences('{"path":"config.json"}', [config])).toEqual([])
    expect(toolCallExplicitReferences(`{"id":"${config.id}"}`, [config])).toEqual([
      { hit: config, kind: 'entity-id' },
    ])
  })

  it('用户确认必须与引用同句；只重复标题不构成确认', () => {
    expect(userConfirmationReferences('对，就按迁移评审结论来', [HIT])).toEqual([{ hit: HIT, kind: 'title' }])
    expect(userConfirmationReferences('对。迁移评审结论是什么？', [HIT])).toEqual([])
    expect(userConfirmationReferences('迁移评审结论', [HIT])).toEqual([])
  })

  it('用户否定/证伪产生负向候选；同一句同时肯定与否定由调用方保守处理', () => {
    expect(userRefutationReferences('不对，迁移评审结论已经过时了', [HIT])).toEqual([{ hit: HIT, kind: 'title' }])
    expect(userRefutationReferences('迁移评审结论', [HIT])).toEqual([])
  })

  it('事件归一化：assistant 只给文本，user 只认人类来源，工具失败不成功', () => {
    const assistant = evidenceFromSessionEvent('assistant/message', {
      message: { content: [{ type: 'text', text: `我用了 ${HIT.id}，验证成功` }] },
    })
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.kind).toBe('assistant-text')

    const pluginUser = evidenceFromSessionEvent('user/message', {
      source: { kind: 'plugin:oh-my-bigbluefish/v7' },
      content: [{ type: 'text', text: '对，就按结论来' }],
    })
    expect(pluginUser).toEqual([])

    const failure = evidenceFromSessionEvent('tool/result', {
      message: { toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'ENOENT' }] },
    })
    expect(failure[0]?.success).toBe(false)
  })

  it('验证类工具只认 test/typecheck/build 类命令', () => {
    expect(isVerificationTool('bash', 'pnpm test')).toBe(true)
    expect(isVerificationTool('bash', 'pnpm v7:typecheck')).toBe(true)
    expect(isVerificationTool('read_file', '{"path":"a.txt"}')).toBe(false)
  })
})

describe('T1 会话证据：验证必须依赖最新版本与外部信号', () => {
  it('引用后实体已更新（stale）时保留 Reference 但不升 Validation', async () => {
    const store = new FakeStore()
    store.entitiesById.set(HIT.id, entity({ id: HIT.id, title: '迁移评审结论' }))
    const session = createT1Session({ store: store as unknown as PostgresStore, logger })
    session.rememberInjection('s-stale', {
      traceId: 'trc_stale',
      hits: [{ ...HIT, updatedAt: '2026-01-01T00:00:00.000Z' }],
    })
    await session.flushEvidence('s-stale')
    await session.ingestEvidence('s-stale', evidenceFromSessionEvent('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '对，就按迁移评审结论来' }],
    }))
    await session.flushEvidence('s-stale')
    expect(store.usage.some(item => item.level === 'reference')).toBe(true)
    expect(store.usage.some(item => item.level === 'validation')).toBe(false)
    session.dispose()
  })

  it('最新版本 + 用户确认才写 Validation；模型自述“已验证”不算', async () => {
    const store = new FakeStore()
    const current = entity({ id: HIT.id, title: '迁移评审结论' })
    store.entitiesById.set(HIT.id, current)
    const session = createT1Session({ store: store as unknown as PostgresStore, logger })
    session.rememberInjection('s-fresh', {
      traceId: 'trc_fresh',
      hits: [{ ...HIT, updatedAt: current.updatedAt }],
    })
    await session.flushEvidence('s-fresh')
    await session.ingestEvidence('s-fresh', evidenceFromSessionEvent('assistant/message', {
      message: { content: [{ type: 'text', text: `我用了 ${HIT.id}，已验证成功` }] },
    }))
    expect(store.usage.some(item => item.level === 'validation')).toBe(false)
    await session.ingestEvidence('s-fresh', evidenceFromSessionEvent('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '对，就按迁移评审结论来' }],
    }))
    expect(store.usage.some(item => item.level === 'validation')).toBe(true)
    session.dispose()
  })

  it('用户否定写 Refutation；工具成功只有验证类命令才升级为 Validation', async () => {
    const store = new FakeStore()
    const current = entity({ id: HIT.id, title: '迁移评审结论' })
    store.entitiesById.set(HIT.id, current)
    const session = createT1Session({ store: store as unknown as PostgresStore, logger })
    session.rememberInjection('s-tool', {
      traceId: 'trc_tool',
      hits: [{ ...HIT, updatedAt: current.updatedAt }],
    })
    await session.flushEvidence('s-tool')
    await session.ingestEvidence('s-tool', evidenceFromSessionEvent('tool/call', {
      name: 'read_file',
      callId: 'call-1',
      arguments: `{"path":"${HIT.id}"}`,
    }))
    await session.ingestEvidence('s-tool', evidenceFromSessionEvent('tool/result', {
      message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] },
    }))
    expect(store.usage.some(item => item.level === 'utilization')).toBe(true)
    expect(store.usage.some(item => item.level === 'validation')).toBe(false)

    await session.ingestEvidence('s-tool', evidenceFromSessionEvent('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '不对，迁移评审结论已经过时了' }],
    }))
    expect(store.usage.some(item => item.level === 'refutation')).toBe(true)
    session.dispose()
  })
})
