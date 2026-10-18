/**
 * v4.1 §3.6：项目身份统一（记忆库）。
 *
 * 判据：
 * ① `ensureProject` / `forProject` / `peek` 一律先解析**项目根**，`projectScope` 与项目库
 *    路径都用根；同一仓库不同子目录的会话**共享同一个项目库**（只打开一次）；
 * ② 非 git / 无 projectRootOf / 解析失败 / 相对根 → 退化为 cwd（行为与 v4.0 一致）；
 * ③ 不同根仍是不同项目（不会被"统一"错并）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectIdentity } from '../../../modules/memory/paths.js'
import { createStoresService, projectDbPathFor } from '../../../modules/memory/store.js'
import {
  capturingLogger,
  fixedClock,
  tempWorkspace,
  testPort,
  testSessionCwds,
  type TempWorkspace,
} from './helpers.js'

function makeService(options: {
  readonly rootOf?: (cwd: string) => string
  readonly cwds?: ReturnType<typeof testSessionCwds>
} = {}) {
  const ws: TempWorkspace = tempWorkspace('omb-project-root-')
  const port = testPort(ws.dir)
  const logger = capturingLogger()
  const cwds = options.cwds ?? testSessionCwds()
  const service = createStoresService({
    logger,
    clock: fixedClock(),
    resolvePort: () => port,
    ...cwds,
    ...(options.rootOf === undefined ? {} : { projectRootOf: options.rootOf }),
  })
  return { ws, port, cwds, service, logger }
}

/** 造一个"仓库根 + 两个子目录"的真实目录树（Windows 上也能 resolve）。 */
function repoTree(ws: TempWorkspace): { root: string; sub1: string; sub2: string } {
  const root = ws.dir
  const sub1 = join(root, 'packages', 'alpha')
  const sub2 = join(root, 'packages', 'beta')
  mkdirSync(sub1, { recursive: true })
  mkdirSync(sub2, { recursive: true })
  return { root, sub1, sub2 }
}

