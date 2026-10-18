/**
 * 3.7 Wave 2 / R9 C2：`/omb-feedback` 命令语义（真实 SQLite 账本）。
 *
 * 判据：
 * ① 四种动作各自动**不同的轴**：useful=效用、wrong=真值（需二次独立确认）、
 *    stale=可逆归档（最近未使用才归档）、noise=只降权；
 * ② 未知 id 拒绝；③ 隐私闸门不可被命令放宽；
 * ④ 全部可逆（`useful`/`revive` 撤销反馈归档）且审计日志只增不改。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, MemoryScope, MemoryStore } from '../../../kernel/abi/index.js'
import {
  parseFeedbackArgs,
  runFeedbackCommand,
  installFeedback,
  type FeedbackDeps,
} from '../../../modules/memory/feedback.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { tempWorkspace, testPort, type TempWorkspace } from './helpers.js'

const NOW = 1_700_000_000_000

interface Fixture {
  readonly user: SqliteMemoryStore
  readonly deps: FeedbackDeps
  readonly closed: { value: boolean }
  close(): Promise<void>
}

function fixture(options: {
  readonly allowedRead?: boolean
  readonly allowedWrite?: boolean
} = {}): Fixture {
  const ws: TempWorkspace = tempWorkspace('omb-feedback-')
  const clock = { now: () => NOW }
  const port = testPort(ws.dir)
  const logger = { debug: () => {}, info: () => {}, warn: () => {} }
  const user = openMemoryStore({ scope: 'user', dbPath: join(ws.dir, 'identity', 'knowledge.db'), port, logger, clock: { now: () => NOW, sleep: async () => {} } as never })
  const closed = { value: false }
  const stores = [{ scope: 'user' as MemoryScope, store: user as MemoryStore }]
  const deps: FeedbackDeps = {
    clock,
    resolveStores: () => stores,
    privacy: () => ({
      decide: () => ({ allowRead: options.allowedRead ?? true, allowWrite: options.allowedWrite ?? true }),
      decideUnattributed: () => ({ allowRead: options.allowedRead ?? true, allowWrite: options.allowedWrite ?? true }),
    }),
    logger,
  }
  return {
    user,
    deps,
    closed,
    async close(): Promise<void> {
      await user.close()
      ws.cleanup()
    },
  }
}

function record(id: string, text = '端口固定为 8080'): MemoryRecord {
  return {
    id,
    scope: 'user',
    kind: 'semantic',
    text,
    contentHash: `hash-${id}`,
    sourceRef: `session:s1#${id}`,
    assertedBy: 'user',
    observedAt: NOW - 86_400_000,
    validTo: null,
    supersededBy: null,
    lastUsedAt: NOW - 86_400_000,
    useCount: 0,
    project: null,
  }
}

async function run(f: Fixture, raw: string, sessionId: string | null = 'sA') {
  const outcome = await runFeedbackCommand(raw, sessionId, f.deps)
  return outcome
}

describe('参数解析', () => {
  it('用法/动作/查看三态', () => {
    expect(parseFeedbackArgs('mem_1 useful')).toEqual({ ok: true, id: 'mem_1', action: 'useful' })
    expect(parseFeedbackArgs('  mem_1   WRONG ')).toEqual({ ok: true, id: 'mem_1', action: 'wrong' })
    expect(parseFeedbackArgs('mem_1')).toEqual({ ok: true, id: 'mem_1', action: 'show' })
    expect(parseFeedbackArgs('')).toMatchObject({ ok: false })
    expect(parseFeedbackArgs('mem_1 praise')).toMatchObject({ ok: false })
    expect(parseFeedbackArgs('mem_1 useful extra')).toMatchObject({ ok: false })
  })
})

describe('/omb-feedback 语义', () => {
  it('useful：效用 +1，回执含撤销办法', async () => {
    const f = fixture()
    await f.user.put(record('mem_1'))
    const outcome = await run(f, 'mem_1 useful')
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain('useful')
    expect(outcome.text).toContain('撤销')
    const [row] = await f.user.utilityStats(['mem_1'])
    expect(row?.useful).toBe(1)
    expect(row?.exposed).toBe(0)
    await f.close()
  })

  it('wrong：第一次只挂待确认（不改真值）；**不同会话**第二次才归档；useful 可复活', async () => {
    const f = fixture()
    await f.user.put(record('mem_1'))

    const first = await run(f, 'mem_1 wrong', 'sA')
    expect(first.text).toContain('待二次确认')
    expect((await f.user.get('mem_1'))?.validTo).toBeNull()

    // 同一会话重复一次不算"独立确认"
    const same = await run(f, 'mem_1 wrong', 'sA')
    expect(same.text).toContain('待二次确认')
    expect((await f.user.get('mem_1'))?.validTo).toBeNull()

    const second = await run(f, 'mem_1 wrong', 'sB')
    expect(second.text).toContain('第二次独立确认')
    const archived = await f.user.get('mem_1')
    expect(archived?.validTo).toBe(NOW)
    expect(archived?.supersededBy).toBeNull() // 非破坏性：不指向“替代条目”
    expect(second.text).toContain('撤销')

    const revive = await run(f, 'mem_1 useful', 'sB')
    expect(revive.text).toContain('复活')
    expect((await f.user.get('mem_1'))?.validTo).toBeNull()

    // 审计：三次动作都在
    const log = await f.user.feedbackLog('mem_1', 10)
    expect(log.map(entry => entry.action)).toEqual(expect.arrayContaining(['wrong', 'wrong', 'revive']))
    await f.close()
  })

  it('stale：最近未使用 → 可逆归档；最近用过 → 只记信号不归档', async () => {
    const f = fixture()
    await f.user.put(record('old'))
    await f.user.put({ ...record('recent'), lastUsedAt: NOW - 1000, useCount: 2 })

    const oldOutcome = await run(f, 'old stale')
    expect(oldOutcome.text).toContain('已可逆归档')
    expect((await f.user.get('old'))?.validTo).toBe(NOW)

    const recentOutcome = await run(f, 'recent stale')
    expect(recentOutcome.text).toContain('不归档')
    expect((await f.user.get('recent'))?.validTo).toBeNull()

    const revived = await run(f, 'old useful')
    expect(revived.text).toContain('复活')
    expect((await f.user.get('old'))?.validTo).toBeNull()
    await f.close()
  })

  it('noise：只降权，不归档；utility 下降', async () => {
    const f = fixture()
    await f.user.put(record('mem_1'))
    await f.user.markUsed(['mem_1'], NOW) // 先有一次曝光，否则收缩到基率看不出变化
    const before = (await f.user.get('mem_1')) as MemoryRecord & { utility?: number }
    const utilityBefore = before.utility ?? Number.NaN
    const outcome = await run(f, 'mem_1 noise')
    expect(outcome.text).toContain('只降权')
    expect((await f.user.get('mem_1'))?.validTo).toBeNull()
    const after = (await f.user.get('mem_1')) as MemoryRecord & { utility?: number }
    expect(after.utility).toBeLessThan(utilityBefore)
    const [row] = await f.user.utilityStats(['mem_1'])
    expect(row?.noise).toBe(1)
    await f.close()
  })

  it('未知 id / 非法动作被拒，且不写任何数据', async () => {
    const f = fixture()
    const unknown = await run(f, 'mem_missing useful')
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未知 id')
    const bad = await run(f, 'mem_1 praise')
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('未知动作')
    await f.close()
  })

  it('隐私：sealed 拒绝读写；read-only 允许看但拒绝改（命令不能放宽隐私）', async () => {
    const sealed = fixture({ allowedRead: false, allowedWrite: false })
    await sealed.user.put(record('mem_1'))
    const denied = await run(sealed, 'mem_1 useful')
    expect(denied.kind).toBe('error')
    expect(denied.text).toContain('sealed')
    expect((await sealed.user.utilityStats(['mem_1'])).length).toBe(0)
    await sealed.close()

    const readOnly = fixture({ allowedRead: true, allowedWrite: false })
    await readOnly.user.put(record('mem_1'))
    const status = await run(readOnly, 'mem_1')
    expect(status.kind).toBe('success')
    const mutate = await run(readOnly, 'mem_1 useful')
    expect(mutate.kind).toBe('error')
    expect(mutate.text).toContain('read-only')
    await readOnly.close()
  })

  it('查看态：给出计数与最近反馈（不含动作）', async () => {
    const f = fixture()
    await f.user.put(record('mem_1'))
    await run(f, 'mem_1 useful')
    const status = await run(f, 'mem_1')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('曝光 0')
    expect(status.text).toContain('useful 1')
    expect(status.text).toContain('最近反馈：useful')
    await f.close()
  })

  it('命令注册：definitionId/name/input.hint 齐全，handler 走同一执行体（无模型工具）', async () => {
    const f = fixture()
    await f.user.put(record('mem_1'))
    interface Registered {
      definitionId: string
      name: string
      input?: { hint: string }
      handler: (invocation: unknown) => Promise<unknown>
    }
    const registered: Registered[] = []
    const commands = {
      register: (definition: Registered) => {
        registered.push(definition)
        return () => {}
      },
    }
    const kernel = {
      service: (name: string) => (name === 'commands' ? commands : undefined),
    } as unknown as import('../../../kernel/abi/index.js').Kernel
    const installation = installFeedback(kernel, f.deps)
    expect(installation.commandState()).toContain('已注册')
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('omb-feedback')
    expect(registered[0]?.definitionId).toBe('omb-memory/feedback')
    expect(registered[0]?.input?.hint).toContain('useful')
    const outcome = (await registered[0]?.handler({ rawInput: 'mem_1 useful', agent: { id: 'sA' } })) as {
      kind: string
      text: string
    }
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain('useful')
    installation.dispose()
    await f.close()
  })
})
