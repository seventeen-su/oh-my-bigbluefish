import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../packages/v7/src/adapters/dynamic/index.js'
import { PostgresMaintenance } from '../../../packages/v7/src/adapters/postgres/maintenance.js'
import { DynamicService } from '../../../packages/v7/src/app/dynamic.js'
import { UpdateService } from '../../../packages/v7/src/app/update.js'
import { DEFAULT_MAX_DEPENDENCY_DEPTH } from '../../../packages/v7/src/domain/dependency.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import { handleRefresh } from '../../../packages/v7/src/jobs/consolidate.js'
import type { ConsolidationDeps } from '../../../packages/v7/src/jobs/consolidate.js'
import type { DynamicResolver } from '../../../packages/v7/src/ports/dynamic.js'
import { derived, normalized, prepareDatabase, resetDatabase, store } from './helpers.js'

/**
 * 引用依赖失效（真实 PostgreSQL）：
 * - 写事务维护 `omb.dynamic_dependency` 边，并在 target 更新时只沿入边标记依赖方；
 * - 链 A→B→C（传播方向）里更新 B 只标记 C，不相关 D 不受影响；
 * - 级联深度、去重、link 边、归档清理、事件驱动 refresh 都走真实表。
 *
 * 不变量：测试只调用真实方法/直接读表，不使用 sleep 轮询。
 */

const clock = { now: () => new Date(), iso: () => new Date().toISOString() }

interface StaleRow {
  entity_id: string
  attr_name: string
  depth: number
  reason: string
  operation: string
}

function dynamicService(db: ReturnType<typeof store>, resolver: DynamicResolver = new DefaultDynamicResolver()): DynamicService {
  return new DynamicService({ store: db, resolver, clock })
}

async function write(db: ReturnType<typeof store>, input: WriteEntityInput) {
  return db.write(normalized(input), derived(input))
}

/**
 * 状态 CAS 之后更新必须带 expectedRevision：测试按读到的当前版本构造 patch。
 * 直接传 undefined 会被 writer 以 invalid-input 拒绝（不允许无条件覆盖）。
 */
async function applyPatch(db: ReturnType<typeof store>, input: WriteEntityInput) {
  const id = input.id
  if (id === undefined) throw new Error('patch 测试输入必须带 id')
  const current = await db.get(id)
  if (current === undefined) throw new Error(`实体不存在：${id}`)
  return db.patch(normalized(input), { id, expectedRevision: current.revision }, derived(input))
}

async function staleRows(db: ReturnType<typeof store>): Promise<StaleRow[]> {
  const result = await db.db.query<StaleRow>(
    `select entity_id, attr_name, depth, reason, operation
     from omb.dynamic_stale
     order by depth asc, entity_id asc, attr_name asc`,
  )
  return result.rows
}

async function marksOf(db: ReturnType<typeof store>, entityId: string) {
  return db.dependencyMarks(entityId)
}

function depsOf(db: ReturnType<typeof store>, dynamic: DynamicService): ConsolidationDeps {
  return {
    store: db,
    queries: new PostgresMaintenance(db.db),
    updateService: new UpdateService({ store: db }),
    clock,
    dynamic,
  }
}

function refSpec(entityId: string, attr = 'title') {
  return { $dynamic: { kind: 'ref' as const, entityId, attr } }
}

