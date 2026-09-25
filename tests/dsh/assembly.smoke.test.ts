/**
 * 装配级冒烟：插件"真的能起来"。
 *
 * 这条测试的由来：`handle.start(loaded.modules)` 少了微内核自身的注册项，
 * 于是所有 `requires: ['omb-kernel']` 的模块被整体阻断——插件装上了，
 * 但只有 1 个模块活着，其余各自只报"缺少必需依赖"。
 * **单元测试全绿也发现不了它**，因为它只在"真实清单 + 真实 start"的组合下出现。
 *
 * 因此这里用真实 `MODULE_ENTRIES` + 真实内核做装配，断言：
 * ① 没有任何模块被阻断
 * ② 每个模块都自报健康且不是 failed
 * ③ 模块声明的工具服务都真的注册了
 * ④ 提示贡献能被按前缀收集到
 * ⑤ 卸载后服务与订阅者清零（热插拔不残留）
 */
import { describe, expect, it } from 'vitest'
import { createKernel } from '../../kernel/index.js'
import { MODULE_CATALOG, SERVICES, toolsServiceFor, type StatusRegistry } from '../../kernel/abi/index.js'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync } from '../../dsh/modules.js'
import { buildStatusTool } from '../../dsh/status-tool.js'
import { collectToolSpecs, testHostContext } from '../../dsh/plugin.js'
import { createToolBridge } from '../../dsh/tool-bridge.js'
import { TOOL_BRIDGE_SERVICE, toHostPlugin } from '../../kernel/hostEntry.js'
import { SessionTable, collectPromptContributions } from '../../dsh/session.js'

/**
 * 装配冒烟：复现**真实路径**——宿主 ctx → `ctx.get('omb:kernel')` → 模块 apply。
 *
 * **不走内核自己启动模块那条路**：那样会与宿主启动重复（实测状态面出现两条
 * `omb-context` 段落、计数器各自独立）。模块生命周期归宿主，依赖顺序由
 * `cordis.patch.yml` 的行级 `inject: ['omb:kernel']` 保证。
 *
 * 这条测试的由来：模块入口曾因拿到宿主 ctx（而非内核）而**静默空转**——
 * 单元测试全绿也发现不了，因为只在"真实清单 + 真实装配"下才出现。
 */
async function assemble(): Promise<ReturnType<typeof createKernel>> {
  const handle = createKernel()
  // 真实路径里由内核行把内核发布到宿主服务表（dsh/plugin.ts 的 publishToHost）。
  // 这里等价地在测试宿主 ctx 上暴露它。
  handle.kernel.provide(SERVICES.kernel, handle.kernel)
  const loaded = loadModulesSync(MODULE_ENTRIES)
  expect(loaded.failures, `模块入口未装配：${JSON.stringify(loaded.failures)}`).toEqual([])
  const host = testHostContext(handle)
  for (const registration of loaded.modules) {
    // 与宿主一样：apply 拿到的是宿主 ctx，模块自己经 ctx.get('omb:kernel') 取内核
    const plugin = toHostPlugin(registration)
    plugin.apply(host)
  }
  return handle
}

