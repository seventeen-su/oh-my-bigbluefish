/**
 * `omb_files` 的隐私闸门（Lead 裁决 (a)）：**sealed 下直接调 ArtifactService / ArtifactIndex
 * 也必须被拒**——不是只测工具层。
 *
 * 为什么制品索引也要过闸门：它就是一份**阅读痕迹**（本会话读过/写过哪些文件）。
 * 把它排除在隐私之外，会得到"记忆读不到、但文件足迹照样列得出来"的半个隐私。
 *
 * 出口逐个覆盖（Lead 明确要求"不要只堵一个"）：
 * ① `ArtifactService.topFor`（模型可见的主入口）
 * ② `ArtifactService.list`（全量快照，返回**路径清单**）
 * ③ `ArtifactService.record`（写：记录的是阅读痕迹）
 * ④ `ArtifactIndex.*` 本身（工具与服务的共同底座——判定在这一层，所以两条入口都逃不掉）
 * ⑤ `omb_files` 工具（把拒绝变成模型可读的 error 结果）
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ARTIFACT_SERVICE, createArtifactModule, type ArtifactService } from '../../../modules/artifact/module.js'
import { ArtifactIndex, ARTIFACT_UNATTRIBUTED_READ_DENIED } from '../../../modules/artifact/index.js'
import { createFilesTool, FILES_TOOL_NAME } from '../../../modules/artifact/tools.js'
import { PrivacyGate } from '../../../modules/memory/privacy/gate.js'
import { PrivacyState } from '../../../modules/memory/privacy/state.js'
import { MEMORY_CONFIG_DEFAULTS, createMemoryRegistration } from '../../../modules/memory/index.js'
import { SessionRuntimeTable, toolCallContext } from '../../../kernel/sessionRuntime.js'
import { createKernel } from '../../../kernel/index.js'
import type { ModuleRegistration } from '../../../kernel/abi/index.js'
import { toHostPlugin } from '../../../kernel/hostEntry.js'
import { capturingLogger, fixedClock, tempWorkspace, testPort } from '../memory/helpers.js'

/** `omb-memory` 依赖 `omb-kernel`：装配集合里必须有内核那一行（测试替身）。 */
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

interface Fixture {
  readonly index: ArtifactIndex
  readonly service: ArtifactService
  readonly state: PrivacyState
  readonly gate: PrivacyGate
}

function fixture(): Fixture {
  const clock = fixedClock()
  const sessions = new SessionRuntimeTable(clock)
  const state = new PrivacyState({
    sessions,
    clock,
    baseline: () => ({ mode: 'normal', origin: 'default', detail: '测试基线：未配置' }),
  })
  const gate = new PrivacyGate({
    state,
    baselineRestricted: () => false,
    isActive: sessionId => state.isActive(sessionId),
    hasRestrictedActiveSession: () => state.hasRestrictedActiveSession(),
  })
  const index = new ArtifactIndex({ logger: capturingLogger(), privacy: () => gate })
  return {
    index,
    state,
    gate,
    service: {
      // 与模块同构的最小服务（判定仍在 index 这一层，服务只做透传）
      record: (path, options, sessionId) =>
        index.record({ path, kind: options?.kind, contentHash: options?.contentHash, at: clock.now() }, sessionId),
      topFor: (query, limit, sessionId) => index.topFor(query, limit, sessionId),
      list: sessionId => index.list(sessionId),
      size: () => index.size(),
      clear: () => index.clear(),
      status: () => ({ available: true, detail: 'test' }),
    },
  }
}

function seed(f: Fixture): void {
  const { index } = f
  index.record({ path: 'src/secret-plan.md', kind: 'file', at: 1 })
  index.record({ path: 'src/other.ts', kind: 'file', at: 2 })
}

