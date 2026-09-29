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
import type { PrivacyGatePort } from '../../../modules/privacy/gate.js'
import type { CommandResultLike } from '../../../modules/privacy/command.js'
import { capturingLogger, tempWorkspace } from '../memory/helpers.js'

interface FakeCommands {
  readonly definitions: {
    readonly name: string
    readonly definitionId: string
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

describe('不注册任何工具（模型不能自己解除限制）', () => {
  it('模块不声明 tools:<id> 服务', () => {
    const ws = tempWorkspace('omb-privacy-mod-')
    try {
      const booted = boot({ path: join(ws.dir, 'm.json') })
      const toolServices = booted.kernel.services().filter(name => name.startsWith('tools:'))
      expect(toolServices).toEqual([])
      booted.dispose()
    } finally {
      ws.cleanup()
    }
  })
})
