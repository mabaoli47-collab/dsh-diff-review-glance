// dsh-diff-review host half (formal plugin)
// 从动态插件 v5.5 固化：harness.handle → webServer 路由，defineTool/registerTool → ctx.tools.register
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-diff-review'
// 只声明根组合顶层可见的服务；shell/sandboxPolicy 是 scoped/可选服务，用 ctx.get 惰性读取
export const inject = ['fs', 'webServer', 'tools', 'settings']

export function apply(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const webServer = ctx.get('webServer')
  const tools = ctx.get('tools')
  const shell = ctx.get('shell')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const settings = ctx.get('settings')

  const IGNORE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'dist', 'build', 'out', 'coverage', 'target', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.dsh-dr-tmp-orig'])
  const MAX_FILES = 20000
  const MAX_DEPTH = 32
  const MAX_READ_BYTES = 2 * 1024 * 1024
  const CACHE_NEW_BYTES = 1024 * 1024
  const PRIME_MAX_FILES = 6000
  const PRIME_MAX_CHARS = 48 * 1024 * 1024
  const CONTEXT = 3
  const MAX_LCS_CELLS = 4 * 1024 * 1024
  const CONFIG_NS = 'dsh-diff-review'
  const ROUTE = '/dsh-diff-review'

  // 多基线设计：每个工作区（cwd）一个独立状态桶
  const STORES = new Map()
  let active = null
  // 会话注册表（第二层）：sessionId -> { cwd: canonCwd, lastTurn: number, label: string }
  // dsh 会话持有自己的工作区与轮次计数；turn 仅会话内唯一，同工作区可挂多个会话
  const SESSIONS = new Map()

  function makeStore(cwd) {
    return {
      cwd,
      session: null,
      baseline: null,
      baselineError: null,
      scanning: false,
      baselineLoading: false,
      fileMeta: new Map(),
      contentCache: new Map(),
      groups: new Map(),
      items: new Map(),
      sessions: new Map(), // sessionId -> { lastTurn, label }：本工作区关联的会话（反向索引）
      lastTurn: 0,
      rev: 0,
      scanCount: 0,
      lastError: null,
      walkFileCount: 0,
      truncated: false,
      scanChain: Promise.resolve(),
    }
  }
  // 规范化 cwd：统一分隔符 + 去尾斜杠 + Windows 盘符路径整体小写
  // （Windows 文件系统大小写不敏感，C:/Foo 与 c:/foo 是同一目录）
  function canonCwd(cwd) {
    let c = String(cwd).replace(/\\/g, '/')
    while (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1)
    if (/^[a-zA-Z]:\//.test(c)) c = c.toLowerCase()
    return c
  }
  function getStore(cwd) {
    const key = canonCwd(cwd)
    let s = STORES.get(key)
    if (!s) {
      s = makeStore(key)
      STORES.set(key, s)
    }
    return s
  }
  function pickStore(args) {
    // 严格按工作区划分：显式携带会话标识或 cwd 时，只认精确映射，
    // 未命中绝不回退到"最近活跃"桶——避免把其他工作区的审阅项
    // 误判为当前工作区（会误导用户对自身代码资产的检查）。
    if (args && typeof args.sessionId === 'string' && args.sessionId) {
      const sess = SESSIONS.get(args.sessionId)
      const cwd = sess && sess.cwd
      if (cwd) {
        const s = STORES.get(canonCwd(cwd))
        if (s) return s
      }
      return null
    }
    if (args && typeof args.cwd === 'string' && args.cwd) {
      const s = STORES.get(canonCwd(args.cwd))
      if (s) return s
      return null
    }
    // 未携带任何键（页面加载早期等）时回落最近活跃桶，不构成跨工作区误判
    return active
  }

  const norm = (p) => String(p).replace(/\\/g, '/')
  const relOf = (p, s) => {
    if (!s || !s.cwd) return norm(p)
    const c = norm(s.cwd).replace(/\/+$/, '')
    const n = norm(p)
    return n === c ? '.' : n.indexOf(c + '/') === 0 ? n.slice(c.length + 1) : n
  }

  function splitLines(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  function lcsOps(a, b) {
    const n = a.length
    const m = b.length
    if (n === 0) return b.map((t, j) => ({ k: 'add', o: null, n: j + 1, t }))
    if (m === 0) return a.map((t, i) => ({ k: 'del', o: i + 1, n: null, t }))
    if (n * m > MAX_LCS_CELLS) {
      const ops = []
      for (let i = 0; i < n; i++) ops.push({ k: 'del', o: i + 1, n: null, t: a[i] })
      for (let j = 0; j < m; j++) ops.push({ k: 'add', o: null, n: j + 1, t: b[j] })
      return ops
    }
    const w = m + 1
    const dp = new Int32Array((n + 1) * w)
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i * w + j] = a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + (j - 1)] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)])
      }
    }
    const ops = []
    let i = n
    let j = m
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.push({ k: 'ctx', o: i, n: j, t: a[i - 1] })
        i--
        j--
      } else if (i > 0 && (j === 0 || dp[(i - 1) * w + j] > dp[i * w + (j - 1)])) {
        ops.push({ k: 'del', o: i, n: null, t: a[i - 1] })
        i--
      } else {
        ops.push({ k: 'add', o: null, n: j, t: b[j - 1] })
        j--
      }
    }
    ops.reverse()
    return ops
  }
  function charHl(a, b) {
    if (a.length > 400 || b.length > 400) return { old: null, next: null }
    const al = a.length
    const bl = b.length
    let p = 0
    while (p < al && p < bl && a[p] === b[p]) p++
    let s = 0
    while (s < al - p && s < bl - p && a[al - 1 - s] === b[bl - 1 - s]) s++
    const oldEnd = al - s
    const newEnd = bl - s
    return { old: oldEnd > p ? { s: p, e: oldEnd } : null, next: newEnd > p ? { s: p, e: newEnd } : null }
  }
  function toViewRow(op) {
    if (op.k === 'ctx') return { k: 'c', o: op.o, n: op.n, t: op.t }
    return { k: 'p', o: op.k === 'del' ? { n: op.o, t: op.t, hl: null } : null, n: op.k === 'add' ? { n: op.n, t: op.t, hl: null } : null }
  }
  function finalizeRows(rows) {
    const out = []
    let i = 0
    while (i < rows.length) {
      if (rows[i].k === 'c') { out.push(rows[i]); i++; continue }
      const dels = []
      const adds = []
      while (i < rows.length && rows[i].k === 'p') {
        if (rows[i].o) dels.push(rows[i].o)
        if (rows[i].n) adds.push(rows[i].n)
        i++
      }
      const len = Math.max(dels.length, adds.length)
      for (let k = 0; k < len; k++) {
        const o = dels[k] || null
        const n = adds[k] || null
        let oh = null
        let nh = null
        if (o && n) { const h = charHl(o.t, n.t); oh = h.old; nh = h.next }
        out.push({ k: 'p', o: o ? { n: o.n, t: o.t, hl: oh } : null, n: n ? { n: n.n, t: n.t, hl: nh } : null })
      }
    }
    return out
  }
  function computeDiff(original, current) {
    const a = splitLines(original)
    const b = splitLines(current)
    const ops = lcsOps(a, b)
    let adds = 0
    let dels = 0
    for (const op of ops) { if (op.k === 'add') adds++; else if (op.k === 'del') dels++ }
    const runs = []
    let i = 0
    while (i < ops.length) {
      if (ops[i].k === 'ctx') { i++; continue }
      const start = i
      while (i < ops.length && ops[i].k !== 'ctx') i++
      runs.push([start, i])
    }
    const merged = []
    for (const r of runs) {
      if (merged.length && r[0] - merged[merged.length - 1][1] <= 2 * CONTEXT) merged[merged.length - 1][1] = r[1]
      else merged.push([r[0], r[1]])
    }
    const hunks = merged.map((pair, idx) => {
      const start = Math.max(0, pair[0] - CONTEXT)
      const end = Math.min(ops.length, pair[1] + CONTEXT)
      const rows = ops.slice(start, end).map(toViewRow)
      let gap = 0
      if (idx > 0) {
        const prevEnd = Math.min(ops.length, merged[idx - 1][1] + CONTEXT)
        gap = start - prevEnd
        if (gap < 0) gap = 0
      }
      return { rows: finalizeRows(rows), gap }
    })
    return { stats: { adds, dels }, hunks }
  }

  async function walkWorkspace(root) {
    const out = new Map()
    const seen = new Set()
    const stack = [{ path: root, depth: 0 }]
    const maxFiles = readConfig().maxFiles // 可配置上限（settings → maxFiles）
    let truncated = false
    while (stack.length > 0 && !truncated) {
      const cur = stack.pop()
      if (cur.depth > MAX_DEPTH) continue
      let target
      try { target = await fs.resolve(cur.path) } catch (e) { continue }
      if (seen.has(target.targetKey)) continue
      seen.add(target.targetKey)
      let entries
      try { entries = await fs.listDir(target) } catch (e) { continue }
      for (let k = entries.length - 1; k >= 0; k--) {
        const e = entries[k]
        if (e.type === 'directory') {
          if (IGNORE_DIRS.has(e.name)) continue
          stack.push({ path: e.target.displayPath, depth: cur.depth + 1 })
        } else if (e.type === 'file') {
          if (e.name.indexOf('dsh-dr-tmp-') === 0) continue
          let ver = e.version
          if (ver === undefined) {
            try {
              const info = await fs.stat(e.target)
              ver = info ? info.version : undefined
            } catch (err) { ver = undefined }
          }
          if (ver !== undefined) out.set(e.target.displayPath, { version: String(ver), size: e.size, target: e.target })
          if (out.size >= maxFiles) { truncated = true; break }
        }
      }
    }
    return { meta: out, truncated }
  }

  function ensureBaseline(s) {
    if (s.baseline) return s.baseline
    s.baselineLoading = true
    s.baseline = (async () => {
      try {
        const { meta, truncated } = await walkWorkspace(s.cwd)
        s.truncated = truncated
        s.walkFileCount = meta.size
        s.fileMeta = meta
        const cfg = readConfig()
        let budget = cfg.primeMaxChars
        let count = 0
        for (const [path, info] of meta) {
          if (count >= cfg.primeMaxFiles || budget <= 0) break
          if (info.size !== undefined && info.size > 1024 * 1024) continue
          try {
            const c = await fs.readText(info.target)
            s.contentCache.set(path, c)
            budget -= c.length
            count++
          } catch (e) { /* 二进制或不可读 */ }
        }
      } catch (e) {
        s.baselineError = (e && e.message) || String(e)
        console.error('[dsh-diff-review] baseline 失败', e)
      } finally {
        s.baselineLoading = false
      }
    })()
    return s.baseline
  }
  // 轮次键 = 会话维度 + turn：turn 仅会话内唯一，同工作区多会话时不得共用键
  function turnKey(sessionId, turn) { return String(sessionId) + '::' + String(turn) }
  function getGroup(s, sessionId, turn) {
    const key = turnKey(sessionId, turn)
    let g = s.groups.get(key)
    if (!g) { g = { sessionId: String(sessionId), turn, items: new Map() }; s.groups.set(key, g) }
    return g
  }
  async function scan(s, sessionId, turn) {
    if (!s.cwd) return
    s.scanning = true
    try {
      if (s.baseline) { try { await s.baseline } catch (e) {} }
      s.scanCount++
      let walk
      try { walk = await walkWorkspace(s.cwd) } catch (e) { s.lastError = 'walk: ' + ((e && e.message) || String(e)); console.error('[dsh-diff-review] 扫描失败', e); return }
      const meta = walk.meta
      s.truncated = walk.truncated
      s.walkFileCount = meta.size
      const group = getGroup(s, sessionId, turn)
      const changed = []
      try {
        for (const [path, info] of meta) {
          const prev = s.fileMeta.get(path)
          if (prev && prev.version === info.version) continue
          if (!prev) {
            if (info.size === undefined || info.size <= CACHE_NEW_BYTES) {
              try { s.contentCache.set(path, await fs.readText(info.target)) } catch (e) { /* 二进制或不可读 */ }
            }
            continue
          }
          if (info.size !== undefined && info.size > MAX_READ_BYTES) continue
          let current
          try { current = await fs.readText(info.target) } catch (e) { continue }
          const original = s.contentCache.get(path)
          if (original !== undefined && original === current) {
            s.contentCache.set(path, current)
            continue
          }
          changed.push({ path, info, original: original === undefined ? null : original, current })
        }
        for (const c of changed) {
          // item id 含会话维度：不同会话的同号轮次修改同一文件不得冲突
          const id = String(sessionId) + '::' + turn + '::' + c.path
          if (s.items.has(id)) continue
          let diff
          if (c.original === null) {
            const lines = splitLines(c.current)
            diff = {
              stats: { adds: lines.length, dels: 0 },
              hunks: [{ rows: lines.map((t, j) => ({ k: 'p', o: null, n: { n: j + 1, t, hl: null } })), gap: 0 }],
            }
          } else {
            diff = computeDiff(c.original, c.current)
          }
          const item = {
            id, sessionId: String(sessionId), turn,
            file: c.path,
            relPath: relOf(c.path, s),
            original: c.original,
            modified: c.current,
            current: c.current,
            originalMissing: c.original === null,
            status: 'pending',
            stats: diff.stats,
            hunks: diff.hunks,
          }
          s.items.set(id, item)
          group.items.set(c.path, item)
          s.contentCache.set(c.path, c.current)
        }
        const nextMeta = new Map()
        for (const [p, info] of meta) nextMeta.set(p, info)
        s.fileMeta = nextMeta
        for (const p of Array.from(s.contentCache.keys())) {
          if (!nextMeta.has(p)) s.contentCache.delete(p)
        }
        if (changed.length > 0) s.rev++
      } catch (e) {
        s.lastError = 'scan: ' + ((e && e.message) || String(e))
        console.error('[dsh-diff-review] scan 处理失败', e)
      }
    } finally {
      s.scanning = false
    }
  }

  async function applyFileWrite(s, file, content, expectedContent) {
    try {
      const target = await fs.resolve(file)
      const cur = await fs.readText(target)
      if (cur !== expectedContent) {
        return { ok: false, error: 'conflict', message: '文件内容已被后续修改，操作已取消' }
      }
      const info = await fs.stat(target)
      let policy
      if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
        try { policy = sandboxPolicy.resolve({ session: s.session }) } catch (e) { policy = undefined }
      }
      const expected = info ? { kind: 'replaceIfVersion', version: info.version } : undefined
      await fs.writeText(target, content, expected, undefined, policy)
      const after = await fs.stat(target)
      if (after) {
        s.fileMeta.set(file, { version: String(after.version), size: after.size, target })
        s.contentCache.set(file, content)
      }
      return { ok: true }
    } catch (e) {
      const code = e && e.code
      const message = code === 'FS_SANDBOX_DENIED'
        ? '写入被沙箱拒绝（当前权限不允许写该文件）'
        : code === 'FS_STALE_VERSION'
          ? '文件在操作期间被修改，已取消'
          : (e && e.message) || String(e)
      return { ok: false, error: code || 'io', message }
    }
  }
  async function reviewItem(s, itemId, action) {
    const item = s.items.get(itemId)
    if (!item) return { ok: false, error: 'not-found', message: '记录不存在（插件可能已重启）' }
    if (action === 'keep') {
      if (item.status === 'pending') { item.status = 'kept'; s.rev++ }
      return { ok: true, status: item.status }
    }
    if (action === 'revert') {
      if (item.original === null) return { ok: false, error: 'no-original', message: '原始内容未知，无法撤销' }
      const res = await applyFileWrite(s, item.file, item.original, item.modified)
      if (!res.ok) return res
      item.status = 'reverted'
      item.current = item.original
      s.rev++
      return { ok: true, status: item.status }
    }
    if (action === 'redo') {
      const res = await applyFileWrite(s, item.file, item.modified, item.original)
      if (!res.ok) return res
      item.status = 'kept'
      item.current = item.modified
      s.rev++
      return { ok: true, status: item.status }
    }
    return { ok: false, error: 'bad-action', message: '未知操作' }
  }

  function itemSummary(item) {
    return { id: item.id, sessionId: item.sessionId, turn: item.turn, file: item.file, relPath: item.relPath, status: item.status, originalMissing: item.originalMissing, stats: item.stats }
  }
  function itemFull(item) {
    // originalMissing 时带 current，供 DiffView 显示当前文件内容；正常 diff 不传整个文件体
    return { id: item.id, sessionId: item.sessionId, turn: item.turn, file: item.file, relPath: item.relPath, status: item.status, originalMissing: item.originalMissing, stats: item.stats, hunks: item.hunks, current: item.originalMissing ? item.current : undefined }
  }

  // ---- 标准 settings 注册（schemastery 兼容的鸭子类型 schema） ----
  // 配置项：编辑器路径（string）+ 扫描/基线上限（number；0 或非法值回退默认）
  let settingsRegistered = false
  if (settings && typeof settings.register === 'function' && typeof settings.get === 'function' && typeof settings.update === 'function') {
    const dict = {
      code: { type: 'string' },
      devenv: { type: 'string' },
      vsDiffMerge: { type: 'string' },
      maxFiles: { type: 'number' },
      primeMaxFiles: { type: 'number' },
      primeMaxChars: { type: 'number' },
    }
    function schema(input) {
      const src = input && typeof input === 'object' ? input : {}
      const out = {}
      for (const key of Object.keys(dict)) {
        if (dict[key].type === 'number') {
          const v = src[key]
          out[key] = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : 0)
        } else {
          out[key] = typeof src[key] === 'string' ? src[key] : ''
        }
      }
      return out
    }
    schema.type = 'object'
    schema.dict = dict
    schema.toJSON = () => ({
      type: 'object',
      properties: {
        code: { type: 'string', description: 'VS Code 可执行文件路径' },
        devenv: { type: 'string', description: 'VS2022 devenv.exe 路径' },
        vsDiffMerge: { type: 'string', description: 'VS2022 vsDiffMerge.exe 路径' },
        maxFiles: { type: 'number', description: '工作区遍历文件数上限（达到即截断，默认 20000）' },
        primeMaxFiles: { type: 'number', description: '基线预读文件数上限（默认 6000）' },
        primeMaxChars: { type: 'number', description: '基线预读字符预算，单位 MB（默认 48）' },
      },
    })
    try {
      settings.register(CONFIG_NS, schema)
      settingsRegistered = true
    } catch (e) {
      console.error('[dsh-diff-review] settings 注册失败', e)
    }
  }

  // 读取插件配置（settings.yaml 命名空间 dsh-diff-review）；数字项 0/非法回退默认常量
  function readConfig() {
    const empty = { code: '', devenv: '', vsDiffMerge: '', maxFiles: MAX_FILES, primeMaxFiles: PRIME_MAX_FILES, primeMaxChars: PRIME_MAX_CHARS }
    if (!settingsRegistered) return empty
    try {
      const v = settings.get(CONFIG_NS)
      if (!v || typeof v !== 'object') return empty
      const num = (x, def) => {
        const n = typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN)
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
      }
      return {
        code: typeof v.code === 'string' ? v.code : '',
        devenv: typeof v.devenv === 'string' ? v.devenv : '',
        vsDiffMerge: typeof v.vsDiffMerge === 'string' ? v.vsDiffMerge : '',
        maxFiles: num(v.maxFiles, MAX_FILES),
        primeMaxFiles: num(v.primeMaxFiles, PRIME_MAX_FILES),
        // 配置以 MB 为单位，内部转为字符数
        primeMaxChars: num(v.primeMaxChars, PRIME_MAX_CHARS / (1024 * 1024)) * (1024 * 1024),
      }
    } catch (e) { return empty }
  }

  function buildEditorCommand(editor, left, right, diff, cfg) {
    // PowerShell 单引号字符串：内部单引号用 '' 转义，杜绝路径含 ' 时的注入/提前终止
    const q = (line) => "'" + String(line).replace(/'/g, "''") + "'"
    const pOpen = q(left)
    const pDm = q(left) + ' ' + q(right)
    const pDevenvDiff = '"/diff" ' + q(left) + ' ' + q(right)
    const pCodeDiff = '"--diff" ' + q(left) + ' ' + q(right)
    const launch = (fileExpr, argLine) =>
      'try { Start-Process -FilePath ' + fileExpr + ' -ArgumentList ' + argLine + ' -ErrorAction Stop } catch { Write-Output (\"ERR:\" + $_.Exception.Message); exit 1 }; Write-Output \"OK:\"'
    if (editor === 'vs') {
      const probeDevenv =
        "$d = Get-Command devenv -ErrorAction SilentlyContinue; "
        + "if (-not $d) { $cands = @('C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe', 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe', 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe', 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe'); foreach ($p in $cands) { if (Test-Path $p) { $d = $p; break } } }; "
        + "if (-not $d) { $roots = @('C:\\Program Files\\Microsoft Visual Studio', 'C:\\Program Files (x86)\\Microsoft Visual Studio', 'D:\\Program Files', 'D:\\Program Files (x86)'); foreach ($r in $roots) { if (-not $d -and (Test-Path $r)) { $hit = Get-ChildItem $r -Filter devenv.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1; if ($hit) { $d = $hit.FullName } } } }; "
        + "if (-not $d) { Write-Output 'MISSING:VS2022'; exit 1 }; "
        + "if ($d -is [string]) { $dPath = $d } else { $dPath = $d.Source }"
      const dExpr = cfg.devenv
        ? '$dPath = ' + q(cfg.devenv) + '; if (-not (Test-Path $dPath)) { Write-Output \"ERR:配置的 devenv 路径不存在: ' + cfg.devenv + '\"; exit 1 }'
        : probeDevenv
      if (diff) {
        const dm = cfg.vsDiffMerge
          ? '$dm = ' + q(cfg.vsDiffMerge) + '; if (Test-Path $dm) { ' + launch('$dm', pDm) + ' } else { Write-Output \"ERR:配置的 vsDiffMerge 路径不存在: ' + cfg.vsDiffMerge + '\"; exit 1 }'
          : "$dm = (Split-Path $dPath) + '\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\vsDiffMerge.exe'; if (Test-Path $dm) { " + launch('$dm', pDm) + ' } else { ' + launch('$dPath', pDevenvDiff) + ' }'
        return dExpr + '; ' + dm
      }
      return dExpr + '; ' + launch('$dPath', pOpen)
    }
    const probeCode =
      "$c = Get-Command code -ErrorAction SilentlyContinue; if (-not $c) { Write-Output 'MISSING:VSCode'; exit 1 }; "
      + "$exe = $c.Source; if ($exe -like '*\\bin\\code.cmd') { $exe = $exe.Substring(0, $exe.Length - '\\bin\\code.cmd'.Length) + '\\Code.exe' }; if (-not (Test-Path $exe)) { $exe = $c.Source }"
    const exeExpr = cfg.code
      ? '$exe = ' + q(cfg.code) + '; if (-not (Test-Path $exe)) { Write-Output \"ERR:配置的 VS Code 路径不存在: ' + cfg.code + '\"; exit 1 }'
      : probeCode
    return exeExpr + '; ' + launch('$exe', diff ? pCodeDiff : pOpen)
  }

  async function writeTempOriginal(s, item) {
    // 用与 cwd 一致的分隔符（Windows \，其他 /），避免跨平台在父目录生成怪文件；
    // 临时文件统一写入工作区根目录下的 .dsh-dr-tmp-orig/ 子目录（writeText 会自动创建父目录），
    // 不再散落在根目录，便于一次性忽略/清理；
    // 临时名含 turn + 路径 hash，避免不同目录同名文件互相覆盖。
    const sep = String(s.cwd).indexOf('\\') >= 0 ? '\\' : '/'
    const normFile = String(item.file).replace(/\\/g, '/')
    const base = normFile.split('/').pop() || 'file'
    let hash = 0
    for (let i = 0; i < normFile.length; i++) hash = ((hash << 5) - hash + normFile.charCodeAt(i)) | 0
    const name = 'dsh-dr-tmp-orig-' + (item.turn != null ? item.turn + '-' : '') + (hash >>> 0).toString(36) + '-' + base
    const tempPath = String(s.cwd).replace(/[\\/]$/, '') + sep + '.dsh-dr-tmp-orig' + sep + name
    try {
      const target = await fs.resolve(tempPath)
      let policy
      if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
        try { policy = sandboxPolicy.resolve({ session: s.session }) } catch (e) { policy = undefined }
      }
      await fs.writeText(target, item.original, undefined, undefined, policy)
      return tempPath
    } catch (e) {
      return null
    }
  }

  // ---- 业务动作分发（替代动态 harness.handle） ----
  async function handleAction(action, args) {
    switch (action) {
      case 'getEditorConfig': return readConfig()
      case 'saveEditorConfig': return saveEditorConfig(args)
      case 'openExternal': return openExternal(args)
      case 'getState': return getState(args)
      case 'getItem': {
        const s = pickStore(args)
        if (!s) return null
        const id = args && args.itemId
        const item = id ? s.items.get(id) : undefined
        return item ? itemFull(item) : null
      }
      case 'review': {
        const s = pickStore(args)
        if (!s) return { ok: false, error: 'no-store', message: '尚无活跃工作区' }
        return reviewItem(s, args && args.itemId, args && args.action)
      }
      case 'reviewGroup': {
        const s = pickStore(args)
        if (!s) return { ok: false, error: 'no-store', message: '尚无活跃工作区' }
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
        const turn = args && args.turn
        const action = args && args.action
        // 轮次归属会话：按 sessionId::turn 精确定位，杜绝跨会话同号轮次误操作
        const g = s.groups.get(turnKey(sid, turn))
        if (!g) return { ok: false, error: 'not-found', message: '该段落没有记录' }
        const results = []
        for (const item of g.items.values()) {
          if (item.status !== 'pending') continue
          results.push({ id: item.id, result: await reviewItem(s, item.id, action) })
        }
        return { ok: true, results }
      }
      case 'reviewSession': {
        // 会话级全部保留：仅作用于该会话的待审阅项（dock 会话组内按钮）
        const s = pickStore(args)
        if (!s) return { ok: true, kept: 0 }
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
        let n = 0
        for (const item of s.items.values()) {
          if (item.sessionId === sid && item.status === 'pending') { item.status = 'kept'; n++ }
        }
        if (n > 0) s.rev++
        return { ok: true, kept: n }
      }
      case 'reviewAll': {
        const s = pickStore(args)
        if (!s) return { ok: true, kept: 0 }
        let n = 0
        for (const item of s.items.values()) {
          if (item.status === 'pending') { item.status = 'kept'; n++ }
        }
        if (n > 0) s.rev++
        return { ok: true, kept: n }
      }
      default:
        return { ok: false, message: '未知动作: ' + String(action) }
    }
  }

  function saveEditorConfig(args) {
    if (!settingsRegistered) return { ok: false, message: 'settings 服务不可用或注册失败' }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, message: '无效参数' }
    const patch = {}
    for (const key of ['code', 'devenv', 'vsDiffMerge']) {
      patch[key] = typeof args[key] === 'string' ? args[key].trim() : ''
    }
    // 数字上限项：合法正整数才写入，否则存 0（读取时回退默认）
    for (const key of ['maxFiles', 'primeMaxFiles', 'primeMaxChars']) {
      const n = Number(args[key])
      patch[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    return Promise.resolve(settings.update(CONFIG_NS, patch))
      .then(() => ({ ok: true, config: { code: patch.code, devenv: patch.devenv, vsDiffMerge: patch.vsDiffMerge } }))
      .catch((e) => ({ ok: false, message: (e && e.message) || String(e) }))
  }

  async function openExternal(args) {
    const itemId = args && args.itemId
    const editor = args && args.editor === 'vs' ? 'vs' : 'vscode'
    const diff = !!(args && args.diff)
    const s = pickStore(args)
    if (!s) return { ok: false, message: '尚无活跃工作区，无法打开' }
    const item = itemId ? s.items.get(itemId) : undefined
    if (!item) return { ok: false, message: '记录不存在（插件可能已重启）' }
    if (!s.cwd) return { ok: false, message: '工作区尚未就绪' }
    try {
      let left = item.file
      if (diff) {
        if (item.original === null) return { ok: false, message: '原始内容未知，无法打开 diff' }
        const temp = await writeTempOriginal(s, item)
        if (temp === null) return { ok: false, message: '无法写入临时原始文件（可能被沙箱拒绝）' }
        left = temp
      }
      const cfg = readConfig()
      if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
        return { ok: false, message: 'shell 服务不可用' }
      }
      let policy
      if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
        try { policy = sandboxPolicy.resolve({ session: s.session, mode: 'danger-full-access' }) } catch (e) { policy = undefined }
      }
      const spec = shell.resolve({
        command: buildEditorCommand(editor, left, item.file, diff, cfg),
        workdir: s.cwd,
        timeoutMs: 30000,
        sandboxPolicy: policy,
      })
      const result = await shell.run(spec)
      const out = (result && result.stdout && typeof result.stdout === 'object' && typeof result.stdout.text === 'string' ? result.stdout.text : String(result && result.stdout || '')).trim()
      if (out.indexOf('OK:') === 0) return { ok: true, message: out }
      if (out.indexOf('ERR:') === 0) return { ok: false, message: out.slice(4) }
      if (out.indexOf('MISSING:') === 0) return { ok: false, message: out }
      return { ok: false, message: out || ('启动失败' + (result && result.exitCode != null ? ' (exit ' + result.exitCode + ')' : '')) }
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) }
    }
  }

  // 会话短标识：dsh sessionId 形如 session-<uuid>，去掉前缀取 uuid 前 8 位，否则取 id 前 8 位
  function shortSessionId(sessionId) {
    const s = String(sessionId)
    const m = s.match(/^session-([0-9a-fA-F]{8})/i)
    return m ? m[1] : s.slice(0, 8)
  }
  function sessionLabel(s, sessionId) {
    const sd = s.sessions.get(sessionId)
    if (sd && sd.label) return sd.label
    return '#' + shortSessionId(sessionId)
  }
  function getState(args) {
    const cfg = readConfig()
    const limits = { maxFiles: cfg.maxFiles, primeMaxFiles: cfg.primeMaxFiles, primeMaxChars: cfg.primeMaxChars }
    const curSessionId = args && typeof args.sessionId === 'string' ? args.sessionId : ''
    const s = pickStore(args)
    if (!s) {
      return { rev: 0, maxTurn: 0, workspaceId: '', workspaceLabel: '', sessionId: curSessionId, sessionKnown: !!curSessionId && SESSIONS.has(curSessionId), loading: false, truncated: false, lastTurn: 0, pendingCount: 0, sessions: [], groups: [], pending: [], limits }
    }
    const groups = []
    for (const g of s.groups.values()) {
      if (g.items.size === 0) continue
      const arr = Array.from(g.items.values())
      const pendingCount = arr.filter(i => i.status === 'pending').length
      groups.push({
        sessionId: g.sessionId,
        sessionLabel: sessionLabel(s, g.sessionId),
        turn: g.turn,
        itemCount: arr.length,
        pendingCount,
        status: pendingCount === 0 ? 'reviewed' : pendingCount === arr.length ? 'pending' : 'partial',
        items: arr.map(itemSummary),
      })
    }
    // 按会话聚合（会话间按 id 稳定排序），会话内按 turn 升序
    groups.sort((a, b) => a.sessionId === b.sessionId ? a.turn - b.turn : (a.sessionId < b.sessionId ? -1 : 1))
    const pending = []
    for (const g of s.groups.values()) {
      for (const item of g.items.values()) {
        if (item.status === 'pending') pending.push(itemSummary(item))
      }
    }
    // 会话按最近活动（lastTurn）倒序、会话内 turn 倒序
    const sessionOrder = new Map()
    for (const [sid, sd] of s.sessions) sessionOrder.set(sid, sd.lastTurn || 0)
    pending.sort((a, b) => {
      const la = sessionOrder.get(a.sessionId) || 0
      const lb = sessionOrder.get(b.sessionId) || 0
      if (la !== lb) return lb - la
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
      return b.turn - a.turn
    })
    const sessions = []
    for (const [sid, sd] of s.sessions) {
      let pc = 0
      for (const g of s.groups.values()) {
        if (g.sessionId === sid) {
          for (const item of g.items.values()) if (item.status === 'pending') pc++
        }
      }
      sessions.push({ id: sid, label: sd.label || '#' + shortSessionId(sid), lastTurn: sd.lastTurn || 0, pendingCount: pc })
    }
    sessions.sort((a, b) => b.lastTurn - a.lastTurn || (a.id < b.id ? -1 : 1))
    const wsLabel = s.cwd ? (s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || s.cwd) : ''
    return {
      rev: s.rev,
      maxTurn: s.lastTurn,
      workspaceId: s.cwd,
      workspaceLabel: wsLabel,
      sessionId: curSessionId,
      sessionKnown: !!curSessionId && SESSIONS.has(curSessionId),
      loading: s.scanning || s.baselineLoading,
      truncated: !!s.truncated,
      lastTurn: s.lastTurn,
      pendingCount: pending.length,
      sessions,
      groups,
      pending,
      limits,
    }
  }

  // ---- webServer 路由：POST /dsh-diff-review  { action, args } → JSON ----
  const BODY_MAX_BYTES = 1024 * 1024
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_MAX_BYTES) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve(raw ? JSON.parse(raw) : {})
        } catch (e) { reject(e) }
      })
      req.on('error', reject)
      // 客户端提前断开：data/end 都不会再触发，close 兜底拒绝，避免 Promise 永久挂起
      // （resolve 之后再 reject 是无效操作，安全）
      req.on('close', () => reject(new Error('request closed')))
    })
  }
  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE,
      async handler(req, res) {
        try {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
          const body = await readBody(req)
          const action = body && body.action
          const args = body && body.args
          const result = await handleAction(action, args)
          sendJson(res, 200, result)
        } catch (e) {
          sendJson(res, 500, { ok: false, message: (e && e.message) || String(e) })
        }
      },
    }))
  }

  // ---- 标准工具注册：drvw_debug（defineTool 生成精确 ToolDefinition 再 register，与动态版 harness.defineTool 同源） ----
  if (tools && typeof tools.register === 'function') {
    const debugTool = defineTool({
      name: 'drvw_debug',
      description: '读取「对话修改审阅」插件（drvw）的内部状态并支持调试动作：action=state 返回状态（默认，可指定 cwd 参数查看特定工作区）；action=scan 立即执行一次扫描（自动引导基线，使用 lastTurn+1 作为回合号）；action=revertAll 撤销全部待审阅项。仅调试用。',
      // ParameterSchemaSpec：扁平属性映射（defineTool 转成 JSON Schema object 根）
      parameters: {
        action: {
          type: 'string',
          enum: ['state', 'scan', 'revertAll'],
          description: '调试动作：state（默认）查看状态；scan 立即扫描；revertAll 撤销全部待审阅项',
        },
        cwd: { type: 'string', description: '目标工作区路径；缺省使用最近活动工作区' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cwd: { type: 'string' },
            baselineReady: { type: 'boolean' },
            baselineError: { type: 'string' },
            lastError: { type: 'string' },
            lastTurn: { type: 'integer' },
            rev: { type: 'integer' },
            scanCount: { type: 'integer' },
            truncated: { type: 'boolean' },
            walkFileCount: { type: 'integer' },
            cacheSize: { type: 'integer' },
            itemCount: { type: 'integer' },
            pendingCount: { type: 'integer' },
            loading: { type: 'boolean' },
            storeCount: { type: 'integer' },
            stores: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  cwd: { type: 'string' },
                  baselineReady: { type: 'boolean' },
                  lastTurn: { type: 'integer' },
                  itemCount: { type: 'integer' },
                  pendingCount: { type: 'integer' },
                },
              },
            },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  turn: { type: 'integer' },
                  itemCount: { type: 'integer' },
                  pendingCount: { type: 'integer' },
                },
              },
            },
            reviewResults: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  ok: { type: 'boolean' },
                  status: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        let s = null
        let sessionId = null
        if (exec && exec.agent && exec.agent.session && exec.agent.session.id != null) {
          sessionId = String(exec.agent.session.id)
          // 工具调用也是一种会话活动：登记会话→工作区绑定（不影响轮次计数）
          s = registerSession(exec.agent, null)
        }
        if (args && typeof args.cwd === 'string') {
          // STORES 的键是 canonCwd 归一化后的路径，直接查原始 cwd 会 miss（getStore 兜底会复用已有桶，但先 canon 更干净）
          s = STORES.get(canonCwd(args.cwd))
          if (!s) s = getStore(args.cwd)
        }
        if (!s && active) s = active
        if (s) {
          ensureBaseline(s)
          if (s.baseline) { try { await s.baseline } catch (e) {} }
        }
        const action = args && args.action ? args.action : 'state'
        if (action === 'scan') {
          // 返回必须符合 output schema（无 actionDone 字段）；无工作区时返回完整空状态并记入 lastError
          if (!s || !s.cwd) {
            if (s) s.lastError = 'scan-skipped-no-cwd'
            return { cwd: '', baselineReady: false, baselineError: '', lastError: s ? (s.lastError || '') : '', lastTurn: 0, rev: 0, scanCount: 0, walkFileCount: 0, truncated: false, cacheSize: 0, itemCount: 0, pendingCount: 0, loading: false, storeCount: STORES.size, stores: [], groups: [], reviewResults: [] }
          }
          await scan(s, sessionId || 'debug', s.lastTurn + 1)
        }
        const reviewResults = []
        if (action === 'revertAll' && s) {
          for (const item of Array.from(s.items.values())) {
            if (item.status !== 'pending') continue
            const r = await reviewItem(s, item.id, 'revert')
            reviewResults.push({ id: item.id, ok: r.ok === true, status: r.status || '', message: r.message || '' })
          }
        }
        const groups = []
        if (s) {
          for (const g of s.groups.values()) {
            if (g.items.size === 0) continue
            const arr = Array.from(g.items.values())
            groups.push({ turn: g.turn, itemCount: arr.length, pendingCount: arr.filter(i => i.status === 'pending').length })
          }
        }
        let pendingCount = 0
        if (s) {
          for (const item of s.items.values()) if (item.status === 'pending') pendingCount++
        }
        const stores = []
        for (const store of STORES.values()) {
          stores.push({
            cwd: store.cwd,
            baselineReady: store.baseline !== null,
            lastTurn: store.lastTurn,
            itemCount: store.items.size,
            pendingCount: Array.from(store.items.values()).filter(i => i.status === 'pending').length,
          })
        }
        return {
          cwd: s ? s.cwd || '' : '',
          baselineReady: s ? s.baseline !== null : false,
          baselineError: s ? (s.baselineError || '') : '',
          lastError: s ? (s.lastError || '') : '',
          lastTurn: s ? s.lastTurn : 0,
          rev: s ? s.rev : 0,
          scanCount: s ? s.scanCount : 0,
          walkFileCount: s ? s.walkFileCount : 0,
          truncated: s ? !!s.truncated : false,
          cacheSize: s ? s.contentCache.size : 0,
          itemCount: s ? s.items.size : 0,
          pendingCount,
          loading: s ? (s.scanning || s.baselineLoading) : false,
          storeCount: STORES.size,
          stores,
          groups,
          reviewResults,
        }
      },
    })
    ctx.effect(() => tools.register(debugTool))
  }

  // 事件监听用 ctx.effect 包裹，随插件 fiber 卸载自动清理，避免长期运行累积
  // 会话登记：会话（第二层）→ 工作区（第一层）绑定 + 轮次计数 + 可读标签
  // dsh 的会话标题是日志事件 session/title（data.title），不在 SessionHeader 里；
  // 从 agent.session.events 中取最近一条（与 dsh 官方测试同款读取方式）
  function readSessionTitle(agent) {
    try {
      const sess = agent && agent.session
      const ev = sess && Array.isArray(sess.events) ? sess.events.findLast((e) => e && e.type === 'session/title') : null
      const t = ev && ev.data && typeof ev.data.title === 'string' ? ev.data.title.trim() : ''
      return t || ''
    } catch (e) { return '' }
  }
  function registerSession(agent, turn) {
    if (!agent || !agent.session) return null
    const sid = agent.session.id != null ? String(agent.session.id) : null
    const cwd = agent.session.header ? agent.session.header.cwd : null
    if (!sid || !cwd) return null
    const c = canonCwd(cwd)
    const header = agent.session.header || {}
    const label = readSessionTitle(agent)
    const prevSess = SESSIONS.get(sid)
    SESSIONS.set(sid, {
      cwd: c,
      lastTurn: prevSess ? prevSess.lastTurn : 0,
      label: label || (prevSess ? prevSess.label : ''),
    })
    const s = getStore(c)
    const prev = s.sessions.get(sid)
    s.sessions.set(sid, {
      lastTurn: prev ? prev.lastTurn : 0,
      label: label || (prev ? prev.label : ''),
    })
    s.session = agent.session
    active = s
    if (typeof turn === 'number' && turn > 0) {
      SESSIONS.get(sid).lastTurn = turn
      s.sessions.get(sid).lastTurn = turn
      s.lastTurn = Math.max(s.lastTurn, turn)
    }
    return s
  }
  ctx.effect(() => ctx.on('agent/status', (payload) => {
    if (payload && payload.status === 'running' && payload.agent) {
      const s = registerSession(payload.agent, null)
      if (s && !s.baseline) ensureBaseline(s)
    }
  }))
  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload && payload.agent
    const turn = payload && payload.turn
    if (typeof turn !== 'number') return
    const s = registerSession(agent, turn)
    if (s && agent.session && agent.session.id != null) {
      const sid = String(agent.session.id)
      ensureBaseline(s)
      s.scanChain = s.scanChain.then(() => scan(s, sid, turn)).catch((e) => { s.lastError = ((e && e.message) || String(e)); console.error('[dsh-diff-review] 扫描失败', e) })
    }
  }))

  console.log('[dsh-diff-review] 正式插件已启动（v0.3.10），webServer 路由:', ROUTE)
}
