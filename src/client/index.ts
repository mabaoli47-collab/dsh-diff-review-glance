// dsh-diff-review client half (formal plugin)
// v0.4：通信迁移到官方 typert RPC（ctx.remote.$mount + 命名空间调用）；
// agent 由运行时注入，无需再传 sessionId。webServer fetch 路由保留为过渡（host 侧未删）。
import * as React from 'react'

// ---- typert remote 描述符（与 host src/host/typert.ts 的 wire 契约一致；client 侧不依赖 zod，codec 用 src-json）----
const REMOTE_PACKAGE = 'dsh-diff-review'
const REMOTE_SERVICE = 'diffReview'
const srcJson = { mode: 'src-json' }
function descriptor(method) {
  return {
    id: REMOTE_PACKAGE + '#' + REMOTE_SERVICE + '/' + method,
    service: REMOTE_SERVICE,
    namespace: REMOTE_SERVICE,
    method,
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: srcJson },
      { name: 'request', wire: 'request', source: 'json', codec: srcJson },
    ],
    result: srcJson,
  }
}
const TYPERT_REMOTE = {
  package: REMOTE_PACKAGE,
  descriptors: ['getState', 'getItem', 'review', 'reviewGroup', 'reviewSession', 'reviewAll', 'openExternal', 'getEditorConfig', 'saveEditorConfig'].map(descriptor),
}

// 过渡期的 fetch 回退路由（host 侧 webServer 路由保留期间可用）
const ROUTE = '/dsh-diff-review'
let pluginCtx = null

let remoteNs = null
async function initRemote() {
  if (remoteNs) return remoteNs
  if (!pluginCtx || !pluginCtx.remote) throw new Error('dsh-diff-review: client remote service unavailable')
  await pluginCtx.remote.$mount(TYPERT_REMOTE)
  remoteNs = pluginCtx.get('remote.' + REMOTE_SERVICE)
  if (!remoteNs) throw new Error('dsh-diff-review: diffReview remote unavailable')
  return remoteNs
}

// callHost：typert RPC 调用（agent 由运行时注入）；失败回退到过渡的 fetch 路由
async function callHost(action, args) {
  try {
    const ns = await initRemote()
    return await ns[action](args || {})
  } catch (e) {
    return fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, args: args || {} }),
    }).then(async (res) => {
      if (!res.ok) throw new Error('dsh-diff-review: host HTTP ' + res.status)
      return res.json()
    })
  }
}

let styleTag = null
function injectCss(css) {
  if (typeof document === 'undefined') return
  // 幂等：HMR/重复 apply 时复用已有标签，避免样式重复累积
  if (styleTag === null || !styleTag.isConnected) {
    styleTag = document.querySelector('style[data-plugin="dsh-diff-review"]')
    if (styleTag === null) {
      styleTag = document.createElement('style')
      styleTag.dataset.plugin = 'dsh-diff-review'
      document.head.appendChild(styleTag)
    }
  }
  if (styleTag.textContent.indexOf(css) === -1) styleTag.textContent += css
}

