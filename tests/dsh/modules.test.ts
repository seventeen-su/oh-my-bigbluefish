/**
 * 模块装配的契约测试。
 *
 * 防的是一条**由本设计新引入的失败模式**：为了让插件能在宿主 Node 进程里加载，
 * 模块入口必须是静态导入（`import.meta.glob` 编译后不是合法 Node 代码，
 * 运行期扫目录又是异步的、违反 H-2）。代价是"新增模块要加一行"。
 *
 * 本测试把这个代价变成一条会失败的测试，而不是一个静默缺席的功能。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync, isModuleEntry, pickRegistrations } from '../../dsh/modules.js'
import { MODULE_IDS } from '../../kernel/abi/index.js'

const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * 产物目录的路径片段。产物目录带**代数后缀**（`lib-gen/g1`）——代数变 = URL 变 =
 * 宿主必然加载新模块，而不是命中 ESM 缓存里的旧实例。
 *
 * 用字符串构造正则（而不是正则字面量）：路径里有 `/`，写在字面量里要层层转义，
 * 可读性差且极易写错（这里踩过一次）。
 */
const OUTPUT_DIR = String.raw`(?:lib-gen/g\d+|lib|build\d*)`

/** 从 YAML 里取指向本仓库模块的相对入口。 */
function moduleEntrySpecs(): readonly string[] {
  const re = new RegExp(String.raw`name:\s*'\./${OUTPUT_DIR}/(modules/[^'?]+)\.js`, 'g')
  return [...yaml.matchAll(re)].map(m => m[1] as string)
}

/** 取 YAML 里「模块行 id + 其入口」的配对。 */
function moduleRows(): readonly (readonly [string, string])[] {
  const re = new RegExp(
    String.raw`- id:\s*(omb-[\w-]+)\s*\n\s*name:\s*'\./${OUTPUT_DIR}/(modules/[^'?]+)\.js`,
    'g',
  )
  return [...yaml.matchAll(re)].map(m => [m[1] as string, m[2] as string] as const)
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

  it('cordis.patch.yml 里每个模块入口都在静态清单中', () => {
    const declared = moduleEntrySpecs()
    expect(declared.length).toBeGreaterThan(0)
    for (const spec of declared) {
      expect(
        MODULE_ENTRIES.has(spec),
        `YAML 引用了 ${spec}，但 dsh/moduleEntries.ts 的静态清单里没有它——`
        + '这会让该行在插件页显示为激活失败（模块入口必须是静态导入，见 modules.ts 的说明）',
      ).toBe(true)
    }
  })

  it('静态清单里没有 YAML 未声明的入口（否则是没人装的死代码）', () => {
    const declared = new Set(moduleEntrySpecs())
    for (const key of MODULE_ENTRIES.keys()) {
      expect(declared.has(key), `静态清单里的 ${key} 在 YAML 里没有对应行`).toBe(true)
    }
  })

  it('每个 YAML 模块行的 id 都在 MODULE_IDS 里', () => {
    const rows = moduleRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [id] of rows) {
      expect(MODULE_IDS.includes(id as (typeof MODULE_IDS)[number]), `YAML 行 id ${id} 不在 MODULE_IDS`).toBe(true)
    }
  })

  it('每个 YAML 模块行的入口与静态清单里的键一一对应', () => {
    // 这条防的是"清单和 YAML 各自指向不同文件"——两边都对但配不上，
    // 于是插件页那一行激活的是另一个文件里的注册项。
    const rows = moduleRows()
    expect(rows.length).toBe(MODULE_ENTRIES.size)
    for (const [id, spec] of rows) {
      const namespace = MODULE_ENTRIES.get(spec)
      expect(namespace, `${id} 的入口 ${spec} 不在静态清单里`).toBeDefined()
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
    // 模块目录下的非入口文件也能被识别（形状判定会把它筛掉并记失败）
    expect(isModuleEntry('modules/memory/store')).toBe(true)
    // 子目录里的文件不是模块入口
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
    // 把同一模块放进两个入口键 → 只装配一次并记一次失败
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
    // 裸 manifest 也能通过形状判定（有 manifest.id 且 configSchema.parse 是函数），
    // 若被收下就会因 id 重复把真正可运行的注册项挤掉——实测导致模块被装配成
    // 没有 apply 的空壳，再被内核剔除。
    const bare = { manifest: { id: 'x', configSchema: { parse: () => ({}) } } }
    const runnable = { manifest: { id: 'x', configSchema: { parse: () => ({}) } }, apply: () => {} }
    const picked = pickRegistrations({ vectorManifest: bare, vectorModule: runnable })
    expect(picked).toHaveLength(1)
    expect(typeof picked[0]?.apply).toBe('function')
  })

  it('缺少 apply 或 configSchema.parse 的不算模块', () => {
    expect(pickRegistrations({ a: { manifest: { id: 'x', configSchema: { parse: () => ({}) } } } })).toHaveLength(0)
    expect(pickRegistrations({ a: { manifest: { id: 'x' }, apply: () => {} } })).toHaveLength(0)
  })
})
