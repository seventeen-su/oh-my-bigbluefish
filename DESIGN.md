# OMB 设置 — DESIGN.md（v4.18.0）

> 设计意图文档。先有本文件的断言，再有 `packages/memory/client.js` 的样式。
> 每个数值后面写“因为 X，所以 Y”，换一个页面也能复用同一条因果。

---
name: omb-settings
surface: DSH Web 侧边栏主面板（可变宽 360–1200+ px）
audience: 普通用户（不是开发者）；同时是 OMB 自己的管理入口
---

## 1. 颜色与角色（只用 DSH 主题 token，不新增色值）

| 角色 | token | 为什么 |
| --- | --- | --- |
| 页面底 | `--dsw-alias-bg-layer-1` | 面板与宿主会话区同层，切过来不会“突然变白/变黑” |
| 区段/卡片表面 | `--dsw-alias-bg-layer-2` | 与 DSH 设置页同一表面层级；靠**层级差**分开，不靠边框 |
| 组内嵌表面 | `--dsw-alias-bg-layer-3` | 卡内再分组时给一级更浅/更深的表面，避免“卡片里再画一个同色边框” |
| 主文本 | `--dsw-alias-label-primary` | 正文/标题 |
| 次文本 | `--dsw-alias-label-secondary` | 说明、值 |
| 弱文本 | `--dsw-alias-label-tertiary` | 标签、时间、辅助 |
| 选中填充 | `--dsw-specific-sidebar-nav-item-active` | 导航/选中行用**填充**表达选中；不用蓝色描边 |
| 悬停填充 | `--dsw-specific-sidebar-nav-item-hover` | 指针反馈 |
| 危险 | `--dsw-alias-state-error-primary` | 仅错误/危险确认 |
| 警告 | `--dsw-alias-state-warn-primary` | 仅风险/待处理 |

**禁止**：自定义十六进制色、`rgb()`、`hsl()`、蓝色描边、`border-color: business`。
**焦点环**：只允许出现在 `:focus-visible`，颜色 `--dsw-focus-ring-color`，宽度 2px，
offset 1px；鼠标点击不出现环。primitive 自带焦点环的不再覆盖。

## 2. 字体与语义 role

| role | 字号/行高 | 字重 | 用途 |
| --- | --- | --- | --- |
| display | 20 / 28 | 600 | 面板标题（唯一） |
| title | 15 / 22 | 600 | 当前页标题 |
| section | 13 / 20 | 600 | 区段标题 |
| body | 14 / 22 | 400 | 记忆正文、画像文本 |
| control | 13 / 20 | 500 | 导航、按钮、行标题 |
| meta | 12 / 18 | 400 | 时间、来源、标签、说明 |

- 一页 ≤5 档字号；标题/正文比 ≥1.25。
- 字重只用 400/500/600；中文标题行高 = 22/28 的整数倍。
- 正文限宽：记忆正文 `max-width: 68ch` 可用；中文卡片不超过容器。
- 中文换行：`line-break: strict; word-break: normal; overflow-wrap: anywhere;`
  （长 id/路径才允许任意断行）。禁止 `word-break: break-all`。

## 3. 间距、圆角、阴影比例尺

- 间距（px）：`4 / 8 / 12 / 16 / 24 / 32`。组内间距 8，组间 24；卡片 padding 16；
  工具栏行高 36；导航单元格 40。
- 圆角：`--dsw-radius-md`（12）用于行/按钮底座，`--dsw-radius-lg`（16）用于卡片/面板；
  **不出现未引用 token 的圆角**（圆点/头像例外）。
- 阴影：卡片的层级由**表面 + 阴影**表达。注意 DSH 亮色主题的 `bg-layer-1/2/3`
  可能同色（`design-platform.css` 亮色三者都是 neutral-bluish-00），所以**不能只靠底色差**：
  - 二级卡（导航轨、内容卡）：`bg-layer-2` + `--dsw-elevation-panel`（带 0.5px 描边与柔和阴影），
    **不要只留一个框、也不要干脆没有框**；
  - 三级卡（详情、组内卡片、空态、通知）：`bg-layer-3` + `--dsw-elevation-soft`；
  - 0.5px 发丝线只用于区段分隔或列表行之间的分界，不用于卡片外框。

