import { describe, expect, it } from 'vitest'
import { createToolDefinitions, type ToolRuntime } from '../../../packages/v7/src/adapters/dsh/tools.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'

const CWD = 'D:\\Program\\Oh-My-BigBlueFish'
const CONTEXT = { sessionId: 'session-1', cwd: CWD, projectKey: CWD }
const EXEC = { agent: { session: { id: 'session-1', header: { cwd: CWD } } }, sessionId: 'session-1' }
const TOOL_NAMES = ['omb_remember', 'omb_recall', 'omb_update', 'omb_link', 'omb_history', 'omb_status', 'omb_admin']
/** 工具结果错误文本上限：校验失败只回传摘要，服务端不把整份 issue 文本回灌模型。 */
const MAX_ERROR_CHARS = 1024

interface Stub {
  readonly runtime: ToolRuntime
  readonly calls: string[]
  readonly remembered: WriteEntityInput[]
}

function stubRuntime(): Stub {
  const calls: string[] = []
  const remembered: WriteEntityInput[] = []
  const runtime: ToolRuntime = {
    context: async () => CONTEXT,
    remember: async input => {
      calls.push('remember')
      remembered.push(input)
      return { ok: true, value: 'remembered' }
    },
    recall: async () => {
      calls.push('recall')
      return { ok: true, value: 'recalled' }
    },
    update: async () => {
      calls.push('update')
      return { ok: true, value: 'updated' }
    },
    link: async () => {
      calls.push('link')
      return { ok: true, value: 'linked' }
    },
    unlink: async () => {
      calls.push('unlink')
      return { ok: true, value: 'unlinked' }
    },
    supersede: async () => {
      calls.push('supersede')
      return { ok: true, value: 'superseded' }
    },
    retract: async () => {
      calls.push('retract')
      return { ok: true, value: 'retracted' }
    },
    history: async () => {
      calls.push('history')
      return { ok: true, value: 'history' }
    },
    status: async () => {
      calls.push('status')
      return { ok: true, value: 'status' }
    },
    admin: async () => {
      calls.push('admin')
      return { ok: true, value: 'admin' }
    },
  }
  return { runtime, calls, remembered }
}

function toolOf(runtime: ToolRuntime, name: string) {
  const definition = createToolDefinitions(runtime).find(item => item.name === name)
  if (definition === undefined) throw new Error(`缺少工具：${name}`)
  return definition
}

function propertyOf(properties: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = properties[name]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`缺少参数属性：${name}`)
  return value as Record<string, unknown>
}

function propertiesOf(runtime: ToolRuntime, name: string): Record<string, unknown> {
  const parameters = toolOf(runtime, name).parameters as { properties?: Record<string, unknown> }
  if (parameters.properties === undefined) throw new Error(`工具 ${name} 的 parameters 缺少 properties`)
  return parameters.properties
}

