import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PgBossQueue } from '../../../packages/v7/src/adapters/pg-boss/index.js'
import { PostgresDb } from '../../../packages/v7/src/adapters/postgres/db.js'
import { PostgresJobFailureLog } from '../../../packages/v7/src/adapters/postgres/jobs.js'
import { prepareDatabase, resetDatabase, TEST_DATABASE_URL } from './helpers.js'

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待任务失败记录超时')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('等待持久失败记录超时')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('pg-boss queue', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('enqueue → work → stop', async () => {
    const queue = new PgBossQueue({ connectionString: TEST_DATABASE_URL })
    let resolveJob: (() => void) | undefined
    const received = new Promise<void>(resolve => {
      resolveJob = resolve
    })
    await queue.work('omb.test.echo', async payload => {
      expect(payload).toEqual({ value: 42 })
      resolveJob?.()
    })
    await queue.start()
    await queue.enqueue('omb.test.echo', { value: 42 })
    await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('queue timeout')), 10_000)),
    ])
    await queue.stop()
    expect(queue.handlerFailures().count).toBe(0)
    expect((await queue.finalFailures()).count).toBe(0)
  })

  it('handler 抛错时记录 handler failure 且任务不会静默成功', async () => {
    const queue = new PgBossQueue({ connectionString: TEST_DATABASE_URL })
    await queue.work('omb.test.fail', async () => {
      throw new Error('boom')
    })
    await queue.start()
    await queue.enqueue('omb.test.fail', { probe: 'handler-failure' }, { retryLimit: 0 })
    await waitFor(() => queue.handlerFailures().count > 0)
    const [failure] = queue.handlerFailures().recent
    expect(failure?.name).toBe('omb.test.fail')
    expect(failure?.error).toBe('boom')
    expect(failure?.attempt).toBe(1)
    await queue.stop()
  })

  it('重试耗尽时最终失败写审计并可跨查询读取', async () => {
    const db = new PostgresDb({ connectionString: TEST_DATABASE_URL })
    const queue = new PgBossQueue({
      connectionString: TEST_DATABASE_URL,
      failureLog: new PostgresJobFailureLog(db),
    })
    try {
      await queue.work('omb.test.final', async () => {
        throw new Error('final boom')
      })
      await queue.start()
      await queue.enqueue('omb.test.final', { probe: 'final-failure' }, { retryLimit: 1 })
      await waitForAsync(async () => (await queue.finalFailures()).count === 1)

      const summary = await queue.finalFailures()
      expect(summary.recent[0]).toMatchObject({
        name: 'omb.test.final',
        error: 'final boom',
        attempt: 2,
        retryLimit: 1,
        payload: '{"probe":"final-failure"}',
      })

      const audit = await db.query<{ action: string; target_ids: string[]; after: Record<string, unknown> }>(
        `select action, target_ids, after from omb.audit_log where action = 'job-final-failure'`,
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]?.target_ids).toEqual([summary.recent[0]?.jobId])
      expect(audit.rows[0]?.after).toMatchObject({ name: 'omb.test.final', attempt: 2, retryLimit: 1 })
    } finally {
      await queue.stop()
      await db.close()
    }
  })

  it('后续成功解除同名任务的历史最终失败', async () => {
    const name = 'omb.test.recover'
    const db = new PostgresDb({ connectionString: TEST_DATABASE_URL })
    const queue = new PgBossQueue({
      connectionString: TEST_DATABASE_URL,
      failureLog: new PostgresJobFailureLog(db),
    })
    try {
      await queue.work(name, async () => {
        throw new Error('first boom')
      })
      await queue.start()
      await queue.enqueue(name, { probe: 'recover' }, { retryLimit: 0 })
      await waitForAsync(async () => (await queue.finalFailures()).count === 1)

      await queue.work(name, async () => {})
      await queue.enqueue(name, { probe: 'recover' }, { retryLimit: 0 })
      await waitForAsync(async () => (await queue.finalFailures()).count === 0)

      const audit = await db.query<{ action: string }>(
        `select action from omb.audit_log
         where action in ('job-final-failure', 'job-recovered')
         order by id`,
      )
      expect(audit.rows.map(row => row.action)).toEqual(['job-final-failure', 'job-recovered'])
    } finally {
      await queue.stop()
      await db.close()
    }
  }, 30_000)
})
