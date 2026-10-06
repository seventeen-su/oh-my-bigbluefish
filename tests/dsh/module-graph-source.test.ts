/**
 * **依赖图的单一真源守卫**（缺陷 3）。
 *
 * 背景（实测核对，不是推断）：依赖图过去由三处共同决定——
 * ① `MODULE_CATALOG.requires`（`kernel/abi/catalog.ts`）
 * ② 各模块 `manifest.requires`
 * ③ `cordis.patch.yml` 行级 `inject`
 *
 * 现状与定性：
 * - ①→② 已改为**派生**（`derivedRequires`/`derivedCapabilities`），漂移在结构上不可能；
 * - ③ 无法派生（那是写给宿主的文件），因此由本测试**比对并失败**；
 * - ③ 的 `inject: ['omb:kernel']` 语义是"等内核就绪的门"，**不是模块间依赖**：
 *   生产路径上模块由宿主按**行序**逐行加载（`dsh/plugin.ts` 不调用 `handle.start()`），
 *   所以模块→模块的边由**行序**满足——下面对行序做断言。
 *
 * 守卫本身也必须被证明会失败：最后一段用**构造出来的**漂移数据证明这些判据不是恒真。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MODULE_CATALOG,
  MODULE_IDS,
  catalogEntryOf,
  derivedCapabilities,
  derivedRequires,
  validateCatalog,
} from '../../kernel/abi/index.js'
import { MODULE_ENTRIES } from '../../dsh/moduleEntries.js'
import { loadModulesSync } from '../../dsh/modules.js'
import { createKernel } from '../../kernel/index.js'

const yaml = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

interface YamlRow {
  readonly id: string
  readonly inject: readonly string[]
  /** 无条件的 `disabled: true`（条件式 `!!js` 另算，见 `conditionalDisabled`）。 */
  readonly disabled: boolean
  readonly conditionalDisabled: boolean
  readonly index: number
}

/**
 * 只取**模块行**：`insert:` 下 4 空格缩进的 `- id: omb-*`。
 * 预设行（`preset-omb`）与它内部的插件行缩进不同、id 也不以 `omb-` 开头，天然排除。
 */
export function parseModuleRows(text: string): readonly YamlRow[] {
  const rows: YamlRow[] = []
  const lines = text.split(/\r?\n/)
  let current: { id: string; body: string[]; index: number } | undefined
  const flush = (): void => {
    if (current === undefined) return
    const body = current.body.join('\n')
    const injectMatch = /^\s*inject:\s*\[([^\]]*)\]/m.exec(body)
    const inject = injectMatch === null
      ? []
      : (injectMatch[1] ?? '')
          .split(',')
          .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
          .filter(part => part.length > 0)
    const disabledLine = /^\s*disabled:\s*(.+)$/m.exec(body)
    const raw = disabledLine?.[1] ?? ''
    rows.push({
      id: current.id,
      inject,
      disabled: disabledLine !== null && !raw.includes('!!js'),
      conditionalDisabled: disabledLine !== null && raw.includes('!!js'),
      index: current.index,
    })
    current = undefined
  }
  lines.forEach((line, index) => {
    const match = /^ {4}- id: (omb-[\w-]+)\s*$/.exec(line)
    if (match !== null) {
      flush()
      current = { id: match[1] ?? '', body: [], index }
      return
    }
    if (current !== undefined) current.body.push(line)
  })
  flush()
  return rows
}

/**
 * **允许出现的行级 `inject` 键**（逐个显式登记）。
 *
 * 为什么是白名单而不是"随便写"：行级 `inject` 的每个键都是宿主**服务名**，
 * 宿主会一直等服务出现才激活该行。写错一个键（`omb-memory` 这种模块 id、
 * 或 `command` 这种拼错的宿主服务名）→ 该行**永远 pending**、能力静默缺席。
 * 实测过这个失败形态（`inject: ['omb:kernel']` 缺了就是"模块取不到内核"）。
 *
 * - `omb:kernel`：**每一行都必须有**（等内核把服务发布出来）
 * - `commands`：宿主斜杠命令注册表（`/omb-privacy` 的控制面入口要它；
 *   3.6 起隐私并入记忆库，这个键因此挂在 `omb-memory` 那一行上，不再是独立行）
 *
 * 新增键必须显式加到这里——那正是"被有意识地决定过一次"的证据。
 */