describe('sealed：所有出口都拒（直接调服务/索引，不经过工具）', () => {
  it('topFor / list / record 在 sealed 下全部被拒，且原因是可读的', () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('s1', 'sealed')

    expect(() => f.service.topFor('secret', 3, 's1')).toThrow(/sealed/)
    expect(() => f.service.topFor('secret', 3, 's1')).toThrow(/禁止读取记忆/)
    expect(() => f.service.list('s1')).toThrow(/sealed/)
    expect(() => f.service.record('src/new.md', undefined, 's1')).toThrow(/sealed/)
    // 索引这一层本身也拒（工具与服务都逃不掉）
    expect(() => f.index.topFor('secret', 3, 's1')).toThrow(/sealed/)
    expect(() => f.index.list('s1')).toThrow(/sealed/)
  })

  it('read-only：读放行、写被拒（记录阅读痕迹也算写）', () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('s1', 'read-only')
    expect(f.service.topFor('secret', 3, 's1').map(e => e.path)).toEqual(['src/secret-plan.md'])
    expect(f.service.list('s1').length).toBe(2)
    expect(() => f.service.record('src/new.md', undefined, 's1')).toThrow(/read-only/)
  })

  it('normal：读写都通', () => {
    const f = fixture()
    f.state.setOverride('s1', 'normal')
    expect(() => f.service.record('src/a.md', undefined, 's1')).not.toThrow()
    expect(f.service.topFor('a.md', 3, 's1')).toHaveLength(1)
  })
})

describe('归属未知：存在受限会话时禁读（scoped fail-closed）', () => {
  it('没有任何受限会话 → 归属未知也放行（否则是把功能做成故障）', () => {
    const f = fixture()
    f.state.setOverride('s1', 'normal')
    seed(f)
    expect(f.index.topFor(undefined, 3).length).toBe(2)
  })

  it('存在 sealed 会话 → 归属未知的读被拒，措辞说明"无法证明不属于受限会话"', () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('s1', 'sealed')
    // **活跃**的受限会话：判据是"本进程内真的活跃过"（`PrivacyState.isActive`），
    // 因此这里要先有一次观测——与生产一致（命令/`session/event` 都会走 `note()`）。
    f.state.noteLineage({ sessionId: 's1', source: 'session-event' })
    expect(() => f.index.topFor(undefined, 3)).toThrow(ARTIFACT_UNATTRIBUTED_READ_DENIED)
    expect(() => f.index.list()).toThrow(/阅读痕迹/)
  })

  it('只留在状态文件里的受限记录（本进程从未活跃）→ 归属未知的读不再被永久掐住', () => {
    const f = fixture()
    seed(f)
    // 重启后重放进来的形态：`setOverride` 建了条目，但没有任何观测
    f.state.setOverride('s1', 'sealed')
    expect(f.index.topFor(undefined, 3).length).toBe(2)
    expect(() => f.index.list()).not.toThrow()
    // 而该会话自己的判定不受影响：真的用它读，仍然是 sealed
    expect(() => f.index.topFor('secret', 3, 's1')).toThrow(/sealed/)
  })

  it('A 的 sealed 不掐 B 的读（范围按会话）', () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('A', 'sealed')
    expect(f.index.topFor('secret', 3, 'B')).toHaveLength(1)
  })
})

describe('子代理继承（制品索引同样按会话解析）', () => {
  it('子会话继承父会话的 sealed → 子会话读制品索引也被拒', () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('parent', 'sealed')
    f.state.noteLineage({ sessionId: 'child', parentSessionId: 'parent', source: 'session-event' })
    expect(() => f.index.topFor(undefined, 3, 'child')).toThrow(/继承自 parent/)
  })
})

describe('omb_files 工具：拒绝变成模型可读的 error 结果', () => {
  it('sealed 下工具返回 error 分支（不是空列表，也不是抛异常）', async () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('s1', 'sealed')
    const tool = createFilesTool({ index: f.index })
    expect(tool.name).toBe(FILES_TOOL_NAME)
    const outcome = await tool.execute({ query: 'secret' }, toolCallContext({ sessionId: 's1' }))
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.text).toContain('sealed')
      expect(outcome.text).not.toContain('src/secret-plan.md') // 泄露检查：错误里不能带路径
    }
  })

  it('read-only 下工具照常返回索引条目（只有写被禁）', async () => {
    const f = fixture()
    seed(f)
    f.state.setOverride('s1', 'read-only')
    const tool = createFilesTool({ index: f.index })
    const outcome = await tool.execute({ query: 'secret' }, toolCallContext({ sessionId: 's1' }))
    expect(outcome.kind).toBe('text')
    if (outcome.kind === 'text') expect(outcome.text).toContain('src/secret-plan.md')
  })
})

