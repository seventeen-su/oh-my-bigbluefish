import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import { createPromptSink, type HostContextLike, type HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { prepareDatabase, resetDatabase, TEST_DATABASE_URL } from './helpers.js'

function wait(ms: number): Promise<void> {
  // 既有 adoption/异步落库等待，T1 改动未新增此模式；后续改条件轮询时一并处理。
  // check:ignore-next-line test-sleep
  return new Promise(resolve => setTimeout(resolve, ms))
}

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'

interface FakeHost {
  ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly promptText: Map<string, string>
  readonly listeners: Map<string, (...args: unknown[]) => unknown>
  readonly logs: string[]
  provider: ((input: unknown) => string) | undefined
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const promptText = new Map<string, string>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const logs: string[] = []
  const push = (level: string, message: unknown) => { logs.push(`${level} ${typeof message === 'string' ? message : JSON.stringify(message)}`) }
  const host: FakeHost = { ctx: undefined as unknown as HostContextLike, tools, promptText, listeners, logs, provider: undefined }
  const ctx = {
    get: (name: string) => {
      if (name === 'tools') {
        return {
          register: (definition: HostToolDefinition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
          // DSH ToolsService.get 的形状：omb_status 的宿主面自检通过它实测注册可见性。
          get: (toolName: string) => tools.get(toolName),
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
    logger: {
      warn: (message: unknown) => push('warn', message),
      error: (message: unknown) => push('error', message),
      info: (message: unknown) => push('info', message),
      debug: () => {},
    },
  }
  host.ctx = ctx as unknown as HostContextLike
  return host
}

/** 有界条件等待；不用固定 sleep 断言异步完成。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await wait(10)
  }
}

interface InjectedMessageLike {
  readonly id?: string
  readonly role?: string
  readonly source?: { readonly kind?: string }
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

/** pre-step decision.messages 里由 OMB 追加的 T1 消息（按 producer-owned source kind 识别）。 */
function t1Messages(decision: unknown): InjectedMessageLike[] {
  const record = typeof decision === 'object' && decision !== null
    ? decision as { messages?: unknown }
    : undefined
  const messages: unknown[] = Array.isArray(record?.messages) ? record.messages : []
  return messages.filter((message): message is InjectedMessageLike => (
    typeof message === 'object'
    && message !== null
    && (message as InjectedMessageLike).source?.kind === 'plugin:oh-my-bigbluefish/v7'
  ))
}

/** T1 文本；systemPrompt provider 读的是 T0 通道，两者必须分别断言。 */
function t1TextOf(decision: unknown): string {
  return t1Messages(decision)
    .flatMap(message => (message.content ?? []).map(block => block.text ?? ''))
    .join('\n')
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
    // 宿主面自检：7 个工具与 4 个钩子都真实接线。
    expect(status?.text).toContain('tools=7/7')
    expect(status?.text).toContain('hooks=4/4')

    const preStep = host.listeners.get('agent/pre-step')
    expect(preStep).toBeDefined()
    const next = async () => ({ kind: 'enter', messages: [] })
    const decision = await preStep?.(
      {
        agent: { session: { id: 'session-smoke', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '插件冒烟记忆' }],
        turn: 1,
      },
      next,
    )
    // 普通指令没有回忆意图/强信号：本步不追加 T1 消息。
    expect(t1Messages(decision)).toHaveLength(0)
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
    const stepDecision = await preStep?.(
      {
        agent: { session: { id: 'tool-t1-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'tool' }, role: 'tool', content: 'ENOENT 工具失败 工具报错召回记忆' }],
        turn: 2,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    // 工具结果已走 additionalContexts；pre-step 不能再追加同一段召回，也不写 system prompt。
    expect(t1Messages(stepDecision)).toHaveLength(0)
    const prompt = host.provider?.({ agent: { session: { id: 'tool-t1-session' } } }) ?? ''
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
      attrs: { title: '工具预取命中记忆', body: '调用前预取', tools: ['bash'] },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preExecute = host.listeners.get('tools/pre-execute')
    const postExecute = host.listeners.get('tools/post-execute')
    expect(preExecute).toBeDefined()
    expect(postExecute).toBeDefined()
    const toolExec = {
      callId: 'call-prefetch-1',
      name: 'bash',
      // 成功工具只在参数含路径/代码样式标识符时才预取并注入；普通调用不再召回。
      arguments: { command: 'cat 工具预取命中记忆 spec.md' },
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

  it('compaction 事件在下一步强制 T1，不依赖回忆意图', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'compaction-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '压缩后重建记忆', body: 'compaction probe' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const event = host.listeners.get('session/event')
    expect(event).toBeDefined()
    // 事件文本与记忆标题共享全文词，但没有回忆意图/强信号：只有 pendingT1 能触发召回。
    event?.(
      { id: 'compaction-session', header: { cwd: PROJECT } },
      { type: 'compaction/start', seq: 1, data: { summary: '压缩后重建记忆' } },
    )

    const preStep = host.listeners.get('agent/pre-step')
    const first = await preStep?.(
      {
        agent: { session: { id: 'compaction-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '你好' }],
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    // T1 走 pre-step 的 decision.messages（producer-owned user message）。
    expect(t1Messages(first)).toHaveLength(1)
    expect(t1TextOf(first)).toContain('[OMB 事件召回]')
    // T0 常驻仍走 systemPrompt provider，T1 不得再混进去。
    const firstPrompt = host.provider?.({ agent: { session: { id: 'compaction-session' } } }) ?? ''
    expect(firstPrompt).toContain('[OMB 常驻]')
    expect(firstPrompt).not.toContain('[OMB 事件召回]')

    const second = await preStep?.(
      {
        agent: { session: { id: 'compaction-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '你好' }],
        turn: 1,
        step: 2,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    // 待消费事件只用一次：下一步没有新触发就不再召回。
    expect(t1Messages(second)).toHaveLength(0)
    expect(host.provider?.({ agent: { session: { id: 'compaction-session' } } })).not.toContain('[OMB 事件召回]')
    dispose()
  })

  it('同一 step 连续两次 post-execute 只挂一段 additionalContexts', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'step-dedupe-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '单步去重召回', body: 'ENOENT 失败 排查', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    await preStep?.(
      {
        agent: { session: { id: 'step-dedupe-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '列出当前目录' }],
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    // 没有强触发：pre-step 本身不该注入 T1，本步的 T1 配额留给工具结果。
    expect(host.provider?.({ agent: { session: { id: 'step-dedupe-session' } } })).not.toContain('[OMB 事件召回]')

    const postExecute = host.listeners.get('tools/post-execute')
    const first = await postExecute?.(
      {
        callId: 'call-step-1',
        name: 'bash',
        arguments: { command: 'cat missing-file-1' },
        agent: { session: { id: 'step-dedupe-session', header: { cwd: PROJECT } } },
      },
      { isError: true, content: [{ type: 'text', text: 'ENOENT 单步去重召回 失败' }] },
      async () => ({ kind: 'accept' }),
    ) as { additionalContexts?: { content?: { text?: string }[] }[] } | undefined
    expect(first?.additionalContexts).toHaveLength(1)

    const second = await postExecute?.(
      {
        callId: 'call-step-2',
        name: 'bash',
        arguments: { command: 'cat missing-file-2' },
        agent: { session: { id: 'step-dedupe-session', header: { cwd: PROJECT } } },
      },
      { isError: true, content: [{ type: 'text', text: 'EACCES 单步去重召回 失败' }] },
      async () => ({ kind: 'accept' }),
    ) as { additionalContexts?: unknown[] } | undefined
    // 同一 turn:step 已经投递过 T1，第二个工具结果不再追加。
    expect(second?.additionalContexts).toBeUndefined()
    dispose()
  })

  it('无关成功工具不触发 T1 注入', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'plain-tool-session', header: { cwd: PROJECT } } } }
    // 这条记忆与工具输出共享 bash/total/0，且触发器命中 bash：若没有闸门会被召回。
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '普通命令输出探针', body: 'total 0 command ls', tools: ['bash'] },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    await preStep?.(
      {
        agent: { session: { id: 'plain-tool-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: '你好' }],
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const postExecute = host.listeners.get('tools/post-execute')
    const decision = await postExecute?.(
      {
        callId: 'call-ls',
        name: 'bash',
        arguments: { command: 'ls' },
        agent: { session: { id: 'plain-tool-session', header: { cwd: PROJECT } } },
      },
      { isError: false, content: [{ type: 'text', text: 'total 0' }] },
      async () => ({ kind: 'accept' }),
    ) as { additionalContexts?: unknown[] } | undefined
    expect(decision?.additionalContexts).toBeUndefined()
    dispose()
  })

  it('T1 不写 system prompt：下一步没有 T1 时 prompt 只留 T0', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'stale-clear-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '清旧命中记忆', body: '上次失败 处理方式', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    const first = await preStep?.(
      {
        agent: { session: { id: 'stale-clear-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: 'ENOENT 上次失败的处理方式是什么' }],
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(t1Messages(first)).toHaveLength(1)
    expect(t1TextOf(first)).toContain('[OMB 事件召回]')
    // T1 只出现在 decision.messages；systemPrompt provider 只承载 T0。
    const firstPrompt = host.provider?.({ agent: { session: { id: 'stale-clear-session' } } }) ?? ''
    expect(firstPrompt).toContain('[OMB 常驻]')
    expect(firstPrompt).not.toContain('[OMB 事件召回]')

    const second = await preStep?.(
      {
        agent: { session: { id: 'stale-clear-session', header: { cwd: PROJECT } } },
        // 与记忆共享全文词，但没有回忆意图/强信号：新 T1 必须为空。
        messages: [{ source: { kind: 'user' }, content: '清旧命中记忆的标题是什么' }],
        turn: 1,
        step: 2,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(t1Messages(second)).toHaveLength(0)
    const prompt = host.provider?.({ agent: { session: { id: 'stale-clear-session' } } }) ?? ''
    // RUN-04：T0 仍要覆盖写，上一轮的 T1 也不能留在系统提示里。
    expect(prompt).toContain('[OMB 常驻]')
    expect(prompt).not.toContain('[OMB 事件召回]')
    dispose()
  })

  it('同一错误工具结果连续两个 pre-step 只注入一次 T1', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'repeat-pre-step-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '重复错误召回', body: 'ENOENT 失败 处理方式', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    const payload = {
      agent: { session: { id: 'repeat-pre-step-session', header: { cwd: PROJECT } } },
      messages: [
        { source: { kind: 'user' }, content: 'ENOENT 上次失败的处理方式是什么' },
        { source: { kind: 'tool' }, role: 'tool', content: 'ENOENT 重复错误召回 失败' },
      ],
      turn: 1,
      step: 1,
    }
    const first = await preStep?.(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(t1Messages(first)).toHaveLength(1)
    expect(t1TextOf(first)).toContain('[OMB 事件召回]')

    // 只有步号变化、事件源内容完全一致：跨 step 内容指纹必须挡住第二次召回。
    const second = await preStep?.(
      { ...payload, step: 2 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(t1Messages(second)).toHaveLength(0)
    const prompt = host.provider?.({ agent: { session: { id: 'repeat-pre-step-session' } } }) ?? ''
    expect(prompt).not.toContain('[OMB 事件召回]')
    expect(prompt).toContain('[OMB 常驻]')
    dispose()
  })

  it('pre-step 在 next() 之后追加 T1：宿主认领的消息原样保留在前', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'append-contract-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '追加契约召回探针', body: 'ENOENT 失败 处理方式', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const claimed = [{
      id: 'msg_claimed_a',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'ENOENT 上次失败的处理方式是什么' }],
    }]
    const decision = await host.listeners.get('agent/pre-step')?.(
      {
        agent: { session: { id: 'append-contract-session', header: { cwd: PROJECT } } },
        messages: claimed,
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: claimed }),
    ) as { messages?: InjectedMessageLike[] } | undefined

    const messages = decision?.messages ?? []
    expect(messages).toHaveLength(2)
    // T1 是追加，不是替换：宿主已排好的认领消息保持原位置与身份。
    expect(messages[0]).toBe(claimed[0])
    const t1 = t1Messages(decision)
    expect(t1).toHaveLength(1)
    expect(t1[0]?.id).toMatch(/^msg_omb_[0-9a-f-]{36}$/)
    expect(t1[0]?.role).toBe('user')
    expect(t1[0]?.source).toEqual({ kind: 'plugin:oh-my-bigbluefish/v7' })
    expect(t1TextOf(decision)).toContain('[OMB 事件召回]')
    dispose()
  })

  it('同一 step 连续两次 pre-step 只追加一次 T1 消息', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'same-step-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '单步配额召回', body: 'ENOENT 失败 处理方式', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    const payload = {
      agent: { session: { id: 'same-step-session', header: { cwd: PROJECT } } },
      messages: [{ source: { kind: 'user' }, content: 'ENOENT 上次失败的处理方式是什么' }],
      turn: 1,
      step: 1,
    }
    const first = await preStep?.(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(t1Messages(first)).toHaveLength(1)

    const again = await preStep?.(payload, async () => ({ kind: 'enter', messages: [] }))
    // 同一步配额：即使事件源完全相同，第二次 pre-step 也不能再追加一条。
    expect(t1Messages(again)).toHaveLength(0)
    dispose()
  })

  it('宿主 reject 的 step 不追加 T1，也不占用本步配额', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'reject-step-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '拒绝步召回', body: 'ENOENT 失败 处理方式', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    const payload = {
      agent: { session: { id: 'reject-step-session', header: { cwd: PROJECT } } },
      messages: [{ source: { kind: 'user' }, content: 'ENOENT 上次失败的处理方式是什么' }],
      turn: 1,
      step: 1,
    }
    const rejected = await preStep?.(payload, async () => ({ kind: 'reject' }))
    // reject 没有 messages：OMB 不能往它上面追加任何东西。
    expect(rejected).toEqual({ kind: 'reject' })

    // 同一步重新进入时配额没有被白占：T1 仍然要追加一次。
    const entered = await preStep?.(payload, async () => ({ kind: 'enter', messages: [] }))
    expect(t1Messages(entered)).toHaveLength(1)
    dispose()
  })

  it('本轮 T0 为空时 pre-step 仍覆盖写空串，清掉上一轮常驻文本', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const session = { id: 'empty-t0-session', header: { cwd: PROJECT } }
    const preStep = host.listeners.get('agent/pre-step')
    const enter = async () => ({ kind: 'enter', messages: [] })

    await preStep?.(
      { agent: { session }, messages: [{ source: { kind: 'user' }, content: '你好' }], turn: 1, step: 1 },
      enter,
    )
    expect(host.provider?.({ agent: { session } })).toContain('[OMB 常驻]')

    // 本轮 T0 构建超过 1.5s 预算（锁住它读的表即可让构建超时）时 buildResident 返回空，
    // 这只是“没有 T0 可写”的现实入口；断言的是清旧行为，不是造数据。
    const blocker = new PostgresStore(TEST_DATABASE_URL)
    try {
      await blocker.db.transaction(async client => {
        await client.query('lock table omb.entity in access exclusive mode')
        await preStep?.(
          { agent: { session }, messages: [{ source: { kind: 'user' }, content: '你好' }], turn: 2, step: 1 },
          enter,
        )
      })
    } finally {
      await blocker.close()
    }
    // RUN-04：没有 T0 也必须覆盖写空串，否则上一轮的常驻文本会留在 system prompt。
    expect(host.provider?.({ agent: { session } })).toBe('')
    dispose()
  })

  it('session/disposed 清理该 session 的 T1 缓存与提示文本', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    const exec = { agent: { session: { id: 'disposed-session', header: { cwd: PROJECT } } } }
    const remembered = await host.tools.get('omb_remember')?.execute({
      kind: 'memory',
      category: 'fact',
      scope: 'project',
      attrs: { title: '处置清理记忆', body: 'ENOENT 失败', error: 'ENOENT' },
    }, exec)
    expect(remembered?.ok).toBe(true)

    const preStep = host.listeners.get('agent/pre-step')
    const first = await preStep?.(
      {
        agent: { session: { id: 'disposed-session', header: { cwd: PROJECT } } },
        messages: [{ source: { kind: 'user' }, content: 'ENOENT 上次的报错' }],
        turn: 1,
        step: 1,
      },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(t1Messages(first)).toHaveLength(1)
    expect(host.provider?.({ agent: { session: { id: 'disposed-session' } } })).not.toContain('[OMB 事件召回]')

    const postExecute = host.listeners.get('tools/post-execute')
    const toolExec = {
      callId: 'call-disposed-1',
      name: 'bash',
      arguments: { command: 'cat missing-file' },
      agent: { session: { id: 'disposed-session', header: { cwd: PROJECT } } },
    }
    const toolResult = { isError: true, content: [{ type: 'text', text: 'ENOENT 处置清理记忆 失败' }] }
    const skipped = await postExecute?.(toolExec, toolResult, async () => ({ kind: 'accept' })) as {
      additionalContexts?: unknown[]
    } | undefined
    // 本步的 T1 已由 pre-step 消费。
    expect(skipped?.additionalContexts).toBeUndefined()

    const dismissed = host.listeners.get('session/disposed')
    expect(dismissed).toBeDefined()
    dismissed?.({ id: 'disposed-session' })
    expect(host.provider?.({ agent: { session: { id: 'disposed-session' } } })).toBe('')

    const again = await postExecute?.(
      { ...toolExec, callId: 'call-disposed-2' },
      toolResult,
      async () => ({ kind: 'accept' }),
    ) as { additionalContexts?: unknown[] } | undefined
    // 步键与指纹缓存都已清空：同一片段可以重新投递，不会命中残留去重。
    expect(again?.additionalContexts).toHaveLength(1)
    dispose()
  })

  it('promptSink 写空串后该 session 读取为空串', () => {
    const host = fakeHost()
    const sink = createPromptSink(host.ctx)
    expect(sink.available).toBe(true)
    expect(sink.write('sink-session', '[OMB 事件召回]\n相关：旧文本')).toBe(true)
    expect(host.provider?.({ agent: { session: { id: 'sink-session' } } })).toContain('[OMB 事件召回]')
    expect(sink.write('sink-session', '')).toBe(true)
    expect(host.provider?.({ agent: { session: { id: 'sink-session' } } })).toBe('')
    sink.dispose()
  })

  it('disposer 顺序收尾 queue.stop → store.close，重复调用不重复收尾', async () => {
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: TEST_DATABASE_URL,
      autoMigrate: true,
      jobs: false,
      residentBudget: 300,
    })
    expect(host.tools.size).toBe(7)
    // 卸载：disposer 同步返回，队列/连接池在后台按序收尾；任何一步都不许抛回宿主。
    expect(() => dispose()).not.toThrow()
    await waitUntil(() => host.logs.some(line => line.includes('teardown 收尾完成')))
    expect(() => dispose()).not.toThrow()

    const infoLines = host.logs.filter(line => line.startsWith('info '))
    const queueIndex = infoLines.findIndex(line => line.includes('teardown queue.stop 完成'))
    const storeIndex = infoLines.findIndex(line => line.includes('teardown store.close 完成'))
    expect(queueIndex).toBeGreaterThanOrEqual(0)
    expect(storeIndex).toBeGreaterThan(queueIndex)
    expect(host.logs.filter(line => line.includes('teardown 收尾完成'))).toHaveLength(1)
    expect(host.logs.some(line => line.includes('teardown') && line.startsWith('warn '))).toBe(false)
  })
})