/** 合法 OMB id（40 字符），用于凑长度而不触发 id 语义校验。 */
function validIds(length: number): string[] {
  return Array.from({ length }, (_, index) => `mem_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
}

async function runRemember(stub: Stub, args: unknown): Promise<{ ok: boolean; text: string }> {
  return toolOf(stub.runtime, 'omb_remember').execute(args, EXEC)
}

describe('v7 工具输入上限与校验失败摘要', () => {
  it('给定 7 个工具当创建定义则名称与顺序不变且正常调用仍走 runtime', async () => {
    const stub = stubRuntime()
    const definitions = createToolDefinitions(stub.runtime)
    expect(definitions.map(definition => definition.name)).toEqual(TOOL_NAMES)
    for (const definition of definitions) {
      // 宿主只收纯 JSON 记录：zod 升级后 parameters 仍不得带 $schema 标记。
      expect((definition.parameters as { type?: unknown }).type).toBe('object')
      expect(JSON.stringify(definition.parameters)).not.toContain('$schema')
    }

    const remembered = await runRemember(stub, { kind: 'memory', category: 'fact', attrs: { answer: 42 } })
    expect(remembered).toEqual({ ok: true, text: 'remembered' })
    expect(stub.remembered[0]).toMatchObject({
      kind: 'memory',
      category: 'fact',
      scope: { kind: 'project', projectKey: CWD },
      attrs: { answer: 42 },
    })
    expect(await toolOf(stub.runtime, 'omb_status').execute({}, EXEC)).toEqual({ ok: true, text: 'status' })
    expect(stub.calls).toEqual(['remember', 'status'])
  })

  it('给定 memory 顶层 title 当调用 remember 则映射到 attrs.title，不静默丢弃', async () => {
    const stub = stubRuntime()
    await runRemember(stub, {
      kind: 'memory',
      category: 'fact',
      title: '本机有 GitHub CLI',
      attrs: { body: '可以直接用 gh' },
    })
    expect(stub.remembered[0]).toMatchObject({
      kind: 'memory',
      attrs: { title: '本机有 GitHub CLI', body: '可以直接用 gh' },
    })
  })

  it('给定 attrs.title 与顶层 title 同时存在当调用 remember 则保留 attrs.title', async () => {
    const stub = stubRuntime()
    await runRemember(stub, {
      kind: 'memory',
      category: 'fact',
      title: '顶层标题',
      attrs: { title: '属性标题', body: '正文' },
    })
    expect(stub.remembered[0]).toMatchObject({
      attrs: { title: '属性标题', body: '正文' },
    })
  })

  it('给定 remember 参数当生成宿主 JSON Schema 则数组与字符串带上限', () => {
    const stub = stubRuntime()
    const properties = propertiesOf(stub.runtime, 'omb_remember')
    expect(propertyOf(properties, 'group')).toMatchObject({ maxItems: 64 })
    expect(propertyOf(propertyOf(properties, 'group'), 'items')).toMatchObject({ maxLength: 64 })
    expect(propertyOf(properties, 'title')).toMatchObject({ maxLength: 500 })
    expect(JSON.stringify(properties)).not.toContain('$schema')
  })

  it('给定 recall 与 update 参数当生成宿主 JSON Schema 则过滤数组与查询带上限', () => {
    const stub = stubRuntime()
    const recall = propertiesOf(stub.runtime, 'omb_recall')
    expect(propertyOf(recall, 'status')).toMatchObject({ maxItems: 32 })
    expect(propertyOf(recall, 'query')).toMatchObject({ maxLength: 4096 })
    const update = propertiesOf(stub.runtime, 'omb_update')
    expect(propertyOf(update, 'group')).toMatchObject({ maxItems: 64 })
  })

  it('给定 10 万个非法 group 元素当调用 omb_remember 则错误文本不超过 1024 字符', async () => {
    const stub = stubRuntime()
    const group = Array.from({ length: 100_000 }, () => ({}))

    const result = await runRemember(stub, { kind: 'memory', category: 'fact', group })

    expect(result.ok).toBe(false)
    expect(result.text.length).toBeLessThanOrEqual(MAX_ERROR_CHARS)
    expect(result.text).toContain('group')
    expect(result.text).toContain('100000')
    expect(stub.calls).toEqual([])
  })

  it('给定 10 万个非法 group 元素当调用 omb_remember 则不逐元素进入 schema 解析', async () => {
    const stub = stubRuntime()
    let elementReads = 0
    const group = new Proxy(new Array<unknown>(100_000), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) elementReads += 1
        return Reflect.get(target, key, receiver)
      },
    })

    const result = await runRemember(stub, { kind: 'memory', category: 'fact', group })

    expect(result.ok).toBe(false)
    expect(elementReads).toBe(0)
    expect(stub.calls).toEqual([])
  })

  it('给定 group 超过 64 项当调用 omb_remember 则拒绝且不调用 runtime', async () => {
    const stub = stubRuntime()
    const result = await runRemember(stub, { kind: 'memory', category: 'fact', group: validIds(65) })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('invalid-input')
    expect(result.text).toContain('64')
    expect(result.text).toContain('65')
    expect(stub.calls).toEqual([])
  })

  it('给定 update 的 group 超过 64 项当调用 omb_update 则拒绝且不调用 runtime', async () => {
    const stub = stubRuntime()
    const result = await toolOf(stub.runtime, 'omb_update').execute(
      { id: validIds(1)[0], expectedRevision: 1, group: validIds(65) },
      EXEC,
    )
    expect(result.ok).toBe(false)
    expect(result.text).toContain('64')
    expect(stub.calls).toEqual([])
  })

  it('给定 status 超过 32 项当调用 omb_recall 则拒绝且不调用 runtime', async () => {
    const stub = stubRuntime()
    const status = Array.from({ length: 33 }, () => 'bogus')
    const result = await toolOf(stub.runtime, 'omb_recall').execute({ query: 'x', status }, EXEC)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('32')
    expect(result.text).toContain('33')
    expect(stub.calls).toEqual([])
  })

  it('给定 20 个非法 status 值当校验失败则只回传前 3 条摘要', async () => {
    const stub = stubRuntime()
    const status = Array.from({ length: 20 }, () => 'bogus')
    const result = await toolOf(stub.runtime, 'omb_recall').execute({ query: 'x', status }, EXEC)
    expect(result.ok).toBe(false)
    expect(result.text.length).toBeLessThanOrEqual(MAX_ERROR_CHARS)
    expect(result.text).toContain('另有 17 个问题')
    expect(stub.calls).toEqual([])
  })

  it('给定 501 字 title 当调用 omb_remember 则拒绝且文本有界', async () => {
    const stub = stubRuntime()
    const result = await runRemember(stub, { kind: 'memory', category: 'fact', title: 'x'.repeat(501) })
    expect(result.ok).toBe(false)
    expect(result.text.length).toBeLessThanOrEqual(MAX_ERROR_CHARS)
    expect(result.text).toContain('title')
    expect(stub.calls).toEqual([])
  })

  it('给定超过 4096 字符的 query 当调用 omb_recall 则拒绝且文本有界', async () => {
    const stub = stubRuntime()
    const result = await toolOf(stub.runtime, 'omb_recall').execute({ query: 'x'.repeat(4097) }, EXEC)
    expect(result.ok).toBe(false)
    expect(result.text.length).toBeLessThanOrEqual(MAX_ERROR_CHARS)
    expect(stub.calls).toEqual([])
  })
})