export const ALLOWED_INJECT_KEYS: readonly string[] = ['omb:kernel', 'commands']

/** 判据（纯函数，便于用构造数据证明它会失败）：每行必须等内核门，且键都在白名单里。 */
export function injectViolations(rows: readonly YamlRow[]): readonly string[] {
  const problems: string[] = []
  for (const row of rows) {
    if (row.id === 'omb-kernel') {
      if (row.inject.length > 0) problems.push(`${row.id}: 内核行不该 inject 任何东西（它就是门本身）`)
      continue
    }
    if (!row.inject.includes('omb:kernel')) {
      problems.push(`${row.id}: 缺少内核就绪门 omb:kernel（inject=${JSON.stringify(row.inject)}）`)
    }
    for (const key of row.inject) {
      if ((MODULE_IDS as readonly string[]).includes(key)) {
        problems.push(
          `${row.id}: inject 里出现了模块 id「${key}」——宿主服务表里没有这个键（那是模块间依赖，靠行序保证）`,
        )
        continue
      }
      if (!ALLOWED_INJECT_KEYS.includes(key)) {
        problems.push(
          `${row.id}: inject 键「${key}」未登记（写错的服务名会让整行永远 pending）；` +
            `确认后加进 ALLOWED_INJECT_KEYS`,
        )
      }
    }
  }
  return problems
}

/** 判据：行序必须满足目录里的模块依赖图。 */
export function orderViolations(rows: readonly YamlRow[]): readonly string[] {
  const rowById = new Map(rows.map(row => [row.id, row]))
  const problems: string[] = []
  for (const row of rows) {
    const entry = catalogEntryOf(row.id)
    if (entry === undefined) {
      problems.push(`${row.id}: 不在 MODULE_CATALOG 里`)
      continue
    }
    for (const dep of entry.requires) {
      const depRow = rowById.get(dep)
      if (depRow === undefined) continue // 内核行：由插件本体的 apply 承担，不是模块行
      if (depRow.index >= row.index) {
        problems.push(`${row.id} 依赖 ${dep}，但 ${dep} 排在它后面`)
      }
    }
  }
  return problems
}

/** 判据：`enabledByDefault` 与行上的 `disabled` 互为镜像（条件式禁用除外）。 */
export function disabledMismatches(rows: readonly YamlRow[]): readonly string[] {
  const problems: string[] = []
  for (const row of rows) {
    if (row.conditionalDisabled) continue
    const entry = catalogEntryOf(row.id)
    if (entry === undefined) {
      problems.push(`${row.id}: 不在 MODULE_CATALOG 里`)
      continue
    }
    if (row.disabled !== !entry.enabledByDefault) {
      problems.push(
        `${row.id}: enabledByDefault=${String(entry.enabledByDefault)} 但 disabled=${String(row.disabled)}`,
      )
    }
  }
  return problems
}

const rows = parseModuleRows(yaml)

