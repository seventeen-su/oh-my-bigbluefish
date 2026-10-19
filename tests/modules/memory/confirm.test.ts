/**
 * `/omb-confirm`（v4.8.0）：候选记忆的用户确认入口。
 *
 * 判据：
 * ① 解析是纯函数（不带参数 = 列表，带 id = 确认，多余参数拒绝）；
 * ② 变换是纯函数：只改 `assertedBy`，正文/id/来源/时间一字不动；
 * ③ 只接受真正的候选（事件、已失效、已被取代、已是 user 一律拒绝）；
 * ④ 隐私闸门先判（sealed 不读；read-only/未知归属不写）；
 * ⑤ 写回后查回验证；失败不谎报成功。
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Kernel, MemoryRecord, TaggedStore } from '../../../kernel/abi/index.js'
import {
  CONFIRM_USAGE,
  installConfirm,
  isConfirmableCandidate,
  listCandidates,
  parseConfirmArgs,
  promoteCandidateRecord,
  renderCandidateList,
  renderConfirmResult,
  runConfirmCommand,
  type ConfirmDeps,
} from '../../../modules/memory/confirm.js'
import { openMemoryStore, type SqliteMemoryStore } from '../../../modules/memory/store.js'
import { capturingLogger, fixedClock, makeRecord, tempWorkspace, testPort, type TempWorkspace, type TestClock } from './helpers.js'

interface ConfirmFixture {
  readonly user: SqliteMemoryStore
  readonly project: SqliteMemoryStore
  readonly stores: readonly TaggedStore[]
  readonly deps: ConfirmDeps
  readonly events: { action: string; changed: boolean; reason: string; sessionId: string | null }[]
  close(): Promise<void>
}

function fixture(options: { readonly allowRead?: boolean; readonly allowWrite?: boolean } = {}): ConfirmFixture {
  const ws: TempWorkspace = tempWorkspace('omb-confirm-')
  const clock: TestClock = fixedClock()
  const port = testPort(ws.dir)
  const logger = capturingLogger()
  const user = openMemoryStore({ scope: 'user', dbPath: port.userDbPath, port, logger, clock })
  const project = openMemoryStore({
    scope: 'project',
    dbPath: join(ws.dir, 'proj', '.omb', 'memory', 'session.db'),
    port,
    logger,
    clock,
  })
  const stores: readonly TaggedStore[] = [
    { scope: 'user', store: user },
    { scope: 'project', store: project },
  ]
  const events: ConfirmFixture['events'] = []
  const decision = { allowRead: options.allowRead ?? true, allowWrite: options.allowWrite ?? true }
  const deps: ConfirmDeps = {
    clock,
    resolveStores: () => stores,
    privacy: () => ({ decide: () => decision, decideUnattributed: () => decision }),
    logger: { info: () => {}, warn: () => {} },
    onConfirm: info => void events.push(info),
  }
  return {
    user,
    project,
    stores,
    deps,
    events,
    async close(): Promise<void> {
      await user.close()
      await project.close()
      ws.cleanup()
    },
  }
}

async function putRecord(store: SqliteMemoryStore, record: MemoryRecord): Promise<MemoryRecord> {
  await store.put(record)
  return record
}

describe('确认命令：解析（纯函数）', () => {
  it('不带参数 = 列表；一个 id = 确认；多余参数拒绝', () => {
    expect(parseConfirmArgs('')).toEqual({ ok: true, request: { kind: 'list' } })
    expect(parseConfirmArgs('   ')).toEqual({ ok: true, request: { kind: 'list' } })
    expect(parseConfirmArgs('mem_abc')).toEqual({ ok: true, request: { kind: 'promote', id: 'mem_abc' } })
    const bad = parseConfirmArgs('mem_abc extra')
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.error).toContain('多余的参数')
    expect(CONFIRM_USAGE).toContain('/omb-confirm')
  })
})

describe('确认变换：只改证据归属', () => {
  it('候选（semantic + model）→ 已确认，其余字段逐字保留', () => {
    const record = makeRecord({
      id: 'mem_candidate',
      scope: 'project',
      kind: 'semantic',
      text: '这个项目统一用 pnpm',
      assertedBy: 'model',
      observedAt: 1_700_000_000_123,
      lastUsedAt: 1_700_000_000_456,
      useCount: 3,
    })
    const result = promoteCandidateRecord(record)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record).toEqual({ ...record, assertedBy: 'user' })
    expect(record.assertedBy).toBe('model') // 纯函数：不原地改写入参
  })

  it('procedural + model 也确认（阶段会变成"经验"）', () => {
    const result = promoteCandidateRecord(makeRecord({ kind: 'procedural', assertedBy: 'model' }))
    expect(result.ok && result.record.assertedBy).toBe('user')
  })

  it('拒绝：事件条目 / 已失效 / 已被取代 / 已是 user / 非 model', () => {
    expect(promoteCandidateRecord(makeRecord({ kind: 'episodic', assertedBy: 'model' })).ok).toBe(false)
    expect(promoteCandidateRecord(makeRecord({ kind: 'semantic', assertedBy: 'model', validTo: 1 })).ok).toBe(false)
    expect(promoteCandidateRecord(makeRecord({ kind: 'semantic', assertedBy: 'model', supersededBy: 'm2' })).ok).toBe(false)
    expect(promoteCandidateRecord(makeRecord({ kind: 'semantic', assertedBy: 'user' })).ok).toBe(false)
    expect(promoteCandidateRecord(makeRecord({ kind: 'semantic', assertedBy: 'execution' })).ok).toBe(false)
  })

  it('isConfirmableCandidate 与变换判据一致', () => {
    expect(isConfirmableCandidate(makeRecord({ assertedBy: 'model' }))).toBe(true)
    expect(isConfirmableCandidate(makeRecord({ assertedBy: 'user' }))).toBe(false)
    expect(isConfirmableCandidate(makeRecord({ kind: 'episodic', assertedBy: 'model' }))).toBe(false)
    expect(isConfirmableCandidate(makeRecord({ assertedBy: 'model', validTo: 1 }))).toBe(false)
  })

  it('列表/确认回执都明确说"只改归属"', () => {
    const record = makeRecord({ id: 'mem_x', text: '回答要简洁', assertedBy: 'model' })
    const list = renderCandidateList([{ record }])
    expect(list).toContain('mem_x')
    expect(list).toContain('/omb-confirm')
    const confirmed = renderConfirmResult({ record: { ...record, assertedBy: 'user' } })
    expect(confirmed).toContain('阶段：候选 → 已确认')
    expect(confirmed).toContain('正文、来源、id、observedAt 均未改')
  })
})

describe('确认命令：真实 SQLite', () => {
  it('列表只列候选（事件/已确认/已失效不出现）', async () => {
    const f = fixture()
    await putRecord(f.user, makeRecord({ id: 'mem_cand', text: '回答要简洁', assertedBy: 'model' }))
    await putRecord(f.user, makeRecord({ id: 'mem_user', text: '已是用户结论', assertedBy: 'user' }))
    await putRecord(f.user, makeRecord({ id: 'mem_event', text: '今天发生了什么', kind: 'episodic', assertedBy: 'execution' }))
    await putRecord(f.user, makeRecord({ id: 'mem_stale', text: '已失效的候选', assertedBy: 'model', validTo: 1 }))

    const items = await listCandidates(f.stores, 5)
    expect(items.map(item => item.record.id)).toEqual(['mem_cand'])
    const result = await runConfirmCommand('', 's1', f.deps)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('mem_cand')
    expect(result.text).not.toContain('mem_user')
    expect(result.text).not.toContain('mem_event')
    expect(f.events[0]).toMatchObject({ action: 'list', changed: false })
    await f.close()
  })

  it('确认候选：assertedBy 变 user，正文/来源/id 不变，查回验证通过', async () => {
    const f = fixture()
    const record = await putRecord(f.user, makeRecord({
      id: 'mem_cand',
      text: '回答要简洁，不要分点',
      assertedBy: 'model',
      sourceRef: 'session:s1#controller:1',
    }))
    const result = await runConfirmCommand('mem_cand', 's1', f.deps)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已确认')
    const stored = await f.user.get('mem_cand')
    expect(stored).toMatchObject({
      assertedBy: 'user',
      text: record.text,
      sourceRef: record.sourceRef,
      observedAt: record.observedAt,
      contentHash: record.contentHash,
    })
    expect(f.events.at(-1)).toMatchObject({ action: 'promote', changed: true })
    await f.close()
  })

  it('未知 id / 已确认 / 事件条目 → 拒绝且不改库', async () => {
    const f = fixture()
    await putRecord(f.user, makeRecord({ id: 'mem_user', text: '已是用户结论', assertedBy: 'user' }))
    await putRecord(f.user, makeRecord({ id: 'mem_event', text: '今天发生了什么', kind: 'episodic', assertedBy: 'execution' }))

    const unknown = await runConfirmCommand('mem_nope', 's1', f.deps)
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未知 id')

    const already = await runConfirmCommand('mem_user', 's1', f.deps)
    expect(already.kind).toBe('error')
    expect(already.text).toContain('已经是')

    const event = await runConfirmCommand('mem_event', 's1', f.deps)
    expect(event.kind).toBe('error')
    expect(event.text).toContain('事件条目')

    expect((await f.user.get('mem_user'))?.assertedBy).toBe('user')
    expect((await f.user.get('mem_event'))?.assertedBy).toBe('execution')
    expect(f.events.filter(entry => entry.action === 'promote' && entry.changed)).toHaveLength(0)
    await f.close()
  })

  it('隐私：sealed 不读；read-only 可列表但不能确认', async () => {
    const sealed = fixture({ allowRead: false, allowWrite: false })
    await putRecord(sealed.user, makeRecord({ id: 'mem_cand', assertedBy: 'model' }))
    expect((await runConfirmCommand('', 's1', sealed.deps)).kind).toBe('error')
    expect((await runConfirmCommand('mem_cand', 's1', sealed.deps)).kind).toBe('error')
    expect((await sealed.user.get('mem_cand'))?.assertedBy).toBe('model')
    await sealed.close()

    const readOnly = fixture({ allowRead: true, allowWrite: false })
    await putRecord(readOnly.user, makeRecord({ id: 'mem_cand', text: '候选结论', assertedBy: 'model' }))
    expect((await runConfirmCommand('', 's1', readOnly.deps)).kind).toBe('success')
    const promoted = await runConfirmCommand('mem_cand', 's1', readOnly.deps)
    expect(promoted.kind).toBe('error')
    expect(promoted.text).toContain('read-only')
    expect((await readOnly.user.get('mem_cand'))?.assertedBy).toBe('model')
    await readOnly.close()
  })

  it('写回后查回失败 → 报错，不谎报确认成功', async () => {
    const f = fixture()
    const record = await putRecord(f.user, makeRecord({ id: 'mem_cand', text: '候选结论', assertedBy: 'model' }))
    // 第一次 getMany 是 findRecord（返回该条），第二次是写回后的查回验证（返回空）
    const spy = vi.spyOn(f.user, 'getMany')
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([])
    const result = await runConfirmCommand('mem_cand', 's1', f.deps)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('查回失败')
    spy.mockRestore()
    await f.close()
  })

  it('库不可用 → 可读错误（不抛）', async () => {
    const f = fixture()
    const deps: ConfirmDeps = { ...f.deps, resolveStores: () => undefined }
    const result = await runConfirmCommand('', 's1', deps)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆服务未就绪')
    await f.close()
  })
})

describe('确认命令：装配', () => {
  it('注册到宿主 commands 服务，handler 可执行，dispose 幂等', async () => {
    const f = fixture()
    await putRecord(f.user, makeRecord({ id: 'mem_cand', text: '候选结论', assertedBy: 'model' }))
    const registered: {
      readonly name: string
      readonly handler: (invocation: unknown) => Promise<{ kind: string; text: string }>
    }[] = []
    let disposed = 0
    const kernel = {
      service: (name: string) => name === 'commands'
        ? {
            register: (definition: unknown) => {
              registered.push(definition as never)
              return () => void (disposed += 1)
            },
          }
        : undefined,
    } as unknown as Kernel
    const install = installConfirm(kernel, f.deps)
    expect(install.commandState()).toContain('已注册')
    expect(registered[0]?.name).toBe('omb-confirm')
    const result = await registered[0]!.handler({ rawInput: 'mem_cand', agent: { id: 's1' } })
    expect(result.kind).toBe('success')
    expect((await f.user.get('mem_cand'))?.assertedBy).toBe('user')
    install.dispose()
    install.dispose()
    expect(disposed).toBe(1)
    await f.close()
  })

  it('commands 服务不可用：如实记未注册，不抛', () => {
    const kernel = { service: () => undefined } as unknown as Kernel
    const install = installConfirm(kernel, { clock: fixedClock(), resolveStores: () => [] })
    expect(install.commandState()).toContain('未注册')
    install.dispose()
  })
})
