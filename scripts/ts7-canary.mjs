/**
 * TypeScript 7 兼容性 canary。
 *
 * ## 为什么主版本停在 6，而这里单独跑 7
 *
 * 宿主 DSH 自己用 `^6.0.3`。OMB 是**被 DSH 加载的插件**——让插件的类型检查器
 * 跑到宿主前面，会在宿主的 `.d.ts` 上引入未经核验的严格性差异。所以主门禁固定
 * 在 6.0.3（与宿主对齐），TS7 单独跑、单独看。
 *
 * ## 为什么仍要跑（TS7 已经是 `latest`）
 *
 * 实测 `npm view typescript dist-tags` → `latest: 7.0.2`。TS7 不是"将来"，是**现在**。
 * "为 TS7 做准备"不能只写在文档里——**必须有一条会失败的命令**，
 * 否则等它成为唯一版本时才发现不兼容。
 *
 * ## 它会自动找 TS7，不需要切换当前版本
 *
 * pnpm 的虚拟 store 里可以**同时**存在 `typescript@7.0.2` 与 `typescript@6.0.3`
 * （`pnpm add -D typescript@7` 之后再 `pnpm add -D typescript@6.0.3` 即可，两者都留在
 * store 里）。本脚本直接用 TS7 的 bin 跑，所以 `pnpm typecheck` 与
 * `pnpm typecheck:ts7` 在**同一次安装状态下都能跑通**。
 *
 * 2026-09-30 实测：TS 7.0.2 下全仓 **0 错误**——所以"为 TS7 做准备"不只是准备，
 * 代码库当下就兼容。这条命令的价值是**让这个事实持续可验证**。
 *
 * ## 退出码
 *
 * - `0` 兼容（TS7 下无类型错误）
 * - `1` 发现 TS7 下的类型错误（**这才是"要修的东西"**）
 * - `2` 环境问题（找不到 TS7），**不算兼容性结论**
 *
 * ## 为什么必须先报一遍主门禁
 *
 * 并行施工期间树经常是红的。若不区分，canary 会把**在途错误**报成"TS7 不兼容"，
 * 于是这条命令很快会被无视——那比没有它更坏。所以先打对照，再判 TS7。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function run(command, args) {
  try {
    const out = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    return { code: 0, out }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      out: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }
  }
}

/** 在 pnpm 虚拟 store 里找 TS7 的 bin（不要求它是"当前"版本）。 */
function findTs7Bin() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  if (!existsSync(store)) return null
  const candidates = readdirSync(store)
    .filter(name => /^typescript@7\./.test(name))
    .sort()
    .reverse()
  for (const dir of candidates) {
    const pkg = join(store, dir, 'node_modules', 'typescript')
    const bin = join(pkg, 'bin', 'tsc')
    if (!existsSync(bin)) continue
    const version = /"version"\s*:\s*"([^"]+)"/.exec(readFileSync(join(pkg, 'package.json'), 'utf8'))?.[1]
    return { bin, version: version ?? dir }
  }
  return null
}

/** 从 tsc 输出里抽错误行（去掉绝对路径前缀，便于阅读）。 */
function errorsOf(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /error TS\d+/.test(line))
    .map(line => line.replace(/^\S*[\\/]/, ''))
}

console.log('=== TypeScript 7 canary ===')

const ts6Version = /Version\s+([\d.]+)/.exec(run('npx', ['tsc', '--version']).out)?.[1] ?? '未知'
console.log(`主门禁 tsc：${ts6Version}`)

const ts7 = findTs7Bin()
if (ts7 === null) {
  console.error(
    '\n环境问题：在 node_modules/.pnpm 里找不到 typescript@7.x —— 这样跑说明不了 TS7 的兼容性。\n'
    + '装一次即可（跑完切回 6，两个版本会都留在 store 里）：\n'
    + '  pnpm add -D typescript@7 && pnpm add -D typescript@6.0.3',
  )
  process.exit(2)
}
console.log(`TS7 二进制：${ts7.version}（来自 pnpm store，与主门禁并存）`)

console.log('\n--- 主门禁（对照）---')
const baseErrors = errorsOf(run('npx', ['tsc', '--noEmit']).out)
console.log(baseErrors.length === 0 ? '干净' : `${String(baseErrors.length)} 条错误`)

console.log('\n--- TS7 ---')
const errors = errorsOf(run('node', [ts7.bin, '--noEmit']).out)

if (errors.length === 0) {
  console.log('TS7 下无类型错误 —— 兼容。')
  if (baseErrors.length > 0) console.log('（注意：主门禁仍有错误——那与 TS7 无关，先修它们。）')
  process.exit(0)
}

console.log(`发现 ${String(errors.length)} 条类型错误：`)
for (const line of errors.slice(0, 40)) console.log(`  ${line}`)
if (errors.length > 40) console.log(`  …还有 ${String(errors.length - 40)} 条`)

console.log('\n处理原则：')
console.log('  · 先与上面的"主门禁（对照）"比对：两边都有 → 仓库本来就有的错，不是 TS7 的问题')
console.log('  · TS7 独有 → 修代码，这才是"为 TS7 做准备"')
console.log('  · 来自宿主 .d.ts 的 → 记录，并考虑 skipLibCheck（当前已为 true）')
process.exit(1)
