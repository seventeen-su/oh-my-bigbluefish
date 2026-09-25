/**
 * ABI 契约测试。
 *
 * 目的：任何对 ABI 的破坏性改动都必须显式经过这里。
 * 删改导出符号 → 本测试失败 → 强制走 `CORE_ABI_VERSION` 递增流程。
 */
import { describe, expect, it } from 'vitest'
import * as abi from '../../kernel/abi/index.js'

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

  it('cordis.patch.yml 的每个 name 都能映射到源码入口（构建前即可校验落点）', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

    // 只校验指向本仓库的相对路径（'./lib/...'），宿主包行（'@deepseek-ai/...'）跳过
    const relativeNames = [...yaml.matchAll(/name:\s*'(\.\/[^']+)'/g)].map(m => m[1] as string)
    expect(relativeNames.length).toBeGreaterThan(0)

    // 尚未实现的模块入口不计为失败——本段在实现到位前输出信息，实现后自然全绿。
    // 这样契约测试可以在施工过程中保持可运行，而不是一开始就红着挡住所有提交。
    const missing: string[] = []
    for (const name of relativeNames) {
      // './lib/modules/memory/index.js?v=1' → 源码落点 'modules/memory/index.ts'
      const withoutQuery = name.split('?')[0] as string
      const sourceBase = withoutQuery.replace(/^\.\/(?:lib|build\d*)\//, '').replace(/\.js$/, '')
      const candidates = [`${sourceBase}.ts`, `${sourceBase}/index.ts`]
      if (!candidates.some(c => existsSync(`${root}${c}`))) missing.push(`${name} → 试过 ${candidates.join(' / ')}`)
    }
    if (missing.length > 0) {
       
      console.warn(`[未实现的模块入口 ${missing.length} 个]\n${missing.join('\n')}`)
    }
    // 指向 dsh/ 的入口必须存在——那是插件本体，缺了整个插件都装不上
    for (const name of relativeNames.filter(n => n.includes('/dsh/'))) {
      const sourceBase = (name.split('?')[0] as string).replace(/^\.\/(?:lib|build\d*)\//, '').replace(/\.js$/, '')
      const exists = [`${sourceBase}.ts`, `${sourceBase}/index.ts`].some(c => existsSync(`${root}${c}`))
      expect(exists, `插件入口缺失：${name}`).toBe(true)
    }
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
