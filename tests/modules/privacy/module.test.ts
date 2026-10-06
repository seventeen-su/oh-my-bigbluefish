/**
 * 模块级集成：命令 → 状态 → 持久化 → 重启后仍在；血缘 → 继承；fail-closed 粘性。
 *
 * 用**真内核**（`createKernel`）+ 假宿主 `commands` 服务（只记录注册项并让它可被调用），
 * 其余全是真的：真的 JSON 文件、真的 `SessionRuntimeTable`、真的 `PrivacyGate`。
 *
 * **3.6 起装配的是 `omb-memory`**（隐私闸门并入记忆库）：`omb-privacy` 那一行没了，
 * 但本文件断言的行为一条都不该少——换的是装配入口，不是契约。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createKernel } from '../../../kernel/index.js'
import type { Kernel, ModuleRegistration, StatusRegistry, ToolDefinition } from '../../../kernel/abi/index.js'
import { MODULE_CATALOG, SERVICES, toolsServiceFor } from '../../../kernel/abi/index.js'
import {
  privacyConfigSchema,
  PRIVACY_SERVICE,
  SESSION_RUNTIME_SERVICE,
} from '../../../modules/memory/privacy/index.js'
import type { PrivacyGate, PrivacyGatePort } from '../../../modules/memory/privacy/gate.js'
import type { CommandResultLike } from '../../../modules/memory/privacy/command.js'
import {
  MEMORY_CONFIG_DEFAULTS,
  MODULE_ID,
  createMemoryRegistration,
  memoryConfigSchema,
} from '../../../modules/memory/index.js'
import { capturingLogger, tempWorkspace, testPort } from '../memory/helpers.js'

interface FakeCommands {
  readonly definitions: {
    readonly name: string
    readonly definitionId: string
    /**
     * 必须能被读出来：`input` 缺了会让**带参数**的命令失效，
     * 而不带参数的路径照常工作——正是那种只在真实使用时才暴露的静默回退。
     */
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: unknown) => CommandResultLike | Promise<CommandResultLike>
  }[]
  readonly service: { register(definition: unknown): () => void }
  readonly disposed: () => number
}

function fakeCommands(): FakeCommands {
  const definitions: FakeCommands['definitions'] = []
  let disposeCount = 0
  return {
    definitions,
    service: {
      register(definition: unknown): () => void {
        definitions.push(definition as FakeCommands['definitions'][number])
        return () => {
          disposeCount += 1
        }
      },
    },
    disposed: () => disposeCount,
  }
}

/**
 * `omb-memory` 依赖 `omb-kernel`，所以装配集合里必须有内核那一行（测试替身）。
 * 3.6 起隐私闸门由**记忆库**提供，因此这里起的是记忆库，不再是隐私模块。
 */
const kernelRow: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.6.0',
    requires: [],
    capabilities: [],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试替身' }),
  },
  apply: () => {},
}

/**
 * 记忆库注册项：存储端口指向状态文件所在目录，**隐私状态文件因此也落在临时目录里**
 * （不然单测会去读开发者真实的 `~/.dsh/.omb/privacy/session-modes.json`）。
 */
function memoryRegistrationFor(path: string): ReturnType<typeof createMemoryRegistration> {
  return createMemoryRegistration({ storageHost: testPort(dirname(path)) })
}

/** 记忆库配置：隐私子块用测试给的路径（生产里由 `cordis.patch.yml` 的同名子块给）。 */
function memoryConfigFor(
  path: string,
  failClosedMode: 'sealed' | 'read-only' = 'sealed',
): unknown {
  return { ...MEMORY_CONFIG_DEFAULTS, privacy: { failClosedMode, path } }
}

/** 起一个内核 + 装配记忆库（可注入宿主命令服务与状态文件路径）。 */
function boot(options: {
  readonly path: string
  readonly commands?: FakeCommands
  readonly failClosedMode?: 'sealed' | 'read-only'
  /** false = 宿主没有 commands 服务（命令面应如实缺席，闸门照常生效）。 */
  readonly withCommands?: boolean
}): {
  kernel: Kernel
  dispose: () => void
  commands: FakeCommands
  registration: ReturnType<typeof createMemoryRegistration>
} {
  const handle = createKernel({ logger: capturingLogger() })
  const commands = options.commands ?? fakeCommands()
  if (options.withCommands !== false) handle.kernel.provide('commands', commands.service)
  const registration = memoryRegistrationFor(options.path)
  const blocked = handle.start(
    [kernelRow, registration],
    new Map([['omb-memory', memoryConfigFor(options.path, options.failClosedMode ?? 'sealed')]]),
  )
  if (blocked.length > 0) {
    throw new Error(`记忆库被依赖规划阻断：${blocked.map(item => item.reason).join('；')}`)
  }
  return { kernel: handle.kernel, dispose: () => handle.dispose(), commands, registration }
}

