/**
 * 模块装配的契约测试。
 *
 * 防的是**由本设计新引入的失败模式**：为了让插件能在宿主 Node 进程里加载，
 * 模块入口必须是静态导入（`import.meta.glob` 编译后不是合法 Node 代码，
 * 运行期扫目录又是异步的、违反 H-2）。代价是"新增模块要加一行"。
 *
 * 本测试把这个代价变成一条会失败的测试，而不是一个静默缺席的功能。
 *
 * 插件页中文名那一组判据的由来（两难，只有一条出路）：
 * - 相对路径的行**永远拿不到本地化元数据**（`readPluginMeta` 见
 *   `barePackageName(specifier) === undefined` 就返回 undefined，
 *   `packages/boot/app-boot/src/package-meta.ts:148`）；
 * - "裸包名 + 子路径"（`@omb/plugin/omb-kernel`）宿主**解析不了**
 *   （实测 8 行 failed to import）；
 * - 于是行名只能是**裸顶层包名**，每个组件是一个独立顶层包 `packages/<组件>/`，
 *   中文名由构建脚本从 `kernel/display.ts` 生成到该包的 `locale/zh.json`。
 * 下面几条判据把这三件事钉在一起，任一处漂移都会失败。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync, isModuleEntry, pickRegistrations, ambiguousIds, registrationFor } from '../../dsh/modules.js'
import { MODULE_IDS } from '../../kernel/abi/index.js'
import { COMPONENT_DISPLAY, componentDirOf, displayFor } from '../../kernel/display.js'
import * as artifactEntry from '../../packages/artifact/index.js'
import * as contextEntry from '../../packages/context/index.js'
import * as kernelEntry from '../../packages/kernel/index.js'
import * as memoryEntry from '../../packages/memory/index.js'
import * as memoryVectorEntry from '../../packages/memory-vector/index.js'
import * as notifyEntry from '../../packages/notify/index.js'
import * as profileEntry from '../../packages/profile/index.js'
import * as reasoningEntry from '../../packages/reasoning/index.js'

const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 组件包入口的**静态**清单（与 `modules/moduleEntries.ts` 同样的理由：显式一行，
 * 漏加就报错）。这里只用于测试，不带运行期含义。
 */
const COMPONENT_ENTRIES: Readonly<Record<string, unknown>> = {
  kernel: kernelEntry,
  memory: memoryEntry,
  'memory-vector': memoryVectorEntry,
  profile: profileEntry,
  reasoning: reasoningEntry,
  context: contextEntry,
  artifact: artifactEntry,
  notify: notifyEntry,
}

/** 从 YAML 里取「行 id → 行 name」的配对。 */
function moduleRows(): readonly (readonly [string, string])[] {
  return [...yaml.matchAll(/- id:\s*(omb-[\w-]+)\s*\n\s*name:\s*'([^']+)'/g)].map(
    m => [m[1] as string, m[2] as string] as const,
  )
}

/** 裸顶层包名（`@scope/name` 或 `name`）——不含子路径。 */
function isBarePackageName(name: string): boolean {
  const parts = name.split('/')
  return name.startsWith('@') ? parts.length === 2 && parts.every(p => p.length > 0) : parts.length === 1
}

/** 组件包目录（`packages/<目录>`）。 */
function packageDirOf(packageName: string): string {
  return join(root, 'packages', componentDirOf(packageName))
}

/** 读一个组件包的清单。 */
function manifestOf(packageName: string): {
  name?: string
  main?: string
  exports?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(packageDirOf(packageName), 'package.json'), 'utf8')) as {
    name?: string
    main?: string
    exports?: Record<string, string>
  }
}

/** 读一个组件包的 locale 字典。 */
function localeOf(packageName: string, language: string): { meta?: { title?: string; description?: string } } {
  return JSON.parse(
    readFileSync(join(packageDirOf(packageName), 'locale', `${language}.json`), 'utf8'),
  ) as { meta?: { title?: string; description?: string } }
}

/** 当前构建代数（`lib-gen/` 不入库，未构建时没有产物可查）。 */
function currentGeneration(): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../build-generation.json', import.meta.url), 'utf8')) as {
      generation?: unknown
      outDir?: unknown
    }
    return typeof parsed.generation === 'number' && typeof parsed.outDir === 'string'
      ? parsed.generation
      : undefined
  } catch {
    return undefined
  }
}

