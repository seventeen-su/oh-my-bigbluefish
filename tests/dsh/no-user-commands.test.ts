/**
 * v4.20.0：启动时不再注册 OMB 用户命令。
 *
 * 用户要求"删除所有用户命令并把能力并入前端"：`/omb-depth`、`/omb-heap`、
 * `/omb-confirm`、`/omb-feedback`、`/omb-privacy`、`/omb-privacy-clean` 的注册调用
 * 必须从装配层消失，文件保留（能力仍被前端端点复用）。这里用源码断言钉住
 * **装配层没有注册调用**，避免只删界面不删接线。
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pluginSource = readFileSync(new URL('../../dsh/plugin.ts', import.meta.url), 'utf8')
const memoryIndexSource = readFileSync(new URL('../../modules/memory/index.ts', import.meta.url), 'utf8')
const privacyIndexSource = readFileSync(new URL('../../modules/memory/privacy/index.ts', import.meta.url), 'utf8')

describe('启动不再注册 OMB 用户命令（v4.20.0）', () => {
  it('dsh/plugin.ts 不再注册 /omb-depth、/omb-heap', () => {
    expect(pluginSource).not.toMatch(/registerDepthCommand\s*\(/)
    expect(pluginSource).not.toMatch(/registerHeapCommand\s*\(/)
    expect(pluginSource).not.toMatch(/from '\.\/depth-command\.js'/)
    expect(pluginSource).not.toMatch(/from '\.\/heap-command\.js'/)
  })

  it('memory/index.ts 不再注册 /omb-confirm、/omb-feedback', () => {
    expect(memoryIndexSource).not.toMatch(/installConfirm\s*\(/)
    expect(memoryIndexSource).not.toMatch(/installFeedback\s*\(/)
  })

  it('privacy/index.ts 不再注册 /omb-privacy、/omb-privacy-clean', () => {
    expect(privacyIndexSource).not.toMatch(/commands\.register\s*\(/)
    expect(privacyIndexSource).not.toMatch(/runPrivacyCommand\s*\(/)
    expect(privacyIndexSource).not.toMatch(/runPrivacyCleanCommand\s*\(/)
    expect(privacyIndexSource).toContain('已删除（v4.20')
  })

  it('命令实现文件保留（能力由前端端点复用）', () => {
    for (const file of ['depth-command.ts', 'heap-command.ts']) {
      expect(existsSync(new URL(`../../dsh/${file}`, import.meta.url))).toBe(true)
    }
    for (const file of ['confirm.ts', 'feedback.ts']) {
      expect(existsSync(new URL(`../../modules/memory/${file}`, import.meta.url))).toBe(true)
    }
    expect(existsSync(new URL('../../modules/memory/privacy/command.ts', import.meta.url))).toBe(true)
  })
})