async function runCommand(
  commands: FakeCommands,
  rawInput: string,
  agent?: unknown,
): Promise<CommandResultLike> {
  const definition = commands.definitions.find(item => item.name === 'omb-privacy')
  if (definition === undefined) throw new Error('命令未注册')
  return await definition.handler({ rawInput, agent: agent ?? { id: 's1' } })
}

describe('注册面', () => {
  it('隐私能力并入 omb-memory 的目录条目（能力名不变：privacy.modes）', () => {
    // 3.6：`omb-privacy` 不再是模块。能力的**归属**换了，**名字**没换——
    // 名字是状态面与开关的对外契约，改它就是破坏性变更。
    const entry = MODULE_CATALOG.find(candidate => candidate.id === MODULE_ID)
    expect(entry).toBeDefined()
    expect(entry?.capabilities).toContain('privacy.modes')
    // 目录里不该再有 omb-privacy 这个模块（三方一致：目录 / MODULE_IDS / cordis.patch.yml 行）
    expect(
      MODULE_CATALOG.some(candidate => candidate.id === ('omb-privacy' as never)),
      '目录里还留着 omb-privacy 条目——那一行已经删了，留着就是"看起来权威但不驱动"的声明',
    ).toBe(false)
    // manifest 的 capabilities 照抄目录（派生，不手写）
    const registration = createMemoryRegistration()
    expect(registration.manifest.id).toBe(MODULE_ID)
    expect(registration.manifest.requires).toEqual(entry?.requires)
    expect(registration.manifest.capabilities).toEqual(entry?.capabilities)
  })

  it('配置缺省值完整，且 failClosedMode 只允许两种受限档', () => {
    expect(privacyConfigSchema.parse(undefined)).toEqual({ failClosedMode: 'sealed', path: null })
    expect(privacyConfigSchema.parse({ failClosedMode: 'read-only' })).toMatchObject({ failClosedMode: 'read-only' })
    expect(() => privacyConfigSchema.parse({ failClosedMode: 'normal' })).toThrow()
    // 并入记忆库后，配置从**记忆库的 `privacy` 子块**进来（原 `omb-privacy` 行的 config 块）
    expect(memoryConfigSchema.parse({ privacy: { failClosedMode: 'read-only' } }).privacy)
      .toEqual({ failClosedMode: 'read-only', path: null })
    expect(memoryConfigSchema.parse(undefined).privacy).toEqual({ failClosedMode: 'sealed', path: null })
  })

  it('装配后：判定端口、会话运行态、命令、状态面贡献都在；卸载后服务清空', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'session-modes.json') })
      expect(booted.kernel.service(PRIVACY_SERVICE)).toBeDefined()
      expect(booted.kernel.service(SESSION_RUNTIME_SERVICE)).toBeDefined()
      expect(booted.commands.definitions.map(d => d.name)).toContain('omb-privacy')
      /**
       * **必须声明 `input`——否则带参数的命令用不了。**
       *
       * 实测症状（用户报告，2026-09-30）：`/omb-privacy`（不带参数）正常，
       * `/omb-privacy read-only`（带参数）被当成普通文本送进模型。
       *
       * 根因在 DSH 客户端 `ui-commands` 的判定表
       * （`packages/client/ui-commands/src/client/service.ts:269` 与 `:282`）：
       * 只有 `desc.input !== undefined` 时前端才"认领"命令后面的参数；
       * 决策表注释写的是 `host input → claim; host bare → detached execute`。
       *
       * 这条断言看着琐碎，但它挡的是一个**只影响带参数路径**的静默回退——
       * 不带参数的测试全都会通过，只有真去用参数才会发现。
       */
      const privacyCommand = booted.commands.definitions.find(d => d.name === 'omb-privacy')
      expect(
        privacyCommand?.input,
        '未声明 input → 前端不认领参数 → /omb-privacy read-only 会被当文本送给模型',
      ).toBeDefined()
      expect(privacyCommand?.input?.hint, 'hint 要在输入框里提示参数怎么给').toContain('read-only')
      const registry = booted.kernel.service<StatusRegistry>(SERVICES.statusContributor)
      expect(registry?.list().map(c => c.name)).toContain('隐私')

      expect(() => booted.dispose()).not.toThrow()
      expect(booted.kernel.service(PRIVACY_SERVICE)).toBeUndefined()
      expect(booted.commands.disposed()).toBe(1)
    } finally {
      ws.cleanup()
    }
  })

  it('宿主没有 commands 服务时：闸门照常生效，只是命令缺席（不抛，且如实说"未注册"）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const booted = boot({ path, withCommands: false })
      expect(booted.kernel.service(PRIVACY_SERVICE)).toBeDefined()
      // 命令面缺席**必须可读**：健康面写明未注册与原因，而不是静默少一条命令
      const health = await booted.registration.manifest.health()
      expect(health.detail).toContain('命令面：omb-privacy **未注册**')
      expect(health.detail).toContain('commands')
      expect(() => booted.dispose()).not.toThrow()
    } finally {
      ws.cleanup()
    }
  })
})

