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
      'RESIDENT_HINT_MAX',
      'SCHEMA_VERSION',
      'SCOPE_BY_KIND',
      'SERVICES',
      'STATUS_TOOL',
      'STORES_SERVICE',
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
