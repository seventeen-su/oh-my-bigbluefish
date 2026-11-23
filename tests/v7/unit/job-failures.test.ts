import { describe, expect, it } from 'vitest'
import { PgBossQueue, describeJobHealth } from '../../../packages/v7/src/adapters/pg-boss/index.js'
import type {
  JobFailureLog,
  JobFinalFailure,
  JobFinalFailureSummary,
} from '../../../packages/v7/src/ports/jobs.js'

interface JobLike {
  readonly id: string
  readonly data: unknown
  readonly retryCount: number
}

interface FakeBoss {
  readonly created: string[]
  handler: ((jobs: JobLike[]) => Promise<void>) | undefined
  createQueue(name: string): Promise<void>
  work(name: string, handler: (jobs: JobLike[]) => Promise<void>): Promise<string>
  getJobById(name: string, id: string): Promise<{ retryLimit: number } | null>
}

function queueWithFakeBoss(
  logged: string[],
  options: { retryLimit?: number; failureLog?: JobFailureLog } = {},
): { queue: PgBossQueue; boss: FakeBoss } {
  const queue = new PgBossQueue({
    connectionString: 'postgres://omb:omb@127.0.0.1:5432/omb',
    ...(options.failureLog !== undefined ? { failureLog: options.failureLog } : {}),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: message => logged.push(message),
    },
  })
  const boss: FakeBoss = {
    created: [],
    handler: undefined,
    async createQueue(name) {
      boss.created.push(name)
    },
    async work(_name, handler) {
      boss.handler = handler
      return 'worker-1'
    },
    async getJobById() {
      return { retryLimit: options.retryLimit ?? 3 }
    },
  }
  // 只把 pg-boss 客户端换成内存 fake：被测的是 work 包装器与失败记录，不是 pg-boss 本身。
  const internals = queue as unknown as { boss: FakeBoss; started: boolean }
  internals.boss = boss
  internals.started = true
  return { queue, boss }
}