describe('命令 → 生效 → 持久化', () => {
  it('/omb-privacy sealed 立刻生效，并写进状态文件', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const booted = boot({ path })
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('s1')).toMatchObject({ allowRead: true, allowWrite: true })

      const result = await runCommand(booted.commands, 'sealed')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('sealed')
      expect(result.text).toContain('已持久化')

      expect(gate?.decide('s1')).toMatchObject({ allowRead: false, allowWrite: false })
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('"s1": "sealed"')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('**重启后同一会话仍然生效**（新内核 + 新模块实例，读同一个文件）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'read-only')
      first.dispose()

      // 模拟 dsh 重启：全新内核 + 全新模块实例，只有磁盘上的文件是共享的
      const second = boot({ path })
      const gate = second.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('s1')).toMatchObject({ allowRead: true, allowWrite: false })
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('read-only：读放行、写被拒（重启后的第二次判定也一样）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      await runCommand(booted.commands, 'read-only')
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      const decision = gate?.decide('s1')
      expect(decision?.allowRead).toBe(true)
      expect(decision?.allowWrite).toBe(false)
      expect(decision?.writeReason).toContain('read-only')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

/**
 * G1（P0）：受限记录不再永久粘性。
 *
 * 现场：任一会话被设过 `read-only`/`sealed`，该条目就永久留在 `session-modes.json`，
 * 每次启动被重放进运行态表 → `#anyRestricted()` 从此恒真 → **所有**后续会话的
 * "归属未知写"（向量编码队列经 `stores.snapshot()` 落盘 `putEmbedding`）一律被拒，
 * 语义召回静默退化成词法召回，而健康面仍是 ok。
 *
 * 修法**不是放宽 fail-closed**：判据收紧到"本进程内真的活跃过"，
 * 并给用户补上清除入口（`forget` / `clear`）与状态面的两个数。
 */
describe('受限记录不再永久粘性（G1 / P0）', () => {
  const gateOf = (booted: { kernel: Kernel }): PrivacyGatePort | undefined =>
    booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)

  it('重启后不对旧会话做任何操作 → 归属未知的写放行，而该会话自己的判定仍然生效', async () => {
    const ws = tempWorkspace('omb-privacy-sticky-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'sealed', { id: 'A' })
      // 反向断言之一：A 在**本进程内**设过模式（命令走 noteLineage → note）→ 仍然拒
      expect(gateOf(first)?.decideUnattributed()).toMatchObject({ allowRead: true, allowWrite: false })
      expect(readFileSync(path, 'utf8')).toContain('"A": "sealed"')
      first.dispose()

      // 模拟 dsh 重启：全新内核 + 全新模块实例，只有磁盘上的状态文件是共享的
      const second = boot({ path })
      // **不对 A 做任何操作**：它只是状态文件里的一条历史记录
      expect(gateOf(second)?.decideUnattributed()).toEqual({
        allowRead: true,
        allowWrite: true,
        readReason: '',
        writeReason: '',
      })
      // 按会话的判定不受影响：真的回到 A 时，sealed 照旧生效
      expect(gateOf(second)?.decide('A')).toMatchObject({ allowRead: false, allowWrite: false })
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('反向断言：从状态文件重放进来的会话**重新活跃**后，归属未知的写必须再次被拒', async () => {
    const ws = tempWorkspace('omb-privacy-sticky-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'read-only', { id: 'A' })
      first.dispose()

      const second = boot({ path })
      const gate = gateOf(second)
      expect(gate?.decideUnattributed().allowWrite).toBe(true) // 尚未活跃

      // 宿主会话事件（生产路径由 adopt 的 on 路由到宿主事件面）→ 该会话真的活了
      const emitSessionEvent = second.kernel.emit as unknown as (event: string, payload: unknown) => void
      emitSessionEvent('session/event', { header: { id: 'A' } })
      expect(gate?.decideUnattributed()).toMatchObject({ allowRead: true, allowWrite: false })
      // 计数如实上涨：状态面能看出"这次拒绝是因为真的存在受限会话"
      expect(second.kernel.service<PrivacyGate>(PRIVACY_SERVICE)?.stats().unattributedWriteDenials).toBeGreaterThan(0)
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('反向断言：从已结束会话**继承**受限档的活跃子会话，同样禁住归属未知的写', async () => {
    const ws = tempWorkspace('omb-privacy-sticky-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'sealed', { id: 'parent' })
      first.dispose()

      const second = boot({ path })
      const gate = gateOf(second)
      expect(gate?.decideUnattributed().allowWrite, '父会话只是历史记录').toBe(true)

      // 子代理会话活了：父会话（已结束）没有再发任何事件，但子在跑并继承 sealed
      const emitSessionEvent = second.kernel.emit as unknown as (event: string, payload: unknown) => void
      emitSessionEvent('session/event', { header: { id: 'child', parentSession: 'parent', delegationDepth: 1 } })
      expect(gate?.decide('child')).toMatchObject({ allowRead: false, allowWrite: false })
      expect(
        gate?.decideUnattributed(),
        '受限会话是"继承来的"，它不出现在显式记录里——漏掉它等于静默放行',
      ).toMatchObject({ allowRead: true, allowWrite: false })
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('命令面有清除入口：forget <id> 清掉单条记录并落盘，该会话回到基线', async () => {
    const ws = tempWorkspace('omb-privacy-forget-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const booted = boot({ path })
      await runCommand(booted.commands, 'sealed', { id: 'A' })
      expect(gateOf(booted)?.decide('A')).toMatchObject({ allowWrite: false })

      const result = await runCommand(booted.commands, 'forget A')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('A')
      expect(gateOf(booted)?.decide('A')).toMatchObject({ allowRead: true, allowWrite: true })
      expect(readFileSync(path, 'utf8')).not.toContain('"A"')

      // 落盘生效：同一条记录不会再被下一次启动重放
      booted.dispose()
      const again = boot({ path })
      expect(gateOf(again)?.decide('A')).toMatchObject({ allowRead: true, allowWrite: true })
      again.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('对没有设置的会话 forget：如实说"没有可清除的记录"，不假装清过', async () => {
    const ws = tempWorkspace('omb-privacy-forget-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const result = await runCommand(booted.commands, 'forget 查无此会话')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('没有显式隐私设置')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('clear 只清**已结束**的会话：本进程内活跃会话的设置原样保留', async () => {
    const ws = tempWorkspace('omb-privacy-clear-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'sealed', { id: 'dead' })
      first.dispose()

      const second = boot({ path })
      await runCommand(second.commands, 'read-only', { id: 'live' }) // 本进程内活跃
      const result = await runCommand(second.commands, 'clear')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('已清除 1 个已结束会话')

      expect(gateOf(second)?.decide('dead'), '已结束会话的记录该被清掉').toMatchObject({ allowRead: true, allowWrite: true })
      expect(gateOf(second)?.decide('live'), '活跃会话的限制不许被批量清理顺手放宽').toMatchObject({ allowRead: true, allowWrite: false })
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { modes: Record<string, string> }
      expect(Object.keys(doc.modes)).toEqual(['live'])
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('状态面把两个数分开说：历史受限记录 N 条（其中本进程活跃 M 条）', async () => {
    const ws = tempWorkspace('omb-privacy-counts-')
    const path = join(ws.dir, 'session-modes.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'sealed', { id: 'old' })
      first.dispose()

      const second = boot({ path })
      await runCommand(second.commands, 'sealed', { id: 'live' })
      const text = (await runCommand(second.commands, 'status')).text
      expect(text).toContain('历史受限记录 2 条（其中本进程活跃 1 条）')
      expect(text).toContain('old=sealed（已结束）')
      expect(text).toContain('live=sealed（活跃）')
      // 出口本身也要在状态面里点得到名，否则用户不知道有这条命令
      expect(text).toContain('/omb-privacy clear')

      const registry = second.kernel.service<StatusRegistry>(SERVICES.statusContributor)
      const rendered = registry?.list().find(c => c.name === '隐私')?.render() ?? ''
      expect(rendered).toContain('历史受限记录 2 条（其中本进程活跃 1 条）')
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

describe('子代理继承（血缘来自宿主会话头）', () => {
  it('宿主 session/event 登记 parentSession → 子会话继承父会话的模式', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      await runCommand(booted.commands, 'sealed', { id: 'parent' })

      // 宿主会话事件：会话头里带 parentSession（生产路径由 adopt 的 on 路由到宿主事件面）
      const emitSessionEvent = booted.kernel.emit as unknown as (event: string, payload: unknown) => void
      emitSessionEvent('session/event', { header: { id: 'child', parentSession: 'parent', delegationDepth: 1 } })

      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      const childDecision = gate?.decide('child')
      expect(childDecision).toMatchObject({ allowRead: false, allowWrite: false })
      expect(childDecision?.writeReason).toContain('继承自 parent')

      // 父会话改回 normal → 子会话立刻跟着变
      await runCommand(booted.commands, 'normal', { id: 'parent' })
      expect(gate?.decide('child')).toMatchObject({ allowRead: true, allowWrite: true })
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('命令 invocation 的血统也会被登记（两条来源都算数）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      await runCommand(booted.commands, 'sealed', { id: 'p2' })
      // 子代理里执行的命令：agent.session.header.parentSession
      await runCommand(booted.commands, 'status', {
        id: 'c2',
        session: { header: { parentSession: 'p2', delegationDepth: 1 } },
      })
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('c2')).toMatchObject({ allowRead: false, allowWrite: false })
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

describe('fail-closed（读不出状态时按最严）', () => {
  it('状态文件损坏 → 所有会话按 sealed、归属未知禁写、状态面写明原因', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'broken.json')
    try {
      writeFileSync(path, '{ 这不是 JSON', 'utf8')
      const booted = boot({ path })
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('any-session')).toMatchObject({ allowRead: false, allowWrite: false })
      expect(gate?.decide('any-session').readReason).toContain('fail-closed')
      expect(gate?.decideUnattributed()).toMatchObject({ allowRead: true, allowWrite: false })

      const registry = booted.kernel.service<StatusRegistry>(SERVICES.statusContributor)
      const rendered = registry?.list().find(c => c.name === '隐私')?.render() ?? ''
      expect(rendered).toContain('fail-closed')
      expect(rendered).toContain('sealed')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('粘性：损坏被写回后**下次启动仍然**是 fail-closed（不会被悄悄放宽）', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'broken.json')
    try {
      writeFileSync(path, 'garbage', 'utf8')
      boot({ path }).dispose() // 第一次启动：读到损坏 + 把粘性标记写回
      expect(readFileSync(path, 'utf8')).toContain('failClosedAt')

      const second = boot({ path }) // 第二次启动：文件现在是合法 JSON，但标记还在
      const gate = second.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('x')).toMatchObject({ allowRead: false })
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('/omb-privacy trust 是唯一的解除途径（显式人类动作）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'broken.json')
    try {
      writeFileSync(path, 'garbage', 'utf8')
      const booted = boot({ path })
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('x').allowWrite).toBe(false)

      const trusted = await runCommand(booted.commands, 'trust')
      expect(trusted.kind).toBe('success')
      expect(trusted.text).toContain('已清除 fail-closed')
      expect(gate?.decide('x')).toMatchObject({ allowRead: true, allowWrite: true })
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('delete 状态文件 = 从未配置过（基线 normal，不是 fail-closed）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'never.json') })
      const gate = booted.kernel.service<PrivacyGatePort>(PRIVACY_SERVICE)
      expect(gate?.decide('s1')).toMatchObject({ allowRead: true, allowWrite: true })
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

describe('健康面与状态面', () => {
  it('隐私读数并进记忆库的健康面（基线、状态文件、命令面、metrics 带命名空间）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'm.json')
    try {
      const booted = boot({ path })
      const health = await booted.registration.manifest.health()
      // 3.6：隐私不再是独立模块，读数必须出现在**记忆库那一行**里——
      // 不并进来，插件页会显示"记忆库正常"而对隐私的降级只字不提。
      expect(health.detail).toContain('隐私闸门（/omb-privacy）')
      expect(health.detail).toContain('基线=normal（从未配置过）')
      expect(health.detail).toContain(path)
      expect(health.detail).toContain('命令面：omb-privacy 已注册')
      expect(health.metrics?.['privacy.sessionsWithMode']).toBeTypeOf('number')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('health detail 把"历史 N 条 / 本进程活跃 M 条"分开写（混报就是下一轮的自相矛盾）', async () => {
    const ws = tempWorkspace('omb-privacy-health-')
    const path = join(ws.dir, 'm.json')
    try {
      const first = boot({ path })
      await runCommand(first.commands, 'sealed', { id: 'old' })
      first.dispose()

      // 重启后：文件里还有 old，但本进程里它从未活跃
      const second = boot({ path })
      const health = await second.registration.manifest.health()
      expect(health.detail).toContain('历史受限记录 1 条（其中本进程活跃 0 条）')
      expect(health.metrics?.['privacy.restrictedSessions']).toBe(1)
      expect(health.metrics?.['privacy.restrictedSessionsActive']).toBe(0)
      second.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('status 文本包含用法与状态文件位置', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const text = (await runCommand(booted.commands, 'status')).text
      // 标题里写清"它是记忆库的东西"——用户看到 /omb-privacy 却找不到 omb-privacy 那一行时，
      // 这行字就是唯一的解释
      expect(text).toContain('隐私模式（记忆库的隐私闸门，命令 /omb-privacy）')
      expect(text).toContain('/omb-privacy')
      expect(text).toContain('状态文件')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

/**
 * **不变量：模型不能自己解除限制。**
 *
 * ## 这一段的历史（值得留着，因为它记录了一次设计反复）
 *
 * 最初模块**刻意不注册任何工具**，理由是"隐私模式是**用户**的决定，不该由模型自己改"。
 *
 * 后来我实测发现 Web 里够不着命令，于是**加了 `omb_privacy` 工具**，用结构性手段
 * （只能收紧 / 放宽需 `allowLoosen`）保住原意图。
 *
 * 再后来用户报告"`/omb-privacy` 能用，`/omb-privacy xxx` 不能用"，查出根因是
 * **注册时没声明 `input` 描述符**——DSH 客户端只在 `desc.input !== undefined` 时
 * 才认领命令后面的参数（`packages/client/ui-commands/src/client/service.ts:269`）。
 * 补上 `input` 后命令带参数可用。
 *
 * **于是工具就没有存在理由了**——用户决定移除它，回到原设计：
 * **隐私只由用户通过命令改，模型既不在工具面也不在命令面碰它。**
 *
 * ## 3.6：断言跟着"归属"搬家，强度只增不减
 *
 * 隐私并入记忆库后，"本模块没有工具"这句话失去了主语（没有那个模块了）。
 * 于是判据换成**更硬也更准**的两条：记忆库的工具名是**白名单**（新增一个就红），
 * 且每个工具的参数面里不许出现档位关键词（防"换个名字但能改隐私"）。
 * 这两条守的是**目的**（模型无法自己解除限制），而不是"某个文件里没有某个字符串"——
 * 将来若有人加回一条能改隐私的工具，下面的断言会立刻红。
 */
describe('不变量：模型不能自己解除限制', () => {
  it('记忆库的工具面里没有任何能改隐私的入口（工具名是白名单，参数面也没有档位词）', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const tools = booted.kernel.service<readonly ToolDefinition[]>(toolsServiceFor(MODULE_ID))
      expect(tools, '记忆库没提供工具服务（tools:omb-memory）').toBeDefined()
      /**
       * **白名单**，不是"过滤一下看看"：新增任何工具都会让这条红。
       * 加之前必须先回答一个问题——"它能不能把 sealed/read-only 改回 normal"。
       * 能，就不许加（隐私是用户的决定，模型只能收紧、不能放宽，最好连工具都没有）。
       */
      expect(tools?.map(tool => tool.name).sort()).toEqual([
        'omb_forget',
        'omb_recall',
        'omb_relate',
        'omb_remember',
      ])
      // 参数面里也不许出现档位关键词：防"换个名字但能改隐私"（例如 `mode: 'sealed'`）
      for (const tool of tools ?? []) {
        expect(
          JSON.stringify(tool.parameters),
          `${tool.name} 的参数面里出现了隐私档位关键词——模型因此可能自己改隐私`,
        ).not.toMatch(/sealed|read-only|privacy/i)
      }
      // 旧形态的独立工具面（`tools:omb-privacy`）不该存在
      expect(booted.kernel.services().filter(name => name === 'tools:omb-privacy')).toEqual([])
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})