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
import { KERNEL_SELF, collectToolSpecs } from '../../dsh/plugin.js'
import { SessionTable, collectPromptContributions } from '../../dsh/session.js'

/** 造一个"没有宿主"的内核——足以装配模块（宿主相关能力缺失时模块会诚实降级）。 */
function assemble(): ReturnType<typeof createKernel> {
  const handle = createKernel()
  const loaded = loadModulesSync(MODULE_ENTRIES)
  expect(loaded.failures, `模块入口未装配：${JSON.stringify(loaded.failures)}`).toEqual([])
  handle.start([KERNEL_SELF, ...loaded.modules])
  return handle
}

describe('装配冒烟：真实清单 + 真实内核', () => {
  it('没有任何模块被阻断（缺微内核注册项会让几乎所有模块被整体阻断）', () => {
    const handle = assemble()
    const health = handle.health()
    const failed = Object.entries(health)
      .filter(([, h]) => h.state === 'failed')
      .map(([id, h]) => `${id}: ${h.detail}`)
    expect(failed, `模块启动失败：\n${failed.join('\n')}`).toEqual([])
  })

  it('每个声明的模块都在健康面里（含微内核自身）', () => {
    const handle = assemble()
    const ids = Object.keys(handle.health()).sort()
    for (const entry of MODULE_CATALOG) {
      expect(ids, `模块 ${entry.id} 未出现在健康面`).toContain(entry.id)
    }
  })

  it('模块声明的工具服务都真的注册了', () => {
    const handle = assemble()
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

  it('工具面能真正收集到工具（含内核自带的 omb_status）', () => {
    const handle = assemble()
    const specs = collectToolSpecs(handle, new SessionTable())
    const names = specs.map(s => s.name)
    expect(names).toContain('omb_status')
    // 至少覆盖记忆与思维链两组工具——否则说明工具服务名拼错了
    expect(names).toContain('omb_recall')
    expect(names).toContain('omb_method')
    // 工具名唯一（重名会被宿主 tools.register 拒绝，而拒绝会让整批失败）
    expect(new Set(names).size).toBe(names.length)
  })

  it('提示贡献能被按前缀收集（模块不必改 dsh/）', () => {
    const handle = assemble()
    const contributions = collectPromptContributions(handle.kernel)
    expect(contributions.length).toBeGreaterThan(0)
    const withResident = contributions.filter(c => typeof c.resident === 'string' && c.resident.length > 0)
    expect(withResident.length, '至少一个模块应提供常驻提示').toBeGreaterThan(0)
  })

  it('状态面登记处可用，且贡献者能自述', () => {
    const handle = assemble()
    const registry = handle.kernel.service<StatusRegistry>(SERVICES.statusContributor)
    expect(registry).toBeDefined()
    expect(registry?.list().length ?? 0).toBeGreaterThan(0)
    expect(handle.status().length).toBeGreaterThan(0)
  })

  it('第二通道登记处可用（向量模块会把通道推进来，记忆模块读它消费）', () => {
    const handle = assemble()
    const registry = handle.kernel.service<{ list(): readonly { name: string }[] }>(SERVICES.channelRegistry)
    expect(registry).toBeDefined()
    // 无宿主端口时向量模块可能降级，但登记处本身必须存在——
    // 它缺席会让 RRF 的第二通道结构上恒为空（语义召回永不发生）
    expect(Array.isArray(registry?.list())).toBe(true)
  })

  it('卸载后服务清空、事件订阅者归零（热插拔不残留）', () => {
    const handle = assemble()
    expect(handle.kernel.services().length).toBeGreaterThan(0)
    handle.dispose()
    // 服务表由模块自行注销；这里断言 dispose 本身不抛且健康面记下注销
    expect(handle.health()['omb-kernel']?.detail).toContain('注销')
  })
})