beforeAll(async () => {
  await prepareDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

describe('引用依赖失效（写事务 + 事件驱动刷新）', () => {
  it('给定 015 迁移当查 schema 则依赖边/标记表与入边索引存在', async () => {
    const db = store()
    const tables = await db.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'omb' and table_name in ('dynamic_dependency', 'dynamic_stale')
       order by table_name`,
    )
    expect(tables.rows.map(row => row.table_name)).toEqual(['dynamic_dependency', 'dynamic_stale'])
    const indexes = await db.db.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'omb' and indexname in ('dynamic_dependency_target', 'dynamic_dependency_source', 'dynamic_stale_root')
       order by indexname`,
    )
    expect(indexes.rows.map(row => row.indexname)).toEqual([
      'dynamic_dependency_source',
      'dynamic_dependency_target',
      'dynamic_stale_root',
    ])
    const columns = await db.db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'omb' and table_name in ('dynamic_dependency', 'dynamic_stale')
       order by table_name, ordinal_position`,
    )
    const signature = columns.rows.map(row => `${row.table_name}.${row.column_name}:${row.data_type}`)
    expect(signature).toContain('dynamic_dependency.origin:text')
    expect(signature).toContain('dynamic_dependency.relation:text')
    expect(signature).toContain('dynamic_stale.root_entity_id:text')
    expect(signature).toContain('dynamic_stale.depth:integer')
    await db.close()
  })

  it('给定引用链 A→B→C（传播方向）当更新 B 则只标记直接下游 C，不相关 D 不受影响', async () => {
    const db = store()
    const dynamic = dynamicService(db)
    const a = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: 'A' } })
    const bInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'B', mirror: refSpec(a.entity.id) },
    }
    const b = await write(db, bInput)
    const cInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'C', mirror: refSpec(b.entity.id) },
    }
    const c = await write(db, cInput)
    const dInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'D', mirror: refSpec(a.entity.id) },
    }
    const d = await write(db, dInput)
    // 先让 B/C/D 都有缓存：之后 B 的更新才可能让 C 的旧缓存失效。
    await dynamic.refreshById(b.entity.id, { force: true })
    await dynamic.refreshById(c.entity.id, { force: true })
    await dynamic.refreshById(d.entity.id, { force: true })

    const edges = await db.db.query<{ source_entity_id: string; target_entity_id: string; origin: string }>(
      'select source_entity_id, target_entity_id, origin from omb.dynamic_dependency order by source_entity_id',
    )
    expect(edges.rows).toEqual(expect.arrayContaining([
      { source_entity_id: b.entity.id, target_entity_id: a.entity.id, origin: 'reference' },
      { source_entity_id: c.entity.id, target_entity_id: b.entity.id, origin: 'reference' },
      { source_entity_id: d.entity.id, target_entity_id: a.entity.id, origin: 'reference' },
    ]))

    const patched: WriteEntityInput = {
      ...bInput,
      id: b.entity.id,
      attrs: { title: 'B2', mirror: refSpec(a.entity.id) },
    }
    await applyPatch(db, patched)

    const cMarks = await marksOf(db, c.entity.id)
    expect(cMarks).toHaveLength(1)
    const cMirrorOrdinal = c.entity.attributes.find(attribute => attribute.name === 'mirror')?.ordinal ?? 0
    expect(cMarks[0]).toMatchObject({
      attrName: 'mirror',
      ordinal: cMirrorOrdinal,
      depth: 0,
      operation: 'patch',
      reason: `dependency:patch:${b.entity.id}`,
    })
    // A 是 B 的依赖（出边方向），不是 B 的下游；D 引用 A 与 B 无关。
    expect(await marksOf(db, a.entity.id)).toEqual([])
    expect(await marksOf(db, d.entity.id)).toEqual([])

    // 旧缓存仍在库里（失败不清缓存），但读取前必须先消费标记。
    const cBefore = await db.get(c.entity.id)
    expect(cBefore?.attributes.find(item => item.name === 'mirror')?.value.kind).toBe('dynamic')

    const result = await handleRefresh(depsOf(db, dynamic), { dependencyRoot: b.entity.id })
    expect(result.refreshed).toBeGreaterThanOrEqual(1)
    const cAfter = await db.get(c.entity.id)
    const mirror = cAfter?.attributes.find(item => item.name === 'mirror')?.value
    expect(mirror?.kind === 'dynamic' ? mirror.cachedValue : undefined).toBe('B2')
    expect(await marksOf(db, c.entity.id)).toEqual([])
    expect(await marksOf(db, d.entity.id)).toEqual([])
    await db.close()
  })

  it('给定超过最大深度当级联则标记到 depth-limit 并停止，刷新顺序按 depth 优先', async () => {
    const db = store()
    const dynamic = dynamicService(db)
    const root = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: 'R0' } })
    const chain: string[] = []
    let previous = root.entity.id
    for (let index = 1; index <= DEFAULT_MAX_DEPENDENCY_DEPTH + 3; index += 1) {
      const input: WriteEntityInput = {
        kind: 'memory', category: 'fact', scope: { kind: 'global' },
        attrs: { title: `N${index}`, mirror: refSpec(previous) },
      }
      const written = await write(db, input)
      chain.push(written.entity.id)
      previous = written.entity.id
    }

    const patched: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      id: root.entity.id,
      attrs: { title: 'R1' },
    }
    await applyPatch(db, patched)

    const rows = await staleRows(db)
    // 正常级联深度 0..maxDepth；下一层（depth=maxDepth+1）标记为 cascade-depth-exceeded 后停止。
    expect(rows.map(row => row.depth)).toEqual([
      0, 1, 2, 3, DEFAULT_MAX_DEPENDENCY_DEPTH, DEFAULT_MAX_DEPENDENCY_DEPTH + 1,
    ])
    expect(rows.slice(0, DEFAULT_MAX_DEPENDENCY_DEPTH + 1).every(row => row.reason === `dependency:patch:${root.entity.id}`)).toBe(true)
    expect(rows.at(-1)?.reason).toBe(`dependency:patch:${root.entity.id}:cascade-depth-exceeded`)
    // 更深的一层不再有标记。
    expect(rows.some(row => row.entity_id === chain[DEFAULT_MAX_DEPENDENCY_DEPTH + 2])).toBe(false)

    // 事件驱动 refresh 的目标顺序：直接依赖优先（depth 0..N 递增）。
    const maintenance = new PostgresMaintenance(db.db)
    const targets = await maintenance.dependencyTargets(root.entity.id, 200)
    expect(targets.map(target => target.depth)).toEqual([0, 1, 2, 3, DEFAULT_MAX_DEPENDENCY_DEPTH, DEFAULT_MAX_DEPENDENCY_DEPTH + 1])

    const result = await handleRefresh(depsOf(db, dynamic), { dependencyRoot: root.entity.id, limit: 200 })
    expect(result.refreshed).toBe(DEFAULT_MAX_DEPENDENCY_DEPTH + 2)
    expect(await staleRows(db)).toEqual([])
    await db.close()
  })

  it('给定多次 patch 与同优先级目标当刷新队列则按实体去重、最近访问优先', async () => {
    const db = store()
    const dynamic = dynamicService(db)
    const target = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: 'T' } })
    const first = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'X', mirror: refSpec(target.entity.id) },
    })
    const second = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: 'Y', mirror: refSpec(target.entity.id) },
    })
    await dynamic.refreshById(first.entity.id, { force: true })
    await dynamic.refreshById(second.entity.id, { force: true })

    const input: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      id: target.entity.id,
      attrs: { title: 'T2' },
    }
    await applyPatch(db, input)
    const input3: WriteEntityInput = { ...input, attrs: { title: 'T3' } }
    await applyPatch(db, input3)

    // 同一属性被两次 root 更新命中：PK 去重后仍只有一行，depth 取最小。
    const rows = await staleRows(db)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.depth === 0)).toBe(true)

    // 同 depth、同 marked_at 时，最近访问的实体先刷新。
    await db.markAccessed?.([second.entity.id])
    const maintenance = new PostgresMaintenance(db.db)
    const targets = await maintenance.dependencyTargets(target.entity.id, 20)
    expect(targets.map(targetRow => targetRow.entityId)).toEqual([second.entity.id, first.entity.id])
    await db.close()
  })

  it('给定 link 边当取消链接/归档 source/取消归档则同步清理与重建依赖边', async () => {
    const db = store()
    const dynamic = dynamicService(db)
    const aInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '链接源' },
    }
    const a = await write(db, aInput)
    const b = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '链接目标' },
    })
    // 源实体需要动态属性：link 边失效时标记它的全部动态属性。
    const aWithDynamic: WriteEntityInput = {
      ...aInput,
      id: a.entity.id,
      attrs: { title: '链接源', mirror: refSpec(b.entity.id) },
    }
    await applyPatch(db, aWithDynamic)
    await dynamic.refreshById(a.entity.id, { force: true })
    const linked = await db.link({ fromId: a.entity.id, toId: b.entity.id, relation: 'related_to' })

    const linkEdges = await db.db.query<{ count: string }>(
      "select count(*)::text as count from omb.dynamic_dependency where origin = 'link' and source_entity_id = $1",
      [a.entity.id],
    )
    expect(Number(linkEdges.rows[0]?.count ?? 0)).toBe(1)
    // 同一实体既有 reference 边又有 link 边：同属性只落一条 stale 标记。
    const patchB: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      id: b.entity.id, attrs: { title: '链接目标2' },
    }
    await applyPatch(db, patchB)
    expect(await marksOf(db, a.entity.id)).toHaveLength(1)

    // unlink（link 软归档）→ link 边删除；reference 边仍保留。
    await db.unlink(linked.link.id, 'test')
    const afterUnlink = await db.db.query<{ origin: string }>(
      'select origin from omb.dynamic_dependency where source_entity_id = $1 order by origin',
      [a.entity.id],
    )
    expect(afterUnlink.rows.map(row => row.origin)).toEqual(['reference'])

    // 归档 source 清理它的出边与自身标记；取消归档按属性重建 reference 边。
    await dynamic.refreshById(a.entity.id, { force: true })
    await db.archive(a.entity.id, 'test', 'test')
    const outgoing = await db.db.query<{ count: string }>(
      "select count(*)::text as count from omb.dynamic_dependency where source_entity_id = $1",
      [a.entity.id],
    )
    expect(Number(outgoing.rows[0]?.count ?? 0)).toBe(0)
    expect(await marksOf(db, a.entity.id)).toEqual([])

    await db.unarchive(a.entity.id, 'test', 'test')
    const rebuilt = await db.db.query<{ origin: string; target_entity_id: string }>(
      'select origin, target_entity_id from omb.dynamic_dependency where source_entity_id = $1',
      [a.entity.id],
    )
    expect(rebuilt.rows).toEqual([{ origin: 'reference', target_entity_id: b.entity.id }])
    await db.close()
  })

  it('给定目标实体物理删除当查依赖表则由外键级联清理边', async () => {
    const db = store()
    const target = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '删除目标' } })
    const source = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '删除源', mirror: refSpec(target.entity.id) },
    })
    // 生产路径只归档不物理删除；这里验证 FK 对真实删除（truncate/未来清理）的级联契约。
    await db.db.query('delete from omb.reference where target_entity_id = $1', [target.entity.id])
    await db.db.query('delete from omb.entity where id = $1', [target.entity.id])
    const edges = await db.db.query<{ count: string }>(
      'select count(*)::text as count from omb.dynamic_dependency where source_entity_id = $1 or target_entity_id = $2',
      [source.entity.id, target.entity.id],
    )
    expect(Number(edges.rows[0]?.count ?? 0)).toBe(0)
    await db.close()
  })

  it('给定依赖刷新解析为空当刷新则清除旧缓存并清除标记，不把旧值当成新结果', async () => {
    const db = store()
    const target = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '空目标' } })
    const sourceInput: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '空解析源', mirror: refSpec(target.entity.id, 'missing') },
    }
    const source = await write(db, sourceInput)
    const ordinal = source.entity.attributes.find(attribute => attribute.name === 'mirror')?.ordinal ?? 0
    await db.setAttributeCache(source.entity.id, 'mirror', ordinal, '旧缓存', new Date().toISOString())
    const patch: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      id: target.entity.id, attrs: { title: '空目标2' },
    }
    await applyPatch(db, patch)
    expect(await marksOf(db, source.entity.id)).toHaveLength(1)

    const refreshed = await dynamicService(db).refreshById(source.entity.id)
    const mirror = refreshed?.attributes.find(attribute => attribute.name === 'mirror')?.value
    expect(mirror?.kind).toBe('dynamic')
    if (mirror?.kind !== 'dynamic') throw new Error('missing dynamic attribute')
    expect(mirror.cachedValue).toBeUndefined()
    expect(await marksOf(db, source.entity.id)).toEqual([])
    const persisted = await db.get(source.entity.id)
    const persistedMirror = persisted?.attributes.find(attribute => attribute.name === 'mirror')?.value
    expect(persistedMirror?.kind === 'dynamic' ? persistedMirror.cachedValue : undefined).toBeUndefined()
    await db.close()
  })

  it('给定依赖刷新失败当读取则返回 staleReason 且不暴露旧缓存，恢复后可刷新', async () => {
    const db = store()
    const target = await write(db, { kind: 'memory', category: 'fact', scope: { kind: 'global' }, attrs: { title: '旧标题' } })
    const source = await write(db, {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      attrs: { title: '依赖失败', mirror: refSpec(target.entity.id) },
    })
    const dynamic = dynamicService(db)
    await dynamic.refreshById(source.entity.id, { force: true })
    const patch: WriteEntityInput = {
      kind: 'memory', category: 'fact', scope: { kind: 'global' },
      id: target.entity.id, attrs: { title: '新标题' },
    }
    await applyPatch(db, patch)
    expect(await marksOf(db, source.entity.id)).toHaveLength(1)

    const failing: DynamicResolver = {
      async resolve() {
        throw new Error('boom')
      },
    }
    const failed = await dynamicService(db, failing).refreshById(source.entity.id)
    const failedMirror = failed?.attributes.find(item => item.name === 'mirror')?.value
    expect(failedMirror?.kind).toBe('dynamic')
    if (failedMirror?.kind !== 'dynamic') throw new Error('missing dynamic attribute')
    expect(failedMirror.cachedValue).toBeUndefined()
    expect(failedMirror.staleReason).toBe(`dependency:patch:${target.entity.id}`)
    expect(failedMirror.lastError).toContain('boom')
    // 数据库仍保留旧缓存（失败不清旧值），标记也保留等待重试。
    expect(await marksOf(db, source.entity.id)).toHaveLength(1)
    const persisted = await db.get(source.entity.id)
    const persistedMirror = persisted?.attributes.find(item => item.name === 'mirror')?.value
    expect(persistedMirror?.kind === 'dynamic' ? persistedMirror.cachedValue : undefined).toBe('旧标题')

    const recovered = await dynamic.refreshById(source.entity.id)
    const recoveredMirror = recovered?.attributes.find(item => item.name === 'mirror')?.value
    expect(recoveredMirror?.kind === 'dynamic' ? recoveredMirror.cachedValue : undefined).toBe('新标题')
    expect(await marksOf(db, source.entity.id)).toEqual([])
    await db.close()
  })
})
