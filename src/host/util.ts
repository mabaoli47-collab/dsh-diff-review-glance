// dsh-diff-review host util: pure functions (no apply state, no services)
// 从 apply 闭包拆出的纯函数/常量——不依赖任何运行时状态，可直接单元测试。
import { posix } from 'node:path'

/** 忽略目录：node_modules/.git/凭据目录等；walkWorkspace 与 realPathBlocked 共用 */
export const IGNORE_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'dist', 'build', 'out', 'coverage', 'target', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.dsh-dr-tmp-orig', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.pnpm-store'])

/** diff 上下文行数与 LCS 单元格上限（computeDiff 使用） */
export const CONTEXT = 3
export const MAX_LCS_CELLS = 4 * 1024 * 1024

/**
 * 规范化 cwd：统一分隔符 + 解析 . 与 ..（posix.normalize）+ 去尾斜杠 + Windows 盘符路径整体小写。
 * 不解析 . / .. 会导致字符串比较因 C:/proj/./sub 与 C:/proj/sub 不一致而失效；
 * 盘符根目录（C:/）必须保留末尾斜杠：截成 "C:" 会使盘符正则失配、大小写不折叠。
 */
export function canonCwd(cwd) {
  let c = posix.normalize(String(cwd).replace(/\\/g, '/'))
  while (c.length > 3 && c.endsWith('/')) c = c.slice(0, -1)
  if (/^[a-zA-Z]:(\/|$)/.test(c)) c = c.toLowerCase()
  return c
}

/** 统一路径分隔符为 / */
export const norm = (p) => String(p).replace(/\\/g, '/')

/**
 * 相对化：p 相对 s.cwd 的路径。Windows 盘符大小写不敏感（s.cwd 经 canonCwd 强制小写，
 * 而 fs.resolve 的 displayPath 可能保留大写盘符 C:/...），严格比较会 miss 导致
 * 返回绝对路径、以及 git show HEAD:<绝对路径> 报错。
 */
export function relOf(p, s) {
  if (!s || !s.cwd) return norm(p)
  const c = norm(s.cwd).replace(/\/+$/, '')
  const n = norm(p)
  const ck = /^[a-zA-Z]:\//.test(c) ? c.toLowerCase() : c
  const nk = /^[a-zA-Z]:\//.test(n) ? n.toLowerCase() : n
  return nk === ck ? '.' : nk.indexOf(ck + '/') === 0 ? n.slice(ck.length + 1) : n
}

/**
 * 敏感文件默认排除：凭据/密钥类文件不纳入基线对比——不读入内存缓存、不产生 diff、
 * 不会因 revert/redo 触碰。best-effort 名单，不是安全保证（见 README 权限说明）。
 */
export function isSensitiveFile(name) {
  return /^\.env($|\.)/i.test(name)
    || /\.(pem|key|p12|pfx|crt|keystore)$/i.test(name)
    || /^(credentials|secrets)(\..*)?$/i.test(name)
    || /(^|\.)config\.local(\..*)?$/i.test(name)
    || /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(name)
    || /^\.(netrc|npmrc|git-credentials|pgpass)$/i.test(name)
    || /^htpasswd$/i.test(name)
    // 收窄：无扩展名精确匹配，或仅 .json/.yaml/.yml/.txt 变体——避免误伤前端常见的 token.js/token.ts
    || /^(secret|token|api[-_]?key|apikey)(\.(json|yaml|yml|txt))?$/i.test(name)
    || /\.kdbx$/i.test(name)
}

/**
 * 边界校验：解析后的真实路径（targetKey，可能经过软链接解析）必须位于工作区根目录内，
 * 防止工作区内的 symlink/junction 指向外部敏感目录（如 ~/.ssh）时被纳入对比甚至被 revert 篡改。
 * 仅当 root 是 Windows 盘符路径时折叠大小写（canonCwd 会把盘符转小写，而 fs.resolve 返回的
 * targetKey 可能保留大写盘符 C:/...，严格比较会误判越界）；
 * Linux/macOS 大小写敏感文件系统保持精确比较，避免把 /a/Proj 与 /a/proj 误判为同源。
 */
export function withinRoot(root, targetKey) {
  const r0 = norm(root).replace(/\/+$/, '')
  const t0 = norm(targetKey)
  if (/^[a-zA-Z]:\//.test(r0)) {
    const r = r0.toLowerCase()
    const t = t0.toLowerCase()
    return t === r || t.indexOf(r + '/') === 0
  }
  return t0 === r0 || t0.indexOf(r0 + '/') === 0
}

/**
 * 解析后真实路径的段级检查：改名的 symlink（foo.txt -> .env、notkube -> .kube）
 * 会绕过基于 listDir 条目名的敏感/忽略判断，必须用真实路径（targetKey）重判——
 * 路径任一目录段命中 IGNORE_DIRS（.ssh/.aws/.kube/.docker 等）即拦截。
 */