## 3.1 滚动条（用户第 14 点）

- 子页内部（`.omb-scroll` / `.omb-list` / `.omb-detail` / `.omb-nav`）隐藏滚动条：
  `scrollbar-width: none` + `::-webkit-scrollbar { width:0; height:0 }`；
- 滚动能力不删：滚轮、触控、键盘仍可操作页面；页面整体不出现额外滚动条。

## 4. 布局概念与线框

一句话：**左侧圆角导航卡 + 右侧圆角内容卡，内容卡内是可滚动的三级表面；任何宽度下
都保持“卡内不换行错位、卡对齐”**。

```
┌ page (layer-1) ────────────────────────────────────────────────┐
│ ┌ header (无卡，title+status) ─────────────────────────────┐  │
│ │ OMB 设置                                   [状态 ●]      │  │
│ └──────────────────────────────────────────────────────────┘  │
│ ┌ nav (layer-2, r16) ┐ ┌ content (layer-2, r16) ─────────────┐ │
│ │ 概览               │ │ 页标题（title）+ 一句说明             │ │
│ │ 记忆               │ │ ┌ 区段 (layer-3, r16) ─────────────┐ │ │
│ │ 项目               │ │ │ 卡片 1        │ 卡片 2            │ │ │
│ │ 个人画像           │ │ │ 卡片 3        │ 卡片 4            │ │ │
│ │                    │ │ └─────────────────────────────────┘ │ │
│ │                    │ │ 列表 / 详情（宽容器并排）             │ │
│ └────────────────────┘ └──────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

- 对齐轴：标题左缘、卡片左缘、列表左缘三条共享线；卡片右缘与内容卡内边距对齐。
- 卡片网格：**2 列**（≥720px）/1 列（窄），`repeat(2, minmax(0,1fr))`，`align-items:stretch`；
  必要时 4 个卡片 = 2×2，**不允许 flex-wrap 产生 3+1 孤行**。
- 工具条：`flex-wrap` + 一致的 `gap`；搜索框 `flex:1 1 220px`；控件不拉伸变形；
  换行后整行左对齐，最后一颗按钮不单独悬在右侧。
- 详情：宽容器列表 1fr + 详情 1.1fr（详情打开时）；未选中详情**收起为 0 宽**，
  不留下空卡片/边框；窄容器详情为覆盖在列表上的滑入卡（同 r16），有关闭按钮。
- 导航与内容**都**是 layer-2 圆角卡（用户要求 12：要么都卡片，要么都不要）；
  两者同 radius、同 padding 节奏、同 elevation token。

## 5. 控件样式矩阵（最终态，逐控件锁定）

| 控件 | 表面 | 边框 | 文本/图标 | 悬停 | 选中/激活 | 焦点 | 禁用 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 二级导航单元格 | 透明 | 无 | control / primary | hover 填充 | 选中填充（`nav-item-active`），无描边 | focus-visible 2px ring | opacity .5 |
| 列表行 | layer-3 或透明 | 无（行间 0.5px 分隔线） | body / primary | hover 填充（`interactive-bg-hover`） | 选中填充（`nav-item-active`），无描边 | focus-visible ring | — |
| Button primary | `--dsw-alias-button-primary-fill` | 无 | foreground | `button-primary-hover` | 按下 `button-primary-active` | primitive 自带 | 原生 disabled 透明度 |
| Button outline | 透明 | 0.5px `border-l3` | primary | `interactive-bg-hover` | `interactive-bg-active` | primitive | — |
| Button ghost | 透明 | 无 | primary | `interactive-bg-hover` | `interactive-bg-active` | primitive | — |
| Input | 原生 primitive | primitive | primary | — | — | primitive | 原生 |
| Pill | `bg-layer-2` | 无 | secondary | hover 填充 | 选中 `button-ghost-active-fill` + 1px inset ghost 边框（primitive） | primitive | — |
| Tag | 透明 | 0.5px 按 tone | tone 色 | — | 只读 | — | — |
| SegmentedControl | primitive 底 | primitive | primary | primitive | primitive 滑块 | primitive | 原生 |
| StateDot | 语义色点 | — | 配文字 | — | — | — | — |
| Modal | layer-2 + prominent elevation | 无 | — | — | — | primitive 焦点陷阱 | — |
| DisclosureRow | 透明 | 无 | 次级→次级悬停 | 文本变色 | 展开 chevron | — | — |
| Toast | primitive | — | — | — | — | — | — |

**自定义元素只允许**：导航单元格、列表行、卡片的**表面/间距**；其余全部用 primitive，
不覆盖其边框/圆角/颜色/焦点。列表行和导航单元格**都用填充表达状态**，没有蓝色边框。

## 6. 文本选择策略（用户第 11 点）

- `user-select: none`：导航、按钮、页头/标题、卡片标签、Tag/Pill、工具栏、时间/来源等
  元信息、空态标题、Modal 标题/按钮。
- `user-select: text`：记忆正文、记忆 id、路径（cwd/root/文件）、审计条目、画像文本、
  错误详情、输入框（原生可选中）、代码样式 `omb-code`。
- 目的：界面骨架不抢选择，内容随时可复制；不给整页加 `user-select:none`。

## 7. 动效清单（用户第 9 点）

| 场景 | 属性 | 时长/曲线 | 传达 |
| --- | --- | --- | --- |
| 页面切换 | opacity + translateY(4px) | 180ms `cubic-bezier(.4,0,.2,1)` | 视图替换 |
| 刷新 | 图标 360° 旋转（loading 时） | 900ms linear 循环 | 正在读取 |
| 详情展开/收起 | flex-basis/transform/opacity | 220ms / 180ms | 层级与状态转移 |
| 行/导航 hover | background-color | 120ms | 指针反馈 |
| 输入/按钮按下 | primitive 自带 | 100ms | 反馈 |
| Toast/Modal | primitive 自带 | — | 状态 |

- 只用 transform/opacity 做移动；为动布局（flex-basis）明确付出每帧一次布局的代价，
  仅限 220ms 的详情栏。
- `prefers-reduced-motion: reduce`：取消位移/旋转/宽度过渡，保留颜色与状态；不写
  `transition: none` 给需要 `transitionend` 的 primitive（本页没有自己的 transitionend 状态机）。
- 禁止 `transition: all`、>500ms 的界面过渡、常驻 `will-change`。

## 8. 文案规则（用户第 10 点）

- 页头：标题 + ≤1 句短语（≤20 汉字）；不出现“页面只读/写操作只有你点击的按钮/
  二级侧边栏/宽窗口详情”等实现说明。
- 运行/开发信息：折叠进“说明”（DisclosureRow）或 tooltip；保留事实但用用户语言。
- 状态文案给结论，不暴露内部枚举：`记忆库就绪`、`已归档`、`等待确认`。
- 空态：一句可执行建议；错误：发生了什么 + 可以怎么做。
- 禁止把 API、端点、扫描行数、内部机制放进主视线。

## 9. 三档自由度（从 brief 推出）

- `DESIGN_VARIANCE = 3`（信任优先/工具型；结构对称、无装饰性错位）；
- `MOTION_INTENSITY = 4`（有反馈、不表演；切换/展开/刷新三类）；
- `VISUAL_DENSITY = 4`（设置面板：中等密度，卡片留白 16）。
- **覆盖路径**：若未来用于品牌展示或 onboarding，可把 VARIANCE 提到 6、MOTION 提到 6；
  数据密集的会话表可把 DENSITY 提到 6，但必须保留 2×2 卡片对齐规则。

## 10. 反事实自检

| 触发变量 | 若换 brief 落点是否相同 | 本次改动 | 为什么 |
| --- | --- | --- | --- |
| 受众：开发者 → 普通用户 | 文案/密度会变 | 页头只留一句短语；技术细节折叠 | 用户不需要理解实现 |
| 内容：记忆列表 → 会话列表 | 表面/控件可复用 | 列表行 + 详情/会话卡两种内容都沿用行/卡 | 结构按内容，装饰不新增 |
| 品牌：无品牌 → 有品牌 | 色值会变 | 只用主题 token，不写死色 | 换主题/品牌时无需改组件 |

## 11. 有意省略

- 不使用图表/迷你折线（数据量小，文字更准确）。
- 不使用渐变/玻璃拟态（设置面板需要稳定对比）。
- 不用“卡片外框 + 阴影”双强调；层级只由表面差 + 单一阴影表达。
