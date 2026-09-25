/**
 * 构建产物加载冒烟。
 *
 * **为什么必须单独测一遍 `lib/`**：源码级测试跑在 Vite/esbuild 下，
 * 而插件在生产里由**宿主 Node 进程**直接 import `lib/` 的产物。两者不等价——
 * 本项目已经因此栽过一次：`import.meta.glob` 是 Vite 专有构造，`tsc` 不转换它，
 * 源码测试全绿而编译产物在 Node 下直接抛 `TypeError`，插件根本装不上。
 *
 * 因此这里对**编译产物**做三件事：
 * ① 能 import（无 Vite 专有语法残留、无未解析的宿主包）
 * ② `apply` 能在没有真宿主的情况下跑完（fake ctx），模块全部装配、工具面齐全
 * ③ 卸载不抛
 *
 * 前置：`pnpm build` 必须已跑过。产物缺失时本文件整体 skip 并说明原因，
 * 而不是给一个看不懂的 import 失败。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 产物目录由 `scripts/build.mjs` **换代**写入（`lib-gen/g1` → `g2` → …）。
 * 这里从代数文件读当前代数——不能写死目录名，否则换代后本冒烟会静默跳过。
 */
function currentOutDir(): string | undefined {
  try {
    const raw = readFileSync(new URL('../../build-generation.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { outDir?: unknown }
    return typeof parsed.outDir === 'string' ? parsed.outDir : undefined
  } catch {
    return undefined
  }
}

/** 产物根目录。**断言非空**：进入本文件的前提是产物存在（否则整体 skip）。 */
function requireOutDir(): string {
  const dir = currentOutDir()
  if (dir === undefined) throw new Error('build-generation.json 缺失或损坏——先跑 node scripts/build.mjs')
  return fileURLToPath(new URL(`../../${dir}/`, import.meta.url))
}

const outDir = currentOutDir()
const libKernel = outDir === undefined ? undefined : fileURLToPath(new URL(`../../${outDir}/dsh/kernel.js`, import.meta.url))
const built = libKernel !== undefined && existsSync(libKernel)

/** fake 宿主：只提供 `apply` 真正会读的东西，其余一律缺失（走降级路径）。 */
function fakeHost(): {
  ctx: Record<string, unknown>
  registered: { tools: string[]; contexts: { name: string; order: number }[] }
} {
  const registered = { tools: [] as string[], contexts: [] as { name: string; order: number }[] }
  const ctx: Record<string, unknown> = {
    get: (name: string) => {
      if (name === 'tools') {
        return {
          register: (definition: unknown) => {
            registered.tools.push((definition as { name: string }).name)
            return () => {}
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          context: (entry: { name: string; order: number }) => {
            registered.contexts.push({ name: entry.name, order: entry.order })
            return () => {}
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  }
  return { ctx, registered }
}

describe.skipIf(!built)('构建产物加载冒烟（换代产物）', () => {
  it('产物里没有 Vite 专有语法残留（import.meta.glob 曾让插件装不上）', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8')
          // 只看**真正的调用**（`import.meta.glob(`），不看注释或字符串里提到的字样——
          // 说明性注释（"不要用 import.meta.glob"）是文档，不是残留。
          // 同时剥掉行注释后再判，避免误报。
          const code = text
            .split('\n')
            .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
            .join('\n')
          if (/import\.meta\.glob\s*\(/.test(code)) offenders.push(full.replace(requireOutDir(), ''))
        }
      }
    }
    walk(requireOutDir())
    expect(offenders, `产物里仍有 import.meta.glob 调用：${offenders.join(', ')}`).toEqual([])
  })

  it('产物不 import 任何 @deepseek-ai/* 包（宿主包在本仓库不可解析）', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8')
          // 只看真正的 import/export from 语句，不看注释与字符串
          if (/^\s*(import|export)[^\n]*from\s*['"]@deepseek-ai\//m.test(text)) {
            offenders.push(full.replace(requireOutDir(), ''))
          }
        }
      }
    }
    walk(requireOutDir())
    expect(offenders, `产物 import 了宿主包：${offenders.join(', ')}`).toEqual([])
  })

  it('入口能被 apply：模块全部装配、工具面齐全、卸载不抛', async () => {
    const entry = (await import(libKernel as string)) as {
      apply(ctx: unknown, config?: unknown): () => void
      name: string
      inject: readonly string[]
    }
    expect(entry.name).toBe('omb')
    expect(entry.inject).toContain('commands')

    const { ctx, registered } = fakeHost()
    const dispose = entry.apply(ctx, {})
    expect(typeof dispose).toBe('function')

    // 工具面：内核自带 + 各模块声明的（缺宿主端口时模块会降级，但工具应注册）
    expect(registered.tools).toContain('omb_status')
    // 提示注入：一个 order 200 的 omb:cognitive 段
    expect(registered.contexts).toContainEqual({ name: 'omb:cognitive', order: 200 })

    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow() // 幂等
  })
})

describe.skipIf(built)('构建产物加载冒烟（lib/）', () => {
  it('产物不存在——先跑 pnpm build', () => {
    expect(built, `未找到 ${libKernel}，请先执行 pnpm build 再跑本条冒烟`).toBe(true)
  })
})
