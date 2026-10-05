/**
 * 离线整合的**回合边界驱动**（M3）。
 *
 * 修复前为什么失败：`planConsolidation` / `promotionCandidates` / `decayPrior` 零生产消费者，
 * `consolidationEveryTurns` 只进一条 debug 日志（死配置），`modules/` 下没有任何 `turn/end` 订阅者
 * ——回响塌缩、矛盾发边、"独立来源 ≥2 才够格谈晋升"全是只存在于测试里的承诺。
 *
 * 事实核验（本轮实读，不是照抄规划稿）：`kernel/abi/kernel.ts:29` 声明了 `turn/end`，
 * `dsh/session.ts:815` 在宿主 `step/end` 时把它发到内核总线上 → 本模块可以直接订阅，
 * 不需要动 `dsh/`。
 *
 * 判据：
 * ① 每 `consolidationEveryTurns` 个回合边界跑一次（**配置是活的**：改小就提前触发）；
 * ② 跑过之后：重复痕迹被**非破坏性**地标失效（`validTo`+`supersededBy`，行数不降）+ `supersedes` 边落库；
 * ③ 同源回响**不算**独立单元（零假晋升）；不同来源链的同文痕迹才算；
 * ④ 写不成（受限会话）必须**可见**（健康面有原因），绝不静默。
 */
import { describe, expect, it } from 'vitest'
import type { Kernel, MemoryStore, ModuleRegistration } from '../../../kernel/abi/index.js'
import { SERVICES } from '../../../kernel/abi/index.js'
import { createKernel } from '../../../kernel/index.js'
import { MODULE_ID, createMemoryRegistration } from '../../../modules/memory/index.js'
import type { MemoryStoresService, PrivacyDecisionPort } from '../../../modules/memory/store.js'
import { capturingLogger, fixedClock, makeRecord, tempWorkspace, testPort } from './helpers.js'

const ECHO_TEXT = '回响：同一条错事被同一个会话重复写下的痕迹'

/** `omb-memory` 依赖 `omb-kernel`：本行是测试替身（模块测试不该依赖集成层）。 */
const kernelRow: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.4.0',
    requires: [],
    capabilities: [],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试替身' }),
  },
  apply: () => {},
}

interface Booted {
  readonly kernel: Kernel
  readonly registration: ModuleRegistration<unknown>
  readonly service: MemoryStoresService
  /** 用户库的（受闸门约束的）句柄。 */
  readonly store: MemoryStore
  dispose(): void
  cleanup(): void
}

/** 起真实内核 + 真实库；`everyTurns` 走 `start()` 的 configs（生产里由 `cordis.patch.yml` 给）。 */
async function boot(everyTurns: number): Promise<Booted> {
  const ws = tempWorkspace('omb-consolidate-')
  const handle = createKernel({ logger: capturingLogger(), clock: fixedClock() })
  const registration = createMemoryRegistration({ storageHost: testPort(ws.dir) })
  handle.start([kernelRow, registration], new Map([[MODULE_ID, { consolidationEveryTurns: everyTurns }]]))
  const service = handle.kernel.service<MemoryStoresService>(SERVICES.stores)
  if (service === undefined) throw new Error('stores 服务未注册')
  // 开库是 `apply` 里的 fire-and-forget；这里显式等它就绪（幂等）
  await service.start()
  const store = service.snapshot().user?.store('user')
  if (store === undefined) throw new Error('用户库未打开')
  return {
    kernel: handle.kernel,
    registration,
    service,
    store,
    dispose: () => handle.dispose(),
    cleanup: () => ws.cleanup(),
  }
}

/** 等整合跑完（它是 `void` 起的异步链：回合边界不等它）。返回健康面 detail。 */
async function waitForRuns(registration: ModuleRegistration<unknown>, minimum = 1): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const detail = (await registration.manifest.health()).detail ?? ''
    const match = /离线整合：已运行 (\d+) 次/.exec(detail)
    if (match !== null && Number(match[1]) >= minimum) return detail
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`整合没有在超时内运行：${(await registration.manifest.health()).detail ?? ''}`)
}

function boundaries(booted: Booted, count: number, from = 1): void {
  for (let turn = from; turn < from + count; turn += 1) {
    booted.kernel.emit('turn/end', { sessionId: 's1', turn })
  }
}

function echo(id: string, sourceRef: string, observedAt: number) {
  return makeRecord({ id, text: ECHO_TEXT, sourceRef, observedAt, scope: 'user' })
}