describe('模块目录 ↔ 模块 manifest：由派生保证一致', () => {
  it('目录自身一致（id 唯一、依赖存在、无环）', () => {
    expect(validateCatalog()).toEqual([])
  })

  it('每个模块 manifest 的 requires/capabilities 逐字等于目录声明', () => {
    const loaded = loadModulesSync(MODULE_ENTRIES)
    expect(loaded.failures, `模块入口装配失败：${loaded.failures.map(f => f.reason).join('；')}`).toEqual([])
    const byId = new Map(loaded.modules.map(m => [m.manifest.id, m.manifest]))
    for (const entry of MODULE_CATALOG) {
      if (entry.id === 'omb-kernel') continue // 内核是插件本体，不是模块注册项
      const manifest = byId.get(entry.id)
      expect(manifest, `目录声明了 ${entry.id}，但装配里没有它`).toBeDefined()
      expect(manifest?.requires, `${entry.id} 的 requires 与目录漂移`).toEqual([...entry.requires])
      expect(manifest?.capabilities, `${entry.id} 的 capabilities 与目录漂移`).toEqual([...entry.capabilities])
    }
  })

  it('目录里的每个模块（除内核行）都必须在静态入口清单里，且没有野生模块', () => {
    const loaded = loadModulesSync(MODULE_ENTRIES)
    const ids = new Set(loaded.modules.map(m => m.manifest.id))
    for (const id of MODULE_IDS) {
      if (id === 'omb-kernel') continue
      expect(ids.has(id), `模块 ${id} 不在 dsh/moduleEntries.ts 的静态清单里`).toBe(true)
    }
    for (const id of ids) {
      expect(catalogEntryOf(id), `模块 ${id} 未登记进 MODULE_CATALOG`).toBeDefined()
    }
  })
})

describe('模块目录 ↔ cordis.patch.yml：漂移即失败', () => {
  it('行 id 与 MODULE_IDS 一一对应（不多不少、不重复）', () => {
    expect(rows.length).toBeGreaterThan(0)
    expect([...rows.map(r => r.id)].sort()).toEqual([...MODULE_IDS].sort())
    expect(new Set(rows.map(r => r.id)).size, '有重复的模块行').toBe(rows.length)
  })

  it('每行都等内核门（`omb:kernel`），且 inject 键都在白名单里（不是模块间依赖）', () => {
    expect(injectViolations(rows)).toEqual([])
  })

  it('行序满足目录里的模块依赖图（依赖必须排在依赖方之前）', () => {
    expect(orderViolations(rows)).toEqual([])
  })

  it('enabledByDefault 与行上的 disabled 互为镜像', () => {
    expect(disabledMismatches(rows)).toEqual([])
  })
})

describe('模块目录：字段没有"看起来权威但没人读"的中间态', () => {
  it('声明的工具名全局唯一且带 omb_ 前缀（assembly.smoke 会核对真的注册了）', () => {
    const all = MODULE_CATALOG.flatMap(entry => entry.tools)
    expect(new Set(all).size, `工具名重复：${all.join(',')}`).toBe(all.length)
    for (const name of all) expect(name.startsWith('omb_'), `${name} 缺 omb_ 前缀`).toBe(true)
  })

  it('capabilities 全局唯一（能力名是状态面与开关的对外契约）', () => {
    const all = MODULE_CATALOG.flatMap(entry => entry.capabilities)
    expect(new Set(all).size, `能力名重复：${all.join(',')}`).toBe(all.length)
  })

  it('未知 id 的派生会**抛**（不静默给默认依赖图）', () => {
    expect(catalogEntryOf('omb-not-a-module')).toBeUndefined()
    expect(() => derivedRequires('omb-not-a-module')).toThrow(/不在 MODULE_CATALOG/)
    expect(() => derivedCapabilities('omb-not-a-module')).toThrow(/不在 MODULE_CATALOG/)
  })
})

