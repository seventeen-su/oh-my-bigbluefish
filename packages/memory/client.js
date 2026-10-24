// OMB 设置面板（v4.18.0）——手写浏览器 bundle，不需要打包器。
//
// 设计约定（契约与理由见 DESIGN.md）：
// - 二级侧边栏导航 + 右侧内容，两者都是同 radius 的表面卡；页面底 layer-1；
// - 三级表面：导航/内容卡 layer-2，组内卡片 layer-3；不用“同底色 + 边框”；
// - 控件只用共享 primitives；只有导航/行/卡片三类自定义表面；
// - 选中用填充、不用蓝色描边；焦点环只出现在 :focus-visible；
// - 字号 20/15/13/14/12，间距 4/8/12/16/24，卡片 padding 16；
// - 页面 180ms、详情 220ms、刷新旋转、hover 120ms；reduced-motion 取消运动；
// - 文本选择：界面骨架不可选，记忆正文/id/路径/画像/审计可选；
// - 面向用户的短文案，技术细节折叠进“说明”。
window.__ModuleLoader__.load({
  id: '@omb/memory',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Input, Modal, Pill, Tag, SegmentedControl, StateDot, TextShimmer, DisclosureRow,
      IconCheckOutlineRegular, IconChecklistOutlineRegular, IconCloseOutlineRegular,
      IconDatabaseOutlineRegular, IconEditOutlineRegular, IconGaugeOutlineRegular,
      IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular,
      IconUserOutlineRegular, IconWarningOutlineRegular, IconWorkspaceTreeOutlineRegular,
    } = primitives
    const h = React.createElement

    const PANEL_ID = 'omb-memory'
    const API = '/omb/api'
    const TITLE = 'OMB 设置'

    const NAV = [
      { value: 'overview', label: '概览', icon: IconGaugeOutlineRegular },
      { value: 'memory', label: '记忆', icon: IconDatabaseOutlineRegular },
      { value: 'project', label: '项目', icon: IconWorkspaceTreeOutlineRegular },
      { value: 'personal', label: '个人画像', icon: IconUserOutlineRegular },
    ]
    const PAGE_HINTS = {
      overview: '记忆与运行状态',
      memory: '搜索、编辑与确认记忆',
      project: '按会话看工作区、深度与隐私',
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
    const PAGE_SIZE = 50

    const CSS = `
      .omb-page {
        container-type: inline-size; container-name: omb-panel;
        display: flex; flex-direction: column; box-sizing: border-box;
        height: 100%; min-height: 0; overflow: hidden;
        padding: 16px 20px; gap: 12px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-family, inherit);
      }
      .omb-head {
        flex: none; display: flex; flex-wrap: wrap; align-items: center;
        justify-content: space-between; gap: 4px 16px; padding: 0 4px;
        user-select: none;
      }
      .omb-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
      .omb-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

      .omb-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; }
      .omb-nav {
        flex: none; width: 52px; box-sizing: border-box; padding: 6px;
        display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
        background: var(--dsw-alias-bg-layer-2);
        border-radius: var(--dsw-radius-lg);
        box-shadow: var(--dsw-elevation-panel);
        user-select: none;
      }
      .omb-nav-cell {
        display: flex; align-items: center; gap: 10px; min-height: 40px; width: 100%;
        padding: 8px 9px; box-sizing: border-box;
        border: none; border-radius: var(--dsw-radius-md); background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 13px; line-height: 20px; font-weight: 500;
        text-align: left; cursor: pointer;
        transition: background-color 120ms var(--ds-ease-in-out, ease-out);
      }
      .omb-nav-cell:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
      .omb-nav-cell[aria-current='page'] { background: var(--dsw-specific-sidebar-nav-item-active); }
      .omb-nav-cell:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 1px;
      }
      .omb-nav-icon { flex: none; }
      .omb-nav-label { display: none; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

      .omb-content {
        flex: 1 1 auto; min-width: 0; min-height: 0; box-sizing: border-box;
        display: flex; flex-direction: column; gap: 12px; padding: 16px;
        background: var(--dsw-alias-bg-layer-2);
        border-radius: var(--dsw-radius-lg);
        box-shadow: var(--dsw-elevation-panel);
      }
      .omb-content-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; user-select: none; }
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
      .omb-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .omb-section-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; user-select: none; }
      .omb-grid { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .omb-card {
        display: flex; flex-direction: column; gap: 4px; min-width: 0;
        padding: 16px; box-sizing: border-box;
        background: var(--dsw-alias-bg-layer-3);
        border-radius: var(--dsw-radius-md);
        box-shadow: var(--dsw-elevation-soft);
      }
      .omb-card-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-card-value { font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
      .omb-card-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .omb-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
      .omb-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
      .omb-code { font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px; user-select: text; }
      .omb-selectable { user-select: text; }
      .omb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-search { flex: 1 1 220px; min-width: 150px; }
      .omb-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

      .omb-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 18px 16px; background: var(--dsw-alias-bg-layer-3); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-elevation-soft); user-select: none; }
      .omb-empty-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; }
      .omb-empty-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-loading { display: inline-flex; align-items: center; gap: 6px; }

      .omb-workspace { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
      .omb-list-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
      .omb-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
      .omb-row {
        display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0;
        padding: 10px 12px; box-sizing: border-box;
        border: none; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
        transition: background-color 120ms var(--ds-ease-in-out, ease-out);
      }
      .omb-row:last-child { border-bottom: none; }
      .omb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-row[data-active='true'] { background: var(--dsw-specific-sidebar-nav-item-active); }
      .omb-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
      .omb-row[data-disabled='true'] { opacity: 0.5; cursor: default; }
      .omb-row-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .omb-row-text { margin: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
      .omb-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); user-select: none; }
      .omb-row-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .omb-detail-pane { position: absolute; inset: 0; z-index: 2; display: flex; min-width: 0; min-height: 0;
        transform: translateX(100%); opacity: 0; visibility: hidden;
        transition: transform 220ms var(--ds-ease-in-out, ease-out), opacity 180ms var(--ds-ease-in-out, ease-out), visibility 0s linear 220ms;
      }
      .omb-workspace[data-detail='open'] > .omb-detail-pane { transform: none; opacity: 1; visibility: visible; transition-delay: 0s; }
      .omb-detail { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
        padding: 16px; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3); border-radius: var(--dsw-radius-md);
        box-shadow: var(--dsw-elevation-soft);
      }
      .omb-detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-detail-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; user-select: none; }
      .omb-detail-text { margin: 0; font-size: 14px; line-height: 22px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
      .omb-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .omb-field { display: flex; flex-direction: column; gap: 6px; }
      .omb-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); user-select: none; }
      .omb-textarea {
        width: 100%; min-height: 108px; box-sizing: border-box; resize: vertical;
        padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px;
        user-select: text;
      }
      .omb-textarea:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
      .omb-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .omb-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; box-sizing: border-box;
        background: var(--dsw-alias-bg-layer-3); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-elevation-soft); user-select: none;
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

      @container omb-panel (min-width: 600px) {
        .omb-page { padding: 20px 24px; gap: 16px; }
        .omb-nav { width: 190px; padding: 10px 8px; }
        .omb-nav-label { display: block; }
        .omb-content { padding: 20px; gap: 16px; }
        .omb-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
      @container omb-panel (min-width: 820px) {
        .omb-workspace { flex-direction: row; align-items: stretch; gap: 16px; }
        .omb-list-pane { flex: 1 1 auto; }
        .omb-detail-pane { position: static; inset: auto; z-index: auto;
          flex: 0 0 0; opacity: 0; visibility: visible; transform: translateX(8px);
          transition: flex-basis 220ms var(--ds-ease-in-out, ease-out), opacity 180ms var(--ds-ease-in-out, ease-out), transform 220ms var(--ds-ease-in-out, ease-out);
        }
        .omb-workspace[data-detail='open'] > .omb-detail-pane { flex-basis: 52%; opacity: 1; transform: none; }
      }
      @container omb-panel (max-width: 520px) {
        .omb-page { padding: 12px; gap: 10px; }
        .omb-nav { width: 48px; padding: 4px; }
        .omb-content { padding: 12px; }
        .omb-grid { grid-template-columns: minmax(0, 1fr); }
        .omb-nav-cell { min-height: 42px; padding: 6px; justify-content: center; }
      }
      @media (pointer: coarse) { .omb-nav-cell, .omb-row { min-height: 44px; } }
      @media (prefers-reduced-motion: reduce) {
        .omb-page-forward, .omb-page-back { animation: none; }
        .omb-spin { animation: none; }
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

    function modeText(mode) { return MODE_TEXT[mode] || String(mode || '未知') }
    function originText(origin) { return ORIGIN_TEXT[origin] || String(origin || '未知') }
    function depthText(depth) { return DEPTH_TEXT[depth] || (depth ? String(depth) : '默认') }

    function Loading({ label }) {
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

    function StatCard({ label, value, note, state }) {
      return h('div', { className: 'omb-card' },
        h('span', { className: 'omb-card-label' }, label),
        state === undefined ? h('span', { className: 'omb-card-value' }, value) : h('span', { className: 'omb-meta' }, h(StateDot, { state }), value),
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
        setLoading(true)
        setError('')
        void Promise.resolve().then(loader).then((value) => {
          if (alive) setData(value)
        }, (failure) => {
          if (alive) setError(messageOf(failure))
        }).finally(() => {
          if (alive) setLoading(false)
        })
        return () => { alive = false }
      }, [...deps, tick])
      return { data, error, loading, reload: () => setTick((value) => value + 1) }
    }

    // ── 概览：记忆 + 运行状态 ────────────────────────────────────────
    function OverviewPage({ onNavigate, refreshTick }) {
      const overview = useLoad(() => api('/overview'), [refreshTick])
      const runtime = useLoad(() => api('/runtime'), [refreshTick])
      const data = overview.data
      const rt = runtime.data
      const ready = data ? data.ready : null
      const limited = data ? data.stores.some((store) => store.scanLimited) : false
      const statusState = overview.error ? 'warning' : ready === null ? 'ongoing' : ready ? 'done' : 'error'
      const statusText = overview.error ? '记忆库不可用' : ready === null ? '读取中' : ready ? '记忆库就绪' : '记忆库未就绪'
      const activity = rt && rt.activity
      const runtimeSummary = rt
        ? `${rt.version} · 控制器 ${rt.controller ? rt.controller.mode : '未知'}${activity ? ` · 活动 ${activity.total} 条` : ''}`
        : '读取中'
      return h('div', { className: 'omb-scroll' },
        h('div', { className: 'omb-grid' },
          h(StatCard, { label: '记忆库', value: statusText, state: statusState, note: data && data.detail ? data.detail : '' }),
          h(StatCard, { label: '活跃条目', value: data ? String(data.totalActive) : '—', note: limited ? '统计最近 500 条' : '全部已打开库' }),
          h(StatCard, { label: '待确认', value: data ? String(data.totalCandidates) : '—', note: data && data.totalCandidates > 0 ? '去“记忆”里处理' : '没有待确认' }),
          h(StatCard, { label: '项目库', value: data ? `${data.openProjects.length}/${data.maxOpenProjects}` : '—', note: data && data.openProjects.length > 0 ? data.openProjects[0] : '无' })),
        h(Section, {
          title: '记忆分布',
          aside: limited ? h('span', { className: 'omb-toolbar-note' }, '统计最近 500 条') : null,
        }, !data
          ? (overview.loading ? h(Loading, { label: '读取概览…' }) : overview.error ? h(ErrorLine, null, `读取失败：${overview.error}`) : h(Empty, { title: '还没有数据', hint: '在一个会话里开始对话后回来看看。' }))
          : data.stores.length === 0
            ? h(Empty, { title: '还没有打开记忆库', hint: '进入一个会话后会自动准备用户库和项目库。' })
            : h('div', null, ...data.stores.map((store) => h('div', {
              key: `${store.scope}:${store.projectScope || ''}`,
              className: 'omb-row',
              style: { cursor: 'default' },
            },
            h('div', { className: 'omb-row-meta' },
              h(Tag, { tone: 'outline' }, store.scope === 'user' ? '用户库' : '项目库'),
              h('span', null, store.projectScope || '用户库')),
            h('div', { className: 'omb-row-meta' },
              h('span', null, `行 ${store.stats.rows}`),
              h('span', null, `活跃 ${store.active}`),
              h('span', null, `待确认 ${store.candidates}`)))))),
        h(Collapsible, { icon: h(IconGaugeOutlineRegular, { size: 16 }), title: '运行状态', summary: runtimeSummary },
          rt
            ? h('div', { className: 'omb-grid' },
              h(StatCard, { label: '版本', value: rt.version || '未知' }),
              h(StatCard, { label: '隐私闸门', value: rt.privacy ? (rt.privacy.allowWrite ? '可写' : '禁写') : '未知', state: rt.privacy ? (rt.privacy.allowWrite ? 'done' : 'warning') : 'idle', note: rt.privacy ? rt.privacy.reason : '未接线' }),
              h(StatCard, { label: '事件控制器', value: rt.controller ? rt.controller.mode : '未知', note: rt.controller ? `${rt.controller.events || 0} 事件 · 写入 ${rt.controller.persisted || 0}` : '' }),
              h(StatCard, { label: '主动提示', value: rt.capture ? String(rt.capture.proactiveCues || 0) : '0', note: rt.capture ? `跟进 ${rt.capture.cueFollowUps || 0} 次` : '' }))
            : runtime.loading ? h(Loading, { label: '读取运行状态…' }) : runtime.error ? h(ErrorLine, null, `运行状态读取失败：${runtime.error}`) : null),
        activity
          ? h(Section, { title: `最近活动（${activity.total} 条）` },
            h('div', null, ...(activity.recent || []).map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'omb-row', style: { cursor: 'default' } },
              h('div', { className: 'omb-row-meta' }, h(Tag, { tone: 'quiet' }, entry.kind), h('span', null, formatTime(entry.at))),
              h('p', { className: 'omb-row-text omb-selectable' }, entry.detail)))))
          : null,
        h('div', { className: 'omb-actions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconDatabaseOutlineRegular, { size: 16 }), onClick: () => onNavigate('memory') }, '去记忆'),
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconWorkspaceTreeOutlineRegular, { size: 16 }), onClick: () => onNavigate('project') }, '去项目')))
    }

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
      const [page, setPage] = React.useState(0)
      const [truncated, setTruncated] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const queryRef = React.useRef('')
      const first = React.useRef(true)

      React.useEffect(() => {
        let alive = true
        setLoading(true)
        setError('')
        void api('/list', { q: queryRef.current, scope, status, kind, limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((data) => {
          if (!alive) return
          setItems(data.items || [])
          setTruncated(data.truncated === true)
        }, (failure) => {
          if (alive) setError(messageOf(failure))
        }).finally(() => {
          if (alive) setLoading(false)
        })
        return () => { alive = false }
      }, [scope, status, kind, tick, refreshTick, page])

      React.useEffect(() => {
        if (first.current) { first.current = false; return undefined }
        const timer = setTimeout(() => { queryRef.current = queryInput; setPage(0); setTick((value) => value + 1) }, 260)
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
          h('div', { className: 'omb-toolbar' },
            h(Input, {
              className: 'omb-search', value: queryInput, placeholder: '搜索记忆', 'aria-label': '搜索记忆',
              onChange: (event) => setQueryInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                queryRef.current = queryInput
                setPage(0)
                setTick((value) => value + 1)
              },
            }),
            h(SegmentedControl, { id: 'omb-scope', label: '库', value: scope, options: SCOPES, onChange: (next) => { setScope(next); setPage(0) } }),
            h(SegmentedControl, { id: 'omb-status', label: '状态', value: status, options: STATUSES, onChange: (next) => { setStatus(next); setPage(0) } }),
            h(Button, {
              variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }),
              onClick: () => setForm({ mode: 'create' }),
            }, '新建')),
          h('div', { className: 'omb-toolbar' },
            h('span', { className: 'omb-pills' }, ...KINDS.map((entry) => h(Pill, {
              key: entry.value || 'all', active: kind === entry.value, onClick: () => { setKind(entry.value); setPage(0) },
            }, entry.label))),
            h(Button, {
              variant: 'ghost', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16, className: loading ? 'omb-spin' : undefined }),
              onClick: () => setTick((value) => value + 1), disabled: loading,
            }, '刷新'),
            h('span', { className: 'omb-toolbar-note', 'aria-live': 'polite' },
              loading ? h(TextShimmer, { active: true }, '读取中…') : `第 ${page + 1} 页 · 本页 ${items.length} 条`),
            h(Button, {
              variant: 'ghost', size: 'sm', disabled: loading || page === 0,
              onClick: () => setPage((value) => Math.max(0, value - 1)),
            }, '上一页'),
            h(Button, {
              variant: 'ghost', size: 'sm', disabled: loading || !truncated,
              onClick: () => setPage((value) => value + 1),
            }, '下一页')),
          notice
            ? h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
              h(StateDot, { state: notice.failed ? 'error' : 'done' }), h('span', { className: 'omb-note' }, notice.text))
            : null,
          error ? h(ErrorLine, null, `读取失败：${error}`) : null,
          h('div', { className: 'omb-list' },
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
              h('span', null, formatTime(item.observedAt))))))),
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
              setNotice({ text, failed: false })
              setTick((value) => value + 1)
            },
          })
          : null)
    }

    function MemoryDetail({ id, onClose, onEdit, onChanged }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
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
      if (loading || waiting) return h('div', { className: 'omb-detail' }, head, h(Loading, { label: '读取记忆…' }))
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
        setBusy(true); setNotice(null)
        void post('/memory', body).then((payload) => {
          setNotice({ text: payload.text || '完成', failed: false })
          setRevision((value) => value + 1)
          onChanged()
          if (closeAfter) onClose()
        }, (failure) => {
          setNotice({ text: messageOf(failure), failed: true })
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
        notice ? h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
          h(StateDot, { state: notice.failed ? 'error' : 'done' }), h('span', { className: 'omb-note' }, notice.text)) : null,
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
              h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => post('/resolve', { action: 'relate', fromId: id, toId: item.record.id }).then(() => { setNotice({ text: '已建立关联', failed: false }); onChanged() }, (failure) => setNotice({ text: messageOf(failure), failed: true })) }, '建立关联'),
              h(Button, { variant: 'outline', size: 'sm', disabled: busy, onClick: () => post('/resolve', { action: 'supersede', fromId: id, toId: item.record.id }).then(() => { setNotice({ text: '已标注取代', failed: false }); onChanged() }, (failure) => setNotice({ text: messageOf(failure), failed: true })) }, '本条取代该条')))))),
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
              setNotice({ text: `已用「${target.text.slice(0, 24)}…」取代这条`, failed: false })
              setRevision((value) => value + 1)
              onChanged()
            },
          })
          : null)
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
          setError(messageOf(failure))
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
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '库'),
        editing
          ? h('div', { className: 'omb-actions' }, h(Tag, { tone: 'outline' }, scope === 'user' ? '用户库' : '项目库'))
          : h(SegmentedControl, {
            id: 'omb-form-scope', label: '库', value: scope,
            options: [{ value: 'user', label: '用户库' }, { value: 'project', label: '项目库' }],
            onChange: setScope,
          })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '类型'),
        h(SegmentedControl, { id: 'omb-form-kind', label: '类型', value: kind, options: CREATABLE_KINDS, onChange: setKind })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '内容'),
        h('textarea', {
          className: 'omb-textarea', value: text, placeholder: '写下要记住的内容',
          onChange: (event) => setText(event.target.value),
        })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '标签（可选）'),
        h(Input, { value: tags, placeholder: '用逗号分隔，最多 8 个', onChange: (event) => setTags(event.target.value) })),
      error ? h(ErrorLine, null, error) : null)
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
      const [notice, setNotice] = React.useState(null)
      const [confirm, setConfirm] = React.useState('')
      const list = sessions.data && sessions.data.available ? sessions.data.items : null
      const current = privacy.data && privacy.data.current ? privacy.data.current.sessionId : null
      const selected = list ? list.find((item) => item.id === selectedId) || null : null

      React.useEffect(() => {
        if (selectedId !== null || list === null) return
        const preferred = list.find((item) => item.active && !item.archived) || list.find((item) => !item.archived) || list[0]
        if (preferred) setSelectedId(preferred.id)
      }, [list, selectedId])

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
        setBusy(true); setNotice(null)
        void post('/privacy', body).then((payload) => {
          setNotice({ text: payload.text || '完成', failed: false })
          privacy.reload(); sessions.reload()
        }, (failure) => {
          setNotice({ text: messageOf(failure), failed: true })
        }).finally(() => setBusy(false))
      }

      const listRows = list && list.length > 0
        ? h('div', { className: 'omb-list' }, ...list.map((item) => {
          const isArchived = item.archived
          return h('button', {
            key: item.id, type: 'button', className: 'omb-row',
            'data-active': item.id === selectedId,
            'data-disabled': isArchived,
            disabled: isArchived,
            onClick: () => { if (!isArchived) setSelectedId(item.id) },
          },
          h('span', { className: 'omb-row-title' }, item.title || baseName(item.cwd) || shortId(item.id)),
          h('span', { className: 'omb-row-meta' },
            isArchived ? h(Tag, { tone: 'quiet' }, '已归档') : item.active ? h(Tag, { tone: 'success' }, '进行中') : h(Tag, { tone: 'outline' }, '历史'),
            item.id === current ? h(Tag, { tone: 'info' }, '当前') : null,
            h('span', null, depthText(item.depth)),
            item.privacy ? h(Tag, { tone: item.privacy.mode === 'normal' ? 'neutral' : 'warning' }, modeText(item.privacy.mode)) : null),
          h('span', { className: 'omb-row-sub' }, item.root || item.cwd))
        }))
        : null

      const listBody = !sessions.data
        ? (sessions.loading ? h(Loading, { label: '读取会话…' }) : null)
        : !sessions.data.available
          ? h(Empty, { title: '暂时读不到会话目录', hint: sessions.data.reason || '宿主没有提供会话列表。' })
          : listRows || h(Empty, { title: '还没有大肥鱼模式的会话', hint: '在模式里选择大肥鱼后开始对话。' })

      const listPane = h('div', { className: 'omb-list-pane' },
        h('div', { className: 'omb-toolbar' },
          h('span', { className: 'omb-toolbar-note', 'aria-live': 'polite' },
            sessions.loading ? h(TextShimmer, { active: true }, '读取中…') : list ? `${list.length} 个会话` : ''),
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16, className: sessions.loading ? 'omb-spin' : undefined }), disabled: sessions.loading, onClick: sessions.reload }, '刷新')),
        sessions.error ? h(ErrorLine, null, `读取失败：${sessions.error}`) : null,
        listBody)

      const privacySection = selected && h(Section, { title: '会话设置' },
        h('div', { className: 'omb-actions' },
          h('span', { className: 'omb-field-label' }, '推理深度'),
          h(Tag, { tone: 'outline' }, depthText(selected.depth)),
          h('span', { className: 'omb-toolbar-note' }, '在会话里用 /omb-depth 修改')),
        h('div', { className: 'omb-actions' },
          h('span', { className: 'omb-field-label' }, '隐私模式'),
          h(SegmentedControl, {
            id: 'omb-session-privacy', label: '隐私模式',
            value: selected.privacy ? selected.privacy.mode : 'normal',
            options: MODE_OPTIONS, disabled: busy,
            onChange: (next) => act({ action: 'set', sessionId: selected.id, mode: next }),
          }),
          h('span', { className: 'omb-toolbar-note' }, selected.privacy ? `${originText(selected.privacy.origin)}${selected.privacy.inheritedFrom ? ' · 继承' : ''}` : '默认')))

      const profileSection = h(Section, { title: '工作区画像' },
        profileLoading ? h(Loading, { label: '读取画像…' })
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
          selected ? h(ControllerSection, { sessionId: selected.id }) : null,
          profileSection,
          privacyMaintenance)

      const detail = selected
        ? h('div', { className: 'omb-detail' },
          h('div', { className: 'omb-detail-head' },
            h('p', { className: 'omb-detail-title' }, selected.title || baseName(selected.cwd) || '会话'),
            selected.archived ? h(Tag, { tone: 'quiet' }, '已归档') : h(Tag, { tone: selected.active ? 'success' : 'outline' }, selected.active ? '进行中' : '历史')),
          h('div', { className: 'omb-meta' },
            h('span', { className: 'omb-code' }, selected.id),
            h('span', { className: 'omb-selectable' }, selected.root || selected.cwd),
            h('span', null, formatTime(selected.createdAt))),
          notice ? h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
            h(StateDot, { state: notice.failed ? 'error' : 'done' }), h('span', { className: 'omb-note' }, notice.text)) : null,
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

      return h('div', { className: 'omb-workspace', 'data-detail': selected ? 'open' : 'closed' }, listPane, aside, modal)
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
    function ControllerSection({ sessionId }) {
      const [tick, setTick] = React.useState(0)
      const resource = useLoad(() => api('/controller', { sessionId }), [sessionId, tick])
      const [task, setTask] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [confirm, setConfirm] = React.useState('')
      const view = resource.data
      const state = view && view.available ? view : null
      const act = (body) => {
        if (busy) return
        setBusy(true); setNotice(null)
        void post('/controller', { sessionId, ...body }).then((payload) => {
          setNotice({ text: payload.text || '已更新', failed: false })
          setTick((value) => value + 1)
        }, (failure) => {
          setNotice({ text: messageOf(failure), failed: true })
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
        notice
          ? h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
            h(StateDot, { state: notice.failed ? 'error' : 'done' }), h('span', { className: 'omb-note' }, notice.text))
          : null,
        resource.loading && !view ? h(Loading, { label: '读取状态机…' })
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
                    onChange: (event) => setTask(event.target.value),
                    onKeyDown: (event) => { if (event.key === 'Enter') addTask() },
                  }),
                  h(Button, { variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }), disabled: busy || task.trim().length === 0, onClick: addTask }, '添加任务')),
                state && state.tasks.length > 0
                  ? h('div', null, ...state.tasks.map((entry, index) => h('div', { key: `${entry.text}-${index}`, className: 'omb-card' },
                    h('p', { className: 'omb-row-text omb-selectable' }, entry.text),
                    h('div', { className: 'omb-meta' }, h('span', null, `到期 ${formatTime(entry.expiresAt)}`)),
                    h('div', { className: 'omb-actions' },
                      h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => act({ action: 'remove-task', text: entry.text }) }, '移除')))))
                  : h('p', { className: 'omb-note' }, '没有任务约束。'),
                state && state.candidates.length > 0
                  ? h('div', null, ...state.candidates.map((entry) => h('div', { key: entry.id, className: 'omb-card' },
                    h('p', { className: 'omb-row-text omb-selectable' }, entry.text),
                    h('div', { className: 'omb-meta' }, h(Tag, { tone: 'outline' }, entry.kind), h('span', null, entry.reason)),
                    h('div', { className: 'omb-actions' },
                      h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => act({ action: 'remove-candidate', text: entry.text }) }, '移除')))))
                  : h('p', { className: 'omb-note' }, '没有待确认候选。'),
                h('div', { className: 'omb-actions' },
                  h(Button, { variant: 'ghost', size: 'sm', disabled: busy || !state || state.tasks.length === 0, onClick: () => setConfirm('tasks') }, '清空任务'),
                  h(Button, { variant: 'ghost', size: 'sm', disabled: busy || !state || state.candidates.length === 0, onClick: () => setConfirm('candidates') }, '清空候选'))),
        h(Modal, {
          open: confirm !== '',
          onClose: () => setConfirm(''),
          title: confirm === 'tasks' ? '清空任务约束？' : '清空待确认候选？',
          closeLabel: '取消',
          description: '只影响当前会话的控制器状态，不改已写入的记忆。',
          footer: h('div', { className: 'omb-modal-actions' },
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirm('') }, '取消'),
            h(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => { setConfirm(''); act({ action: confirm === 'tasks' ? 'clear-tasks' : 'clear-candidates' }) } }, '清空')),
        }))
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
        void run.then((payload) => onSaved(payload.text || '已保存'), (failure) => setError(messageOf(failure)))
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
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '轴'),
        h(SegmentedControl, { id: 'omb-profile-axis', label: '轴', value: axis, options: PROFILE_AXES, onChange: setAxis })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '键'),
        h(Input, { value: key, placeholder: '例如：回答语言', 'aria-label': '画像键', onChange: (event) => setKey(event.target.value) })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '取值'),
        h('textarea', { className: 'omb-textarea', value, placeholder: '例如：中文', onChange: (event) => setValue(event.target.value) })),
      h('div', { className: 'omb-field' },
        h('span', { className: 'omb-field-label' }, '依据（可选）'),
        h(Input, { value: evidence, placeholder: '用；分隔', onChange: (event) => setEvidence(event.target.value) })),
      error ? h(ErrorLine, null, error) : null)
    }

    // ── 记忆生命周期：手动指定取代目标（v4.19） ───────────────────
    function SupersedeModal({ currentId, onClose, onDone }) {
      const resource = useLoad(() => api('/list', { status: 'active', scope: 'all', limit: 50 }), [])
      const [query, setQuery] = React.useState('')
      const [target, setTarget] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const options = (resource.data && resource.data.items ? resource.data.items : [])
        .filter((item) => item.id !== currentId && (query.trim().length === 0 || item.text.includes(query.trim())))
      const submit = () => {
        if (target === null || busy) return
        setBusy(true); setError('')
        void post('/resolve', { action: 'supersede', fromId: currentId, toId: target.id }).then(() => onDone(target), (failure) => setError(messageOf(failure)))
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
      resource.loading ? h(Loading, { label: '读取候选记忆…' })
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
      const [notice, setNotice] = React.useState(null)
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
        setBusy(true); setNotice(null)
        void post('/personal', { action: 'retract', axis: entry.axis, key: entry.key }).then((payload) => {
          setNotice({ text: payload.text || '已删除', failed: false })
          setRevision((value) => value + 1)
        }, (failure) => setNotice({ text: messageOf(failure), failed: true }))
          .finally(() => { setBusy(false); setConfirmDelete(null) })
      }

      const actionsRow = h('div', { className: 'omb-actions' },
        h(Button, { variant: 'primary', size: 'sm', icon: h(IconPlusOutlineRegular, { size: 16 }), onClick: () => setForm({ record: null }) }, '新增条目'),
        h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRefreshOutlineRegular, { size: 16, className: resource.loading ? 'omb-spin' : undefined }), disabled: resource.loading, onClick: resource.reload }, '刷新'))
      const noticeRow = notice
        ? h('div', { className: 'omb-notice', role: 'status', 'aria-live': 'polite' },
          h(StateDot, { state: notice.failed ? 'error' : 'done' }), h('span', { className: 'omb-note' }, notice.text))
        : null
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
        ? h(Empty, { title: '还没有个人画像', hint: '点“新增条目”写下你的长期偏好；聊到习惯后也会自动出现推断。' })
        : h(React.Fragment, null, ...grouped.map(([axis, entries]) => h(Section, { key: axis, title: (entries[0] && entries[0].axisLabel) || axis }, ...entries.map(entryCard))))
      const summary = data && data.text
        ? h(Collapsible, { icon: h(IconUserOutlineRegular, { size: 16 }), title: '画像摘要', summary: '' }, h('p', { className: 'omb-note omb-selectable' }, data.text))
        : null

      const content = !data
        ? (resource.loading ? h(Loading, { label: '读取个人画像…' }) : resource.error ? h(ErrorLine, null, `读取失败：${resource.error}`) : null)
        : !data.available
          ? h(Empty, { title: '个人画像暂不可用', hint: data.reason || '' })
          : h(React.Fragment, null, actionsRow, noticeRow, stats, conflicts, groups, summary)

      const formModal = form
        ? h(PersonalForm, {
          record: form.record,
          onClose: () => setForm(null),
          onSaved: (text) => {
            setForm(null)
            setNotice({ text, failed: false })
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

      return h('div', { className: 'omb-scroll' }, content, formModal, deleteModal)
    }

    function MemoryPanel() {
      const [page, setPage] = React.useState('overview')
      const [direction, setDirection] = React.useState(1)
      const [refreshTick, setRefreshTick] = React.useState(0)
      const overview = useLoad(() => api('/overview'), [page === 'overview'])
      const active = NAV.find((entry) => entry.value === page) || NAV[0]
      const go = (next) => {
        const from = NAV.findIndex((entry) => entry.value === page)
        const to = NAV.findIndex((entry) => entry.value === next)
        setDirection(to >= from ? 1 : -1)
        setPage(next)
      }
      const ready = overview.data ? overview.data.ready : null
      const statusState = overview.error ? 'warning' : ready === null ? 'ongoing' : ready ? 'done' : 'error'
      const statusText = overview.error ? '记忆库不可用' : ready === null ? '读取中' : ready ? '记忆库就绪' : '记忆库未就绪'
      return h('div', { className: 'omb-page' },
        h('style', null, CSS),
        h('div', { className: 'omb-head' },
          h('h2', { className: 'omb-title' }, TITLE),
          h('span', { className: 'omb-status' }, h(StateDot, { state: statusState }), statusText)),
        h('div', { className: 'omb-body' },
          h('nav', { className: 'omb-nav', 'aria-label': `${TITLE}导航` },
            ...NAV.map((entry) => h('button', {
              key: entry.value, type: 'button', className: 'omb-nav-cell',
              'aria-current': page === entry.value ? 'page' : undefined,
              title: entry.label,
              onClick: () => go(entry.value),
            },
            h(entry.icon, { size: 18, className: 'omb-nav-icon', 'aria-hidden': true }),
            h('span', { className: 'omb-nav-label' }, entry.label)))),
          h('div', { className: 'omb-content' },
            h('div', { className: 'omb-content-head' },
              h('div', null,
                h('h3', { className: 'omb-content-title' }, active.label),
                h('p', { className: 'omb-content-desc' }, PAGE_HINTS[page])),
              h('div', { className: 'omb-content-actions' },
                h(Button, {
                  variant: 'ghost', size: 'sm',
                  icon: h(IconRefreshOutlineRegular, { size: 16, className: overview.loading ? 'omb-spin' : undefined }),
                  disabled: overview.loading, onClick: () => { setRefreshTick((value) => value + 1); overview.reload() }, 'aria-label': '刷新',
                }, '刷新'))),
            h('div', { key: page, className: `omb-page-in ${direction > 0 ? 'omb-page-forward' : 'omb-page-back'}` },
              page === 'overview' ? h(OverviewPage, { onNavigate: go, refreshTick })
                : page === 'memory' ? h(MemoryPage, { refreshTick })
                  : page === 'project' ? h(ProjectPage, { refreshTick })
                    : h(PersonalPage, { refreshTick })))))
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

