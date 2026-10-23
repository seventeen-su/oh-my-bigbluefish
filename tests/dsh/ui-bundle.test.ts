/**
 * 侧边栏 bundle 的发布契约（v4.15.4）：清单、导出与文件必须一致。
 *
 * 这些断言防的是**部署漂移**：`dsh.client` 指向的 `./client` 必须在 exports 里、
 * 文件必须真的存在、bundle 必须用宿主模块加载器注册。任何一项漂移，
 * 宿主启动时要么 loud fail（缺文件），要么页面静默没有入口（id/导出不匹配）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const PKG = join(ROOT, 'packages', 'memory')
const CLIENT = join(PKG, 'client.js')

describe('侧边栏 bundle 发布契约', () => {
  it('package.json 声明 dsh.client 且 ./client 导出指向真实文件', () => {
    const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { client?: { platform?: string; immediately?: boolean; inject?: string[] } }
      exports?: Record<string, string>
    }
    expect(manifest.name).toBe('@omb/memory')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.immediately).toBe(true)
    expect(Array.isArray(manifest.dsh?.client?.inject)).toBe(true)
    expect(manifest.exports?.['./client']).toBe('./client.js')
    expect(existsSync(CLIENT)).toBe(true)
  })

  it('client.js 用 __ModuleLoader__ 注册且 id 等于包名', () => {
    const source = readFileSync(CLIENT, 'utf8')
    expect(source).toContain('window.__ModuleLoader__.load')
    expect(source).toContain("id: '@omb/memory'")
    // 两个入口：主面板 + 侧边栏图标
    expect(source).toContain("ctx.slots.inject('main'")
    expect(source).toContain("ctx.slots.inject('sidebar.panellist'")
    // 写动作只打 /omb/api 的 confirm/resolve（没有别的写端点）
    expect(source).toContain("run('/confirm'")
    expect(source).toContain("run('/resolve'")
  })

  it('UI 复用共享控件与主题 token（不自己造控件、不写死颜色）', () => {
    const source = readFileSync(CLIENT, 'utf8')
    // 标准控件来自基线共享模块（PLATFORM_MODULES 已 seed，客户端 bundle 可直接 require）
    expect(source).toContain("require('@deepseek-ai/dsh-client-ui-primitives')")
    for (const name of ['Button', 'Input', 'Pill', 'Tag', 'SegmentedTabs', 'SegmentedControl', 'StateDot']) {
      expect(source).toMatch(new RegExp(`\\b${name}\\b`))
    }
    // 颜色/圆角走 --dsw-* 语义 token
    expect(source).toContain('var(--dsw-alias-label-primary)')
    expect(source).toContain('var(--dsw-alias-border-l2)')
    expect(source).toContain('var(--dsw-radius-lg)')
    // 不写死色值（主题切换由 ui-theme 负责）
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('未选中条目时不请求详情（HTTP 400 missing id 回归）', () => {
    const source = readFileSync(CLIENT, 'utf8')
    // Detail 的 effect 必须先判空再 fetch；否则挂载即打 /detail 无 id → 400。
    expect(source).toContain("if (typeof id !== 'string' || id.length === 0)")
    expect(source).toContain("从左侧选择一条记忆查看详情、审计与相关条目。")
  })
})