describe('模块入口清单与 YAML 一致', () => {
  it('YAML 的 name 不得带 ?v= 缓存尾缀（新宿主下会让行加载失败）', () => {
    // 由来：`?v=N` 是旧 v2 的开发习惯（Node ESM 按 URL 缓存）。
    // 在 DSH 0.1.7 里它**从原理上不可用**——实测装到 profile 后 8 行全部
    // "failed to import"，报错 URL 形如 `kernel.js%3Fv=1`：那个 `?v=1`
    // 被当成**文件名字面量**去找，文件当然不存在。
    // 换代现在由组件包的 `main`/`exports` 指向 `lib-gen/g<N>/` 承担。
    const offenders = [...yaml.matchAll(/name:\s*'([^']*\?v=\d+[^']*)'/g)].map(m => m[1] as string)
    expect(offenders, `这些行带了 ?v= 尾缀，装到宿主后会加载失败：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每行的 name 都是组件包的裸顶层包名（宿主按它查拦截路由并取本地化元数据）', () => {
    // 判据三方一致：YAML 行名 = kernel/display.ts 的 packageName = packages/<目录> 的包名。
    // 相对路径拿不到中文名；"裸包名 + 子路径"解析不了——两者都实测过。
    const rows = moduleRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [id, name] of rows) {
      expect(name.startsWith('.'), `行 ${id} 的 name「${name}」是相对路径——拿不到中文名`).toBe(false)
      expect(isBarePackageName(name), `行 ${id} 的 name「${name}」带了子路径或查询串——宿主解析不了`).toBe(true)
      expect(name, `行 ${id} 的 name「${name}」与显示表不一致`).toBe(displayFor(id)?.packageName)
      expect(manifestOf(name).name, `packages/${componentDirOf(name)}/package.json 的 name 与行名不一致`).toBe(name)
    }
  })

  it('每个组件包都有 locale/zh.json，且标题/说明与 kernel/display.ts 逐字一致', () => {
    // 插件页显示的是 `readPluginMeta` 从 `<包名>/locale/zh.json` 取的
    // `meta.title` / `meta.description`。这里把"生成结果 = 唯一真源"钉住：
    // 改了 display.ts 却忘了跑构建，本测试立刻失败。
    for (const [id, name] of moduleRows()) {
      const display = displayFor(id)
      expect(display, `行 ${id} 缺显示元数据（kernel/display.ts）`).toBeDefined()
      const zh = localeOf(name, 'zh')
      const en = localeOf(name, 'en')
      expect(zh.meta?.title, `packages/${componentDirOf(name)}/locale/zh.json 的中文名与 display.ts 不一致`).toBe(display?.zh)
      expect(zh.meta?.description, `packages/${componentDirOf(name)}/locale/zh.json 的说明与 display.ts 不一致`).toBe(display?.zhDescription)
      expect(en.meta?.title, 'en.json 的英文名与 display.ts 不一致').toBe(display?.en)
      expect(en.meta?.description, 'en.json 的英文说明与 display.ts 不一致').toBe(display?.enDescription)
    }
  })

  it('每个组件包的 exports 暴露 locale 与 package.json（元数据解析就靠这两个子路径）', () => {
    for (const [id, name] of moduleRows()) {
      const manifest = manifestOf(name)
      expect(manifest.exports?.['./locale/zh.json'], `行 ${id} 的包没有导出 locale/zh.json`).toBe('./locale/zh.json')
      expect(manifest.exports?.['./locale/en.json'], `行 ${id} 的包没有导出 locale/en.json`).toBe('./locale/en.json')
      expect(manifest.exports?.['./package.json'], `行 ${id} 的包没有导出 package.json`).toBe('./package.json')
      expect(manifest.exports?.['.'], `行 ${id} 的包没有导出入口`).toBe(manifest.main)
    }
  })

  it('每个组件包的入口指向当前代数，且该转发文件与编译产物真实存在', () => {
    // 换代就是靠这里：`main`/`exports` 指向 `lib-gen/g<N>/index.js`，URL 变 = 不命中 ESM 缓存。
    // 代数号**不得**出现在 cordis.patch.yml 里（行名是裸包名，见上面两条）。
    const generation = currentGeneration()
    expect(generation, 'build-generation.json 缺失或损坏——先跑 node scripts/build.mjs').toBeDefined()
    const built = existsSync(join(root, 'lib-gen', `g${generation as number}`))
    for (const [id, name] of moduleRows()) {
      const pointer = `./lib-gen/g${generation as number}/index.js`
      const manifest = manifestOf(name)
      expect(manifest.main, `行 ${id}（${name}）的 main 没指向当前代数——跑 node scripts/build.mjs`).toBe(pointer)
      expect(manifest.exports?.['.']).toBe(pointer)
      // tsc 产物与转发文件：`lib-gen/` 不入库，未构建时跳过（构建后必须存在）
      if (!built) continue
      expect(
        existsSync(join(root, 'lib-gen', `g${generation as number}`, 'packages', componentDirOf(name), 'index.js')),
        `行 ${id} 缺编译产物 lib-gen/g${generation as number}/packages/${componentDirOf(name)}/index.js`,
      ).toBe(true)
      expect(
        existsSync(join(packageDirOf(name), 'lib-gen', `g${generation as number}`, 'index.js')),
        `行 ${id} 缺包内转发文件 packages/${componentDirOf(name)}/lib-gen/g${generation as number}/index.js`,
      ).toBe(true)
      // 转发文件的两条语句都要在：`export *` 带出具名注册项，`export { default }` 供宿主按行加载
      const shim = readFileSync(join(packageDirOf(name), 'lib-gen', `g${generation as number}`, 'index.js'), 'utf8')
      expect(shim).toContain(`lib-gen/g${generation as number}/packages/${componentDirOf(name)}/index.js`)
      expect(shim).toContain('export *')
      expect(shim).toContain('export { default }')
    }
  })

  it('没有两行指向同一个组件包（否则同一模块被激活两次）', () => {
    // 实测过这个症状：状态面出现两条 `omb-context` 段落、计数器各自独立。
    const names = moduleRows().map(([, name]) => name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个 YAML 模块行的 id 都在 MODULE_IDS 里', () => {
    const rows = moduleRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const [id] of rows) {
      expect(MODULE_IDS.includes(id as (typeof MODULE_IDS)[number]), `YAML 行 id ${id} 不在 MODULE_IDS`).toBe(true)
    }
  })

  it('每个组件都有中文显示名与说明（插件页那一列靠它）', () => {
    // 插件页显示的是行的 name；中文名来自 `packages/<组件>/locale/zh.json`。
    // 缺了它用户看到的就是一串包名/路径，不知道哪个开关对应哪个组件。
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

  it('每个组件包的 default 导出就是该组件的宿主插件（宿主按行加载读的就是它）', () => {
    // 这条是**真实形状**的验证：逐个 import 组件包入口，断言
    // ① 有 default；② default 就是该组件的宿主插件；③ 具名导出里能取到唯一注册项。
    // 少了任何一条，宿主那一行就是"装上但什么都不做"。
    for (const [id, name] of moduleRows()) {
      const dir = componentDirOf(name)
      const namespace = COMPONENT_ENTRIES[dir] as {
        default?: unknown
        apply?: unknown
        name?: unknown
        manifest?: { id?: string }
      } | undefined
      expect(namespace, `行 ${id} 的组件包 packages/${dir} 不在测试的静态清单里`).toBeDefined()
      expect(namespace?.default, `组件包 ${name} 没有 default 导出——宿主按行加载读的就是它`).toBeDefined()
      if (id === 'omb-kernel') {
        // 微内核是**插件本体**（不是模块目录里的注册项）：default 就是 apply 函数，
        // 形状与换代前的 `lib-gen/g<N>/dsh/kernel.js` 完全一致。
        expect(typeof namespace?.default, '微内核入口的 default 应是 apply 函数').toBe('function')
        expect(namespace?.apply).toBe(namespace?.default)
        expect(namespace?.name).toBe('omb')
        continue
      }
      const plugin = namespace?.default as { manifest?: { id?: string }; apply?: unknown }
      expect(plugin.manifest?.id, `组件包 ${name} 的 default 不是本组件的宿主插件`).toBe(id)
      expect(typeof plugin.apply, `组件包 ${name} 的 default 没有 apply`).toBe('function')
      expect(() => registrationFor(namespace, id), `组件包 ${name} 取不到唯一注册项`).not.toThrow()
    }
    // 静态清单里不该有孤儿包
    const rowDirs = new Set(moduleRows().map(([, name]) => componentDirOf(name)))
    for (const dir of Object.keys(COMPONENT_ENTRIES)) {
      expect(rowDirs, `packages/${dir} 在 cordis.patch.yml 里没有对应行`).toContain(dir)
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
