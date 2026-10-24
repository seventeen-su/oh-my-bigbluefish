/**
 * 护栏：大肥鱼模式（`preset-omb` 的 `config.plugins`）的**行清单**。
 *
 * ## 为什么需要一条"数行"的测试
 *
 * 这个列表就是"用大肥鱼模式时模型手里有什么"。它曾经因为注释写断了而只剩
 * persona + agent-instructions，后果是一个文件/命令工具都没有，而**门禁全绿**——
 * 因为没有任何测试覆盖 `preset-omb.config.plugins`（`abi.contract` 只收 `@omb/` 前缀，
 * 预设里的 `@deepseek-ai/dsh-*` 全被过滤掉；装配 smoke 只到内核/模块层）。
 *
 * 大肥鱼模式以 DSH 自带**创造模式**为底。DSH 0.2.1-rc.3（当前核过的宿主）的创造模式
 * 定义在 `<dsh-checkout>/packages/bundle/web-app/presets/cordis.patch.yml`，相对 0.2.0-rc.2：
 *
 *   新增：`time-context`、`tool-schedule`、`tool-plugin-market`
 *   删除：`tool-subagent-codex`、`tool-subagent-claude-code`、`tool-ralph`
 *   删除字段：`backgroundMode`
 *   文案：`plan-mode` 首句改为"直到用户通过 exit_plan_mode 批准"
 *
 * **rc.3 之后又变了两处**（本文件对这两处单独加断言）：
 *
 *   - `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径被移除，
 *     `list_agents` 改由主插件注册——预设里再写这一行会让**整个预设挂载失败**；
 *   - `tool-subagent` 的配置键 `modelSelectionSettings` 改名为
 *     `modelSelection` + `modelDiscovery`，旧键会被 schemastery 静默合并、永不生效。
 *
 * 所以这里把"应与创造模式一致的行"钉成清单：**增减任何一行都必须同步本文件**。
 * 只是文本级断言（仓库没有 YAML 依赖），但它足以让"漏一行"变成红灯。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `tests/dsh/` 下）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const patchText = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * 与 DSH 0.2.1-rc.3 创造模式逐行对齐的包清单（**唯一有意的差异**是 `tool-cordis`：
 * 它是给"改 DSH 自身"用的源码导航工具，与 OMB 的日常认知任务无关，见 cordis.patch.yml 注释）。
 */
const CREATIVE_MODE_PACKAGES = [
  // 人格 / 指令 / 时间上下文
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  // 平台工具
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-tool-goal',
  // 计划模式
  '@deepseek-ai/dsh-plan-mode',
  // 压缩组
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  // 委派组
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-workflow-ptc',
  '@deepseek-ai/dsh-tool-workflow',
  // 交互与网页
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  // 技能 / 展示
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-present',
  // 插件管理（宿主平面提供 profileContext 时才启用）
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-plugin-market',
] as const

/** 预设里引用但**有意不抄**的创造模式行。 */
const INTENTIONALLY_OMITTED = ['@deepseek-ai/dsh-tool-cordis'] as const

/** 0.2.1-rc.2 创造模式已删除、本仓库也不应再引用的行（保留是陷阱：一启用就整预设挂载失败）。 */
const REMOVED_HOST_ROWS = [
  'dsh-tool-subagent-codex',
  'dsh-tool-subagent-claude-code',
  'dsh-tool-ralph',
] as const

/** 预设/工具行使用的所有 `name:` 取值（含 `@omb/*` 组件行与 `cordis:group`）。 */
function declaredNames(): string[] {
  return [...patchText.matchAll(/^\s*name:\s*'([^']+)'/gm)].map(match => match[1] ?? '')
}

/** 每个 `name:` 行的行号，便于报错时定位。 */
function lineOf(name: string): number {
  const lines = patchText.split('\n')
  return lines.findIndex(line => line.includes(`name: '${name}'`)) + 1
}

