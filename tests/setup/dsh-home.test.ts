/**
 * "测试隔离真的生效了吗"——这条用例存在的唯一目的。
 *
 * ## 为什么"有 setup 文件"不等于"隔离生效"
 *
 * 这正是本项目的第一条测试原则（`docs/parallel-work.md` §十：**存在 ≠ 生效**）：
 * `setupFiles` 配错路径、配置没被 vitest 读到、或哪天有人删了 `vitest.config.ts`，
 * 隔离都会**静默失效**——而失效的后果不是红，是"少数用例悄悄读开发者的真实
 * `~/.dsh/...`"，一旦那份状态文件是 fail-closed 粘性，它们会**无故变红**。
 *
 * 所以这里断言的是**效果**（DSH_HOME 真的被指到临时目录），不是"文件存在"。
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('测试隔离：$DSH_HOME 指向本次运行的临时目录', () => {
  it('setup 生效：落在系统临时目录下，且**不是**真实的 ~/.dsh', () => {
    const home = process.env['DSH_HOME']
    expect(home, '$DSH_HOME 必须由 tests/setup/dsh-home.ts 设置（没设置=setup 没生效）').toBeDefined()
    expect(home ?? '').toContain('omb-test-dsh-')
    expect(home).not.toBe(join(homedir(), '.dsh'))
  })

  it('那个目录真的被建出来了（不是设了个不存在的路径）', () => {
    const home = process.env['DSH_HOME'] ?? ''
    expect(home).not.toBe('')
    expect(existsSync(home)).toBe(true)
    expect(statSync(home).isDirectory()).toBe(true)
  })

  it('真实 home 不在这个路径里（防止把隔离写成了"指回真实目录"）', () => {
    const home = (process.env['DSH_HOME'] ?? '').replace(/\\/g, '/').toLowerCase()
    const real = join(homedir(), '.dsh').replace(/\\/g, '/').toLowerCase()
    expect(home.startsWith(real)).toBe(false)
  })
})
