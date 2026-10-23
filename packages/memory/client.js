// OMB 记忆管理侧边栏（v4.16.0）——手写浏览器 bundle，不需要打包器。
//
// UI/UX 规范（对齐 DSH web 的既有做法）：
// - 控件一律复用共享控件 `@deepseek-ai/dsh-client-ui-primitives`（Button/Input/Pill/
//   Tag/SegmentedTabs/SegmentedControl/StateDot），不自己造按钮、输入框或页签；
// - 颜色/圆角/字体一律走 `--dsw-*` 语义 token，不写死色值、不写死主题分支；
// - 布局用 flex/grid + `minmax(0, …)`，窄容器自动堆叠，不给固定宽高；
// - 状态文案通过 `aria-live` 播报；可交互行有可见焦点环。
//
// 数据面：宿主 `/omb/api`（只读 GET；写操作只有用户点击的 confirm/resolve）。
window.__ModuleLoader__.load({
  id: '@omb/memory',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Input, Pill, Tag, SegmentedTabs, SegmentedControl, StateDot,
    } = primitives
    const h = React.createElement

    const PANEL_ID = 'omb-memory'
    const API = '/omb/api'
    const TABS = [
      { value: 'overview', label: '概览' },
      { value: 'memory', label: '记忆库' },
      { value: 'candidates', label: '候选确认' },
      { value: 'runtime', label: '运行状态' },
      { value: 'profile', label: '项目画像' },
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

    const CSS = `
      .omb-page {
        display: flex; flex-direction: column; gap: 12px; box-sizing: border-box;
        height: 100%; min-height: 0; padding: 16px 20px; overflow: hidden;
        color: var(--dsw-alias-label-primary);
      }
      .omb-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
      .omb-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
      .omb-sub { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .omb-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .omb-card {
        display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 12px 14px;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
      }
      .omb-card-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-card-value { font-size: 16px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
      .omb-card-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .omb-sections { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; min-height: 0; }
      .omb-section-title { margin: 0 0 6px; font-size: 13px; line-height: 20px; font-weight: 600; }
      .omb-muted { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary)); }
      .omb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-toolbar .omb-search { flex: 1 1 220px; min-width: 160px; }
      .omb-workspace { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); min-height: 0; flex: 1 1 auto; }
      @media (min-width: 900px) {
        .omb-workspace { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); }
      }
      .omb-list { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; padding-right: 4px; }
      .omb-row {
        display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
        padding: 10px 12px; text-align: left; color: inherit; cursor: pointer;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: transparent; font: inherit;
      }
      .omb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .omb-row[data-active='true'] { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l4)); }
      .omb-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
      .omb-row-text { margin: 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
      .omb-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .omb-detail {
        display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; overflow-y: auto;
        padding: 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
      }
      .omb-detail-text { margin: 0; font-size: 13px; line-height: 22px; overflow-wrap: anywhere; white-space: pre-wrap; }
      .omb-files { display: flex; flex-direction: column; gap: 4px; }
      .omb-file { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .omb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .omb-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: pre-wrap; overflow-wrap: anywhere; }
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

    function StageTags({ item }) {
      const tone = item.stage === 'candidate' ? 'warning' : item.stage === 'confirmed' ? 'success' : 'outline'
      return [
        h(Tag, { key: 'kind', tone }, `${item.scope}/${item.kind}`),
        h(Tag, { key: 'stage', tone }, item.stageLabel || item.stage || '未知'),
        h(Tag, { key: 'by', tone: 'quiet' }, item.assertedBy),
      ]
    }

    function StateLine({ state, children }) {
      return h('span', { className: 'omb-meta' },
        h(StateDot, { state }),
        children)
    }

    function OverviewView({ data, loading, error, onRefresh }) {
      if (loading && !data) return h('p', { className: 'omb-muted' }, '读取中…')
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-muted' }, '暂无数据')
      return h('div', { className: 'omb-sections' },
        h('div', { className: 'omb-cards' },
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '记忆库'),
            h(StateLine, { state: data.ready ? 'done' : 'error' }, data.ready ? '就绪' : '未就绪'),
            h('span', { className: 'omb-card-note' }, data.detail || '无说明')),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '活跃条目'),
            h('span', { className: 'omb-card-value' }, String(data.totalActive)),
            data.stores.some((store) => store.scanLimited)
              ? h('span', { className: 'omb-card-note' }, '部分库只统计最近 500 行（非全量）')
              : null),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '候选条目'),
            h('span', { className: 'omb-card-value' }, String(data.totalCandidates)),
            data.stores.some((store) => store.scanLimited)
              ? h('span', { className: 'omb-card-note' }, '同上：扫描上限内计数')
              : null),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, `已打开项目库 ${data.openProjects.length}/${data.maxOpenProjects}`),
            h('span', { className: 'omb-card-note' }, data.openProjects.length > 0 ? data.openProjects.join('、') : '无'))),
        h('div', null,
          h('p', { className: 'omb-section-title' }, '各库'),
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
        h('div', { className: 'omb-actions' },
          h(Button, { variant: 'outline', size: 'sm', onClick: onRefresh }, '刷新'),
          h('span', { className: 'omb-note' }, '页面只读：确认候选用 /omb-confirm 或在候选页点按钮；手动裁决见记忆详情。'),
          data.stores.some((store) => store.scanLimited)
            ? h('span', { className: 'omb-note' }, '计数范围：每个库最近 500 行（库更大时见"部分库"提示）。')
            : null))
    }

    function MemoryWorkspace({ candidatesOnly, onChanged }) {
      const [items, setItems] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [status, setStatus] = React.useState('active')
      const [kind, setKind] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [revision, setRevision] = React.useState(0)
      const [loading, setLoading] = React.useState(false)
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

      // 输入防抖：旧实现每个按键都触发一次请求（query 是 load 的依赖）。
      // 现在输入只更新本地值，停顿 250ms 或按 Enter 才请求。
      React.useEffect(() => {
        if (firstQuery.current) {
          firstQuery.current = false
          return undefined
        }
        const timer = setTimeout(() => setRevision((value) => value + 1), 250)
        return () => clearTimeout(timer)
      }, [query])

      return h('div', { className: 'omb-workspace' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 } },
          candidatesOnly
            ? h('p', { className: 'omb-muted' }, '候选 = 模型推断写入、等待用户确认的条目。')
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
              h('span', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                ...KINDS.map((entry) => h(Pill, {
                  key: entry.value || 'all', active: kind === entry.value,
                  onClick: () => setKind(entry.value),
                }, entry.label)))),
          h('div', { className: 'omb-meta', 'aria-live': 'polite' },
            loading ? '读取中…' : `显示 ${items.length} / ${total} 条${total > items.length ? '（超出单页上限）' : ''}`),
          error ? h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`) : null,
          h('div', { className: 'omb-list' },
            items.length === 0 && !loading ? h('p', { className: 'omb-muted' }, '没有匹配条目') : null,
            ...items.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'omb-row',
              'data-active': item.id === selectedId,
              onClick: () => setSelectedId(item.id),
            },
            h('span', { className: 'omb-row-text' }, trims(item.text, 180)),
            h('span', { className: 'omb-meta' },
              ...StageTags({ item }),
              h('span', { key: 'time' }, formatTime(item.observedAt)),
              item.tags.length > 0 ? h('span', { key: 'tags' }, `#${item.tags.join(' #')}`) : null))))),
        h(DetailView, {
          id: selectedId,
          onChanged: () => { setRevision((value) => value + 1); if (onChanged) onChanged() },
        }))
    }

    function DetailView({ id, onChanged }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [actionText, setActionText] = React.useState('')
      const [revision, setRevision] = React.useState(0)

      React.useEffect(() => {
        // 关键修复：id 为空是「还没选条目」，不是错误——不发请求，也不再显示 400。
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

      if (loading) return h('div', { className: 'omb-detail' }, h('p', { className: 'omb-muted' }, '读取详情…'))
      if (error) return h('div', { className: 'omb-detail' }, h('p', { className: 'omb-error', role: 'alert' }, `详情读取失败：${error}`))
      if (!data) {
        return h('div', { className: 'omb-detail' },
          h('p', { className: 'omb-muted' }, id ? '未找到该条目（可能已被删除或属于其他库）。' : '从左侧选择一条记忆查看详情、审计与相关条目。'))
      }

      const record = data.record
      const canConfirm = record.stage === 'candidate' && record.kind !== 'episodic'
      const lastAudit = data.auditAvailable ? data.audit[0] : undefined
      const canUndo = data.auditAvailable && record.stage === 'confirmed'
        && lastAudit !== undefined && lastAudit.action === 'confirm'
      const isFailedText = /失败|未确认|未撤销|未执行|无法/.test(actionText)

      return h('div', { className: 'omb-detail' },
        h('div', { className: 'omb-actions' },
          ...StageTags({ item: record }),
          h('span', { className: 'omb-meta' }, record.id)),
        h('p', { className: 'omb-detail-text' }, record.text),
        h('div', { className: 'omb-meta' },
          h('span', null, `来源 ${record.sourceRef}`),
          h('span', null, formatTime(record.observedAt)),
          record.projectScope ? h('span', null, `项目 ${record.projectScope}`) : null,
          record.tags.length > 0 ? h('span', null, `标签 ${record.tags.join('、')}`) : null),
        record.validTo === null && record.supersededBy === null
          ? null
          : h('p', { className: 'omb-muted' },
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
        h('div', null,
          h('p', { className: 'omb-section-title' }, `确认审计（${data.auditAvailable ? data.audit.length : '不可读'}）`),
          data.auditAvailable
            ? (data.audit.length === 0
              ? h('p', { className: 'omb-muted' }, '没有经 /omb-confirm 的记录。')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                ...data.audit.map((entry, index) => h('div', { key: `${entry.action}-${entry.at}-${index}`, className: 'omb-meta' },
                  h(Tag, { tone: entry.action === 'undo' ? 'warning' : 'success' }, entry.action === 'undo' ? '撤销' : '确认'),
                  h('span', null, formatTime(entry.at)),
                  h('span', null, entry.sessionId ? `会话 ${entry.sessionId}` : '无会话')))))
            : h('p', { className: 'omb-muted' }, '该库没有确认审计面（旧实现），无法证明确认历史。')),
        h('div', null,
          h('p', { className: 'omb-section-title' }, `可能相关 / 冲突（${data.related.length}）`),
          data.related.length === 0
            ? h('p', { className: 'omb-muted' }, '没有共享实体键的活跃条目。')
            : h('div', { className: 'omb-list', style: { maxHeight: 260 } },
              ...data.related.map((item) => h('div', {
                key: item.record.id,
                className: 'omb-card',
              },
              h('p', { className: 'omb-row-text' }, item.record.text),
              h('div', { className: 'omb-meta' },
                h('span', null, item.record.id),
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

    function RuntimeView() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
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
      if (loading && !data) return h('p', { className: 'omb-muted' }, '读取运行时读数…')
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-muted' }, '暂无读数')
      const controller = data.controller || {}
      const capture = data.capture || {}
      const activity = data.activity
      const situation = data.situation
      return h('div', { className: 'omb-sections' },
        h('div', { className: 'omb-cards' },
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, 'OMB 版本'),
            h('span', { className: 'omb-card-value' }, data.version || '未知')),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '记忆库'),
            h(StateLine, { state: data.stores.ready ? 'done' : 'error' }, data.stores.ready ? '就绪' : '未就绪'),
            h('span', { className: 'omb-card-note' }, `项目库 ${data.stores.openProjects.length}/${data.stores.maxOpenProjects}`)),
          data.privacy
            ? h('div', { className: 'omb-card' },
              h('span', { className: 'omb-card-label' }, '隐私闸门'),
              h(StateLine, { state: data.privacy.allowWrite ? 'done' : 'warning' }, data.privacy.allowWrite ? '可写' : '禁写'),
              h('span', { className: 'omb-card-note' }, data.privacy.reason || '无原因'))
            : null),
        situation
          ? h('div', null,
            h('p', { className: 'omb-section-title' }, '会话状态机'),
            h('div', { className: 'omb-meta' },
              h(Tag, { tone: 'outline' }, situation.state || '未知'),
              situation.tier ? h(Tag, { tone: 'quiet' }, situation.tier) : null,
              h('span', null, situation.sessionId || '未知会话'),
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
          : h('p', { className: 'omb-muted' }, '会话状态未接线（session-state 服务不可用）。'),
        h('div', null,
          h('p', { className: 'omb-section-title' }, '事件控制器'),
          h('p', { className: 'omb-note' },
            `模式 ${controller.mode || '未知'} · 事件 ${controller.events ?? 0} · persist ${controller.persist ?? 0}`
            + `（写入 ${controller.persisted ?? 0} / 查回失败 ${controller.verifyFailed ?? 0}）`
            + ` · 幂等跳过 ${controller.duplicateActions ?? 0}`)),
        h('div', null,
          h('p', { className: 'omb-section-title' }, '捕获与主动性'),
          h('p', { className: 'omb-note' },
            `偏好写入 ${capture.preferences ?? 0} · 失败 ${capture.failed ?? 0}`
            + ` · 主动提示命中 ${capture.proactiveCues ?? 0} / 跟进 ${capture.cueFollowUps ?? 0}`)),
        activity
          ? h('div', null,
            h('p', { className: 'omb-section-title' }, `活动日志（${activity.total} 条，错误 ${activity.errors}）`),
            h('p', { className: 'omb-note' },
              Object.entries(activity.byKind || {}).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(' · ') || '无'),
            ...(activity.recent || []).map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'omb-meta' },
              h(Tag, { tone: 'quiet' }, entry.kind),
              h('span', null, entry.detail),
              h('span', null, formatTime(entry.at)))))
          : h('p', { className: 'omb-muted' }, '活动日志未接线（旧装配）。'),
        h('div', { className: 'omb-actions' },
          h(Button, { variant: 'outline', size: 'sm', onClick: () => void load() }, '刷新')))
    }

    function ProfileView() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
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
      if (loading && !data) return h('p', { className: 'omb-muted' }, '读取项目画像…')
      if (error) return h('p', { className: 'omb-error', role: 'alert' }, `读取失败：${error}`)
      if (!data) return h('p', { className: 'omb-muted' }, '暂无画像')
      if (!data.available) return h('p', { className: 'omb-muted' }, `画像不可用：${data.reason || '未知原因'}`)
      const structure = data.structure || {}
      return h('div', { className: 'omb-sections' },
        h('div', { className: 'omb-cards' },
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '项目根'),
            h('span', { className: 'omb-card-note' }, data.root || '未知')),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, 'cwd 相对根'),
            h('span', { className: 'omb-card-note' }, data.cwdRel === '' ? '.' : data.cwdRel || '未知')),
          h('div', { className: 'omb-card' },
            h('span', { className: 'omb-card-label' }, '分支 / HEAD'),
            h('span', { className: 'omb-card-note' }, `${data.branch || '未知'} / ${data.head ? String(data.head).slice(0, 12) : '未知'}`))),
        h('div', null,
          h('p', { className: 'omb-section-title' }, '顶层目录'),
          h('div', { className: 'omb-meta' },
            ...(structure.topDirs || []).map((dir) => h(Tag, { key: dir.name, tone: 'outline' }, `${dir.name}(${dir.files})`)))),
        h('div', null,
          h('p', { className: 'omb-section-title' }, '文件索引'),
          h('div', { className: 'omb-files' },
            ...(structure.files || []).map((file) => h('div', { key: file.path, className: 'omb-file' },
              h('span', null, file.path),
              h('span', null, `${file.lines} 行 · ${file.symbols} 符号 · ${file.imports} 导入`))))),
        data.text
          ? h('div', null,
            h('p', { className: 'omb-section-title' }, '画像摘要'),
            h('p', { className: 'omb-note' }, data.text))
          : null,
        h('div', { className: 'omb-actions' },
          h(Button, { variant: 'outline', size: 'sm', onClick: () => void load() }, '刷新')))
    }

    function MemoryPanel() {
      const [tab, setTab] = React.useState('overview')
      const [overview, setOverview] = React.useState(null)
      const [overviewError, setOverviewError] = React.useState('')
      const [overviewLoading, setOverviewLoading] = React.useState(false)

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

      const tabs = TABS.map((entry) => ({
        value: entry.value,
        label: entry.label,
        id: `omb-tab-${entry.value}`,
        panelId: `omb-panel-${entry.value}`,
      }))
      return h('div', { className: 'omb-page' },
        h('style', null, CSS),
        h('div', { className: 'omb-header' },
          h('h2', { className: 'omb-title' }, 'OMB 记忆'),
          h('p', { className: 'omb-sub' }, '记忆库、候选确认、审计与冲突裁决；运行状态和项目画像只读。')),
        h(SegmentedTabs, {
          items: tabs, value: tab, label: 'OMB 记忆视图',
          onChange: (next) => setTab(next),
        }),
        h('div', {
          className: 'omb-content', role: 'tabpanel',
          id: `omb-panel-${tab}`, 'aria-labelledby': `omb-tab-${tab}`,
        },
        tab === 'overview'
          ? h(OverviewView, { data: overview, loading: overviewLoading, error: overviewError, onRefresh: () => void loadOverview() })
          : tab === 'runtime'
            ? h(RuntimeView)
            : tab === 'profile'
              ? h(ProfileView)
              : h(MemoryWorkspace, {
                key: tab,
                candidatesOnly: tab === 'candidates',
                onChanged: () => void loadOverview(),
              })))
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
          label: () => 'OMB 记忆',
        }, MemoryIcon))
      },
    }
  },
})
