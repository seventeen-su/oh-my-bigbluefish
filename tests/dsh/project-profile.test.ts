/**
 * 项目画像端口的行为测试（v4.1 §3.2）。
 *
 * 重点不是"文本好看"，而是四条契约：
 * ① 有 package.json/README/目录时能产出可用画像，且文本与结构化层同源；
 * ② 构建发生在**项目根**：子目录 cwd → root 一致、cwdRel 记录"我在哪"；
 * ③ 缓存生效，`refresh()` 才能看到变化；确定性（同树同输出）；
 * ④ 非目录/读失败/卸载后一律返回 undefined，**绝不抛**。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProjectProfile } from '../../dsh/project-profile.js'
import { PROFILE_TEXT_MAX } from '../../dsh/project-profile.js'

const dirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omb-project-profile-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'demo-project',
    version: '1.2.3',
    description: 'a demo workspace',
    scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .', dev: 'vite' },
    dependencies: { zod: '^4' },
    devDependencies: { vitest: '^3', typescript: '^6' },
  }))
  writeFileSync(join(dir, 'README.md'), '# Demo Project\n\nThis project demonstrates the profile builder.\n')
  writeFileSync(join(dir, 'tsconfig.json'), '{}')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  return dir
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omb-project-repo-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'repo-demo',
    version: '0.1.0',
    description: 'a repo used by profile tests',
    scripts: { build: 'tsc', test: 'vitest run', dev: 'vite' },
    dependencies: { zod: '^4' },
    devDependencies: { vitest: '^3' },
  }))
  writeFileSync(join(root, 'README.md'), '# Repo Demo\n\nA repo for the profile.\n')
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  writeFileSync(join(root, 'AGENTS.md'), '# Agent rules\n\nbe careful\n')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), "import { helper } from '../lib/helper'\nexport const alpha = 1\nexport const beta = 2\n")
  writeFileSync(join(root, 'src', 'deep', 'util.ts'), '// util\n')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'helper.ts'), 'export function helper(): void {}\n')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'index.test.ts'), 'it("x", () => {})\n')
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide Title\n\nbody\n')
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(root, 'sub', 'deep', 'note.md'), '# note\n')
  return root
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言
      }
    }
  }
})

describe('项目画像', () => {
  it('产出项目名/版本/命令/README/顶层信息', () => {
    const dir = makeProject()
    const now = 1_000
    const { port, dispose } = createProjectProfile({ clock: { now: () => now } })
    const profile = port.read(dir)
    expect(profile).toBeDefined()
    expect(profile?.text).toContain('demo-project v1.2.3')
    expect(profile?.text).toContain('test=vitest run')
    expect(profile?.text).toContain('README：Demo Project')
    expect(profile?.generatedAt).toBe(now)
    dispose()
  })

  it('缓存生效；refresh() 后才看到变化', async () => {
    const dir = makeProject()
    let now = 2_000
    const { port, dispose } = createProjectProfile({ clock: { now: () => now }, ttlMs: 60_000 })
    const first = port.read(dir)
    expect(first?.text).toContain('a demo workspace')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'demo-project',
      version: '2.0.0',
      description: 'changed description',
      scripts: { test: 'vitest run' },
    }))
    now += 1_000
    const cached = port.read(dir)
    expect(cached?.text, 'TTL 内必须命中缓存').toContain('a demo workspace')
    expect(cached?.text).not.toContain('changed description')

    const refreshed = await port.refresh(dir)
    expect(refreshed?.text).toContain('changed description')
    expect(refreshed?.text).toContain('demo-project v2.0.0')
    dispose()
  })

  it('非目录 / 不存在路径 / 卸载后都返回 undefined，不抛', () => {
    const dir = makeProject()
    const { port, dispose } = createProjectProfile({ clock: { now: () => 1 } })
    expect(port.read(join(dir, 'does-not-exist'))).toBeUndefined()
    expect(port.read(join(dir, 'package.json'))).toBeUndefined()
    dispose()
    expect(port.read(dir)).toBeUndefined()
  })

  it('子目录 cwd：构建在项目根，cwdRel 记录"我在哪"，结构层与文本同源', () => {
    const root = makeRepo()
    const cwd = join(root, 'sub', 'deep')
    const { port, dispose } = createProjectProfile({ clock: { now: () => 100 }, rootOf: () => root })
    const view = port.read(cwd)
    expect(view).toBeDefined()
    expect(view?.root).toBe(resolve(root))
    expect(view?.cwdRel).toBe('sub/deep')
    expect(view?.identity?.name).toBe('repo-demo')
    expect(view?.identity?.version).toBe('0.1.0')
    expect(view?.gates?.map(gate => gate.name)).toEqual(['build', 'test'])

    const src = view?.structure?.sources?.find(source => source.dir === 'src')
    expect(src, 'src 目录必须被统计到').toBeDefined()
    expect(src?.files).toBe(2)
    expect(src?.lines).toBe(4)
    expect(src?.tests).toBe(0)
    // v4.2 符号层：从 `export const a/b` 识别出代表符号（正则，不是语言服务）。
    expect(src?.symbols).toContain('alpha')
    expect(src?.symbols).toContain('beta')
    expect(src?.exports).toBeGreaterThanOrEqual(2)
    // v4.3 依赖层：src/index.ts 的 `../lib/helper` 解析为仓库内文件 → 跨目录边。
    expect(view?.structure?.imports).toEqual([{ from: 'src', to: 'lib', count: 1 }])
    const tests = view?.structure?.sources?.find(source => source.dir === 'tests')
    expect(tests?.tests).toBe(1)

    expect(view?.structure?.docs?.[0]?.path).toBe('docs/guide.md')
    expect(view?.structure?.docs?.[0]?.title).toBe('Guide Title')
    expect(view?.structure?.entries).toContain('package.json')
    expect(view?.structure?.entries).toContain('AGENTS.md')
    expect(view?.structure?.entries).toContain('src/index.ts')

    expect(view?.text).toContain('cwd 相对：sub/deep')
    expect(view?.text).toContain('源码：')
    expect(view?.text).toContain('docs/guide.md「Guide Title」')
    expect(view?.text.length ?? 0).toBeLessThanOrEqual(PROFILE_TEXT_MAX)
    dispose()
  })

  it('从项目根调用：cwdRel 为空串，文本写"仓库根"', () => {
    const root = makeRepo()
    const { port, dispose } = createProjectProfile({ clock: { now: () => 1 }, rootOf: () => root })
    const view = port.read(root)
    expect(view?.root).toBe(resolve(root))
    expect(view?.cwdRel).toBe('')
    expect(view?.text).toContain('cwd 相对：仓库根')
    dispose()
  })

  it('确定性：同一棵树两次重建产出同一份结构/身份/文本', async () => {
    const root = makeRepo()
    let now = 7
    const { port, dispose } = createProjectProfile({ clock: { now: () => now }, rootOf: () => root })
    const first = await port.refresh(root)
    now = 9
    const second = await port.refresh(root)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(JSON.stringify(second?.structure)).toBe(JSON.stringify(first?.structure))
    expect(JSON.stringify(second?.identity)).toBe(JSON.stringify(first?.identity))
    expect(JSON.stringify(second?.gates)).toBe(JSON.stringify(first?.gates))
    expect(second?.text).toBe(first?.text)
    expect(second?.generatedAt).toBe(9)
    dispose()
  })

  it('有界扫描：达到文件上限时如实标注，不假装"这就是全部"', () => {
    const root = makeRepo()
    const { port, dispose } = createProjectProfile({
      clock: { now: () => 1 },
      rootOf: () => root,
      maxFiles: 3,
    })
    const view = port.read(root)
    expect(view).toBeDefined()
    expect(view?.text).toContain('结构扫描已达上限 3 文件')
    expect(view?.text.length ?? 0).toBeLessThanOrEqual(PROFILE_TEXT_MAX)
    dispose()
  })
})

/** v4.4：带 tsconfig 路径别名的仓库（src/app.ts 通过 `@lib/*` 导入并调用）。 */
function makeAliasRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'omb-project-alias-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'alias-demo', version: '0.1.0' }))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } },
  }))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'helper.ts'), 'export function helper(): number { return 1 }\n')
  writeFileSync(
    join(root, 'src', 'app.ts'),
    "import { helper } from '@lib/helper'\nexport const value = helper()\n",
  )
  return root
}

describe('v4.4 导入图升级', () => {
  it('tsconfig 别名解析：目录边 + 文件边 + 近似调用边', () => {
    const root = makeAliasRepo()
    const { port, dispose } = createProjectProfile({ clock: { now: () => 1 }, rootOf: () => root })
    const view = port.read(root)
    expect(view).toBeDefined()
    expect(view?.structure?.aliases?.[0]).toContain('@lib/*')
    expect(view?.structure?.imports).toContainEqual({ from: 'src', to: 'lib', count: 1 })
    expect(view?.structure?.fileImports).toContainEqual({
      from: 'src/app.ts',
      to: 'lib/helper.ts',
      count: 1,
    })
    expect(view?.structure?.calls).toContainEqual({
      caller: 'src/app.ts',
      callee: 'lib/helper.ts',
      symbol: 'helper',
      count: 1,
    })
    dispose()
  })
})
