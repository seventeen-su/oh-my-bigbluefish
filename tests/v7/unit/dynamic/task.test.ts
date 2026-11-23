import { describe, expect, it } from 'vitest'
import { DefaultDynamicResolver } from '../../../../packages/v7/src/adapters/dynamic/index.js'
import type { DynamicContext } from '../../../../packages/v7/src/ports/dynamic.js'
import { FakeContext, expectOmbError } from './helpers.js'

const resolver = new DefaultDynamicResolver()

describe('task 动态值', () => {
  it('给定 subagent 任务字段则经 readTask 返回', async () => {
    const context = new FakeContext({ tasks: { 'subagent:agent-1.status': 'completed' } })
    const value = await resolver.resolve({ kind: 'task', source: 'subagent', id: 'agent-1', field: 'status' }, context)
    expect(value).toBe('completed')
    expect(context.taskCalls).toEqual([{ source: 'subagent', id: 'agent-1', field: 'status' }])
  })

  it('给定 team 任务不带字段则返回整个任务值', async () => {
    const context = new FakeContext({ tasks: { 'team:tree-1': { state: 'running', progress: 0.5 } } })
    const value = await resolver.resolve({ kind: 'task', source: 'team', id: 'tree-1' }, context)
    expect(value).toEqual({ state: 'running', progress: 0.5 })
  })

  it('给定 job 任务则按 job 来源读取', async () => {
    const context = new FakeContext({ tasks: { 'job:job-7': 'queued' } })
    const value = await resolver.resolve({ kind: 'task', source: 'job', id: 'job-7' }, context)
    expect(value).toBe('queued')
    expect(context.taskCalls).toEqual([{ source: 'job', id: 'job-7' }])
  })

  it('给定任务不存在则报 not-found', async () => {
    const context = new FakeContext()
    await expectOmbError(resolver.resolve({ kind: 'task', source: 'subagent', id: 'ghost' }, context), 'not-found', /任务不存在/)
  })

  it('给定 readTask 抛错则包成 OmbFailure', async () => {
    const context = new FakeContext()
    const failing: DynamicContext = {
      depth: 0,
      now: context.now,
      async getAttribute() {
        return undefined
      },
      async readFile() {
        return ''
      },
      async readTask() {
        throw new Error('job store offline')
      },
    }
    await expectOmbError(resolver.resolve({ kind: 'task', source: 'job', id: 'job-1' }, failing), 'internal', /offline/)
  })
})