describe('依赖缺席时的降级链：可读原因，不假装正常（无前端条件下的"自动关闭"形态）', () => {
  it('omb-memory 缺席：依赖它的真实模块给出 degraded/failed + 可读原因', () => {
    // 复现"配置里强行启用依赖方，但依赖那一行被关掉"：
    // 宿主照样会挂载 profile / memory-vector 行（行序守卫已证明 inject 只管内核门），
    // 于是它们拿不到 `stores` 服务——必须**如实降级并写明原因**，不能 state=ok 空转。
    const handle = createKernel()
    const loaded = loadModulesSync(MODULE_ENTRIES)
    const dependents = ['omb-profile', 'omb-memory-vector']
    for (const id of dependents) {
      const registration = loaded.modules.find(m => m.manifest.id === id)
      expect(registration, `装配里缺少 ${id}`).toBeDefined()
      if (registration === undefined) continue
      handle.mount(registration)
      const health = handle.health()[id]
      expect(health, `${id} 没有任何健康记录——缺席的依赖被静默吞掉了`).toBeDefined()
      expect(health?.state, `${id} 在依赖缺席时不该自称正常`).not.toBe('ok')
      expect((health?.detail ?? '').length, `${id} 的降级原因不能为空（无空降级）`).toBeGreaterThan(8)
    }

    // 依赖缺席这件事必须出现在**至少一个可读位置**：模块自己的原因，或依赖图自检。
    // 实测：`omb-memory-vector` 自报的是"权重目录不存在"（它自己的降级路径），
    // 并不提 omb-memory——所以依赖图自检不是装饰，它是这件事唯一被说出来的地方。
    const report = handle.moduleGraph()
    expect([...report.missingDependencies].sort()).toEqual(['omb-memory-vector ← omb-memory', 'omb-profile ← omb-memory'])
    for (const id of dependents) {
      const detail = handle.health()[id]?.detail ?? ''
      const selfExplains = /依赖|服务|stores|未就绪|不可用|未自报/.test(detail)
      const graphExplains = report.missingDependencies.some(line => line.startsWith(id))
      expect(selfExplains || graphExplains, `${id} 的依赖缺席既没写进自己的原因，也没进依赖图自检`).toBe(true)
    }
    expect(handle.status().join('\n')).toContain('依赖未挂载')
    // H-1：这一路不抛
    expect(() => handle.dispose()).not.toThrow()
  })
})

describe('守卫本身会失败（用构造出来的漂移数据证明判据不是恒真）', () => {  it('行序倒置被抓住', () => {
    const drifted = parseModuleRows(
      [
        '- insert:',
        '    - id: omb-memory-vector', // 依赖 omb-memory，却排在它前面
        "      name: '@omb/memory-vector'",
        "      inject: ['omb:kernel']",
        '    - id: omb-memory',
        "      name: '@omb/memory'",
        "      inject: ['omb:kernel']",
        '',
      ].join('\n'),
    )
    expect(orderViolations(drifted).join('\n')).toContain('omb-memory-vector 依赖 omb-memory')
  })

  it('inject 写错（写成模块 id）被抓住', () => {
    const drifted = parseModuleRows(
      [
        '- insert:',
        '    - id: omb-memory-vector',
        "      name: '@omb/memory-vector'",
        "      inject: ['omb:kernel', 'omb-memory']", // 宿主服务表里没有 omb-memory → 行会永远 pending
        '',
      ].join('\n'),
    )
    const problems = injectViolations(drifted).join('\n')
    expect(problems).toContain('omb-memory')
    expect(problems).toContain('模块 id')
  })

  it('inject 漏了内核门 / 拼错宿主服务名被抓住', () => {
    const noGate = parseModuleRows(
      ['- insert:', '    - id: omb-notify', "      name: '@omb/notify'", '',].join('\n'),
    )
    expect(injectViolations(noGate).join('\n')).toContain('缺少内核就绪门')

    const typo = parseModuleRows(
      [
        '- insert:',
        '    - id: omb-notify',
        "      name: '@omb/notify'",
        "      inject: ['omb:kernel', 'command']", // 少了 s → 永远等不到
        '',
      ].join('\n'),
    )
    expect(injectViolations(typo).join('\n')).toContain('未登记')
  })

  it('disabled 与 enabledByDefault 不一致被抓住', () => {
    const drifted = parseModuleRows(
      [
        '- insert:',
        '    - id: omb-notify',
        "      name: '@omb/notify'",
        "      inject: ['omb:kernel']",
        '      disabled: true', // 目录说默认启用
        '',
      ].join('\n'),
    )
    expect(disabledMismatches(drifted).join('\n')).toContain('omb-notify')
  })

  it('条件式 disabled（!!js）不参与镜像（平台决定，不是漂移）', () => {
    const conditional = parseModuleRows(
      [
        '- insert:',
        '    - id: omb-notify',
        "      name: '@omb/notify'",
        "      inject: ['omb:kernel']",
        "      disabled: !!js process.platform === 'win32'",
        '',
      ].join('\n'),
    )
    expect(disabledMismatches(conditional)).toEqual([])
  })
})
