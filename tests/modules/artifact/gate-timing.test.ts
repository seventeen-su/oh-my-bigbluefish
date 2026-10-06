/**
 * **时序**：`SERVICES.privacy` 还没就绪时，制品的写入不得**静默**放行。
 *
 * ## 背景（并入之后的时序变化）
 *
 * 3.6 起隐私闸门由 `omb-memory` 提供（原先是独立一行、排在记忆库之前）。
 * 生产行序上 memory 在 artifact 之前，所以正常路径没有窗口；但有两种真实情形
 * 会让制品面对一个"没有闸门"的服务表：
 * ① `omb-memory` 那一行没装上 / 被用户关掉；
 * ② 装配顺序异常（制品先挂）或热重载中间态。
 *
 * ## 契约选择：**如实降级**，不是拒绝
 *
 * `SERVICES.privacy` 取不到 == 进程里**根本没有任何隐私档位**（状态文件都没人读）。
 * 此时拒绝写入只是把一个正常功能变成永久故障，所以判据保持既有契约
 * "取不到 = 不受限"（与 `modules/memory/store.ts` 同口径）。
 * 但"不受限"**不等于"没人知道"**：每一次这样的写入都被计数、留最近时间，
 * 并由健康面、组件自述段与日志三处说出可读原因——**静默放行才是缺陷**。
 *
 * 这条测试就是这个判据：把 `modules/artifact/module.ts` 里那段留声删掉（恢复旧形态），
 * 下面三条会立刻红。
 */
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_SERVICE,
  artifactConfigSchema,
  createArtifactModule,
  type ArtifactService,
} from '../../../modules/artifact/module.js'
import { createMemoryRegistration } from '../../../modules/memory/index.js'
import { createKernel } from '../../../kernel/index.js'
import type { Kernel, ModuleRegistration, StatusRegistry } from '../../../kernel/abi/index.js'
import { SERVICES } from '../../../kernel/abi/index.js'
import { capturingLogger, tempWorkspace, testPort } from '../memory/helpers.js'

/** `omb-artifact` 现在显式依赖 `omb-memory`；这个替身让"只有制品"这种装配可复现。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.6.0',
    requires: [],
    capabilities: ['kernel.services'],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用内核占位' }),
  },
  apply: () => {},
}

/**
 * `omb-memory` 的替身：**只满足依赖、不提供 privacy 端口**。
 *
 * 用它装配出一套"依赖齐备但闸门缺席"的形态——`start()` 会按依赖规划阻断依赖缺席的模块，
 * 而这条判据要的正是"制品在跑、闸门不在"。
 */
const MEMORY_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-memory',
    version: '3.6.0',
    requires: ['omb-kernel'],
    capabilities: [],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用记忆库占位（不提供 privacy）' }),
  },
  apply: () => {},
}

interface CommandsStub {
  readonly definitions: { readonly name: string; readonly handler: (invocation: unknown) => unknown }[]
  readonly service: { register(definition: unknown): () => void }
}

function commandsStub(): CommandsStub {
  const definitions: CommandsStub['definitions'] = []
  return {
    definitions,
    service: {
      register(definition: unknown): () => void {
        definitions.push(definition as CommandsStub['definitions'][number])
        return () => {}
      },
    },
  }
}

/** 挂一个只有制品的装配（没有 memory ⇒ 没有 `SERVICES.privacy`）。 */
function artifactOnly(): {
  handle: ReturnType<typeof createKernel>
  module: ReturnType<typeof createArtifactModule>
  service: ArtifactService
  commands: CommandsStub
} {
  const handle = createKernel({ logger: capturingLogger() })
  const commands = commandsStub()
  handle.kernel.provide('commands', commands.service)
  const module = createArtifactModule()
  /**
   * 用 `mount()` 而不是 `start()`：**这是生产路径**。
   *
   * `start()` 会按依赖规划**阻断**依赖缺席的模块（制品现在依赖 `omb-memory`），
   * 于是"制品在、记忆库不在"这种状态根本造不出来；而真实宿主是按行独立挂载的
   * （`cordis.patch.yml` 每行一个插件，`mount()` 不查依赖），所以那种状态**确实可达**——
   * 正是它让"闸门缺位时不得静默"这条判据有必要。
   */
  handle.mount(module as ModuleRegistration<unknown>)
  const service = handle.kernel.service<ArtifactService>(ARTIFACT_SERVICE)
  if (service === undefined) throw new Error('制品服务未注册（测试装配有误）')
  return { handle, module, service, commands }
}

/** 从组件自述段读那一段（它会先自报一次健康，快照因此是新鲜的）。 */
function artifactSection(kernel: Kernel): string {
  const registry = kernel.service<StatusRegistry>(SERVICES.statusContributor)
  const section = registry?.list().find(item => item.name.includes('制品索引'))
  return section?.render() ?? ''
}

