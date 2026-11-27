import { describe, expect, it } from 'vitest'
import { createBoardReader } from '../../../packages/v7/src/adapters/postgres/projection.js'
import type { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import {
  ProjectionReadApi,
} from '../../../packages/v7/src/app/projections/index.js'
import type {
  BoardItem,
} from '../../../packages/v7/src/app/projections/types.js'
import type {
  BoardQuery,
  BoardReader,
} from '../../../packages/v7/src/app/projections/read.js'
import type {
  ProjectionTaskStore,
} from '../../../packages/v7/src/app/projections/tasks.js'
import type { Clock } from '../../../packages/v7/src/ports/clock.js'
import type { EntitySummary } from '../../../packages/v7/src/ports/search.js'
import type { StoreStats } from '../../../packages/v7/src/ports/observability.js'
import { buildResident, type ResidentBoardsReader } from '../../../packages/v7/src/recall/resident.js'
import type { RecallEngine } from '../../../packages/v7/src/retrieval/engine.js'
import type { RecallHit, RecallResult } from '../../../packages/v7/src/retrieval/types.js'

/**
 * T0 读投影看板的单元证据（不依赖 PostgreSQL）。
 *
 * 覆盖：优先读模型、状态只保留三类、两块都空/失败/超时回退写模型、trace 预算与
 * 来源标注、“用 boards 时恰好两条 SQL（不查 lag）”，以及水位停摆（worker 挂着时
 * 读模型会静默变旧）只在“超龄 **且** 还有未投影任务”时回退。
 * 真实 PG 的看板回填/投影由 integration/projection-wiring.test.ts 证明；
 * plugin 的注入接线由 integration/plugin.test.ts 证明。
 */

const PREFERENCE_BOARD_TITLE = '偏好：先写测试再改实现'
const STATE_TITLES = ['进行中的状态', '等待中的状态', '阻塞中的状态'] as const

function nowIso(): string {
  return '2026-01-01T00:00:00.000Z'
}

function boardPreference(entityId = 'mem_board_pref', title = PREFERENCE_BOARD_TITLE): BoardItem {
  return { entityId, title, summary: '看板摘要', salience: 0.9, revision: 3, updatedAt: nowIso() }
}

function boardState(entityId: string, status: BoardItem['status'], title?: string): BoardItem {
  return {
    entityId,
    ...(title === undefined ? {} : { title }),
    ...(status === undefined ? {} : { status }),
    projectKey: '/workspace',
    revision: 2,
    updatedAt: nowIso(),
  }
}

/** 读模型两块看板的替身：记录每次 readBoard，便于断言 T0 只读两次、且不读其它通道。 */
class FakeBoards implements BoardReader {
  readonly reads: BoardQuery[] = []

  constructor(
    private readonly rows: {
      readonly preference?: readonly BoardItem[]
      readonly state?: readonly BoardItem[]
      readonly error?: Error
    },
  ) {}

  async readBoard(query: BoardQuery): Promise<readonly BoardItem[]> {
    this.reads.push(query)
    if (this.rows.error !== undefined) throw this.rows.error
    return query.kind === 'preference' ? (this.rows.preference ?? []) : (this.rows.state ?? [])
  }

  async readBoardRow(): Promise<BoardItem | undefined> {
    throw new Error('T0 不应按实体读看板行')
  }

  async deriveFromWriteModel(): Promise<readonly BoardItem[]> {
    throw new Error('T0 不应从写模型派生看板')
  }
}

function clockOf(): Clock {
  return { now: () => new Date(nowIso()), iso: () => nowIso() }
}

function taskStoreOf(onLag: () => void = () => {}): ProjectionTaskStore {
  return {
    lag: async () => {
      onLag()
      return []
    },
  } as unknown as ProjectionTaskStore
}

function readApiOf(boards: BoardReader, onLag?: () => void): ProjectionReadApi {
  return new ProjectionReadApi({ store: taskStoreOf(onLag), boards, clock: clockOf() })
}

/** 一片看板的新鲜度：水位年龄 + 仍未投影的源行数（由读模型实现方提供）。 */
interface FakeFreshness {
  readonly watermarkAgeMs?: number
  readonly unprojected: number
}

/** 直接返回快照的读取器：只测 resident.ts 的停摆判定，不经过 ProjectionReadApi 的 SQL。 */
function boardsReaderOf(input: {
  readonly preference?: readonly BoardItem[]
  readonly state?: readonly BoardItem[]
  readonly preferenceFreshness?: FakeFreshness
  readonly stateFreshness?: FakeFreshness
}): ResidentBoardsReader {
  return {
    readResidentBoards: async () => ({
      preference: input.preference ?? [],
      state: input.state ?? [],
      ...(input.preferenceFreshness === undefined ? {} : { preferenceFreshness: input.preferenceFreshness }),
      ...(input.stateFreshness === undefined ? {} : { stateFreshness: input.stateFreshness }),
    }),
  }
}

const stateHit: RecallHit = {
  entityId: 'st_fallback_0123456789abcdef0123',
  kind: 'state',
  title: '回退状态标题',
  snippet: '进行中',
  status: 'in_progress',
  scope: { kind: 'project', projectKey: '/workspace' },
  updatedAt: nowIso(),
  score: 1,
  fusedScore: 0.02,
  why: ['test'],
  channels: ['state_board'],
  rawScores: { state_board: 1 },
  chainSiblings: [],
  historyCount: 0,
}

function stateResult(): RecallResult {
  return {
    traceId: 'trc_fallback_state',
    configVersion: 'test',
    scenario: 'session-start',
    query: '当前项目 进行中 阻塞中',
    hits: [stateHit],
    channelErrors: [],
    channels: [],
    expansion: { seeds: 1, expanded: 0, chains: 0 },
    warnings: [],
  }
}

const preferenceSummary: EntitySummary = {
  id: 'mem_fallback_pref',
  kind: 'memory',
  title: '回退偏好标题',
  category: 'fact',
  scope: { kind: 'global' },
  snippet: '回退偏好摘要',
  archived: false,
  isCurrent: true,
  updatedAt: nowIso(),
  historyCount: 0,
}

function statsOf(): StoreStats {
  return {
    memory: 3,
    state: 2,
    chain: 1,
    archived: 1,
    attrNames: ['title', 'body', 'tags'],
    categories: { fact: 2, clue: 1, event: 0 },
    scopes: { global: 2, project: 1 },
    recentStates: [{ id: stateHit.entityId, title: '回退状态标题', status: 'in_progress' }],
  }
}

interface EngineProbe {
  readonly engine: RecallEngine
  readonly calls: number
}

function engineProbe(result: RecallResult | undefined): EngineProbe {
  const probe = {
    calls: 0,
    engine: {} as RecallEngine,
  }
  probe.engine = {
    async recall() {
      probe.calls += 1
      if (result === undefined) throw new Error('boards 命中时不应跑六通道召回')
      return result
    },
  } as unknown as RecallEngine
  return probe
}

function contextOf(): { sessionId: string; cwd: string; projectKey: string } {
  return { sessionId: 'session-resident-boards', cwd: '/workspace', projectKey: '/workspace' }
}

describe('T0 读投影看板', () => {
  it('给定两块看板都有行当构建常驻文本则只用读模型并标 read-model', async () => {
    const boards = new FakeBoards({
      preference: [boardPreference()],
      state: [
        boardState('st_in_progress', 'in_progress', STATE_TITLES[0]),
        boardState('st_waiting', 'waiting', STATE_TITLES[1]),
        boardState('st_blocked', 'blocked', STATE_TITLES[2]),
        // 看板 SQL 不会返回 completed，但 T0 仍要兜底过滤，避免脏读模型把已完成状态注入。
        boardState('st_completed', 'completed', '已完成不应注入'),
      ],
    })
    const engine = engineProbe(undefined)
    let statsCalls = 0
    let preferenceCalls = 0
    let lagCalls = 0
    const api = readApiOf(boards, () => {
      lagCalls += 1
    })

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => {
        statsCalls += 1
        return statsOf()
      },
      undefined,
      async () => {
        preferenceCalls += 1
        return [preferenceSummary]
      },
      { reader: api },
    )

    expect(built.text).toContain('[OMB 常驻]')
    expect(built.text).toContain(PREFERENCE_BOARD_TITLE)
    expect(built.text).toContain(`[in_progress] ${STATE_TITLES[0]}`)
    expect(built.text).toContain(`[waiting] ${STATE_TITLES[1]}`)
    expect(built.text).toContain(`[blocked] ${STATE_TITLES[2]}`)
    expect(built.text).not.toContain('已完成不应注入')
    expect(built.text).not.toContain('常用属性')
    expect(built.trace.usedTokens).toBeLessThanOrEqual(600)
    expect(built.trace.droppedSections).toEqual([])

    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    const stateSection = built.trace.sections.find(section => section.name === 'states')
    expect(preferenceSection).toMatchObject({ kept: true, source: 'read-model' })
    expect(stateSection).toMatchObject({ kept: true, source: 'read-model' })
    expect(preferenceSection?.fallbackReason).toBeUndefined()
    expect(stateSection?.fallbackReason).toBeUndefined()
    expect(built.trace.sections.some(section => section.name === 'index')).toBe(false)
    expect(built.preferenceHits).toEqual([{ id: 'mem_board_pref', title: PREFERENCE_BOARD_TITLE }])
    expect(built.stateHits.map(hit => hit.id)).toEqual(['st_in_progress', 'st_waiting', 'st_blocked'])

    // 读模型命中时：两块看板各读一次，不跑六通道、不查 stats、不查 lag。
    expect(boards.reads.map(query => query.kind)).toEqual(['preference', 'state'])
    expect(engine.calls).toBe(0)
    expect(statsCalls).toBe(0)
    expect(preferenceCalls).toBe(0)
    expect(lagCalls).toBe(0)
  })

  it('给定只有偏好看板有行当构建常驻文本则仍用读模型（状态为空不触发回退）', async () => {
    const boards = new FakeBoards({ preference: [boardPreference()], state: [] })
    const engine = engineProbe(undefined)

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      undefined,
      undefined,
      undefined,
      { reader: readApiOf(boards) },
    )

    expect(built.text).toContain(PREFERENCE_BOARD_TITLE)
    expect(built.trace.sections.some(section => section.name === 'states')).toBe(false)
    expect(built.trace.sections.find(section => section.name === 'preferences')?.source).toBe('read-model')
    expect(built.stateHits).toEqual([])
    expect(engine.calls).toBe(0)
  })

  it('给定读模型两块都为空当构建常驻文本则回退写模型并在 trace 标回退原因', async () => {
    const boards = new FakeBoards({ preference: [], state: [] })
    const engine = engineProbe(stateResult())
    let statsCalls = 0
    const notices: string[] = []

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => {
        statsCalls += 1
        return statsOf()
      },
      notice => notices.push(notice.traceId),
      async () => [preferenceSummary],
      { reader: readApiOf(boards) },
    )

    // 回退路径仍按旧优先级组装：偏好、状态、索引、工具提示。
    expect(built.text).toContain(`偏好：${preferenceSummary.title}`)
    expect(built.text).toContain(stateHit.title ?? '')
    expect(built.text).toContain('常用属性')
    expect(engine.calls).toBe(1)
    expect(statsCalls).toBe(1)

    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    const stateSection = built.trace.sections.find(section => section.name === 'states')
    expect(preferenceSection).toMatchObject({
      kept: true,
      source: 'write-model',
      fallbackReason: 'read-model-empty',
    })
    expect(stateSection).toMatchObject({
      kept: true,
      source: 'write-model',
      fallbackReason: 'read-model-empty',
    })
    expect(built.trace.sections.filter(section => section.name === 'index').length).toBeGreaterThan(0)
    expect(built.preferenceHits).toEqual([{ id: preferenceSummary.id, title: preferenceSummary.title }])
    // 回退路径的状态由 engine.recall 自己写 recall_event，不在 build 结果里重复登记。
    expect(built.stateHits).toEqual([])
    expect(notices).toEqual(['trc_fallback_state'])
  })

  it('给定读模型抛错当构建常驻文本则回退写模型并把错误写进 trace', async () => {
    const boards = new FakeBoards({ error: new Error('投影连接中断：ECONNRESET') })
    const engine = engineProbe(stateResult())

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => statsOf(),
      undefined,
      async () => [preferenceSummary],
      { reader: readApiOf(boards) },
    )

    expect(built.text).toContain('常用属性')
    expect(engine.calls).toBe(1)
    const stateSection = built.trace.sections.find(section => section.name === 'states')
    expect(stateSection?.source).toBe('write-model')
    expect(stateSection?.fallbackReason).toBe('read-model-error: 投影连接中断：ECONNRESET')
  })

  it('给定读模型超时当构建常驻文本则按写模型回退', async () => {
    const never = new Promise<readonly BoardItem[]>(() => {})
    const slowBoards: BoardReader = {
      async readBoard() {
        return never
      },
      async readBoardRow() {
        return undefined
      },
      async deriveFromWriteModel() {
        return []
      },
    }
    const engine = engineProbe(stateResult())

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => statsOf(),
      undefined,
      async () => [preferenceSummary],
      { reader: readApiOf(slowBoards), timeoutMs: 5 },
    )

    expect(built.text).toContain(stateHit.title ?? '')
    expect(engine.calls).toBe(1)
    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    expect(preferenceSection?.fallbackReason).toBe('read-model-timeout')
  })

  it('给定读模型内容超预算当构建常驻文本则仍按预算裁剪并记录 dropped', async () => {
    const longTitle = '偏好长标题'.repeat(40)
    const boards = new FakeBoards({
      preference: [boardPreference('mem_long_pref', longTitle)],
      state: [boardState('st_short', 'in_progress', '短状态')],
    })

    const built = await buildResident(
      engineProbe(undefined).engine,
      contextOf(),
      60,
      undefined,
      undefined,
      undefined,
      { reader: readApiOf(boards) },
    )

    expect(built.trace.budgetTokens).toBe(60)
    expect(built.trace.usedTokens).toBeLessThanOrEqual(60)
    expect(built.text).not.toContain(longTitle)
    expect(built.text).toContain('短状态')
    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    expect(preferenceSection).toMatchObject({ kept: false, source: 'read-model' })
    expect(built.trace.droppedSections).toContain('preferences')
    expect(built.preferenceHits).toEqual([])
  })

  it('给定两块看板当 T0 读取则只发两条 SQL 且不查 lag', async () => {
    const preferenceRow = {
      entity_id: 'mem_board_pref',
      title: PREFERENCE_BOARD_TITLE,
      summary: '看板摘要',
      salience: 0.9,
      revision: '3',
      updated_at: nowIso(),
    }
    const stateRow = {
      entity_id: 'st_board_state',
      title: STATE_TITLES[0],
      status: 'in_progress',
      project_key: '/workspace',
      event_time: nowIso(),
      revision: '2',
      updated_at: nowIso(),
    }
    const queries: string[] = []
    // 真实 BoardReader 实现 + 记账的假执行器：每条 readBoard 恰好一条 SQL。
    const fakeDb = {
      query: async (text: string) => {
        queries.push(text)
        if (text.includes('preference_board')) return { rows: [preferenceRow] }
        if (text.includes('state_board')) return { rows: [stateRow] }
        return { rows: [] }
      },
    } as unknown as PostgresDb
    let lagCalls = 0
    const api = new ProjectionReadApi({
      store: taskStoreOf(() => {
        lagCalls += 1
      }),
      boards: createBoardReader(fakeDb),
      clock: clockOf(),
    })

    const snapshot = await api.readResidentBoards({ projectKey: '/workspace', preferenceLimit: 5, stateLimit: 5 })
    expect(queries).toHaveLength(2)
    expect(queries.filter(text => text.includes('projection_task') || text.includes('projection_watermark'))).toEqual([])
    expect(lagCalls).toBe(0)
    expect(snapshot.preference[0]).toMatchObject({ entityId: 'mem_board_pref', revision: 3 })
    expect(snapshot.state[0]).toMatchObject({ entityId: 'st_board_state', status: 'in_progress' })

    // 没有项目键时只需一条偏好 SQL：不发明知为空的“当前项目状态”查询。
    queries.length = 0
    const preferenceOnly = await api.readResidentBoards()
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('preference_board')
    expect(preferenceOnly.state).toEqual([])

    // 同一条读路径接进 buildResident：T0 全程仍是两条 SQL，不跑 engine/stats。
    const engine = engineProbe(undefined)
    queries.length = 0
    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => {
        throw new Error('读模型命中时不应查 stats')
      },
      undefined,
      async () => {
        throw new Error('读模型命中时不应查偏好写模型')
      },
      { reader: api },
    )
    expect(queries).toHaveLength(2)
    expect(built.text).toContain(PREFERENCE_BOARD_TITLE)
    expect(engine.calls).toBe(0)
  })

  it('给定看板水位超龄且仍有未投影任务当构建常驻文本则回退写模型并标 fallbackReason', async () => {
    const boards = boardsReaderOf({
      preference: [boardPreference()],
      preferenceFreshness: { watermarkAgeMs: 120_000, unprojected: 2 },
    })
    const engine = engineProbe(stateResult())

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => statsOf(),
      undefined,
      async () => [preferenceSummary],
      { reader: boards },
    )

    // 停摆时读模型的行还在、但已经不新：必须换成写模型，而不是静默注入旧值。
    expect(built.text).toContain(`偏好：${preferenceSummary.title}`)
    expect(built.text).toContain('库索引')
    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    expect(preferenceSection).toMatchObject({ kept: true, source: 'write-model' })
    expect(preferenceSection?.fallbackReason).toBe(
      'read-model-watermark-stale: preference_board watermarkAgeMs=120000 unprojected=2',
    )
    expect(built.preferenceHits).toEqual([{ id: preferenceSummary.id, title: preferenceSummary.title }])
  })

  it('给定水位超龄但没有未投影任务当构建常驻文本则仍用读模型（空闲不是停摆）', async () => {
    // 长时间没有写入时水位同样很老，但读模型并没有落后：这时回退只是白花查询。
    const boards = boardsReaderOf({
      preference: [boardPreference()],
      preferenceFreshness: { watermarkAgeMs: 3_600_000, unprojected: 0 },
    })
    const engine = engineProbe(undefined)

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      undefined,
      undefined,
      undefined,
      { reader: boards },
    )

    expect(built.text).toContain(PREFERENCE_BOARD_TITLE)
    expect(built.trace.sections.find(section => section.name === 'preferences')).toMatchObject({
      kept: true,
      source: 'read-model',
    })
    expect(built.trace.sections.some(section => section.fallbackReason !== undefined)).toBe(false)
    expect(engine.calls).toBe(0)
  })

  it('给定水位未超龄但仍有待投影任务当构建常驻文本则仍用读模型（正常在途）', async () => {
    const boards = boardsReaderOf({
      preference: [boardPreference()],
      preferenceFreshness: { watermarkAgeMs: 5_000, unprojected: 3 },
    })
    const engine = engineProbe(undefined)

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      undefined,
      undefined,
      undefined,
      { reader: boards },
    )

    expect(built.text).toContain(PREFERENCE_BOARD_TITLE)
    expect(built.trace.sections.find(section => section.name === 'preferences')?.source).toBe('read-model')
    expect(engine.calls).toBe(0)
  })

  it('给定水位门槛可配置当年龄超过配置值则按配置回退', async () => {
    const boards = boardsReaderOf({
      preference: [boardPreference()],
      preferenceFreshness: { watermarkAgeMs: 2_000, unprojected: 1 },
    })
    const engine = engineProbe(stateResult())

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => statsOf(),
      undefined,
      async () => [preferenceSummary],
      { reader: boards, maxWatermarkAgeMs: 1_000 },
    )

    const preferenceSection = built.trace.sections.find(section => section.name === 'preferences')
    expect(preferenceSection?.source).toBe('write-model')
    expect(preferenceSection?.fallbackReason).toBe(
      'read-model-watermark-stale: preference_board watermarkAgeMs=2000 unprojected=1',
    )
  })

  it('给定状态看板没有行但当水位超龄且仍有未投影任务则回退写模型（缺行也是旧读）', async () => {
    // worker 停摆时新写的状态根本还没投影进来，读模型读到 0 行恰恰是最该回退的情形。
    const boards = boardsReaderOf({
      preference: [boardPreference()],
      state: [],
      stateFreshness: { watermarkAgeMs: 90_000, unprojected: 1 },
    })
    const engine = engineProbe(stateResult())

    const built = await buildResident(
      engine.engine,
      contextOf(),
      600,
      async () => statsOf(),
      undefined,
      async () => [preferenceSummary],
      { reader: boards },
    )

    expect(built.trace.sections.find(section => section.name === 'preferences')?.source).toBe('write-model')
    const stateSection = built.trace.sections.find(section => section.name === 'states')
    expect(stateSection).toMatchObject({ kept: true, source: 'write-model' })
    expect(stateSection?.fallbackReason).toBe(
      'read-model-watermark-stale: state_board watermarkAgeMs=90000 unprojected=1',
    )
    // 回退后状态来自写模型（engine），所以没有 boards 路径的 stateHits。
    expect(built.stateHits).toEqual([])
  })
})
