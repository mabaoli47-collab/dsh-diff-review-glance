// dsh-diff-review host half (formal plugin)
// 从动态插件 v5.5 固化；v0.4 起通信迁移到官方 typert RPC（agent 注入，天然会话绑定），
// v0.8 起移除 webServer 过渡 HTTP 路由——typert 为唯一通道，无 HTTP 攻击面
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { randomBytes } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { watch } from 'node:fs'
import { canonCwd, IGNORE_DIRS, norm, relOf, isSensitiveFile, withinRoot, realPathBlocked, shortSessionId, turnKey, splitLines, computeDiff, parseGitignore, gitignoreMatchLayered } from './host/util.js'
import { hostContribution } from './host/typert.js'

export const name = 'dsh-diff-review'
// 只声明根组合顶层可见的服务；shell/sandboxPolicy 是 scoped/可选服务，用 ctx.get 惰性读取
export const inject = ['fs', 'tools', 'settings']

export function apply(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const tools = ctx.get('tools')
  const shell = ctx.get('shell')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const settings = ctx.get('settings')

  const MAX_FILES = 20000
  const MAX_DEPTH = 32
  const MAX_READ_BYTES = 2 * 1024 * 1024
  const CACHE_NEW_BYTES = 1024 * 1024
  const PRIME_MAX_FILES = 6000
  const PRIME_MAX_CHARS = 48 * 1024 * 1024
  const CONFIG_NS = 'dsh-diff-review'
  // 空闲资源回收：工作区超过此时间无任何会话活动（getState/回合/实时检查）时，
  // 释放该 store 的 watcher 句柄与定时器（contentCache/审阅记录保留）
  const IDLE_RELEASE_MS = 10 * 60 * 1000
  // contentCache 兜底上限：超限时按插入序淘汰最旧条目（防失控增长；被淘汰文件的
  // 后续 diff 退回 git 补读或"原始未知"，README 已披露）
  const CACHE_MAX_ENTRIES = 40000
  // 外部 diff 临时文件保留时长：超过后由维护定时器删除（编辑器仍占用时删除失败被忽略）
  const TEMP_TTL_MS = 2 * 60 * 60 * 1000
  // 临时文件登记表：tempPath -> createdAt（用于定期清理，随 fiber 卸载清空）
  const tempRegistry = new Map()

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
      // 最近活动时间戳：维护定时器据此释放空闲工作区的 watcher/定时器资源
      // （页面开着时 getState 每 2 秒刷新；页面关闭、无会话活动超过阈值才释放）
      lastActivityAt: Date.now(),
      groups: new Map(),
      items: new Map(),
      // 实时预览桶（detectMode='live'，仅 Windows）：watcher 检测到的"进行中"修改，
      // 只读展示；回合结束正式扫描后清空并并入正式审阅项（避免抓到 AI 写文件的中间态）
      live: new Map(),
      watcher: null, // fs.watch 句柄（懒启动，随 fiber 卸载关闭）
      watchTimer: null, // 事件去抖定时器
      watchFailedAt: 0, // watcher 启动失败时间戳（30 秒后自动重试；0=无失败）
      watchError: '', // 最近一次 watcher 启动失败原因（getState 暴露给 UI）
      liveTimer: null, // 定期兜底定时器（live 模式：事件静默时全量检查）
      _livePendingPaths: null, // 去抖窗口内累积的待检查路径 Set（避免只查最后一个文件）
      _liveFull: false, // 目录级/无文件名事件：需要全量兜底
      _lastLiveEventAt: 0, // 最近一次 watcher 事件时间戳（判断事件是否静默）
      _lastLiveCheckAt: 0, // 最近一次实时检查时间戳（兜底节流）
      _liveEventCount: 0, // 已收到的事件计数（getState 暴露，便于诊断）
      _liveCheckCount: 0, // 已执行的实时检查计数
      _fallbackMs: 5000, // 静默兜底间隔（连续无变更时指数退避 5s→…→80s；有事件/有变更复位）
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

  // 敏感文件默认排除：凭据/密钥类文件不纳入基线对比——不读入内存缓存、不产生 diff、
  // 不会因 revert/redo 触碰。默认排除 .env*、私钥/证书、credentials.* / secrets.*、
  // SSH 私钥（无扩展名）、.netrc/.npmrc/.git-credentials/.pgpass/htpasswd 等。
  // 注意：这是 best-effort 名单，不是安全保证（见 README 权限说明）。
  // 实现见 src/host/util.ts（isSensitiveFile）——本轮起纯函数拆入独立模块以便单元测试
  // 边界校验：解析后的真实路径（targetKey，可能经过软链接解析）必须位于工作区根目录内，
  // 防止工作区内的 symlink/junction 指向外部敏感目录（如 ~/.ssh）时被纳入对比甚至被 revert 篡改。
  // 仅当 root 是 Windows 盘符路径时折叠大小写（canonCwd 会把盘符转小写，而 fs.resolve 返回的
  // targetKey 可能保留大写盘符 C:/...，严格比较会误判越界）；
  // Linux/macOS 大小写敏感文件系统保持精确比较，避免把 /a/Proj 与 /a/proj 误判为同源
  // 实现见 src/host/util.ts（withinRoot / realPathBlocked）
  // 读取单个 .gitignore 文件（不存在/不可读返回 null；超大文件放弃，防 DoS）：
  // 用于根/各层 .gitignore 与用户自配的外部忽略文件（均只读、只解析、不展示不执行）
  async function loadGitignoreAt(absPath) {
    try {
      const t = await fs.resolve(absPath)
      const text = await fs.readText(t)
      if (text.length > 1024 * 1024) return null
      const rules = parseGitignore(text)
      return rules.length > 0 ? rules : null
    } catch (e) { return null }
  }
  // .gitignore 规则层缓存（store 级，TTL 30 秒）：gitignore 极少变化，避免每次
  // 扫描/实时检查对同一目录重复读盘。key = 规范化绝对目录路径。
  async function cachedGitignoreRules(s, absDirPath) {
    if (!s._giCache) s._giCache = new Map()
    const key = canonCwd(absDirPath)
    const hit = s._giCache.get(key)
    if (hit && Date.now() - hit.at < 30000) return hit.rules
    const rules = await loadGitignoreAt(join(absDirPath, '.gitignore'))
    const val = rules || []
    if (s._giCache.size > 20000) s._giCache.clear() // 缓存兜底上限
    s._giCache.set(key, { rules: val, at: Date.now() })
    return val
  }
  // 用户自配的外部忽略文件（settings extraIgnoreFiles，每行一个路径，可工作区外）：
  // 作为 base='' 的基础层（先应用，低优先，仅追加忽略）；store 级 TTL 缓存
  async function cachedExtraLayers(s) {
    if (s._extraLayers && s._extraLayersAt && Date.now() - s._extraLayersAt < 30000) return s._extraLayers
    const layers = []
    const cfg = readConfig()
    if (cfg.respectGitignore) {
      for (const p of cfg.extraIgnoreFiles || []) {
        const rules = await loadGitignoreAt(p)
        if (rules) layers.push({ base: '', rules })
        else if (p) console.warn('[dsh-diff-review] 自定义忽略文件不可读（已跳过）:', p)
      }
    }
    s._extraLayers = layers
    s._extraLayersAt = Date.now()
    return layers
  }
  // 单文件路径：收集"用户指定文件 + 该文件所在目录向上到根"的各层 .gitignore（根→深）
  async function gitignoreLayersUpTo(s, relPath) {
    const layers = await cachedExtraLayers(s)
    const rel = String(relPath)
    const dirs = ['']
    const segs = rel.split('/')
    segs.pop() // 去掉文件名，取目录部分
    let acc = ''
    for (const seg of segs) { acc = acc ? acc + '/' + seg : seg; dirs.push(acc) }
    for (const base of dirs) {
      const absDir = base === '' ? s.cwd : norm(join(s.cwd, base))
      const own = await cachedGitignoreRules(s, absDir)
      if (own.length > 0) layers.push({ base, rules: own })
    }
    return layers
  }
  async function walkWorkspace(s) {
    const root = s.cwd
    const out = new Map()
    const seen = new Set()
    const cfg0 = readConfig()
    const maxFiles = cfg0.maxFiles // 可配置上限（settings → maxFiles）
    // 分层 .gitignore（v0.11 敏感加强 + v0.13 嵌套/外部文件）：每层 .gitignore 管其子树，
    // 深层规则优先；用户自配外部忽略文件为基础层。设置 respectGitignore 可整体关闭。
    // 存在性经 entries 判断（无 .gitignore 的目录零额外 IO）；规则层按目录 TTL 缓存。
    const respectGi = cfg0.respectGitignore
    const extraLayers = respectGi ? await cachedExtraLayers(s) : []
    const rootRules = respectGi ? await cachedGitignoreRules(s, root) : []
    const baseLayers = extraLayers.concat(rootRules.length > 0 ? [{ base: '', rules: rootRules }] : [])
    const stack = [{ path: root, depth: 0, parentLayers: baseLayers }]
    let truncated = false
    while (stack.length > 0 && !truncated) {
      const cur = stack.pop()
      if (cur.depth > MAX_DEPTH) continue
      let target
      try { target = await fs.resolve(cur.path) } catch (e) { continue }
      if (!withinRoot(root, target.targetKey)) continue // 软链接越界：跳过，不纳入对比
      // seen 用 canonCwd 归一（盘符统一小写）：防止底层 resolve 大小写不一致时同一目录重复入队
      const seenKey = canonCwd(target.targetKey)
      if (seen.has(seenKey)) continue
      seen.add(seenKey)
      let entries
      try { entries = await fs.listDir(target) } catch (e) { continue }
      // 本目录层：从 entries 识别 .gitignore 文件条目（无需额外 resolve 探测存在性）
      let layers = cur.parentLayers
      if (respectGi && cur.depth > 0) {
        const giEntry = entries.find(x => x.type === 'file' && x.name === '.gitignore')
        if (giEntry) {
          const own = await cachedGitignoreRules(s, cur.path)
          if (own.length > 0) {
            const base = relOf(cur.path, s)
            if (base !== '.') layers = cur.parentLayers.concat([{ base, rules: own }])
          }
        }
      }
      for (let k = entries.length - 1; k >= 0; k--) {
        const e = entries[k]
        if (e.type === 'directory') {
          if (IGNORE_DIRS.has(e.name)) continue
          // 目录 symlink 改名绕过（notkube -> .kube）：resolve 后重判真实路径段
          let dTarget
          try { dTarget = await fs.resolve(e.target.displayPath) } catch (err) { continue }
          if (!withinRoot(root, dTarget.targetKey)) continue
          if (realPathBlocked(dTarget.targetKey)) continue
          // gitignore 目录命中：整个目录不深入（用当前目录的规则链判断）
          if (gitignoreMatchLayered(layers, relOf(dTarget.displayPath, { cwd: root }), true)) continue
          stack.push({ path: dTarget.displayPath, depth: cur.depth + 1, parentLayers: layers })
        } else if (e.type === 'file') {
          if (e.name.indexOf('dsh-dr-tmp-') === 0) continue
          // 文件级 symlink/junction 越界防护：listDir 可能把指向工作区外的
          // 文件符号链接报告为 file（如 link -> /etc/passwd / ~/.ssh/id_rsa），
          // 必须重新 resolve 并用真实路径（targetKey）做 withinRoot 校验，
          // 越界跳过——否则读取侧会越界读到外部敏感文件并生成 diff
          let fTarget
          try { fTarget = await fs.resolve(e.target.displayPath) } catch (err) { continue }
          if (!withinRoot(root, fTarget.targetKey)) continue
          // 敏感判断移到解析后真实路径：foo.txt -> .env 之类的改名链接
          // 用真实 basename 重判 + 真实路径段忽略检查
          const realName = fTarget.displayPath.split('/').pop() || e.name
          if (isSensitiveFile(realName) || realPathBlocked(fTarget.targetKey)) continue
          // gitignore 文件命中：不读入基线、不产生审阅项（分层规则链）
          if (gitignoreMatchLayered(layers, relOf(fTarget.displayPath, { cwd: root }), false)) continue
          let ver = e.version
          if (ver === undefined) {
            try {
              const info = await fs.stat(fTarget)
              ver = info ? info.version : undefined
            } catch (err) { ver = undefined }
          }
          if (ver !== undefined) out.set(fTarget.displayPath, { version: String(ver), size: e.size, target: fTarget })
          if (out.size >= maxFiles) { truncated = true; break }
        }
      }
    }
    return { meta: out, truncated }
  }

  function ensureBaseline(s) {
    if (s.baseline) return s.baseline
    syncLiveWatcher(s) // 实时模式：工作区基线建立时同步启动 watcher
    s.baselineLoading = true
    s.baseline = (async () => {
      try {
        const { meta, truncated } = await walkWorkspace(s)
        s.truncated = truncated
        s.walkFileCount = meta.size
        s.fileMeta = meta
        s.baselineError = null // 重试成功后清除旧错误（drvw_debug 不再显示过期错误）
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
        // 失败后清空 baseline 引用：下次 ensureBaseline 触发重建（否则永久退化为 git 补读/原始未知）
        s.baseline = null
      } finally {
        s.baselineLoading = false
      }
    })()
    return s.baseline
  }
  // 轮次键 = 会话维度 + turn：turn 仅会话内唯一，同工作区多会话时不得共用键
  // 轮次键 = 会话维度 + turn：turn 仅会话内唯一，同工作区多会话时不得共用键（实现见 src/host/util.ts）
  function getGroup(s, sessionId, turn) {
    const key = turnKey(sessionId, turn)
    let g = s.groups.get(key)
    if (!g) { g = { sessionId: String(sessionId), turn, items: new Map() }; s.groups.set(key, g) }
    return g
  }
  // 只读 Git 补读：git show HEAD:<relPath> 取文件在 HEAD 的原始内容，
  // 用于"基线预算未覆盖的文件被修改"时恢复对比基准；非 git 仓库 / 失败返回 null（走 originalMissing 兜底）
  async function readOriginalFromGit(s, path) {
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') return null
    const rel = relOf(path, s)
    if (!rel || rel === '.' || rel.indexOf('..') === 0) return null
    // 绝对路径前置拦截（relOf 异常返回绝对路径时不做无用的 git show 调用）：
    // POSIX 绝对路径 或 Windows 盘符路径
    if (posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
    // git pathspec 通配符：rel 含 * ? [ 时 git show HEAD:* 会被解释为 glob 匹配
    // （Windows 文件名本不允许这些字符，此处防御类 Unix 文件名场景）
    if (/[*?[\]]/.test(rel)) return null
    // PowerShell 变量/转义字符（$ 与反引号）：单引号内本不展开，但极端文件名下
    // 直接放弃 git 补读走 originalMissing 兜底，杜绝任何解析歧义（纵深防御）
    if (/[$\x60]/.test(rel)) return null
    // 控制字符（含换行）拒绝：杜绝折行/多行命令解析
    if (/[\u0000-\u001f]/.test(rel)) return null
    try {
      // 平台感知单引号转义：Windows PowerShell 用 ''；POSIX sh/bash 的 '' 是
      // "闭合 + 空串拼接"，会脱离引号包裹导致命令注入（如 a'; id; 'b.txt）
      const isPosix = String(process.platform) !== 'win32'
      const quoted = isPosix
        ? "'" + String('HEAD:' + rel).replace(/'/g, "'\\''") + "'"
        : "'" + String('HEAD:' + rel).replace(/'/g, "''") + "'"
      let policy
      if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
        try { policy = sandboxPolicy.resolve({ session: s.session }) } catch (e) { policy = undefined }
      }
      const spec = shell.resolve({
        command: 'git show ' + quoted,
        workdir: s.cwd,
        timeoutMs: 10000,
        ...(policy ? { sandboxPolicy: policy } : {}),
      })
      const result = await shell.run(spec)
      // 退出码非 0 一律视为失败：git 报错（未跟踪/非仓库）走 stderr，stdout 可能是空串，
      // 若把 '' 当"空文件原文"返回，会解锁 revert 并把用户文件清空——数据丢失红线
      if (!result || result.exitCode !== 0) return null
      const raw = result && result.stdout
      const out = (raw && typeof raw === 'object' && typeof raw.text === 'string') ? raw.text : String(raw || '')
      // 输出超上限（极端大文件的 HEAD 版本）：放弃补读，避免内存占用
      if (out.length > MAX_READ_BYTES) return null
      const trimmed = out.trim()
      if (trimmed.indexOf('fatal:') === 0 || trimmed.indexOf('ERR:') === 0) return null
      return out
    } catch (e) { return null }
  }

  // ---- 实时预览（detectMode='live'，仅 Windows）：fs.watch 事件去抖后增量比对 ----
  // 设计：watcher 只当"变更触发器"，正确性仍以单文件/全量版本对比为准；
  // 回合末全量扫描保留为兜底，watcher 丢事件只会延迟、不会漏检。
  // 实时变更挂 store.live（工作区级"进行中"预览：只读、不可审阅），
  // 回合结束正式扫描后清空并入正式审阅项——避免抓到 AI 写文件的中间态。
  function syncLiveWatcher(s) {
    const cfg = readConfig()
    // 失败自动重试：30 秒后允许再次尝试（watchFailedAt 由 getState/saveEditorConfig 触发路径重置）
    if (s.watchFailedAt && Date.now() - s.watchFailedAt > 30000) { s.watchFailedAt = 0; s.watchError = '' }
    if (cfg.detectMode === 'live' && !s.watcher && !s.watchFailedAt) {
      try {
        const w = watch(s.cwd, { recursive: true }, (eventType, filename) => scheduleLiveCheck(s, filename))
        w.on('error', (e) => {
          s.watchFailedAt = Date.now()
          s.watchError = (e && e.message) || String(e)
          try { w.close() } catch (err) { /* 忽略 */ }
          s.watcher = null
          console.warn('[dsh-diff-review] 实时监听失败，已回退回合模式:', s.watchError)
        })
        s.watcher = w
        s.watchFailedAt = 0
        s.watchError = ''
        s._fallbackMs = 5000 // 重建 watcher 时复位兜底退避（避免停在 80s 导致首次兜底最长延迟 80s）
        ensureLiveFallbackTimer(s)
      } catch (e) {
        s.watchFailedAt = Date.now()
        s.watchError = (e && e.message) || String(e)
        console.warn('[dsh-diff-review] 实时监听启动失败，已回退回合模式:', s.watchError)
      }
    } else if (cfg.detectMode !== 'live' && s.watcher) {
      try { s.watcher.close() } catch (e) { /* 忽略 */ }
      s.watcher = null
    }
    if (cfg.detectMode !== 'live' && s.liveTimer) {
      clearInterval(s.liveTimer)
      s.liveTimer = null
    }
  }
  // 事件静默兜底：Windows fs.watch 事件可能丢失（或沙箱拦截 file watching），
  // 若长时间没有事件到达，定期做一次全量版本对比保证不漏检。
  // 只在 live 模式下运行；事件正常时（8 秒内有事件）自动跳过。
  // 兜底间隔按"连续无变更"指数退避（5s→10s→…→80s）：空闲工作区不会每 5 秒全量扫描。
  function ensureLiveFallbackTimer(s) {
    if (s.liveTimer || readConfig().detectMode !== 'live') return
    s.liveTimer = setInterval(() => {
      if (readConfig().detectMode !== 'live') return
      const now = Date.now()
      // 从未收到事件（watcher 可能完全失效）或事件静默超过 8 秒时兜底；
      // 间隔受 _fallbackMs 退避约束（有事件时 _lastLiveEventAt 持续刷新，自然跳过）
      if ((s._lastLiveEventAt === 0 || now - s._lastLiveEventAt > 8000) && now - (s._lastLiveCheckAt || 0) >= (s._fallbackMs || 5000)) {
        queueLiveCheck(s)
      }
    }, 5000)
  }
  function scheduleLiveCheck(s, filename) {
    if (readConfig().detectMode !== 'live') return
    s._lastLiveEventAt = Date.now()
    s._fallbackMs = 5000 // 事件驱动：兜底间隔复位
    s._liveEventCount++
    if (filename != null) {
      // 累积全部事件路径：AI 一次写多个文件/原子写 staging 刷屏时，
      // 不能只保留最后一个文件名（否则前面的变更全部丢失）
      if (!s._livePendingPaths) s._livePendingPaths = new Set()
      s._livePendingPaths.add(filename)
    } else {
      // 无文件名（目录级/未知事件）：标记需要全量兜底
      s._liveFull = true
    }
    if (s.watchTimer) clearTimeout(s.watchTimer)
    s.watchTimer = setTimeout(() => { s.watchTimer = null; queueLiveCheck(s) }, 600)
  }
  // 实时检查统一挂到 scanChain 串行队列：与回合末 scan / drvw_debug 扫描不并发
  // 读写 fileMeta/contentCache/live（JS 单线程下引用赋值原子、无半更新状态，
  // 串行化主要保证语义干净：live 检查总是在上一次扫描完成之后执行）
  function queueLiveCheck(s) {
    s.scanChain = s.scanChain
      .then(() => doLiveCheck(s))
      .then((changed) => {
        // 有变更 → 间隔复位；连续无变更 → 指数退避（上限 80s），空闲工作区不空转全量扫描
        s._fallbackMs = changed ? 5000 : Math.min((s._fallbackMs || 5000) * 2, 80000)
      })
      .catch((e) => { s.lastError = ((e && e.message) || String(e)); console.error('[dsh-diff-review] 实时检查失败', e) })
  }
  async function doLiveCheck(s) {
    if (!s.cwd || readConfig().detectMode !== 'live') return
    s.lastActivityAt = Date.now()
    if (s.baseline) { try { await s.baseline } catch (e) {} }
    const paths = s._livePendingPaths
    const full = s._liveFull
    s._livePendingPaths = null
    s._liveFull = false
    s._lastLiveCheckAt = Date.now()
    s._liveCheckCount++
    try {
      let changed = false
      // 事件路径过多（≥30）或出现目录级事件时走全量，否则逐文件增量比对
      if (full || !paths || paths.size >= 30) {
        changed = await checkLiveAll(s)
      } else {
        for (const p of paths) {
          if (await checkLiveFile(s, p)) changed = true
        }
      }
      if (changed) s.rev++
      return changed // 供 queueLiveCheck 调整静默兜底退避间隔
    } catch (e) {
      console.error('[dsh-diff-review] 实时检查失败', e)
      return false
    }
  }
  // 文件级事件：只比对单个文件（绝大多数场景，避免全量 walk 成本）
  async function checkLiveFile(s, rawPath) {
    // Windows recursive watch 的 filename 通常是相对路径（反斜杠），个别情况可能是绝对路径：
    // 绝对路径（盘符或 / 开头）直接使用，相对路径拼接到工作区
    const np = norm(rawPath)
    const joined = /^[a-zA-Z]:\//.test(np) || posix.isAbsolute(np) ? np : join(s.cwd, np)
    let target
    try { target = await fs.resolve(joined) } catch (e) { return removeLivePath(s, rawPath) }
    if (!withinRoot(s.cwd, target.targetKey)) return false
    const realName = target.displayPath.split('/').pop() || ''
    if (isSensitiveFile(realName) || realPathBlocked(target.targetKey)) return false
    // gitignore 加强（分层 + 用户自配外部文件）：被忽略的文件不进实时预览（已在 live 桶则移除）；设置可关闭。
    // 与 walkWorkspace 的层级语义等价（gitignoreLayersUpTo 收集 extra 基础层 + 根→文件所在目录逐层），
    // 保证"全量扫描排除、单文件事件也排除"的一致行为（3.2 审查项：两条路径同一判定结果）。
    if (readConfig().respectGitignore && gitignoreMatchLayered(await gitignoreLayersUpTo(s, relOf(target.displayPath, s)), relOf(target.displayPath, s), false)) {
      s.live.delete(target.displayPath)
      return false
    }
    let info
    try { info = await fs.stat(target) } catch (e) { return removeLivePath(s, rawPath) }
    const path = target.displayPath
    return liveCompare(s, path, target, info ? info.version : undefined, info ? info.size : undefined)
  }
  // 目录级/无文件名事件：全量兜底对比 + 清理已消失的 live 项 + 新文件读缓存
  async function checkLiveAll(s) {
    let walk
    try { walk = await walkWorkspace(s) } catch (e) { return false }
    const meta = walk.meta
    let changed = false
    for (const [path, info] of meta) {
      const prev = s.fileMeta.get(path)
      if (prev && prev.version !== info.version) {
        if (await liveCompare(s, path, info.target, info.version, info.size)) changed = true
      }
    }
    for (const path of Array.from(s.live.keys())) {
      if (!meta.has(path)) { s.live.delete(path); changed = true }
    }
    for (const [path, info] of meta) {
      if (!s.fileMeta.has(path) && (info.size === undefined || info.size <= CACHE_NEW_BYTES)) {
        try { s.contentCache.set(path, await fs.readText(info.target)) } catch (e) { /* 二进制或不可读 */ }
      }
    }
    return changed
  }
  // 单文件版本对比 → 更新 live 桶（与 scan 的 item 生成逻辑同构，但不改 fileMeta）
  async function liveCompare(s, path, target, ver, size) {
    // 已撤销的 live 项冻结：文件已恢复为会话基线，不再被实时刷新覆盖（回合结束统一清空）
    const existing = s.live.get(path)
    if (existing && existing.status === 'reverted') return false
    const prev = s.fileMeta.get(path)
    if (prev && prev.version === String(ver)) return false
    if (!prev) {
      if (size === undefined || size <= CACHE_NEW_BYTES) {
        try { s.contentCache.set(path, await fs.readText(target)) } catch (e) { /* 二进制或不可读 */ }
      }
      return false
    }
    if (size !== undefined && size > MAX_READ_BYTES) return false
    let current
    try { current = await fs.readText(target) } catch (e) { return false }
    let original = s.contentCache.get(path)
    let gitOriginal = false
    if (original === undefined) {
      original = await readOriginalFromGit(s, path)
      if (typeof original === 'string') { s.contentCache.set(path, original); gitOriginal = true }
    }
    if (original !== undefined && original === current) {
      s.live.delete(path)
      return false
    }
    const diff = original === null ? buildAddsOnlyDiff(current) : computeDiff(original, current)
    s.live.set(path, {
      id: 'live::' + path,
      sessionId: '(live)',
      turn: 0,
      file: path,
      relPath: relOf(path, s),
      original,
      modified: current,
      current,
      originalMissing: original === null,
      gitOriginal,
      status: 'pending',
      stats: diff.stats,
      hunks: diff.hunks,
      degraded: !!diff.degraded,
      live: true,
    })
    return true
  }
  // 删除事件兜底：resolve 已失败，把事件路径归一化为绝对路径后与 live 项 key 精确匹配。
  // Windows 折叠盘符/整段大小写（fs 大小写不敏感）；POSIX 保持精确（避免误删 Foo.txt 的 live 项）
  function removeLivePath(s, rawPath) {
    const np = norm(rawPath)
    const abs = /^[a-zA-Z]:\//.test(np) || posix.isAbsolute(np) ? np : norm(join(s.cwd, np))
    const isWin = String(process.platform) === 'win32'
    const target = isWin ? abs.toLowerCase() : abs
    let removed = false
    for (const k of Array.from(s.live.keys())) {
      const nk = isWin ? norm(k).toLowerCase() : norm(k)
      if (nk === target) { s.live.delete(k); removed = true }
    }
    return removed
  }
  // 原始内容未知（外部命令修改/非 git 补读失败）时：整文件视为新增
  function buildAddsOnlyDiff(current) {
    const lines = splitLines(current)
    return {
      stats: { adds: lines.length, dels: 0 },
      hunks: [{ rows: lines.map((t, j) => ({ k: 'p', o: null, n: { n: j + 1, t, hl: null } })), gap: 0 }],
      degraded: false,
    }
  }
  // watcher/去抖定时器/兜底定时器随插件 fiber 卸载清理
  ctx.effect(() => () => {
    for (const st of STORES.values()) {
      if (st.watchTimer) { clearTimeout(st.watchTimer); st.watchTimer = null }
      if (st.liveTimer) { clearInterval(st.liveTimer); st.liveTimer = null }
      if (st.watcher) { try { st.watcher.close() } catch (e) { /* 忽略 */ } st.watcher = null }
    }
    tempRegistry.clear()
  })

  // ---- 空闲资源回收（每 60 秒维护一次，随 fiber 卸载清理）----
  // ① 空闲工作区释放 watcher 句柄与定时器（页面开着时 getState 每 2 秒刷新
  // lastActivityAt，不会误释放；页面关闭/无会话活动超过 IDLE_RELEASE_MS 才释放，
  // 重新激活时 getState 的 syncLiveWatcher/ensureLiveFallbackTimer 自动重建）；
  // ② contentCache 超上限时按插入序淘汰最旧条目（Map 迭代序 = 插入序），兜底防失控增长；
  // ③ 过期外部 diff 临时文件删除（编辑器仍占用时删除失败被忽略，下轮重试）。
  function maintainStores() {
    const now = Date.now()
    for (const st of STORES.values()) {
      if (st.lastActivityAt && now - st.lastActivityAt > IDLE_RELEASE_MS) {
        if (st.watchTimer) { clearTimeout(st.watchTimer); st.watchTimer = null }
        if (st.liveTimer) { clearInterval(st.liveTimer); st.liveTimer = null }
        if (st.watcher) { try { st.watcher.close() } catch (e) { /* 忽略 */ } st.watcher = null }
        st._livePendingPaths = null
        st._liveFull = false
        st._fallbackMs = 5000 // 释放时复位退避，重建后立即恢复 5s 兜底
      }
      if (st.contentCache.size > CACHE_MAX_ENTRIES) {
        const excess = st.contentCache.size - Math.floor(CACHE_MAX_ENTRIES * 0.75)
        let dropped = 0
        for (const key of Array.from(st.contentCache.keys())) {
          if (dropped >= excess) break
          st.contentCache.delete(key)
          dropped++
        }
      }
    }
    for (const [p, t] of Array.from(tempRegistry.entries())) {
      if (now - t > TEMP_TTL_MS) {
        tempRegistry.delete(p)
        unlink(p).catch(() => { /* 编辑器仍占用/权限不足：忽略，下轮重试 */ })
      }
    }
  }
  ctx.effect(() => {
    const timer = setInterval(maintainStores, 60000)
    return () => clearInterval(timer)
  })

  async function scan(s, sessionId, turn, opts) {
    if (!s.cwd) return
    // dryRun=true（调试预览扫描）：只统计变更，不写 items/groups/contentCache/fileMeta、
    // 不推进 rev——否则调试扫描会把 contentCache 覆盖为当前内容，真实回合的审阅项
    // 会因 original===current 被静默跳过（会话前原文丢失），并残留不可见的幽灵项。
    // 参见 README：drvw_debug 的 scan 为纯预览，绝不修改插件内部审阅状态。
    const dryRun = !!(opts && opts.dryRun)
    s.scanning = true
    try {
      if (s.baseline) { try { await s.baseline } catch (e) {} }
      s.scanCount++
      let walk
      try { walk = await walkWorkspace(s) } catch (e) { s.lastError = 'walk: ' + ((e && e.message) || String(e)); console.error('[dsh-diff-review] 扫描失败', e); return }
      const meta = walk.meta
      s.truncated = walk.truncated
      s.walkFileCount = meta.size
      const group = dryRun ? null : getGroup(s, sessionId, turn)
      const changed = []
      try {
        for (const [path, info] of meta) {
          const prev = s.fileMeta.get(path)
          if (prev && prev.version === info.version) continue
          if (!prev) {
            if (!dryRun && (info.size === undefined || info.size <= CACHE_NEW_BYTES)) {
              try { s.contentCache.set(path, await fs.readText(info.target)) } catch (e) { /* 二进制或不可读 */ }
            }
            continue
          }
          if (info.size !== undefined && info.size > MAX_READ_BYTES) continue
          let current
          try { current = await fs.readText(info.target) } catch (e) { continue }
          let original = s.contentCache.get(path)
          let gitOriginal = false
          if (original === undefined) {
            // 基线预算外（primeMaxFiles/primeMaxChars 未覆盖）或缓存缺失的文件被修改：
            // 尝试从 Git 历史补读原始内容（只读 git show），失败则按"原始未知"处理。
            // 注意：HEAD 内容 ≠ 会话开始前的原文（会话前可能有未提交本地修改），
            // 该原文只用于 diff 展示，item 标记 gitOriginal 以禁止 revert（避免吞掉未提交工作）
            original = await readOriginalFromGit(s, path)
            if (typeof original === 'string') {
              if (!dryRun) s.contentCache.set(path, original)
              gitOriginal = true
            }
          }
          if (original !== undefined && original === current) {
            if (!dryRun) s.contentCache.set(path, current)
            continue
          }
          changed.push({ path, info, original: original === undefined ? null : original, current, gitOriginal })
        }
        for (const c of changed) {
          // item id 含会话维度：不同会话的同号轮次修改同一文件不得冲突
          const id = String(sessionId) + '::' + turn + '::' + c.path
          if (s.items.has(id)) continue
          let diff
          if (c.original === null) {
            diff = buildAddsOnlyDiff(c.current)
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
            gitOriginal: !!c.gitOriginal,
            status: 'pending',
            stats: diff.stats,
            hunks: diff.hunks,
            degraded: !!diff.degraded,
          }
          if (!dryRun) {
            s.items.set(id, item)
            group.items.set(c.path, item)
            s.contentCache.set(c.path, c.current)
          }
        }
        const nextMeta = new Map()
        for (const [p, info] of meta) nextMeta.set(p, info)
        if (!dryRun) {
          s.fileMeta = nextMeta
          for (const p of Array.from(s.contentCache.keys())) {
            if (!nextMeta.has(p)) s.contentCache.delete(p)
          }
          if (changed.length > 0) s.rev++
        }
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
      // 越界防护：真实路径（含软链接解析）必须位于工作区内，否则拒绝写回
      if (!withinRoot(s.cwd, target.targetKey)) {
        return { ok: false, error: 'out-of-bounds', message: '文件真实路径超出工作区根目录，操作已取消' }
      }
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
    if (action === 'revert' || action === 'redo') {
      // 写入前校验：文件当前是否已被 .gitignore 忽略（item 可能在文件加入忽略前已创建）。
      // 被忽略的文件不产生审阅项、也不应被撤销/重做触碰（与"忽略=不跟踪"语义一致）
      if (readConfig().respectGitignore) {
        const rel = relOf(item.file, s)
        if (gitignoreMatchLayered(await gitignoreLayersUpTo(s, rel), rel, false)) {
          return { ok: false, error: 'gitignored', message: '该文件现已被 .gitignore 忽略，禁止撤销/重做' }
        }
      }
    }
    if (action === 'revert') {
      // gitOriginal：原文来自 git HEAD（可能 ≠ 会话开始前内容，会话前可能有未提交本地修改），
      // 撤销会把文件回退到 HEAD 吞掉未提交工作——禁止 revert，仅允许 diff 展示
      if (item.original === null || item.gitOriginal) return { ok: false, error: 'no-original', message: '原始内容未知（或来自 git HEAD 非会话基线），无法撤销' }
      const res = await applyFileWrite(s, item.file, item.original, item.modified)
      if (!res.ok) return res
      item.status = 'reverted'
      item.current = item.original
      s.rev++
      return { ok: true, status: item.status }
    }
    if (action === 'redo') {
      // 与 revert 对称的守卫：原始内容未知/来自 git HEAD 的项禁止重做。
      // 当前不可达（此类项无法进入 reverted 态，UI 也不提供重做按钮），
      // 但作为防御性约束防止未来改动引入可达路径
      if (item.original === null || item.gitOriginal) return { ok: false, error: 'no-original', message: '原始内容未知（或来自 git HEAD 非会话基线），无法重做' }
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
    return { id: item.id, sessionId: item.sessionId, turn: item.turn, file: item.file, relPath: item.relPath, status: item.status, originalMissing: item.originalMissing, gitOriginal: !!item.gitOriginal, stats: item.stats, live: !!item.live }
  }
  function itemFull(item) {
    // originalMissing 时带 current，供 DiffView 显示当前文件内容；正常 diff 不传整个文件体
    return { id: item.id, sessionId: item.sessionId, turn: item.turn, file: item.file, relPath: item.relPath, status: item.status, originalMissing: item.originalMissing, gitOriginal: !!item.gitOriginal, stats: item.stats, hunks: item.hunks, current: item.originalMissing ? item.current : undefined, degraded: !!item.degraded, live: !!item.live }
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
      detectMode: { type: 'string' },
      liveRevert: { type: 'boolean' },
      respectGitignore: { type: 'boolean' },
      extraIgnoreFiles: { type: 'string' },
    }
    function schema(input) {
      const src = input && typeof input === 'object' ? input : {}
      const out = {}
      for (const key of Object.keys(dict)) {
        if (dict[key].type === 'number') {
          const v = src[key]
          out[key] = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : 0)
        } else if (dict[key].type === 'boolean') {
          out[key] = !!src[key]
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
        detectMode: { type: 'string', description: '检测模式：turn=回合结束刷新（默认，跨平台）；live=实时预览（watcher 监听，仅 Windows）' },
        liveRevert: { type: 'boolean', description: '实时预览项允许直接撤销（默认关闭；开启后 live 项显示撤销按钮，带版本冲突保护）' },
        respectGitignore: { type: 'boolean', description: '尊重 .gitignore（默认开启：根 + 各层 .gitignore 与用户自配忽略文件中被忽略的文件不读入基线、不产生审阅项、不可撤销）' },
        extraIgnoreFiles: { type: 'string', description: '自定义忽略文件路径（每行一个，可工作区外；作为基础忽略层，纯只读匹配）' },
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
    const empty = { code: '', devenv: '', vsDiffMerge: '', maxFiles: MAX_FILES, primeMaxFiles: PRIME_MAX_FILES, primeMaxChars: PRIME_MAX_CHARS, detectMode: 'turn', liveRevert: false, respectGitignore: true, extraIgnoreFiles: [] }
    if (!settingsRegistered) return empty
    try {
      const v = settings.get(CONFIG_NS)
      if (!v || typeof v !== 'object') return empty
      // 上限硬夹紧：防止手工改 settings.yaml 写入极大值导致全盘遍历/预读 DoS
      const num = (x, def, max) => {
        const n = typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN)
        if (!(Number.isFinite(n) && n > 0)) return def
        return Math.min(Math.floor(n), max)
      }
      // 实时预览（watcher）仅 Windows 实现：其他平台一律回退回合模式
      const isWin = String(process.platform) === 'win32'
      return {
        code: typeof v.code === 'string' ? v.code : '',
        devenv: typeof v.devenv === 'string' ? v.devenv : '',
        vsDiffMerge: typeof v.vsDiffMerge === 'string' ? v.vsDiffMerge : '',
        maxFiles: num(v.maxFiles, MAX_FILES, 200000),
        primeMaxFiles: num(v.primeMaxFiles, PRIME_MAX_FILES, 60000),
        // 配置以 MB 为单位，内部转为字符数；硬上限 1024MB
        primeMaxChars: num(v.primeMaxChars, PRIME_MAX_CHARS / (1024 * 1024), 1024) * (1024 * 1024),
        detectMode: v.detectMode === 'live' && isWin ? 'live' : 'turn',
        // 实时撤销默认关闭：进行中的文件可能仍被 AI 改写，撤销存在"两个写者"竞态，由用户显式开启
        liveRevert: v.liveRevert === true,
        // 尊重 .gitignore 默认开启（敏感加强）；显式设为 false 才关闭
        respectGitignore: v.respectGitignore !== false,
        // 用户自配外部忽略文件（换行分隔路径；可工作区外，纯只读匹配）
        extraIgnoreFiles: typeof v.extraIgnoreFiles === 'string' ? v.extraIgnoreFiles.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [],
      }
    } catch (e) { return empty }
  }

  function buildEditorCommand(editor, left, right, diff, cfg) {
    // 防御：文件路径（来自工作区文件名/临时文件）含控制字符时直接拒绝——单引号转义只处理
    // 单引号注入，控制字符（换行等）在极端文件名场景下不应进入 shell 命令
    if (/[\u0000-\u001f]/.test(String(left)) || /[\u0000-\u001f]/.test(String(right))) {
      return 'Write-Output \'ERR:文件路径含控制字符，已拒绝打开\'; exit 1'
    }
    // 「在文件资源管理器中显示」：Windows explorer /select, / macOS open -R / Linux xdg-open 目录
    if (editor === 'explorer') {
      const qPosix = (line) => "'" + String(line).replace(/'/g, "'\\''") + "'"
      const qWin = (line) => "'" + String(line).replace(/'/g, "''") + "'"
      if (String(process.platform) !== 'win32') {
        if (String(process.platform) === 'darwin') return 'open -R ' + qPosix(left) + '; echo OK:'
        return 'xdg-open ' + qPosix(dirname(String(left).replace(/\\/g, '/'))) + '; echo OK:'
      }
      // explorer.exe 是 GUI 程序（启动即返回）；/select,"path" 在资源管理器中定位并选中
      const quoted = '"' + String(left).replace(/"/g, '""') + '"'
      return 'Start-Process -FilePath explorer.exe -ArgumentList ' + qWin('/select,' + quoted) + '; Write-Output "OK:"'
    }
    // POSIX（macOS / Linux）：code 命令（或配置路径）打开/diff；VS2022 仅 Windows 支持。
    // 命令前先校验可执行文件存在，失败输出 ERR:（避免 command-not-found 后仍 echo OK: 误判成功）
    if (String(process.platform) !== 'win32') {
      const q = (line) => "'" + String(line).replace(/'/g, "'\\''") + "'"
      const exe = (cfg.code && cfg.code.trim()) ? cfg.code.trim() : 'code'
      const exeQ = /^[a-zA-Z0-9_\-./]+$/.test(exe) ? exe : q(exe)
      if (editor === 'vs') return "echo 'ERR:VS2022 仅支持 Windows'; exit 1"
      const check = 'if ! command -v ' + exeQ + ' >/dev/null 2>&1; then echo \'ERR:编辑器命令不存在\'; exit 1; fi'
      const run = diff ? exeQ + ' --diff ' + q(left) + ' ' + q(right) + '; echo OK:' : exeQ + ' ' + q(left) + '; echo OK:'
      return check + '; ' + run
    }
    // PowerShell 单引号字符串：内部单引号用 '' 转义，杜绝路径含 ' 时的注入/提前终止
    const q = (line) => "'" + String(line).replace(/'/g, "''") + "'"
    // -ArgumentList 多参数必须用逗号分隔（PowerShell 数组语法）：
    // 空格分隔会被解析为 Start-Process 自身的位置参数而报
    // "A positional parameter cannot be found"（外部 diff 打开失败）
    const pOpen = q(left)
    const pDm = q(left) + ', ' + q(right)
    const pDevenvDiff = '"/diff", ' + q(left) + ', ' + q(right)
    const pCodeDiff = '"--diff", ' + q(left) + ', ' + q(right)
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
        // 报错消息不含配置值：PowerShell 双引号字符串会执行 $()/反引号转义，插值用户输入可被注入
        ? '$dPath = ' + q(cfg.devenv) + '; if (-not (Test-Path $dPath)) { Write-Output \'ERR:配置的 devenv 路径不存在\'; exit 1 }'
        : probeDevenv
      if (diff) {
        const dm = cfg.vsDiffMerge
          ? '$dm = ' + q(cfg.vsDiffMerge) + '; if (Test-Path $dm) { ' + launch('$dm', pDm) + ' } else { Write-Output \'ERR:配置的 vsDiffMerge 路径不存在\'; exit 1 }'
          : "$dm = (Split-Path $dPath) + '\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\vsDiffMerge.exe'; if (Test-Path $dm) { " + launch('$dm', pDm) + ' } else { ' + launch('$dPath', pDevenvDiff) + ' }'
        return dExpr + '; ' + dm
      }
      return dExpr + '; ' + launch('$dPath', pOpen)
    }
    const probeCode =
      "$c = Get-Command code -ErrorAction SilentlyContinue; if (-not $c) { Write-Output 'MISSING:VSCode'; exit 1 }; "
      + "$exe = $c.Source; if ($exe -like '*\\bin\\code.cmd') { $exe = $exe.Substring(0, $exe.Length - '\\bin\\code.cmd'.Length) + '\\Code.exe' }; if (-not (Test-Path $exe)) { $exe = $c.Source }"
    const exeExpr = cfg.code
      ? '$exe = ' + q(cfg.code) + '; if (-not (Test-Path $exe)) { Write-Output \'ERR:配置的 VS Code 路径不存在\'; exit 1 }'
      : probeCode
    return exeExpr + '; ' + launch('$exe', diff ? pCodeDiff : pOpen)
  }

  async function writeTempOriginal(s, item) {
    // 临时文件名含 turn + 路径 hash + 随机段（防可预测文件名枚举）+ 原文件名，
    // 避免不同目录同名文件互相覆盖。
    // 安全策略：优先写入系统临时目录（OS 自动清理、不污染工作区、不会进入 git），
    // 写后 chmod 600 限制同机其他用户读取；若宿主沙箱不允许写系统临时目录，
    // 则回退到工作区 .dsh-dr-tmp-orig/（writeText 自动建父目录）。
    const sep = String(s.cwd).indexOf('\\') >= 0 ? '\\' : '/'
    const normFile = String(item.file).replace(/\\/g, '/')
    // 防御性 sanitize：pop() 本身只取最后一段文件名（不含分隔符/..），但若文件名
    // 恰好是 . 或 ..（理论保留名）则回退 'file'，杜绝任何路径穿越的可能
    let base = normFile.split('/').pop() || 'file'
    if (base === '.' || base === '..' || base === '') base = 'file'
    let hash = 0
    for (let i = 0; i < normFile.length; i++) hash = ((hash << 5) - hash + normFile.charCodeAt(i)) | 0
    // 随机段不可用时直接拒绝写入（省略随机段会使文件名可预测，助长预建 symlink 攻击）
    let rand
    try { rand = '-' + randomBytes(16).toString('hex') } catch (e) { return null }
    const name = 'dsh-dr-tmp-orig-' + (item.turn != null ? item.turn + '-' : '') + (hash >>> 0).toString(36) + rand + '-' + base
    // 目录级 symlink 检查：系统临时目录与工作区回退目录若被预建为符号链接
    // （多用户 /tmp TOCTOU、工作区被注入链接），都放弃该候选
    const isSymlinkDir = async (p) => {
      try {
        const info = await fs.lstat(p)
        return !!(info && info.type === 'symlink')
      } catch (e) { return false } // 不存在 → 不是 symlink（writeText 会自动创建）
    }
    const candidates = []
    try {
      const tmpDir = join(tmpdir(), 'dsh-dr-tmp-orig')
      if (!(await isSymlinkDir(tmpDir))) candidates.push(join(tmpDir, name))
    } catch (e) { /* tmpdir 不可用则跳过 */ }
    const wsDir = String(s.cwd).replace(/[\\/]$/, '') + sep + '.dsh-dr-tmp-orig'
    if (!(await isSymlinkDir(wsDir))) candidates.push(wsDir + sep + name)
    for (const tempPath of candidates) {
      try {
        const target = await fs.resolve(tempPath)
        let policy
        if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
          try { policy = sandboxPolicy.resolve({ session: s.session }) } catch (e) { policy = undefined }
        }
        await fs.writeText(target, item.original, undefined, undefined, policy)
        try { await chmod(target.targetKey, 0o600) } catch (e) { /* 权限位设置失败不影响功能 */ }
        // 登记临时文件（维护定时器定期清理过期项；编辑器仍占用时删除失败会被忽略）
        tempRegistry.set(tempPath, Date.now())
        return tempPath
      } catch (e) { /* 沙箱拒绝或 IO 失败：尝试下一个候选 */ }
    }
    return null
  }

  // ---- 业务动作分发 ----
  // 唯一入口：typert DiffReviewService（agent 由运行时注入，会话绑定不可伪造）。
  // 动作 + args 的契约由 client 侧 TYPERT_REMOTE 描述符与 src/host/typert.ts 保持一致。
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
        // 实时预览项（id 前缀 live::）从 live 桶读取，正式项从 items 读取
        const item = id ? (id.indexOf('live::') === 0 ? s.live.get(id.slice(6)) : s.items.get(id)) : undefined
        if (!item) {
          // 返回错误对象而非 null：客户端可区分"记录不存在"与"加载中"（避免卡"加载 diff…"）
          return { ok: false, error: 'not-found', message: '记录不存在（插件可能已重启）' }
        }
        // 会话标识必填（fail-closed）。操作范围 = 当前 agent 所在工作区（v0.12 起的语义变更：
        // 从"严格会话隔离"调整为"工作区级信任边界"——typert agent 不可伪造、同一工作区的
        // 会话属同一用户项目；pickStore 已按会话定位工作区 store），store 内的正式/live 项
        // 均属该工作区，可读取（typert agent 不可伪造）。
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
        if (!sid) return { ok: false, error: 'no-store', message: '缺少会话标识，操作已拒绝' }
        return itemFull(item)
      }
      case 'review': {
        const s = pickStore(args)
        if (!s) return { ok: false, error: 'no-store', message: '尚无活跃工作区' }
        // 会话标识必填（fail-closed）。操作范围 = 当前 agent 所在工作区（v0.12 起语义变更：
        // 工作区级信任边界，见 getItem 注释）：store 内的正式/live 项均属该工作区，允许操作
        // （typert agent 不可伪造；跨工作区由 pickStore 隔离）
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
        if (!sid) return { ok: false, error: 'no-store', message: '缺少会话标识，操作已拒绝' }
        const item = args && args.itemId ? (args.itemId.indexOf('live::') === 0 ? s.live.get(args.itemId.slice(6)) : s.items.get(args.itemId)) : undefined
        if (item && item.live) {
          // 实时预览项：默认只读（只读模式更安全——进行中的文件可能仍被 AI 改写，两个写者竞态）。
          // liveRevert=true 时允许直接撤销，安全护栏：
          // ① 走 applyFileWrite 版本冲突检测——AI 在你撤销后已改过文件则拒绝，不静默破坏；
          // ② 原始内容未知（originalMissing/gitOriginal）不可撤销；③ 撤销成功后该项冻结
          // （liveCompare 跳过已撤销项，不再被实时刷新覆盖），文件恢复为会话基线后，
          // 回合扫描会因 original===current 天然跳过，不会重复产生正式审阅项。
          // 「保留」在 live 阶段无意义（回合结束自动成为正式项），不提供。
          const cfg = readConfig()
          if (cfg.liveRevert && args && args.action === 'revert' && !item.originalMissing && !item.gitOriginal) {
            const res = await applyFileWrite(s, item.file, item.original, item.modified)
            if (!res.ok) return res
            item.status = 'reverted'
            item.current = item.original
            s.rev++
            return { ok: true, status: item.status }
          }
          return { ok: false, error: 'live-item', message: (item.originalMissing || item.gitOriginal) ? '原始内容未知，无法撤销' : '实时预览为只读（默认），可在 设置 → Diff 审阅插件 开启实时撤销' }
        }
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
        // 会话级全部保留（dock 会话组内按钮）。目标会话 = request.targetSessionId（client 传，
        // 须与当前 agent 同工作区）或缺省当前会话——修复 typert 迁移期"targetSessionId 被
        // sessionId 覆盖"导致的静默错位（点 B 会话按钮实际保留 A 会话）。
        const s = pickStore(args)
        if (!s) return { ok: true, kept: 0 }
        const me = args && typeof args.sessionId === 'string' ? args.sessionId : ''
        if (!me) return { ok: true, kept: 0 }
        const target = args && typeof args.targetSessionId === 'string' && args.targetSessionId ? args.targetSessionId : me
        // 目标会话必须已登记且与当前 agent 同一工作区（防跨工作区误操作）
        const meSess = SESSIONS.get(me)
        const tSess = SESSIONS.get(target)
        if (!meSess || !tSess || tSess.cwd !== meSess.cwd) return { ok: false, error: 'no-store', message: '目标会话不属于当前工作区，操作已拒绝' }
        let n = 0
        for (const item of s.items.values()) {
          if (item.sessionId === target && item.status === 'pending') { item.status = 'kept'; n++ }
        }
        if (n > 0) s.rev++
        return { ok: true, kept: n }
      }
      case 'reviewAll': {
        // 工作区级批量保留（dock 总栏按钮）：作用于当前 agent 工作区全部待审阅项。
        // 注意这是有意的跨会话写路径（非破坏性——仅置 kept）；若未来添加"工作区全部撤销"
        // 需重新评估破坏性跨会话写语义。
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
      const raw = typeof args[key] === 'string' ? args[key] : ''
      // 拒绝控制字符（换行等）+ Shell 元字符：路径最终会进入 shell 命令，杜绝跨平台脚本注入面。
      // 注意：括号 ( ) 不拒绝——Windows 默认路径 C:\Program Files (x86)\... 含括号，
      // 且路径经 q() 单引号包裹后括号天然安全（此前误杀该路径属回归）
      if (/[\u0000-\u001f]/.test(raw)) return { ok: false, message: key + ' 含控制字符，已拒绝' }
      if (/[$`"';&|]/.test(raw)) return { ok: false, message: key + ' 含 Shell 危险字符，已拒绝' }
      patch[key] = raw.trim()
    }
    // 数字上限项：合法正整数才写入，否则存 0（读取时回退默认）
    for (const key of ['maxFiles', 'primeMaxFiles', 'primeMaxChars']) {
      const n = Number(args[key])
      patch[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    // 检测模式：仅允许 turn / live（非法拒绝；live 在非 Windows 由 readConfig 回退回合模式）
    const dm = typeof args.detectMode === 'string' ? args.detectMode : ''
    if (dm !== 'turn' && dm !== 'live') return { ok: false, message: 'detectMode 仅支持 turn / live' }
    patch.detectMode = dm
    // 实时撤销开关（默认关闭）
    patch.liveRevert = args.liveRevert === true
    // 尊重 .gitignore 开关（默认开启；显式 false 才关闭）
    patch.respectGitignore = args.respectGitignore !== false
    // 自定义忽略文件：每行一个路径（可工作区外）；拒绝控制字符（读取走 fs 服务不经 shell）
    const rawExtra = typeof args.extraIgnoreFiles === 'string' ? args.extraIgnoreFiles : ''
    const extraList = rawExtra.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    for (const p of extraList) {
      if (/[\u0000-\u001f]/.test(p)) return { ok: false, message: 'extraIgnoreFiles 含控制字符（每行一个路径），已拒绝' }
    }
    patch.extraIgnoreFiles = extraList.join('\n')
    return Promise.resolve(settings.update(CONFIG_NS, patch))
      .then(() => {
        // 模式切换后同步各工作区 watcher 状态（live→启动，turn→关闭）；失败标记重置以便重试
        for (const st of STORES.values()) { st.watchFailedAt = 0; st.watchError = ''; syncLiveWatcher(st) }
        return { ok: true, config: { code: patch.code, devenv: patch.devenv, vsDiffMerge: patch.vsDiffMerge, detectMode: patch.detectMode, liveRevert: patch.liveRevert, respectGitignore: patch.respectGitignore } }
      })
      .catch((e) => ({ ok: false, message: (e && e.message) || String(e) }))
  }

  async function openExternal(args) {
    const itemId = args && args.itemId
    const editor = args && args.editor === 'vs' ? 'vs' : (args && args.editor === 'explorer' ? 'explorer' : 'vscode')
    const diff = !!(args && args.diff)
    const s = pickStore(args)
    if (!s) return { ok: false, message: '尚无活跃工作区，无法打开' }
    const item = itemId ? (itemId.indexOf('live::') === 0 ? s.live.get(itemId.slice(6)) : s.items.get(itemId)) : undefined
    if (!item) return { ok: false, message: '记录不存在（插件可能已重启）' }
    // 会话标识必填（fail-closed）。操作范围 = 当前 agent 所在工作区（v0.12 起语义变更：
    // 工作区级信任边界，见 getItem 注释）；store 内的正式/live 项均属该工作区，可触发外部打开
    const sid = args && typeof args.sessionId === 'string' ? args.sessionId : null
    if (!sid) return { ok: false, message: '缺少会话标识，操作已拒绝' }
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

  // 会话短标识：dsh sessionId 形如 session-<uuid>（实现见 src/host/util.ts shortSessionId）
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
    if (s) s.lastActivityAt = Date.now()
    // 实时模式：只要会话已登记（store 存在），每次 getState 都确保 watcher 状态与基线
    // 就绪（幂等）——不依赖 agent/status 回合事件，重启后首个 getState 即可启动实时监听
    if (s && cfg.detectMode === 'live') {
      syncLiveWatcher(s)
      ensureLiveFallbackTimer(s)
      ensureBaseline(s)
    }
    if (!s) {
      return { rev: 0, maxTurn: 0, workspaceId: '', workspaceLabel: '', sessionId: curSessionId, sessionKnown: !!curSessionId && SESSIONS.has(curSessionId), loading: false, truncated: false, lastTurn: 0, pendingCount: 0, sessions: [], groups: [], pending: [], live: [], limits, detectMode: cfg.detectMode, liveRevert: cfg.liveRevert, respectGitignore: cfg.respectGitignore, watcherActive: false, liveError: '', liveStats: { events: 0, checks: 0, items: 0 } }
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
      live: Array.from(s.live.values()).map(itemSummary),
      detectMode: cfg.detectMode,
      liveRevert: cfg.liveRevert,
      respectGitignore: cfg.respectGitignore,
      watcherActive: !!s.watcher,
      liveError: s.watchError || '',
      liveStats: { events: s._liveEventCount || 0, checks: s._liveCheckCount || 0, items: s.live.size },
      limits,
    }
  }

  // ---- 标准工具注册：drvw_debug（defineTool 生成精确 ToolDefinition 再 register，与动态版 harness.defineTool 同源） ----
  if (tools && typeof tools.register === 'function') {
    const debugTool = defineTool({
      name: 'drvw_debug',
      description: '读取「对话修改审阅」插件（drvw）的内部状态并支持调试动作：action=state 返回状态（默认，可指定 cwd 参数查看特定工作区）；action=scan 立即执行一次预览扫描（完全 dry-run：只统计变更，不写 items/groups/contentCache/基线、不推进 rev）。仅包含不修改插件审阅状态的只读调试动作；cwd 必须等于当前会话工作区。',
      // ParameterSchemaSpec：扁平属性映射（defineTool 转成 JSON Schema object 根）
      parameters: {
        action: {
          type: 'string',
          enum: ['state', 'scan'],
          description: '调试动作：state（默认）查看状态；scan 立即扫描（只读）',
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
          // 安全边界（发布 gate）：调试工具不得把插件的文件读取/写回能力扩展到任意目录。
          // cwd 参数必须等于当前调用者（agent 会话）的工作区，否则直接拒绝——
          // 防止对任意指定目录建立基线并执行扫描。
          const agentCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : null
          if (!agentCwd || canonCwd(args.cwd) !== canonCwd(agentCwd)) {
            return { cwd: '', baselineReady: false, baselineError: '', lastError: 'drvw_debug: cwd 必须等于当前会话工作区（防止越权扫描/写回）', lastTurn: 0, rev: 0, scanCount: 0, walkFileCount: 0, truncated: false, cacheSize: 0, itemCount: 0, pendingCount: 0, loading: false, groups: [], reviewResults: [] }
          }
          s = STORES.get(canonCwd(args.cwd))
          if (!s) s = getStore(args.cwd)
        }
        // 不提供 cwd 时仅使用当前调用者会话的工作区（registerSession 已登记）；
        // 不再回退到 active（最后活跃工作区）——否则提示注入下 AI 不带参数调用
        // 会拿到其他工作区的内部状态，违背工作区隔离原则
        if (s) {
          ensureBaseline(s)
          if (s.baseline) { try { await s.baseline } catch (e) {} }
        }
        const action = args && args.action ? args.action : 'state'
        if (action === 'scan') {
          // 返回必须符合 output schema（无 actionDone 字段）；无工作区时返回完整空状态并记入 lastError
          if (!s || !s.cwd) {
            if (s) s.lastError = 'scan-skipped-no-cwd'
            return { cwd: '', baselineReady: false, baselineError: '', lastError: s ? (s.lastError || '') : '', lastTurn: 0, rev: 0, scanCount: 0, walkFileCount: 0, truncated: false, cacheSize: 0, itemCount: 0, pendingCount: 0, loading: false, groups: [], reviewResults: [] }
          }
          // 节流 + 串行化：与 turn-stopping 共用 scanChain 队列，避免并发操作同一 store
          // （并发会污染 fileMeta/contentCache 基线）；2 秒内不重复触发全量扫描，
          // 防提示注入诱导高频调用造成本地 CPU/磁盘 DoS。
          const now = Date.now()
          if (s.lastToolScanAt && now - s.lastToolScanAt < 2000) {
            s.lastError = 'scan-throttled: 扫描过于频繁，请稍后再试'
          } else {
            s.lastToolScanAt = now
            // 调试扫描 = 完全 dry-run：固定独立 sessionId（'drvw-scan'），只统计变更，
            // 不写 items/groups/contentCache/fileMeta、不推进 rev——杜绝覆盖基线缓存
            // 导致真实回合审阅项被静默跳过、或残留不可见的幽灵项
            const chain = s.scanChain.then(() => scan(s, 'drvw-scan', 0, { dryRun: true })).catch((e) => { s.lastError = ((e && e.message) || String(e)); console.error('[dsh-diff-review] 扫描失败', e) })
            s.scanChain = chain
            await chain
          }
        }
        // 仅保留只读动作（state/scan）；revertAll 等写回动作已移除——调试工具不得成为
        // 提示注入下的批量文件写回入口（发布安全门禁）
        const reviewResults = []
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
        // 不再返回 stores 数组：其中包含宿主上所有活跃工作区的绝对路径，
        // 避免调试工具成为提示注入下的环境情报泄露口（AI 需要时自有 fs 工具可查）
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
  // 从 agent.session.events 中取最近一条（与 dsh 官方测试同款读取方式；用倒序查找而非 findLast，兼容旧 Node）
  function readSessionTitle(agent) {
    try {
      const sess = agent && agent.session
      let ev = null
      if (sess && Array.isArray(sess.events)) {
        for (let i = sess.events.length - 1; i >= 0; i--) {
          if (sess.events[i] && sess.events[i].type === 'session/title') { ev = sess.events[i]; break }
        }
      }
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
    s.lastActivityAt = Date.now()
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
      s.scanChain = s.scanChain.then(async () => {
        await scan(s, sid, turn)
        // 回合结束定稿：清空实时预览桶（正式审阅项已收录该轮变更），避免旧快照并存
        if (s.live.size > 0) { s.live.clear(); s.rev++ }
      }).catch((e) => { s.lastError = ((e && e.message) || String(e)); console.error('[dsh-diff-review] 扫描失败', e) })
    }
  }))

  // ---- v0.4 typert RPC transport（官方通信通道）----
  // agent 由运行时注入（scope.context='agent'）：方法内以 agent 会话为准，
  // client 传入的 sessionId 一律被 agent 覆盖——调用者身份不可伪造，天然会话绑定。
  // 操作范围 = 当前 agent 所在工作区（pickStore 按会话定位工作区 store）。
  // agentSessionId：typert 运行时注入的 agent 可能是 sessionId 字符串或 agent 对象
  // （含 session.id），统一显式取值，避免依赖 String(agent) 的字符串化语义。
  function agentSessionId(agent) {
    if (agent == null) return ''
    if (typeof agent === 'string') return agent
    if (typeof agent === 'object' && agent.session && agent.session.id != null) return String(agent.session.id)
    return String(agent)
  }
  const typert = ctx.get('typert')
  if (typert && typeof typert.register === 'function') {
    class DiffReviewService extends TypertRemoteService {
      constructor() { super(ctx, 'diffReview') }
      getState(agent, request) {
        // 重启后首个 getState 即登记会话（typert 的 agent 由运行时注入，含 session/header/cwd）：
        // live 模式据此建立基线并启动 watcher，不依赖 agent/status 回合事件——
        // 否则重启后第一回合进行中实时预览不生效（store 直到回合结束才创建）
        registerSession(agent, null)
        return handleAction('getState', Object.assign({}, request, { sessionId: agentSessionId(agent) }))
      }
      getItem(agent, request) { return handleAction('getItem', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      review(agent, request) { return handleAction('review', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      reviewGroup(agent, request) { return handleAction('reviewGroup', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      reviewSession(agent, request) { return handleAction('reviewSession', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      reviewAll(agent, request) { return handleAction('reviewAll', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      openExternal(agent, request) { return handleAction('openExternal', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      getEditorConfig(agent, request) { return handleAction('getEditorConfig', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
      saveEditorConfig(agent, request) { return handleAction('saveEditorConfig', Object.assign({}, request, { sessionId: agentSessionId(agent) })) }
    }
    new DiffReviewService()
    ctx.effect(() => typert.register(hostContribution()))
  }

  console.log('[dsh-diff-review] 正式插件已启动（v0.14.1），typert 唯一通道（无 HTTP 路由）')
}
