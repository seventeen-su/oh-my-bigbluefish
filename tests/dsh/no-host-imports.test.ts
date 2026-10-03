/**
 * 护栏：本仓库**不得** import 宿主的包。
 *
 * ## 为什么需要一条测试来钉住一件"本来就没发生"的事
 *
 * `dsh/plugin.ts` 顶部写着"本文件不 import 任何 `@deepseek-ai/*`"。这句话原先附带的
 * 理由是"**本仓库解析不到它们**"——而那个理由是**物理事实**，不是纪律：
 * 解析不到，自然写不出 import。
 *
 * 2026-10-01 实测发现这个事实已经不成立：pnpm 的 `auto-install-peers` 默认会把整套
 * 宿主依赖树装进 `node_modules`（`.pnpm` 里 `0.1.7-rc.2` 与 `0.2.0-rc.2` 两代并存）。
 * 于是"零 import"从**不可能**变成了**靠自觉**——而自觉会随下一次重构蒸发，
 * 症状是"某天开始用一个可能过期的宿主副本"，且不会有任何报错。
 *
 * 现在两道防线：
 *   ① `.npmrc` 关掉自动装 peer（让"解析不到"重新成立）；
 *   ② 本文件——**物理事实可以被配置改掉，纪律只能用会失败的断言守住**。
 *
 * 顺带钉住 `dsh-desktop-notify`：那个名字在 npm 上已被他人占用，拉进来的是**另一个程序**。
 * 本插件与真正的通知插件之间是**结构探测**关系（`modules/notify/bridge.ts` 的
 * `isDesktopNotifyLike`），不是依赖关系，所以源码里也不该出现对它的 import。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `tests/dsh/` 下）。与仓库其余测试同一写法：`import.meta.url`。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 受检查的源码目录。**不含** `lib-gen`（构建产物）与 `node_modules`。 */
const SOURCE_DIRS = ['dsh', 'modules', 'kernel', 'packages', 'scripts'] as const

/** 受检查的扩展名。`.mjs` 也算——脚本同样不该拉宿主包。 */
const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js'] as const

/** 禁止出现的模块说明符前缀/精确名。 */
const FORBIDDEN: readonly { readonly label: string; readonly test: (spec: string) => boolean }[] = [
  { label: '@deepseek-ai/*（宿主的包）', test: spec => spec === '@deepseek-ai' || spec.startsWith('@deepseek-ai/') },
  { label: 'dsh-desktop-notify（npm 上是被抢注的另一个程序）', test: spec => spec === 'dsh-desktop-notify' || spec.startsWith('dsh-desktop-notify/') },
  { label: '@deepseek-ai/cordis*（同上，属宿主）', test: spec => spec.startsWith('@deepseek-ai/cordis') },
]

/** 递归收集受检查的文件（绝对路径）。 */
function collect(dir: string, into: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return into
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'lib-gen' || name === '.git') continue
    const full = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      collect(full, into)
      continue
    }
    if (EXTENSIONS.some(ext => name.endsWith(ext))) into.push(full)
  }
  return into
}

/**
 * 抽取源码里出现的模块说明符。
 *
 * 只认真正会触发解析的三种写法：静态 `from '…'`、动态 `import('…')`、`require('…')`。
 * **注释里提到包名不算**——本仓库的大量注释正是在解释"为什么不用宿主的包"，
 * 把它们也算成违规，等于逼着后来人删掉解释。
 * 因此这里先剥掉注释，再抽取。
 */
function specifiersOf(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const found: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of withoutLineComments.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1])
    }
  }
  return found
}

describe('宿主包护栏', () => {
  const files = SOURCE_DIRS.flatMap(dir => collect(join(REPO_ROOT, dir)))

  it('受检查的文件确实被扫到了（否则这条护栏是空转的）', () => {
    // "扫到 0 个文件"与"没有任何违规"必须能分辨——否则目录改名会让护栏静默失效
    expect(files.length).toBeGreaterThan(50)
  })

  it('源码里没有任何对宿主包的 import', () => {
    const offences: string[] = []
    for (const file of files) {
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const spec of specifiersOf(source)) {
        const hit = FORBIDDEN.find(rule => rule.test(spec))
        if (hit !== undefined) offences.push(`${relative(REPO_ROOT, file)} → ${spec}（${hit.label}）`)
      }
    }
    expect(offences, '本仓库经结构化接口访问宿主，不得 import 宿主的包').toEqual([])
  })

  it('注释里提到宿主包名**不算**违规（解释"为什么不用"正是这些注释的价值）', () => {
    // 反向断言：证明上面的抽取器真的剥了注释。没有这一条，
    // 一个"把什么都当违规"的抽取器也能让上一条通过。
    const sample = "// import x from '@deepseek-ai/dsh-tools'\n/* from 'dsh-desktop-notify' */\nconst a = 1\n"
    expect(specifiersOf(sample)).toEqual([])
    expect(specifiersOf("import x from '@deepseek-ai/dsh-tools'\n")).toEqual(['@deepseek-ai/dsh-tools'])
  })
})
