/**
 * OMB 设置 bundle 的发布契约（v4.18.0）。
 *
 * 防部署漂移 + 钉住用户这轮明确要求的界面事实：
 * 四页二级侧边栏、二级/三级卡片、锁定控件、隐藏子页滚动条、文本选择策略、
 * 手动记忆增删改标记、项目页（会话目录/归档/深度/隐私）、个人画像页、短文案。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const PKG = join(ROOT, 'packages', 'memory')
const CLIENT = join(PKG, 'client.js')

function source(): string {
  return readFileSync(CLIENT, 'utf8')
}

describe('OMB 设置 bundle 发布契约', () => {
  it('package.json 声明 dsh.client 且 ./client 导出指向真实文件', () => {
    const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { client?: { platform?: string; immediately?: boolean; inject?: string[] } }
      exports?: Record<string, string>
    }
    expect(manifest.name).toBe('@omb/memory')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.immediately).toBe(true)
    expect(manifest.exports?.['./client']).toBe('./client.js')
    expect(existsSync(CLIENT)).toBe(true)
  })

  it('client.js 用 __ModuleLoader__ 注册、两个入口与全部端点', () => {
    const code = source()
    expect(code).toContain('window.__ModuleLoader__.load')
    expect(code).toContain("id: '@omb/memory'")
    expect(code).toContain("ctx.slots.inject('main'")
    expect(code).toContain("ctx.slots.inject('sidebar.panellist'")
    expect(code).toContain("post('/memory'")
    expect(code).toContain("post('/privacy'")
    expect(code).toContain("post('/resolve'")
    for (const path of ["api('/overview')", "api('/list'", "api('/detail'", "api('/sessions')", "api('/personal')", "api('/profile'"]) {
      expect(code).toContain(path)
    }
  })

  it('标题与四个页面（合并后的信息架构）', () => {
    const code = source()
    expect(code).toContain("'OMB 设置'")
    expect(code).not.toContain('OMB 记忆')
    for (const label of ['概览', '记忆', '项目', '个人画像']) {
      expect(code).toContain(`label: '${label}'`)
    }
    // 合并后的旧页签不再作为主导航
    expect(code).not.toContain("label: '候选确认'")
    expect(code).not.toContain("label: '会话隐私'")
    expect(code).not.toContain("label: '运行状态'")
    expect(code).not.toContain("label: '项目画像'")
    expect(code).not.toContain('SegmentedTabs')
  })

  it('二级侧边栏 + 二级/三级卡片：有表面与阴影，不是“只剩框”', () => {
    const code = source()
    expect(code).toContain("className: 'omb-nav'")
    expect(code).toContain("className: 'omb-content'")
    expect(code).toContain('var(--dsw-elevation-panel)')
    expect(code).toContain('var(--dsw-elevation-soft)')
    expect(code).toContain('var(--dsw-alias-bg-layer-2)')
    expect(code).toContain('var(--dsw-alias-bg-layer-3)')
    expect(code).toContain('border-radius: var(--dsw-radius-lg)')
    const card = /\.omb-card \{([\s\S]*?)\}/.exec(code)
    expect(card).not.toBeNull()
    const cardBody = card?.[1] ?? ''
    expect(cardBody).not.toContain('border:')
    expect(cardBody).not.toContain('border-color')
  })

  it('控件锁定：选中用填充、焦点环只在 focus-visible、禁止蓝色描边', () => {
    const code = source()
    expect(code).toContain('var(--dsw-specific-sidebar-nav-item-active)')
    expect(code).toContain('var(--dsw-specific-sidebar-nav-item-hover)')
    expect(code).toContain(':focus-visible')
    expect(code).toContain('var(--dsw-focus-ring-color')
    expect(code).not.toContain('border-color: var(--dsw-alias-state-business-primary)')
    expect(code).not.toMatch(/outline:\s*[^;]*\bblue\b/i)
  })

  it('排版比例尺、弹性对齐与容器查询', () => {
    const code = source()
    expect(code).toContain('container-type: inline-size')
    expect(code).toContain('@container omb-panel (min-width: 600px)')
    expect(code).toContain('@container omb-panel (min-width: 820px)')
    expect(code).toContain('repeat(2, minmax(0, 1fr))')
    expect(code).toContain('repeat(4, minmax(0, 1fr))')
    expect(code).toContain('font-size: 20px')
    expect(code).toContain('font-size: 15px')
    expect(code).toContain('font-size: 13px')
    expect(code).toContain('line-height: 22px')
    expect(code).toContain('padding: 16px')
  })

  it('文本选择策略与子页滚动条隐藏', () => {
    const code = source()
    expect(code).toContain('user-select: none')
    expect(code).toContain('user-select: text')
    expect(code).toContain("className: 'omb-selectable'")
    expect(code).toContain('scrollbar-width: none')
    expect(code).toContain('::-webkit-scrollbar')
    expect(code).toContain('.omb-scroll, .omb-list, .omb-detail, .omb-nav')
  })

  it('动效：方向感子页浮动、详情、刷新、减弱动效', () => {
    const code = source()
    expect(code).toContain('@keyframes omb-slide-forward')
    expect(code).toContain('@keyframes omb-slide-back')
    expect(code).toContain("direction > 0 ? 'omb-page-forward' : 'omb-page-back'")
    expect(code).toContain('@keyframes omb-spin')
    expect(code).toContain("className: loading ? 'omb-spin'")
    expect(code).toContain('flex-basis 220ms var(--ds-ease-in-out')
    expect(code).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('手动记忆操作：新建/编辑/删除/标记都在前端可达', () => {
    const code = source()
    expect(code).toContain("action: 'create'")
    expect(code).toContain("action: 'update'")
    expect(code).toContain("action: 'delete'")
    expect(code).toContain("action: 'mark'")
    for (const mark of ["mark: 'confirm'", "mark: 'obsolete'", "mark: 'revive'"]) {
      expect(code).toContain(mark)
    }
    expect(code).toContain("offset: page * PAGE_SIZE")
    expect(code).toContain("'上一页'")
    expect(code).toContain("'下一页'")
    expect(code).toContain('h(MemoryForm')
    expect(code).toContain('新建')
  })

  it('项目页：会话目录、归档灰色不可读、深度与隐私；个人画像页', () => {
    const code = source()
    expect(code).toContain('已归档会话不可读')
    expect(code).toContain("'data-disabled': isArchived")
    expect(code).toContain('depthText')
    expect(code).toContain('隐私模式')
    expect(code).toContain('工作区画像')
    expect(code).toContain('个人画像')
    expect(code).toContain("api('/personal')")
  })

  it('面向用户的短文案（不把实现说明塞进主视线）', () => {
    const code = source()
    for (const banned of ['页面只读', '宽窗口详情', '写操作只有你点击的按钮', '扫描上限']) {
      expect(code).not.toContain(banned)
    }
    expect(code).toContain("'记忆与运行状态'")
    expect(code).toContain("'搜索、编辑与确认记忆'")
    expect(code).toContain('记忆库就绪')
  })

  it('共享控件与主题 token；无十六进制色值', () => {
    const code = source()
    expect(code).toContain("require('@deepseek-ai/dsh-client-ui-primitives')")
    for (const name of ['Button', 'Input', 'Pill', 'Tag', 'SegmentedControl', 'StateDot', 'Modal', 'TextShimmer', 'DisclosureRow']) {
      expect(code).toMatch(new RegExp(`\\b${name}\\b`))
    }
    expect(code).toContain('var(--dsw-alias-label-primary)')
    expect(code).toContain('var(--dsw-alias-label-tertiary)')
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('未选中条目时不请求详情（HTTP 400 missing id 回归）', () => {
    const code = source()
    expect(code).toContain("if (typeof id !== 'string' || id.length === 0)")
    expect(code).toContain('选一条记忆查看详情。')
  })
})
