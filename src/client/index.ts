// dsh-diff-review client half (formal plugin)
// v0.4：通信迁移到官方 typert RPC（ctx.remote.$mount + 命名空间调用）；
// agent 由运行时注入，无需再传 sessionId。v0.8：typert 为唯一通道（无 HTTP 回退）。
import * as React from 'react'

// ---- typert remote 描述符（与 host src/host/typert.ts 的 wire 契约一致）----
// 宿主的 client loader（requireStrictCodec）要求 result/参数 codec 为 strict（mode + typeSymbol
// + zod-backed schema），src-json 会被拒（"field result has no strict codec"，0.16.2 诊断确认）。
// client 不依赖 zod：构造鸭子 zod v4 schema（_zod + identity parse）——通过形状校验，
// 运行时透传 JSON，与 host 的 z.any() 语义一致（数据校验由 host 业务层负责）。
const REMOTE_PACKAGE = 'dsh-diff-review'
const REMOTE_SERVICE = 'diffReview'
const passthroughSchema = { _zod: {}, parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) }
const strictJson = { mode: 'strict', typeSymbol: 'dsh-diff-review#json', schema: passthroughSchema }
const agentStrict = { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', schema: passthroughSchema }
function descriptor(method) {
  return {
    id: REMOTE_PACKAGE + '#' + REMOTE_SERVICE + '/' + method,
    service: REMOTE_SERVICE,
    namespace: REMOTE_SERVICE,
    method,
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentStrict },
      { name: 'request', wire: 'request', source: 'json', codec: strictJson },
    ],
    result: strictJson,
  }
}
const TYPERT_REMOTE = {
  package: REMOTE_PACKAGE,
  descriptors: ['getState', 'getItem', 'review', 'reviewGroup', 'reviewSession', 'reviewAll', 'clearReviewed', 'openExternal', 'getEditorConfig', 'saveEditorConfig'].map(descriptor),
}

let pluginCtx = null

// callHost 读取当前 sessionId 的闭包引用（apply 内赋值），用作 lookup 参数
let getCurrentSessionId = () => ''

let remoteNs = null
async function initRemote() {
  if (remoteNs) return remoteNs
  if (!pluginCtx || !pluginCtx.remote) {
    const e = new Error('dsh-diff-review: client remote service unavailable')
    console.error('[dsh-diff-review] initRemote 失败: remote 服务不可用', e)
    throw e
  }
  try {
    await pluginCtx.remote.$mount(TYPERT_REMOTE)
  } catch (e) {
    console.error('[dsh-diff-review] initRemote 失败: $mount 抛错（descriptors=' + TYPERT_REMOTE.descriptors.length + '）', e)
    throw e
  }
  remoteNs = pluginCtx.get('remote.' + REMOTE_SERVICE)
  if (!remoteNs) {
    const e = new Error('dsh-diff-review: diffReview remote unavailable')
    console.error('[dsh-diff-review] initRemote 失败: get(remote.diffReview) 返回空', e)
    throw e
  }
  return remoteNs
}

