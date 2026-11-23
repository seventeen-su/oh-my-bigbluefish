import type { JsonValue } from '../../domain/json.js'
import { isJsonValue } from '../../domain/json.js'
import type { TaskReader } from '../../ports/task.js'
import { asRecord, methodOf, readService, type HostContextLike } from './host.js'

function valueOf(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined
}

function fieldOf(value: unknown, field: string | undefined): JsonValue | undefined {
  if (field === undefined) return valueOf(value)
  const record = asRecord(value)
  if (record === undefined) return undefined
  return valueOf(record[field])
}

function fieldOfNested(value: unknown, field: string | undefined): JsonValue | undefined {
  const direct = fieldOf(value, field)
  if (direct !== undefined || field === undefined) return direct
  const record = asRecord(value)
  return record === undefined ? undefined : fieldOf(record['job'], field)
}

/**
 * DSH 结构性 TaskReader：
 * - job: `ctx.jobs.read(id)`；
 * - subagent: `ctx.agents.get(id)`；
 * - team: 遍历 live agents，用 `agentTeams.getTask(agent, id)` 找到所属 Team。
 *
 * 三个服务都是可选的；缺失时返回 undefined，由 resolver 报 not-found/unsupported，
 * 而不是伪造一个任务值。
 */
export function createDshTaskReader(ctx: HostContextLike | undefined): TaskReader {
  return {
    async read(source, id, field, caller) {
      if (source === 'job') {
        const jobs = readService(ctx, 'jobs')
        const read = methodOf(jobs, 'read') as ((id: string, caller?: string) => unknown) | undefined
        const get = methodOf(jobs, 'get') as ((id: string, caller?: string) => unknown) | undefined
        try {
          // get 不移动模型消费游标；只有 result 需要 read（read 会推进游标）。
          if (field !== 'result' && get !== undefined) {
            return fieldOf(await get(id, caller), field)
          }
          if (read === undefined) return undefined
          return fieldOfNested(await read(id, caller), field)
        } catch {
          return undefined
        }
      }
      if (source === 'subagent') {
        const agents = readService(ctx, 'agents')
        const get = methodOf(agents, 'get') as ((id: string) => unknown) | undefined
        if (get === undefined) return undefined
        try {
          const agent = await get(id)
          if (field === undefined) {
            const record = asRecord(agent)
            return record === undefined
              ? undefined
              : valueOf({ id: record['id'], status: record['status'], name: record['name'] })
          }
          return fieldOf(agent, field)
        } catch {
          return undefined
        }
      }
      const teams = readService(ctx, 'agentTeams')
      const getTask = methodOf(teams, 'getTask') as ((agent: unknown, id: string) => unknown) | undefined
      const agents = readService(ctx, 'agents')
      const list = methodOf(agents, 'list') as (() => unknown) | undefined
      if (getTask === undefined || list === undefined) return undefined
      try {
        for (const agent of (await list()) as unknown[]) {
          try {
            const task = await getTask(agent, id)
            if (task !== undefined) return fieldOf(task, field)
          } catch {
            // 该 agent 的 Team 不包含这个 id；继续找下一个。
          }
        }
      } catch {
        return undefined
      }
      return undefined
    },
  }
}
