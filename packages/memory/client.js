// OMB 记忆管理侧边栏（v4.15.0）——手写浏览器 bundle，不需要打包器。
// 宿主 `dsh-client-modules` 扫描到本包 `dsh.client` 后把它作为懒加载工厂注册；
// 只有用户第一次打开面板时才会执行。
//
// 数据面：宿主 `/omb/api`（只读 GET）。写操作（确认候选）仍走 `/omb-confirm`，
// 本面板不提供写入口——"手动管理"的第一阶段先把**看见与审计**做好。
window.__ModuleLoader__.load({
  id: '@omb/memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'omb-memory'
    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'memory', label: '记忆库' },
      { id: 'candidates', label: '候选确认' },
      { id: 'runtime', label: '运行状态' },
      { id: 'profile', label: '项目画像' },
    ]

    const styles = {
      page: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        padding: '16px 20px', gap: 12, boxSizing: 'border-box', color: 'inherit',
        font: 'inherit',
        overflow: 'hidden',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      hint: { opacity: 0.65, fontSize: 12, lineHeight: 1.5 },
      tabs: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      tab: (active) => ({
        appearance: 'none', cursor: 'pointer', fontSize: 13,
        padding: '5px 12px', borderRadius: 999,
        border: `1px solid ${active ? 'currentColor' : 'rgba(127,127,127,.35)'}`,
        background: active ? 'rgba(127,127,127,.16)' : 'transparent',
        color: 'inherit', opacity: active ? 1 : 0.75,
      }),
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px', minWidth: 160, padding: '6px 10px', fontSize: 13,
        borderRadius: 8, border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent', color: 'inherit',
      },
      select: {
        padding: '6px 8px', fontSize: 13, borderRadius: 8,
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit',
      },
      button: {
        appearance: 'none', cursor: 'pointer', fontSize: 13, padding: '5px 12px',
        borderRadius: 8, border: '1px solid rgba(127,127,127,.4)',
        background: 'transparent', color: 'inherit',
      },
      columns: { display: 'flex', gap: 16, flex: 1, minHeight: 0, alignItems: 'stretch' },
      list: {
        flex: '1 1 44%', minWidth: 260, overflowY: 'auto', display: 'flex',
        flexDirection: 'column', gap: 8, paddingRight: 4,
      },
      card: (active) => ({
        textAlign: 'left', cursor: 'pointer', padding: '10px 12px', borderRadius: 10,
        border: `1px solid ${active ? 'rgba(120,180,255,.75)' : 'rgba(127,127,127,.28)'}`,
        background: active ? 'rgba(120,180,255,.10)' : 'transparent', color: 'inherit',
        display: 'flex', flexDirection: 'column', gap: 6,
      }),
      meta: { fontSize: 11, opacity: 0.65, display: 'flex', gap: 8, flexWrap: 'wrap' },
      body: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.55,
      },
      detail: {
        flex: '1 1 56%', minWidth: 280, overflowY: 'auto', padding: 14, borderRadius: 12,
        border: '1px solid rgba(127,127,127,.28)', display: 'flex',
        flexDirection: 'column', gap: 10, minHeight: 0,
      },
      badge: {
        fontSize: 11, padding: '2px 8px', borderRadius: 999,
        border: '1px solid rgba(127,127,127,.35)', display: 'inline-block',
      },
      error: { color: '#ff9a9a', fontSize: 12 },
      empty: { opacity: 0.6, fontSize: 13, padding: '10px 0' },
      stat: { display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 12 },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: '6px 0 0' },
    }

    async function api(path, params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const suffix = search.toString()
      const response = await fetch(`/omb/api${path}${suffix ? `?${suffix}` : ''}`, {
        credentials: 'same-origin', headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.json()).error || ''
        } catch {
          detail = ''
        }
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`)
      }
      return response.json()
    }

    function formatTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '时间未知'
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function StatusPill({ item }) {
      const label = item.stageLabel || item.stage || ''
      return h('span', { style: styles.badge }, `${item.scope}/${item.kind} · ${label} · ${item.assertedBy}`)
    }

    function Overview({ data, loading, error, onRefresh }) {
      if (loading && !data) return h('div', { style: styles.empty }, '读取中…')
      if (error) return h('div', { style: styles.error }, `读取失败：${error}`)
      if (!data) return h('div', { style: styles.empty }, '暂无数据')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: styles.hint },
          `库状态：${data.ready ? '就绪' : '未就绪'}——${data.detail}`),
        h('div', { style: styles.stat }, h('span', null, '活跃条目'), h('strong', null, String(data.totalActive))),
        h('div', { style: styles.stat }, h('span', null, '候选条目'), h('strong', null, String(data.totalCandidates))),
        h('div', { style: styles.stat }, h('span', null, '已打开项目库'),
          h('strong', null, data.openProjects.length > 0 ? data.openProjects.join('、') : '无')),
        h('div', { style: styles.stat }, h('span', null, '项目库连接上限'), h('strong', null, String(data.maxOpenProjects))),
        h('p', { style: styles.sectionTitle }, '各库'),
        ...data.stores.map((store) => h('div', {
          key: `${store.scope}:${store.projectScope || ''}`,
          style: { ...styles.stat, borderTop: '1px solid rgba(127,127,127,.2)', paddingTop: 6 },
        },
        h('span', null, `${store.scope}${store.projectScope ? `（${store.projectScope}）` : ''}`),
        h('span', null, `行 ${store.stats.rows} · 活跃 ${store.active} · 候选 ${store.candidates}`))),
        h('div', { style: styles.hint }, '页面只读：确认候选请用 /omb-confirm；本面板不写库。'),
        h('button', { style: styles.button, onClick: onRefresh }, '刷新'))
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
      if (loading && !data) return h('div', { style: styles.empty }, '读取运行时读数…')
      if (error) return h('div', { style: styles.error }, `读取失败：${error}`)
      if (!data) return h('div', { style: styles.empty }, '暂无读数')
      const controller = data.controller || {}
      const capture = data.capture || {}
      const activity = data.activity
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: styles.stat }, h('span', null, 'OMB 版本'), h('strong', null, data.version || '未知')),
        h('div', { style: styles.stat }, h('span', null, '记忆库'),
          h('strong', null, `${data.stores.ready ? '就绪' : '未就绪'} · 项目库 ${data.stores.openProjects.length}/${data.stores.maxOpenProjects}`)),
        data.privacy
          ? h('div', { style: styles.stat }, h('span', null, '隐私闸门'),
            h('strong', null, `${data.privacy.allowWrite ? '可写' : '禁写'} · ${data.privacy.reason || '无原因'} `))
          : null,
        h('p', { style: styles.sectionTitle }, '事件控制器'),
        h('div', { style: styles.hint },
          `模式 ${controller.mode || '未知'} · 事件 ${controller.events ?? 0} · persist ${controller.persist ?? 0}`
          + `（写入 ${controller.persisted ?? 0}/查回失败 ${controller.verifyFailed ?? 0}）· 幂等跳过 ${controller.duplicateActions ?? 0}`),
        data.situation
          ? h('div', null,
            h('p', { style: styles.sectionTitle }, '会话状态机'),
            h('div', { style: styles.hint },
              `会话 ${data.situation.sessionId || '未知'} · 状态 ${data.situation.state || '未知'}`
              + (data.situation.tier ? `/${data.situation.tier}` : '')
              + ` · 第 ${data.situation.turn ?? '?'} 回合`
              + ` · 空闲 ${typeof data.situation.idleMs === 'number' ? `${Math.round(data.situation.idleMs / 1000)}s` : '未知'}`
              + (data.situation.lastTurnEndReason ? ` · 上回合 ${data.situation.lastTurnEndReason}` : '')
              + (data.situation.interrupted ? ' · 已中断' : '')
              + (data.situation.unresolved ? ' · 未解决' : '')),
            data.situation.goals || data.situation.todos
              ? h('div', { style: styles.hint },
                `目标 ${data.situation.goals ? `${data.situation.goals.open}/${data.situation.goals.total}` : '未知'}`
                + ` · 待办 ${data.situation.todos ? `${data.situation.todos.open}/${data.situation.todos.total}` : '未知'}`)
              : null,
            data.situation.workspace
              ? h('div', { style: styles.hint },
                `工作区 ${data.situation.workspace.root || '未知'}`
                + ` · 本会话切换 ${data.situation.workspace.switches ?? 0} 次`
                + (data.situation.workspace.previousRoot ? ` · 上一处 ${data.situation.workspace.previousRoot}` : ''))
              : null)
          : h('div', { style: styles.hint }, '会话状态未接线（session-state 服务不可用）。'),
        h('p', { style: styles.sectionTitle }, '捕获与主动性'),
        h('div', { style: styles.hint },
          `偏好写入 ${capture.preferences ?? 0} · 失败 ${capture.failed ?? 0}`
          + ` · 主动提示命中 ${capture.proactiveCues ?? 0} / 跟进 ${capture.cueFollowUps ?? 0}`),
        activity
          ? h('div', null,
            h('p', { style: styles.sectionTitle }, `活动日志（${activity.total} 条，错误 ${activity.errors}）`),
            h('div', { style: styles.hint },
              Object.entries(activity.byKind || {}).filter(([, count]) => count > 0).map(([kind, count]) => `${kind} ${count}`).join(' · ') || '无'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
              (activity.recent || []).map((entry, index) => h('div', { key: `${entry.at}-${index}`, style: styles.meta },
                h('span', null, entry.kind), h('span', null, entry.detail), h('span', null, formatTime(entry.at))))))
          : h('div', { style: styles.hint }, '活动日志未接线（旧装配）。'),
        h('button', { style: styles.button, onClick: () => void load() }, '刷新'))
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
      if (loading && !data) return h('div', { style: styles.empty }, '读取项目画像…')
      if (error) return h('div', { style: styles.error }, `读取失败：${error}`)
      if (!data) return h('div', { style: styles.empty }, '暂无画像')
      if (!data.available) return h('div', { style: styles.hint }, `画像不可用：${data.reason || '未知原因'}`)
      const structure = data.structure || {}
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: styles.stat }, h('span', null, '项目根'), h('strong', null, data.root || '未知')),
        h('div', { style: styles.stat }, h('span', null, 'cwd 相对根'), h('strong', null, data.cwdRel === '' ? '.' : data.cwdRel || '未知')),
        h('div', { style: styles.stat }, h('span', null, '分支 / HEAD'),
          h('strong', null, `${data.branch || '未知'} / ${data.head ? String(data.head).slice(0, 12) : '未知'}`)),
        h('p', { style: styles.sectionTitle }, '顶层目录'),
        h('div', { style: styles.hint },
          (structure.topDirs || []).map(dir => `${dir.name}(${dir.files})`).join(' · ') || '无'),
        h('p', { style: styles.sectionTitle }, '文件索引'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          (structure.files || []).map(file => h('div', { key: file.path, style: styles.meta },
            h('span', null, file.path), h('span', null, `${file.lines} 行 · ${file.symbols} 符号 · ${file.imports} 导入`)))),
        data.text
          ? h('div', null, h('p', { style: styles.sectionTitle }, '画像摘要'),
            h('div', { style: { ...styles.body, maxHeight: 220, overflowY: 'auto' } }, data.text))
          : null,
        h('button', { style: styles.button, onClick: () => void load() }, '刷新'))
    }

    function MemoryList({ tab, onOpen, selectedId }) {
      const [items, setItems] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [status, setStatus] = React.useState(tab === 'candidates' ? 'active' : 'active')
      const [kind, setKind] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const data = tab === 'candidates'
            ? await api('/candidates', { limit: 50 })
            : await api('/list', { q: query, scope, status, kind, limit: 50 })
          setItems(data.items || [])
          setTotal(data.total || 0)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [tab, query, scope, status, kind])

      React.useEffect(() => {
        void load()
      }, [load])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: 1 } },
        tab === 'memory'
          ? h('div', { style: styles.toolbar },
            h('input', {
              style: styles.input, placeholder: '搜索记忆（词法 + 子串回退）', value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void load() },
            }),
            h('select', { style: styles.select, value: scope, onChange: (event) => setScope(event.target.value) },
              h('option', { value: 'all' }, '全部作用域'),
              h('option', { value: 'user' }, '用户库'),
              h('option', { value: 'project' }, '项目库')),
            h('select', { style: styles.select, value: status, onChange: (event) => setStatus(event.target.value) },
              h('option', { value: 'active' }, '活跃'),
              h('option', { value: 'stale' }, '已失效'),
              h('option', { value: 'superseded' }, '已被取代'),
              h('option', { value: 'all' }, '全部状态')),
            h('select', { style: styles.select, value: kind, onChange: (event) => setKind(event.target.value) },
              h('option', { value: '' }, '全部类型'),
              h('option', { value: 'semantic' }, '语义'),
              h('option', { value: 'procedural' }, '流程'),
              h('option', { value: 'episodic' }, '事件')),
            h('button', { style: styles.button, onClick: () => void load() }, '搜索'))
          : h('div', { style: styles.hint }, '候选 = 模型推断写入、等待用户确认的条目（/omb-confirm <id>）。'),
        error ? h('div', { style: styles.error }, `读取失败：${error}`) : null,
        h('div', { style: styles.hint },
          loading ? '读取中…' : `显示 ${items.length} / ${total} 条${total > items.length ? '（超出单页上限）' : ''}`),
        h('div', { style: styles.list },
          items.length === 0 && !loading ? h('div', { style: styles.empty }, '没有匹配条目') : null,
          ...items.map((item) => h('button', {
            key: item.id, style: styles.card(item.id === selectedId),
            onClick: () => onOpen(item.id),
          },
          h('div', { style: styles.body }, item.text.length > 180 ? `${item.text.slice(0, 180)}…` : item.text),
          h('div', { style: styles.meta },
            h(StatusPill, { item }),
            h('span', null, formatTime(item.observedAt)),
            item.tags.length > 0 ? h('span', null, `#${item.tags.join(' #')}`) : null)))))
    }

    async function post(path, body) {
      const response = await fetch(`/omb/api${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const text = payload && typeof payload.text === 'string' ? payload.text : `HTTP ${response.status}`
        throw new Error(text)
      }
      return payload || { ok: true, text: '' }
    }

    function Detail({ id, onChanged }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [actionText, setActionText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [revision, setRevision] = React.useState(0)

      React.useEffect(() => {
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

      const run = (action) => {
        if (busy) return
        setBusy(true)
        setActionText('')
        void post('/confirm', { id, action }).then((payload) => {
          setActionText(payload.text || '完成')
          setRevision((value) => value + 1)
          if (onChanged) onChanged()
        }, (failure) => {
          setActionText(failure instanceof Error ? failure.message : String(failure))
        }).finally(() => setBusy(false))
      }

      const runResolve = (action, toId) => {
        if (busy) return
        setBusy(true)
        setActionText('')
        void post('/resolve', { action, fromId: id, toId }).then((payload) => {
          setActionText(payload.text || '完成')
          setRevision((value) => value + 1)
          if (onChanged) onChanged()
        }, (failure) => {
          setActionText(failure instanceof Error ? failure.message : String(failure))
        }).finally(() => setBusy(false))
      }

      if (loading) return h('div', { style: styles.empty }, '读取详情…')
      if (error) return h('div', { style: styles.error }, `详情读取失败：${error}`)
      if (!data) return h('div', { style: styles.empty }, '未选择条目')
      const record = data.record
      const canConfirm = record.stage === 'candidate' && record.kind !== 'episodic'
      const lastAudit = data.auditAvailable ? data.audit[0] : undefined
      const canUndo = data.auditAvailable && record.stage === 'confirmed'
        && lastAudit !== undefined && lastAudit.action === 'confirm'
      return h('div', { style: styles.detail },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(StatusPill, { item: record }),
          h('span', { style: styles.hint }, record.id)),
        h('div', { style: styles.body }, record.text),
        h('div', { style: styles.meta },
          h('span', null, `来源：${record.sourceRef}`),
          h('span', null, `时间：${formatTime(record.observedAt)}`),
          record.projectScope ? h('span', null, `项目：${record.projectScope}`) : null,
          record.tags.length > 0 ? h('span', null, `标签：${record.tags.join('、')}`) : null),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          canConfirm
            ? h('button', { style: styles.button, disabled: busy, onClick: () => run('confirm') }, busy ? '处理中…' : '确认为已确认')
            : null,
          canUndo
            ? h('button', { style: styles.button, disabled: busy, onClick: () => run('undo') }, busy ? '处理中…' : '撤销确认')
            : null,
          h('span', { style: styles.hint },
            canConfirm || canUndo ? '动作走 /omb-confirm 同一实现；只改证据归属，不改正文。' : '这条当前没有可执行的确认动作。')),
        actionText.length === 0
          ? null
          : h('div', { style: actionText.startsWith('未') || actionText.includes('失败') ? styles.error : styles.hint, whiteSpace: 'pre-wrap' }, actionText),
        record.validTo === null && record.supersededBy === null
          ? null
          : h('div', { style: styles.hint },
            `状态：${record.supersededBy ? `被 ${record.supersededBy} 取代` : `有效至 ${formatTime(record.validTo)}`}`),
        h('p', { style: styles.sectionTitle }, `确认审计（${data.auditAvailable ? data.audit.length : '不可读'}）`),
        data.auditAvailable
          ? (data.audit.length === 0
            ? h('div', { style: styles.empty }, '没有经 /omb-confirm 的记录')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              ...data.audit.map((entry, index) => h('div', { key: `${entry.action}-${entry.at}-${index}`, style: styles.meta },
                h('span', null, entry.action === 'undo' ? '撤销' : '确认'),
                h('span', null, formatTime(entry.at)),
                h('span', null, entry.sessionId ? `会话 ${entry.sessionId}` : '无会话')))))
          : h('div', { style: styles.hint }, '该库没有确认审计面（旧实现），无法证明确认历史。'),
        h('p', { style: styles.sectionTitle }, `可能相关 / 冲突（${data.related.length}）`),
        data.related.length === 0
          ? h('div', { style: styles.empty }, '没有共享实体键的活跃条目')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...data.related.map((item) => h('div', { key: item.record.id, style: { ...styles.card(false), cursor: 'default' } },
              h('div', { style: styles.body }, item.record.text),
              h('div', { style: styles.meta }, h('span', null, item.record.id), h('span', null, formatTime(item.record.observedAt)), h('span', null, item.shared.join('、'))),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', {
                  style: styles.button, disabled: busy,
                  onClick: () => runResolve('relate', item.record.id),
                }, '建立关联'),
                h('button', {
                  style: styles.button, disabled: busy,
                  onClick: () => runResolve('supersede', item.record.id),
                }, '本条取代该条'),
                h('span', { style: styles.hint }, '取代 = validTo + supersededBy + supersedes 边（非破坏）'))))))
    }

    function MemoryPanel() {
      const [tab, setTab] = React.useState('overview')
      const [overview, setOverview] = React.useState(null)
      const [overviewError, setOverviewError] = React.useState('')
      const [overviewLoading, setOverviewLoading] = React.useState(false)
      const [selectedId, setSelectedId] = React.useState(null)
      const [refreshKey, setRefreshKey] = React.useState(0)

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

      React.useEffect(() => {
        void loadOverview()
      }, [loadOverview])

      return h('div', { style: styles.page },
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, 'OMB 记忆'),
          h('span', { style: styles.hint }, '手动管理面：记忆库 / 候选 / 审计 / 相关条目；运行状态与项目画像只读')),
        h('div', { style: styles.tabs },
          ...TABS.map((entry) => h('button', {
            key: entry.id, style: styles.tab(tab === entry.id),
            onClick: () => { setTab(entry.id); setSelectedId(null) },
          }, entry.label))),
        tab === 'overview'
          ? h(Overview, { data: overview, loading: overviewLoading, error: overviewError, onRefresh: () => void loadOverview() })
          : tab === 'runtime'
            ? h(RuntimeView)
            : tab === 'profile'
              ? h(ProfileView)
              : h('div', { style: styles.columns },
                h(MemoryList, { key: `${tab}-${refreshKey}`, tab, selectedId, onOpen: setSelectedId }),
                h(Detail, {
                  id: selectedId,
                  onChanged: () => {
                    setRefreshKey((value) => value + 1)
                    void loadOverview()
                  },
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
