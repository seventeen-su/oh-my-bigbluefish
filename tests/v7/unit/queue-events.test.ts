import { describe, expect, it } from 'vitest'
import { PgBossQueue } from '../../../packages/v7/src/adapters/pg-boss/index.js'

describe('PgBossQueue error boundary', () => {
  it('consumes pg-boss error events instead of letting EventEmitter throw', () => {
    const logged: string[] = []
    const queue = new PgBossQueue({
      connectionString: 'postgres://omb:omb@127.0.0.1:5432/omb',
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: message => logged.push(message),
      },
    })
    const boss = (queue as unknown as {
      boss: { emit(event: string, error: unknown): boolean }
    }).boss

    const failure = new Error('terminating connection due to administrator command')
    expect(() => boss.emit('error', failure)).not.toThrow()
    expect(logged).toEqual(['pg-boss 错误（队列将重试）：terminating connection due to administrator command'])
  })
})
