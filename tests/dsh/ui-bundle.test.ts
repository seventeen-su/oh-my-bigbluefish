/**
 * 侧边栏 bundle 的发布契约（v4.17.0）：清单、导出与文件必须一致。
 *
 * 这些断言防的是**部署漂移**：`dsh.client` 指向的 `./client` 必须在 exports 里、
 * 文件必须真的存在、bundle 必须用宿主模块加载器注册。任何一项漂移，
 * 宿主启动时要么 loud fail（缺文件），要么页面静默没有入口（id/导出不匹配）。
 *
 * v4.17.0 的界面契约（用户六点要求的可核对形式）：
 * - 标题是「OMB 设置」，不是「OMB 记忆」；
 * - 主导航是**二级侧边栏**（`omb-nav` + `aria-current`），不是顶部页签
 *   （`SegmentedTabs` 不再用于主导航）；
 * - 响应式 + 弹性：容器查询 `@container omb-panel`、`minmax(0, …)`、
 *   窄容器收成图标轨；宽容器列表/详情并排；
 * - 详情栏在未选中条目时收起（`data-detail='closed'` + `inert`），选中时展开；
 * - 动效走 `--ds-ease-in-out`，并在 `prefers-reduced-motion: reduce` 下取消；
 * - 新增「会话隐私」页与 `POST /privacy`（用户点击才发）。
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
    const code = source()
    expect(code).toContain('window.__ModuleLoader__.load')
    expect(code).toContain("id: '@omb/memory'")
    // 两个入口：主面板 + 侧边栏图标
    expect(code).toContain("ctx.slots.inject('main'")
    expect(code).toContain("ctx.slots.inject('sidebar.panellist'")
    // 写动作只打 /omb/api 的 confirm/resolve/privacy（没有别的写端点）
    expect(code).toContain("run('/confirm'")
    expect(code).toContain("run('/resolve'")
    expect(code).toContain("post('/privacy'")
  })

  it('标题是「OMB 设置」且页面名称随标题（不是 OMB 记忆）', () => {
    const code = source()
    expect(code).toContain("'OMB 设置'")
    expect(code).not.toContain('OMB 记忆')
    expect(code).toContain('label: () => TITLE')
  })

  it('主导航是二级侧边栏而非顶部菜单栏', () => {
    const code = source()
    // 二级侧边栏：左导航轨 + aria-current 的导航单元
    expect(code).toContain("className: 'omb-nav'")
    expect(code).toContain("aria-label': `${TITLE}导航`")
    expect(code).toContain("aria-current': page === entry.value ? 'page' : undefined")
    // 六个页签都在导航轨里
    for (const label of ['概览', '记忆库', '候选确认', '会话隐私', '运行状态', '项目画像']) {
      expect(code).toContain(`label: '${label}'`)
    }
    // 顶部页签组件不再用于主导航（用户要求的“二级侧边栏而非顶部菜单栏”）
    expect(code).not.toContain('SegmentedTabs')
  })

  it('响应式与弹性排版：容器查询 + minmax + 窄容器图标轨', () => {
    const code = source()
    expect(code).toContain('container-type: inline-size')
    expect(code).toContain('@container omb-panel (min-width: 720px)')
    expect(code).toContain('@container omb-panel (min-width: 900px)')
    expect(code).toContain('repeat(auto-fit, minmax(min(180px, 100%), 1fr))')
    expect(code).toContain('flex: 1 1 auto')
    expect(code).toContain('min-width: 0')
    // 窄容器导航收成图标轨（标签隐藏，宽度 46px）
    expect(code).toContain('.omb-nav {')
    expect(code).toContain('width: 46px')
    expect(code).toContain('.omb-nav-label {')
    expect(code).toContain('display: none')
    // 指针粗（触屏）时放大点击目标
    expect(code).toContain('@media (pointer: coarse)')
  })

  it('详情栏：未选中时收起（inert），选中时展开，动效可减弱', () => {
    const code = source()
    // 状态由 data-detail 驱动：closed 时不占宽度、不可聚焦
    expect(code).toContain("'data-detail': open ? 'open' : 'closed'")
    expect(code).toContain("'aria-hidden': open ? undefined : true")
    expect(code).toContain('inert: open ? undefined : true')
    // 宽容器：flex-basis 过渡；窄容器：transform 滑入
    expect(code).toContain('transition:')
    expect(code).toContain('flex-basis 220ms var(--ds-ease-in-out')
    expect(code).toContain('transform: translateX(100%)')
    // 减弱动效：去掉运动但保留状态变化
    expect(code).toContain('@media (prefers-reduced-motion: reduce)')
    expect(code).toContain('transition: none')
  })

  it('UI 复用共享控件与主题 token（不自己造控件、不写死颜色）', () => {
    const code = source()
    // 标准控件来自基线共享模块（PLATFORM_MODULES 已 seed，客户端 bundle 可直接 require）
    expect(code).toContain("require('@deepseek-ai/dsh-client-ui-primitives')")
    for (const name of ['Button', 'Input', 'Pill', 'Tag', 'SegmentedControl', 'StateDot']) {
      expect(code).toMatch(new RegExp(`\\b${name}\\b`))
    }
    // 标准图标也来自同一共享模块
    for (const icon of ['IconShieldOutlineRegular', 'IconRefreshOutlineRegular', 'IconCloseOutlineRegular']) {
      expect(code).toContain(icon)
    }
    // 颜色/圆角/动效走 --dsw-* / --ds-* 语义 token
    expect(code).toContain('var(--dsw-alias-label-primary)')
    expect(code).toContain('var(--dsw-alias-border-l2)')
    expect(code).toContain('var(--dsw-radius-lg)')
    expect(code).toContain('var(--dsw-specific-sidebar-nav-item-active)')
    expect(code).toContain('var(--dsw-focus-ring-color')
    expect(code).toContain('var(--ds-ease-in-out')
    // 不写死色值（主题切换由 ui-theme 负责）
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('会话隐私页：基线/当前会话/显式设置/危险操作，动作只走 POST /privacy', () => {
    const code = source()
    expect(code).toContain("await api('/privacy')")
    expect(code).toContain("post('/privacy'")
    expect(code).toContain("action: 'set'")
    expect(code).toContain("action: 'clear'")
    // 危险动作经标准 Modal 二次确认后才发（不再用内联两段式按钮）
    expect(code).toContain("h(Modal, {")
    expect(code).toContain("'clear-inactive'")
    expect(code).toContain("'trust'")
    // 三档模式标签与“模型无入口”的说明
    expect(code).toContain('read-only')
    expect(code).toContain('sealed')
    expect(code).toContain('模型工具没有隐私入口')
  })

  it('界面精致度：品牌头、导航计数、快捷入口、标准模态与 shimmer 加载态', () => {
    const code = source()
    // 品牌头：图标块 + 标题 + 状态点
    expect(code).toContain("className: 'omb-brand'")
    expect(code).toContain("className: 'omb-brand-mark'")
    expect(code).toContain("className: 'omb-head-side'")
    // 导航计数只在宽容器显示
    expect(code).toContain("className: 'omb-nav-count'")
    expect(code).toContain('.omb-nav-count {')
    expect(code).toContain('display: inline-block')
    // 概览快捷入口（onNavigate）
    expect(code).toContain('onNavigate')
    expect(code).toContain("onClick: () => onNavigate('memory')")
    // 加载态用标准 TextShimmer（动画在减弱动效时由控件自身处理）
    expect(code).toContain('TextShimmer')
    expect(code).toContain("h(TextShimmer, { active: true }")
    // 空状态有标题 + 建议，不是一行冷冰冰的“没有”
    expect(code).toContain("className: 'omb-empty'")
    expect(code).toContain('没有匹配条目')
    // 每页有标题 + 一句话说明（图标轨收起文字时仍能看懂当前页）
    expect(code).toContain("className: 'omb-page-title'")
    expect(code).toContain("className: 'omb-page-desc'")
    expect(code).toContain('库就绪、计数与各库分布')
    // 卡片与设置页同源 token
    expect(code).toContain('var(--dsw-alias-settings-card-fill')
    expect(code).toContain('var(--dsw-alias-settings-card-stroke')
  })

  it('未选中条目时不请求详情（HTTP 400 missing id 回归）', () => {
    const code = source()
    // Detail 的 effect 必须先判空再 fetch；否则挂载即打 /detail 无 id → 400。
    expect(code).toContain("if (typeof id !== 'string' || id.length === 0)")
    expect(code).toContain('从左侧选择一条记忆查看详情、审计与相关条目。')
  })
})
