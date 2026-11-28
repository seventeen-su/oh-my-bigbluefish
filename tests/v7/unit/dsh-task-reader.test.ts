import { describe, expect, it } from 'vitest'
import { createDshTaskReader } from '../../../packages/v7/src/adapters/dsh/tasks.js'
import type { HostContextLike } from '../../../packages/v7/src/adapters/dsh/host.js'

const agent = { id: 'agent-1', status: 'running', name: 'worker' }

const ctx = {
  get(name: string) {
    if (name === 'jobs') {
      return {
        read: (id: string, caller?: string) => id === 'job-1' && caller === 'session-1'
          ? { job: { id, status: 'read-path' }, result: 'ok' }
          : Promise.reject(new Error('unknown or foreign')),
        get: (id: string, caller?: string) => id === 'job-1' && caller === 'session-1'
          ? { id, status: 'running' }
          : Promise.reject(new Error('unknown or foreign')),
      }
    }
    if (name === 'agents') {
      return {
        get: (id: string) => id === agent.id ? agent : undefined,
        list: () => [agent],
      }
    }
    if (name === 'agentTeams') {
      return {
        getTask: (caller: unknown, id: string) => caller === agent && id === 'team-task-1'
          ? { id, status: 'pending', title: '任务' }
          : undefined,
      }
    }
    return undefined
  },
} as unknown as HostContextLike

describe('DSH TaskReader', () => {
  it('reads job field for the owning session', async () => {
    const reader = createDshTaskReader(ctx)
    await expect(reader.read('job', 'job-1', 'status', 'session-1')).resolves.toBe('running')
    await expect(reader.read('job', 'job-1', 'result', 'session-1')).resolves.toBe('ok')
  })

  it('does not read an owned job without the caller session', async () => {
    const reader = createDshTaskReader(ctx)
    await expect(reader.read('job', 'job-1', 'status')).resolves.toBeUndefined()
  })

  it('reads subagent status/name and full summary', async () => {
    const reader = createDshTaskReader(ctx)
    await expect(reader.read('subagent', 'agent-1', 'status')).resolves.toBe('running')
    await expect(reader.read('subagent', 'agent-1', 'name')).resolves.toBe('worker')
    await expect(reader.read('subagent', 'agent-1')).resolves.toEqual({ id: 'agent-1', status: 'running', name: 'worker' })
  })

  it('finds a team task through live agents', async () => {
    const reader = createDshTaskReader(ctx)
    await expect(reader.read('team', 'team-task-1', 'status')).resolves.toBe('pending')
    await expect(reader.read('team', 'team-task-1', 'title')).resolves.toBe('任务')
  })

  it('给定宿主方法依赖 this 当读取任务则仍绑定到服务对象', async () => {
    const boundCtx = {
      get(name: string) {
        if (name === 'jobs') {
          return {
            marker: 'jobs',
            get(this: { marker: string }, id: string) {
              if (this.marker !== 'jobs') throw new Error('jobs this 丢失')
              return { id, status: 'running' }
            },
            read(this: { marker: string }, id: string) {
              if (this.marker !== 'jobs') throw new Error('jobs this 丢失')
              return { id, status: 'read-path', result: 'ok' }
            },
          }
        }
        if (name === 'agents') {
          return {
            marker: 'agents',
            get(this: { marker: string }, id: string) {
              if (this.marker !== 'agents') throw new Error('agents this 丢失')
              return id === agent.id ? agent : undefined
            },
            list(this: { marker: string }) {
              if (this.marker !== 'agents') throw new Error('agents this 丢失')
              return [agent]
            },
          }
        }
        if (name === 'agentTeams') {
          return {
            marker: 'teams',
            getTask(this: { marker: string }, caller: unknown, id: string) {
              if (this.marker !== 'teams') throw new Error('teams this 丢失')
              return caller === agent && id === 'team-task-1'
                ? { id, status: 'pending', title: '任务' }
                : undefined
            },
          }
        }
        return undefined
      },
    } as unknown as HostContextLike

    const reader = createDshTaskReader(boundCtx)
    await expect(reader.read('job', 'job-1', 'result', 'session-1')).resolves.toBe('ok')
    await expect(reader.read('subagent', 'agent-1', 'status')).resolves.toBe('running')
    await expect(reader.read('team', 'team-task-1', 'title')).resolves.toBe('任务')
  })

  it('returns undefined for missing services or tasks', async () => {
    const reader = createDshTaskReader(ctx)
    await expect(reader.read('job', 'missing')).resolves.toBeUndefined()
    await expect(reader.read('subagent', 'missing')).resolves.toBeUndefined()
    await expect(reader.read('team', 'missing')).resolves.toBeUndefined()
  })
})
