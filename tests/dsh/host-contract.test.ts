/**
 * 护栏：与宿主的**版本契约**，以及提示里允许出现的插值变量。
 *
 * ## 为什么这两件事要放在同一条测试里
 *
 * 它们都是"**看起来声明了、实际什么都没约束**"的高发区：
 *
 *   ① **版本契约**。root `package.json` 用 33 条 `@deepseek-ai/*` peer 声明"在哪个宿主上
 *      核过"。但 DSH 的判定口径是 `semver.satisfies(runtime, range, { includePrerelease: true })`
 *      （`packages/boot/app-boot/src/plugin-compatibility.ts:52`，0.2.1-rc.2 实测）——
 *      在这个口径下 `^0.2.0-rc.2` **接受任何 0.2.x 预发布**，peer 清单本身并不 pin 版本。
 *      而它若真的不满足，失败方式是"bundle 被静默跳过、日志什么都不打"
 *      （同文件 `profile.ts:759-767` 把错误就地 `catch` 进 `skippedBundles`）。
 *      所以这里改用一条 `engines.dsh`：按 `plugin-compatibility.ts:57-61`，**一旦存在
 *      `engines.dsh` 就只用它、完全忽略 peer**，契约从 33 条收敛成一条、且不依赖 peer 逐个改名。
 *
 *   ② **提示插值变量**。DSH 的插值是**严格**的：段文本里任何 `{{x}}` 必须是已注册变量，
 *      否则抛 `unknown prompt variable` 并让**整轮运行失败**；变量已注册但值为 `undefined`
 *      同样抛（`packages/core/system-prompt/src/index.ts:365-372`）。宿主内置只注册
 *      `provider` / `model` 两个（`packages/core/agent-loop/src/index.ts:389-390`）。
 *      本仓库曾因 persona 里写 `{{cwd}}` 整轮失败——`cwd` 从来不是内置变量。
 *
 * 因此：**配置里出现任何新插值变量，必须在同一次改动里更新本文件的允许清单**，
 * 否则这条测试先红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `tests/dsh/` 下）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * DSH 0.2.1-rc.2 内置注册的提示变量（**只有两个**）。
 * 证据：<dsh-checkout>/packages/core/agent-loop/src/index.ts:389-390（`ctx.systemPrompt.variable(...)`）。
 * 插件可以自注册变量，但本仓库不注册（重名会抛 "already registered"），所以配置里只准用这两个。
 */
const HOST_PROMPT_VARIABLES = ['provider', 'model'] as const

/**
 * 核过的宿主线：`0.2.0-rc.2`（基线档核过）到 `0.2.1-rc.2`（本轮核过）。
 *
 * 上界写成 `<=0.2.1-rc.2` 而不是 `<0.3.0`：`0.2.1-rc.2` 是**最后一次实测核过的构建**，
 * 0.2.1 正式版与 0.2.2-* 都还没核过——DSH 的失败方式是"bundle 被静默跳过、日志什么都不打"
 * （`packages/boot/app-boot/src/profile.ts:759-767`），所以宁可拒绝也不静默接受未核验宿主。
 */
const VERIFIED_HOST_RANGE = '>=0.2.0-rc.2 <=0.2.1-rc.2'

interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
  readonly engines?: { dsh?: string }
  readonly dsh?: { bundle?: { patch?: string | readonly string[] } }
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Manifest

/** 逐行判定 YAML 注释（只剥行首 `#`；字符串里的 `#` 不剥，足够覆盖本仓库的 patch 文件）。 */
function interpolationVariablesOfYaml(relativePath: string): { where: string; name: string }[] {
  const found: { where: string; name: string }[] = []
  const lines = readFileSync(join(REPO_ROOT, relativePath), 'utf8').split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) return
    for (const match of line.matchAll(/\{\{\s*([A-Za-z0-9_]*)\s*\}\}/g)) {
      found.push({ where: `${relativePath}:${index + 1}`, name: match[1] ?? '' })
    }
  })
  return found
}

describe('宿主版本契约', () => {
  it('用一条 engines.dsh 表达核过的宿主范围（存在时 DSH 只用它、忽略全部 peer）', () => {
    expect(manifest.engines?.dsh).toBe(VERIFIED_HOST_RANGE)
  })

  it('peer 声明仍是"核过的宿主"清单，没有被悄悄放宽或膨胀', () => {
    const peers = manifest.peerDependencies ?? {}
    const entries = Object.entries(peers)
    // 0.2.1-rc.2 实测：35 个 dsh-* + 1 个 cordis（rc.2 对齐时补了 time-context / tool-schedule / plugin-market）；
    // `dsh-desktop-notify` 已整个移除（npm 上是另一个程序）
    expect(entries).toHaveLength(36)
    for (const [name, range] of entries) {
      if (name === '@deepseek-ai/cordis') {
        expect(range, `${name} 的范围`).toBe('~4.0.4')
        continue
      }
      expect(name.startsWith('@deepseek-ai/dsh'), `${name} 不是 dsh-* 包`).toBe(true)
      expect(range, `${name} 的范围`).toBe('^0.2.0-rc.2')
    }
    expect(peers['dsh-desktop-notify'], 'dsh-desktop-notify 在 npm 上是被抢注的另一个程序，不能回到 peer').toBeUndefined()
  })

  it('装配入口仍然经 dsh.bundle.patch 声明（DSH 只按 package.json 找 patch，不 import 装配包）', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('依赖清单里没有 @omb/privacy（3.6.0 已把隐私并入记忆库；加回来会让 profile bundle 解析失败）', () => {
    const dependencies = manifest.dependencies ?? {}
    expect(dependencies['@omb/privacy']).toBeUndefined()
  })
})

describe('提示插值变量', () => {
  const patch = manifest.dsh?.bundle?.patch
  const patchFiles = (Array.isArray(patch) ? patch : [patch]).filter((file): file is string => typeof file === 'string')

  it('cordis.patch.yml 被真的扫到了（否则这条护栏是空转的）', () => {
    expect(patchFiles.length).toBeGreaterThan(0)
    const variables = patchFiles.flatMap(file => interpolationVariablesOfYaml(file))
    // 当前唯一真插值是 persona prefix 的 {{model}}；扫描器必须确实看到它
    expect(variables.length).toBeGreaterThan(0)
  })

  it('配置里的每个 {{变量}} 都是宿主内置注册的两个之一', () => {
    const offenders = patchFiles
      .flatMap(file => interpolationVariablesOfYaml(file))
      .filter(({ name }) => !HOST_PROMPT_VARIABLES.includes(name as (typeof HOST_PROMPT_VARIABLES)[number]))
    expect(offenders, '未注册的插值变量会让整轮运行失败（{{cwd}} 已踩过一次）').toEqual([])
  })

  it('注释里写 {{cwd}} 不算违规（解释"为什么不能加"正是那段注释的价值）', () => {
    const variables = interpolationVariablesOfYaml('cordis.patch.yml')
    // 反例样本在注释里；这一条同时证明上面的扫描器只认非注释行
    const names = variables.map(item => item.name)
    expect(names).not.toContain('cwd')
  })
})