// callHost：唯一通道 = typert RPC。
// 调用约定（v0.16.5 修正）：官方生成的命名空间方法签名 = (lookup 参数, 业务参数...)。
// 官方 client（ui-goal 等）显式传 sessionId 作为 lookup 参数（agent 标识），如
// ctx.remote.goals.edit(sessionId, ref, req)——gateway 用 resolveAgent(sessionId) 注入
// 完整 agent 到 host 方法。本插件 descriptor 的 lookup 参数是第一个（agent），业务
// 参数是第二个（request），故调用为 ns[action](sessionId, request)。sessionId 来自
// slot standard props（resolveCurrentSession 捕获，见 apply 内 currentSessionId）。
// 之前的错误链：v0.16.4 传 (undefined, request) 使 request 落错位（arity 2 通过但
// host 断言缺 request）；ca71e7d 传 (request) 单参又少了 lookup 位（arity 期望 2）。
// 返回解包：命名空间方法返回 RemoteResult<{ ok, value }> 包装，业务数据在 value 里。
async function callHost(action, args) {
  try {
    const ns = await initRemote()
    const sid = typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : ''
    const r = await ns[action](sid, args || {})
    // 诊断：打印 r 的原始形状（类型 + 键列表 + ok/value 摘要），字段变化时打一次
    try {
      const sig = action + ':' + (r == null ? 'null' : typeof r === 'object' ? Object.keys(r).join(',') : typeof r) + ':' + String(r && typeof r === 'object' ? (r.ok === true ? 'ok:' + JSON.stringify(r.value).substring(0, 200) : 'err:' + JSON.stringify(r.error)) : r)
      if (typeof window !== 'undefined' && window.__dshdrRpcSig !== sig) {
        window.__dshdrRpcSig = sig
        console.error('[dsh-diff-review] callHost 原始返回(' + action + '): ' + sig)
      }
    } catch (de) { /* 诊断失败忽略 */ }
    if (r && typeof r === 'object' && 'ok' in r) {
      if (r.ok === true) return r.value
      // ok=false：RPC 层业务错误，返回带 message 的错误对象（与旧 HTTP 语义一致）
      return { ok: false, message: (r.error && (r.error.message || JSON.stringify(r.error))) || 'RPC 调用失败' }
    }
    return r
  } catch (e) {
    console.error('[dsh-diff-review] callHost(' + action + ') 失败:', e)
    throw e
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
  // callHost 需要显式传 sessionId 作为 lookup 参数（官方 typert 调用约定）——
  // 通过闭包函数暴露 apply 内的 currentSessionId
  let currentSessionIdRef = ''
  getCurrentSessionId = () => currentSessionIdRef

  // 初始 state 补全全部字段：首帧渲染（fetch 尚未返回）时不出现「未知工作区」误导文案，
  // 而是按"未识别"处理，等首次轮询返回后纠正
  let state = { rev: 0, maxTurn: 0, workspaceId: null, workspaceLabel: '', sessionId: '', sessionKnown: false, loading: false, truncated: false, lastTurn: 0, pendingCount: 0, sessions: [], groups: [], pending: [], live: [], skippedCount: 0, detectMode: 'turn', liveRevert: false, respectGitignore: true, liveSupported: false, watcherActive: false, liveError: '', liveStats: { events: 0, checks: 0, items: 0 } }
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
        currentSessionIdRef = props.sessionId
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
      // client 诊断（去重：仅字段变化时打印一次，避免 2 秒轮询刷屏）
      try {
        const sig = (st ? [st.sessionId, st.workspaceId, st.sessionKnown, st.hostError, st.loading].join('|') : 'null')
        if (window && !window.__dshdrLastSig) window.__dshdrLastSig = ''
        if (typeof window !== 'undefined' && window.__dshdrLastSig !== sig) {
          window.__dshdrLastSig = sig
          console.error('[dsh-diff-review] getState 响应: sessionId=' + String(st && st.sessionId) + ' workspaceId=' + String(st && st.workspaceId) + ' sessionKnown=' + String(st && st.sessionKnown) + ' hostError=' + String(st && st.hostError) + ' loading=' + String(st && st.loading))
        }
      } catch (e) { /* 诊断失败忽略 */ }
      if (st && Array.isArray(st.pending) && Array.isArray(st.groups)) {
        // 版本防护：v0.3.7 客户端 + 旧版宿主（返回旧 schema，无 workspaceId）→
        // 提示重启 dsh，而不是把缺失字段误读成"未识别工作区"
        if (typeof st.workspaceId !== 'string') {
          if (state.hostError !== 'old-host') {
            state = Object.assign({}, state, { hostError: 'old-host', sessionKnown: false, loading: false })
            emit()
          }
        } else if (st.hostError !== state.hostError || !!st.sessionKnown !== !!state.sessionKnown || st.pendingCount !== state.pendingCount || (st.sessions || []).length !== (state.sessions || []).length || st.rev !== state.rev || !!st.loading !== !!state.loading || st.maxTurn !== state.maxTurn || st.workspaceId !== state.workspaceId || st.detectMode !== state.detectMode || !!st.liveRevert !== !!state.liveRevert || !!st.respectGitignore !== !!state.respectGitignore || !!st.watcherActive !== !!state.watcherActive || (st.liveError || '') !== (state.liveError || '') || !!st.truncated !== !!state.truncated || (st.skippedCount || 0) !== (state.skippedCount || 0) || (st.limits && st.limits.maxFiles) !== (state.limits && state.limits.maxFiles) || (st.liveStats && st.liveStats.events) !== (state.liveStats && state.liveStats.events) || (st.liveStats && st.liveStats.items) !== (state.liveStats && state.liveStats.items)) {
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
  // 每个 item 独立请求序号：防止慢响应覆盖新请求的结果（快速展开/折叠同一 item 的竞态）。
  // 按 itemId 分桶而非全局序号——展开 A 后再展开 B 时，A 的在途响应不会被 B 的序号
  // 误判为过期而丢弃（否则 A 详情永远进不了缓存，界面一直停在"加载 diff…"）
  const itemSeqs = new Map()
  async function fetchItem(itemId) {
    if (detailCache.has(itemId)) return detailCache.get(itemId)
    const seq = (itemSeqs.get(itemId) || 0) + 1
    itemSeqs.set(itemId, seq)
    try {
      const d = await callHost('getItem', Object.assign({ itemId }, cwdArg()))
      // 错误对象（记录不存在/无权限）不缓存为 detail，返回给 ItemRow 展示错误而非卡"加载 diff…"
      if (d && d.ok === false) return { error: d.message || '记录不存在' }
      if (seq === itemSeqs.get(itemId) && d) detailCache.set(itemId, d)
      return seq === itemSeqs.get(itemId) ? d : null
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
    let results = null
    try { results = await callHost('reviewGroup', Object.assign({ turn, action }, cwdArg())) } catch (e) {}
    // 逐项失败不静默：收集失败结果供调用方（TurnTailView）展示
    let firstError = null
    if (results && Array.isArray(results.results)) {
      for (const r of results.results) {
        if (r && r.result && r.result.ok === false && r.result.message) { firstError = r.result.message; break }
      }
    }
    const prefix = (currentSessionId || '') + '::' + turn + '::'
    for (const key of Array.from(detailCache.keys())) {
      if (key.indexOf(prefix) === 0) detailCache.delete(key)
    }
    await refresh()
    return firstError
  }
  async function keepAll() {
    try { await callHost('reviewAll', cwdArg()) } catch (e) {}
    detailCache.clear() // 全部保留后清缓存，避免展开旧 status
    await refresh()
  }
  async function clearReviewed() {
    try { await callHost('clearReviewed', cwdArg()) } catch (e) {}
    detailCache.clear()
    await refresh()
  }
  async function keepSession(sessionId) {
    // 目标会话经 targetSessionId 显式传递：host 侧 sessionId 由 agent 覆盖（不可伪造），
    // targetSessionId 用于定位目标会话并校验其与当前 agent 同工作区——
    // 修复 typert 迁移期"点 B 会话按钮实际保留 A 会话"的静默错位
    let err = null
    try {
      const r = await callHost('reviewSession', Object.assign({}, cwdArg(), { targetSessionId: sessionId }))
      if (r && r.ok === false && r.message) err = r.message
    } catch (e) { err = '调用失败' }
    // 前缀精确匹配（startsWith 比 indexOf 切割更稳：item id 为 sessionId::turn::path）
    for (const key of Array.from(detailCache.keys())) {
      if (key.indexOf(sessionId + '::') === 0) detailCache.delete(key)
    }
    await refresh()
    return err
  }

  ctx.effect(() => ctx.interval(() => {
    // 页面不可见时暂停轮询（无意义请求）；恢复可见后下一个 tick 自动恢复
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    refresh()
  }, 2000))
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  })
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
    '.dshdr-turn { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 10px; padding: 8px 10px; border: 1px solid rgba(128,128,128,0.35); border-radius: 10px; background: rgba(128,128,128,0.1); max-height: 50vh; overflow-y: auto; overflow-x: hidden; }\n' +
    '.dshdr-turn-head { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 600; flex-wrap: wrap; }\n' +
    '.dshdr-turn-actions { margin-left: auto; display: flex; gap: 6px; }\n' +
    '.dshdr-diff { border: 1px solid rgba(128,128,128,0.35); border-radius: 8px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }\n' +
    '.dshdr-diff-head { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-bottom: 1px solid rgba(128,128,128,0.3); background: rgba(128,128,128,0.1); font-family: inherit; }\n' +
    '.dshdr-diff-head .dshdr-path { font-family: inherit; flex: 0 1 auto; }\n' +
    '.dshdr-switch { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: 11px; color: rgba(128,128,128,0.95); cursor: pointer; user-select: none; white-space: nowrap; }\n' +
    '.dshdr-switch input { accent-color: #2ea043; cursor: pointer; }\n' +
    '.dshdr-note { font-size: 11px; color: rgba(128,128,128,0.9); }\n' +
    '.dshdr-cols { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid rgba(128,128,128,0.3); }\n' +
    '.dshdr-cols > div { padding: 3px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: rgba(128,128,128,0.9); }\n' +
    // 两栏布局：左右各一个面板，面板级横向滚动（左=修改前、右=修改后，各自滚长行）；
    // 纵向滚动由外层 .dshdr-scroll 统一承担（左右行号保持同步）
    '.dshdr-scroll { max-height: 360px; overflow-y: auto; overflow-x: hidden; }\n' +
    '.dshdr-diff-body { display: grid; grid-template-columns: 1fr 1fr; }\n' +
    '.dshdr-pane { min-width: 0; }\n' +
    '.dshdr-pane + .dshdr-pane { border-left: 1px solid rgba(128,128,128,0.2); }\n' +
    '.dshdr-pane-scroll { overflow-x: auto; }\n' +
    '.dshdr-pane-row { display: grid; grid-template-columns: 3.4em minmax(0, 1fr); }\n' +
    '.dshdr-pane-row .dshdr-ln { padding: 0 6px; text-align: right; color: rgba(128,128,128,0.8); background: rgba(128,128,128,0.08); user-select: none; }\n' +
    '.dshdr-pane-row .dshdr-txt { padding: 0 8px; white-space: pre; }\n' +
    '.dshdr-pane-row.dshdr-row-del .dshdr-txt { background: rgba(248,81,73,0.18); }\n' +
    '.dshdr-pane-row.dshdr-row-add .dshdr-txt { background: rgba(46,160,67,0.2); }\n' +
    '.dshdr-pane-row.dshdr-row-del .dshdr-ln { background: rgba(248,81,73,0.14); }\n' +
    '.dshdr-pane-row.dshdr-row-add .dshdr-ln { background: rgba(46,160,67,0.16); }\n' +
    '.dshdr-collapsed { text-align: center; font-size: 11px; color: rgba(128,128,128,0.8); padding: 1px 0; border-top: 1px dashed rgba(128,128,128,0.3); border-bottom: 1px dashed rgba(128,128,128,0.3); background: rgba(128,128,128,0.06); }\n' +
    '.dshdr-hl { background: rgba(248,81,73,0.5); }\n' +
    '.dshdr-row-add .dshdr-hl { background: rgba(46,160,67,0.55); }\n' +
    '.dshdr-error { color: #f85149; font-size: 12px; padding: 2px 10px 6px; }\n' +
    '.dshdr-info { color: #2ea043; font-size: 12px; padding: 2px 10px 6px; }\n' +
    '.dshdr-loading { color: rgba(128,128,128,0.9); font-size: 12px; padding: 6px 10px; }\n' +
    '.dshdr-cfg { display: flex; flex-direction: column; gap: 10px; padding: 16px; max-width: 640px; }\n' +
    '.dshdr-cfg h3 { margin: 0; font-size: 15px; font-weight: 600; }\n' +
    '.dshdr-cfg .dshdr-cfg-desc { margin: 0; font-size: 12px; color: rgba(128,128,128,0.9); }\n' +
    '.dshdr-cfg-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }\n' +
    '.dshdr-cfg-field input { padding: 6px 8px; border: 1px solid rgba(128,128,128,0.4); border-radius: 6px; background: rgba(128,128,128,0.08); color: inherit; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n' +
    '.dshdr-cfg-field input[type="checkbox"] { width: 16px; height: 16px; padding: 0; border: none; border-radius: 0; background: none; accent-color: #2ea043; }\n' +
    '.dshdr-cfg-field textarea { padding: 6px 8px; min-height: 44px; width: 100%; box-sizing: border-box; border: 1px solid rgba(128,128,128,0.4); border-radius: 6px; background: rgba(128,128,128,0.08); color: inherit; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical; }\n' +
    '.dshdr-cfg-field input:focus { outline: none; border-color: rgba(46,160,67,0.6); }\n' +
    '.dshdr-cfg-field select { padding: 6px 8px; min-height: 32px; width: 100%; box-sizing: border-box; border: 1px solid rgba(128,128,128,0.4); border-radius: 6px; background: rgba(128,128,128,0.08); color: inherit; font-size: 13px; }\n' +
    '.dshdr-cfg-field select option { background: #1f2328; color: inherit; }\n' +
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
  function LineTextPane({ t, hl }) {
    if (!hl) return t
    const { s, e } = hl
    const children = []
    if (s > 0) children.push(t.slice(0, s))
    children.push(React.createElement('span', { key: 'hl', className: 'dshdr-hl' }, t.slice(s, e)))
    if (e < t.length) children.push(t.slice(e))
    return children
  }
  // 结构化行流 → 左右两栏（左=修改前旧行，右=修改后新行；ctx 行两侧同文本，del/add 只落各自侧）
  function buildPaneRows(rows) {
    const left = []
    const right = []
    for (const row of rows) {
      if (row.k === 'collapsed') { left.push({ k: 'collapsed', n: row.n }); continue }
      if (row.k === 'c') {
        left.push({ k: 'c', ln: row.o, t: row.t, hl: null })
        right.push({ k: 'c', ln: row.n, t: row.t, hl: null })
      } else {
        if (row.o) left.push({ k: 'p', ln: row.o.n, t: row.o.t, hl: row.o.hl, kind: 'del' })
        if (row.n) right.push({ k: 'p', ln: row.n.n, t: row.n.t, hl: row.n.hl, kind: 'add' })
      }
    }
    return { left, right }
  }
  function paneRowEl(row, key) {
    if (row.k === 'collapsed') {
      return React.createElement('div', { key, className: 'dshdr-collapsed' }, row.n + ' 行未改动')
    }
    const cls = row.kind ? 'dshdr-pane-row dshdr-row-' + row.kind : 'dshdr-pane-row'
    return React.createElement('div', { key, className: cls },
      React.createElement('span', { className: 'dshdr-ln' }, row.ln),
      React.createElement('span', { className: 'dshdr-txt' }, React.createElement(LineTextPane, { t: row.t, hl: row.hl })))
  }
  function buildNormalRows(hunks) {
    const rows = []
    for (const hunk of hunks) {
      for (const row of hunk.rows) {
        if (row.k === 'c') rows.push({ k: 'c', o: row.o, n: row.n, t: row.t })
        else rows.push({ k: 'p', o: row.o, n: row.n })
      }
    }
    return rows
  }
  function buildOnlyChangedRows(hunks) {
    const rows = []
    let ctxCount = 0
    const flush = () => {
      if (ctxCount > 0) { rows.push({ k: 'collapsed', n: ctxCount }); ctxCount = 0 }
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
        if (row.o || row.n) rows.push({ k: 'p', o: row.o, n: row.n })
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
    const { left, right } = buildPaneRows(rows)
    const pane = (list, key) => React.createElement('div', { key, className: 'dshdr-pane' },
      React.createElement('div', { className: 'dshdr-pane-scroll' },
        list.map((r, i) => paneRowEl(r, i))))
    return React.createElement('div', { className: 'dshdr-diff' },
      React.createElement('div', { className: 'dshdr-diff-head' },
        React.createElement('span', { className: 'dshdr-path' }, item.relPath),
        React.createElement('span', { className: 'dshdr-stats' },
          React.createElement('span', { className: 'add' }, '+' + item.stats.adds),
          React.createElement('span', { className: 'del' }, '-' + item.stats.dels)),
        item.degraded
          ? React.createElement('span', { className: 'dshdr-note', title: '文件行数过多（超过约 2048×2048 行对），无法精确计算差异，已退化为全量删除+新增' }, '大文件 diff 已简化')
          : null,
        item.gitOriginal
          ? React.createElement('span', { className: 'dshdr-note', title: '该文件在基线预算外（或会话开始前未缓存），对比基准来自 git HEAD 而非会话开始前内容——撤销会把文件回退到 HEAD、吞掉未提交工作，故仅可保留' }, '原文来自 git HEAD（仅可保留）')
          : null,
        React.createElement('label', { className: 'dshdr-switch', title: '仅显示改动行，未改动行折叠为计数' },
          React.createElement('input', { type: 'checkbox', checked: oc, onChange: () => toggleOnlyChanged() }),
          React.createElement('span', null, '只显示改动行'))),
      React.createElement('div', { className: 'dshdr-cols' },
        React.createElement('div', null, '原内容'),
        React.createElement('div', null, '修改后')),
      React.createElement('div', { className: 'dshdr-scroll' },
        React.createElement('div', { className: 'dshdr-diff-body' },
          pane(left, 'left'),
          pane(right, 'right'))))
  }
  function actionsFor(item, liveRevert) {
    // 实时预览项：默认只读；仅当设置开启实时撤销（liveRevert）时才显示撤销按钮
    // （保留无意义——回合结束自动成为正式项）
    if (item.live) {
      if (!liveRevert || item.originalMissing || item.gitOriginal) return []
      return item.status === 'pending' ? [['revert', '撤销']] : []
    }
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
      if (!open && detail === null) {
        const d = await fetchItem(item.id)
        if (d && d.error) { setError(d.error); setOpen(true); return }
        setDetail(d)
      }
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
    const acts = actionsFor(item, !!(getSnapshot() && getSnapshot().liveRevert))
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
      // 实时预览项也可外部打开（打开的是当前工作区文件本身）
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
      React.createElement('button', { className: 'dshdr-btn', disabled: busy || item.originalMissing, title: item.originalMissing ? '原始内容未知' : undefined, onClick: () => openExternal('vs', true) }, 'VS 2022 Diff'),
      React.createElement('button', { className: 'dshdr-btn', disabled: busy, onClick: () => openExternal('explorer', false) }, '在资源管理器中显示')))
    if (open && detail === null && !error) body.push(React.createElement('div', { key: 'l', className: 'dshdr-loading' }, '加载 diff…'))
    if (open && detail) body.push(React.createElement('div', { key: 'd', className: 'dshdr-detail', style: { padding: '4px' } }, React.createElement(DiffView, { item: detail })))
    return React.createElement('div', { className: 'dshdr-item' }, head, body.length ? React.createElement('div', null, body) : null)
  }

  function DockPanel(props) {
    // 会话解析放入 effect：避免渲染期副作用（内部可能触发 refresh 网络请求）
    React.useEffect(() => { resolveCurrentSession(props) }, [props && props.sessionId])
    const [snap, setSnap] = React.useState(getSnapshot())
    React.useEffect(() => subscribe(setSnap), [])
    const [open, setOpen] = React.useState(false)
    const [sessionError, setSessionError] = React.useState(null)
    const pending = (snap && snap.pending) || []
    const pendingCount = (snap && typeof snap.pendingCount === 'number') ? snap.pendingCount : pending.length
    // 实时模式：徽记应反映进行中修改——把 live 预览项数并入总数（正式项 + 实时预览），
    // 否则 detectMode=live 时文件一变徽记不刷新（live 项在回合结束才并入正式 pending）
    const liveCount = (snap && Array.isArray(snap.live)) ? snap.live.length : 0
    const badgeCount = pendingCount + liveCount
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
        React.createElement('span', { className: 'dshdr-count' }, badgeCount),
        loading ? React.createElement('span', { className: 'dshdr-loading', style: { padding: '0', marginLeft: '2px' } }, '加载中…') : null),
      React.createElement('span', { className: 'dshdr-toggle' }, open ? '收起' : '展开'),
      React.createElement('button', { className: 'dshdr-btn primary', onClick: (e) => { e.stopPropagation(); keepAll() } }, '工作区全部保留'))
    if (!open) return React.createElement('div', { className: 'dshdr-dock' }, head)
    const wsTitle = workspaceName || (currentSessionId ? '未识别（尚无对话记录）' : '获取会话信息中…')
    const wsHead = React.createElement('div', { className: 'dshdr-turn-head' },
      React.createElement('span', null, '当前工作区：' + wsTitle),
      React.createElement('span', { className: 'dshdr-turn-actions' },
        React.createElement('button', { className: 'dshdr-btn primary', onClick: () => keepAll() }, '工作区全部保留'),
        React.createElement('button', { className: 'dshdr-btn', onClick: () => clearReviewed(), title: '清除已保留/已撤销的记录（审阅列表瘦身）' }, '清理已处理')))
    if (!known) {
      // 会话标识尚未就绪（刷新后首帧）≠ 会话确实未识别：前者提示"获取中"，稍后自动恢复
      const msg = (snap && snap.hostError === 'host-unreachable')
        ? '未能连接插件宿主（host 半未加载）。请重启 dsh 并刷新页面'
        : (snap && snap.hostError === 'old-host')
          ? '宿主版本过旧：与当前客户端不兼容。请重启 dsh 使宿主加载新版本'
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
    // 实时预览块（detectMode='live' 时 host 返回）：进行中的修改，只读展示
    const liveItems = (snap && snap.live) || []
    // 实时模式状态提示（诊断 + 可观测）：watcher 失败原因 / 已开启
    const liveMode = !!(snap && snap.detectMode === 'live')
    const liveStats = (snap && snap.liveStats) || { events: 0, checks: 0, items: 0 }
    const liveStatus = liveMode
      ? (snap && snap.liveError
          ? React.createElement('div', { className: 'dshdr-error' }, '实时预览不可用：' + snap.liveError)
          : snap && snap.watcherActive
            ? React.createElement('div', { className: 'dshdr-note', style: { padding: '2px 10px 0' } }, '实时预览已开启（已收到 ' + liveStats.events + ' 次文件事件，' + liveStats.items + ' 项预览）')
            : React.createElement('div', { className: 'dshdr-note', style: { padding: '2px 10px 0' } }, '实时预览：等待工作区就绪…'))
      : null
    const liveBlock = liveItems.length > 0
      ? React.createElement('div', { className: 'dshdr-session' },
          React.createElement('div', { className: 'dshdr-session-head' },
            React.createElement('span', { className: 'dshdr-session-label' }, '进行中修改（实时预览）'),
            React.createElement('span', { className: 'dshdr-note' }, '工作区级 · 回合结束后并入正式审阅项')),
          React.createElement('div', { className: 'dshdr-list' },
            liveItems.map(item => React.createElement(ItemRow, { key: item.id, item, showTurn: false }))))
      : null
    // 整个工作区、按会话分组（pending 已由 host 按会话最近活动倒序、会话内 turn 倒序排列）
    const sessionBlocks = []
    for (const sess of sessions) {
      const items = pending.filter(i => i.sessionId === sess.id)
      if (items.length === 0) continue
      sessionBlocks.push(React.createElement('div', { key: sess.id, className: 'dshdr-session' },
        React.createElement('div', { className: 'dshdr-session-head' },
          React.createElement('span', { className: 'dshdr-session-label' }, '会话：' + sess.label + '（' + items.length + ' 项待审阅）'),
          React.createElement('button', { className: 'dshdr-btn primary', onClick: async () => {
            const e = await keepSession(sess.id)
            if (e) setSessionError(e)
          } }, '本会话全部保留')),
        React.createElement('div', { className: 'dshdr-list' },
          items.map(item => React.createElement(ItemRow, { key: item.id, item, showTurn: true })))))
    }
    return React.createElement('div', { className: 'dshdr-dock' },
      head,
      React.createElement('div', { className: 'dshdr-turn' },
        wsHead,
        sessionError ? React.createElement('div', { className: 'dshdr-error', style: { padding: '2px 10px' } }, sessionError) : null,
        liveStatus,
        truncated ? React.createElement('div', { className: 'dshdr-loading' }, '工作区文件数超上限（当前上限 ' + ((snap && snap.limits && snap.limits.maxFiles) || 20000) + ' 个文件），扫描已截断（部分文件未覆盖）。可在 设置 → Diff 审阅插件 调整上限') : null,
        (snap && snap.skippedCount > 0) ? React.createElement('div', { className: 'dshdr-note', style: { padding: '2px 10px 0' } }, '有 ' + snap.skippedCount + ' 个文件因过大/不可读未纳入审阅（默认上限 2MB）') : null,
        liveBlock,
        sessionBlocks.length === 0
          ? React.createElement('div', { className: 'dshdr-loading' }, '暂无待审阅修改')
          : React.createElement('div', null, sessionBlocks)))
  }

  function TurnTailView(props) {
    // 会话解析放入 effect：避免渲染期副作用（内部可能触发 refresh 网络请求）
    React.useEffect(() => { resolveCurrentSession(props) }, [props && props.sessionId])
    const turn = props && props.matched ? props.matched.turn : null
    const [snap, setSnap] = React.useState(getSnapshot())
    const [open, setOpen] = React.useState(false)
    const [groupError, setGroupError] = React.useState(null)
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
        React.createElement('button', { className: 'dshdr-btn primary', onClick: async (e) => { e.stopPropagation(); setGroupError(await doReviewGroup(turn, 'keep')) } }, '本段全部保留'),
        pendingCount > 0
          ? React.createElement('button', { className: 'dshdr-btn danger', onClick: async (e) => { e.stopPropagation(); setGroupError(await doReviewGroup(turn, 'revert')) } }, '本段全部撤销')
          : null))
    return React.createElement('div', { className: 'dshdr-turn' },
      head,
      groupError ? React.createElement('div', { className: 'dshdr-error', style: { padding: '0 10px' } }, groupError) : null,
      open ? React.createElement('div', { className: 'dshdr-list' },
        items.map(item => React.createElement(ItemRow, { key: item.id, item, showTurn: false }))) : null)
  }

  function EditorSettingsView() {
    const [cfg, setCfg] = React.useState({ code: '', devenv: '', vsDiffMerge: '', maxFiles: 0, primeMaxFiles: 0, primeMaxChars: 0, detectMode: 'turn', liveRevert: false, respectGitignore: true, extraIgnoreFiles: '', trackNewFiles: false, liveSupported: false })
    const [status, setStatus] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      callHost('getEditorConfig', {}).then((c) => {
        console.error('[dsh-diff-review] getEditorConfig 响应: ' + JSON.stringify(c))
        if (alive && c) {
          setCfg({
            code: c.code || '', devenv: c.devenv || '', vsDiffMerge: c.vsDiffMerge || '',
            maxFiles: c.maxFiles || 0, primeMaxFiles: c.primeMaxFiles || 0, primeMaxChars: c.primeMaxChars ? c.primeMaxChars / (1024 * 1024) : 0,
            detectMode: c.detectMode === 'live' ? 'live' : 'turn',
            liveRevert: !!c.liveRevert,
            respectGitignore: c.respectGitignore !== false,
            extraIgnoreFiles: (c.extraIgnoreFiles && Array.isArray(c.extraIgnoreFiles)) ? c.extraIgnoreFiles.join('\n') : '',
            trackNewFiles: !!c.trackNewFiles,
            liveSupported: c.liveSupported !== false,
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
          detectMode: cfg.detectMode,
          liveRevert: cfg.liveRevert,
          respectGitignore: cfg.respectGitignore,
          extraIgnoreFiles: cfg.extraIgnoreFiles || '',
          trackNewFiles: cfg.trackNewFiles,
        })
        console.error('[dsh-diff-review] saveEditorConfig 响应: ' + JSON.stringify(r))
        setStatus(r && r.ok === true ? { ok: true, message: '已保存（标准 settings 注册，写入 settings.yaml）' } : { ok: false, message: (r && r.message) || '保存失败' })
      } catch (e) { console.error('[dsh-diff-review] saveEditorConfig 调用抛错', e); setStatus({ ok: false, message: '保存失败' }) }
    }
    const field = (key, label, ph, type) => React.createElement('label', { className: 'dshdr-cfg-field', key: key },
      React.createElement('span', null, label),
      React.createElement('input', { type: type || 'text', value: cfg[key], placeholder: ph, onChange: (e) => setCfg({ ...cfg, [key]: e.target.value }) }))
    const numField = (key, label, ph) => React.createElement('label', { className: 'dshdr-cfg-field', key: key },
      React.createElement('span', null, label),
      React.createElement('input', { type: 'number', min: '0', step: '1', value: cfg[key] || '', placeholder: ph, onChange: (e) => setCfg({ ...cfg, [key]: Number(e.target.value) || 0 }) }))
    return React.createElement('div', { className: 'dshdr-cfg' },
      React.createElement('h3', null, '检测模式'),
      React.createElement('p', { className: 'dshdr-cfg-desc' }, '回合结束：每段对话结束后检测文件修改（默认，跨平台）。实时预览：对话进行中即检测并显示只读预览（仅 Windows，watcher 监听工作区；回合结束后并入正式审阅项）。'),
      React.createElement('label', { className: 'dshdr-cfg-field', key: 'detectMode' },
        React.createElement('span', null, '检测模式'),
        React.createElement('select', { value: cfg.detectMode, onChange: (e) => setCfg({ ...cfg, detectMode: e.target.value }) },
          React.createElement('option', { value: 'turn' }, '回合结束（默认）'),
          React.createElement('option', { value: 'live', disabled: !cfg.liveSupported }, '实时预览（' + (cfg.liveSupported ? '仅 Windows' : '当前平台不支持') + '）'))),
      React.createElement('label', { className: 'dshdr-cfg-field', key: 'liveRevert' },
        React.createElement('span', null, '实时预览允许撤销（默认关闭）'),
        React.createElement('input', { type: 'checkbox', checked: cfg.liveRevert, onChange: (e) => setCfg({ ...cfg, liveRevert: e.target.checked }) })),
      React.createElement('label', { className: 'dshdr-cfg-field', key: 'respectGitignore' },
        React.createElement('span', null, '尊重 .gitignore（默认开启）'),
        React.createElement('input', { type: 'checkbox', checked: cfg.respectGitignore, onChange: (e) => setCfg({ ...cfg, respectGitignore: e.target.checked }) })),
      React.createElement('label', { className: 'dshdr-cfg-field', key: 'extraIgnoreFiles' },
        React.createElement('span', null, '自定义忽略文件（每行一个路径，可工作区外；仅只读匹配）'),
        React.createElement('textarea', { rows: 2, value: cfg.extraIgnoreFiles || '', placeholder: '如 C:\\Users\\you\\.dsh\\extra-ignore.txt（.gitignore 格式）', onChange: (e) => setCfg({ ...cfg, extraIgnoreFiles: e.target.value }) })),
      React.createElement('label', { className: 'dshdr-cfg-field', key: 'trackNewFiles' },
        React.createElement('span', null, '跟踪新建文件（默认关闭；开启后新文件也显示，仅可保留不可撤销）'),
        React.createElement('input', { type: 'checkbox', checked: cfg.trackNewFiles, onChange: (e) => setCfg({ ...cfg, trackNewFiles: e.target.checked }) })),
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
