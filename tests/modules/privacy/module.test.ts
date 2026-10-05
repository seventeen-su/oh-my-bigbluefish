/**
 * 模块级集成：命令 → 状态 → 持久化 → 重启后仍在；血缘 → 继承；fail-closed 粘性。
 *
 * 用**真内核**（`createKernel`）+ 假宿主 `commands` 服务（只记录注册项并让它可被调用），
 * 其余全是真的：真的 JSON 文件、真的 `SessionRuntimeTable`、真的 `PrivacyGate`。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKernel } from '../../../kernel/index.js'
import type { Kernel, StatusRegistry } from '../../../kernel/abi/index.js'
import { SERVICES } from '../../../kernel/abi/index.js'
import {
  createPrivacyRegistration,
  MODULE_ID,
  privacyConfigSchema,
  PRIVACY_SERVICE,
  SESSION_RUNTIME_SERVICE,
} from '../../../modules/privacy/index.js'
import type { PrivacyGate, PrivacyGatePort } from '../../../modules/privacy/gate.js'
import type { CommandResultLike } from '../../../modules/privacy/command.js'
import { capturingLogger, tempWorkspace } from '../memory/helpers.js'

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

/** 装配并拿到 disposer（`apply` 的返回类型允许 void，测试里断言它确实给了）。 */
function mount(
  kernel: Kernel,
  registration: ReturnType<typeof createPrivacyRegistration>,
  config: { failClosedMode: 'sealed' | 'read-only'; path: string | null },
): () => void {
  const dispose = registration.apply(kernel, config)
  if (typeof dispose !== 'function') throw new Error('模块 apply 未返回 disposer（宿主无法卸载）')
  return dispose
}

/** 起一个内核 + 装配隐私模块（可注入宿主命令服务与状态文件路径）。 */
function boot(options: {
  readonly path: string
  readonly commands?: FakeCommands
  readonly failClosedMode?: 'sealed' | 'read-only'
}): { kernel: Kernel; dispose: () => void; commands: FakeCommands } {
  const handle = createKernel({ logger: capturingLogger() })
  const commands = options.commands ?? fakeCommands()
  handle.kernel.provide('commands', commands.service)
  const registration = createPrivacyRegistration()
  const dispose = mount(handle.kernel, registration, {
    failClosedMode: options.failClosedMode ?? 'sealed',
    path: options.path,
  })
  return { kernel: handle.kernel, dispose: () => dispose(), commands }
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
  it('模块 id / requires / capabilities 来自目录（派生，不手写）', () => {
    const registration = createPrivacyRegistration()
    expect(registration.manifest.id).toBe(MODULE_ID)
    expect(registration.manifest.requires).toEqual(['omb-kernel'])
    expect(registration.manifest.capabilities).toEqual(['privacy.modes'])
  })

  it('配置缺省值完整，且 failClosedMode 只允许两种受限档', () => {
    expect(privacyConfigSchema.parse(undefined)).toEqual({ failClosedMode: 'sealed', path: null })
    expect(privacyConfigSchema.parse({ failClosedMode: 'read-only' })).toMatchObject({ failClosedMode: 'read-only' })
    expect(() => privacyConfigSchema.parse({ failClosedMode: 'normal' })).toThrow()
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

  it('宿主没有 commands 服务时：闸门照常生效，只是命令缺席（不抛）', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const handle = createKernel({ logger: capturingLogger() })
      const registration = createPrivacyRegistration()
      const dispose = mount(handle.kernel, registration, {
        failClosedMode: 'sealed',
        path: join(ws.dir, 'session-modes.json'),
      })
      expect(handle.kernel.service(PRIVACY_SERVICE)).toBeDefined()
      expect(() => dispose()).not.toThrow()
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
  it('health 带 metrics 与可读 detail（含基线与状态文件）', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    const path = join(ws.dir, 'm.json')
    try {
      const handle = createKernel({ logger: capturingLogger() })
      const registration = createPrivacyRegistration()
      const dispose = mount(handle.kernel, registration, { failClosedMode: 'sealed', path })

      const health = await registration.manifest.health()
      expect(health.state).toBe('ok')
      expect(health.detail).toContain('基线')
      expect(health.detail).toContain(path)
      expect(health.metrics?.sessionsWithMode).toBeTypeOf('number')
      dispose()
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
      const handle = createKernel({ logger: capturingLogger() })
      const registration = createPrivacyRegistration()
      const dispose = mount(handle.kernel, registration, { failClosedMode: 'sealed', path })
      const health = await registration.manifest.health()
      expect(health.detail).toContain('历史受限记录 1 条（其中本进程活跃 0 条）')
      expect(health.metrics?.restrictedSessions).toBe(1)
      expect(health.metrics?.restrictedSessionsActive).toBe(0)
      dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('status 文本包含用法与状态文件位置', async () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const text = (await runCommand(booted.commands, 'status')).text
      expect(text).toContain('隐私模式（omb-privacy）')
      expect(text).toContain('/omb-privacy')
      expect(text).toContain('状态文件')
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})

/**
 * 不变量：**模型不能自己解除限制**。
 *
 * ## 这条测试原来是"模块不注册任何工具"
 *
 * 那个写法守着正确的**意图**（原注释：隐私模式是**用户**的决定，不该由模型自己改），
 * 但它守的是**手段**而不是**目的**——而那个手段建立在一个不成立的前提上：
 * **命令在 Web 界面里够不着**。
 *
 * 实测证据（2026-09-30，真实 GUI）：
 * 1. 在会话里发出 `/omb-privacy normal`；
 * 2. `omb_status` → `显式设置 0 个会话`、状态文件从未被创建 → **命令没被执行**；
 * 3. grep 整个 DSH Web 客户端 → **没有任何斜杠命令处理**。
 *
 * 于是"命令是唯一入口"等于这个功能对 Web 用户**不可用**。
 *
 * ## 所以测试改成守**目的**（更强，不是更弱）
 *
 * 不再断言"没有工具"（那是手段），而是断言**模型无法自己解除限制**这条不变量：
 * - 收紧：模型可直接做；
 * - 放宽：**没有 `allowLoosen` 就必须被拒**；
 * - `trust`（清 fail-closed 粘性）：根本不提供。
 *
 * 这样"隐私是用户的决定"在**行为层面**被钉住——比"没有工具"更难绕过：
 * 将来若有人加了一条能放宽的工具，这条测试会立刻红。
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
 * 这条不变量现在靠"**根本没有那条路**"成立，比"有路但拦住"更硬：
 * 将来若有人加回一条能改隐私的工具，下面的断言会立刻红。
 */
describe('不变量：模型不能自己解除限制', () => {
  it('模块不注册任何工具——隐私模式不由模型改', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const toolServices = booted.kernel.services().filter(name => name.startsWith('tools:'))
      expect(
        toolServices,
        '一旦出现 tools:omb-privacy，模型就多了一条改隐私的路——那是刻意不要的',
      ).toEqual([])
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})