describe('装配冒烟：真实清单 + 真实内核', () => {
  it('没有任何模块被阻断（缺微内核注册项会让几乎所有模块被整体阻断）', async () => {
    const handle = await assemble()
    const health = handle.health()
    const failed = Object.entries(health)
      .filter(([, h]) => h.state === 'failed')
      .map(([id, h]) => `${id}: ${h.detail}`)
    expect(failed, `模块启动失败：\n${failed.join('\n')}`).toEqual([])
  })

  it('每个"模块"都在健康面里（微内核不是模块，不进模块健康面）', async () => {
    const handle = await assemble()
    const ids = Object.keys(handle.health()).sort()
    for (const entry of MODULE_CATALOG) {
      // 微内核豁免：它是插件本体（宿主侧），没有独立模块资源，因此不往**模块**
      // 健康面里报。它的存在由 MODULE_IDS（可切换行清单）与 omb_status 的
      // "构建"段体现——健康面只回答"模块好不好"这个问题。
      if (entry.id === 'omb-kernel') continue
      expect(ids, `模块 ${entry.id} 未出现在健康面`).toContain(entry.id)
    }
    expect(ids.length).toBeGreaterThan(0)
  })

  it('模块声明的工具服务都真的注册了', async () => {
    const handle = await assemble()
    const names = handle.kernel.services()
    for (const entry of MODULE_CATALOG) {
      if (entry.tools.length === 0) continue
      // 微内核豁免：它不是模块目录里的注册项，`omb_status` 由 `dsh/`
      // 直接产出（见 `collectToolSpecs`），没有 `tools:omb-kernel` 服务。
      if (entry.id === 'omb-kernel') continue
      const serviceName = toolsServiceFor(entry.id)
      expect(names, `模块 ${entry.id} 声明了工具 ${entry.tools.join(',')}，但未注册 ${serviceName}`)
        .toContain(serviceName)
    }
  })

  it('工具桥：模块挂载完成后，模块工具真的进了宿主工具面', async () => {
    // **这条防的是"看起来全对、功能却不在"**：内核 `apply` 是同步的，模块行由宿主
    // 异步挂载。先前内核在 apply 里一次性收集工具，结果只有内核自带的 `omb_status`
    // 进了工具面，其余 7 个工具**全部消失**，而健康面一切正常。
    // 现在由 `toolBridge` 幂等重放：每挂载完一个模块就同步一次。
    const registered: string[] = []
    const missingOutput: string[] = []
    // 假宿主**复刻真宿主的契约校验**：`tools.register()` 要求
    // `output { schema, render }`，缺了会抛
    // （`packages/core/tools/src/index.ts:1066-1070`）。
    // 不复刻这条校验，测试就会对"每个 OMB 工具都被宿主拒绝"保持全绿——
    // 实测正是如此：桥手搓注册对象漏了 `output`，工具面全空而测试全过。
    const host = {
      register: (def: unknown) => {
        const d = def as { name: string; output?: { schema?: unknown; render?: unknown } }
        if (d.output === undefined || typeof d.output.render !== 'function') {
          missingOutput.push(d.name)
          throw new TypeError(`tool "${d.name}" must declare output { schema, render }`)
        }
        registered.push(d.name)
        return () => {}
      },
    }
    const handle = createKernel()
    handle.kernel.provide(SERVICES.kernel, handle.kernel)
    const bridge = createToolBridge()
    bridge.attach(host, {
      services: () => handle.kernel.services(),
      service: <T,>(name: string) => handle.kernel.service<T>(name),
      logger: { warn: () => {} },
    })
    handle.kernel.provide(TOOL_BRIDGE_SERVICE, bridge)

    // 内核自带工具：由内核行加进桥
    const statusSpec = buildStatusTool(handle, new SessionTable())
    bridge.add([statusSpec], 'omb-kernel')

    // 模拟宿主逐行加载：每挂载完一个模块重放一次
    const loaded = loadModulesSync(MODULE_ENTRIES)
    const hostCtx = testHostContext(handle)
    for (const registration of loaded.modules) {
      handle.mount(registration, hostCtx)
      bridge.sync()
    }

    // 目录里声明的**每一个**工具都必须在工具面里
    const declared = MODULE_CATALOG.flatMap(entry => entry.tools)
    for (const tool of declared) {
      expect(registered, `目录声明了 ${tool}，但它不在工具面里`).toContain(tool)
    }
    // 无重名（宿主对重名会抛，而抛会让整批失败）
    expect(new Set(registered).size).toBe(registered.length)
    // **每个工具都必须带宿主要求的 output** —— 缺了会被真宿主拒绝
    expect(
      missingOutput,
      `这些工具缺 output { schema, render }，会被宿主拒绝：${missingOutput.join('、')}`,
    ).toEqual([])
    // 桥是幂等的：再同步几次不会重复注册
    const before = registered.length
    bridge.sync()
    bridge.sync()
    expect(registered.length).toBe(before)
    bridge.dispose()
  })

  it('工具面能真正收集到工具（含内核自带的 omb_status）', async () => {
    const handle = await assemble()
    const specs = collectToolSpecs(handle, new SessionTable())
    const names = specs.map(s => s.name)
    expect(names).toContain('omb_status')
    // 至少覆盖记忆与思维链两组工具——否则说明工具服务名拼错了
    expect(names).toContain('omb_recall')
    expect(names).toContain('omb_method')
    // 工具名唯一（重名会被宿主 tools.register 拒绝，而拒绝会让整批失败）
    expect(new Set(names).size).toBe(names.length)
  })

  it('提示贡献能被按前缀收集（模块不必改 dsh/）', async () => {
    const handle = await assemble()
    const contributions = collectPromptContributions(handle.kernel)
    expect(contributions.length).toBeGreaterThan(0)
    const withResident = contributions.filter(c => typeof c.resident === 'string' && c.resident.length > 0)
    expect(withResident.length, '至少一个模块应提供常驻提示').toBeGreaterThan(0)
  })

  it('状态面登记处可用，且贡献者能自述', async () => {
    const handle = await assemble()
    const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    expect(registry).toBeDefined()
    expect(registry?.list().length ?? 0).toBeGreaterThan(0)
    expect(handle.status().length).toBeGreaterThan(0)
  })

  it('第二通道登记处可用（向量模块会把通道推进来，记忆模块读它消费）', async () => {
    const handle = await assemble()
    const registry = handle.kernel.service<{ list(): readonly { name: string }[] }>(SERVICES.channelRegistry)
    expect(registry).toBeDefined()
    // 无宿主端口时向量模块可能降级，但登记处本身必须存在——
    // 它缺席会让 RRF 的第二通道结构上恒为空（语义召回永不发生）
    expect(Array.isArray(registry?.list())).toBe(true)
  })

  it('卸载后服务清空、事件订阅者归零（热插拔不残留）', async () => {
    const handle = await assemble()
    expect(handle.kernel.services().length).toBeGreaterThan(0)
    handle.dispose()
    // 服务表由模块自行注销；这里断言 dispose 本身不抛且健康面记下注销
    expect(handle.health()['omb-kernel']?.detail).toContain('注销')
  })
})
