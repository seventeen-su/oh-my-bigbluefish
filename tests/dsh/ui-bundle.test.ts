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
    expect(source).toContain("post('/confirm'")
    expect(source).toContain("post('/resolve'")
  })
})
