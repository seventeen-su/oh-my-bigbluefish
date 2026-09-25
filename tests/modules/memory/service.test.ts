/**
 * `StoresService` 测试：用户库单例 + 项目库按 cwd 惰性缓存。
 *
 * 契约（`kernel/abi/storage.ts`）：
 * - `forSession` / `forProject` 未就绪或打开失败一律返回 `undefined`，**绝不抛**
 * - 同一 cwd 复用同一套件；`projectScope` 是套件身份
 * - `close()` 绝不抛
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StorageHostPort } from '../../../kernel/abi/index.js'
import { projectIdentity } from '../../../modules/memory/paths.js'
import {
  StoreClosedError,
  createStoresService,
  projectDbPathFor,
  type MemoryStoresService,
} from '../../../modules/memory/store.js'
import {
  type CapturingLogger,
  capturingLogger,
  countingSqlite,
  fixedClock,
  makeRecord,
  nodeSqlite,
  tempWorkspace,
  testPort,
  type TestPort,
} from './helpers.js'

function makeService(
  port: StorageHostPort | undefined,
  options: { readonly maxOpenProjects?: number } = {},
): { service: MemoryStoresService; logger: CapturingLogger } {
  const logger = capturingLogger()
  const service = createStoresService({
    logger,
    clock: fixedClock(),
    resolvePort: () => port,
    ...(options.maxOpenProjects === undefined ? {} : { maxOpenProjects: options.maxOpenProjects }),
  })
  return { service, logger }
}

describe('StoresService：双库与 cwd 身份', () => {
  it('forProject 打开用户库 + 项目库，migrated 各有一条', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    const set = await service.forProject(ws.dir)
    expect(set).toBeDefined()
    expect(set?.projectScope).toBe(projectIdentity(ws.dir))
    expect(set?.stores.map(tagged => tagged.scope).sort()).toEqual(['project', 'user'])
    expect(set?.store('user')).toBeDefined()
    expect(set?.store('project')).toBeDefined()
    expect(set?.store('project')).not.toBe(set?.store('user'))
    expect(set?.migrated.map(entry => entry.scope).sort()).toEqual(['project', 'user'])
    expect(set?.migrated.every(entry => entry.from === 0 && entry.to === 1)).toBe(true)

    // 路径遵循规划 §5.3 的布局
    expect(port.opened).toEqual([port.userDbPath, projectDbPathFor(ws.dir)])
    expect(existsSync(join(ws.dir, '.omb', 'memory', 'session.db'))).toBe(true)
    expect(existsSync(join(ws.dir, '.omb', 'memory', 'README.md'))).toBe(true)

    await service.close()
    ws.cleanup()
  })

  it('同一 cwd 的不同写法归一到同一套件（只打开一次库）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    const first = await service.forProject(ws.dir)
    const second = await service.forProject(join(ws.dir, 'nested', '..'))
    expect(second).toBe(first)
    expect(port.opened.filter(path => path === projectDbPathFor(ws.dir))).toHaveLength(1)
    expect(service.status().openProjects).toHaveLength(1)

    await service.close()
    ws.cleanup()
  })

  it('并发 forProject 只打开一次（在飞请求去重）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    const [a, b, c] = await Promise.all([
      service.forProject(ws.dir),
      service.forProject(ws.dir),
      service.forProject(ws.dir),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(port.opened).toHaveLength(2) // 用户库 + 项目库各一次

    await service.close()
    ws.cleanup()
  })

  it('forSession：未登记 cwd → 仅用户库（projectScope=null 是显式信号）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    const set = await service.forSession('s-unknown')
    expect(set?.projectScope).toBeNull()
    expect(set?.stores.map(tagged => tagged.scope)).toEqual(['user'])
    expect(set?.store('project')).toBeUndefined()
    expect(port.opened).toEqual([port.userDbPath])

    await service.close()
    ws.cleanup()
  })

  it('forSession：登记 cwd 后拿到项目库', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    service.rememberCwd('s1', ws.dir)
    const set = await service.forSession('s1')
    expect(set?.projectScope).toBe(projectIdentity(ws.dir))
    expect(set?.stores).toHaveLength(2)
    expect(await set?.store('project')?.put(makeRecord({ scope: 'project', id: 'p1' }))).toBeUndefined()
    expect(await set?.store('project')?.get('p1')).toMatchObject({ id: 'p1', text: expect.any(String) })

    await service.close()
    ws.cleanup()
  })

  it('项目库写不进的 scope 直接被拒（位置即权威）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)
    const set = await service.forProject(ws.dir)
    const project = set?.store('project')
    await expect(project?.put(makeRecord({ scope: 'user', id: 'wrong' }))).rejects.toThrow(/scope=user/)
    expect((await project?.stats())?.rows).toBe(0)
    await service.close()
    ws.cleanup()
  })
})

describe('StoresService：降级与诚实原因', () => {
  it('宿主端口未注入：返回 undefined，status/failure 写明原因，绝不抛', async () => {
    const ws = tempWorkspace()
    const { service } = makeService(undefined)

    await expect(service.forProject(ws.dir)).resolves.toBeUndefined()
    await expect(service.forSession('s1')).resolves.toBeUndefined()
    expect(service.status().ready).toBe(false)
    expect(service.status().detail).toContain('宿主未注入')
    expect(service.failure()).toContain('未注入')
    await expect(service.start()).resolves.toBeUndefined()

    await service.close()
    ws.cleanup()
  })

  it('端口后到也能成功（不缓存"未注入"这个失败）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    // 用可变盒子而不是 `let`：`resolvePort` 会在赋值前被读取（这正是不缓存失败的场景）
    const box: { current: StorageHostPort | undefined } = { current: undefined }
    const logger = capturingLogger()
    const service = createStoresService({
      logger,
      clock: fixedClock(),
      resolvePort: () => box.current,
    })

    expect(await service.forProject(ws.dir)).toBeUndefined()
    box.current = port
    const set = await service.forProject(ws.dir)
    expect(set).toBeDefined()
    expect(service.status().ready).toBe(true)

    await service.close()
    ws.cleanup()
  })

  it('库版本高于插件支持：拒绝打开，failure 说明"拒绝打开"而不是"损坏"', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    mkdirSync(join(ws.dir, '.omb', 'memory'), { recursive: true })
    const future = nodeSqlite(port.userDbPath)
    future.exec('PRAGMA user_version = 99')
    future.close()

    const { service } = makeService(port)
    expect(await service.forProject(ws.dir)).toBeUndefined()
    expect(service.status().ready).toBe(false)
    expect(service.failure()).toContain('拒绝打开')
    expect(service.status().detail).toContain('99')

    await service.close()
    ws.cleanup()
  })

  it('项目库打不开时会话仍拿到用户库（降级而非全失）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    // 用目录占住项目库文件位置 → openDatabase 必然失败
    mkdirSync(projectDbPathFor(ws.dir), { recursive: true })

    const { service } = makeService(port)
    service.rememberCwd('s1', ws.dir)

    expect(await service.forProject(ws.dir)).toBeUndefined()
    expect(service.failure()).toContain('项目库打开失败')

    const set = await service.forSession('s1')
    expect(set).toBeDefined()
    expect(set?.projectScope).toBeNull()
    expect(set?.store('user')).toBeDefined()

    await service.close()
    ws.cleanup()
  })

  it('相对 cwd 被拒（不静默锚到进程 cwd）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    expect(await service.forProject('relative/project')).toBeUndefined()
    expect(service.failure()).toContain('绝对 cwd')

    await service.close()
    ws.cleanup()
  })

  it('createDirs=false 时不创建任何目录（目录缺失即打开失败）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir, { createDirs: false })
    const { service } = makeService(port)

    expect(await service.forProject(ws.dir)).toBeUndefined()
    expect(existsSync(join(ws.dir, '.omb'))).toBe(false)

    await service.close()
    ws.cleanup()
  })
})

describe('StoresService：缓存上限与关闭', () => {
  it('超过上限按 LRU 淘汰并关库；用户库不受影响', async () => {
    const ws = tempWorkspace()
    const port: TestPort = testPort(ws.dir)
    const { service, logger } = makeService(port, { maxOpenProjects: 2 })
    const dirs = ['p1', 'p2', 'p3'].map(name => join(ws.dir, name))

    const first = await service.forProject(dirs[0] as string)
    await service.forProject(dirs[1] as string)
    expect(service.status().openProjects).toHaveLength(2)

    await service.forProject(dirs[2] as string)
    const open = service.status().openProjects
    expect(open).toHaveLength(2)
    expect(open).not.toContain(projectIdentity(dirs[0] as string))
    expect(logger.warnings.join('\n')).toContain('淘汰')

    // 被淘汰的项目库已关闭，旧句柄继续用会明确报错；用户库仍可用
    await expect(first?.store('project')?.stats()).rejects.toBeInstanceOf(StoreClosedError)
    await expect(first?.store('user')?.stats()).resolves.toBeDefined()

    await service.close()
    ws.cleanup()
  })

  it('close 幂等、绝不抛；关闭后取库返回 undefined、旧句柄报"已关闭"', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)
    const set = await service.forProject(ws.dir)

    await expect(service.close()).resolves.toBeUndefined()
    await expect(service.close()).resolves.toBeUndefined()
    await expect(service.dispose()).resolves.toBeUndefined()
    expect(await service.forProject(ws.dir)).toBeUndefined()
    expect(await service.forSession('s1')).toBeUndefined()
    expect(service.status().detail).toContain('已关闭')
    await expect(set?.store('project')?.stats()).rejects.toBeInstanceOf(StoreClosedError)

    ws.cleanup()
  })

  it('底层关闭抛异常时 close 仍然 resolve（H-1）', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir, {
      openDatabase: path => {
        const real = countingSqlite(nodeSqlite(path))
        return {
          exec: sql => real.exec(sql),
          prepare: sql => real.prepare(sql),
          close: () => {
            real.close()
            throw new Error('关闭爆炸')
          },
        }
      },
    })
    const { service, logger } = makeService(port)
    expect(await service.forProject(ws.dir)).toBeDefined()

    await expect(service.close()).resolves.toBeUndefined()
    expect(await service.forProject(ws.dir)).toBeUndefined()
    expect(logger.warnings.join('\n')).toContain('关闭爆炸')
    ws.cleanup()
  })

  it('snapshot 与 status 一致：只报已打开的套件', async () => {
    const ws = tempWorkspace()
    const port = testPort(ws.dir)
    const { service } = makeService(port)

    expect(service.snapshot()).toEqual({ user: undefined, projects: [] })
    await service.start() // 预热用户库
    expect(service.snapshot().user).toBeDefined()
    expect(service.status().openProjects).toEqual([])

    await service.forProject(ws.dir)
    expect(service.snapshot().projects).toHaveLength(1)
    expect(service.status().openProjects).toEqual([projectIdentity(ws.dir)])

    await service.close()
    ws.cleanup()
  })
})
