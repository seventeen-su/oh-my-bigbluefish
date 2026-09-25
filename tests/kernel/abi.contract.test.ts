/**
 * ABI 契约测试。
 *
 * 目的：任何对 ABI 的破坏性改动都必须显式经过这里。
 * 删改导出符号 → 本测试失败 → 强制走 `CORE_ABI_VERSION` 递增流程。
 */
import { describe, expect, it } from 'vitest'
import * as abi from '../../kernel/abi/index.js'

/**
 * 产物路径前缀。产物目录带**代数后缀**（`lib-gen/g1`）——代数变 = URL 变 =
 * 宿主必然加载新模块，而不是命中 ESM 缓存里的旧实例
 * （见 `kernel/buildInfo.ts` 的说明）。
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

  it('cordis.patch.yml 的每个 name 都是存在的产物相对路径', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

    // 行名必须是**相对路径**：宿主用 `new URL(name, baseUrl)` 解析它。
    // 实测裸包名 + 子路径（`@omb/plugin/omb-kernel`）在这个宿主里解析不了
    // ——8 行全部 "failed to import"。所以这是硬约束，不是风格偏好。
    const ourNames = [...yaml.matchAll(/name:\s*'(\.\/[^']+)'/g)].map(m => m[1] as string)
    expect(ourNames.length).toBeGreaterThan(0)

    for (const name of ourNames) {
      const withoutQuery = name.split('?')[0] as string
      // 相对路径锚定补丁文件所在目录（仓库根）
      expect(
        existsSync(`${root}${withoutQuery.replace(/^\.\//, '')}`),
        `${name} 指向的产物不存在（先跑 node scripts/build.mjs）`,
      ).toBe(true)
    }

    // 指向内核本体的那一行必须在 dsh/ 下——它缺了整个插件都装不上
    const kernelRow = /- id:\s*omb-kernel\s*\n\s*name:\s*'([^']+)'/.exec(yaml)?.[1]
    expect(kernelRow, 'cordis.patch.yml 里找不到 omb-kernel 行').toBeDefined()
    expect(kernelRow as string).toContain('/dsh/')
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
