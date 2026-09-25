/**
 * 模块装配的契约测试。
 *
 * 防的是**由本设计新引入的失败模式**：为了让插件能在宿主 Node 进程里加载，
 * 模块入口必须是静态导入（`import.meta.glob` 编译后不是合法 Node 代码，
 * 运行期扫目录又是异步的、违反 H-2）。代价是"新增模块要加一行"。
 *
 * 本测试把这个代价变成一条会失败的测试，而不是一个静默缺席的功能。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync, isModuleEntry, pickRegistrations, ambiguousIds } from '../../dsh/modules.js'
import { MODULE_IDS } from '../../kernel/abi/index.js'
import { COMPONENT_DISPLAY } from '../../kernel/display.js'

const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
const root = fileURLToPath(new URL('../../', import.meta.url))

/** 从 YAML 里取「行 id → 行 name」的配对。 */
function moduleRows(): readonly (readonly [string, string])[] {
  return [...yaml.matchAll(/- id:\s*(omb-[\w-]+)\s*\n\s*name:\s*'([^']+)'/g)].map(
    m => [m[1] as string, m[2] as string] as const,
  )
}

describe('模块入口清单与 YAML 一致', () => {
  it('YAML 的 name 不得带 ?v= 缓存尾缀（新宿主下会让行加载失败）', () => {
    // 由来：`?v=N` 是旧 v2 的开发习惯（Node ESM 按 URL 缓存）。
    // 在 DSH 0.1.7 里它**从原理上不可用**——实测装到 profile 后 8 行全部
    // "failed to import"，报错 URL 形如 `kernel.js%3Fv=1`：那个 `?v=1`
    // 被当成**文件名字面量**去找，文件当然不存在。
    // 换代目录（`lib-gen/g<N>`）已能做到同样的"绕过 ESM 缓存"且不破坏路径。
    const offenders = [...yaml.matchAll(/name:\s*'([^']*\?v=\d+[^']*)'/g)].map(m => m[1] as string)
    expect(offenders, `这些行带了 ?v= 尾缀，装到宿主后会加载失败：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每行的 name 都是相对路径（硬约束：宿主用 new URL(name, baseUrl) 解析它）', () => {
    // 实测：裸包名 + 子路径（`@omb/plugin/omb-kernel`）在这个宿主里**解析不了**
    // ——8 行全部 "failed to import"。宿主只认相对路径与顶层包名，
    // 所以这不是风格偏好：想换代码代次只能换产物目录名。
    const rows = moduleRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [id, name] of rows) {
      expect(name.startsWith('./'), `行 ${id} 的 name「${name}」不是相对路径`).toBe(true)
    }
  })

  it('每行指向的产物文件真实存在', () => {
    for (const [id, name] of moduleRows()) {
      const target = name.split('?')[0] as string
      expect(
        existsSync(`${root}${target.replace(/^\.\//, '')}`),
        `行 ${id} 的 ${name} 不存在（先跑 node scripts/build.mjs）`,
      ).toBe(true)
    }
  })

  it('没有两行指向同一个产物文件（否则同一模块被激活两次）', () => {
    // 实测过这个症状：状态面出现两条 `omb-context` 段落、计数器各自独立。
    const targets = moduleRows().map(([, name]) => name.split('?')[0] as string)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('每个 YAML 模块行的 id 都在 MODULE_IDS 里', () => {
    const rows = moduleRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [id] of rows) {
      expect(MODULE_IDS.includes(id as (typeof MODULE_IDS)[number]), `YAML 行 id ${id} 不在 MODULE_IDS`).toBe(true)
    }
  })

  it('每个组件都有中文显示名与说明（插件页那一列靠它）', () => {
    // 插件页显示的是行 id 与 name（路径）；中文名来自 DSH 的本地化元数据。
    // 缺了它用户看到的就是一串 file:/// 路径，不知道哪个开关对应哪个组件。
    for (const id of MODULE_IDS) {
      const entry = COMPONENT_DISPLAY.find(item => item.rowId === id)
      expect(entry, `组件 ${id} 缺显示元数据（kernel/display.ts）`).toBeDefined()
      expect((entry?.zh ?? '').length, `组件 ${id} 的中文名为空`).toBeGreaterThan(0)
      expect((entry?.zhDescription ?? '').length, `组件 ${id} 缺中文说明`).toBeGreaterThan(0)
    }
    // 显示表里不该有孤儿条目
    for (const entry of COMPONENT_DISPLAY) {
      expect(MODULE_IDS).toContain(entry.rowId)
    }
  })
})

describe('loadModulesSync', () => {
  it('从真实清单装配出与 MODULE_IDS 同规模的模块集合', () => {
    const result = loadModulesSync(MODULE_ENTRIES)
    const ids = result.modules.map(m => m.manifest.id).sort()
    // 每个模块入口恰好导出一个注册项
    expect(ids.length).toBe(MODULE_ENTRIES.size)
    expect(new Set(ids).size).toBe(ids.length) // 无重复
    // 除了微内核（不在模块目录里），其余 MODULE_IDS 都应被装配
    for (const id of MODULE_IDS) {
      if (id === 'omb-kernel') continue
      expect(ids, `模块 ${id} 未被装配`).toContain(id)
    }
  })

  it('输出顺序按 id 稳定（与文件系统枚举顺序无关）', () => {
    const a = loadModulesSync(MODULE_ENTRIES).modules.map(m => m.manifest.id)
    const b = loadModulesSync(MODULE_ENTRIES).modules.map(m => m.manifest.id)
    expect(a).toEqual(b)
    expect(a).toEqual([...a].sort())
  })

  it('入口判据是"模块目录下的直接文件"，不要求文件名叫 index/module', () => {
    expect(isModuleEntry('modules/memory/index')).toBe(true)
    expect(isModuleEntry('modules/memory/module')).toBe(true)
    // 这条曾经是 bug：vector.ts 是合法模块入口，却因文件名被静默跳过
    expect(isModuleEntry('modules/memory/vector')).toBe(true)
    expect(isModuleEntry('modules/memory/store')).toBe(true)
    expect(isModuleEntry('modules/memory/sub/thing')).toBe(false)
    expect(isModuleEntry('modules/memory')).toBe(false)
  })

  it('模块目录下的非模块文件被记为失败，而不是静默跳过', () => {
    const result = loadModulesSync(new Map([['modules/memory/store', { someExport: 1 }]]))
    expect(result.modules).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.path).toBe('modules/memory/store')
  })

  it('导出形状不对的入口记为失败而不是静默丢弃', () => {
    const result = loadModulesSync(new Map([['modules/x/index', { something: 1 }]]))
    expect(result.modules).toEqual([])
    expect(result.failures).toEqual([
      { path: 'modules/x/index', reason: '入口未导出 ModuleRegistration 形状的对象' },
    ])
  })

  it('模块 id 重复记为失败', () => {
    const profile = MODULE_ENTRIES.get('modules/profile/index')
    expect(loadModulesSync(new Map([['modules/a/index', profile]])).modules).toHaveLength(1)
    const result = loadModulesSync(
      new Map<string, unknown>([
        ['modules/a/index', profile],
        ['modules/b/index', profile],
      ]),
    )
    expect(result.modules).toHaveLength(1)
    expect(result.failures[0]?.reason).toContain('模块 id 重复')
  })
})

describe('pickRegistrations：按结构判定，不按导出名', () => {
  it('多种导出命名都能被发现', () => {
    const shape = { manifest: { id: 'x', configSchema: { parse: () => ({}) } }, apply: () => {} }
    expect(pickRegistrations({ artifactModule: shape })).toHaveLength(1)
    expect(pickRegistrations({ reasoningRegistration: shape })).toHaveLength(1)
  })

  it('同一 id 下"可运行的注册项"优先于"裸清单"', () => {
    // 真实情形：vector.ts 同时导出 vectorManifest 与 vectorModule。
    // 裸 manifest 也能通过形状判定，若被收下就会因 id 重复把真正可运行的注册项
    // 挤掉——实测导致模块被装配成没有 apply 的空壳，再被内核剔除。
    const bare = { manifest: { id: 'x', configSchema: { parse: () => ({}) } } }
    const runnable = { manifest: { id: 'x', configSchema: { parse: () => ({}) } }, apply: () => {} }
    const picked = pickRegistrations({ vectorManifest: bare, vectorModule: runnable })
    expect(picked).toHaveLength(1)
    expect(typeof picked[0]?.apply).toBe('function')
  })

  it('具名注册项优先于 default 宿主包装器（**不依赖命名空间键序**）', () => {
    // 这条防的是一个只在 Node 原生 ESM 下暴露、vitest 下**假绿**的 bug：
    // ESM 命名空间的键按**字典序**枚举，`default` 排在 `registration` 等之前；
    // 而 `default` 是 `toHostPlugin` 包装器（它**也有** manifest 与 apply）。
    // 挑中包装器后内核原生路径传进去的第一参是内核视图而非宿主 ctx → 静默失效。
    //
    // vitest 下 Vite 按**源码顺序**建键（`default` 在最后），所以只断言真实清单
    // 是抓不住它的——必须手工构造"default 在前"的命名空间。
    const real = { manifest: { id: 'x', configSchema: { parse: () => ({}) } }, apply: () => {} }
    const wrapper = { manifest: real.manifest, apply: () => {} }
    for (const ns of [
      { default: wrapper, registration: real }, // 字典序（Node ESM）
      { registration: real, default: wrapper }, // 源码序（Vite）
    ]) {
      const picked = pickRegistrations(ns)
      expect(picked, `键序 ${Object.keys(ns).join(',')} 下应挑中具名注册项`).toHaveLength(1)
      expect(picked[0]).toBe(real)
    }
  })

  it('"具名项 + default 包装器"是正常形态：归 warnings 而非 failures', () => {
    const real = { manifest: { id: 'x', configSchema: { parse: () => ({}) } }, apply: () => {} }
    const wrapper = { manifest: real.manifest, apply: () => {} }
    expect(ambiguousIds({ default: wrapper, registration: real })).toEqual(['x'])
    expect(ambiguousIds({ registration: real })).toEqual([])

    const result = loadModulesSync(new Map([['modules/x/index', { default: wrapper, registration: real }]]))
    expect(result.modules).toHaveLength(1)
    expect(result.modules[0]).toBe(real)
    expect(result.failures).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('已选具名项')
  })

  it('缺少 apply 或 configSchema.parse 的不算模块', () => {
    expect(pickRegistrations({ a: { manifest: { id: 'x', configSchema: { parse: () => ({}) } } } })).toHaveLength(0)
    expect(pickRegistrations({ a: { manifest: { id: 'x' }, apply: () => {} } })).toHaveLength(0)
  })
})
