/**
 * 项目画像端口的行为测试。
 *
 * 重点不是"文本好看"，而是三条契约：
 * ① 有 package.json/README/目录时能产出可用画像；
 * ② 缓存生效，`refresh()` 才能看到变化；
 * ③ 非目录/读失败/卸载后一律返回 undefined，**绝不抛**。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectProfile } from '../../dsh/project-profile.js'

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
})
