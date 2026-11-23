import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tokenize } from '../../../packages/v7/src/domain/text.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { attributeValue } from '../../../packages/v7/src/domain/entity.js'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import { DynamicService } from '../../../packages/v7/src/app/dynamic.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

describe('PostgresStore', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    await resetDatabase()
  })

  it('写入记忆并读回属性与视图', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: {
        title: '项目记忆库',
        body: 'PostgreSQL + pgvector 单库',
        tags: ['memory', 'postgres'],
      },
    }
    const written = await db.write(normalized(input), derived(input))
    expect(written.entity.id).toMatch(/^mem_/)
    expect(written.entity.attributes.map(item => item.name)).toEqual(
      expect.arrayContaining(['id', 'category', 'scope', 'title', 'body', 'tags']),
    )

    const loaded = await db.get(written.entity.id)
    expect(loaded?.attributes.find(item => item.name === 'title')?.value).toEqual({ kind: 'static', value: '项目记忆库' })

    const view = await db.db.query<{ title: string; category: string; scope: string; search_text: string }>(
      'select title, category, scope, search_text from omb.entity_view where entity_id = $1',
      [written.entity.id],
    )
    expect(view.rows[0]?.title).toBe('项目记忆库')
    expect(view.rows[0]?.category).toBe('fact')
    expect(view.rows[0]?.scope).toBe('global')
    expect(view.rows[0]?.search_text).toContain('记忆')
    await db.close()
  })

  it('全文检索命中中文 bigram，归档后默认不返回', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '项目记忆库', body: '中文全文用 bigram 预切' },
    }
    const written = await db.write(normalized(input), derived(input))
    const tokens = tokenize('记忆库')
    expect(tokens).toContain('记忆')
    const hits = await db.fulltext({ query: '记忆库', tokens, limit: 10 })
    expect(hits.map(hit => hit.entityId)).toContain(written.entity.id)

    await db.archive(written.entity.id, 'test', 'test')
    const after = await db.fulltext({ query: '记忆库', tokens, limit: 10 })
    expect(after.map(hit => hit.entityId)).not.toContain(written.entity.id)
    const withArchived = await db.fulltext({ query: '记忆库', tokens, limit: 10, includeArchived: true })
    expect(withArchived.map(hit => hit.entityId)).toContain(written.entity.id)
    await db.close()
  })

  it('单字中文回退走 chars GIN 候选，不依赖 trgm', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '项目记忆库' },
    }
    const written = await db.write(normalized(input), derived(input))
    const hits = await db.singleChar({ query: '忆', tokens: tokenize('忆'), limit: 5 })
    expect(hits.map(hit => hit.entityId)).toContain(written.entity.id)
    const view = await db.db.query<{ chars: string[] }>('select chars from omb.entity_view where entity_id = $1', [written.entity.id])
    expect(view.rows[0]?.chars).toContain('忆')

    const twoInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '中文记忆' },
    }
    const two = await db.write(normalized(twoInput), derived(twoInput))
    const twoCharHits = await db.singleChar({ query: '中文', tokens: tokenize('中文'), limit: 5 })
    expect(twoCharHits.find(hit => hit.entityId === two.entity.id)?.rawScore).toBeGreaterThan(0.2)
    await db.close()
  })

  it('T0 偏好摘要只返回全局标签=偏好条目', async () => {
    const db = store()
    const preferred = await db.write(normalized({
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '偏好颜色', tags: ['偏好'] },
    }), derived({
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '偏好颜色', tags: ['偏好'] },
    }))
    await db.write(normalized({
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '普通记忆' },
    }), derived({
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '普通记忆' },
    }))
    const prefs = await db.preferenceSummaries(10)
    expect(prefs.map(item => item.id)).toContain(preferred.entity.id)
    expect(prefs.some(item => item.id !== preferred.entity.id)).toBe(false)
    await db.close()
  })

  it('recall_event 只有 injected=true 才写 injected_at', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '注入时间测试' },
    }
    const written = await db.write(normalized(input), derived(input))
    await db.recordRecall([
      {
        traceId: 'trc_injected', entityId: written.entity.id, channel: 'fulltext',
        rank: 1, injected: true,
      },
      {
        traceId: 'trc_tool', entityId: written.entity.id, channel: 'fulltext',
        rank: 1, injected: false,
      },
    ])
    const rows = await db.db.query<{ trace_id: string; injected: boolean; injected_at: string | null }>(
      `select trace_id, injected, injected_at from omb.recall_event
       where trace_id in ('trc_injected','trc_tool') order by trace_id`,
    )
    expect(rows.rows.find(row => row.trace_id === 'trc_injected')?.injected_at).not.toBeNull()
    expect(rows.rows.find(row => row.trace_id === 'trc_tool')?.injected_at).toBeNull()
    await db.close()
  })

  it('T0 常驻 trace 写入数据库并可读取裁剪证据', async () => {
    const db = store()
    await db.recordResidentTrace({
      traceId: 'trc_resident_0123456789abcdef0123456789abcdef',
      sessionId: 'session-resident',
      turnId: '2',
      budgetTokens: 90,
      usedTokens: 31,
      text: '[OMB 常驻]\n当前状态：进行中（st_1）',
      sections: [
        { name: 'header', tokens: 5, kept: true, text: '[OMB 常驻]', entityIds: [] },
        { name: 'preferences', tokens: 50, kept: false, text: '偏好：很长', entityIds: ['mem_1'] },
        { name: 'states', tokens: 26, kept: true, text: '当前状态：进行中（st_1）', entityIds: ['st_1'] },
      ],
      droppedSections: ['preferences'],
    })

    const rows = await db.db.query<{
      session_id: string
      turn_id: string
      budget_tokens: number
      used_tokens: number
      sections: { name: string; kept: boolean; entityIds: string[] }[]
      dropped_sections: string[]
      text: string
    }>(
      `select session_id, turn_id, budget_tokens, used_tokens, sections, dropped_sections, text
       from omb.resident_trace where trace_id = $1`,
      ['trc_resident_0123456789abcdef0123456789abcdef'],
    )
    expect(rows.rows[0]).toMatchObject({
      session_id: 'session-resident',
      turn_id: '2',
      budget_tokens: 90,
      used_tokens: 31,
      dropped_sections: ['preferences'],
    })
    expect(rows.rows[0]?.sections.find(section => section.name === 'states')?.entityIds).toEqual(['st_1'])
    expect(rows.rows[0]?.text).toContain('当前状态')
    await db.close()
  })

  it('patch 更新实体 origin，避免后台写入丢失 job 来源', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      origin: 'job', attrs: { title: '来源测试', body: 'initial' },
    }
    const written = await db.write(normalized(input), derived(input))
    const nextInput: WriteEntityInput = {
      id: written.entity.id,
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      origin: 'job', attrs: { title: '来源测试', body: 'updated' },
    }
    const patched = await db.patch(
      normalized(nextInput),
      { id: written.entity.id, expectedRevision: 1, attrs: { body: 'updated' }, origin: 'job' },
      derived(nextInput),
    )
    expect(patched.entity.origin).toBe('job')
    const row = await db.db.query<{ origin: string }>('select origin from omb.entity where id = $1', [written.entity.id])
    expect(row.rows[0]?.origin).toBe('job')
    await db.close()
  })

  it('状态机更新生成历史，完成状态自动归档', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'state',
      scope: { kind: 'project', projectKey: 'D:\\Program\\Oh-My-BigBlueFish' },
      title: 'v7 迁移',
      status: 'in_progress',
      time: '2026-11-22T00:00:00.000Z',
      attrs: { note: '先做存储' },
    }
    const written = await db.write(normalized(input), derived(input))
    const next: WriteEntityInput = {
      ...input,
      id: written.entity.id,
      status: 'blocked',
      attrs: { note: '等待 pgvector 验证', blocker: 'extension' },
    }
    const patched = await db.patch(normalized(next), { id: written.entity.id, expectedRevision: 1 }, derived(next))
    expect(patched.history?.status).toBe('in_progress')
    expect(patched.entity.revision).toBe(2)
    const history = await db.history(written.entity.id, 10)
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('in_progress')

    const doneInput: WriteEntityInput = { ...next, status: 'completed', attrs: { note: '完成' } }
    const done = await db.patch(normalized(doneInput), { id: written.entity.id, expectedRevision: 2 }, derived(doneInput))
    expect(done.entity.archivedAt).toBeDefined()
    expect(await db.get(written.entity.id)).toBeUndefined()
    expect((await db.get(written.entity.id, { includeArchived: true }))?.archivedAt).toBeDefined()
    await db.close()
  })

  it('记忆/思维链的 status 可选属性不会触发状态机自动归档', async () => {
    const db = store()
    const memoryInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '带状态标签的记忆', status: 'completed' },
    }
    const memory = await db.write(normalized(memoryInput), derived(memoryInput))
    expect(await db.get(memory.entity.id)).toBeDefined()
    const memoryView = await db.db.query<{ archived_at: string | null }>(
      'select archived_at from omb.entity_view where entity_id = $1', [memory.entity.id],
    )
    expect(memoryView.rows[0]?.archived_at).toBeNull()

    const chainInput: WriteEntityInput = {
      kind: 'chain', scope: { kind: 'global' }, title: '带状态标签的链',
      group: [memory.entity.id], attrs: { status: 'discarded' },
    }
    const chain = await db.write(normalized(chainInput), derived(chainInput))
    expect(await db.get(chain.entity.id)).toBeDefined()
    await db.close()
  })

  it('链接与思维链扩展', async () => {
    const db = store()
    const leftInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '左', body: 'A' },
    }
    const rightInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '右', body: 'B' },
    }
    const left = await db.write(normalized(leftInput), derived(leftInput))
    const right = await db.write(normalized(rightInput), derived(rightInput))
    const link = await db.link({ fromId: left.entity.id, toId: right.entity.id, relation: 'depends_on' })
    expect(link.created).toBe(true)
    const expanded = await db.expand([left.entity.id], 1)
    expect(expanded.map(item => item.entityId)).toContain(right.entity.id)

    await db.unlink(link.link.id, 'test')
    const relinked = await db.link({ fromId: left.entity.id, toId: right.entity.id, relation: 'depends_on' })
    expect(relinked.created).toBe(true)

    const undirected = await db.link({
      fromId: left.entity.id,
      toId: right.entity.id,
      relation: 'related',
      directed: false,
    })
    const reverse = await db.link({
      fromId: right.entity.id,
      toId: left.entity.id,
      relation: 'related',
      directed: false,
    })
    expect(reverse.created).toBe(false)
    expect(reverse.link.id).toBe(undirected.link.id)
    const undirectedRows = await db.db.query<{ count: string }>(
      `select count(*)::text as count from omb.link
       where relation = 'related' and directed = false and archived_at is null`,
    )
    expect(undirectedRows.rows[0]?.count).toBe('1')

    const chainInput: WriteEntityInput = {
      kind: 'chain',
      scope: { kind: 'global' },
      title: '一组',
      group: [left.entity.id, right.entity.id],
    }
    const chain = await db.write(normalized(chainInput), derived(chainInput))
    const chainExpanded = await db.expand([left.entity.id], 1)
    expect(chainExpanded.some(item => item.chainId === chain.entity.id && item.entityId === right.entity.id)).toBe(true)

    // 改组必须同步 chain_member：移除 right、加入 left 后，从 right 不再展开出旧组。
    const changed: WriteEntityInput = { ...chainInput, id: chain.entity.id, group: [left.entity.id] }
    await db.patch(normalized(changed), { id: chain.entity.id, expectedRevision: 1 }, derived(changed))
    const afterChange = await db.expand([right.entity.id], 1)
    expect(afterChange.some(item => item.chainId === chain.entity.id)).toBe(false)
    const fromLeft = await db.expand([left.entity.id], 1)
    expect(fromLeft.some(item => item.chainId === chain.entity.id && item.entityId === right.entity.id)).toBe(false)

    const nested: WriteEntityInput = {
      kind: 'chain', scope: { kind: 'global' }, title: '嵌套链', group: [chain.entity.id],
    }
    await expect(db.write(normalized(nested), derived(nested))).rejects.toThrow(/必须/)
    await db.close()
  })

  it('动态 ref 属性可求值并写回缓存', async () => {
    const db = store()
    const targetInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '目标标题' },
    }
    const target = await db.write(normalized(targetInput), derived(targetInput))
    const sourceInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '引用者', mirror: { $dynamic: { kind: 'ref', entityId: target.entity.id, attr: 'title' } } },
    }
    const source = await db.write(normalized(sourceInput), derived(sourceInput))
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: { now: () => new Date(), iso: () => new Date().toISOString() },
    })
    const refreshed = await dynamic.refreshById(source.entity.id, { force: true })
    expect(attributeValue(refreshed!, 'mirror')).toBe('目标标题')
    const view = await db.db.query<{ attrs: Record<string, unknown> }>('select attrs from omb.entity_view where entity_id = $1', [source.entity.id])
    expect(view.rows[0]?.attrs['mirror']).toBe('目标标题')
    await db.close()
  })

  it('动态刷新失败保留旧缓存并记录 last_error', async () => {
    const db = store()
    const targetInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '缓存目标' },
    }
    const target = await db.write(normalized(targetInput), derived(targetInput))
    const sourceInput: WriteEntityInput = {
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'global' },
      attrs: { title: '缓存引用', mirror: { $dynamic: { kind: 'ref', entityId: target.entity.id, attr: 'title' } } },
    }
    const source = await db.write(normalized(sourceInput), derived(sourceInput))
    const ordinal = source.entity.attributes.find(attribute => attribute.name === 'mirror')?.ordinal ?? 0
    const now = new Date().toISOString()
    await db.setAttributeCache(source.entity.id, 'mirror', ordinal, '旧缓存', now)
    await db.setAttributeCache(source.entity.id, 'mirror', ordinal, undefined, now, 'refresh boom')
    const loaded = await db.get(source.entity.id)
    const mirror = loaded?.attributes.find(attribute => attribute.name === 'mirror')?.value
    expect(mirror?.kind).toBe('dynamic')
    expect(mirror?.kind === 'dynamic' ? mirror.cachedValue : undefined).toBe('旧缓存')
    expect(mirror?.kind === 'dynamic' ? mirror.lastError : undefined).toBe('refresh boom')
    await db.close()
  })

  it('动态 ref 支持多跳、必填属性和无 attr 整实体', async () => {
    const db = store()
    const targetInput: WriteEntityInput = {
      kind: 'state', scope: { kind: 'global' }, title: '目标状态', status: 'blocked',
      time: '2026-11-22T00:00:00.000Z', attrs: { body: '目标' },
    }
    const target = await db.write(normalized(targetInput), derived(targetInput))
    const middleInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '中间', mirror: { $dynamic: { kind: 'ref', entityId: target.entity.id, attr: 'title' } } },
    }
    const middle = await db.write(normalized(middleInput), derived(middleInput))
    const sourceInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: {
        title: '源',
        deep: { $dynamic: { kind: 'ref', entityId: middle.entity.id, attr: 'mirror' } },
        whole: { $dynamic: { kind: 'ref', entityId: target.entity.id } },
      },
    }
    const source = await db.write(normalized(sourceInput), derived(sourceInput))
    const dynamic = new DynamicService({
      store: db,
      resolver: new DefaultDynamicResolver(),
      clock: { now: () => new Date(), iso: () => new Date().toISOString() },
    })
    const refreshed = await dynamic.refreshById(source.entity.id, { force: true })
    expect(attributeValue(refreshed!, 'deep')).toBe('目标状态')
    const whole = attributeValue(refreshed!, 'whole')
    expect(whole).toEqual(expect.objectContaining({ title: '目标状态', status: 'blocked' }))
    await db.close()
  })

  it('审计可回滚 patch 与 write', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '回滚前', body: 'A' },
    }
    const written = await db.write(normalized(input), derived(input))
    const patchInput: WriteEntityInput = {
      ...input, id: written.entity.id, pinned: true, confidence: 0.9, origin: 'job',
      attrs: { title: '回滚后', body: 'B' },
    }
    await db.patch(normalized(patchInput), {
      id: written.entity.id,
      expectedRevision: 1,
      pinned: true,
      confidence: 0.9,
      origin: 'job',
    }, derived(patchInput))
    const patched = await db.get(written.entity.id)
    expect(patched?.pinned).toBe(true)
    expect(patched?.confidence).toBe(0.9)
    expect(patched?.origin).toBe('job')
    const audits = await db.listAudit(10, written.entity.id)
    const patchAudit = audits.find(item => item.action === 'patch')
    expect(patchAudit?.id).toBeDefined()
    const rollback = await db.rollback(patchAudit!.id, 'test')
    expect(rollback.applied[0]).toContain('restore')
    const restored = await db.get(written.entity.id)
    expect(attributeValue(restored!, 'title')).toBe('回滚前')
    expect(restored?.pinned).toBe(false)
    expect(restored?.confidence).toBeUndefined()
    expect(restored?.origin).toBe('model')

    const audit = await db.listAudit(20, written.entity.id)
    const writeAudit = audit.find(item => item.action === 'write')
    expect(writeAudit?.id).toBeDefined()
    await db.rollback(writeAudit!.id, 'test')
    expect(await db.get(written.entity.id)).toBeUndefined()
    await db.close()
  })

  it('状态自动归档可由 patch 审计回滚恢复未归档', async () => {
    const db = store()
    const input: WriteEntityInput = {
      kind: 'state', scope: { kind: 'global' }, title: '归档回滚', status: 'in_progress',
      time: '2026-11-22T00:00:00.000Z', attrs: { note: '进行中' },
    }
    const written = await db.write(normalized(input), derived(input))
    const done: WriteEntityInput = { ...input, id: written.entity.id, status: 'completed', attrs: { note: '完成' } }
    await db.patch(normalized(done), { id: written.entity.id, expectedRevision: 1 }, derived(done))
    expect(await db.get(written.entity.id)).toBeUndefined()
    const audits = await db.listAudit(10, written.entity.id)
    const patchAudit = audits.find(item => item.action === 'patch')
    expect(patchAudit?.id).toBeDefined()
    await db.rollback(patchAudit!.id, 'test')
    const restored = await db.get(written.entity.id)
    expect(restored?.archivedAt).toBeUndefined()
    expect(restored?.attributes.find(attribute => attribute.name === 'status')?.value).toEqual({
      kind: 'static',
      value: 'in_progress',
    })
    await db.close()
  })

  it('思维链组成员变更可由 patch 审计回滚', async () => {
    const db = store()
    const leftInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '链左', body: 'A' },
    }
    const rightInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '链右', body: 'B' },
    }
    const left = await db.write(normalized(leftInput), derived(leftInput))
    const right = await db.write(normalized(rightInput), derived(rightInput))
    const chainInput: WriteEntityInput = {
      kind: 'chain', scope: { kind: 'global' }, title: '回滚链', group: [left.entity.id, right.entity.id],
    }
    const chain = await db.write(normalized(chainInput), derived(chainInput))
    const next: WriteEntityInput = { ...chainInput, id: chain.entity.id, group: [left.entity.id] }
    await db.patch(normalized(next), { id: chain.entity.id, expectedRevision: 1 }, derived(next))
    expect((await db.expand([left.entity.id], 1)).some(item => item.entityId === right.entity.id && item.chainId === chain.entity.id)).toBe(false)
    const audits = await db.listAudit(10, chain.entity.id)
    const patchAudit = audits.find(item => item.action === 'patch')
    expect(patchAudit?.id).toBeDefined()
    await db.rollback(patchAudit!.id, 'test')
    expect((await db.expand([left.entity.id], 1)).some(item => item.entityId === right.entity.id && item.chainId === chain.entity.id)).toBe(true)
    await db.close()
  })

  it('相似属性与相似记忆在写入时返回', async () => {
    const db = store()
    const first: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: 'Postgres 配置', body: '连接串与迁移' },
    }
    await db.write(normalized(first), derived(first))
    const second: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: 'Postgres 配置记录', body: '连接串与迁移说明' },
    }
    const written = await db.write(normalized(second), derived(second))
    expect(written.similarEntities.length).toBeGreaterThan(0)
    expect(written.similarAttributes.length).toBeGreaterThan(0)
    const unrelated: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '天气记录', body: '今天下雨' },
    }
    const weather = await db.write(normalized(unrelated), derived(unrelated))
    expect(weather.similarEntities).toEqual([])
    await db.close()
  })
})
