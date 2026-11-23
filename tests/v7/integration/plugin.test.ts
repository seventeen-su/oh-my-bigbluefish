import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { prepareDatabase, resetDatabase, TEST_DATABASE_URL } from './helpers.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly promptText: Map<string, string>
  readonly listeners: Map<string, (...args: unknown[]) => unknown>
  provider: ((input: unknown) => string) | undefined
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const promptText = new Map<string, string>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const host: FakeHost = { ctx: undefined as unknown as HostContextLike, tools, promptText, listeners, provider: undefined }
  const ctx = {
    get: (name: string) => {
      if (name === 'tools') {
        return {
          register: (definition: HostToolDefinition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          getContextOrder: () => 200,
          context: (arg: unknown) => {
            const record = arg as { name?: string; text?: (input: unknown) => string }
            if (typeof record.text === 'function') host.provider = record.text
            return () => {}
          },
        }
      }
      return undefined
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
  }
  host.ctx = ctx as unknown as HostContextLike
  return host
}

describe('v7 plugin entry', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('注册 7 个工具，remember/recall/status 全链路可调用', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    expect([...host.tools.keys()].sort()).toEqual([
      'omb_admin', 'omb_history', 'omb_link', 'omb_recall', 'omb_remember', 'omb_status', 'omb_update',
    ])
    const exec = { agent: { session: { id: 'session-smoke', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '插件冒烟记忆', body: 'v7 全链路' },
    }, exec)
    expect(remembered?.ok).toBe(true)
    expect(remembered?.text).toContain('已写入 memory')

    const id = /mem_[0-9a-f-]{36}/.exec(remembered?.text ?? '')?.[0]
    expect(id).toBeDefined()

    const recalled = await host.tools.get('omb_recall')?.execute({ query: '插件冒烟记忆', scope: 'project' }, exec)
    expect(recalled?.ok).toBe(true)
    expect(recalled?.text).toContain('trace')

    const updated = await host.tools.get('omb_update')?.execute({
      id,
      expectedRevision: 1,
      attrs: { title: '插件冒烟记忆（更新）' },
    }, exec)
    expect(updated?.ok).toBe(true)
    expect(updated?.text).toContain('revision 2')

    const noRevision = await host.tools.get('omb_update')?.execute({
      id,
      attrs: { title: '缺 revision 的更新' },
    }, exec)
    expect(noRevision?.ok).toBe(false)
    expect(noRevision?.text).toContain('invalid-input')

    const second = await host.tools.get('omb_remember')?.execute({
      kind: 'memory', category: 'fact', scope: 'project', attrs: { title: '插件冒烟第二', body: 'B' },
    }, exec)
    const secondId = /mem_[0-9a-f-]{36}/.exec(second?.text ?? '')?.[0]
    const linked = await host.tools.get('omb_link')?.execute({
      from: id, to: secondId, relation: 'related_to',
    }, exec)
    expect(linked?.ok).toBe(true)

    const audit = await host.tools.get('omb_admin')?.execute({ action: 'audit', limit: 10 }, exec)
    expect(audit?.ok).toBe(true)
    expect(audit?.text).toContain('write')

    const status = await host.tools.get('omb_status')?.execute({}, exec)
    expect(status?.ok).toBe(true)
    expect(status?.text).toContain('db=ok')
    expect(status?.text).toContain('jobFailures=0')

    const preStep = host.listeners.get('agent/pre-step')
    expect(preStep).toBeDefined()
    const next = async () => ({ kind: 'enter', messages: [] })
    await preStep?.(
      {
        agent: { session: { id: 'session-smoke', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '插件冒烟记忆' }],
        turn: 1,
      },
      next,
    )
    expect(host.provider).toBeDefined()
    const injected = host.provider?.({ agent: { session: { id: 'session-smoke' } } }) ?? ''
    expect(injected).toContain('[OMB 常驻]')

    const ledger = new PostgresStore(TEST_DATABASE_URL)
    let trace: { used_tokens: number; budget_tokens: number; sections: unknown[]; text: string } | undefined
    for (let attempt = 0; attempt < 40 && trace === undefined; attempt += 1) {
      const rows = await ledger.db.query<{ used_tokens: number; budget_tokens: number; sections: unknown[]; text: string }>(
        `select used_tokens, budget_tokens, sections, text
         from omb.resident_trace where session_id = $1 order by id desc limit 1`,
        ['session-smoke'],
      )
      trace = rows.rows[0]
      if (trace === undefined) await wait(25)
    }
    expect(trace).toBeDefined()
    expect(trace?.budget_tokens).toBe(300)
    expect(trace?.used_tokens).toBeLessThanOrEqual(300)
    expect(trace?.sections.length).toBeGreaterThan(0)
    expect(trace?.text).toContain('[OMB 常驻]')
    await ledger.close()
    dispose()
  })

  it('assistant 文本与工具参数引用命中时记录 adoption', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'adoption-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory', category: 'fact', scope: 'project',
      attrs: { title: '采用率测试记忆', body: 'adoption probe' },
    }, exec)
    const id = /mem_[0-9a-f-]{36}/.exec(remembered?.text ?? '')?.[0]
    expect(id).toBeDefined()
    const recalled = await host.tools.get('omb_recall')?.execute({ query: 'adoption probe', scope: 'project' }, exec)
    const trace = /trace (trc_[0-9a-f-]{36})/.exec(recalled?.text ?? '')?.[1]
    expect(trace).toBeDefined()

    const listener = host.listeners.get('session/event')
    expect(listener).toBeDefined()
    listener?.(
      { id: 'adoption-session', header: { cwd: PROJECT } },
      { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: `使用 ${id}` }] } },
    )
    await wait(100)

    const db = new PostgresStore(TEST_DATABASE_URL)
    const byText = await db.db.query<{ adopted_at: string | null; adoption_kind: string | null }>(
      'select adopted_at, adoption_kind from omb.recall_event where trace_id=$1 and entity_id=$2',
      [trace, id],
    )
    expect(byText.rows[0]?.adopted_at).not.toBeNull()
    expect(byText.rows[0]?.adoption_kind).toBe('text')

    const second = await host.tools.get('omb_recall')?.execute({ query: 'adoption probe', scope: 'project' }, exec)
    const secondTrace = /trace (trc_[0-9a-f-]{36})/.exec(second?.text ?? '')?.[1]
    listener?.(
      { id: 'adoption-session', header: { cwd: PROJECT } },
      { type: 'tool/call', seq: 2, data: { name: 'read_file', arguments: JSON.stringify({ id }) } },
    )
    await wait(100)
    const byTool = await db.db.query<{ adopted_at: string | null; adoption_kind: string | null }>(
      'select adopted_at, adoption_kind from omb.recall_event where trace_id=$1 and entity_id=$2',
      [secondTrace, id],
    )
    expect(byTool.rows[0]?.adopted_at).not.toBeNull()
    expect(byTool.rows[0]?.adoption_kind).toBe('tool')
    await db.close()
    dispose()
  })

  it('事件捕获把子目录 cwd 提升为 git root projectKey', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const subdir = `${PROJECT}\\packages`
    const listener = host.listeners.get('session/event')
    listener?.(
      { id: 'event-capture-session', header: { cwd: subdir } },
      { type: 'goal/change', seq: 1, data: { cwd: subdir, goal: { id: 'goal-capture', objective: '捕获项目根' } } },
    )
    const db = new PostgresStore(TEST_DATABASE_URL)
    let projectKey: string | undefined
    for (let attempt = 0; attempt < 80 && projectKey === undefined; attempt += 1) {
      const rows = await db.db.query<{ project_key: string }>(
        `select metadata->>'projectKey' as project_key from omb.artifact
         where kind = 'goal/change' order by id desc limit 1`,
      )
      projectKey = rows.rows[0]?.project_key
      if (projectKey === undefined) await wait(25)
    }
    expect(projectKey).toBe(PROJECT.replaceAll('\\', '/'))
    await db.close()
    dispose()
  })

  it('T0 偏好注入写 recall_event，assistant 采用后标记 adopted', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'resident-pref-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'global',
      attrs: { title: 'T0 偏好采用', tags: ['偏好'] },
    }, exec)
    const id = /mem_[0-9a-f-]{36}/.exec(remembered?.text ?? '')?.[0]
    expect(id).toBeDefined()

    const preStep = host.listeners.get('agent/pre-step')
    await preStep?.(
      {
        agent: { session: { id: 'resident-pref-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '继续' }],
        turn: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const db = new PostgresStore(TEST_DATABASE_URL)
    let residentEvent: { trace_id: string; injected: boolean } | undefined
    for (let attempt = 0; attempt < 40 && residentEvent === undefined; attempt += 1) {
      const rows = await db.db.query<{ trace_id: string; injected: boolean }>(
        `select trace_id, injected from omb.recall_event
         where entity_id = $1 and channel = 'resident' order by id desc limit 1`,
        [id],
      )
      residentEvent = rows.rows[0]
      if (residentEvent === undefined) await wait(25)
    }
    expect(residentEvent?.injected).toBe(true)
    await wait(50)

    const listener = host.listeners.get('session/event')
    listener?.(
      { id: 'resident-pref-session', header: { cwd: PROJECT } },
      { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '采用 T0 偏好采用' }] } },
    )
    await wait(100)
    const adopted = await db.db.query<{ adopted_at: string | null; adoption_kind: string | null }>(
      `select adopted_at, adoption_kind from omb.recall_event
       where trace_id = $1 and entity_id = $2`,
      [residentEvent?.trace_id, id],
    )
    expect(adopted.rows[0]?.adopted_at).not.toBeNull()
    expect(adopted.rows[0]?.adoption_kind).toBe('text')
    await db.close()
    dispose()
  })

  it('工具结果即时召回挂到 additionalContexts，且下一步不重复召回', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'tool-t1-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '工具报错召回记忆', body: 'ENOENT 工具失败的处理方式' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const postExecute = host.listeners.get('tools/post-execute')
    expect(postExecute).toBeDefined()
    const decision = await postExecute?.(
      {
        name: 'bash',
        arguments: { command: 'cat missing-file' },
        agent: { session: { id: 'tool-t1-session', header: { cwd: PROJECT } } },
      },
      {
        isError: true,
        content: [{ type: 'text', text: 'ENOENT 工具失败 工具报错召回记忆' }],
        error: { name: 'Error', code: 'ENOENT', reason: 'missing-file' },
      },
      async () => ({ kind: 'accept' }),
    ) as {
      additionalContexts?: {
        source?: { kind?: string; plugin?: string }
        content?: { text?: string }[]
      }[]
    } | undefined
    expect(decision?.additionalContexts).toHaveLength(1)
    expect(decision?.additionalContexts?.[0]?.source?.kind).toBe('plugin:oh-my-bigbluefish/v7')
    expect(decision?.additionalContexts?.[0]?.source?.kind).not.toBe('plugin')
    expect(decision?.additionalContexts?.[0]?.source).not.toHaveProperty('plugin')
    const injected = decision?.additionalContexts?.[0]?.content?.[0]?.text ?? ''
    expect(injected).toContain('[OMB 事件召回]')
    expect(injected).toContain('工具报错召回记忆')

    const preStep = host.listeners.get('agent/pre-step')
    await preStep?.(
      {
        agent: { session: { id: 'tool-t1-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'tool' }, role: 'tool', content: 'ENOENT 工具失败 工具报错召回记忆' }],
        turn: 2,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const prompt = host.provider?.({ agent: { session: { id: 'tool-t1-session' } } }) ?? ''
    // 工具结果已走 additionalContexts；system prompt 不能再重复同一段召回。
    expect(prompt).not.toContain('[OMB 事件召回]')

    const db = new PostgresStore(TEST_DATABASE_URL)
    const events = await db.db.query<{ injected: boolean; query: string }>(
      `select injected, query from omb.recall_event where session_id = $1`,
      ['tool-t1-session'],
    )
    expect(events.rows.some(row => row.injected && row.query?.includes('工具报错召回记忆'))).toBe(true)
    await db.close()
    dispose()
  })

  it('工具调用前启动预取，成功后复用而不等结果查询', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'tool-prefetch-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '工具预取命中记忆', body: '调用前预取' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preExecute = host.listeners.get('tools/pre-execute')
    const postExecute = host.listeners.get('tools/post-execute')
    expect(preExecute).toBeDefined()
    expect(postExecute).toBeDefined()
    const toolExec = {
      callId: 'call-prefetch-1',
      name: 'bash',
      arguments: { command: 'cat 工具预取命中记忆' },
      agent: { session: { id: 'tool-prefetch-session', header: { cwd: PROJECT } } },
    }
    await expect(preExecute?.(toolExec, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    const decision = await postExecute?.(
      toolExec,
      { isError: false, content: [{ type: 'text', text: '无关输出' }] },
      async () => ({ kind: 'accept' }),
    ) as { additionalContexts?: { content?: { text?: string }[] }[] } | undefined
    const injected = decision?.additionalContexts?.[0]?.content?.[0]?.text ?? ''
    expect(injected).toContain('工具预取命中记忆')
    dispose()
  })
})