/**
 * **并入验收**（Lead 明确要求的反向断言）：
 *
 * `omb-privacy` 那一行删掉之后，制品写入**仍然受闸门约束**——
 * 闸门由记忆库提供（服务名 `SERVICES.privacy` 没变），档位由**真命令** `/omb-privacy` 改，
 * `forget` 这个逃生口也照旧。这条测的就是"并入没有把闸门弄丢"。
 */
describe('并入验收：删掉 omb-privacy 行之后，制品写入仍受闸门约束', () => {
  it('记忆库提供闸门 + 真 /omb-privacy 命令：sealed 后制品的写与读都被拒，forget 后恢复', async () => {
    const ws = tempWorkspace('omb-privacy-artifact-')
    const privacyPath = join(ws.dir, 'session-modes.json')
    try {
      const handle = createKernel({ logger: capturingLogger() })
      // 宿主 commands 服务（生产由宿主提供；这里只要能记录注册项并供测试调用）
      const definitions: {
        readonly name: string
        readonly input?: { readonly hint: string }
        readonly handler: (invocation: unknown) => { kind: string; text: string } | Promise<{ kind: string; text: string }>
      }[] = []
      handle.kernel.provide('commands', {
        register: (definition: unknown) => {
          definitions.push(definition as (typeof definitions)[number])
          return () => {}
        },
      })

      const memory = createMemoryRegistration({ storageHost: testPort(ws.dir) })
      const artifact = createArtifactModule()
      const blocked = handle.start(
        [kernelRow, memory, artifact as ModuleRegistration<unknown>],
        new Map([
          ['omb-memory', { ...MEMORY_CONFIG_DEFAULTS, privacy: { failClosedMode: 'sealed', path: privacyPath } }],
        ]),
      )
      expect(blocked, '装配被依赖规划阻断').toEqual([])

      // ① 闸门就位——由**记忆库**提供，不是测试手搭的
      expect(handle.kernel.service('privacy'), '记忆库没有提供 privacy 服务 → 制品没有闸门').toBeDefined()
      const service = handle.kernel.service<ArtifactService>(ARTIFACT_SERVICE)
      expect(service).toBeDefined()
      service?.record('src/plan.md', undefined, 's1')
      expect(service?.topFor('plan', 3, 's1')).toHaveLength(1)

      // ② 命令仍在（名字没变；注册从记忆库的 apply 走），forget / clear 也在 hint 里
      const command = definitions.find(item => item.name === 'omb-privacy')
      expect(command, '命令没注册——并入之后用户就没有改档位的入口了').toBeDefined()
      expect(command?.input?.hint).toContain('forget')
      expect(command?.input?.hint).toContain('clear')

      // ③ 真命令改档位 → 制品的写与读立刻被拒（闸门没丢）
      const sealed = await command?.handler({ rawInput: 'sealed', agent: { id: 's1' } })
      expect(sealed?.kind).toBe('success')
      expect(() => service?.record('src/new.md', undefined, 's1')).toThrow(/sealed/)
      expect(() => service?.topFor('plan', 3, 's1')).toThrow(/sealed/)
      expect(() => service?.list('s1')).toThrow(/sealed/)

      // ④ 逃生口仍在：forget 之后该会话回到基线，写入恢复
      const forgotten = await command?.handler({ rawInput: 'forget s1', agent: { id: 's1' } })
      expect(forgotten?.kind).toBe('success')
      expect(service?.record('src/new.md', undefined, 's1')).toBeDefined()

      // 卸载后不留服务（H-1）
      expect(() => handle.dispose()).not.toThrow()
      expect(handle.kernel.service(ARTIFACT_SERVICE)).toBeUndefined()
      expect(handle.kernel.service('privacy')).toBeUndefined()
      expect(toHostPlugin(artifact as ModuleRegistration<unknown>).manifest.id).toBe('omb-artifact')
    } finally {
      ws.cleanup()
    }
  })
})
