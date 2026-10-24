// 大肥鱼增强（v4.20.0）——手写浏览器 bundle，不需要打包器。
//
// 设计约定（契约与理由见 DESIGN.md）：
// - 二级侧边栏导航 + 右侧内容，两者都是同 radius 的表面卡；页面底 layer-1；
// - 三级表面：导航/内容卡 layer-2，组内卡片 layer-3；不用“同底色 + 边框”；
// - 控件只用共享 primitives；只有导航/行/卡片三类自定义表面；
// - 选中用填充、不用蓝色描边；焦点环只出现在 :focus-visible；
// - 字号 20/15/13/14/12，间距 4/8/12/16/24，卡片 padding 16；
// - 页面 180ms、详情 220ms、hover 120ms；reduced-motion 取消运动；
// - 文本选择：界面骨架不可选，记忆正文/id/路径/画像/审计可选；
// - 面向用户的短文案，技术细节折叠进“说明”。
window.__ModuleLoader__.load({
  id: '@omb/memory',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Input, Modal, Tag, StateDot, TextShimmer, DisclosureRow, Toast,
      IconCheckOutlineRegular, IconChecklistOutlineRegular, IconChevronDownOutlineRegular,
      IconChevronUpOutlineRegular, IconCloseOutlineRegular,
      IconDatabaseOutlineRegular, IconEditOutlineRegular,
      IconPlusOutlineRegular, IconTrashOutlineRegular,
      IconUserOutlineRegular, IconWarningOutlineRegular, IconWorkspaceTreeOutlineRegular,
    } = primitives
    const h = React.createElement

    const PANEL_ID = 'omb-memory'
    const API = '/omb/api'
    const TITLE = '大肥鱼增强'

    const NAV = [
      { value: 'memory', label: '记忆', icon: IconDatabaseOutlineRegular },
      { value: 'project', label: '项目', icon: IconWorkspaceTreeOutlineRegular },
      { value: 'machines', label: '状态机', icon: IconChecklistOutlineRegular },
      { value: 'personal', label: '画像', icon: IconUserOutlineRegular },
    ]
    const PAGE_HINTS = {
      memory: '搜索、编辑与确认记忆',
      project: '按工作区展开会话',
      machines: '项目级跨会话与跨工作区状态',
      personal: '你的长期偏好与协作方式',
    }
    const SCOPES = [
      { value: 'all', label: '全部' },
      { value: 'user', label: '用户库' },
      { value: 'project', label: '项目库' },
    ]
    const STATUSES = [
      { value: 'active', label: '活跃' },
      { value: 'candidate', label: '待确认' },
      { value: 'stale', label: '已失效' },
      { value: 'all', label: '全部' },
    ]
    const KINDS = [
      { value: '', label: '全部' },
      { value: 'semantic', label: '语义' },
      { value: 'procedural', label: '流程' },
      { value: 'episodic', label: '事件' },
    ]
    const CREATABLE_KINDS = KINDS.filter((entry) => entry.value !== '')
    const MODE_TEXT = { normal: '可读写', 'read-only': '只读', sealed: '封存' }
    const MODE_OPTIONS = [
      { value: 'normal', label: '可读写' },
      { value: 'read-only', label: '只读' },
      { value: 'sealed', label: '封存' },
    ]
    const DEPTH_TEXT = { quick: '快速', standard: '标准', deep: '深入' }
    const ORIGIN_TEXT = { command: '手动设置', inherited: '继承', default: '默认', 'fail-closed': '兜底' }
    const AXIS_ORDER = ['stable', 'capability', 'intent', 'collaboration']
    const PAGE_SIZE = 30

    const CSS = `
      .omb-page {
        container-type: inline-size; container-name: omb-panel;
        display: flex; flex-direction: column; box-sizing: border-box;
        height: 100%; min-height: 0; min-width: 0; overflow: hidden;
        padding: 12px 16px; gap: 12px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-family, inherit);
        transition: none;
      }
      .omb-head {
        flex: none; display: flex; flex-wrap: wrap; align-items: center;
        justify-content: space-between; gap: 4px 16px; padding: 0 4px;
        user-select: none;
      }
      .omb-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
      .omb-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

      .omb-body {
        flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; gap: 0; overflow: hidden;
        background: #232324;
        border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
      }
      .omb-nav {
        position: relative;
        flex: none; width: 56px; box-sizing: border-box; padding: 6px;
        display: flex; flex-direction: column; gap: 4px; overflow-y: auto;
        background: transparent; border: none; border-right: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: 0;
        user-select: none;
        /* 不用 width/padding 过渡：容器宽度是宿主实时改的，过渡会"追"着指针走。 */
        transition: none;
      }
      /* 首次出现只做淡入：位置/高度先无过渡地就位，再打开滑动过渡。
         滑动过渡用**内联样式**给（见 MemoryPanel）：CSS 里任何后置规则（减弱动效等）
         都不应该把它覆盖掉；减弱动效在 JS 里显式判断。 */
      .omb-nav-indicator {
        position: absolute; left: 6px; right: 6px; top: 0; height: 0; z-index: 0;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-specific-sidebar-nav-item-active);
        pointer-events: none;
        transition: opacity 220ms var(--ds-ease-in-out, ease-out);
      }
      .omb-nav-indicator[data-ready='false'] { opacity: 0; }
      .omb-nav-cell {
        position: relative; z-index: 1;
        display: flex; align-items: center; gap: 10px; min-height: 40px; width: 100%;
        padding: 8px 9px; box-sizing: border-box;
        border: none; border-radius: var(--dsw-radius-md); background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 20px; font-weight: 500;
        text-align: left; cursor: pointer; justify-content: center;
        transition: background-color 120ms var(--ds-ease-in-out, ease-out), color 120ms var(--ds-ease-in-out, ease-out);
      }
      /* 0.2.1-rc.3 之后 DSH 移除了 --dsw-specific-sidebar-nav-item-hover，
         它自己的导航 hover 也改用 --dsw-alias-interactive-bg-hover（ui-settings-general 的 .navCell）。 */
      .omb-nav-cell:hover:not([aria-current='page']) { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-nav-cell:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .omb-nav-icon { flex: none; }
      .omb-nav-label { display: none; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

      .omb-content {
        flex: 1 1 auto; min-width: 0; min-height: 0; box-sizing: border-box; overflow: hidden;
        display: flex; flex-direction: column; gap: 12px; padding: 16px;
        background: transparent; border: none; border-radius: 0;
        transition: none;
      }
      .omb-content-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; min-width: 0; user-select: none; }
      .omb-content-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
      .omb-content-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-content-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
      .omb-page-in { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .omb-page-forward { animation: omb-slide-forward 220ms cubic-bezier(.22,.61,.36,1); }
      .omb-page-back { animation: omb-slide-back 220ms cubic-bezier(.22,.61,.36,1); }
      @keyframes omb-slide-forward {
        from { opacity: 0; transform: translateX(14px) scale(.995); }
        to { opacity: 1; transform: none; }
      }
      @keyframes omb-slide-back {
        from { opacity: 0; transform: translateX(-14px) scale(.995); }
        to { opacity: 1; transform: none; }
      }
      .omb-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; padding-right: 4px; }

      .omb-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .omb-stack { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .omb-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .omb-section-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; user-select: none; }
      .omb-grid { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .omb-grid > * { min-width: 0; }
      .omb-detail .omb-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .omb-card {
        display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 100%;
        padding: 16px; box-sizing: border-box; overflow-wrap: anywhere;
        background: var(--dsw-alias-settings-card-fill);
        border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-settings-card-stroke);
      }
      .omb-card-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-card-value { display: flex; align-items: center; gap: 6px; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
      /* 统计卡之后的说明文字：与网格拉开一段，别贴着 */
      .omb-grid + .omb-note { margin-top: 8px; }
      .omb-card-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .omb-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; max-width: 100%; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
      .omb-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
      .omb-code { font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px; user-select: text; }
      .omb-selectable { user-select: text; }
      .omb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-toolbar > * { flex: 0 1 auto; min-width: 0; }
      .omb-toolbar > .omb-search { flex: 1 1 220px; }
      /* 搜索框是**弹性填充**，不设上限：窄容器里让它自己收缩，而不是换行 */
      .omb-search { flex: 1 1 220px; min-width: 0; max-width: none; }
      .omb-select-field { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
      .omb-select-trigger {
        display: inline-flex; align-items: center; justify-content: space-between; gap: 6px;
        min-width: 96px; max-width: 190px; height: 32px; box-sizing: border-box;
        padding: 0 8px; border: none; border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap;
        cursor: pointer; transition: background-color 120ms var(--ds-ease-in-out, ease-out);
      }
      .omb-select-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-select-trigger:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .omb-select-trigger:disabled { opacity: 0.5; cursor: default; }
      .omb-select-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; }
      .omb-select-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
      /* 下拉浮层：仿 dsh-desktop-notify 的 SelectMenu —— 大圆角、玻璃透明、无边框，按触发按钮所在侧对齐 */
      .omb-select-menu {
        position: absolute; z-index: 120; top: calc(100% + 4px);
        box-sizing: border-box; min-width: 132px; max-width: 240px; max-height: 280px; overflow-y: auto;
        padding: 4px; display: flex; flex-direction: column; gap: 2px;
        border: none; border-radius: var(--dsw-radius-lg, 14px);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 74%, transparent);
        color: var(--dsw-alias-label-primary);
        backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);
        filter: drop-shadow(0 10px 22px rgb(0 0 0 / 28%));
        animation: omb-menu-in 130ms cubic-bezier(.2,.8,.2,1);
      }
      .omb-select-menu[data-align='left'] { left: 0; right: auto; }
      .omb-select-menu[data-align='right'] { right: 0; left: auto; }
      .omb-select-item {
        display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; flex: 0 0 auto;
        padding: 0 8px; box-sizing: border-box; border: none; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 18px;
        text-align: left; cursor: pointer; white-space: nowrap;
      }
      .omb-select-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-select-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
      .omb-select-item[aria-selected='true'] { background: var(--dsw-specific-sidebar-nav-item-active); }
      .omb-select-item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .omb-select-check { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
      @keyframes omb-menu-in {
        from { opacity: 0; transform: translateY(-2px) scale(.98); }
        to { opacity: 1; transform: none; }
      }
      .omb-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 18px 16px; background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-settings-card-stroke); user-select: none; }
      .omb-empty-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; }
      .omb-empty-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-loading { display: inline-flex; align-items: center; gap: 6px; }

      .omb-workspace { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
      .omb-list-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; transition: opacity 180ms var(--ds-ease-in-out, ease-out), transform 180ms var(--ds-ease-in-out, ease-out); }
      .omb-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px; }
      .omb-row {
        display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0;
        padding: 10px 12px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-settings-card-fill); color: inherit; font: inherit; text-align: left; cursor: pointer;
        transition: background-color 120ms var(--ds-ease-in-out, ease-out), border-color 120ms var(--ds-ease-in-out, ease-out);
      }
      .omb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-row[data-active='true'] { background: var(--dsw-specific-sidebar-nav-item-active); }
      .omb-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
      .omb-row[data-disabled='true'] { opacity: 0.5; cursor: default; }
      .omb-row-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .omb-row-text { margin: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; max-width: 100%; }
      .omb-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; max-width: 100%; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-row-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .omb-workspace-group { display: flex; flex-direction: column; gap: 4px; }
      .omb-workspace-sessions { display: flex; flex-direction: column; gap: 4px; margin-left: 10px; padding-left: 8px; border-left: 0.5px solid var(--dsw-alias-border-l2); }
      .omb-collapse {
        display: grid; grid-template-rows: 0fr;
        transition: grid-template-rows 200ms var(--ds-ease-in-out, ease-out), margin-top 200ms var(--ds-ease-in-out, ease-out);
      }
      /* 收起时高度为 0，但父容器的 flex gap 仍会留一份间距（看起来空白翻倍）：
         用等量负 margin 抵消那一份 gap；展开时 margin 回到 0。 */
      .omb-collapse[data-open='false'] { margin-top: -4px; }
      .omb-collapse[data-open='true'] { grid-template-rows: 1fr; }
      .omb-collapse > div { overflow: hidden; min-height: 0; }
      .omb-row-split { flex-direction: row; align-items: center; gap: 4px; padding: 0; }
      .omb-workspace-card { padding: 10px 12px; }
      .omb-workspace-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; text-align: left; }
      .omb-session-card { padding: 10px 12px; }
      .omb-session-main {
        flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px;
        text-align: left;
      }
      .omb-row-chevron {
        flex: none; display: inline-flex; align-items: center; justify-content: center;
        color: var(--dsw-alias-label-secondary); user-select: none;
      }
      /* 子会话组：与工作区组同一套缩进 + 左边框（v4.22.2） */
      .omb-session-children {
        display: flex; flex-direction: column; gap: 4px;
        margin-left: 10px; padding-left: 8px;
        border-left: 0.5px solid var(--dsw-alias-border-l2);
      }
      .omb-session-main:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .omb-chevron { display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); user-select: none; }

      .omb-detail-pane { position: absolute; inset: 0; z-index: 2; display: flex; min-width: 0; min-height: 0;
        transform: translateX(100%); opacity: 0; visibility: hidden;
        transition: transform 220ms var(--ds-ease-in-out, ease-out), opacity 180ms var(--ds-ease-in-out, ease-out), visibility 0s linear 220ms;
      }
      .omb-workspace[data-detail='open'] > .omb-detail-pane { transform: none; opacity: 1; visibility: visible; transition-delay: 0s; }
      .omb-detail { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
        padding: 16px; box-sizing: border-box; background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-md);
        border: 0.5px solid var(--dsw-alias-settings-card-stroke);
      }
      .omb-detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-detail-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; user-select: none; }
      .omb-detail-text { margin: 0; font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
      .omb-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .omb-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .omb-form { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .omb-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); user-select: none; }
      .omb-textarea {
        width: 100%; min-height: 108px; box-sizing: border-box; resize: vertical;
        padding: 8px; border: none; border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px;
        user-select: text; outline: none;
      }
      .omb-textarea:focus-visible { outline: none; }
      .omb-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .omb-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; box-sizing: border-box;
        background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-settings-card-stroke); user-select: none;
      }
      .omb-notice > .omb-note { color: var(--dsw-alias-label-secondary); }
      .omb-spin { animation: omb-spin 900ms linear infinite; }
      @keyframes omb-spin { to { transform: rotate(360deg); } }
      .omb-toolbar-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }

      /* 子页内不显示滚动条：滚动仍可用（滚轮/键盘/触控），视觉只留内容。 */
      .omb-scroll, .omb-list, .omb-detail, .omb-nav {
        scrollbar-width: none;
      }
      .omb-scroll::-webkit-scrollbar, .omb-list::-webkit-scrollbar,
      .omb-detail::-webkit-scrollbar, .omb-nav::-webkit-scrollbar { width: 0; height: 0; display: none; }

      @container omb-panel (min-width: 618px) {
        /* 只改内容内边距；「.omb-page」自己的 padding 变化会改变容器查询的 content box，
           在阈值附近形成 618↔620 的翻转死循环（712px 窗口抖动的根因）。 */
        .omb-content { padding: 20px; gap: 16px; }
      }
      @container omb-panel (min-width: 760px) {
        .omb-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
      /*
       * 二级侧栏的**唯一**尺寸切换点（v4.23.0 收尾）：
       *   · 容器 < 980px：56px 图标轨（标签不渲染，尺寸恒定）；
       *   · 容器 ≥ 980px：190px 带文字。
       * 以前在 617/760 两处各调一次宽度（56→52→190），窗口/面板拖动时会连续跳两次，
       * 看起来像"侧栏大小抖动"。现在只留一个断点，且远离开常见的 700–900px 区间。
       */
      @container omb-panel (min-width: 980px) {
        .omb-nav { width: 190px; padding: 10px 8px; }
        .omb-nav-indicator { left: 8px; right: 8px; }
        .omb-nav-label { display: block; }
        .omb-nav-cell { justify-content: flex-start; padding: 8px 9px; }
      }
      /*
       * 详情栏的两种形态（v4.22.2 重新划断点）：
       *   · 容器 ≥ 560px：列表 + 详情并排（详情宽度用 flex-basis 动画过渡）；
       *   · 容器 < 560px：详情覆盖列表，列表淡出 + 轻微左移（不再"瞬间消失"）。
       * 断点从 820 降到 560 的原因：820 落在常见窗口宽度里（宿主侧栏展开/收起会改变面板
       * 宽度），窗口拖动时会在"覆盖/并排"之间反复横跳；560 在常规宽度下不会被跨到。
       */
      @container omb-panel (min-width: 560px) {
        .omb-workspace { flex-direction: row; align-items: stretch; gap: 16px; }
        .omb-list-pane { flex: 1 1 0; min-width: 0; }
        .omb-detail-pane { position: static; inset: auto; z-index: auto;
          flex: 0 0 0; opacity: 0; visibility: visible; transform: translateX(8px); overflow: hidden;
          transition: flex-basis 220ms var(--ds-ease-in-out, ease-out), opacity 180ms var(--ds-ease-in-out, ease-out), transform 220ms var(--ds-ease-in-out, ease-out);
        }
        .omb-workspace[data-detail='open'] > .omb-detail-pane { flex-basis: clamp(280px, 46%, 560px); opacity: 1; transform: none; }
      }
      @container omb-panel (max-width: 559px) {
        .omb-workspace[data-detail='open'] > .omb-list-pane {
          opacity: 0; pointer-events: none; transform: translateX(-10px);
          transition: opacity 180ms var(--ds-ease-in-out, ease-out), transform 180ms var(--ds-ease-in-out, ease-out);
        }
      }
      @container omb-panel (max-width: 617px) {
        .omb-nav-cell { justify-content: center; padding: 8px; min-height: 42px; }
      }
      @container omb-panel (max-width: 520px) {
        .omb-content { padding: 12px; }
        .omb-grid { grid-template-columns: minmax(0, 1fr); }
      }
      @container omb-panel (max-width: 380px) {
        .omb-content { padding: 8px; }
        .omb-toolbar { gap: 6px; }
      }
      @media (pointer: coarse) { .omb-nav-cell, .omb-row { min-height: 44px; } }
      @media (prefers-reduced-motion: reduce) {
        .omb-page-forward, .omb-page-back { animation: none; }
        .omb-spin { animation: none; }
        .omb-nav-cell, .omb-row, .omb-detail-pane,
        .omb-nav-indicator,
        .omb-workspace[data-detail='open'] > .omb-detail-pane { transition: none; }
      }
    `

    async function api(path, params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const suffix = search.toString()
      const response = await fetch(`${API}${path}${suffix ? `?${suffix}` : ''}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const detail = payload && typeof payload.error === 'string' ? payload.error : ''
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`)
      }
      return payload
    }

    async function post(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const text = payload && typeof payload.text === 'string' ? payload.text : `HTTP ${response.status}`
        throw new Error(text)
      }
      return payload || { ok: true, text: '' }
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function formatTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function shortId(id) {
      const value = typeof id === 'string' ? id : ''
      return value.length > 30 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value
    }

    function baseName(path) {
      const parts = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] || String(path || '')
    }

    /** 会话显示名：有标题用标题；标题晚到/缺失时先用短 id，绝不拿 cwd 冒充。 */
    function sessionName(item, titles) {
      if (item && typeof item.title === 'string' && item.title.length > 0) return item.title
      const late = titles && item ? titles[item.id] : undefined
      if (typeof late === 'string' && late.length > 0) return late
      return `会话 ${shortId(item && item.id ? item.id : '')}`
    }

    /** 历史会话标题按需补读（每个 id 只请求一次；最多并发 20）。 */
    function useSessionTitles(items) {
      const [titles, setTitles] = React.useState({})
      const pendingRef = React.useRef(new Set())
      const mountedRef = React.useRef(true)
      React.useEffect(() => () => { mountedRef.current = false }, [])
      React.useEffect(() => {
        const pending = (items || []).filter((item) => item && item.title === null && titles[item.id] === undefined && !pendingRef.current.has(item.id))
        for (const item of pending.slice(0, 20)) {
          pendingRef.current.add(item.id)
          void api('/session-title', { id: item.id }).then((data) => {
            if (!mountedRef.current) return
            setTitles((value) => ({ ...value, [item.id]: typeof data.title === 'string' ? data.title : '' }))
          }, () => {
            if (mountedRef.current) setTitles((value) => ({ ...value, [item.id]: '' }))
          })
        }
      }, [items, titles])
      return titles
    }

    function modeText(mode) { return MODE_TEXT[mode] || String(mode || '未知') }
    function originText(origin) { return ORIGIN_TEXT[origin] || String(origin || '未知') }
    function depthText(depth) { return DEPTH_TEXT[depth] || (depth ? String(depth) : '默认') }

    function Loading({ label = '正在加载中...' }) {
      return h('p', { className: 'omb-note omb-loading', 'aria-live': 'polite' }, h(TextShimmer, { active: true }, label))
    }

    function ErrorLine({ children }) {
      return h('p', { className: 'omb-error', role: 'alert' }, children)
    }

    function Empty({ title, hint }) {
      return h('div', { className: 'omb-empty' },
        h('p', { className: 'omb-empty-title' }, title),
        hint ? h('p', { className: 'omb-empty-hint' }, hint) : null)
    }

    function Section({ title, aside, children }) {
      return h('section', { className: 'omb-section' },
        h('div', { className: 'omb-section-head' },
          h('h3', { className: 'omb-section-title' }, title),
          aside || null),
        children)
    }

    function Collapsible({ icon, title, summary, children }) {
      const [open, setOpen] = React.useState(false)
      return h(DisclosureRow, {
        icon, title, open, expandable: true,
        onToggle: () => setOpen((value) => !value),
        collapsedContent: summary ? h('span', { className: 'omb-row-meta' }, summary) : undefined,
      }, children)
    }

    function useToast() {
      const [toast, setToast] = React.useState(null)
      // 操作提醒不写句号（用户口径）：只剥掉结尾的「。」，不动正文里的标点。
      const show = (text, tone) => {
        const value = String(text === undefined || text === null ? '' : text).replace(/[。\s]+$/, '')
        setToast({ text: value, tone, key: `${Date.now()}-${Math.random()}` })
      }
      const node = toast === null
        ? null
        : h(Toast, { key: toast.key, text: toast.text, tone: toast.tone, onDone: () => setToast(null) })
      return [node, show]
    }

    /** 关闭浮层：点外部 / Escape（与 dsh-desktop-notify 的菜单同一套行为）。 */
    function useMenuDismiss(open, onClose, anchor) {
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (anchor.current && !anchor.current.contains(event.target)) onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, onClose, anchor])
    }

    /**
     * 选择控件（v4.22.2）：仿 `dsh-desktop-notify` 的 SelectMenu，不用原生 <select>。
     *
     * 触发器：32px、无边框、模块平台底色、悬停换底色；
     * 浮层：大圆角 + 玻璃透明 + 无边框，**按触发器所在侧对齐**（左半屏左对齐、右半屏右对齐）。
     */
    function Select({ label, value, options, onChange, disabled }) {
      const [open, setOpen] = React.useState(false)
      const [align, setAlign] = React.useState('left')
      const anchor = React.useRef(null)
      useMenuDismiss(open, () => setOpen(false), anchor)
      const current = options.find((option) => option.value === value) || options[0] || { label: '' }
      const toggle = () => {
        if (disabled) return
        if (!open && anchor.current && typeof anchor.current.getBoundingClientRect === 'function') {
          const rect = anchor.current.getBoundingClientRect()
          // 对齐基准是**大肥鱼增强面板**的中心（不是画面中心）：
          // 面板左边还有 DSH 一级侧边栏，用 window.innerWidth/2 会让整页偏右。
          const page = typeof anchor.current.closest === 'function' ? anchor.current.closest('.omb-page') : null
          const pageRect = page && typeof page.getBoundingClientRect === 'function' ? page.getBoundingClientRect() : null
          const middle = pageRect && pageRect.width > 0
            ? pageRect.left + pageRect.width / 2
            : (window.innerWidth || document.documentElement.clientWidth || 0) / 2
          setAlign(rect.left + rect.width / 2 <= middle ? 'left' : 'right')
        }
        setOpen((value) => !value)
      }
      return h('div', { className: 'omb-select-field', ref: anchor },
        label ? h('span', { className: 'omb-field-label' }, label) : null,
        h('button', {
          type: 'button', className: 'omb-select-trigger', disabled,
          'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
          'aria-label': label || undefined,
          onClick: toggle,
        },
        h('span', { className: 'omb-select-value' }, current.label),
        h('span', { className: 'omb-select-chevron', 'aria-hidden': true },
          open ? h(IconChevronUpOutlineRegular, { size: 12 }) : h(IconChevronDownOutlineRegular, { size: 12 }))),
        open
          ? h('div', { className: 'omb-select-menu', role: 'listbox', 'aria-label': label || '选项', 'data-align': align },
            ...options.map((option) => h('button', {
              key: option.value, type: 'button', role: 'option',
              'aria-selected': option.value === value ? 'true' : 'false',
              className: 'omb-select-item',
              onClick: () => { setOpen(false); onChange(option.value) },
            },
            h('span', { className: 'omb-select-item-label' }, option.label),
            option.value === value ? h('span', { className: 'omb-select-check', 'aria-hidden': true }, h(IconCheckOutlineRegular, { size: 12 })) : null)))
          : null)
    }

    function StatCard({ label, value, note, state }) {
      return h('div', { className: 'omb-card' },
        h('span', { className: 'omb-card-label' }, label),
        // 值一律用 .omb-card-value（同一字号/行高）：带状态点的卡曾用 .omb-meta（12/18），
        // 与同排卡片高度不一致，看起来"填不满卡片"。
        h('span', { className: 'omb-card-value' },
          state === undefined ? null : h(StateDot, { state }),
          h('span', null, value)),
        note ? h('span', { className: 'omb-card-note' }, note) : null)
    }

    function StageTags({ item }) {
      const tone = item.stage === 'candidate' ? 'warning' : item.stage === 'confirmed' ? 'success' : 'outline'
      return [
        h(Tag, { key: 'kind', tone }, `${item.scope === 'user' ? '用户' : '项目'} · ${item.kind === 'semantic' ? '语义' : item.kind === 'procedural' ? '流程' : '事件'}`),
        h(Tag, { key: 'stage', tone }, item.stageLabel || item.stage || '未知'),
      ]
    }

    function useLoad(loader, deps) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const run = (initial) => {
          if (initial) setLoading(true)
          void Promise.resolve().then(loader).then((value) => {
            if (!alive) return
            setData(value)
            setError('')
          }, (failure) => {
            if (alive) setError(messageOf(failure))
          }).finally(() => {
            if (alive) setLoading(false)
          })
        }
        run(true)
        // 无刷新按钮：可见时每 8 秒自动跟踪，窗口重新聚焦时立即更新。
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') run(false)
        }, 8000)
        const onFocus = () => run(false)
        window.addEventListener('focus', onFocus)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [...deps, tick])
      return { data, error, loading, reload: () => setTick((value) => value + 1) }
    }

    // ── 概览：记忆 + 运行状态（同屏三级卡片，无折叠、无跳转按钮） ──

    // ── 记忆：列表 + 详情 + 新建/编辑/删除/标记 ─────────────────────
    function MemoryPage({ refreshTick }) {
      const [items, setItems] = React.useState([])
      const [queryInput, setQueryInput] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [status, setStatus] = React.useState('active')
      const [kind, setKind] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const [hasMore, setHasMore] = React.useState(false)
      const [loadingMore, setLoadingMore] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [toastNode, showToast] = useToast()
      const queryRef = React.useRef('')
      const first = React.useRef(true)
      const loadingMoreRef = React.useRef(false)
      const hasMoreRef = React.useRef(false)
      const loadingRef = React.useRef(true)
      const seqRef = React.useRef(0)

      const resetForFilter = () => {
        seqRef.current += 1
        loadingRef.current = true
        loadingMoreRef.current = false
        hasMoreRef.current = false
        setItems([])
        setHasMore(false)
        setLoading(true)
        setError('')
        setTick((value) => value + 1)
      }

      const loadMore = React.useCallback(() => {
        if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return
        loadingMoreRef.current = true
        setLoadingMore(true)
        const offset = items.length
        const seq = seqRef.current
        void api('/list', { q: queryRef.current, scope, status, kind, limit: PAGE_SIZE, offset }).then((data) => {
          if (seqRef.current !== seq) return
          const next = data.items || []
          setItems((current) => {
            const seen = new Set(current.map((item) => item.id))
            return [...current, ...next.filter((item) => !seen.has(item.id))]
          })
          hasMoreRef.current = data.truncated === true
          setHasMore(data.truncated === true)
        }, (failure) => {
          setError(messageOf(failure))
        }).finally(() => {
          loadingMoreRef.current = false
          setLoadingMore(false)
        })
      }, [items.length, scope, status, kind])

      React.useEffect(() => {
        let alive = true
        const seq = seqRef.current + 1
        seqRef.current = seq
        loadingRef.current = true
        setLoading(true)
        setError('')
        hasMoreRef.current = false
        void api('/list', { q: queryRef.current, scope, status, kind, limit: PAGE_SIZE, offset: 0 }).then((data) => {
          if (!alive || seqRef.current !== seq) return
          setItems(data.items || [])
          hasMoreRef.current = data.truncated === true
          setHasMore(data.truncated === true)
        }, (failure) => {
          if (alive && seqRef.current === seq) setError(messageOf(failure))
        }).finally(() => {
          if (alive && seqRef.current === seq) {
            loadingRef.current = false
            setLoading(false)
          }
        })
        return () => { alive = false }
      }, [scope, status, kind, tick, refreshTick])

      React.useEffect(() => {
        if (first.current) { first.current = false; return undefined }
        const timer = setTimeout(() => { queryRef.current = queryInput; resetForFilter() }, 260)
        return () => clearTimeout(timer)
      }, [queryInput])

      React.useEffect(() => {
        if (selectedId === null) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setSelectedId(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selectedId])

      const open = selectedId !== null
      return h('div', { className: 'omb-workspace', 'data-detail': open ? 'open' : 'closed' },
        h('div', { className: 'omb-list-pane' },
          // 第一行：搜索（弹性填充）+ 新建；不设固定上限，窄容器里搜索自己收缩
          h('div', { className: 'omb-toolbar' },
            h(Input, {
              className: 'omb-search', value: queryInput, placeholder: '搜索记忆', 'aria-label': '搜索记忆',
              onChange: (event) => setQueryInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                queryRef.current = queryInput
                resetForFilter()
              },
            }),
            h(Button, {
              variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }),
              onClick: () => setForm({ mode: 'create' }),
            }, '新建')),
          // 第二行：库 / 状态 / 类型（v4.22.2：筛选在检索与新建下方，三个下拉同一行）
          h('div', { className: 'omb-toolbar' },
            h(Select, { label: '库', value: scope, options: SCOPES, onChange: (next) => { setScope(next); resetForFilter() } }),
            h(Select, { label: '状态', value: status, options: STATUSES, onChange: (next) => { setStatus(next); resetForFilter() } }),
            h(Select, { label: '类型', value: kind, options: KINDS, onChange: (next) => { setKind(next); resetForFilter() } })),
          h('div', { className: 'omb-toolbar' },
            h('span', { className: 'omb-toolbar-note', 'aria-live': 'polite' },
              loading ? h(TextShimmer, { active: true }, '正在加载中...') : `已加载 ${items.length} 条`)),
          error ? h(ErrorLine, null, `读取失败：${error}`) : null,
          h('div', {
            className: 'omb-list',
            onScroll: (event) => {
              const el = event.currentTarget
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) loadMore()
            },
          },
            items.length === 0 && !loading
              ? h(Empty, {
                title: status === 'candidate' ? '没有待确认的记忆' : '没有匹配的记忆',
                hint: status === 'candidate' ? '模型推断的内容会先出现在这里。' : '换个关键词或状态试试。',
              })
              : null,
            ...items.map((item) => h('button', {
              key: item.id, type: 'button', className: 'omb-row',
              'data-active': item.id === selectedId,
              'aria-pressed': item.id === selectedId,
              onClick: () => setSelectedId((current) => current === item.id ? null : item.id),
            },
            h('span', { className: 'omb-row-text' }, item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text),
            h('span', { className: 'omb-row-meta' },
              ...StageTags({ item }),
              h('span', null, formatTime(item.observedAt))))),
            loadingMore
              ? h('span', { className: 'omb-toolbar-note' }, h(TextShimmer, { active: true }, '加载更多…'))
              : hasMore
                ? h('span', { className: 'omb-toolbar-note' }, '继续向下滚动加载')
                : items.length > 0 ? h('span', { className: 'omb-toolbar-note' }, '已全部加载') : null)),
        h('aside', {
          className: 'omb-detail-pane', 'aria-label': '记忆详情',
          'aria-hidden': open ? undefined : true,
          inert: open ? undefined : true,
        }, h(MemoryDetail, {
          id: selectedId,
          onClose: () => setSelectedId(null),
          onEdit: (record) => setForm({ mode: 'edit', record }),
          onChanged: () => setTick((value) => value + 1),
        })),
        form
          ? h(MemoryForm, {
            form,
            onClose: () => setForm(null),
            onSaved: (text) => {
              setForm(null)
              showToast(text, 'success')
              setTick((value) => value + 1)
            },
          })
          : null,
        toastNode)
    }

    function MemoryDetail({ id, onClose, onEdit, onChanged }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [toastNode, showToast] = useToast()
      const [revision, setRevision] = React.useState(0)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [supersedeOpen, setSupersedeOpen] = React.useState(false)

      React.useEffect(() => {
        if (typeof id !== 'string' || id.length === 0) {
          setData(null); setError(''); setLoading(false)
          return undefined
        }
        let alive = true
        setLoading(true); setError(''); setData(null)
        void api('/detail', { id }).then((detail) => { if (alive) setData(detail) }, (failure) => {
          if (alive) setError(messageOf(failure))
        }).finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [id, revision])

      const requested = typeof id === 'string' && id.length > 0
      const waiting = requested && data === null && error === '' && !loading
      const head = h('div', { className: 'omb-detail-head' },
        h('p', { className: 'omb-detail-title' }, '记忆详情'),
        onClose ? h(Button, { variant: 'ghost', size: 'sm', icon: h(IconCloseOutlineRegular, { size: 16 }), onClick: onClose }, '收起') : null)

      if (!requested) return h('div', { className: 'omb-detail' }, head, h('p', { className: 'omb-note' }, '选一条记忆查看详情。'))
      if (loading || waiting) return h('div', { className: 'omb-detail' }, head, h(Loading, null))
      if (error) {
        return h('div', { className: 'omb-detail' }, head, /HTTP 404/.test(error)
          ? h(Empty, { title: '找不到这条记忆', hint: '它可能已被删除。' })
          : h(ErrorLine, null, `读取失败：${error}`))
      }
      const record = data.record
      const canConfirm = record.stage === 'candidate' && record.kind !== 'episodic'
      const active = record.validTo === null && record.supersededBy === null
      const act = (body, closeAfter) => {
        if (busy) return
        setBusy(true)
        void post('/memory', body).then((payload) => {
          showToast(payload.text || '完成', 'success')
          setRevision((value) => value + 1)
          onChanged()
          if (closeAfter) onClose()
        }, (failure) => {
          showToast(messageOf(failure))
        }).finally(() => setBusy(false))
      }
      const feedback = (action) => {
        if (busy) return
        setBusy(true)
        void post('/feedback', { id, action }).then((payload) => {
          showToast(payload.text || '反馈已记录', 'success')
          setRevision((value) => value + 1)
          onChanged()
        }, (failure) => {
          showToast(messageOf(failure))
        }).finally(() => setBusy(false))
      }
      return h('div', { className: 'omb-detail' },
        head,
        h('div', { className: 'omb-row-meta' }, ...StageTags({ item: record })),
        h('p', { className: 'omb-detail-text' }, record.text),
        h('div', { className: 'omb-meta' },
          h('span', { className: 'omb-code' }, record.id),
          h('span', null, formatTime(record.observedAt)),
          record.projectScope ? h('span', null, `工作区 ${record.projectScope}`) : null,
          record.tags.length > 0 ? h('span', null, record.tags.map((tag) => `#${tag}`).join(' ')) : null),
        record.supersededBy ? h('p', { className: 'omb-note' }, '这条已被更新的记忆取代（历史仍可查）。')
          : record.validTo !== null ? h('p', { className: 'omb-note' }, '这条已标记为过时。') : null,
        h('div', { className: 'omb-detail-actions' },
          canConfirm ? h(Button, { variant: 'primary', size: 'sm', icon: h(IconCheckOutlineRegular, { size: 16 }), disabled: busy, onClick: () => act({ action: 'mark', id, mark: 'confirm' }) }, '确认') : null,
          active ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => act({ action: 'mark', id, mark: 'obsolete' }) }, '标记过时') : null,
          active ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setSupersedeOpen(true) }, '取代…') : null,
          record.validTo !== null && record.supersededBy === null ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => act({ action: 'mark', id, mark: 'revive' }) }, '恢复') : null,
          onEdit ? h(Button, { variant: 'ghost', size: 'sm', icon: h(IconEditOutlineRegular, { size: 16 }), disabled: busy, onClick: () => onEdit(record) }, '编辑') : null,
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconTrashOutlineRegular, { size: 16 }), disabled: busy, onClick: () => setConfirmDelete(true) }, '删除')),
        h('div', { className: 'omb-detail-actions' },
          h('span', { className: 'omb-field-label' }, '反馈'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => feedback('useful') }, '有用'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => feedback('wrong') }, '错误'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => feedback('stale') }, '过时'),
          h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => feedback('noise') }, '噪声')),
        h(Collapsible, {
          icon: h(IconChecklistOutlineRegular, { size: 16 }),
          title: `确认记录（${data.auditAvailable ? data.audit.length : '不可读'}）`,
          summary: data.auditAvailable ? `${data.audit.length} 条` : '不可读',
        }, data.auditAvailable
          ? (data.audit.length === 0 ? h('p', { className: 'omb-note' }, '没有确认记录。') : h('div', null, ...data.audit.map((entry, index) => h('div', { key: `${entry.action}-${entry.at}-${index}`, className: 'omb-row', style: { cursor: 'default' } },
            h('div', { className: 'omb-row-meta' }, h(Tag, { tone: entry.action === 'undo' ? 'warning' : 'success' }, entry.action === 'undo' ? '撤销' : '确认'), h('span', null, formatTime(entry.at)))))))
          : h('p', { className: 'omb-note' }, '这个库没有确认记录。')),
        h(Collapsible, {
          icon: h(IconWorkspaceTreeOutlineRegular, { size: 16 }),
          title: `相关记忆（${data.related.length}）`,
          summary: `${data.related.length} 条`,
        }, data.related.length === 0
          ? h('p', { className: 'omb-note' }, '没有相关记忆。')
          : h('div', null, ...data.related.map((item) => h('div', { key: item.record.id, className: 'omb-card' },
            h('p', { className: 'omb-row-text omb-selectable' }, item.record.text),
            h('div', { className: 'omb-meta' }, h('span', { className: 'omb-code' }, item.record.id)),
            h('div', { className: 'omb-actions' },
              h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => post('/resolve', { action: 'relate', fromId: id, toId: item.record.id }).then(() => { showToast('已建立关联', 'success'); onChanged() }, (failure) => showToast(messageOf(failure))) }, '建立关联'),
              h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => post('/resolve', { action: 'supersede', fromId: id, toId: item.record.id }).then(() => { showToast('已标注取代', 'success'); onChanged() }, (failure) => showToast(messageOf(failure))) }, '本条取代该条')))))),
        h(Modal, {
          open: confirmDelete,
          onClose: () => setConfirmDelete(false),
          title: '删除这条记忆？',
          closeLabel: '取消',
          description: '删除会从库中移除并清理对应向量，无法撤销。',
          footer: h('div', { className: 'omb-modal-actions' },
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirmDelete(false) }, '取消'),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { setConfirmDelete(false); act({ action: 'delete', id }, true) } }, '删除')),
        }),
        supersedeOpen
          ? h(SupersedeModal, {
            currentId: id,
            onClose: () => setSupersedeOpen(false),
            onDone: (target) => {
              setSupersedeOpen(false)
              showToast(`已用「${target.text.slice(0, 24)}…」取代这条`, 'success')
              setRevision((value) => value + 1)
              onChanged()
            },
          })
          : null,
        toastNode)
    }

    function MemoryForm({ form, onClose, onSaved }) {
      const editing = form.mode === 'edit'
      const record = form.record
      const [kind, setKind] = React.useState(editing ? record.kind : 'semantic')
      const [scope, setScope] = React.useState(editing ? record.scope : 'user')
      const [text, setText] = React.useState(editing ? record.text : '')
      const [tags, setTags] = React.useState(editing ? record.tags.join(', ') : '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [toastNode, showToast] = useToast()
      const submit = () => {
        if (busy) return
        setBusy(true); setError('')
        const tagList = tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        const body = editing
          ? { action: 'update', id: record.id, text, kind, tags: tagList }
          : { action: 'create', scope, kind, text, tags: tagList }
        void post('/memory', body).then((payload) => {
          onSaved(payload.text || (editing ? '已保存' : '已添加'))
        }, (failure) => {
          const message = messageOf(failure)
          setError(message)
          showToast(message)
        }).finally(() => setBusy(false))
      }
      return h(Modal, {
        open: true,
        onClose,
        title: editing ? '编辑记忆' : '新建记忆',
        closeLabel: '取消',
        description: editing ? '保存后立刻生效。' : '手动添加的记忆标记为“你确认过的”。',
        footer: h('div', { className: 'omb-modal-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || text.trim().length === 0, onClick: submit }, editing ? '保存' : '添加')),
      },
      h('div', { className: 'omb-form' },
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '库'),
        editing
          ? h('div', { className: 'omb-actions' }, h(Tag, { tone: 'outline' }, scope === 'user' ? '用户库' : '项目库'))
          : h(Select, {
            value: scope,
            options: [{ value: 'user', label: '用户库' }, { value: 'project', label: '项目库' }],
            onChange: setScope,
          })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '类型'),
        h(Select, { value: kind, options: CREATABLE_KINDS, onChange: setKind })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '内容'),
        h('textarea', {
          className: 'omb-textarea', value: text, placeholder: '写下要记住的内容',
          onChange: (event) => setText(event.target.value),
        })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '标签（可选）'),
        h(Input, { value: tags, placeholder: '用逗号分隔，最多 8 个', onChange: (event) => setTags(event.target.value) })),
      error ? h(ErrorLine, null, error) : null,
      toastNode))
    }

    // ── 项目：会话 × 工作区 × 深度 × 隐私 ───────────────────────────
    function ProjectPage({ refreshTick }) {
      const sessions = useLoad(() => api('/sessions'), [refreshTick])
      const privacy = useLoad(() => api('/privacy'), [refreshTick])
      const [selectedId, setSelectedId] = React.useState(null)
      const [profile, setProfile] = React.useState(null)
      const [profileError, setProfileError] = React.useState('')
      const [profileLoading, setProfileLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [toastNode, showToast] = useToast()
      const [confirm, setConfirm] = React.useState('')
      const list = sessions.data && sessions.data.available ? sessions.data.items : null
      const current = privacy.data && privacy.data.current ? privacy.data.current.sessionId : null
      const selected = list ? list.find((item) => item.id === selectedId) || null : null
      const [expanded, setExpanded] = React.useState({})
      const [expandedSessions, setExpandedSessions] = React.useState({})
      const groups = React.useMemo(() => {
        const map = new Map()
        for (const item of list || []) {
          const key = item.root || item.cwd || 'unknown'
          if (!map.has(key)) map.set(key, { key, label: baseName(key) || key, root: key, items: [], latest: 0, active: false })
          const group = map.get(key)
          group.items.push(item)
          group.latest = Math.max(group.latest, item.createdAt || 0)
          group.active = group.active || item.active === true
        }
        return [...map.values()]
          .map((group) => ({
            ...group,
            items: group.items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
          }))
          .sort((a, b) => b.latest - a.latest)
      }, [list])
      const toggleGroup = (key) => setExpanded((value) => ({ ...value, [key]: !value[key] }))
      const toggleSession = (id) => setExpandedSessions((value) => ({ ...value, [id]: !value[id] }))
      const visibleSessions = groups.filter((group) => expanded[group.key] === true).flatMap((group) => group.items)
      const titles = useSessionTitles(visibleSessions)

      React.useEffect(() => {
        if (!selected || selected.archived) { setProfile(null); setProfileError(''); return undefined }
        let alive = true
        setProfileLoading(true); setProfileError('')
        void api('/profile', { sessionId: selected.id }).then((value) => { if (alive) setProfile(value) }, (failure) => {
          if (alive) setProfileError(messageOf(failure))
        }).finally(() => { if (alive) setProfileLoading(false) })
        return () => { alive = false }
      }, [selected ? selected.id : null, selected ? selected.archived : false, refreshTick])

      const act = (body) => {
        if (busy) return
        setBusy(true)
        void post('/privacy', body).then((payload) => {
          showToast(payload.text || '完成', 'success')
          privacy.reload(); sessions.reload()
        }, (failure) => {
          showToast(messageOf(failure))
        }).finally(() => setBusy(false))
      }
      const setDepth = (depth) => {
        if (busy) return
        setBusy(true)
        void post('/depth', { sessionId: selected.id, depth }).then((payload) => {
          showToast(payload.text || '已更新推理深度', 'success')
          sessions.reload()
        }, (failure) => {
          showToast(messageOf(failure))
        }).finally(() => setBusy(false))
      }

      /**
       * 会话卡片（v4.22.2）：整卡可点。
       * - 有子会话：点任意位置 = 选中 + 展开/收起（和工作区卡片同一个交互）；
       * - 无子会话：点任意位置 = 选中。
       * 右侧只保留一个 chevron 指示器（不是按钮，不单独 hover），展开/收起走 grid-rows 动画。
       */
      const sessionRow = (item, depth, hasChildren, childOpen, onToggle) => {
        const isArchived = item.archived
        return h('button', {
          key: item.id, type: 'button', className: 'omb-row omb-row-split omb-session-card',
          'data-active': item.id === selectedId,
          'data-disabled': isArchived,
          disabled: isArchived,
          'aria-expanded': hasChildren ? (childOpen ? 'true' : 'false') : undefined,
          onClick: () => {
            if (isArchived) return
            setSelectedId(item.id)
            if (hasChildren) onToggle()
          },
        },
        h('span', { className: 'omb-session-main' },
          h('span', { className: 'omb-row-title' }, sessionName(item, titles)),
          h('span', { className: 'omb-row-meta' },
            isArchived ? h(Tag, { tone: 'quiet' }, '已归档') : item.active ? h(Tag, { tone: 'success' }, '进行中') : h(Tag, { tone: 'outline' }, '历史'),
            depth > 0 ? h(Tag, { tone: 'quiet' }, '子会话') : null,
            !item.preset ? h(Tag, { tone: 'quiet' }, '旧会话') : null,
            item.id === current ? h(Tag, { tone: 'info' }, '当前') : null,
            h('span', null, depthText(item.depth)),
            item.privacy ? h(Tag, { tone: item.privacy.mode === 'normal' ? 'neutral' : 'warning' }, modeText(item.privacy.mode)) : null)),
        hasChildren
          ? h('span', { className: 'omb-row-chevron', 'aria-hidden': true },
            childOpen ? h(IconChevronUpOutlineRegular, { size: 14 }) : h(IconChevronDownOutlineRegular, { size: 14 }))
          : null)
      }
      const renderGroupSessions = (group) => {
        const ids = new Set(group.items.map((item) => item.id))
        const children = new Map()
        const roots = []
        for (const item of group.items) {
          const parent = item.parentId && ids.has(item.parentId) ? item.parentId : null
          if (parent === null) roots.push(item)
          else {
            if (!children.has(parent)) children.set(parent, [])
            children.get(parent).push(item)
          }
        }
        const seen = new Set()
        const render = (item, depth) => {
          if (seen.has(item.id)) return []
          seen.add(item.id)
          const kids = children.get(item.id) || []
          const open = expandedSessions[item.id] === true
          return [
            sessionRow(item, depth, kids.length > 0, open, () => toggleSession(item.id)),
            kids.length === 0
              ? null
              : h('div', { key: `${item.id}:children`, className: 'omb-collapse', 'data-open': open ? 'true' : 'false' },
                h('div', null,
                  h('div', { className: 'omb-session-children' }, ...kids.flatMap((child) => render(child, depth + 1))))),
          ]
        }
        return roots.flatMap((item) => render(item, 0))
      }
      const listRows = groups.length > 0
        ? h('div', { className: 'omb-list' }, ...groups.map((group) => h('div', { key: group.key, className: 'omb-workspace-group' },
          h('button', {
            type: 'button', className: 'omb-row omb-row-split omb-workspace-card',
            onClick: () => toggleGroup(group.key),
            'aria-expanded': expanded[group.key] === true,
            title: expanded[group.key] ? '收起' : '展开',
          },
          h('span', { className: 'omb-workspace-main' },
            h('span', { className: 'omb-row-title' }, group.label || group.root),
            h('span', { className: 'omb-row-meta' },
              h(Tag, { tone: group.active ? 'success' : 'outline' }, group.active ? '有进行中会话' : '历史'),
              h('span', null, `${group.items.length} 个会话`)),
            h('span', { className: 'omb-row-sub' }, group.root)),
          h('span', { className: 'omb-row-chevron', 'aria-hidden': true },
            expanded[group.key] ? h(IconChevronUpOutlineRegular, { size: 12 }) : h(IconChevronDownOutlineRegular, { size: 12 }))),
          h('div', { className: 'omb-collapse', 'data-open': expanded[group.key] === true ? 'true' : 'false' },
            h('div', null,
              h('div', { className: 'omb-workspace-sessions' }, ...renderGroupSessions(group)))))))
        : null

      const listBody = !sessions.data
        ? (sessions.loading ? h(Loading, null) : null)
        : !sessions.data.available
          ? h(Empty, { title: '暂时读不到会话目录', hint: sessions.data.reason || '宿主没有提供会话列表。' })
          : listRows || h(Empty, { title: '还没有大肥鱼模式的会话', hint: '在模式里选择大肥鱼后开始对话。' })

      const listPane = h('div', { className: 'omb-list-pane' },
        h('div', { className: 'omb-toolbar' },
          h('span', { className: 'omb-toolbar-note', 'aria-live': 'polite' },
            sessions.loading ? h(TextShimmer, { active: true }, '正在加载中...') : groups.length > 0 ? `${groups.length} 个工作区` : '')),
        sessions.error ? h(ErrorLine, null, `读取失败：${sessions.error}`) : null,
        listBody)

      const privacySection = selected && h(Section, { title: '会话设置' },
        selected.active ? h('p', { className: 'omb-note' }, '会话运行中：设置已锁定，结束后可修改。') : null,
        h('div', { className: 'omb-actions' },
          h('span', { className: 'omb-field-label' }, '推理深度'),
          h(Select, {
            label: '推理深度', value: selected.depth || 'standard',
            options: [{ value: 'quick', label: '快速' }, { value: 'standard', label: '标准' }, { value: 'deep', label: '深入' }],
            disabled: busy || selected.active, onChange: setDepth,
          }),
          h('span', { className: 'omb-toolbar-note' }, '写入本会话的推理档位')),
        h('div', { className: 'omb-actions' },
          h('span', { className: 'omb-field-label' }, '隐私模式'),
          h(Select, {
            label: '隐私模式',
            value: selected.privacy ? selected.privacy.mode : 'normal',
            options: MODE_OPTIONS, disabled: busy || selected.active,
            onChange: (next) => act({ action: 'set', sessionId: selected.id, mode: next }),
          }),
          h('span', { className: 'omb-toolbar-note' }, selected.privacy ? `${originText(selected.privacy.origin)}${selected.privacy.inheritedFrom ? ' · 继承' : ''}` : '默认')))

      const profileSection = h(Section, { title: '工作区画像' },
        profileLoading ? h(Loading, null)
          : profileError ? h(ErrorLine, null, `画像读取失败：${profileError}`)
            : !profile || !profile.available
              ? h(Empty, { title: '暂无可用的工作区画像', hint: profile ? profile.reason || '非 git 工作区或尚未构建。' : '' })
              : h('div', null,
                h('div', { className: 'omb-grid' },
                  h(StatCard, { label: '分支 / HEAD', value: `${profile.branch || '未知'} / ${profile.head ? String(profile.head).slice(0, 8) : '未知'}` }),
                  h(StatCard, { label: '顶层目录', value: String((profile.structure && profile.structure.topDirs || []).length), note: (profile.structure && profile.structure.topDirs || []).slice(0, 4).map((dir) => dir.name).join(' · ') }),
                  h(StatCard, { label: '文件索引', value: String((profile.structure && profile.structure.files || []).length), note: '按符号与导入排序' }),
                  h(StatCard, { label: '项目根', value: profile.root ? baseName(profile.root) : '未知', note: profile.root || '' })),
                profile.text ? h('p', { className: 'omb-note omb-selectable' }, profile.text) : null))

      const privacyMaintenance = h(Section, { title: '隐私维护' },
        h('p', { className: 'omb-note' }, '只影响你这里的设置；模型没有入口。'),
        h('div', { className: 'omb-actions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconWarningOutlineRegular, { size: 16 }), disabled: busy || !privacy.data || !privacy.data.available, onClick: () => setConfirm('clear-inactive') }, '清理已结束记录'),
          privacy.data && privacy.data.available && privacy.data.baseline && privacy.data.baseline.origin === 'fail-closed'
            ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setConfirm('trust') }, '解除兜底限制')
            : null))

      const detailBody = selected && selected.archived
        ? h(Empty, { title: '已归档会话不可读', hint: '归档是保护状态：不会读取工作区画像，也不能改隐私。' })
        : h(React.Fragment, null,
          privacySection,
          selected
            ? (!selected.privacy
              ? h(Section, { title: '状态机' }, h(Empty, { title: '隐私状态不可读', hint: '无法确认会话隐私档位，先不展示状态机。' }))
              : selected.privacy.mode === 'sealed'
                ? h(Section, { title: '状态机' }, h(Empty, { title: '封存会话不可读', hint: '解除封存后再查看控制器状态。' }))
                : h(ControllerSection, { sessionId: selected.id, readOnly: selected.privacy.mode === 'read-only' }))
            : null,
          profileSection,
          privacyMaintenance)

      const detail = selected
        ? h('div', { className: 'omb-detail' },
          h('div', { className: 'omb-detail-head' },
            h('p', { className: 'omb-detail-title' }, sessionName(selected, titles)),
            selected.archived ? h(Tag, { tone: 'quiet' }, '已归档') : h(Tag, { tone: selected.active ? 'success' : 'outline' }, selected.active ? '进行中' : '历史')),
          h('div', { className: 'omb-meta' },
            h('span', { className: 'omb-code' }, selected.id),
            h('span', { className: 'omb-selectable' }, selected.root || selected.cwd),
            h('span', null, formatTime(selected.createdAt))),
          detailBody)
        : h('div', { className: 'omb-detail' },
          h('p', { className: 'omb-detail-title' }, '会话详情'),
          h('p', { className: 'omb-note' }, '选一个会话查看工作区、深度与隐私。'))

      const aside = h('aside', {
        className: 'omb-detail-pane', 'aria-label': '会话详情',
        'aria-hidden': selected ? undefined : true,
        inert: selected ? undefined : true,
      }, detail)

      const modal = h(Modal, {
        open: confirm !== '',
        onClose: () => setConfirm(''),
        title: confirm === 'trust' ? '解除兜底限制？' : '清理已结束会话的记录？',
        closeLabel: '取消',
        description: confirm === 'trust'
          ? '仅在确认隐私状态文件已修好时使用。'
          : '只删除已结束、且不是活跃会话继承来源的记录。',
        footer: h('div', { className: 'omb-modal-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm('') }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => act({ action: confirm === 'trust' ? 'trust' : 'clear-inactive' }) }, '确认')),
      })

      return h('div', { className: 'omb-workspace', 'data-detail': selected ? 'open' : 'closed' }, listPane, aside, modal, toastNode)
    }

    // ── 个人画像 ────────────────────────────────────────────────────
    const PHASE_TEXT = {
      idle: '空闲',
      'candidate-pending': '待确认候选',
      'tracking-tasks': '跟踪任务',
      mixed: '混合',
    }
    const PROFILE_AXES = [
      { value: 'stable', label: '稳定偏好' },
      { value: 'intent', label: '意图' },
      { value: 'collaboration', label: '协作方式' },
    ]

    // ── 控制器状态机：手动查看/增删任务与候选（v4.19） ─────────────
    function ControllerSection({ sessionId, readOnly }) {
      const [tick, setTick] = React.useState(0)
      const resource = useLoad(() => api('/controller', { sessionId }), [sessionId, tick])
      const [task, setTask] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [toastNode, showToast] = useToast()
      const [confirm, setConfirm] = React.useState('')
      const view = resource.data
      const state = view && view.available ? view : null
      const act = (body) => {
        if (busy) return
        setBusy(true)
        void post('/controller', { sessionId, ...body }).then((payload) => {
          showToast(payload.text || '已更新', 'success')
          setTick((value) => value + 1)
        }, (failure) => {
          showToast(messageOf(failure))
        }).finally(() => setBusy(false))
      }
      const addTask = () => {
        const text = task.trim()
        if (text.length === 0) return
        act({ action: 'add-task', text })
        setTask('')
      }
      return h(Section, { title: '状态机' },
        h('p', { className: 'omb-note' }, '会话内的任务约束与候选；手改立即生效，任务在回合结束失效。'),
        readOnly ? h('p', { className: 'omb-note' }, '只读会话：可以查看，不能编辑状态机。') : null,
        resource.loading && !view ? h(Loading, null)
          : resource.error ? h(ErrorLine, null, `状态机读取失败：${resource.error}`)
            : !view || !view.available
              ? h(Empty, { title: '状态机暂不可用', hint: view ? view.reason || '' : '' })
              : h(React.Fragment, null,
                h('div', { className: 'omb-meta' },
                  h(Tag, { tone: state && state.phase !== 'idle' ? 'warning' : 'outline' }, PHASE_TEXT[state ? state.phase : 'idle'] || '空闲'),
                  h('span', null, `任务 ${state ? state.tasks.length : 0} 条`),
                  h('span', null, `候选 ${state ? state.candidates.length : 0} 条`)),
                h('div', { className: 'omb-toolbar' },
                  h(Input, {
                    className: 'omb-search', value: task, placeholder: '添加一条任务约束', 'aria-label': '添加任务约束',
                    disabled: readOnly,
                    onChange: (event) => setTask(event.target.value),
                    onKeyDown: (event) => { if (event.key === 'Enter') addTask() },
                  }),
                  h(Button, { variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }), disabled: readOnly || busy || task.trim().length === 0, onClick: addTask }, '添加任务')),
                state && state.tasks.length > 0
                  ? h('div', null, ...state.tasks.map((entry, index) => h('div', { key: `${entry.text}-${index}`, className: 'omb-card' },
                    h('p', { className: 'omb-row-text omb-selectable' }, entry.text),
                    h('div', { className: 'omb-meta' }, h('span', null, `到期 ${formatTime(entry.expiresAt)}`)),
                    h('div', { className: 'omb-actions' },
                      h(Button, { variant: 'ghost', size: 'sm', disabled: readOnly || busy, onClick: () => act({ action: 'remove-task', text: entry.text }) }, '移除')))))
                  : h('p', { className: 'omb-note' }, '没有任务约束。'),
                state && state.candidates.length > 0
                  ? h('div', null, ...state.candidates.map((entry) => h('div', { key: entry.id, className: 'omb-card' },
                    h('p', { className: 'omb-row-text omb-selectable' }, entry.text),
                    h('div', { className: 'omb-meta' }, h(Tag, { tone: 'outline' }, entry.kind), h('span', null, entry.reason)),
                    h('div', { className: 'omb-actions' },
                      h(Button, { variant: 'ghost', size: 'sm', disabled: readOnly || busy, onClick: () => act({ action: 'remove-candidate', text: entry.text }) }, '移除')))))
                  : h('p', { className: 'omb-note' }, '没有待确认候选。'),
                h('div', { className: 'omb-actions' },
                  h(Button, { variant: 'ghost', size: 'sm', disabled: readOnly || busy || !state || state.tasks.length === 0, onClick: () => setConfirm('tasks') }, '清空任务'),
                  h(Button, { variant: 'ghost', size: 'sm', disabled: readOnly || busy || !state || state.candidates.length === 0, onClick: () => setConfirm('candidates') }, '清空候选'))),
        h(Modal, {
          open: confirm !== '',
          onClose: () => setConfirm(''),
          title: confirm === 'tasks' ? '清空任务约束？' : '清空待确认候选？',
          closeLabel: '取消',
          description: '只影响当前会话的控制器状态，不改已写入的记忆。',
          footer: h('div', { className: 'omb-modal-actions' },
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm('') }, '取消'),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { setConfirm(''); act({ action: confirm === 'tasks' ? 'clear-tasks' : 'clear-candidates' }) } }, '清空')),
        }),
        toastNode)
    }

    // ── 状态机总览：项目级跨会话 + 跨工作区（v4.20） ────────────────
    /**
     * 「状态机」页（v4.22.2）：**会话时空状态机**的可视化。
     *
     * 每条会话一张卡：世界身份（epoch）、我信过什么（读取印记）、增量（外部改动/
     * 守卫计数）、时间（回合/步骤/空闲/上次结束原因）。**不再展示记忆控制器的
     * 任务/候选表**（那个在项目页的「会话设置」里）。
     */
    const SITUATION_STATE_TEXT = {
      active: '进行中', idle: '空闲', stale: '陈旧', recovering: '恢复中', unknown: '未观测',
    }
    const TURN_REASON_TEXT = {
      complete: '完成', completed: '完成', done: '完成', closed: '结束',
      cancelled: '取消', canceled: '取消', aborted: '中断', error: '报错',
      interrupted: '中断', 'max-tokens': '超出输出上限',
    }
    function formatIdle(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '未知'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟`
      const hours = Math.round(minutes / 60)
      if (hours < 48) return `${hours} 小时`
      return `${Math.round(hours / 24)} 天`
    }
    function shortHead(head) {
      return typeof head === 'string' && head.length > 0 ? head.slice(0, 7) : null
    }

    function MachinesPage({ refreshTick }) {
      const resource = useLoad(() => api('/machines'), [refreshTick])
      const [query, setQuery] = React.useState('')
      const [stateFilter, setStateFilter] = React.useState('all')
      const data = resource.data
      const groups = data && data.groups ? data.groups : []
      const filteredGroups = groups.map((group) => ({
        ...group,
        sessions: group.sessions.filter((entry) => {
          if (stateFilter !== 'all' && entry.state !== stateFilter) return false
          const needle = query.trim().toLowerCase()
          if (needle.length === 0) return true
          const haystack = [sessionName(entry), entry.cwd, entry.title || '', entry.lastTurnEndReason || '']
            .join(' ').toLowerCase()
          return haystack.includes(needle)
        }),
      })).filter((group) => group.sessions.length > 0)
      const sessions = filteredGroups.flatMap((group) => group.sessions)
      const titles = useSessionTitles(sessions)
      const observed = sessions.filter((entry) => entry.observed === true)
      const activeCount = sessions.filter((entry) => entry.state === 'active').length
      const changedReads = sessions.reduce((sum, entry) => sum + (entry.reads ? entry.reads.changed : 0), 0)
      const stats = h('div', { className: 'omb-grid' },
        h(StatCard, { label: '工作区', value: String(filteredGroups.length), note: '按项目根聚合' }),
        h(StatCard, { label: '有读数的会话', value: String(observed.length), note: `共 ${sessions.length} 条会话` }),
        h(StatCard, { label: '进行中', value: String(activeCount), note: 'state=active' }),
        h(StatCard, { label: '读取印记有变化', value: String(changedReads), note: '读完又被外部改过' }))
      const sessionCard = (entry) => {
        const locked = entry.archived === true || entry.privacy === 'sealed'
        const stateText = entry.archived ? '已归档' : (SITUATION_STATE_TEXT[entry.state] || '未观测')
        const epoch = entry.epoch
        const head = epoch === null ? null : shortHead(epoch.head)
        const reason = entry.lastTurnEndReason === null ? null : (TURN_REASON_TEXT[entry.lastTurnEndReason] || entry.lastTurnEndReason)
        const reads = entry.reads || { count: 0, changed: 0, unknown: 0, entries: [] }
        const side = entry.sideEffects || {}
        const readEntries = (reads.entries || []).map((item, index) => h('div', { key: `${item.path}-${index}`, className: 'omb-row-meta' },
          h('span', { className: 'omb-code omb-selectable' }, item.path),
          h(Tag, { tone: item.status === 'changed' ? 'warning' : item.status === 'unknown' ? 'quiet' : 'outline' },
            item.status === 'changed' ? '已变化' : item.status === 'unknown' ? '无法核验' : '未变')))
        return h('div', { key: entry.id, className: 'omb-card' },
          h('div', { className: 'omb-row-meta' },
            h(Tag, { tone: entry.state === 'active' ? 'success' : entry.state === 'unknown' ? 'quiet' : 'outline' }, stateText),
            entry.tier ? h(Tag, { tone: 'quiet' }, `tier ${entry.tier}`) : null,
            entry.interrupted ? h(Tag, { tone: 'warning' }, '有中断') : null,
            entry.unresolved ? h(Tag, { tone: 'warning' }, '未闭合') : null,
            entry.privacy ? h(Tag, { tone: entry.privacy === 'normal' ? 'neutral' : 'warning' }, modeText(entry.privacy)) : null,
            h('span', null, entry.id)),
          h('p', { className: 'omb-row-title' }, sessionName(entry, titles)),
          locked ? h('p', { className: 'omb-note' }, '归档/封存会话：不读状态机。') : null,
          !locked && entry.observed !== true
            ? h('p', { className: 'omb-note' }, '未观测：本进程还没有这个会话的状态（历史会话或重启前的会话），不是空闲。')
            : null,
          entry.observed === true
            ? h(React.Fragment, null,
              h('div', { className: 'omb-row-meta' },
                h('span', null, `回合 ${entry.turn === null ? '未知' : entry.turn} · 步骤 ${entry.step === null ? '未知' : entry.step}`),
                h('span', null, `最近活动 ${entry.lastEventAt === null ? '未知' : formatTime(entry.lastEventAt)}`),
                h('span', null, `空闲 ${formatIdle(entry.idleMs)}`),
                h('span', null, `上次结束 ${reason || '未记录'}`)),
              h('div', { className: 'omb-row-meta' },
                h('span', null, `目标 ${entry.goals.open}/${entry.goals.total}`),
                h('span', null, `待办 ${entry.todos.open}/${entry.todos.total}`),
                epoch === null
                  ? h('span', null, '工作区身份：未测量')
                  : h('span', null, `工作区 ${head ? head + ' · ' : ''}${epoch.branch || '无分支'} · 脏 ${epoch.dirtyCount} 个文件 · 来源 ${epoch.source}`),
                epoch !== null && epoch.degraded ? h(Tag, { tone: 'warning' }, '数据不确定') : null,
                epoch !== null && epoch.instructions ? h(Tag, { tone: 'quiet' }, '有指令指纹') : null),
              h('div', { className: 'omb-row-meta' },
                h('span', null, `读取印记 ${reads.count} 条（变化 ${reads.changed} / 无法核验 ${reads.unknown}）`),
                h('span', null, `拒写 ${side.denies || 0} · 放弃 ${side.gaveUps || 0} · 盲写 ${side.blindWrites || 0} · 陈旧写 ${side.staleWrites || 0} · 无法核验 ${side.unverifiable || 0}`),
                h('span', null, `shell 写 ${side.shellWrites || 0}（未知 ${side.shellUnknown || 0} / 推断 ${side.shellInferred || 0}）· 其他会话写 ${side.otherSessionWrites || 0}`)),
              entry.workspace
                ? h('div', { className: 'omb-row-meta' },
                  h('span', null, `跨工作区切换 ${entry.workspace.switches} 次`),
                  entry.workspace.previousRoot ? h('span', null, `上一处 ${entry.workspace.previousRoot}`) : null)
                : null,
              h(Collapsible, {
                icon: h(IconWorkspaceTreeOutlineRegular, { size: 16 }),
                title: `读取印记（${reads.entries.length}）`,
                summary: reads.entries.length === 0 ? '无' : `变化 ${reads.changed} / 无法核验 ${reads.unknown}`,
              }, readEntries.length === 0
                ? h('p', { className: 'omb-note' }, '没有读取印记。')
                : h('div', { className: 'omb-stack' }, ...readEntries)))
            : null)
      }
      const groupView = filteredGroups.map((group) => h(Section, { key: group.root, title: group.label || group.root },
        h('div', { className: 'omb-stack' }, ...group.sessions.map(sessionCard))))
      const filters = h('div', { className: 'omb-toolbar' },
        h(Input, { className: 'omb-search', value: query, placeholder: '搜索会话 / 路径 / 上次结束原因', onChange: (event) => setQuery(event.target.value) }),
        h(Select, {
          label: '状态', value: stateFilter,
          options: [{ value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'idle', label: '空闲' }, { value: 'stale', label: '陈旧' }, { value: 'recovering', label: '恢复中' }, { value: 'unknown', label: '未观测' }],
          onChange: setStateFilter,
        }))
      const content = !data
        ? (resource.loading ? h(Loading, null) : resource.error ? h(ErrorLine, null, `读取失败：${resource.error}`) : null)
        : !data.available
          ? h(Empty, { title: '状态机暂不可用', hint: data.reason || '' })
          : h(React.Fragment, null, filters, stats,
            filteredGroups.length === 0
              ? h(Empty, { title: '没有匹配的状态机', hint: '换个关键词或状态试试。' })
              : h(React.Fragment, null, ...groupView))
      return h('div', { className: 'omb-scroll' }, content)
    }

    // ── 个人画像手动编辑（v4.19） ─────────────────────────────────
    function PersonalForm({ record, onClose, onSaved }) {
      const editing = record !== null
      const [axis, setAxis] = React.useState(editing ? record.axis : 'stable')
      const [key, setKey] = React.useState(editing ? record.key : '')
      const [value, setValue] = React.useState(editing ? record.value : '')
      const [evidence, setEvidence] = React.useState(editing && record.evidence ? record.evidence.join('；') : '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [toastNode, showToast] = useToast()
      const submit = () => {
        if (busy || key.trim().length === 0 || value.trim().length === 0) return
        setBusy(true); setError('')
        const evidenceList = evidence.split(/[；;]/).map((item) => item.trim()).filter((item) => item.length > 0)
        const declare = () => post('/personal', {
          action: 'declare', axis, key: key.trim(), value: value.trim(),
          ...(evidenceList.length === 0 ? {} : { evidence: evidenceList }),
        })
        // 改写一条已声明条目：先撤掉同键旧声明，再写新值（避免留下两条冲突）。
        const run = editing && record.provenance === 'declared'
          ? post('/personal', { action: 'retract', axis: record.axis, key: record.key }).then(declare)
          : declare()
        void run.then((payload) => onSaved(payload.text || '已保存'), (failure) => {
          const message = messageOf(failure)
          setError(message)
          showToast(message)
        })
          .finally(() => setBusy(false))
      }
      return h(Modal, {
        open: true,
        onClose,
        title: editing ? '改写画像条目' : '新增画像条目',
        closeLabel: '取消',
        description: editing && record.provenance === 'declared'
          ? '保存会替换同键的旧声明。'
          : editing ? '保存后转为“你确认”的条目，覆盖同键推断。' : '写你确认的长期偏好，之后可以再改。',
        footer: h('div', { className: 'omb-modal-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || key.trim().length === 0 || value.trim().length === 0, onClick: submit }, '保存')),
      },
      h('div', { className: 'omb-form' },
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '轴'),
        h(Select, { value: axis, options: PROFILE_AXES, onChange: setAxis })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '键'),
        h(Input, { value: key, placeholder: '例如：回答语言', 'aria-label': '画像键', onChange: (event) => setKey(event.target.value) })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '取值'),
        h('textarea', { className: 'omb-textarea', value, placeholder: '例如：中文', onChange: (event) => setValue(event.target.value) })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '依据（可选）'),
        h(Input, { value: evidence, placeholder: '用；分隔', onChange: (event) => setEvidence(event.target.value) })),
      error ? h(ErrorLine, null, error) : null,
      toastNode))
    }

    // ── 记忆生命周期：手动指定取代目标（v4.19） ───────────────────
    function SupersedeModal({ currentId, onClose, onDone }) {
      const resource = useLoad(() => api('/list', { status: 'active', scope: 'all', limit: 50 }), [])
      const [query, setQuery] = React.useState('')
      const [target, setTarget] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [toastNode, showToast] = useToast()
      const options = (resource.data && resource.data.items ? resource.data.items : [])
        .filter((item) => item.id !== currentId && (query.trim().length === 0 || item.text.includes(query.trim())))
      const submit = () => {
        if (target === null || busy) return
        setBusy(true); setError('')
        void post('/resolve', { action: 'supersede', fromId: currentId, toId: target.id }).then(() => onDone(target), (failure) => {
          const message = messageOf(failure)
          setError(message)
          showToast(message)
        })
          .finally(() => setBusy(false))
      }
      return h(Modal, {
        open: true,
        onClose,
        title: '用哪条记忆取代这条？',
        closeLabel: '取消',
        description: '被取代的旧条目会标为失效但保留历史，不删除。',
        footer: h('div', { className: 'omb-modal-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy || target === null, onClick: submit }, '取代')),
      },
      h('div', { className: 'omb-toolbar' },
        h(Input, { className: 'omb-search', value: query, placeholder: '搜索目标记忆', onChange: (event) => setQuery(event.target.value) })),
      error ? h(ErrorLine, null, error) : null,
      toastNode,
      resource.loading ? h(Loading, null)
        : resource.error ? h(ErrorLine, null, `读取失败：${resource.error}`)
          : options.length === 0 ? h(Empty, { title: '没有可选的记忆', hint: '换个关键词，或先新建一条。' })
            : h('div', { className: 'omb-list', style: { maxHeight: '280px' } }, ...options.map((item) => h('button', {
              key: item.id, type: 'button', className: 'omb-row',
              'data-active': target !== null && target.id === item.id,
              onClick: () => setTarget(item),
            },
            h('span', { className: 'omb-row-text' }, item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text),
            h('span', { className: 'omb-row-meta' }, ...StageTags({ item }))))))
    }

    function PersonalPage({ refreshTick }) {
      const [revision, setRevision] = React.useState(0)
      const [form, setForm] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [toastNode, showToast] = useToast()
      const resource = useLoad(() => api('/personal'), [refreshTick, revision])
      const data = resource.data
      const grouped = React.useMemo(() => {
        const map = new Map()
        for (const entry of (data && data.entries) || []) {
          const axis = entry.axis || 'stable'
          if (!map.has(axis)) map.set(axis, [])
          map.get(axis).push(entry)
        }
        return [...map.entries()].sort((a, b) => AXIS_ORDER.indexOf(a[0]) - AXIS_ORDER.indexOf(b[0]))
      }, [data])
      const remove = (entry) => {
        if (busy) return
        setBusy(true)
        void post('/personal', { action: 'retract', axis: entry.axis, key: entry.key }).then((payload) => {
          showToast(payload.text || '已删除', 'success')
          setRevision((value) => value + 1)
        }, (failure) => showToast(messageOf(failure)))
          .finally(() => { setBusy(false); setConfirmDelete(null) })
      }

      const actionsRow = h('div', { className: 'omb-actions' },
        h(Button, { variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }), onClick: () => setForm({ record: null }) }, '新增条目'))
      const stats = data ? h('div', { className: 'omb-grid' },
        h(StatCard, { label: '已声明', value: String(data.status ? data.status.declared : data.entries.length), note: '你明确说过的偏好' }),
        h(StatCard, { label: '推断', value: String(data.status ? data.status.inferred : 0), note: '从对话里归纳' }),
        h(StatCard, { label: '待裁决冲突', value: String(data.status ? data.status.conflicts : data.conflicts.length), state: data.conflicts.length > 0 ? 'warning' : 'idle', note: data.conflicts.length > 0 ? '同一条偏好有两个说法' : '没有冲突' }),
        h(StatCard, { label: '能力轴', value: data.status && data.status.capabilityAxis === 'on-session-only' ? '仅本会话' : '关闭', note: '不在长期记忆里保存能力判断' })) : null
      const conflicts = data && data.conflicts.length > 0
        ? h(Section, { title: '待裁决的冲突' }, ...data.conflicts.map((conflict) => h('div', { key: `${conflict.axis}:${conflict.key}`, className: 'omb-card' },
          h('div', { className: 'omb-row-meta' }, h(Tag, { tone: 'warning' }, conflict.axisLabel || conflict.axis), h('span', null, conflict.key)),
          ...conflict.values.map((value, index) => h('p', { key: index, className: 'omb-detail-text omb-selectable' }, `${value.provenance === 'declared' ? '你说过' : '推断'}：${value.value}`)))))
        : null
      const entryCard = (entry, index) => {
        const evidence = entry.evidence && entry.evidence.length > 0
          ? h('p', { className: 'omb-note omb-selectable' }, `依据：${entry.evidence.slice(0, 3).join('；')}`)
          : null
        const actions = h('div', { className: 'omb-actions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconEditOutlineRegular, { size: 16 }), onClick: () => setForm({ record: entry }) }, entry.provenance === 'declared' ? '编辑' : '改为确认'),
          entry.provenance === 'declared'
            ? h(Button, { variant: 'ghost', size: 'sm', icon: h(IconTrashOutlineRegular, { size: 16 }), disabled: busy, onClick: () => setConfirmDelete(entry) }, '删除')
            : null)
        return h('div', { key: `${entry.key}-${index}`, className: 'omb-card' },
          h('div', { className: 'omb-row-meta' },
            h(Tag, { tone: entry.provenance === 'declared' ? 'success' : 'quiet' }, entry.provenance === 'declared' ? '你确认' : '推断'),
            h('span', { className: 'omb-code' }, entry.key),
            h('span', null, formatTime(entry.updated))),
          h('p', { className: 'omb-detail-text omb-selectable' }, entry.value),
          evidence,
          actions)
      }
      const groups = grouped.length === 0
        ? h(Empty, { title: '还没有画像', hint: '点“新增条目”写下你的长期偏好；聊到习惯后也会自动出现推断。' })
        : h(React.Fragment, null, ...grouped.map(([axis, entries]) => h(Section, { key: axis, title: (entries[0] && entries[0].axisLabel) || axis }, ...entries.map(entryCard))))
      const summary = data && data.text
        ? h(Collapsible, { icon: h(IconUserOutlineRegular, { size: 16 }), title: '画像摘要', summary: '' }, h('p', { className: 'omb-note omb-selectable' }, data.text))
        : null

      const content = !data
        ? (resource.loading ? h(Loading, null) : resource.error ? h(ErrorLine, null, `读取失败：${resource.error}`) : null)
        : !data.available
          ? h(Empty, { title: '画像暂不可用', hint: data.reason || '' })
          : h(React.Fragment, null, actionsRow, stats, conflicts, groups, summary)

      const formModal = form
        ? h(PersonalForm, {
          record: form.record,
          onClose: () => setForm(null),
          onSaved: (text) => {
            setForm(null)
            showToast(text, 'success')
            setRevision((value) => value + 1)
          },
        })
        : null

      const deleteModal = h(Modal, {
        open: confirmDelete !== null,
        onClose: () => setConfirmDelete(null),
        title: '删除这条画像条目？',
        closeLabel: '取消',
        description: '只删除你确认过的声明；推断条目用“改为确认”覆盖。',
        footer: h('div', { className: 'omb-modal-actions' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirmDelete(null) }, '取消'),
          h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { if (confirmDelete) remove(confirmDelete) } }, '删除')),
      })

      return h('div', { className: 'omb-scroll' }, content, formModal, deleteModal, toastNode)
    }

    function MemoryPanel() {
      const [page, setPage] = React.useState(null)
      const [direction, setDirection] = React.useState(1)
      const navRef = React.useRef(null)
      const cellRefs = React.useRef({})
      /** 首次出现只淡入（位置先无过渡就位）；随后切换才启用滑动回弹。 */
      const positioned = React.useRef(false)
      /**
       * 选中高亮块的位置（相对 nav 的 offsetTop/高度）。
       * `ready=false` 先隐藏；`animate=false` 时不启用 transform/height 过渡（只淡入）。
       */
      const [indicator, setIndicator] = React.useState({ top: 0, height: 0, ready: false, animate: false })
      /** 减弱动效：显式判断并内联关闭滑动（不依赖 CSS 规则是否被后置规则覆盖）。 */
      const reducedMotion = React.useMemo(() => {
        try {
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches
        } catch {
          return false
        }
      }, [])
      const active = page === null ? null : NAV.find((entry) => entry.value === page) || null
      const go = (next) => {
        const from = page === null ? -1 : NAV.findIndex((entry) => entry.value === page)
        const to = NAV.findIndex((entry) => entry.value === next)
        setDirection(to >= from ? 1 : -1)
        setPage(next)
      }
      const measure = () => {
        const nav = navRef.current
        const cell = page === null ? null : cellRefs.current[page]
        if (!nav || !cell) {
          setIndicator((value) => (value.ready ? { ...value, ready: false } : value))
          return
        }
        const top = cell.offsetTop
        const height = cell.offsetHeight
        setIndicator((value) => {
          const next = { top, height, ready: true, animate: positioned.current }
          if (value.top === next.top && value.height === next.height
            && value.ready === next.ready && value.animate === next.animate) return value
          return next
        })
      }
      React.useLayoutEffect(measure, [page])
      React.useLayoutEffect(() => {
        if (!indicator.ready || positioned.current) return undefined
        // 第一帧位置已就位（opacity 正在淡入），下一帧才允许 transform/height 过渡，
        // 否则首次选中会从 (top=0,height=0) 滑下来，看起来像回弹。
        const frame = requestAnimationFrame(() => {
          positioned.current = true
          setIndicator((value) => (value.animate ? value : { ...value, animate: true }))
        })
        return () => cancelAnimationFrame(frame)
      }, [indicator.ready])
      React.useEffect(() => {
        const nav = navRef.current
        if (!nav || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(nav)
        return () => observer.disconnect()
      }, [page])
      /**
       * 滑动过渡**内联**给：CSS 里的 `transition` 会被后置规则（例如
       * `@media (prefers-reduced-motion)` 的 `transition: none`）覆盖，曾导致
       * 回弹动画"被吃掉"。内联是最终权威；减弱动效在 JS 里判断后显式降级。
       */
      const indicatorTransition = reducedMotion || !indicator.animate
        ? 'opacity 220ms var(--ds-ease-in-out, ease-out)'
        // 起步慢、中后段加速、末尾小幅过冲再收束：Q 弹感来自 y2>1，但不拉开两端差距。
        : 'transform 340ms cubic-bezier(.38, .02, .2, 1.4), height 340ms cubic-bezier(.38, .02, .2, 1.4), opacity 220ms var(--ds-ease-in-out, ease-out)'
      return h('div', { className: 'omb-page' },
        h('style', null, CSS),
        h('div', { className: 'omb-head' },
          h('h2', { className: 'omb-title' }, TITLE)),
        h('div', { className: 'omb-body' },
          h('nav', { ref: navRef, className: 'omb-nav', 'aria-label': `${TITLE}导航` },
            h('span', {
              className: 'omb-nav-indicator',
              'data-ready': indicator.ready ? 'true' : 'false',
              'data-animate': indicator.animate ? 'true' : 'false',
              'aria-hidden': true,
              style: {
                transform: `translateY(${indicator.top}px)`,
                height: `${indicator.height}px`,
                transition: indicatorTransition,
              },
            }),
            ...NAV.map((entry) => h('button', {
              key: entry.value, type: 'button', className: 'omb-nav-cell',
              ref: (node) => { if (node) cellRefs.current[entry.value] = node },
              'aria-current': page === entry.value ? 'page' : undefined,
              title: entry.label,
              onClick: () => go(entry.value),
            },
            h(entry.icon, { size: 18, className: 'omb-nav-icon', 'aria-hidden': true }),
            h('span', { className: 'omb-nav-label' }, entry.label)))),
          h('div', { className: 'omb-content' },
            active === null
              ? null
              : h(React.Fragment, null,
                h('div', { className: 'omb-content-head' },
                  h('div', null,
                    h('h3', { className: 'omb-content-title' }, active.label),
                    h('p', { className: 'omb-content-desc' }, PAGE_HINTS[page]))),
                h('div', { key: page, className: `omb-page-in ${direction > 0 ? 'omb-page-forward' : 'omb-page-back'}` },
                  page === 'memory' ? h(MemoryPage)
                    : page === 'project' ? h(ProjectPage)
                      : page === 'machines' ? h(MachinesPage)
                        : h(PersonalPage))))))
    }

    function MemoryIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 20, height: size || 20, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 7 18.5h2' }),
      h('path', { d: 'M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 17 18.5h-2' }),
      h('path', { d: 'M9 4.5V19.5M15 4.5V19.5M9 9h6M9 13h6M9 17h6' }))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => TITLE,
        }, MemoryIcon))
      },
    }
  },
})