describe('PgBossQueue handler failure 记录', () => {
  it('给定 handler 抛错当 worker 执行则记录 handler failure 且仍 rethrow', async () => {
    const logged: string[] = []
    const { queue, boss } = queueWithFakeBoss(logged)
    await queue.work('omb.embed', async () => {
      throw new Error('嵌入器没有返回向量')
    })
    const handler = boss.handler
    expect(handler).toBeDefined()

    const job: JobLike = { id: 'job-1', data: { entityId: 'mem_1', text: 'x' }, retryCount: 2 }
    await expect(handler?.([job])).rejects.toThrow('嵌入器没有返回向量')
    expect(logged).toEqual(['后台任务失败：omb.embed'])

    const summary = queue.handlerFailures()
    expect(summary.count).toBe(1)
    expect(summary.recent).toHaveLength(1)
    expect(summary.recent[0]).toMatchObject({
      name: 'omb.embed',
      attempt: 3,
      error: '嵌入器没有返回向量',
      jobId: 'job-1',
    })
    expect(summary.recent[0]?.payload).toBe('{"entityId":"mem_1","text":"x"}')
    expect(summary.recent[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('给定同名任务重试成功当查询状态则清除进程内 handler failure', async () => {
    const logged: string[] = []
    const { queue, boss } = queueWithFakeBoss(logged)
    let fail = true
    await queue.work('omb.embed', async () => {
      if (fail) throw new Error('暂时失败')
    })
    const handler = boss.handler
    const job: JobLike = { id: 'job-recover', data: {}, retryCount: 0 }
    await expect(handler?.([job])).rejects.toThrow('暂时失败')
    expect(queue.handlerFailures().count).toBe(1)

    fail = false
    await handler?.([job])
    expect(queue.handlerFailures()).toEqual({ count: 0, recent: [] })
  })

  it('给定恢复日志写失败当任务成功则仍返回成功并记录错误', async () => {
    const logged: string[] = []
    const failureLog: JobFailureLog = {
      async record() {},
      async recordRecovery() {
        throw new Error('audit down')
      },
      async summary(): Promise<JobFinalFailureSummary> {
        return { count: 0, recent: [] }
      },
    }
    const { queue, boss } = queueWithFakeBoss(logged, { failureLog })
    let fail = true
    await queue.work('omb.embed', async () => {
      if (fail) throw new Error('第一次失败')
    })
    const job: JobLike = { id: 'job-recovery-log-fail', data: {}, retryCount: 0 }
    await expect(boss.handler?.([job])).rejects.toThrow('第一次失败')
    fail = false
    await expect(boss.handler?.([job])).resolves.toBeUndefined()
    expect(queue.handlerFailures().count).toBe(0)
    expect(logged.some(message => message.includes('恢复记录写入失败'))).toBe(true)
  })

  it('给定最后一次重试仍失败当 worker 执行则写持久最终失败', async () => {
    const logged: string[] = []
    const persisted: JobFinalFailure[] = []
    const failureLog: JobFailureLog = {
      async record(failure) {
        persisted.push(failure)
      },
      async summary(limit = 5): Promise<JobFinalFailureSummary> {
        return { count: persisted.length, recent: persisted.slice(-limit).reverse() }
      },
    }
    const { queue, boss } = queueWithFakeBoss(logged, { retryLimit: 2, failureLog })
    await queue.work('omb.embed', async () => {
      throw new Error('重试耗尽')
    })
    const job: JobLike = { id: 'job-final', data: { entityId: 'mem_final' }, retryCount: 2 }
    await expect(boss.handler?.([job])).rejects.toThrow('重试耗尽')

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      jobId: 'job-final',
      name: 'omb.embed',
      attempt: 3,
      retryLimit: 2,
      error: '重试耗尽',
      payload: '{"entityId":"mem_final"}',
    })
    expect((await queue.finalFailures()).count).toBe(1)
  })

  it('给定还有剩余重试当 worker 执行则不写持久最终失败', async () => {
    const logged: string[] = []
    const persisted: JobFinalFailure[] = []
    const failureLog: JobFailureLog = {
      async record(failure) {
        persisted.push(failure)
      },
      async summary(): Promise<JobFinalFailureSummary> {
        return { count: persisted.length, recent: [] }
      },
    }
    const { queue, boss } = queueWithFakeBoss(logged, { retryLimit: 2, failureLog })
    await queue.work('omb.embed', async () => {
      throw new Error('还会重试')
    })
    const job: JobLike = { id: 'job-retry', data: {}, retryCount: 1 }
    await expect(boss.handler?.([job])).rejects.toThrow('还会重试')

    expect(persisted).toHaveLength(0)
  })
})

describe('omb_status 任务健康行', () => {
  it('给定成功启动且无 handler 失败当生成状态则 jobs=on 且 jobFailures=0', () => {
    expect(describeJobHealth({
      enabled: true,
      initialized: true,
      failures: { count: 0, recent: [] },
    })).toEqual(['jobs=on', 'jobFailures=0', 'jobFinalFailures=0'])
  })

  it('给定 handler 失败当生成状态则 jobs=degraded 且带最近一条摘要', () => {
    expect(describeJobHealth({
      enabled: true,
      initialized: true,
      failures: {
        count: 2,
        recent: [{
          name: 'omb.embed',
          payload: '{"entityId":"mem_1"}',
          error: 'boom\nretry',
          at: '2026-11-23T00:00:00.000Z',
          attempt: 3,
          jobId: 'job-1',
        }],
      },
    })).toEqual([
      'jobs=degraded',
      'jobFailures=2',
      'jobFinalFailures=0',
      'jobFailure=kind=handler scope=process-memory name=omb.embed attempt=3 at=2026-11-23T00:00:00.000Z error=boom retry payload={"entityId":"mem_1"}',
    ])
  })

  it('给定持久最终失败当生成状态则 jobs=degraded 且带持久摘要', () => {
    expect(describeJobHealth({
      enabled: true,
      initialized: true,
      failures: { count: 0, recent: [] },
      finalFailures: {
        count: 1,
        recent: [{
          jobId: 'job-final',
          name: 'omb.extract',
          payload: '{}',
          error: '抽取写库失败',
          at: '2026-11-23T01:02:03.000Z',
          attempt: 4,
          retryLimit: 3,
        }],
      },
    })).toEqual([
      'jobs=degraded',
      'jobFailures=0',
      'jobFinalFailures=1',
      'jobFinalFailure=name=omb.extract jobId=job-final attempt=4 retryLimit=3 at=2026-11-23T01:02:03.000Z error=抽取写库失败 payload={}',
    ])
  })

  it('给定持久失败查询失败当生成状态则标明不可用而不是假装为零', () => {
    expect(describeJobHealth({
      enabled: true,
      initialized: true,
      failures: { count: 0, recent: [] },
      finalFailureError: '连接中断',
    })).toEqual([
      'jobs=degraded',
      'jobFailures=0',
      'jobFinalFailures=unavailable',
      'jobFinalFailureError=连接中断',
    ])
  })

  it('给定启动未完成当生成状态则 jobs=degraded 且 jobFailures=0', () => {
    expect(describeJobHealth({
      enabled: true,
      initialized: false,
      failures: { count: 0, recent: [] },
    })).toEqual(['jobs=degraded', 'jobFailures=0', 'jobFinalFailures=0'])
  })
})
