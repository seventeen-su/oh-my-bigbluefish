/**
 * ABI 契约测试。
 *
 * 目的：任何对 ABI 的破坏性改动都必须显式经过这里。
 * 删改导出符号 → 本测试失败 → 强制走 `CORE_ABI_VERSION` 递增流程。
 */
import { describe, expect, it } from 'vitest'
import * as abi from '../../kernel/abi/index.js'
import { componentDirOf } from '../../kernel/display.js'

/**
 * 产物目录带**代数后缀**（`lib-gen/g<N>`）——代数变 = URL 变 = 宿主必然加载新模块，
 * 而不是命中 ESM 缓存里的旧实例（见 `kernel/buildInfo.ts` 的说明）。
 * 行名里**不出现**代数：换代由每个组件包的 `main`/`exports` 承担
 * （`scripts/build.mjs` 每次构建刷新它们）。
 */

describe('内核 ABI 契约', () => {
  it('CORE_ABI_VERSION 已冻结为 1', () => {
    expect(abi.CORE_ABI_VERSION).toBe(1)
  })

  it('运行时导出符号清单稳定（新增需显式更新本清单）', () => {
    const runtimeExports = Object.keys(abi).sort()
    expect(runtimeExports).toEqual([
      'ASSERTED_BY',
      'CORE_ABI_VERSION',
      'EDGE_TYPES',
      'FOCUS_DEPTHS',
      'MEMORY_KINDS',
      'MEMORY_SCOPES',
      'MODULE_CATALOG',
      'MODULE_IDS',
      'RESERVED_SOURCE_PREFIX',
      'RESIDENT_HINT_MAX',
      'SCHEMA_VERSION',
      'SCOPE_BY_KIND',
      'SERVICES',
      'STATUS_TOOL',
      'STORES_SERVICE',
      'toolsServiceFor',
      'validateCatalog',
    ])
  })

  it('模块目录自身一致：依赖存在、无环、id 唯一', () => {
    expect(abi.validateCatalog()).toEqual([])
  })

  it('模块 id 与 cordis.patch.yml 的行 id 一一对应（契约三方一致）', async () => {
    const { readFileSync } = await import('node:fs')
    const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    for (const id of abi.MODULE_IDS) {
      expect(yaml, `缺少行 id：${id}`).toContain(`id: ${id}`)
    }
  })

  it('cordis.patch.yml 的每个 name 都是**存在且有中文名的裸顶层包**', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

    // 判据（三方一致，两条硬约束夹出来的唯一解）：
    // ① 行名必须是**裸包名**：相对路径的行拿不到本地化元数据
    //    （`readPluginMeta` 见 `barePackageName(specifier) === undefined` 就放弃，
    //    packages/boot/app-boot/src/package-meta.ts:148），插件页只显示一串文件路径；
    // ② 不得带子路径：`@omb/plugin/omb-kernel` 实测 8 行 "failed to import"——
    //    宿主按 `barePackageName(request)` 查拦截路由，拿到的是 `@omb/plugin`。
    // 于是每个组件必须是一个独立顶层包，中文名放该包自己的 `locale/zh.json`。
    const ourNames = [...yaml.matchAll(/name:\s*'(@?[^']+)'/g)]
      .map(m => m[1] as string)
      .filter(name => name.startsWith('@omb/'))
    expect(ourNames.length).toBeGreaterThan(0)

    for (const name of ourNames) {
      const parts = name.split('/')
      expect(parts.length, `${name} 不是裸顶层包名（带了子路径）`).toBe(2)
      const dir = join(root, 'packages', componentDirOf(name))
      const manifestPath = join(dir, 'package.json')
      expect(existsSync(manifestPath), `${name} 对应的组件包不存在：${manifestPath}`).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
      expect(manifest.name, `${manifestPath} 的 name 与行名不一致`).toBe(name)

      // 中文名/说明：插件页那一列就取这两个字段
      const localePath = join(dir, 'locale', 'zh.json')
      expect(existsSync(localePath), `${name} 缺 locale/zh.json——插件页会退回显示包名`).toBe(true)
      const locale = JSON.parse(readFileSync(localePath, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
      expect(typeof locale.meta?.title === 'string' && locale.meta.title.length > 0, `${localePath} 缺 meta.title`).toBe(true)
      expect(
        typeof locale.meta?.description === 'string' && locale.meta.description.length > 0,
        `${localePath} 缺 meta.description`,
      ).toBe(true)

      // `exports` 必须放行 locale 与 package.json——元数据解析走的就是这两个子路径
      const exports = (manifest as { exports?: Record<string, unknown> }).exports
      expect(exports?.['./locale/zh.json'], `${name} 没有导出 locale/zh.json`).toBe('./locale/zh.json')
      expect(exports?.['./package.json'], `${name} 没有导出 package.json`).toBe('./package.json')
    }

    // 微内核那一行指向自己的组件包（它缺了整个插件都装不上）
    const kernelRow = /- id:\s*omb-kernel\s*\n\s*name:\s*'([^']+)'/.exec(yaml)?.[1]
    expect(kernelRow, 'cordis.patch.yml 里找不到 omb-kernel 行').toBeDefined()
    expect(kernelRow as string).toBe('@omb/kernel')
  })

  it('每个模块 id 在 cordis.patch.yml 里都有对应行（缺行 = 插件页看不到开关）', async () => {
    const { readFileSync } = await import('node:fs')
    const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    const declared = new Set([...yaml.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map(m => m[1] as string))
    for (const id of abi.MODULE_IDS) {
      expect(declared.has(id), `cordis.patch.yml 缺少行 id：${id}`).toBe(true)
    }
  })

  it('写入路由：情景/程序性落项目库，语义落用户库', () => {
    expect(abi.SCOPE_BY_KIND).toEqual({
      episodic: 'project',
      procedural: 'project',
      semantic: 'user',
    })
  })

  it('枚举取值冻结（改动即破坏性变更）', () => {
    expect(abi.MEMORY_KINDS).toEqual(['episodic', 'semantic', 'procedural'])
    expect(abi.MEMORY_SCOPES).toEqual(['user', 'project'])
    expect(abi.ASSERTED_BY).toEqual(['user', 'execution', 'model'])
    expect(abi.EDGE_TYPES).toEqual(['supersedes', 'conflicts_with', 'derived_from'])
    expect(abi.FOCUS_DEPTHS).toEqual(['quick', 'standard', 'deep'])
  })

  it('边类型没有权重字段——未归一化的权重是量纲不可比错误', () => {
    // 编译期约束的表达：Edge 只允许这四个字段
    const edge: abi.Edge = {
      fromId: 'a',
      toId: 'b',
      type: 'supersedes',
      createdAt: 0,
    }
    expect(Object.keys(edge).sort()).toEqual(['createdAt', 'fromId', 'toId', 'type'])
  })

  it('常驻提示上限为 120 字符（保住前缀缓存）', () => {
    expect(abi.RESIDENT_HINT_MAX).toBe(120)
  })
})