describe('时序：闸门未就绪期间的写入必须留声', () => {
  it('端口缺席：写入按契约放行，但**被计数**并写进健康面与组件自述段', async () => {
    const { handle, module, service } = artifactOnly()
    expect(handle.kernel.service(SERVICES.privacy), '这个装配里不该有 privacy 服务').toBeUndefined()

    // 契约：取不到 = 不受限（不是"被拒"）
    const entry = service.record('src/a.ts', { kind: 'file' }, 's1')
    expect(entry?.path).toBe('src/a.ts')
    expect(service.status().rejectedWrites).toBe(0)

    // 但"放行"必须可读：健康面给出次数与原因
    const health = await module.manifest.health()
    expect(health.metrics?.ungatedWrites, '缺闸门的写入次数没被数——这就是静默放行').toBe(1)
    expect(health.detail).toContain('隐私闸门未就绪期间写入 1 次')
    expect(health.detail).toContain('未经闸门约束')
    expect(health.detail).toContain('omb-memory')

    // 组件自述段（`omb_status` 里模型唯一能读到的那一段）同样要有
    const rendered = artifactSection(handle.kernel)
    expect(rendered).toContain('隐私闸门未就绪期间写入 1 次')

    // 第二次写入：计数继续涨（每一次都留痕，不是只报第一次）
    service.record('src/b.ts', { kind: 'file' }, 's1')
    const after = await module.manifest.health()
    expect(after.metrics?.ungatedWrites).toBe(2)
    expect(after.detail).toContain('写入 2 次')
    handle.dispose()
  })

  it('反向断言：闸门到位后计数**冻结**，且写入真的被拒（不是"放行+计数"）', async () => {
    const { handle, module, service } = artifactOnly()
    service.record('src/a.ts', { kind: 'file' }, 's1')
    expect((await module.manifest.health()).metrics?.ungatedWrites).toBe(1)

    // "闸门到位"：按会话拒绝一切写入的判定端口（与记忆库装出来的那一份同形状）
    const decision = { allowRead: true, allowWrite: false, readReason: '', writeReason: '会话已被设为 sealed（测试）' }
    handle.kernel.provide(SERVICES.privacy, {
      decide: () => decision,
      decideUnattributed: () => decision,
      restricted: () => true,
    })

    expect(() => service.record('src/b.ts', { kind: 'file' }, 's1')).toThrow(/sealed/)
    const health = await module.manifest.health()
    // 冻结：上次那 1 次是"闸门缺位"的历史事实，不该被后来的拒绝改写，也不该再涨
    expect(health.metrics?.ungatedWrites).toBe(1)
    expect(health.detail).toContain('写入 1 次')
    expect(health.metrics?.rejectedWrites).toBe(1)
    handle.dispose()
  })

  it('memory 后到（真实提供者）：先放行并计数，装上后同一实例立刻受约束、计数不再涨', async () => {
    const ws = tempWorkspace('omb-gate-timing-')
    try {
      const { handle, module, service, commands } = artifactOnly()
      service.record('src/early.ts', { kind: 'file' }, 's1')
      expect((await module.manifest.health()).metrics?.ungatedWrites).toBe(1)

      // 记忆库**后到**：它 apply 时把 `SERVICES.privacy` 同步装上（真实提供者，不是替身）
      const memory = createMemoryRegistration({ storageHost: testPort(ws.dir) })
      // 依赖图自检在装上之前要**点名**这条缺席（item 4 的判据：缺服务不能只靠运行时发现）
      expect(
        handle.moduleGraph().missingDependencies,
        '制品依赖 omb-memory（闸门由它提供），缺席必须被依赖图点名',
      ).toContain('omb-artifact ← omb-memory')
      handle.mount(memory as ModuleRegistration<unknown>)
      expect(handle.kernel.service(SERVICES.privacy)).toBeDefined()
      expect(handle.moduleGraph().missingDependencies).not.toContain('omb-artifact ← omb-memory')

      // 用真命令把本会话设为 sealed（命令面也随记忆库一起到位）
      const command = commands.definitions.find(item => item.name === 'omb-privacy')
      expect(command, '命令没注册：并入之后用户改不了档位').toBeDefined()
      await command?.handler({ rawInput: 'sealed', agent: { id: 's1' } })

      expect(() => service.record('src/late.ts', { kind: 'file' }, 's1')).toThrow(/sealed/)
      const health = await module.manifest.health()
      expect(health.metrics?.ungatedWrites, '闸门到位后不该再有未约束的写入').toBe(1)
      expect(health.detail).toContain('写入 1 次')
      handle.dispose()
    } finally {
      ws.cleanup()
    }
  })

  it('配置里的 maxEntries 不影响留声（两条读数各归各的）', async () => {
    const handle = createKernel({ logger: capturingLogger() })
    const module = createArtifactModule()
    handle.start(
      [KERNEL_STUB, MEMORY_STUB, module as ModuleRegistration<unknown>],
      new Map([['omb-artifact', artifactConfigSchema.parse({ maxEntries: 2 })]]),
    )
    const service = handle.kernel.service<ArtifactService>(ARTIFACT_SERVICE)
    for (const name of ['a', 'b', 'c']) service?.record(`src/${name}.ts`, { kind: 'file' }, 's1')
    const health = await module.manifest.health()
    expect(health.metrics?.indexed).toBe(2) // 上限生效
    expect(health.metrics?.ungatedWrites).toBe(3) // 留声不受淘汰影响：写入发生过就是发生过
    handle.dispose()
  })

  it('空路径不算"放行"：没有落进索引的写入不进未约束计数', async () => {
    const { handle, module, service } = artifactOnly()
    expect(service.record('   ', { kind: 'file' }, 's1')).toBeUndefined()
    const health = await module.manifest.health()
    expect(health.metrics?.ungatedWrites).toBe(0)
    expect(health.detail).not.toContain('隐私闸门未就绪')
    handle.dispose()
  })
})
