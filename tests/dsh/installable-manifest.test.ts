/**
 * 护栏：**可安装性**——发布出去的 `@omb/plugin` 能不能被别的 DSH profile 用 pnpm 装上。
 *
 * ## 为什么这条必须存在
 *
 * 2026-10-25 实测：根 `package.json` 把 7 个组件写成 `dependencies` 里的
 * `workspace:*`。`workspace:` 协议**只在 OMB 自己的 pnpm workspace 内**可解析；
 * 当 `@omb/plugin` 被当成 `file:`/git 依赖装进一个普通 DSH profile 时，pnpm 解析
 * 插件的 dependencies 会直接抛：
 *
 * ```
 * ERR_PNPM_WORKSPACE_PKG_NOT_FOUND In : "@omb/artifact@workspace:*" is in the
 * dependencies but no package named "@omb/artifact" is present in the workspace
 * This error happened while installing the dependencies of @omb/plugin@4.22.0
 * ```
 *
 * 而 DSH 的插件管理器每次装/卸/切换都会重跑 `pnpm install`，于是**该 profile 的
 * 所有插件操作一起失败**。复现与修法（7 个组件移到 `devDependencies`）见
 * `docs/v4.22.1-host-rc3-and-install-fix.md`。
 *
 * 本文件钉住的就是"发布依赖里不许出现 workspace:/link: 协议，组件只许在
 * devDependencies 里"，以及部署副本解析组件行所依赖的 `packages/` 必须随包发布。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 仓库根（本文件在 `tests/dsh/` 下）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 组件包清单：与 `kernel/display.ts` 的包名一一对应（少一个 = 7 行解析不到）。 */
const COMPONENT_PACKAGES = [
  '@omb/artifact',
  '@omb/kernel',
  '@omb/memory',
  '@omb/memory-vector',
  '@omb/notify',
  '@omb/profile',
  '@omb/reasoning',
] as const

interface Manifest {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly files?: readonly string[]
}

function readManifest(relative: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as Manifest
}

/** 会被 pnpm 在**消费方**安装的依赖段（devDependencies 不在其中）。 */
const INSTALLED_FIELDS = ['dependencies', 'optionalDependencies'] as const

function installedEntries(manifest: Manifest): [string, string][] {
  return INSTALLED_FIELDS.flatMap(field => Object.entries(manifest[field] ?? {}))
}

/** 仓库里所有会随包发布的 manifest（根 + 7 个组件）。 */
function shippedManifests(): { relative: string; manifest: Manifest }[] {
  const relative = ['package.json']
  for (const dir of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (dir.isDirectory()) relative.push(join('packages', dir.name, 'package.json'))
  }
  return relative.filter(file => existsSync(join(REPO_ROOT, file))).map(file => ({ relative: file, manifest: readManifest(file) }))
}

const root = readManifest('package.json')

describe('发布依赖：workspace: 协议只许留在 devDependencies', () => {
  it('根 dependencies / optionalDependencies 里没有任何 workspace: 或 link: 协议', () => {
    const offenders = installedEntries(root)
      .filter(([, spec]) => spec.startsWith('workspace:') || spec.startsWith('link:'))
      .map(([name, spec]) => `${name}: ${spec}`)
    expect(offenders, '这两个协议在消费方的 pnpm 里解析不到，会拖垮整个 profile 的插件操作').toEqual([])
  })

  it('根 dependencies 里没有任何 @omb/* 组件（组件不是发布依赖）', () => {
    const offenders = Object.keys(root.dependencies ?? {}).filter(name => name.startsWith('@omb/'))
    expect(offenders, '组件只能放 devDependencies；放进 dependencies 会让外部 profile 的 pnpm 直接失败').toEqual([])
  })

  it('7 个组件都在 devDependencies 里写 workspace:*（仓库内与部署副本的解析来源）', () => {
    const devDeps = root.devDependencies ?? {}
    const missing = COMPONENT_PACKAGES.filter(name => devDeps[name] !== 'workspace:*')
    expect(missing).toEqual([])
  })

  it('每个随包发布的 manifest 的安装依赖段都没有 workspace:/link:（组件包自己的依赖也查）', () => {
    const offenders = shippedManifests().flatMap(({ relative, manifest }) =>
      installedEntries(manifest)
        .filter(([, spec]) => spec.startsWith('workspace:') || spec.startsWith('link:'))
        .map(([name, spec]) => `${relative}: ${name}@${spec}`))
    expect(offenders, '消费方 pnpm 只认 registry / file: / git 这几类可解析的 specifier').toEqual([])
  })

  it('组件包目录与包名一一对应（部署副本按裸包名解析它们）', () => {
    for (const name of COMPONENT_PACKAGES) {
      const dir = name.slice('@omb/'.length)
      const manifest = readManifest(join('packages', dir, 'package.json'))
      expect(manifest.name, `packages/${dir}/package.json 的 name`).toBe(name)
    }
  })

  it('发布文件清单包含 packages/ 与 cordis.patch.yml（否则装上后没有组件行可解析）', () => {
    expect(root.files ?? []).toContain('packages')
    expect(root.files ?? []).toContain('cordis.patch.yml')
  })
})
