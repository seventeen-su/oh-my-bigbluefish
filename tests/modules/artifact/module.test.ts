/**
 * `omb-artifact` 模块级集成测试（真内核，零宿主 mock）。
 *
 * 覆盖：
 * ① 声明服务与工具（`artifact` / `tools:omb-artifact`）
 * ② 路径只经 `record(path)` 进来——事件不产生条目（单一入口）
 * ③ **不注入清单**：模块没有提示段贡献，查询上限 3
 * ④ dispose 干净（服务与工具声明都回收）且绝不抛
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../../kernel/index.js'
import { MODULE_CATALOG } from '../../../kernel/abi/index.js'
import type { Kernel, ModuleRegistration, ToolDefinition } from '../../../kernel/abi/index.js'
import {
  ARTIFACT_SERVICE,
  ARTIFACT_TOOLS_SERVICE,
  artifactConfigSchema,
  createArtifactModule,
  type ArtifactService,
} from '../../../modules/artifact/module.js'
import { FILES_TOOL_NAME } from '../../../modules/artifact/tools.js'

/** `omb-kernel` 占位注册：本测试只验证制品模块，不重复测内核。 */
const KERNEL_STUB: ModuleRegistration<unknown> = {
  manifest: {
    id: 'omb-kernel',
    version: '3.0.0',
    requires: [],
    capabilities: ['kernel.services'],
    configSchema: { parse: () => ({}) },
    health: () => ({ state: 'ok', detail: '测试用内核占位' }),
  },
  apply: () => {},
}

const catalogEntry = MODULE_CATALOG.find(candidate => candidate.id === 'omb-artifact')

function fakeClock(start = 5_000): { now(): number } {
  return { now: () => start }
}

function start(config?: unknown): { kernel: Kernel; handle: ReturnType<typeof createKernel>; service: ArtifactService } {
  const handle = createKernel({ clock: fakeClock() })
  const module = createArtifactModule()
  handle.start(
    [KERNEL_STUB, module as ModuleRegistration<unknown>],
    config === undefined ? undefined : new Map([['omb-artifact', config]]),
  )
  const service = handle.kernel.service<ArtifactService>(ARTIFACT_SERVICE)
  if (service === undefined) throw new Error('制品服务未注册（测试装配有误）')
  return { kernel: handle.kernel, handle, service }
}

describe('注册面', () => {
  it('模块 id / 依赖 / 能力名与目录契约一致', () => {
    const module = createArtifactModule()
    expect(module.manifest.id).toBe('omb-artifact')
    expect(module.manifest.requires).toEqual(catalogEntry?.requires)
    expect(module.manifest.capabilities).toEqual(catalogEntry?.capabilities)
  })

  it('配置缺省值完整', () => {
    expect(artifactConfigSchema.parse(undefined)).toEqual({ maxEntries: 500 })
  })

  it('声明 omb_files 工具，模块自己不注册工具（由 dsh 侧取用）', () => {
    const { kernel } = start()
    const tools = kernel.service<readonly ToolDefinition[]>(ARTIFACT_TOOLS_SERVICE)
    expect(tools).toHaveLength(1)
    expect(tools?.[0]?.name).toBe(FILES_TOOL_NAME)
    // 工具名必须与目录契约一致（关闭模块 → 工具消失，名字不能漂）
    expect(catalogEntry?.tools).toEqual([FILES_TOOL_NAME])
  })

  it('**不注入清单**：模块不提供任何提示段贡献', () => {
    const module = createArtifactModule()
    // 提示段只能经 PromptContribution 形状暴露；这里在清单与服务面上都不存在
    expect(Object.keys(module)).toEqual(['manifest', 'apply'])
    const { kernel } = start()
    expect(kernel.service('prompt:artifact')).toBeUndefined()
    expect(kernel.service('prompt:omb-artifact')).toBeUndefined()
  })
})

describe('record：单一入口', () => {
  it('dsh 侧喂路径 → 索引可查，时间用内核时钟', () => {
    const { service } = start()
    const entry = service.record('src/parser.ts', { kind: 'file', contentHash: 'h1' })
    expect(entry).toMatchObject({ path: 'src/parser.ts', kind: 'file', contentHash: 'h1', at: 5_000 })
    expect(service.size()).toBe(1)
    expect(service.topFor('parser').map(e => e.path)).toEqual(['src/parser.ts'])
  })

  it('空路径不产生条目（不抛）', () => {
    const { service } = start()
    expect(service.record('  ')).toBeUndefined()
    expect(service.size()).toBe(0)
  })

  it('emit evidence/observed 不产生任何条目（事件载荷没有路径，不猜）', () => {
    const { kernel, service } = start()
    kernel.emit('evidence/observed', { sessionId: 's1', actionHash: 'a', evidenceHash: 'e', at: 1 })
    kernel.emit('evidence/observed', { sessionId: 's1', actionHash: 'b', evidenceHash: 'f', at: 2 })
    expect(service.size()).toBe(0)
    expect(service.topFor()).toEqual([])
  })

  it('查询上限为 3（索引不是清单）', () => {
    const { service } = start()
    for (let i = 0; i < 8; i += 1) service.record(`src/f${i}.ts`)
    expect(service.topFor('src', 99).length).toBe(3)
    expect(service.topFor('src').length).toBe(3)
  })

  it('maxEntries 配置生效', () => {
    const { service } = start({ maxEntries: 2, })
    service.record('a')
    service.record('b')
    service.record('c')
    expect(service.size()).toBe(2)
  })
})

describe('健康面与热插拔', () => {
  it('健康面写明条数与"不注入上下文"', async () => {
    const handle = createKernel()
    const module = createArtifactModule()
    handle.start([KERNEL_STUB, module as ModuleRegistration<unknown>])
    const service = handle.kernel.service<ArtifactService>(ARTIFACT_SERVICE)
    service?.record('src/a.ts')

    const health = await module.manifest.health()
    expect(health.state).toBe('ok')
    expect(health.detail).toContain('1/500')
    expect(health.detail).toContain('不注入上下文')
    expect(health.metrics?.topLimit).toBe(3)
  })

  it('dispose 回收服务与工具声明、清索引，且绝不抛', () => {
    const { handle, kernel, service } = start()
    service.record('src/a.ts')
    expect(() => handle.dispose()).not.toThrow()
    expect(kernel.service(ARTIFACT_SERVICE)).toBeUndefined()
    expect(kernel.service(ARTIFACT_TOOLS_SERVICE)).toBeUndefined()
    expect(handle.listenerCount()).toBe(0)
  })

  it('卸载后旧服务引用仍可调用（返回空而不是抛）', () => {
    const { handle, service } = start()
    service.record('src/a.ts')
    handle.dispose()
    expect(() => service.topFor('a')).not.toThrow()
    expect(service.size()).toBe(0)
  })

  it('配置非法 → 模块 failed 且原因可读', () => {
    const handle = createKernel()
    handle.start(
      [KERNEL_STUB, createArtifactModule() as ModuleRegistration<unknown>],
      new Map([['omb-artifact', { maxEntries: -1 }]]),
    )
    expect(handle.health()['omb-artifact']?.state).toBe('failed')
  })
})
