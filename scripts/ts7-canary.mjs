/**
 * TypeScript 7 兼容性 canary。
 *
 * ## 为什么它不在主门禁里
 *
 * 宿主 DSH 自己用 `^6.0.3`。OMB 是**被 DSH 加载的插件**——让插件的类型检查器
 * 跑到宿主前面，会在宿主的 `.d.ts` 上引入未经核验的严格性差异。所以主门禁固定
 * 在 6.0.3（与宿主对齐），TS7 单独跑、单独看。
 *
 * ## 为什么仍要跑
 *
 * TS 7 已经是 `latest`（实测 `npm view typescript dist-tags` → `latest: 7.0.2`）。
 * "为 TS7 做准备"不能只写在文档里——**必须有一条会失败的命令**，否则等它成为
 * 唯一版本时才发现不兼容。
 *
 * ## 用法（两步，因为两个版本不能同时是"当前"）
 *
 * ```sh
 * # ① 先确认主版本干净（必须全绿，否则 TS7 的结果无法归因）
 * npx tsc --noEmit
 *
 * # ② 切到 7 再跑本脚本
 * pnpm add -D typescript@7 && node scripts/ts7-canary.mjs
 * pnpm add -D typescript@6.0.3    # 跑完切回
 * ```
 *
 * ## 退出码
 *
 * - `0` 兼容（TS7 下无类型错误）
 * - `1` 发现 TS7 下的类型错误（**这才是"要修的东西"**）
 * - `2` 环境问题（当前不是 TS7），**不算兼容性结论**
 *
 * ## 为什么必须区分"TS7 独有的错"与"仓库本来就有的错"
 *
 * 并行施工期间树经常是红的。若不区分，TS7 的 canary 会把**别人的在途错误**
 * 报成"TS7 不兼容"，于是这条命令很快就会被无视——那比没有它更坏。
 * 所以脚本**先要求你把主版本跑绿**，并在这里再确认一次当前装的是 TS7。
 */
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function run(args) {
  try {
    const out = execFileSync('npx', args, {
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

const versionResult = run(['tsc', '--version'])
const version = /Version\s+([\d.]+)/.exec(versionResult.out)?.[1] ?? null

console.log('=== TypeScript 7 canary ===')
console.log(`当前 tsc：${version ?? '未知'}`)

if (version === null) {
  console.error('\n环境问题：取不到 tsc 版本。先 `pnpm install`。')
  process.exit(2)
}

if (!version.startsWith('7.')) {
  console.error(
    `\n环境问题：当前是 ${version}，不是 7.x —— 这样跑出来的结果说明不了 TS7 的兼容性。\n`
    + '请先切版本：`pnpm add -D typescript@7`，跑完再 `pnpm add -D typescript@6.0.3`。',
  )
  process.exit(2)
}

console.log('\n--- TS7 下的类型检查 ---')
const result = run(['tsc', '--noEmit'])
const errors = result.out
  .split('\n')
  .map(line => line.trim())
  .filter(line => /error TS\d+/.test(line))
  .map(line => line.replace(/^\S*[\\/]/, ''))

if (errors.length === 0) {
  console.log('\nTS7 下无类型错误 —— 兼容。')
  process.exit(0)
}

console.log(`\n发现 ${String(errors.length)} 条类型错误：`)
for (const line of errors.slice(0, 40)) console.log(`  ${line}`)
if (errors.length > 40) console.log(`  …还有 ${String(errors.length - 40)} 条`)

console.log('\n处理原则：')
console.log('  · 先确认这些错在 TS 6.0.3 下**不存在**（否则它们是仓库本来就有的错，不是 TS7 的问题）')
console.log('  · 确认是 TS7 独有的 → 修代码，这才是"为 TS7 做准备"')
console.log('  · 来自宿主 .d.ts 的 → 记录，并考虑 skipLibCheck（当前已为 true）')
process.exit(1)