function apply(ctx) {
  pluginCtx = ctx
  const slots = ctx.slots || ctx.get('slots')
  if (slots === undefined) return

  // 初始 state 补全全部字段：首帧渲染（fetch 尚未返回）时不出现「未知工作区」误导文案，
  // 而是按"未识别"处理，等首次轮询返回后纠正
  let state = { rev: 0, maxTurn: 0, workspaceId: null, workspaceLabel: '', sessionId: '', sessionKnown: false, loading: false, truncated: false, lastTurn: 0, pendingCount: 0, sessions: [], groups: [], pending: [] }
  const subs = new Set()
  const detailCache = new Map()
  let fetching = false
  // 当前会话 id（由 slot 的 standard props 提供，纯数据，不调用任何 hook；host 端用它精确映射到工作区）
  let currentSessionId = undefined
  let lastSeenSessionId = undefined
  function resolveCurrentSession(props) {
    try {
      if (props && typeof props.sessionId === 'string' && props.sessionId) {
        currentSessionId = props.sessionId
      }
    } catch (e) { /* 忽略 */ }
    // 会话标识就绪/变化时立即拉取一次，避免"刷新后首帧拿不到 sessionId"的未识别卡顿
    // （interval 轮询只是兜底，这里保证 sessionId 一注入就刷新）
    if (currentSessionId !== lastSeenSessionId) {
      lastSeenSessionId = currentSessionId
      refresh()
    }
  }
  function cwdArg() { return currentSessionId ? { sessionId: currentSessionId } : {} }

  let onlyChanged = false
  const viewSubs = new Set()
  function toggleOnlyChanged() {
    onlyChanged = !onlyChanged
    for (const fn of Array.from(viewSubs)) { try { fn(onlyChanged) } catch (e) {} }
  }

  function getSnapshot() { return state }
  function subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } }
  function emit() {
    const s = state
    for (const fn of Array.from(subs)) { try { fn(s) } catch (e) {} }
  }

  // 轮询与操作后的刷新共用：fetch 进行中时把请求排队，完成后补跑一次——
  // 避免 doReview/keepAll 等操作与 2 秒轮询碰撞时操作结果要等下一周期才上屏
  let refreshQueued = false
  async function refresh() {
    if (fetching) { refreshQueued = true; return }
    fetching = true
    try {
      const st = await callHost('getState', cwdArg())
      if (st && Array.isArray(st.pending) && Array.isArray(st.groups)) {
        // 版本防护：v0.3.7 客户端 + 旧版宿主（返回旧 schema，无 workspaceId）→
        // 提示重启 dsh，而不是把缺失字段误读成"未识别工作区"
        if (typeof st.workspaceId !== 'string') {
          if (state.hostError !== 'old-host') {
            state = Object.assign({}, state, { hostError: 'old-host', sessionKnown: false, loading: false })
            emit()
          }
        } else if (st.hostError !== state.hostError || !!st.sessionKnown !== !!state.sessionKnown || st.pendingCount !== state.pendingCount || (st.sessions || []).length !== (state.sessions || []).length || st.rev !== state.rev || !!st.loading !== !!state.loading || st.maxTurn !== state.maxTurn || st.workspaceId !== state.workspaceId) {
          state = st
          emit()
        }
      }
    } catch (e) {
      // fetch 失败（路由 404 等）：记录"宿主未连接"并在 UI 提示，避免静默显示误导性空态
      if (state.hostError !== 'host-unreachable') {
        state = Object.assign({}, state, { hostError: 'host-unreachable', sessionKnown: false, loading: false })
        emit()
      }
    }
    finally {
      fetching = false
      if (refreshQueued) { refreshQueued = false; refresh() }
    }
  }
  // 请求序号：防止慢响应覆盖新请求的结果（快速展开/折叠同一 item 时的竞态）
  let fetchSeq = 0
  async function fetchItem(itemId) {
    if (detailCache.has(itemId)) return detailCache.get(itemId)
    const seq = ++fetchSeq
    try {
      const d = await callHost('getItem', Object.assign({ itemId }, cwdArg()))
      if (seq === fetchSeq && d) detailCache.set(itemId, d)
      return seq === fetchSeq ? d : null
    } catch (e) { return null }
  }
  async function doReview(itemId, action) {
    detailCache.delete(itemId)
    let r = null
    try { r = await callHost('review', Object.assign({ itemId, action }, cwdArg())) } catch (e) { r = { ok: false, message: '调用失败' } }
    await refresh()
    return r
  }
  async function doReviewGroup(turn, action) {
    // 轮次归属会话：turn 仅会话内唯一，必须携带当前会话 id，host 端按 sessionId::turn 精确定位
    try { await callHost('reviewGroup', Object.assign({ turn, action }, cwdArg())) } catch (e) {}
    const prefix = (currentSessionId || '') + '::' + turn + '::'
    for (const key of Array.from(detailCache.keys())) {
      if (key.indexOf(prefix) === 0) detailCache.delete(key)
    }
    await refresh()
  }
  async function keepAll() {
    try { await callHost('reviewAll', cwdArg()) } catch (e) {}
    detailCache.clear() // 全部保留后清缓存，避免展开旧 status
    await refresh()
  }
  async function keepSession(sessionId) {
    // cwdArg() 在前、目标 sessionId 在后覆盖：否则 { sessionId } 会被 cwdArg() 的
    // { sessionId: currentSessionId } 覆盖，导致点击其他会话的"本会话全部保留"时
    // 误操作当前会话（严重 UI 逻辑 bug）
    try { await callHost('reviewSession', Object.assign({}, cwdArg(), { sessionId })) } catch (e) {}
    // 前缀精确匹配（startsWith 比 indexOf 切割更稳：item id 为 sessionId::turn::path）
    for (const key of Array.from(detailCache.keys())) {
      if (key.indexOf(sessionId + '::') === 0) detailCache.delete(key)
    }
    await refresh()
  }

  ctx.effect(() => ctx.interval(() => refresh(), 2000))
  refresh()

  injectCss('\n' +
    '.dshdr-dock { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: var(--dsh-composer-card-max-width); margin: 2px auto 8px; }\n' +
    '.dshdr-bar { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border: 1px solid rgba(128,128,128,0.4); border-radius: 10px; background: rgba(128,128,128,0.16); cursor: pointer; user-select: none; }\n' +
    '.dshdr-bar:hover { background: rgba(128,128,128,0.24); }\n' +
    '.dshdr-title { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; }\n' +
    '.dshdr-count { background: rgba(210,153,34,0.3); color: #d29922; border-radius: 10px; padding: 0 8px; font-size: 12px; }\n' +
    '.dshdr-toggle { font-size: 11px; color: rgba(128,128,128,0.9); }\n' +
    '.dshdr-btn { border: 1px solid rgba(128,128,128,0.45); background: rgba(128,128,128,0.12); color: inherit; border-radius: 6px; padding: 2px 9px; font-size: 12px; cursor: pointer; white-space: nowrap; }\n' +
    '.dshdr-btn:hover { background: rgba(128,128,128,0.22); }\n' +
    '.dshdr-btn.primary { border-color: rgba(46,160,67,0.55); color: #2ea043; }\n' +
    '.dshdr-btn.danger { border-color: rgba(248,81,73,0.55); color: #f85149; }\n' +
    '.dshdr-btn:disabled { opacity: 0.5; cursor: default; }\n' +
    '.dshdr-list { display: flex; flex-direction: column; gap: 4px; }\n' +
    '.dshdr-item { border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; overflow: hidden; }\n' +
    '.dshdr-item-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; }\n' +
    '.dshdr-item-head:hover { background: rgba(128,128,128,0.1); }\n' +
    '.dshdr-open-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 10px 8px; }\n' +
    '.dshdr-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
    '.dshdr-turn-tag { font-size: 11px; color: rgba(128,128,128,0.9); border: 1px solid rgba(128,128,128,0.4); border-radius: 8px; padding: 0 6px; white-space: nowrap; }\n' +
    '.dshdr-stats { font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; display: flex; gap: 6px; white-space: nowrap; }\n' +
    '.dshdr-stats .add { color: #2ea043; } .dshdr-stats .del { color: #f85149; }\n' +
    '.dshdr-badge { font-size: 11px; border-radius: 10px; padding: 1px 8px; white-space: nowrap; }\n' +
    '.dshdr-badge-pending { background: rgba(210,153,34,0.3); color: #d29922; }\n' +
    '.dshdr-badge-kept { background: rgba(46,160,67,0.25); color: #2ea043; }\n' +
    '.dshdr-badge-reverted { background: rgba(139,148,158,0.3); color: #8b949e; }\n' +
    '.dshdr-turn { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 10px; padding: 8px 10px; border: 1px solid rgba(128,128,128,0.35); border-radius: 10px; background: rgba(128,128,128,0.1); }\n' +
    '.dshdr-turn-head { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; flex-wrap: wrap; }\n' +
    '.dshdr-turn-actions { margin-left: auto; display: flex; gap: 6px; }\n' +
    '.dshdr-diff { border: 1px solid rgba(128,128,128,0.35); border-radius: 8px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }\n' +
    '.dshdr-diff-head { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-bottom: 1px solid rgba(128,128,128,0.3); background: rgba(128,128,128,0.1); font-family: inherit; }\n' +
    '.dshdr-diff-head .dshdr-path { font-family: inherit; flex: 0 1 auto; }\n' +
    '.dshdr-switch { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: 11px; color: rgba(128,128,128,0.95); cursor: pointer; user-select: none; white-space: nowrap; }\n' +
    '.dshdr-switch input { accent-color: #2ea043; cursor: pointer; }\n' +
    '.dshdr-note { font-size: 11px; color: rgba(128,128,128,0.9); }\n' +
    '.dshdr-cols { display: grid; grid-template-columns: 3.4em max-content 3.4em max-content; border-bottom: 1px solid rgba(128,128,128,0.3); }\n' +
    '.dshdr-cols > div { padding: 3px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: rgba(128,128,128,0.9); }\n' +
    // 横向滚动：文本列按内容宽度（max-content），长行撑开行宽，容器 overflow:auto 出现横向滚动条
    '.dshdr-scroll { max-height: 360px; overflow: auto; }\n' +
    '.dshdr-row { display: grid; grid-template-columns: 3.4em max-content 3.4em max-content; }\n' +
    '.dshdr-row .dshdr-ln { padding: 0 6px; text-align: right; color: rgba(128,128,128,0.8); background: rgba(128,128,128,0.08); user-select: none; }\n' +
    '.dshdr-row .dshdr-txt { padding: 0 8px; white-space: pre; }\n' +
    '.dshdr-row.dshdr-ctx .dshdr-txt { background: transparent; }\n' +
    '.dshdr-collapsed { text-align: center; font-size: 11px; color: rgba(128,128,128,0.8); padding: 1px 0; border-top: 1px dashed rgba(128,128,128,0.3); border-bottom: 1px dashed rgba(128,128,128,0.3); background: rgba(128,128,128,0.06); }\n' +
    '.dshdr-txt-del { background: rgba(248,81,73,0.18); }\n' +
    '.dshdr-txt-add { background: rgba(46,160,67,0.2); }\n' +
    '.dshdr-row .dshdr-ln-del { background: rgba(248,81,73,0.14); }\n' +
    '.dshdr-row .dshdr-ln-add { background: rgba(46,160,67,0.16); }\n' +
    '.dshdr-hl { background: rgba(248,81,73,0.5); }\n' +
    '.dshdr-txt-add .dshdr-hl { background: rgba(46,160,67,0.55); }\n' +
    '.dshdr-error { color: #f85149; font-size: 12px; padding: 2px 10px 6px; }\n' +
    '.dshdr-info { color: #2ea043; font-size: 12px; padding: 2px 10px 6px; }\n' +
    '.dshdr-loading { color: rgba(128,128,128,0.9); font-size: 12px; padding: 6px 10px; }\n' +
    '.dshdr-cfg { display: flex; flex-direction: column; gap: 10px; padding: 16px; max-width: 640px; }\n' +
    '.dshdr-cfg h3 { margin: 0; font-size: 15px; font-weight: 600; }\n' +
    '.dshdr-cfg .dshdr-cfg-desc { margin: 0; font-size: 12px; color: rgba(128,128,128,0.9); }\n' +
    '.dshdr-cfg-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }\n' +
    '.dshdr-cfg-field input { padding: 6px 8px; border: 1px solid rgba(128,128,128,0.4); border-radius: 6px; background: rgba(128,128,128,0.08); color: inherit; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n' +
    '.dshdr-cfg-field input:focus { outline: none; border-color: rgba(46,160,67,0.6); }\n' +
    '.dshdr-cfg-actions { display: flex; align-items: center; gap: 10px; }\n' +
    '.dshdr-cfg .dshdr-info, .dshdr-cfg .dshdr-error { padding: 0; }\n' +
    '.dshdr-missing pre { margin: 0; padding: 8px 10px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: inherit; font-size: 12px; }\n' +
    '.dshdr-session { border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; margin: 0 0 6px; overflow: hidden; }\n' +
    '.dshdr-session-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; background: rgba(128,128,128,0.1); font-size: 13px; font-weight: 600; }\n' +
    '.dshdr-session-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n')

  function StatusBadge({ status }) {
    const map = { pending: '待审阅', kept: '已保留', reverted: '已撤销' }
    return React.createElement('span', { className: 'dshdr-badge dshdr-badge-' + status }, map[status] || status)
  }
  function LineText({ line }) {
    if (!line.hl) return line.t
    const { s, e } = line.hl
    const children = []
    if (s > 0) children.push(line.t.slice(0, s))
    children.push(React.createElement('span', { key: 'hl', className: 'dshdr-hl' }, line.t.slice(s, e)))
    if (e < line.t.length) children.push(line.t.slice(e))
    return children
  }
  function rowEl(row, key) {
    if (row.k === 'c') {
      return React.createElement('div', { key, className: 'dshdr-row dshdr-ctx' },
        React.createElement('span', { className: 'dshdr-ln' }, row.o),
        React.createElement('span', { className: 'dshdr-txt' }, row.t),
        React.createElement('span', { className: 'dshdr-ln' }, row.n),
        React.createElement('span', { className: 'dshdr-txt' }, row.t))
    }
    const o = row.o
    const n = row.n
    return React.createElement('div', { key, className: 'dshdr-row dshdr-pair' },
      React.createElement('span', { className: 'dshdr-ln dshdr-ln-del' }, o ? o.n : ''),
      React.createElement('span', { className: 'dshdr-txt dshdr-txt-del' }, o ? React.createElement(LineText, { line: o }) : ''),
      React.createElement('span', { className: 'dshdr-ln dshdr-ln-add' }, n ? n.n : ''),
      React.createElement('span', { className: 'dshdr-txt dshdr-txt-add' }, n ? React.createElement(LineText, { line: n }) : ''))
  }
  function collapsedBar(n) {
    return React.createElement('div', { className: 'dshdr-collapsed' }, n + ' 行未改动')
  }
  function buildNormalRows(hunks) {
    const rows = []
    for (const hunk of hunks) {
      for (const row of hunk.rows) rows.push(rowEl(row, rows.length))
    }
    return rows
  }
  function buildOnlyChangedRows(hunks) {
    const rows = []
    let ctxCount = 0
    const flush = () => {
      if (ctxCount > 0) { rows.push(collapsedBar(ctxCount)); ctxCount = 0 }
    }
    for (let hi = 0; hi < hunks.length; hi++) {
      const hunk = hunks[hi]
      if (hi === 0) {
        // 文件开头到首个 Hunk 之间未纳入 diff 的行：由首行行号推导（行号从 1 起，减 1 即前置未改动行数）
        const first = hunk.rows && hunk.rows[0]
        let firstLine = 0
        if (first) {
          if (first.k === 'c') firstLine = first.o || first.n || 0
          else firstLine = (first.o && first.o.n) || (first.n && first.n.n) || 0
        }
        const lead = firstLine > 1 ? firstLine - 1 : 0
        if (lead > 0) ctxCount += lead
      } else if (hunk.gap > 0) {
        ctxCount += hunk.gap
      }
      for (const row of hunk.rows) {
        if (row.k === 'c') { ctxCount++; continue }
        flush()
        rows.push(rowEl(row, rows.length))
      }
    }
    flush()
    return rows
  }
  function DiffView({ item }) {
    const [oc, setOc] = React.useState(onlyChanged)
    React.useEffect(() => { viewSubs.add(setOc); return () => { viewSubs.delete(setOc) } }, [])
    if (item.originalMissing) {
      return React.createElement('div', { className: 'dshdr-diff' },
        React.createElement('div', { className: 'dshdr-diff-head' },
          React.createElement('span', { className: 'dshdr-path' }, item.relPath),
          React.createElement('span', { className: 'dshdr-note' }, '原始内容未知（可能由外部命令修改），无法对比与撤销')),
        React.createElement('div', { className: 'dshdr-missing' }, React.createElement('pre', null, item.current)))
    }
    const rows = oc ? buildOnlyChangedRows(item.hunks) : buildNormalRows(item.hunks)
    return React.createElement('div', { className: 'dshdr-diff' },
      React.createElement('div', { className: 'dshdr-diff-head' },
        React.createElement('span', { className: 'dshdr-path' }, item.relPath),
        React.createElement('span', { className: 'dshdr-stats' },
          React.createElement('span', { className: 'add' }, '+' + item.stats.adds),
          React.createElement('span', { className: 'del' }, '-' + item.stats.dels)),
        React.createElement('label', { className: 'dshdr-switch', title: '仅显示改动行，未改动行折叠为计数' },
          React.createElement('input', { type: 'checkbox', checked: oc, onChange: () => toggleOnlyChanged() }),
          React.createElement('span', null, '只显示改动行'))),
      React.createElement('div', { className: 'dshdr-cols' },
        React.createElement('div', null, '原内容'),
        React.createElement('div', null, ''),
        React.createElement('div', null, '修改后'),
        React.createElement('div', null, '')),
      React.createElement('div', { className: 'dshdr-scroll' }, rows))
  }
  function actionsFor(item) {
    // gitOriginal：原文来自 git HEAD 非会话基线，撤销会回退到 HEAD 吞掉未提交工作——仅允许保留
    if (item.originalMissing || item.gitOriginal) return item.status === 'pending' ? [['keep', '保留']] : []
    if (item.status === 'pending') return [['keep', '保留'], ['revert', '撤销']]
    if (item.status === 'kept') return [['revert', '撤销']]
    return [['redo', '重做']]
  }
  function ItemRow({ item, showTurn }) {
    const [open, setOpen] = React.useState(false)
    const [detail, setDetail] = React.useState(null)
    const [error, setError] = React.useState(null)
    const [info, setInfo] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [openMenu, setOpenMenu] = React.useState(false)

    async function toggle() {
      if (!open && detail === null) setDetail(await fetchItem(item.id))
      setOpen(!open)
    }
    async function act(action) {
      setBusy(true)
      setError(null)
      setInfo(null)
      const r = await doReview(item.id, action)
      if (r && r.ok === false && r.message) setError(r.message)
      // 撤销/重做后旧 diff 已失效：重置局部 detail 缓存，避免展开时展示操作前的旧内容
      setDetail(null)
      setBusy(false)
    }
    async function openExternal(editor, diff) {
      setBusy(true)
      setError(null)
      setInfo(null)
      setOpenMenu(false)
      try {
        const r = await callHost('openExternal', Object.assign({ itemId: item.id, editor, diff }, cwdArg()))
        if (r && r.ok === true) setInfo((r.message || '已请求在外部编辑器中打开'))
        else if (r && r.message) setError(r.message)
        else setError('调用失败')
      } catch (e) { setError('调用失败') }
      setBusy(false)
    }
    const acts = actionsFor(item)
    const head = React.createElement('div', { className: 'dshdr-item-head', onClick: toggle },
      React.createElement('span', { className: 'dshdr-path' }, item.relPath),
      showTurn ? React.createElement('span', { className: 'dshdr-turn-tag' }, '第 ' + item.turn + ' 段') : null,
      React.createElement('span', { className: 'dshdr-stats' },
        React.createElement('span', { className: 'add' }, '+' + item.stats.adds),
        React.createElement('span', { className: 'del' }, '-' + item.stats.dels)),
      React.createElement(StatusBadge, { status: item.status }),
      acts.map(a => React.createElement('button', {
        key: a[0],
        className: 'dshdr-btn ' + (a[0] === 'revert' || a[0] === 'redo' ? 'danger' : 'primary'),
        disabled: busy,
        onClick: (e) => { e.stopPropagation(); act(a[0]) },
      }, a[1])),
      React.createElement('button', {
        key: 'open',
        className: 'dshdr-btn',
        disabled: busy,
        onClick: (e) => { e.stopPropagation(); setOpenMenu(!openMenu) },
      }, '其他打开方式'))
    const body = []
    if (error) body.push(React.createElement('div', { key: 'e', className: 'dshdr-error' }, error))
    if (info) body.push(React.createElement('div', { key: 'i', className: 'dshdr-info' }, info))
    if (openMenu) body.push(React.createElement('div', { key: 'om', className: 'dshdr-open-row' },
      React.createElement('button', { className: 'dshdr-btn', disabled: busy, onClick: () => openExternal('vscode', false) }, 'VS Code 打开'),
      React.createElement('button', { className: 'dshdr-btn', disabled: busy || item.originalMissing, title: item.originalMissing ? '原始内容未知' : undefined, onClick: () => openExternal('vscode', true) }, 'VS Code Diff'),
      React.createElement('button', { className: 'dshdr-btn', disabled: busy, onClick: () => openExternal('vs', false) }, 'VS 2022 打开'),
      React.createElement('button', { className: 'dshdr-btn', disabled: busy || item.originalMissing, title: item.originalMissing ? '原始内容未知' : undefined, onClick: () => openExternal('vs', true) }, 'VS 2022 Diff')))
    if (open && detail === null && !error) body.push(React.createElement('div', { key: 'l', className: 'dshdr-loading' }, '加载 diff…'))
    if (open && detail) body.push(React.createElement('div', { key: 'd', className: 'dshdr-detail', style: { padding: '4px' } }, React.createElement(DiffView, { item: detail })))
    return React.createElement('div', { className: 'dshdr-item' }, head, body.length ? React.createElement('div', null, body) : null)
  }

  function DockPanel(props) {
    resolveCurrentSession(props)
    const [snap, setSnap] = React.useState(getSnapshot())
    React.useEffect(() => subscribe(setSnap), [])
    const [open, setOpen] = React.useState(false)
    const pending = (snap && snap.pending) || []
    const pendingCount = (snap && typeof snap.pendingCount === 'number') ? snap.pendingCount : pending.length
    const loading = !!(snap && snap.loading)
    const truncated = !!(snap && snap.truncated)
    const sessions = (snap && snap.sessions) || []
    const workspaceName = (snap && snap.workspaceLabel) || (snap && snap.workspaceId ? snap.workspaceId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')
    // 严格按工作区：会话尚未映射到任何工作区时明确提示"未识别"，绝不展示其他工作区的数据
    // （字段缺失/为假一律视为未识别，杜绝"未知工作区"类误导兜底）
    const known = !!(snap && snap.sessionKnown)
    // 常驻显示：即使 0 修改也渲染总审阅栏（空态提示），便于确认插件已生效
    const head = React.createElement('div', { className: 'dshdr-bar', onClick: () => setOpen(!open) },
      React.createElement('span', { className: 'dshdr-title' },
        React.createElement('span', null, '待审阅修改'),
        React.createElement('span', { className: 'dshdr-count' }, pendingCount),
        loading ? React.createElement('span', { className: 'dshdr-loading', style: { padding: '0', marginLeft: '2px' } }, '加载中…') : null),
      React.createElement('span', { className: 'dshdr-toggle' }, open ? '收起' : '展开'),
      React.createElement('button', { className: 'dshdr-btn primary', onClick: (e) => { e.stopPropagation(); keepAll() } }, '工作区全部保留'))
    if (!open) return React.createElement('div', { className: 'dshdr-dock' }, head)
    const wsTitle = workspaceName || (currentSessionId ? '未识别（尚无对话记录）' : '获取会话信息中…')
    const wsHead = React.createElement('div', { className: 'dshdr-turn-head' },
      React.createElement('span', null, '当前工作区：' + wsTitle),
      React.createElement('span', { className: 'dshdr-turn-actions' },
        React.createElement('button', { className: 'dshdr-btn primary', onClick: () => keepAll() }, '工作区全部保留')))
    if (!known) {
      // 会话标识尚未就绪（刷新后首帧）≠ 会话确实未识别：前者提示"获取中"，稍后自动恢复
      const msg = (snap && snap.hostError === 'host-unreachable')
        ? '未能连接插件宿主（host 半未加载）。请重启 dsh 并刷新页面'
        : (snap && snap.hostError === 'old-host')
          ? '宿主版本过旧：客户端 v0.3.7 与旧版宿主不兼容。请重启 dsh 使宿主加载新版本'
          : currentSessionId
            ? '当前会话尚无对话记录，等待首个回合结束后自动识别工作区'
            : '正在获取会话信息…'
      return React.createElement('div', { className: 'dshdr-dock' },
        head,
        React.createElement('div', { className: 'dshdr-turn' },
          wsHead,
          React.createElement('div', { className: 'dshdr-loading' }, msg)))
    }
    if (loading) {
      return React.createElement('div', { className: 'dshdr-dock' },
        head,
        React.createElement('div', { className: 'dshdr-turn' },
          wsHead,
          React.createElement('div', { className: 'dshdr-loading' }, '扫描工作区中，请稍候…')))
    }
    // 整个工作区、按会话分组（pending 已由 host 按会话最近活动倒序、会话内 turn 倒序排列）
    const sessionBlocks = []
    for (const sess of sessions) {
      const items = pending.filter(i => i.sessionId === sess.id)
      if (items.length === 0) continue
      sessionBlocks.push(React.createElement('div', { key: sess.id, className: 'dshdr-session' },
        React.createElement('div', { className: 'dshdr-session-head' },
          React.createElement('span', { className: 'dshdr-session-label' }, '会话：' + sess.label + '（' + items.length + ' 项待审阅）'),
          React.createElement('button', { className: 'dshdr-btn primary', onClick: () => keepSession(sess.id) }, '本会话全部保留')),
        React.createElement('div', { className: 'dshdr-list' },
          items.map(item => React.createElement(ItemRow, { key: item.id, item, showTurn: true })))))
    }
    return React.createElement('div', { className: 'dshdr-dock' },
      head,
      React.createElement('div', { className: 'dshdr-turn' },
        wsHead,
        truncated ? React.createElement('div', { className: 'dshdr-loading' }, '工作区文件数超上限（当前上限 ' + ((snap && snap.limits && snap.limits.maxFiles) || 20000) + ' 个文件），扫描已截断（部分文件未覆盖）。可在 设置 → Diff 审阅插件 调整上限') : null,
        sessionBlocks.length === 0
          ? React.createElement('div', { className: 'dshdr-loading' }, '暂无待审阅修改')
          : React.createElement('div', null, sessionBlocks)))
  }

  function TurnTailView(props) {
    resolveCurrentSession(props)
    const turn = props && props.matched ? props.matched.turn : null
    const [snap, setSnap] = React.useState(getSnapshot())
    const [open, setOpen] = React.useState(false)
    React.useEffect(() => subscribe(setSnap), [])
    React.useEffect(() => { refresh() }, [turn])
    // 轮次归属会话：仅匹配当前会话的该轮次（turn 仅会话内唯一，跨会话同号轮次不得串数据）
    const group = snap && snap.groups ? snap.groups.find(g => g.sessionId === (currentSessionId || '') && g.turn === turn) : null
    if (!group || group.items.length === 0) return null
    const items = group.items
    const pendingCount = group.pendingCount
    const head = React.createElement('div', { className: 'dshdr-turn-head', style: { cursor: 'pointer' }, onClick: () => setOpen(!open) },
      React.createElement('span', { className: 'dshdr-toggle' }, open ? '收起' : '展开'),
      React.createElement('span', null, '第 ' + turn + ' 段对话的文件修改（' + items.length + ' 个文件' + (pendingCount > 0 ? '，' + pendingCount + ' 项待审阅' : '') + '）'),
      React.createElement('span', { className: 'dshdr-turn-actions' },
        React.createElement('button', { className: 'dshdr-btn primary', onClick: (e) => { e.stopPropagation(); doReviewGroup(turn, 'keep') } }, '本段全部保留'),
        pendingCount > 0
          ? React.createElement('button', { className: 'dshdr-btn danger', onClick: (e) => { e.stopPropagation(); doReviewGroup(turn, 'revert') } }, '本段全部撤销')
          : null))
    return React.createElement('div', { className: 'dshdr-turn' },
      head,
      open ? React.createElement('div', { className: 'dshdr-list' },
        items.map(item => React.createElement(ItemRow, { key: item.id, item, showTurn: false }))) : null)
  }

  function EditorSettingsView() {
    const [cfg, setCfg] = React.useState({ code: '', devenv: '', vsDiffMerge: '', maxFiles: 0, primeMaxFiles: 0, primeMaxChars: 0 })
    const [status, setStatus] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      callHost('getEditorConfig', {}).then((c) => {
        if (alive && c) {
          setCfg({
            code: c.code || '', devenv: c.devenv || '', vsDiffMerge: c.vsDiffMerge || '',
            maxFiles: c.maxFiles || 0, primeMaxFiles: c.primeMaxFiles || 0, primeMaxChars: c.primeMaxChars ? c.primeMaxChars / (1024 * 1024) : 0,
          })
        }
      }).catch(() => {})
      return () => { alive = false }
    }, [])
    async function save() {
      try {
        const r = await callHost('saveEditorConfig', {
          code: cfg.code, devenv: cfg.devenv, vsDiffMerge: cfg.vsDiffMerge,
          maxFiles: cfg.maxFiles, primeMaxFiles: cfg.primeMaxFiles, primeMaxChars: cfg.primeMaxChars,
        })
        setStatus(r && r.ok === true ? { ok: true, message: '已保存（标准 settings 注册，写入 settings.yaml）' } : { ok: false, message: (r && r.message) || '保存失败' })
      } catch (e) { setStatus({ ok: false, message: '保存失败' }) }
    }
    const field = (key, label, ph, type) => React.createElement('label', { className: 'dshdr-cfg-field', key: key },
      React.createElement('span', null, label),
      React.createElement('input', { type: type || 'text', value: cfg[key], placeholder: ph, onChange: (e) => setCfg({ ...cfg, [key]: e.target.value }) }))
    const numField = (key, label, ph) => React.createElement('label', { className: 'dshdr-cfg-field', key: key },
      React.createElement('span', null, label),
      React.createElement('input', { type: 'number', min: '0', step: '1', value: cfg[key] || '', placeholder: ph, onChange: (e) => setCfg({ ...cfg, [key]: Number(e.target.value) || 0 }) }))
    return React.createElement('div', { className: 'dshdr-cfg' },
      React.createElement('h3', null, '外部编辑器路径（留空自动探测）'),
      React.createElement('p', { className: 'dshdr-cfg-desc' }, '通过标准 settings 注册（命名空间 dsh-diff-review），保存后由 settings 服务写入 settings.yaml。配置优先；留空自动探测。'),
      field('code', 'VS Code（code 或 Code.exe 路径）', '如 C:\\Program Files\\Microsoft VS Code\\Code.exe'),
      field('devenv', 'VS2022（devenv.exe 路径）', '如 C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe'),
      field('vsDiffMerge', 'VS2022 Diff（vsDiffMerge.exe，可选）', '留空则从 devenv 同侧自动查找'),
      React.createElement('h3', null, '扫描与基线上限（留 0 使用默认）'),
      React.createElement('p', { className: 'dshdr-cfg-desc' }, '大工作区超过上限时扫描会被截断（dock 会提示）。提高上限可覆盖更多文件，但会占用更多内存与扫描时间。'),
      numField('maxFiles', '工作区遍历文件数上限（默认 20000）', '20000'),
      numField('primeMaxFiles', '基线预读文件数上限（默认 6000）', '6000'),
      numField('primeMaxChars', '基线预读字符预算 MB（默认 48）', '48'),
      React.createElement('div', { className: 'dshdr-cfg-actions' },
        React.createElement('button', { className: 'dshdr-btn primary', onClick: save }, '保存'),
        status && React.createElement('span', { className: status.ok ? 'dshdr-info' : 'dshdr-error' }, status.message)))
  }

  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: 'dsh-dr-pending', order: 35 },
    (props) => React.createElement(DockPanel, props),
  ))
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'dsh-dr-editor-config', order: 150, label: 'Diff 审阅插件' },
    () => React.createElement(EditorSettingsView),
  ))
  const select = (owner) => {
    // 宽松挂载：任何已结束的 turn 都挂载组件，数据匹配交给组件内部
    try {
      const t = owner && owner.turn ? owner.turn.turn : null
      if (typeof t !== 'number' || t <= 0) return null
      const status = owner.turn && owner.turn.status
      if (status === 'open') return null
      return { turn: t }
    } catch (e) { return null }
  }
  slots.inject('conversation.chat.turnTail', () => slots.register(
    { name: 'conversation.chat.turnTail', select, priority: -2 },
    (props) => React.createElement(TurnTailView, props),
  ))
}