describe('大肥鱼模式的行清单', () => {
  it('扫描到了预设行（否则这条护栏是空转的）', () => {
    const names = declaredNames()
    expect(names).toContain('@deepseek-ai/dsh-agent-preset')
    expect(names).toContain('@omb/kernel')
    expect(names.length).toBeGreaterThan(20)
  })

  it('创造模式里有的工具/上下文行一个都不少（tool-cordis 除外，理由见注释）', () => {
    // 行名可能带子路径（如 `@deepseek-ai/dsh-plugin-manager/tools`），按裸包名比较
    const bare = (name: string) => name.split('/').slice(0, 2).join('/')
    const used = new Set(declaredNames().map(bare))
    const missing = CREATIVE_MODE_PACKAGES.filter(pkg => !used.has(pkg))
    expect(missing, '与 DSH 0.2.1-rc.3 创造模式对齐：这些行缺失就是模型能力缺口').toEqual([])
  })

  it('rc.3 移除的 list-agents 子路径行不再出现（写入会让整个预设 broken）', () => {
    // 只看 `name:` 取值：注释里会写"不要再加回这一行"，那正是这条护栏的价值
    expect(declaredNames()).not.toContain('@deepseek-ai/dsh-tool-subagent-control/list-agents')
  })

  it('tool-subagent 用的是 rc.3 的配置键 modelSelection/modelDiscovery（旧 modelSelectionSettings 静默失效）', () => {
    expect(patchText).toMatch(/^\s*modelSelection:\s*true\s*$/m)
    expect(patchText).toMatch(/^\s*modelDiscovery:\s*true\s*$/m)
    expect(patchText).not.toMatch(/^\s*modelSelectionSettings\s*:/m)
  })

  it('有意省略的 tool-cordis 不出现（这条让"省略"变成显式决定而不是遗忘）', () => {
    const names = declaredNames()
    for (const pkg of INTENTIONALLY_OMITTED) expect(names).not.toContain(pkg)
  })

  it('rc.2 已删除的 codex / claude-code / ralph 行不再出现', () => {
    // 只看"行 id / provider 配置"，不看注释：注释里会解释为什么删
    for (const marker of REMOVED_HOST_ROWS) {
      expect(patchText).not.toMatch(new RegExp(`^\\s*- id: ${marker}\\s*$`, 'm'))
    }
    expect(patchText).not.toMatch(/^\s*provider: codex\s*$/m)
    expect(patchText).not.toMatch(/^\s*provider: claude-code\s*$/m)
  })

  it('没有 rc.2 已移除的 config 字段（backgroundMode；未知键会被静默合并、永不生效）', () => {
    // 只看 YAML 键（注释里会解释这个字段为什么被删）
    expect(patchText).not.toMatch(/^\s*backgroundMode\s*:/m)
  })

  it('plan-mode 文案是 rc.2 的版本（旧版"成功即退出"在审批被拒时语义不同）', () => {
    expect(patchText).toContain('Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode.')
  })

  it('预设引用的每个宿主包都在 peer 契约里（漏声明 = 契约与用法脱节）', () => {
    const peers = manifest.peerDependencies ?? {}
    // 行名可能是"包 + 子路径"（如 `@deepseek-ai/dsh-plugin-manager/tools`）；契约按包声明，比较裸包名
    const bare = (name: string) => name.split('/').slice(0, 2).join('/')
    const used = new Set(declaredNames().filter(name => name.startsWith('@deepseek-ai/')).map(bare))
    const missing = [...used].filter(name => peers[name] === undefined).map(name => `${name}（${lineOf(name)} 行附近）`)
    expect(missing, '在 cordis.patch.yml 里引用了但 package.json 没有 peer 声明').toEqual([])
  })

  it('peer 契约本身没有被放宽（rd.2 核过的范围，含新增的 3 行）', () => {
    const peers = manifest.peerDependencies ?? {}
    const entries = Object.entries(peers)
    expect(entries).toHaveLength(36)
    for (const [name, range] of entries) {
      if (name === '@deepseek-ai/cordis') {
        expect(range, `${name} 的范围`).toBe('~4.0.4')
        continue
      }
      expect(name.startsWith('@deepseek-ai/dsh'), `${name} 不是 dsh-* 包`).toBe(true)
      expect(range, `${name} 的范围`).toBe('^0.2.1-rc.3')
    }
    // 预设里引用到的都是"可选"（缺任何一个只让那一行不激活，OMB 自身模块照常工作）
    for (const name of ['@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-plugin-market']) {
      expect(manifest.peerDependenciesMeta?.[name]?.optional, `${name} 应标 optional`).toBe(true)
    }
  })
})
