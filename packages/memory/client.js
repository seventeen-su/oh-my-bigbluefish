// OMB 设置面板（v4.17.0）——手写浏览器 bundle，不需要打包器。
//
// 界面约定（对齐 DSH web 的既有做法）：
// - 二级侧边栏：页面导航在面板左侧的导航轨上（不是顶部页签），窄容器收成图标轨；
// - 控件复用共享控件 `@deepseek-ai/dsh-client-ui-primitives`（Button/Input/Pill/
//   Tag/SegmentedControl/StateDot 与标准图标），不自己造按钮或输入框；
// - 颜色/圆角/动效 token 一律走 `--dsw-*` / `--ds-*`，不写死色值；
// - 弹性排版：flex + grid + `minmax(0, …)`，用容器查询（`@container omb-panel`）
//   在宽容器才并排列表与详情；窄容器详情变成从右侧滑入的面板；
// - 动效克制：页面切换 160ms 淡入、详情栏 220ms 展开/收起、hover 100–120ms；
//   全部在 `prefers-reduced-motion: reduce` 下取消运动（状态与颜色变化保留）；
// - 详情栏在**没有选中条目时收起**（不占宽度，`inert` + `aria-hidden`）。
//
// 数据面：宿主 `/omb/api`（只读 GET；写操作只有用户点击的 confirm/resolve/privacy）。
window.__ModuleLoader__.load({
  id: '@omb/memory',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Input, Modal, Pill, Tag, SegmentedControl, StateDot, TextShimmer,
      IconChecklistOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular,
      IconGaugeOutlineRegular, IconInfoOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular,
      IconShieldOutlineRegular, IconWorkspaceTreeOutlineRegular,
    } = primitives
    const h = React.createElement

    const PANEL_ID = 'omb-memory'
    const API = '/omb/api'
    const TITLE = 'OMB 设置'

    const NAV = [
      { value: 'overview', label: '概览', icon: IconGaugeOutlineRegular },
      { value: 'memory', label: '记忆库', icon: IconDatabaseOutlineRegular },
      { value: 'candidates', label: '候选确认', icon: IconChecklistOutlineRegular },
      { value: 'privacy', label: '会话隐私', icon: IconShieldOutlineRegular },
      { value: 'runtime', label: '运行状态', icon: IconPlayOutlineRegular },
      { value: 'profile', label: '项目画像', icon: IconWorkspaceTreeOutlineRegular },
    ]
    const SCOPES = [
      { value: 'all', label: '全部' },
      { value: 'user', label: '用户库' },
      { value: 'project', label: '项目库' },
    ]
    const STATUSES = [
      { value: 'active', label: '活跃' },
      { value: 'stale', label: '已失效' },
      { value: 'superseded', label: '已被取代' },
      { value: 'all', label: '全部' },
    ]
    const KINDS = [
      { value: '', label: '全部类型' },
      { value: 'semantic', label: '语义' },
      { value: 'procedural', label: '流程' },
      { value: 'episodic', label: '事件' },
    ]
    const PRIVACY_MODES = [
      { value: 'normal', label: 'normal' },
      { value: 'read-only', label: 'read-only' },
      { value: 'sealed', label: 'sealed' },
    ]
    const MODE_TEXT = {
      normal: 'normal（可读可写）',
      'read-only': 'read-only（可读不可写）',
      sealed: 'sealed（不可读不可写）',
    }
    const ORIGIN_TEXT = {
      command: '命令设置',
      inherited: '继承',
      default: '默认',
      'fail-closed': 'fail-closed 兜底',
    }
    const PAGE_HINTS = {
      overview: '库就绪、计数与各库分布；计数带扫描上限，不冒充全量。',
      memory: '检索、筛选与详情；写操作只有你点击的确认/裁决。',
      candidates: '模型推断写入、等待你确认的条目；确认后进入记忆库。',
      privacy: '按会话管理隐私档位（normal / read-only / sealed）；模型工具没有入口。',
      runtime: '本进程台账：版本、隐私闸门、事件控制器、捕获与活动日志。',
      profile: 'git 项目根、目录与文件索引（只读）。',
    }

    const CSS = `
      .omb-page {
        container-type: inline-size; container-name: omb-panel;
        display: flex; flex-direction: column; box-sizing: border-box;
        height: 100%; min-height: 0; overflow: hidden;
        color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-family, inherit);
      }
      .omb-head {
        flex: none; display: flex; flex-wrap: wrap; align-items: center;
        justify-content: space-between; gap: 8px 16px; padding: 16px 20px 12px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2);
      }
      .omb-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .omb-brand-mark {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px; flex: none;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-primary);
      }
      .omb-title { margin: 0; font-size: 19px; line-height: 26px; font-weight: 600; }
      .omb-sub { margin: 1px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-head-side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px 10px; }
      .omb-head-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

      /* ── 二级侧边栏：左导航轨 + 右内容，任何宽度都不回到顶部菜单 ── */
      .omb-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 10px; padding: 0 12px 12px; }
      .omb-nav {
        flex: none; width: 46px; box-sizing: border-box;
        display: flex; flex-direction: column; gap: 2px;
        padding: 6px; overflow-y: auto;
        border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
      }
      .omb-nav-cell {
        display: flex; align-items: center; gap: 8px; min-height: 36px; width: 100%;
        padding: 6px 8px; box-sizing: border-box;
        border: none; border-radius: var(--dsw-radius-md); background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
        transition: background-color 120ms var(--ds-ease-in-out, ease-out);
      }
      .omb-nav-cell:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
      .omb-nav-cell[aria-current='page'] { background: var(--dsw-specific-sidebar-nav-item-active); }
      .omb-nav-cell:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .omb-nav-icon { flex: none; }
      .omb-nav-label {
        display: none; min-width: 0; overflow: hidden;
        white-space: nowrap; text-overflow: ellipsis;
      }
      .omb-nav-count {
        display: none; flex: none; margin-left: auto;
        padding: 0 6px; border-radius: 999px;
        font-size: 11px; line-height: 16px;
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-tertiary);
      }
      .omb-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
      .omb-page-in { width: 100%; max-width: 1120px; margin: 0 auto; animation: omb-page-in 160ms var(--ds-ease-in-out, ease-out); }
      @keyframes omb-page-in { from { opacity: 0; transform: translateY(4px); } }
      .omb-page-head {
        flex: none; display: flex; flex-wrap: wrap; align-items: baseline;
        gap: 2px 10px; padding: 0 0 10px;
      }
      .omb-page-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
      .omb-page-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-loading { display: inline-flex; align-items: center; gap: 6px; }
      .omb-empty {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 6px; padding: 28px 16px; box-sizing: border-box; text-align: center;
        border: 0.5px dashed var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
        color: var(--dsw-alias-label-tertiary);
      }
      .omb-empty-title { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .omb-empty-hint { margin: 0; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
      .omb-scroll {
        flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
        gap: 12px; overflow-y: auto; padding-right: 4px;
      }

      .omb-grid {
        display: grid; gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
      }
      .omb-card {
        display: flex; flex-direction: column; gap: 4px; min-width: 0;
        padding: 12px 14px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-settings-card-fill, transparent);
      }
      .omb-card-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-card-value { font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
      .omb-card-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .omb-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .omb-section-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
      .omb-meta {
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
        min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
      }
      .omb-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .omb-notice {
        display: flex; align-items: flex-start; gap: 8px; min-width: 0;
        padding: 10px 12px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-2);
      }
      .omb-notice > .omb-note { color: var(--dsw-alias-label-secondary); }
      .omb-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
      .omb-code { font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px; }
      .omb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-search { flex: 1 1 220px; min-width: 140px; }
      .omb-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

      /* ── 记忆库工作区：宽容器列表 + 详情并排；详情未选中时收起 ── */
      .omb-workspace {
        position: relative; flex: 1 1 auto; min-height: 0; min-width: 0;
        display: flex; flex-direction: column; gap: 10px;
      }
      .omb-list-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .omb-list {
        flex: 1 1 auto; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 6px; padding-right: 4px;
      }
      .omb-row {
        display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
        padding: 10px 12px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
        transition: background-color 100ms ease, border-color 120ms ease;
      }
      .omb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-row[data-active='true'] {
        border-color: var(--dsw-alias-state-business-primary);
        background: var(--dsw-specific-sidebar-nav-item-active);
      }
      .omb-row:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .omb-row-text { margin: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }

      /* 窄容器：详情是覆盖在列表上的滑入面板（隐藏时不可聚焦） */
      .omb-detail-pane {
        position: absolute; inset: 0; z-index: 2; display: flex; min-width: 0; min-height: 0;
        background: var(--dsw-alias-bg-layer-1, transparent);
        transform: translateX(100%); opacity: 0; visibility: hidden;
        transition:
          transform 220ms var(--ds-ease-in-out, ease-out),
          opacity 180ms var(--ds-ease-in-out, ease-out),
          visibility 0s linear 220ms;
      }
      .omb-workspace[data-detail='open'] > .omb-detail-pane {
        transform: none; opacity: 1; visibility: visible; transition-delay: 0s;
      }
      .omb-detail {
        flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 12px; padding: 14px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-2);
      }
      .omb-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .omb-detail-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
      .omb-detail-text { margin: 0; font-size: 13px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .omb-file { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .omb-priv-row { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px 12px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
      .omb-priv-row[data-inheritance='true'] { border-color: var(--dsw-alias-state-warn-primary); }
      .omb-priv-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-section + .omb-section { padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .omb-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }

      /* 宽容器：左导航轨展开文字，列表与详情并排；详情栏宽度可过渡 */
      @container omb-panel (min-width: 720px) {
        .omb-head { padding: 20px 24px 14px; }
        .omb-body { gap: 14px; padding: 0 16px 16px; }
        .omb-nav { width: 172px; padding: 10px 8px; }
        .omb-nav-label { display: block; }
        .omb-nav-count { display: inline-block; }
        .omb-nav-cell { min-height: 38px; padding: 8px 10px; }
      }
      @container omb-panel (max-width: 560px) {
        .omb-head { padding: 12px 12px 10px; }
        .omb-body { gap: 8px; padding: 0 8px 8px; }
        .omb-nav { width: 42px; padding: 4px; }
        .omb-card { padding: 10px 12px; }
        .omb-detail, .omb-priv-row { padding: 10px 12px; }
      }
      @container omb-panel (min-width: 900px) {
        .omb-workspace { flex-direction: row; align-items: stretch; gap: 14px; }
        .omb-list-pane { flex: 1 1 auto; }
        .omb-detail-pane {
          position: static; inset: auto; z-index: auto; background: transparent;
          flex: 0 0 0; opacity: 0; visibility: visible; transform: translateX(8px);
          transition:
            flex-basis 220ms var(--ds-ease-in-out, ease-out),
            opacity 180ms var(--ds-ease-in-out, ease-out),
            transform 220ms var(--ds-ease-in-out, ease-out);
        }
        .omb-workspace[data-detail='open'] > .omb-detail-pane { flex-basis: 56%; opacity: 1; transform: none; }
      }

      @media (pointer: coarse) {
        .omb-nav-cell { min-height: 44px; }
        .omb-row { min-height: 44px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .omb-page-in { animation: none; }
        /* 这里直接取消过渡是安全的：收起/展开由 React 状态驱动，**没有**任何代码
           等 transitionend 收尾（motion-transitions §8 的例外条件不成立）；
           颜色/背景等状态提示仍保留。 */
        .omb-nav-cell, .omb-row, .omb-detail-pane,
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

    function formatTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '时间未知'
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function trims(text, max) {
      const value = typeof text === 'string' ? text : ''
      return value.length > max ? `${value.slice(0, max)}…` : value
    }

    function shortId(id, max) {
      const value = typeof id === 'string' ? id : ''
      if (value.length <= max) return value
      return `${value.slice(0, Math.max(1, max - 12))}…${value.slice(-8)}`
    }

    function modeText(mode) {
      return MODE_TEXT[mode] || String(mode || '未知')
    }

    function originText(origin) {
      return ORIGIN_TEXT[origin] || String(origin || '未知')
    }

    function StageTags({ item }) {
      const tone = item.stage === 'candidate' ? 'warning' : item.stage === 'confirmed' ? 'success' : 'outline'
      return [
        h(Tag, { key: 'kind', tone }, `${item.scope}/${item.kind}`),
        h(Tag, { key: 'stage', tone }, item.stageLabel || item.stage || '未知'),
        h(Tag, { key: 'by', tone: 'quiet' }, item.assertedBy),
      ]
    }

    function StateLine({ state, children }) {
      return h('span', { className: 'omb-meta' }, h(StateDot, { state }), children)
    }

    function Loading({ label }) {
      return h('p', { className: 'omb-note omb-loading', 'aria-live': 'polite' },
        h(TextShimmer, { active: true }, label))
    }

    function Empty({ title, hint }) {
      return h('div', { className: 'omb-empty' },
        h(IconInfoOutlineRegular, { size: 20, 'aria-hidden': true }),
        h('p', { className: 'omb-empty-title' }, title),
        hint ? h('p', { className: 'omb-empty-hint' }, hint) : null)
    }

    function Card({ label, value, note, state }) {
      return h('div', { className: 'omb-card' },
        h('span', { className: 'omb-card-label' }, label),
        state === undefined
          ? h('span', { className: 'omb-card-value' }, value)
          : h(StateLine, { state }, value),
        note ? h('span', { className: 'omb-card-note' }, note) : null)
    }

    function LoadState({ loading, error, data, label }) {
      if (loading && !data) return h(Loading, { label: `读取${label}…` })
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-note' }, `暂无${label}`)
      return null
    }

    function OverviewView({ data, loading, error, onRefresh, onNavigate }) {
      if (loading && !data) return h(Loading, { label: '读取中…' })
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-note' }, '暂无数据')
      const limited = data.stores.some((store) => store.scanLimited)
      return h('div', { className: 'omb-scroll' },
        h('div', { className: 'omb-grid' },
          h(Card, {
            label: '记忆库', value: data.ready ? '就绪' : '未就绪',
            state: data.ready ? 'done' : 'error', note: data.detail || '无说明',
          }),
          h(Card, {
            label: '活跃条目', value: String(data.totalActive),
            note: limited ? '部分库只统计最近 500 行（非全量）' : '全部已打开库',
          }),
          h(Card, {
            label: '候选条目', value: String(data.totalCandidates),
            note: limited ? '扫描上限内计数（非全量）' : '全部已打开库',
          }),
          h(Card, {
            label: `已打开项目库 ${data.openProjects.length}/${data.maxOpenProjects}`,
            value: data.openProjects.length > 0 ? `${data.openProjects.length} 个` : '无',
            note: data.openProjects.length > 0 ? data.openProjects.join('、') : '尚无项目库',
          })),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '各库'),
          data.stores.length === 0
            ? h('p', { className: 'omb-note' }, '尚未打开任何库；进入一个会话后宿主会预热用户库/项目库。')
            : null,
          ...data.stores.map((store) => h('div', {
            key: `${store.scope}:${store.projectScope || ''}`,
            className: 'omb-meta',
            style: { padding: '6px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
          },
          h(Tag, { tone: 'outline' }, store.scope),
          h('span', null, store.projectScope || '用户库'),
          h('span', null, `行 ${store.stats.rows}`),
          h('span', null, `活跃 ${store.active}`),
          h('span', null, `候选 ${store.candidates}`)))),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '快捷入口'),
          h('div', { className: 'omb-actions' },
            h(Button, {
              variant: 'ghost', size: 'sm', icon: h(IconDatabaseOutlineRegular, { size: 16 }),
              onClick: () => onNavigate('memory'),
            }, '记忆库'),
            h(Button, {
              variant: 'ghost', size: 'sm', icon: h(IconChecklistOutlineRegular, { size: 16 }),
              onClick: () => onNavigate('candidates'),
            }, '候选确认'),
            h(Button, {
              variant: 'ghost', size: 'sm', icon: h(IconShieldOutlineRegular, { size: 16 }),
              onClick: () => onNavigate('privacy'),
            }, '会话隐私'),
            h(Button, {
              variant: 'ghost', size: 'sm', icon: h(IconPlayOutlineRegular, { size: 16 }),
              onClick: () => onNavigate('runtime'),
            }, '运行状态'))),
        h('div', { className: 'omb-actions' },
          h(Button, {
            variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16 }),
            onClick: onRefresh,
          }, '刷新'),
          h('span', { className: 'omb-note' },
            '本页只读。确认候选走“候选确认”页或 /omb-confirm；手动裁决在记忆详情里。')),
        limited
          ? h('p', { className: 'omb-note' }, '计数范围：每个库最近 500 行；库更大时按“扫描上限内”理解。')
          : null)
    }

    function DetailView({ id, onClose, onChanged }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [actionText, setActionText] = React.useState('')
      const [revision, setRevision] = React.useState(0)

      React.useEffect(() => {
        // 没选条目 = 还没打开详情，不是错误：不发请求（曾因此产生 /detail 无 id → HTTP 400）。
        if (typeof id !== 'string' || id.length === 0) {
          setData(null)
          setError('')
          setLoading(false)
          return undefined
        }
        let alive = true
        setLoading(true)
        setError('')
        setData(null)
        void api('/detail', { id }).then((detail) => {
          if (alive) setData(detail)
        }, (failure) => {
          if (alive) setError(failure instanceof Error ? failure.message : String(failure))
        }).finally(() => {
          if (alive) setLoading(false)
        })
        return () => { alive = false }
      }, [id, revision])

      const run = (path, body) => {
        if (busy) return
        setBusy(true)
        setActionText('')
        void post(path, body).then((payload) => {
          setActionText(payload.text || '完成')
          setRevision((value) => value + 1)
          if (onChanged) onChanged()
        }, (failure) => {
          setActionText(failure instanceof Error ? failure.message : String(failure))
        }).finally(() => setBusy(false))
      }

      const requested = typeof id === 'string' && id.length > 0
      // id 刚变成本次选中、effect 还没跑完时，避免先闪一帧"未找到/空态"。
      const waiting = requested && data === null && error === '' && !loading
      const head = h('div', { className: 'omb-detail-head' },
        h('p', { className: 'omb-detail-title' }, '记忆详情'),
        h(Button, {
          variant: 'ghost', size: 'sm', icon: h(IconCloseOutlineRegular, { size: 16 }),
          onClick: onClose, 'aria-label': '收起详情',
        }, '收起'))

      if (loading || waiting) return h('div', { className: 'omb-detail' }, head, h(Loading, { label: '读取详情…' }))
      if (error) {
        return h('div', { className: 'omb-detail' }, head,
          /HTTP 404/.test(error)
            ? h(Empty, { title: '未找到该条目', hint: '可能已被删除或属于其他库；刷新列表后再试。' })
            : h('p', { className: 'omb-error', role: 'alert' }, `详情读取失败：${error}`))
      }
      if (!data) {
        return h('div', { className: 'omb-detail' }, head,
          h('p', { className: 'omb-note' }, id ? '未找到该条目（可能已被删除或属于其他库）。' : '从左侧选择一条记忆查看详情、审计与相关条目。'))
      }

      const record = data.record
      const canConfirm = record.stage === 'candidate' && record.kind !== 'episodic'
      const lastAudit = data.auditAvailable ? data.audit[0] : undefined
      const canUndo = data.auditAvailable && record.stage === 'confirmed'
        && lastAudit !== undefined && lastAudit.action === 'confirm'
      const isFailedText = /失败|未确认|未撤销|未执行|无法/.test(actionText)

      return h('div', { className: 'omb-detail' },
        head,
        h('div', { className: 'omb-actions' },
          ...StageTags({ item: record }),
          h('span', { className: 'omb-meta omb-code' }, record.id)),
        h('p', { className: 'omb-detail-text' }, record.text),
        h('div', { className: 'omb-meta' },
          h('span', null, `来源 ${record.sourceRef}`),
          h('span', null, formatTime(record.observedAt)),
          record.projectScope ? h('span', null, `项目 ${record.projectScope}`) : null,
          record.tags.length > 0 ? h('span', null, `标签 ${record.tags.join('、')}`) : null),
        record.validTo === null && record.supersededBy === null
          ? null
          : h('p', { className: 'omb-note' },
            record.supersededBy ? `已被 ${record.supersededBy} 取代（非破坏，历史可查）` : `有效至 ${formatTime(record.validTo)}`),
        h('div', { className: 'omb-actions' },
          canConfirm
            ? h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => run('/confirm', { id, action: 'confirm' }) }, '确认为已确认')
            : null,
          canUndo
            ? h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => run('/confirm', { id, action: 'undo' }) }, '撤销确认')
            : null,
          h('span', { className: 'omb-note' }, canConfirm || canUndo ? '动作走 /omb-confirm 同一实现；只改证据归属。' : '当前没有可执行的确认动作。')),
        actionText.length === 0
          ? null
          : h('p', { className: isFailedText ? 'omb-error' : 'omb-note', role: 'status', 'aria-live': 'polite' }, actionText),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, `确认审计（${data.auditAvailable ? data.audit.length : '不可读'}）`),
          data.auditAvailable
            ? (data.audit.length === 0
              ? h('p', { className: 'omb-note' }, '没有经 /omb-confirm 的记录。')
              : h('div', { className: 'omb-list', style: { maxHeight: 220 } },
                ...data.audit.map((entry, index) => h('div', { key: `${entry.action}-${entry.at}-${index}`, className: 'omb-meta' },
                  h(Tag, { tone: entry.action === 'undo' ? 'warning' : 'success' }, entry.action === 'undo' ? '撤销' : '确认'),
                  h('span', null, formatTime(entry.at)),
                  h('span', null, entry.sessionId ? `会话 ${entry.sessionId}` : '无会话')))))
            : h('p', { className: 'omb-note' }, '该库没有确认审计面（旧实现），无法证明确认历史。')),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, `可能相关 / 冲突（${data.related.length}）`),
          data.related.length === 0
            ? h('p', { className: 'omb-note' }, '没有共享实体键的活跃条目。')
            : h('div', { className: 'omb-list', style: { maxHeight: 280 } },
              ...data.related.map((item) => h('div', { key: item.record.id, className: 'omb-card' },
                h('p', { className: 'omb-row-text' }, item.record.text),
                h('div', { className: 'omb-meta' },
                  h('span', { className: 'omb-code' }, item.record.id),
                  h('span', null, formatTime(item.record.observedAt)),
                  h('span', null, `共享 ${item.shared.join('、')}`)),
                h('div', { className: 'omb-actions' },
                  h(Button, {
                    variant: 'outline', size: 'sm', disabled: busy,
                    onClick: () => run('/resolve', { action: 'relate', fromId: id, toId: item.record.id }),
                  }, '建立关联'),
                  h(Button, {
                    variant: 'outline', size: 'sm', disabled: busy,
                    onClick: () => run('/resolve', { action: 'supersede', fromId: id, toId: item.record.id }),
                  }, '本条取代该条'),
                  h('span', { className: 'omb-note' }, '取代 = validTo + supersededBy + supersedes 边（非破坏）')))))))
    }

    function LibraryView({ candidatesOnly, onChanged }) {
      const [items, setItems] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [status, setStatus] = React.useState('active')
      const [kind, setKind] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [revision, setRevision] = React.useState(0)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const queryRef = React.useRef('')
      const firstQuery = React.useRef(true)

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const data = candidatesOnly
            ? await api('/candidates', { limit: 50 })
            : await api('/list', { q: queryRef.current, scope, status, kind, limit: 50 })
          setItems(data.items || [])
          setTotal(data.total || 0)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [candidatesOnly, scope, status, kind])

      React.useEffect(() => { void load() }, [load, revision])

      // 输入防抖：输入只改本地值，停顿 250ms 或按 Enter 才请求。
      React.useEffect(() => {
        if (firstQuery.current) {
          firstQuery.current = false
          return undefined
        }
        const timer = setTimeout(() => setRevision((value) => value + 1), 250)
        return () => clearTimeout(timer)
      }, [query])

      // 详情打开时按 Escape 收起（窄容器是滑入面板，宽容器是收起右栏）。
      React.useEffect(() => {
        if (selectedId === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setSelectedId(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selectedId])

      const open = selectedId !== null
      return h('div', { className: 'omb-workspace', 'data-detail': open ? 'open' : 'closed' },
        h('div', { className: 'omb-list-pane' },
          candidatesOnly
            ? h('p', { className: 'omb-note' }, '候选 = 模型推断写入、等待用户确认的条目。')
            : h('div', { className: 'omb-toolbar' },
              h(Input, {
                className: 'omb-search', value: query, placeholder: '搜索记忆（词法 + 子串回退）',
                'aria-label': '搜索记忆',
                onChange: (event) => {
                  queryRef.current = event.target.value
                  setQuery(event.target.value)
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    queryRef.current = query
                    setRevision((value) => value + 1)
                  }
                },
              }),
              h(SegmentedControl, {
                id: 'omb-scope', label: '作用域', value: scope, options: SCOPES,
                onChange: (next) => setScope(next),
              }),
              h(SegmentedControl, {
                id: 'omb-status', label: '状态', value: status, options: STATUSES,
                onChange: (next) => setStatus(next),
              }),
              h('span', { className: 'omb-pills' },
                ...KINDS.map((entry) => h(Pill, {
                  key: entry.value || 'all', active: kind === entry.value,
                  onClick: () => setKind(entry.value),
                }, entry.label)))),
          h('div', { className: 'omb-meta', 'aria-live': 'polite' },
            loading
              ? h(TextShimmer, { active: true }, '读取中…')
              : `显示 ${items.length} / ${total} 条${total > items.length ? '（超出单页上限）' : ''}`),
          error ? h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`) : null,
          h('div', { className: 'omb-list' },
            items.length === 0 && !loading
              ? h(Empty, {
                title: '没有匹配条目',
                hint: candidatesOnly
                  ? '模型推断写入后会出现在这里；确认后进入记忆库。'
                  : '试试清空搜索、切换状态/类型，或换一个作用域。',
              })
              : null,
            ...items.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'omb-row',
              'data-active': item.id === selectedId,
              'aria-pressed': item.id === selectedId,
              onClick: () => setSelectedId((current) => current === item.id ? null : item.id),
            },
            h('span', { className: 'omb-row-text' }, trims(item.text, 180)),
            h('span', { className: 'omb-meta' },
              ...StageTags({ item }),
              h('span', { key: 'time' }, formatTime(item.observedAt)),
              item.tags.length > 0 ? h('span', { key: 'tags' }, `#${item.tags.join(' #')}`) : null))))),
        h('aside', {
          className: 'omb-detail-pane',
          'aria-label': '记忆详情',
          'aria-hidden': open ? undefined : true,
          inert: open ? undefined : true,
        }, h(DetailView, {
          id: selectedId,
          onClose: () => setSelectedId(null),
          onChanged: () => { setRevision((value) => value + 1); if (onChanged) onChanged() },
        })))
    }

    function PrivacyView() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [messageFailed, setMessageFailed] = React.useState(false)
      const [confirm, setConfirm] = React.useState('')
      // null = 还没选；首屏用当前会话的真实档位填充，避免"默认 read-only"被误点成放宽 sealed。
      const [pendingMode, setPendingMode] = React.useState(null)
      const [sessionId, setSessionId] = React.useState('')
      const [sessionMode, setSessionMode] = React.useState('read-only')

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await api('/privacy')
          setData(payload)
          if (payload && payload.available && payload.current) {
            setPendingMode((previous) => previous === null ? payload.current.mode : previous)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => { void load() }, [load])

      const act = (body) => {
        if (busy) return
        setBusy(true)
        setMessage('')
        setMessageFailed(false)
        void post('/privacy', body).then((payload) => {
          setMessage(payload.text || '完成')
          setMessageFailed(false)
          setConfirm('')
          void load()
        }, (failure) => {
          setMessage(failure instanceof Error ? failure.message : String(failure))
          setMessageFailed(true)
          // 失败时也关掉确认框：否则错误文案被模态遮住，用户看不到原因。
          setConfirm('')
        }).finally(() => setBusy(false))
      }

      const currentMode = pendingMode
        ?? (data && data.current ? data.current.mode : 'read-only')
      const failClosed = data && data.available && data.baseline && data.baseline.origin === 'fail-closed'
      const canBulkClear = data && data.available
        ? data.sessions.some((entry) => entry.active !== true && entry.inheritanceSource !== true)
        : false
      const usable = data !== null && data.available === true
      const messageBlock = message.length === 0
        ? null
        : h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
          h(StateDot, { state: messageFailed ? 'error' : 'done' }),
          h('span', { className: 'omb-note' }, message))

      return h('div', { className: 'omb-scroll' },
        h('p', { className: 'omb-note' },
          '这里管理的是你自己的会话隐私模式。模型工具没有隐私入口；页面上的写入只来自你点击的按钮。sealed 下模型读不到记忆，但本页面仍可读。'),
        !data
          ? h(LoadState, { loading, error, data, label: '隐私设置' })
          : h(React.Fragment, null,
            !data.available
              ? h('p', { className: 'omb-error', role: 'alert' }, `隐私管理不可用：${data.reason || '未知原因'}`)
              : null,
            messageBlock,
            h('div', { className: 'omb-grid' },
              h(Card, {
                label: '基线', value: modeText(data.baseline.mode),
                note: `${originText(data.baseline.origin)} · ${data.baseline.detail}`,
                state: data.baseline.origin === 'fail-closed' ? 'warning' : 'idle',
              }),
              h(Card, {
                label: '当前会话',
                value: data.current ? modeText(data.current.mode) : '未知',
                note: data.current
                  ? `${originText(data.current.origin)}`
                    + (data.current.inheritedFrom ? ` · 继承自 ${shortId(data.current.inheritedFrom, 28)}` : '')
                    + ` · ${shortId(data.current.sessionId, 34)}`
                    + (data.current.parentSessionId ? ` · 父 ${shortId(data.current.parentSessionId, 28)}` : '')
                  : '宿主未提供当前会话标识（不猜）',
                state: data.current ? (data.current.mode === 'normal' ? 'done' : 'warning') : 'idle',
              }),
              h(Card, {
                label: '状态文件',
                value: data.durable.ok ? '可读写' : '降级/未持久化',
                note: data.durable.path
                  ? `${data.durable.path}${data.durable.savedAt ? `（最近写入 ${formatTime(data.durable.savedAt)}）` : ''}`
                  : data.durable.detail,
                state: data.durable.ok ? 'done' : 'error',
              }),
              h(Card, {
                label: '受限会话',
                value: data.restricted === null
                  ? '未测量'
                  : `${data.restricted.active} 活跃 / ${data.restricted.history} 历史`,
                note: data.restricted === null
                  ? '读会话运行态失败：不写 0，按未测量处理'
                  : '只有本进程活跃的受限会话会掐住"归属未知"的写',
                state: data.restricted === null ? 'warning' : (data.restricted.active > 0 ? 'warning' : 'idle'),
              })),
            h('div', { className: 'omb-section' },
              h('p', { className: 'omb-section-title' }, '给当前会话设模式'),
              data.current
                ? h('div', { className: 'omb-priv-actions' },
                  h(SegmentedControl, {
                    id: 'omb-priv-current', label: '当前会话模式', value: currentMode,
                    options: PRIVACY_MODES, disabled: busy,
                    onChange: (next) => setPendingMode(next),
                  }),
                  h(Button, {
                    variant: 'primary', size: 'sm', disabled: busy,
                    onClick: () => act({ action: 'set', sessionId: data.current.sessionId, mode: currentMode }),
                  }, '应用'),
                  h('span', { className: 'omb-note' }, '分段控件先显示当前档位；改动后点“应用”才写入。立即生效：库访问边界按新档位拒绝读/写。'))
                : h('p', { className: 'omb-note' }, '当前会话未知：可用下方"按会话 id 设置"。')),
            h('div', { className: 'omb-section' },
              h('p', { className: 'omb-section-title' }, '按会话 id 设置'),
              h('div', { className: 'omb-priv-actions' },
                h(Input, {
                  className: 'omb-search', value: sessionId,
                  placeholder: '会话 id（如 session-…）', 'aria-label': '会话 id',
                  disabled: busy || !usable,
                  onChange: (event) => setSessionId(event.target.value),
                }),
                h(SegmentedControl, {
                  id: 'omb-priv-session', label: '指定会话模式', value: sessionMode,
                  options: PRIVACY_MODES, disabled: busy || !usable,
                  onChange: (next) => setSessionMode(next),
                }),
                h(Button, {
                  variant: 'outline', size: 'sm', disabled: busy || !usable || sessionId.trim().length === 0,
                  onClick: () => act({ action: 'set', sessionId: sessionId.trim(), mode: sessionMode }),
                }, '设置'),
                h('span', { className: 'omb-note' }, '用于已结束会话或不便切换的会话；id 必须与宿主实际会话一致，写错的 id 不会影响现有会话。'))),
            h('div', { className: 'omb-section' },
              h('p', { className: 'omb-section-title' }, `有显式设置的会话（${data.sessions.length}）`),
              data.sessions.length === 0
                ? h('p', { className: 'omb-note' }, '没有显式设置：所有会话都走继承/基线。')
                : h('div', { className: 'omb-list' },
                  ...data.sessions.map((entry, index) => h('div', {
                    key: entry.sessionId,
                    className: 'omb-priv-row',
                    'data-inheritance': entry.inheritanceSource ? 'true' : 'false',
                  },
                    h('div', { className: 'omb-meta' },
                      h('span', { className: 'omb-code' }, shortId(entry.sessionId, 40)),
                      h(Tag, { tone: entry.mode === 'sealed' ? 'danger' : entry.mode === 'read-only' ? 'warning' : 'neutral' }, modeText(entry.mode)),
                      h(Tag, { tone: entry.active ? 'success' : 'quiet' }, entry.active ? '活跃' : '已结束'),
                      entry.inheritanceSource ? h(Tag, { tone: 'info' }, '活跃会话的继承来源') : null,
                      entry.parentSessionId ? h('span', null, `父 ${shortId(entry.parentSessionId, 28)}`) : null,
                      h('span', null, formatTime(entry.updatedAt))),
                    h('div', { className: 'omb-priv-actions' },
                      h(SegmentedControl, {
                        id: `omb-priv-row-${index}`, label: `会话 ${shortId(entry.sessionId, 20)} 模式`,
                        value: entry.mode, options: PRIVACY_MODES, disabled: busy,
                        onChange: (next) => act({ action: 'set', sessionId: entry.sessionId, mode: next }),
                      }),
                      h(Button, {
                        variant: 'ghost', size: 'sm', disabled: busy,
                        onClick: () => act({ action: 'clear', sessionId: entry.sessionId }),
                      }, '清除记录'),
                      h('span', { className: 'omb-note' },
                        entry.inheritanceSource
                          ? '活跃子会话正从这里继承，清除会放宽它们（页面不替你决定，请先确认）。'
                          : '清除后回到继承/基线。')))))),

            h('div', { className: 'omb-section' },
              h('p', { className: 'omb-section-title' }, '危险操作'),
              h('div', { className: 'omb-actions' },
                h(Button, {
                  variant: 'outline', size: 'sm', disabled: busy || !usable || !canBulkClear,
                  onClick: () => setConfirm('clear-inactive'),
                }, '清理已结束会话的受限记录…'),
                failClosed
                  ? h(Button, {
                    variant: 'outline', size: 'sm', disabled: busy || !usable,
                    onClick: () => setConfirm('trust'),
                  }, '解除 fail-closed 兜底…')
                  : null),
              h('p', { className: 'omb-note' },
                '「清理已结束会话」只删已结束且不是活跃会话继承来源的记录；活跃会话与继承来源原样保留。'
                + '「解除 fail-closed」清除状态文件读不出时的粘性兜底标记——只有确认状态文件已修好才该点。')),
            h('div', { className: 'omb-section' },
              h('p', { className: 'omb-section-title' }, '命令面与拒绝计数'),
              h('p', { className: 'omb-note' },
                `${data.commands.privacy} / ${data.commands.clean}：${data.commands.state}`),
              h('p', { className: 'omb-note' },
                `判定 ${data.stats.decisions} 次 · 读拒绝 ${data.stats.readDenials} · 写拒绝 ${data.stats.writeDenials}`
                + ` · 归属未知写拒绝 ${data.stats.unattributedWriteDenials}`
                + (data.stats.lastDeniedSession ? ` · 最近被拒会话 ${shortId(data.stats.lastDeniedSession, 34)}` : '')),
              h('p', { className: 'omb-note' },
                '变更记录写入隐私状态文件（重启后同一会话仍生效）；命令回执与这里共用同一实现。')),
            h('div', { className: 'omb-actions' },
              h(Button, {
                variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16 }),
                disabled: busy, onClick: () => void load(),
              }, '刷新'),
              h('span', { className: 'omb-note' },
                data.current ? `当前会话 ${shortId(data.current.sessionId, 40)} · ${modeText(data.current.mode)}` : '当前会话未知')),
            h(Modal, {
              open: confirm !== '',
              onClose: () => setConfirm(''),
              title: confirm === 'trust' ? '解除 fail-closed 兜底？' : '清理已结束会话的受限记录？',
              closeLabel: '取消',
              description: confirm === 'trust'
                ? '这会清除状态文件读不出时的粘性兜底标记（基线回到 normal）。请确认状态文件已修好，或确实不再需要保留旧限制。'
                : '只会删除已结束、且不是活跃会话继承来源的记录；活跃会话与继承来源保持原样。',
              footer: h('div', { className: 'omb-modal-actions' },
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm('') }, '取消'),
                h(Button, {
                  variant: 'primary', size: 'sm', disabled: busy,
                  onClick: () => act({ action: confirm === 'trust' ? 'trust' : 'clear-inactive' }),
                }, '确认执行')),
            })))
    }

    function RuntimeView() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          setData(await api('/runtime'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => { void load() }, [load])
      if (loading && !data) return h(Loading, { label: '读取运行时读数…' })
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-note' }, '暂无读数')
      const controller = data.controller || {}
      const capture = data.capture || {}
      const activity = data.activity
      const situation = data.situation
      return h('div', { className: 'omb-scroll' },
        h('div', { className: 'omb-grid' },
          h(Card, { label: 'OMB 版本', value: data.version || '未知' }),
          h(Card, {
            label: '记忆库', value: data.stores.ready ? '就绪' : '未就绪',
            state: data.stores.ready ? 'done' : 'error',
            note: `项目库 ${data.stores.openProjects.length}/${data.stores.maxOpenProjects}`,
          }),
          data.privacy
            ? h(Card, {
              label: '隐私闸门', value: data.privacy.allowWrite ? '可写' : '禁写',
              state: data.privacy.allowWrite ? 'done' : 'warning',
              note: data.privacy.reason || '无原因',
            })
            : null),
        situation
          ? h('div', { className: 'omb-section' },
            h('p', { className: 'omb-section-title' }, '会话状态机'),
            h('div', { className: 'omb-meta' },
              h(Tag, { tone: 'outline' }, situation.state || '未知'),
              situation.tier ? h(Tag, { tone: 'quiet' }, situation.tier) : null,
              h('span', { className: 'omb-code' }, situation.sessionId || '未知会话'),
              h('span', null, `第 ${situation.turn ?? '?'} 回合`),
              h('span', null, `空闲 ${typeof situation.idleMs === 'number' ? `${Math.round(situation.idleMs / 1000)}s` : '未知'}`),
              situation.interrupted ? h(Tag, { tone: 'danger' }, '已中断') : null,
              situation.unresolved ? h(Tag, { tone: 'warning' }, '未解决') : null),
            situation.lastTurnEndReason ? h('p', { className: 'omb-note' }, `上回合结局：${situation.lastTurnEndReason}`) : null,
            h('p', { className: 'omb-note' },
              `目标 ${situation.goals ? `${situation.goals.open}/${situation.goals.total}` : '未知'}`
              + ` · 待办 ${situation.todos ? `${situation.todos.open}/${situation.todos.total}` : '未知'}`),
            situation.workspace
              ? h('p', { className: 'omb-note' },
                `工作区 ${situation.workspace.root || '未知'}`
                + ` · 本会话切换 ${situation.workspace.switches ?? 0} 次`
                + (situation.workspace.previousRoot ? ` · 上一处 ${situation.workspace.previousRoot}` : ''))
              : null)
          : h('p', { className: 'omb-note' }, '会话状态未接线（session-state 服务不可用）。'),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '事件控制器'),
          h('p', { className: 'omb-note' },
            `模式 ${controller.mode || '未知'} · 事件 ${controller.events ?? 0} · persist ${controller.persist ?? 0}`
            + `（写入 ${controller.persisted ?? 0} / 查回失败 ${controller.verifyFailed ?? 0}）`
            + ` · 幂等跳过 ${controller.duplicateActions ?? 0}`)),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '捕获与主动性'),
          h('p', { className: 'omb-note' },
            `偏好写入 ${capture.preferences ?? 0} · 失败 ${capture.failed ?? 0}`
            + ` · 主动提示命中 ${capture.proactiveCues ?? 0} / 跟进 ${capture.cueFollowUps ?? 0}`)),
        activity
          ? h('div', { className: 'omb-section' },
            h('p', { className: 'omb-section-title' }, `活动日志（${activity.total} 条，错误 ${activity.errors}）`),
            h('p', { className: 'omb-note' },
              Object.entries(activity.byKind || {}).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(' · ') || '无'),
            ...(activity.recent || []).map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'omb-meta' },
              h(Tag, { tone: 'quiet' }, entry.kind),
              h('span', null, entry.detail),
              h('span', null, formatTime(entry.at)))))
          : h('p', { className: 'omb-note' }, '活动日志未接线（旧装配）。'),
        h('div', { className: 'omb-actions' },
          h(Button, {
            variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16 }),
            onClick: () => void load(),
          }, '刷新')))
    }

    function ProfileView() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          setData(await api('/profile'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])
      React.useEffect(() => { void load() }, [load])
      if (loading && !data) return h(Loading, { label: '读取项目画像…' })
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-note' }, '暂无画像')
      if (!data.available) return h('p', { className: 'omb-note' }, `画像不可用：${data.reason || '未知原因'}`)
      const structure = data.structure || {}
      return h('div', { className: 'omb-scroll' },
        h('div', { className: 'omb-grid' },
          h(Card, { label: '项目根', value: data.root || '未知', note: data.root || '' }),
          h(Card, { label: 'cwd 相对根', value: data.cwdRel === '' ? '.' : data.cwdRel || '未知' }),
          h(Card, {
            label: '分支 / HEAD',
            value: `${data.branch || '未知'} / ${data.head ? String(data.head).slice(0, 12) : '未知'}`,
          })),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '顶层目录'),
          h('div', { className: 'omb-meta' },
            ...(structure.topDirs || []).map((dir) => h(Tag, { key: dir.name, tone: 'outline' }, `${dir.name}(${dir.files})`)))),
        h('div', { className: 'omb-section' },
          h('p', { className: 'omb-section-title' }, '文件索引'),
          h('div', { className: 'omb-list' },
            ...(structure.files || []).map((file) => h('div', { key: file.path, className: 'omb-file' },
              h('span', null, file.path),
              h('span', null, `${file.lines} 行 · ${file.symbols} 符号 · ${file.imports} 导入`))))),
        data.text
          ? h('div', { className: 'omb-section' },
            h('p', { className: 'omb-section-title' }, '画像摘要'),
            h('p', { className: 'omb-note' }, data.text))
          : null,
        h('div', { className: 'omb-actions' },
          h(Button, {
            variant: 'outline', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16 }),
            onClick: () => void load(),
          }, '刷新')))
    }

    function MemoryPanel() {
      const [page, setPage] = React.useState('overview')
      const [overview, setOverview] = React.useState(null)
      const [overviewError, setOverviewError] = React.useState('')
      const [overviewLoading, setOverviewLoading] = React.useState(true)

      const loadOverview = React.useCallback(async () => {
        setOverviewLoading(true)
        setOverviewError('')
        try {
          setOverview(await api('/overview'))
        } catch (failure) {
          setOverviewError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setOverviewLoading(false)
        }
      }, [])

      React.useEffect(() => { void loadOverview() }, [loadOverview])

      const active = NAV.find((entry) => entry.value === page) || NAV[0]
      const ready = overview !== null && overview.ready === true
      const statusState = overview === null ? (overviewError ? 'warning' : 'ongoing') : ready ? 'done' : 'error'
      const statusText = overview === null
        ? (overviewError ? '读数不可用' : '读取中')
        : ready ? '记忆库就绪' : '记忆库未就绪'
      const countOf = (value) => {
        if (overview === null) return ''
        if (value === 'candidates' && overview.totalCandidates > 0) return String(overview.totalCandidates)
        if (value === 'memory' && overview.totalActive > 0) return String(overview.totalActive)
        return ''
      }
      return h('div', { className: 'omb-page' },
        h('style', null, CSS),
        h('div', { className: 'omb-head' },
          h('div', { className: 'omb-brand' },
            h('span', { className: 'omb-brand-mark', 'aria-hidden': true }, h(MemoryIcon, { size: 20 })),
            h('div', null,
              h('h2', { className: 'omb-title' }, TITLE),
              h('p', { className: 'omb-sub' }, '记忆、候选、会话隐私与运行读数；页面只读，写操作只有你点击的按钮。'))),
          h('div', { className: 'omb-head-side' },
            h('span', { className: 'omb-meta' }, h(StateDot, { state: statusState }), statusText),
            h('span', { className: 'omb-head-note' }, '二级侧边栏 · 宽窗口详情在右侧展开'))),
        h('div', { className: 'omb-body' },
          h('nav', { className: 'omb-nav', 'aria-label': `${TITLE}导航` },
            ...NAV.map((entry) => {
              const count = countOf(entry.value)
              return h('button', {
                key: entry.value,
                type: 'button',
                className: 'omb-nav-cell',
                'aria-current': page === entry.value ? 'page' : undefined,
                title: entry.label,
                onClick: () => setPage(entry.value),
              },
              h(entry.icon, { size: 18, className: 'omb-nav-icon', 'aria-hidden': true }),
              h('span', { className: 'omb-nav-label' }, entry.label),
              count === ''
                ? null
                : h('span', { className: 'omb-nav-count' }, count))
            })),
          h('div', { className: 'omb-main' },
            h('div', {
              key: page,
              className: 'omb-page-in',
              role: 'region',
              'aria-label': active.label,
              style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' },
            },
            h('div', { className: 'omb-page-head' },
              h('h3', { className: 'omb-page-title' }, active.label),
              h('p', { className: 'omb-page-desc' }, PAGE_HINTS[page] || '')),
            page === 'overview'
              ? h(OverviewView, {
                data: overview, loading: overviewLoading, error: overviewError,
                onRefresh: () => void loadOverview(),
                onNavigate: (next) => setPage(next),
              })
              : page === 'privacy'
                ? h(PrivacyView)
                : page === 'runtime'
                  ? h(RuntimeView)
                  : page === 'profile'
                    ? h(ProfileView)
                    : h(LibraryView, {
                      key: page,
                      candidatesOnly: page === 'candidates',
                      onChanged: () => void loadOverview(),
                    })))))
    }

    function MemoryIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 20, height: size || 20, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: 'M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 7 18.5h2' }),
      h('path', { d: 'M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 17 18.5h-2' }),
      h('path', { d: 'M9 4.5V19.5M15 4.5V19.5M9 9h6M9 13h6M9 17h6' }))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20,
          label: () => TITLE,
        }, MemoryIcon))
      },
    }
  },
})