async function seedEchoes(booted: Booted, sourceRefs: readonly string[]): Promise<void> {
  await Promise.all(sourceRefs.map((ref, index) => booted.store.put(echo(`echo-${index + 1}`, ref, 1_000 + index))))
}

async function records(booted: Booted, count: number) {
  return await Promise.all(
    Array.from({ length: count }, (_, index) => booted.store.get(`echo-${index + 1}`)),
  )
}

describe('离线整合：回合边界驱动（M3）', () => {
  it('到点才跑：每 consolidationEveryTurns 个边界一次（配置是活的，不是死旋钮）', async () => {
    const booted = await boot(3)
    await seedEchoes(booted, ['session:echo#turn-1', 'session:echo#turn-3', 'session:echo#turn-5'])

    boundaries(booted, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await booted.registration.manifest.health()).detail ?? '').toContain('尚未到点')

    boundaries(booted, 1, 3)
    await waitForRuns(booted.registration)

    // 非破坏性：三条行都还在（"我当时相信什么"仍可回答）
    expect((await booted.store.stats()).rows).toBe(3)
    const after = await records(booted, 3)
    expect(after.filter(record => record?.supersededBy !== null && record?.validTo !== null)).toHaveLength(2)
    for (const record of after) expect(record?.text).toBe(ECHO_TEXT) // 正文一字未改
    booted.dispose()
    booted.cleanup()
  })

  it('同源回响塌缩后：supersedes 边落库（omb_relate 追得到），且零假晋升', async () => {
    const booted = await boot(3)
    await seedEchoes(booted, ['session:echo#turn-1', 'session:echo#turn-3', 'session:echo#turn-5'])
    boundaries(booted, 3)
    const detail = await waitForRuns(booted.registration)

    const after = await records(booted, 3)
    const keeper = after.find(record => record?.supersededBy === null)
    expect(keeper).toBeDefined()
    const walk = await booted.store.walkGraph({ fromId: keeper?.id ?? '', depth: 1, types: ['supersedes'] })
    expect(walk.edges.map(edge => `${edge.fromId}->${edge.toId}:${edge.type}`).sort()).toEqual(
      after
        .filter(record => record?.supersededBy !== null)
        .map(record => `${keeper?.id}->${record?.id}:supersedes`)
        .sort(),
    )

    // 同源回响（independentSources === 1）**不算**独立单元 → 假晋升防线在读数上可见
    expect(detail).toContain('离线整合：已运行 1 次')
    expect(detail).toContain('独立来源≥2 的组 0 个')
    expect(detail).not.toContain('⚠ 整合最近一次有失败')
    booted.dispose()
    booted.cleanup()
  })

  it('独立来源 ≥2 的同文痕迹才够格谈晋升（α/β 两条链 → 1 个独立单元）', async () => {
    const booted = await boot(3)
    await seedEchoes(booted, ['session:alpha#turn-1', 'session:beta#turn-1'])
    boundaries(booted, 3)
    const detail = await waitForRuns(booted.registration)
    expect(detail).toContain('独立来源≥2 的组 1 个')
    booted.dispose()
    booted.cleanup()
  })

  it('重入闸：一次发满两轮的边界，不会叠出重复标注', async () => {
    const booted = await boot(3)
    await seedEchoes(booted, ['session:echo#turn-1', 'session:echo#turn-2'])
    boundaries(booted, 6)
    await waitForRuns(booted.registration)
    const after = await records(booted, 2)
    expect(after.filter(record => record?.supersededBy !== null)).toHaveLength(1)
    booted.dispose()
    booted.cleanup()
  })

  it('写不成必须可见：受限会话里仍读得到，但标失效被拒会写进健康面（绝不静默）', async () => {
    const booted = await boot(3)
    await seedEchoes(booted, ['session:echo#turn-1', 'session:echo#turn-2'])

    // 播种之后再打开隐私闸门：快照视图的**归属未知 → 禁写**
    const decision: PrivacyDecisionPort = {
      allowRead: true,
      allowWrite: false,
      readReason: '读允许',
      writeReason: '受限期禁写（归属未知）',
    }
    booted.kernel.provide(SERVICES.privacy, { decide: () => decision, decideUnattributed: () => decision })

    boundaries(booted, 3)
    const detail = await waitForRuns(booted.registration)
    expect(detail).toContain('⚠ 整合最近一次有失败')
    expect(detail).toContain('受限期禁写')

    // 拒绝是真的：库里一条都没被标上
    const after = await records(booted, 2)
    expect(after.every(record => record?.supersededBy === null)).toBe(true)
    booted.dispose()
    booted.cleanup()
  })
})