export function realPathBlocked(targetKey) {
  const segs = norm(targetKey).split('/')
  for (const seg of segs) {
    if (IGNORE_DIRS.has(seg)) return true
  }
  return false
}

/** 会话短标识：dsh sessionId 形如 session-<uuid>，去掉前缀取 uuid 前 8 位，否则取 id 前 8 位 */
export function shortSessionId(sessionId) {
  const s = String(sessionId)
  const m = s.match(/^session-([0-9a-fA-F]{8})/i)
  return m ? m[1] : s.slice(0, 8)
}

/** 轮次键 = 会话维度 + turn：turn 仅会话内唯一，同工作区多会话时不得共用键 */
export function turnKey(sessionId, turn) { return String(sessionId) + '::' + String(turn) }

export function splitLines(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
export function lcsOps(a, b) {
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
export function charHl(a, b) {
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
export function toViewRow(op) {
  if (op.k === 'ctx') return { k: 'c', o: op.o, n: op.n, t: op.t }
  return { k: 'p', o: op.k === 'del' ? { n: op.o, t: op.t, hl: null } : null, n: op.k === 'add' ? { n: op.n, t: op.t, hl: null } : null }
}
export function finalizeRows(rows) {
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
export function computeDiff(original, current) {
  const a = splitLines(original)
  const b = splitLines(current)
  // 超过 LCS 单元格上限时 lcsOps 退化为"全删+全增"（degraded）：与 lcsOps 内部
  // 判断条件保持一致（n*m > MAX_LCS_CELLS），供 UI 对退化 diff 给出提示
  const degraded = a.length * b.length > MAX_LCS_CELLS
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
  return { stats: { adds, dels }, hunks, degraded }
}

// ---- .gitignore 匹配（敏感文件加强防线）----
// 解析工作区根 .gitignore：用户显式声明不跟踪的文件，插件不读入基线、不产生审阅项、
// 不可撤销。覆盖常见语法：注释/空行、! 取反、尾部 /（目录）、前导 /（锚定根）、
// * ? ** [abc] 通配、\ 转义、无斜杠模式（任意层级 basename）。不支持：嵌套 .gitignore、
// 尾部空格转义（简化：尾部空白一律去除）。
function escapeReChar(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c
}
/** 把一条 gitignore 模式编译为正则片段（不包含边界锚定） */
function gitignorePatternToSource(pattern) {
  let src = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') { i++; src += '.*' }
      else src += '[^/]*'
    } else if (ch === '?') {
      src += '[^/]'
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) { src += '\\['; continue }
      src += pattern.slice(i, close + 1)
      i = close
    } else if (ch === '\\') {
      i++
      if (i < pattern.length) src += escapeReChar(pattern[i])
    } else {
      src += escapeReChar(ch)
    }
  }
  return src
}
/** 解析 .gitignore 文本 → 规则列表（顺序敏感：后匹配的规则优先，! 取反） */
export function parseGitignore(text) {
  const rules = []
  const lines = String(text).split(/\r?\n/)
  for (let raw of lines) {
    raw = raw.replace(/\s+$/, '')
    if (!raw || raw[0] === '#') continue
    let negate = false
    if (raw[0] === '!') { negate = true; raw = raw.slice(1) }
    if (!raw) continue
    let dirOnly = false
    if (raw.endsWith('/')) { dirOnly = true; raw = raw.slice(0, -1) }
    let anchored = false
    if (raw.startsWith('/')) { anchored = true; raw = raw.slice(1) }
    if (!raw) continue
    const hasSlash = raw.indexOf('/') !== -1
    const body = gitignorePatternToSource(raw)
    // 无斜杠模式：匹配任意层级同名段（(?:^|/)name$）；含斜杠/锚定：相对根前缀匹配（^a/b($|/)）
    const re = hasSlash || anchored ? new RegExp('^' + body + '(?:$|/)') : new RegExp('(?:^|/)' + body + '$')
    rules.push({ negate, dirOnly, re })
  }
  return rules
}
/**
 * 判断相对路径（/ 分隔）是否被 gitignore 忽略。
 * 返回 true=应忽略。isDir 标识该路径是目录（目录模式的尾部 / 规则可匹配目录本体）。
 * 对路径的每个前缀（目录）与全路径逐一测试规则，后出现的规则覆盖先出现的（! 取反）。
 */
export function gitignoreMatch(rules, relPath, isDir) {
  if (!rules || rules.length === 0) return false
  const segments = String(relPath).split('/')
  const candidates = []
  for (let i = 1; i <= segments.length; i++) candidates.push(segments.slice(0, i).join('/'))
  const last = candidates.length - 1 // 全路径（目录本体或文件）下标
  let ignored = false
  for (const rule of rules) {
    let hit = false
    for (let ci = 0; ci < candidates.length; ci++) {
      // 目录模式（尾部 /）不匹配文件本体（但可匹配其目录前缀）
      if (rule.dirOnly && ci === last && !isDir) continue
      if (rule.re.test(candidates[ci])) { hit = true; break }
    }
    if (hit) ignored = !rule.negate
  }
  return ignored
}