describe('项目根统一（v4.1 §3.6）', () => {
  it('同一仓库的两个子目录会话共享同一个项目库（只打开一次，项目路径在根）', async () => {
    // 自建一套临时仓库树（makeService 的默认目录树不含子目录）
    const base = tempWorkspace('omb-project-root-')
    const tree = repoTree(base)
    const port = testPort(base.dir)
    const cwds = testSessionCwds()
    cwds.remember('s1', tree.sub1)
    cwds.remember('s2', tree.sub2)
    const service = createStoresService({
      logger: capturingLogger(),
      clock: fixedClock(),
      resolvePort: () => port,
      ...cwds,
      projectRootOf: cwd => (cwd === tree.root || cwd.startsWith(`${tree.root}\\`) || cwd.startsWith(`${tree.root}/`) ? tree.root : cwd),
    })

    const set1 = await service.forSession('s1')
    const set2 = await service.forSession('s2')
    expect(set1).toBeDefined()
    expect(set2).toBeDefined()
    expect(set1?.projectScope).toBe(projectIdentity(tree.root))
    expect(set2?.projectScope).toBe(projectIdentity(tree.root))
    // 同一个项目库实例（不是两个 cwd 各开一个）
    expect(set1?.store('project')).toBe(set2?.store('project'))
    const projectDb = projectDbPathFor(tree.root)
    expect(port.opened.filter(path => path.endsWith('session.db'))).toEqual([projectDb])
    expect(existsSync(join(tree.root, '.omb', 'memory', 'session.db'))).toBe(true)
    // 子目录下没有自己的库
    expect(existsSync(join(tree.sub1, '.omb', 'memory', 'session.db'))).toBe(false)

    // peek 也按根解析（capture 的 currentProject 与 omb_project 的 store 都读它）
    expect(service.peek('s1')?.projectScope).toBe(projectIdentity(tree.root))

    await service.close()
    base.cleanup()
  })

  it('首会话在子目录、后会话在根：仍是同一个库（反向顺序同样成立）', async () => {
    const base = tempWorkspace('omb-project-root-')
    const tree = repoTree(base)
    const port = testPort(base.dir)
    const cwds = testSessionCwds()
    cwds.remember('s-sub', tree.sub2)
    cwds.remember('s-root', tree.root)
    const service = createStoresService({
      logger: capturingLogger(),
      clock: fixedClock(),
      resolvePort: () => port,
      ...cwds,
      projectRootOf: cwd => (cwd === tree.root || cwd.startsWith(`${tree.root}/`) || cwd.startsWith(`${tree.root}\\`) ? tree.root : cwd),
    })
    const sub = await service.forSession('s-sub')
    const root = await service.forSession('s-root')
    expect(sub?.projectScope).toBe(projectIdentity(tree.root))
    expect(root?.projectScope).toBe(projectIdentity(tree.root))
    expect(sub?.store('project')).toBe(root?.store('project'))
    expect(port.opened.filter(path => path.endsWith('session.db'))).toHaveLength(1)
    await service.close()
    base.cleanup()
  })

  it('项目库路径用根：子目录会话写入落在 <root>/.omb/memory/session.db', async () => {
    const base = tempWorkspace('omb-project-root-')
    const tree = repoTree(base)
    const port = testPort(base.dir)
    const cwds = testSessionCwds()
    cwds.remember('s1', tree.sub1)
    const service = createStoresService({
      logger: capturingLogger(),
      clock: fixedClock(),
      resolvePort: () => port,
      ...cwds,
      projectRootOf: () => tree.root,
    })
    const set = await service.forSession('s1')
    expect(set?.projectScope).toBe(projectIdentity(tree.root))
    await set?.store('project')?.put({
      id: 'p1',
      scope: 'project',
      kind: 'episodic',
      text: '项目根统一后写在根库',
      contentHash: 'hash-p1',
      sourceRef: 'session:s1#1',
      assertedBy: 'execution',
      observedAt: 1_700_000_000_000,
      validTo: null,
      supersededBy: null,
      lastUsedAt: 1_700_000_000_000,
      useCount: 0,
      project: set.projectScope ?? null,
    })
    // 根库里有这条；cwd 的旧路径没有库
    expect(projectDbPathFor(tree.root)).toBe(port.opened.find(path => path.endsWith('session.db')))
    expect(existsSync(join(tree.sub1, '.omb', 'memory', 'session.db'))).toBe(false)
    await service.close()
    base.cleanup()
  })

  it('无 projectRootOf：退化为 cwd（v4.0 行为不变）', async () => {
    const built = makeService()
    const set = await built.service.forProject(built.ws.dir)
    expect(set?.projectScope).toBe(projectIdentity(built.ws.dir))
    expect(built.port.opened).toEqual([built.port.userDbPath, projectDbPathFor(built.ws.dir)])
    await built.service.close()
    built.ws.cleanup()
  })

  it('projectRootOf 抛错 / 返回空串 / 返回相对路径 → 一律回退 cwd（不静默采用进程 cwd）', async () => {
    const cases: readonly ((cwd: string) => string)[] = [
      () => {
        throw new Error('git exploded')
      },
      () => '',
      () => '.',
    ]
    for (const rootOf of cases) {
      const built = makeService({ rootOf })
      const set = await built.service.forProject(built.ws.dir)
      expect(set?.projectScope).toBe(projectIdentity(built.ws.dir))
      expect(built.port.opened).toContain(projectDbPathFor(built.ws.dir))
      await built.service.close()
      built.ws.cleanup()
    }
  })

  it('不同根仍是不同项目：两个仓库各开各的库', async () => {
    const first = tempWorkspace('omb-project-root-a-')
    const second = tempWorkspace('omb-project-root-b-')
    const treeA = repoTree(first)
    const treeB = repoTree(second)
    const port = testPort(first.dir)
    const cwds = testSessionCwds()
    cwds.remember('a', join(treeA.root, 'packages', 'alpha'))
    cwds.remember('b', join(treeB.root, 'packages', 'beta'))
    const service = createStoresService({
      logger: capturingLogger(),
      clock: fixedClock(),
      resolvePort: () => port,
      ...cwds,
      projectRootOf: cwd =>
        cwd.startsWith(`${treeA.root}\\`) || cwd.startsWith(`${treeA.root}/`) || cwd === treeA.root
          ? treeA.root
          : cwd.startsWith(`${treeB.root}\\`) || cwd.startsWith(`${treeB.root}/`) || cwd === treeB.root
            ? treeB.root
            : cwd,
    })
    const a = await service.forSession('a')
    const b = await service.forSession('b')
    expect(a?.projectScope).toBe(projectIdentity(treeA.root))
    expect(b?.projectScope).toBe(projectIdentity(treeB.root))
    expect(a?.store('project')).not.toBe(b?.store('project'))
    await service.close()
    first.cleanup()
    second.cleanup()
  })
})
