import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../../../plugin/v7/index.js'
import type { HostContextLike, HostToolDefinition } from '../../../packages/v7/src/adapters/dsh/host.js'
import { prepareDatabase, resetDatabase } from './helpers.js'

const PROJECT = 'D:\\Program\\Oh-My-BigBlueFish'
const EXEC = { agent: { session: { id: 'startup-recovery', header: { cwd: PROJECT } } } }

interface FakeHost {
  readonly ctx: HostContextLike
  readonly tools: Map<string, HostToolDefinition>
  readonly errors: string[]
}

function fakeHost(): FakeHost {
  const tools = new Map<string, HostToolDefinition>()
  const errors: string[] = []
  const ctx = {
    get: (name: string) => name === 'tools'
      ? {
          register: (definition: HostToolDefinition) => {
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        }
      : undefined,
    on: () => () => {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
    },
  }
  return { ctx: ctx as unknown as HostContextLike, tools, errors }
}

const openSockets = new Set<Socket>()

function startProxy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(client => {
      const upstream = connect({ host: '127.0.0.1', port: 5432 })
      openSockets.add(client)
      openSockets.add(upstream)
      const closeBoth = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.pipe(upstream).pipe(client)
      client.once('error', closeBoth)
      upstream.once('error', closeBoth)
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function closeProxy(server: Server | undefined): Promise<void> {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  if (server === undefined) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (port === undefined) throw new Error('无法分配测试端口')
  return port
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('v7 startup recovery', () => {
  beforeAll(async () => {
    await prepareDatabase()
  })

  afterEach(async () => {
    await resetDatabase()
  })

  it('does not keep a startup failure after PostgreSQL becomes reachable', async () => {
    const port = await freePort()
    const host = fakeHost()
    const dispose = apply(host.ctx, {
      databaseUrl: `postgres://omb:omb@127.0.0.1:${port}/omb_v7_test`,
      autoMigrate: true,
      jobs: false,
      residentBudget: 100,
    })
    let proxy: Server | undefined
    try {
      // 让插件的首次初始化真实失败，而不是只假设它会失败。
      await waitFor(() => host.errors.some(message => message.includes('ECONNREFUSED')))
      const down = await host.tools.get('omb_status')?.execute({}, {})
      expect(down?.text).toContain('db=down')
      expect(down?.text).toContain('jobFailures=0')

      proxy = await startProxy(port)
      const recovered = await host.tools.get('omb_status')?.execute({}, {})
      expect(recovered?.text).toContain('db=ok')

      const remembered = await host.tools.get('omb_remember')?.execute({
        kind: 'memory',
        category: 'fact',
        scope: 'project',
        attrs: { title: '启动恢复测试', body: '数据库恢复后同一个进程可写' },
      }, EXEC)
      expect(remembered?.ok).toBe(true)
      expect(remembered?.text).toContain('已写入 memory')
    } finally {
      await closeProxy(proxy)
      dispose()
    }
  })
})
