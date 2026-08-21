# dsh-diff-review-glance

DeepSeek Harness（dsh）Web 的**逐段对话文件修改审阅**插件：每段对话结束后，自动对比工作区文件版本，找出**仅被修改**（不含新增/删除）的文件，生成类似 VS Code Git diff 的双栏对比，供你审阅后**保留 / 撤销 / 重做**。

当前版本：v0.16.4

> 中文文档 · [English README](./README_EN.md)

## 目录

- [特性](#特性)
- [安装](#安装)
- [使用](#使用)
- [配置（设置 → Diff 审阅插件）](#配置设置--diff-审阅插件)
- [工作原理](#工作原理)
- [权限说明](#权限说明)
- [风险声明](#风险声明)
- [已知限制](#已知限制)
- [开发](#开发)
- [版本历史](#版本历史)
- [许可](#许可)
- [碎碎念](#碎碎念)

## 特性

- **多工作区多基线**：每个工作区独立建立基线、独立检测，切换工作区互不干扰；同名文件、同回合号不会互相污染
- **自动检测所有修改来源**：回合末全量版本对比，bash / 编辑器 / write 工具修改的文件都能捕获
- **可选实时预览**：检测模式可在「回合结束」与「实时预览」间切换——实时模式用 `fs.watch` 监听工作区（仅 Windows，非 Windows 自动回退回合模式），对话进行中即显示「进行中修改」预览，**可直接展开 diff 或外部打开**；实时撤销默认关闭（设置项 `liveRevert`，开启后带版本冲突保护）；回合结束后并入正式审阅项（避免抓到写文件的中间态）
- **总审阅栏（常驻）**：输入框上方始终显示「待审阅修改」，0 修改时显示空态，加载中显示进度
- **两级分组（工作区 → 会话）**：dock 展开后先按会话分组，会话组内各项标注来源回合（第 N 段）；同一工作区下的多个会话、同号轮次互不混淆（轮次仅会话内唯一）
- **会话真实标题**：会话组显示 dsh 会话标题（取自会话日志 `session/title` 事件），标题未生成时回退为会话短 id（如 `#356424b9`）
- **回合尾部面板**：每段对话结束处显示「第 N 段对话的文件修改」，默认折叠、点击展开（严格归属当前会话）
- **diff 查看**：LCS 行级 diff + 字符级高亮，支持「只显示改动行」（未改动行折叠为计数）；**左右两栏布局**，原内容 / 修改后两栏各带横向滚动条，便于阅览长行
- **审阅操作**：逐项或按段「全部保留 / 全部撤销」，撤销后支持「重做」；「清理已处理」按钮可清除保留/撤销记录
- **外部打开**：「其他打开方式」→ VS Code / VS2022 打开或 Diff（临时原文件自动写入工作区），以及**在文件资源管理器中显示**（Windows `explorer /select,` / macOS `open -R` / Linux `xdg-open`）
- **标准 settings 配置**：外部编辑器路径通过 settings.yaml 配置，留空自动探测

## 安装

### 通过 GitHub

```bash
dsh plugin --profile web add github:mabaoli47-collab/dsh-diff-review
```

### 通过 npm（尚未发布）

> 插件**尚未发布到 npm**，以下命令暂不可用（请使用上方 GitHub 或本地路径方式安装）：

~~`dsh plugin --profile web add dsh-diff-review@<version>`~~

### 通过本地路径

```bash
# 路径含空格时先复制到无空格临时目录
git clone <repo-url> %TEMP%\dsh-diff-review
dsh plugin --profile web add "file:%TEMP%\dsh-diff-review"
```

安装完成后**重启 dsh**。

## 使用

1. 正常对话、修改文件（任何方式）
2. 回合结束后：
   - 输入框上方出现「待审阅修改」dock（点击展开 → 工作区头部 + 按会话分组；总栏「工作区全部保留」，会话组内「本会话全部保留」）
   - 每段对话尾部出现「第 N 段对话的文件修改」面板（点击展开 → 各文件项）
3. 可选：在 设置 → Diff 审阅插件 将检测模式切换为「实时预览」，对话进行中即可在 dock 顶部看到「进行中修改（实时预览）」块（仅 Windows）——可直接展开 diff 或外部打开；如需进行中撤销，勾选「实时预览允许撤销」（默认关闭）
4. 点击文件项展开 diff（可切换「只显示改动行」）
5. 执行「保留」或「撤销」；「其他打开方式」可在 VS Code / VS2022 中打开文件或 diff，或在文件资源管理器 / 访达中定位文件

## 配置（设置 → Diff 审阅插件）

| 键 | 说明 | 默认 |
|---|---|---|
| `code` | VS Code 可执行文件路径（`code` 或 `Code.exe`） | 留空自动探测 |
| `devenv` | VS2022 `devenv.exe` 路径 | 留空自动探测 |
| `vsDiffMerge` | VS2022 `vsDiffMerge.exe` 路径（可选） | 留空从 devenv 同侧查找 |
| `maxFiles` | 工作区遍历文件数上限（达到即截断） | `20000` |
| `primeMaxFiles` | 基线预读文件数上限 | `6000` |
| `primeMaxChars` | 基线预读字符预算（单位 MB） | `48` |
| `detectMode` | 检测模式：`turn`=回合结束刷新（默认，跨平台）；`live`=实时预览（fs.watch 监听，仅 Windows，非 Windows 自动回退 turn） | `turn` |
| `liveRevert` | 实时预览项允许直接撤销（默认关闭；开启后 live 项显示撤销按钮，带版本冲突保护——进行中文件可能仍被 AI 改写，存在两个写者竞态，建议在 AI 停笔时撤销） | `false` |
| `respectGitignore` | 尊重 `.gitignore`（默认开启：根 + 各层 `.gitignore` 及用户自配忽略文件中被忽略的文件不读入基线、不产生审阅项、不可撤销；关闭后恢复仅名单过滤） | `true` |
| `extraIgnoreFiles` | 自定义忽略文件路径（每行一个，可工作区外；.gitignore 格式，作为基础忽略层，纯只读匹配） | 空 |
| `trackNewFiles` | 跟踪新建文件（默认关闭；开启后新建文件也产生审阅项——无会话前原文，**仅可保留不可撤销**） | `false` |

配置写入 `~/.dsh/settings.yaml`（命名空间 `dsh-diff-review`）。数字项填 `0` 或非法值回退默认。

## 工作原理

- **多基线 + 会话层**：`STORES: Map<cwd, store>` 每个工作区独立状态桶（基线 / 版本快照 / 内容缓存 / 分组 / 待审阅项）；`SESSIONS: Map<sessionId, {cwd, lastTurn, label}>` 会话注册表；轮次键为 `sessionId::turn`，审阅项 id 为 `sessionId::turn::path`（同一工作区多会话、同号轮次互不冲突）
- **会话隔离模型**：操作范围 = **当前 agent 所在工作区**（typert agent 由运行时注入、不可伪造，pickStore 按会话定位工作区 store）。工作区内跨会话的正式/live 项均可读取与操作（dock 按会话分组的全工作区审阅由此成立；「本会话全部保留」经 `targetSessionId` 显式指定目标会话，须与当前 agent 同工作区）；**跨工作区完全隔离**。实时预览桶（live）为工作区级数据（`sessionId='(live)'`）。
- **检测时机**：`agent/turn-stopping`（回合结束）触发全量 `walkWorkspace` 版本对比（默认，跨平台）；`detectMode=live` 时额外用 `fs.watch` 递归监听工作区，事件去抖 600ms 后做**单文件/全量增量比对**（watcher 只当触发器，正确性仍以版本对比为准，回合末全量扫描保留为兜底——watcher 丢事件只会延迟不会漏检；另有 8 秒事件静默自动全量兜底，空闲时指数退避 5s→80s），实时变更挂 `store.live` 预览桶，**开启 `liveRevert` 后可在进行中撤销**（`applyFileWrite` 版本冲突保护：AI 已改过则拒绝；撤销成功后该项冻结、文件恢复会话基线，回合扫描因 `original===current` 天然不重复产生正式项），回合结束正式扫描后清空并入正式审阅项
- **仅跟踪修改**：新文件只缓存不产生审阅项（符合「仅包括修改」）；文件版本变化才生成 diff
- **原文来源与不可撤销项**：审阅项的「原始内容」优先取会话基线缓存；基线预算未覆盖的文件被修改时，经宿主 shell 只读 `git show HEAD:<relPath>` 补读（详见风险声明「Git 补读」）；git 补读得到的原文标记 `gitOriginal`——**仅用于 diff 展示，不可撤销/重做**（避免回退到 HEAD 吞掉会话前未提交的工作）；两者皆失败则标记 `originalMissing`，仅可保留
- **通信（v0.4 起）**：host 通过**官方 typert RPC**（`dsh-typert-protocol`）暴露服务——调用方 `agent` 由运行时注入，**会话绑定不可伪造**；client 经 `ctx.remote` 挂载描述符后调用命名空间方法。**typert 为唯一通道**（v0.8 起移除过渡 HTTP 路由），无 HTTP 攻击面。**调用约定（v0.16.5 修正后固化）**：descriptor 的 result/参数必须 strict codec（宿主 client loader 拒绝 src-json）；命名空间方法签名 = (lookup 参数, 业务参数...)，client **显式传当前会话 sessionId 作 lookup 参数**（官方 `ctx.remote.goals.edit(sessionId, ref, req)` 模式，不可用 `(undefined, request)` 占位）；返回是 `RemoteResult` 信封（`{ok, value}`），业务数据在 `value` 里须解包；host 返回必须纯 JSON 安全（**含 undefined 值会被 gateway 边界校验拒绝**）。

## 权限说明

本插件属于**高权限本地开发工具**，安装前请知悉其实际能力：

- **读取当前工作区文件内容**：为建立文件版本基线并检测修改，插件会遍历并预读工作区文本。默认排除敏感文件（best-effort 名单，非安全保证）：`.env*`、`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.crt` / `*.keystore`、`credentials.*`、`secrets.*`、`config.local.*`、SSH 私钥（`id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`，无扩展名）、`secret`/`token`/`api_key`/`apikey`（精确名或 `.json`/`.yaml`/`.yml`/`.txt` 变体）、`.kdbx`、`.netrc` / `.npmrc` / `.git-credentials` / `.pgpass` / `htpasswd`；以及 `.ssh/` `.aws/` `.gnupg/` `.kube/` 等敏感目录和常见依赖/构建/IDE 目录（完整名单见 `src/host/util.ts` 的 `IGNORE_DIRS`）。v0.11 起**`.gitignore` 中忽略的文件同样被排除**：v0.13 起读取**根 + 各层 `.gitignore`**（含嵌套仓库自己的，各管各的子树、深层规则优先），用户显式声明不跟踪的文件不读入基线、不产生审阅项、不可撤销；另可经 `extraIgnoreFiles` 自配**工作区外**的忽略文件（**读取范围因此扩展到用户指定路径**，仅只读解析、不展示不执行）；
- **实时监听工作区（live 模式）**：`detectMode=live` 时，宿主进程经 **`node:fs` 的 `fs.watch` 直接监听工作区文件系统事件**（这是对 dsh fs 服务沙箱的只读旁路：事件本身不含文件内容，仅作为「重新比对」的触发器，内容读取仍走受沙箱约束的 fs 服务）；
- **写回工作区文件**：「撤销 / 重做」（以及开启 `liveRevert` 后**实时预览项的撤销**）会把文件恢复为审阅前的版本（带版本冲突检测——文件被外部修改时会拒绝写回而非覆盖）；
- **启动外部进程**：「其他打开方式」会以完整沙箱访问（`danger-full-access`）启动**你配置**的编辑器（VS Code / VS2022）或资源管理器（`explorer.exe` / `open -R` / `xdg-open`）——正式审阅项与实时预览项均可触发，仅在你主动点击时发生；
- **通信（v0.4）**：host/client 仅走官方 **typert RPC**（`dsh-typert-protocol`，agent 由运行时注入，天然会话绑定，无 HTTP 攻击面）。v0.8 起过渡 HTTP 路由已移除，typert 为唯一通道。

**威胁模型**：插件的信任边界 = dsh 宿主进程 + 本机浏览器（typert 为宿主内部通道，无网络监听）。插件**不会**将任何数据上传网络——所有通信均为浏览器 ↔ 本机宿主之间的本地请求。实时预览桶（live）为工作区级数据，其读取/操作不绑定发起会话，但写操作（撤销）仅在本机同源客户端触发且受 `liveRevert` 门控与版本冲突保护。

## 风险声明

本插件已做路径边界、命令注入、TOCTOU/版本冲突等防护，但以下**残余风险与条件性风险**需明确知悉：

- **敏感文件过滤是 best-effort，非安全保证**：默认排除名单基于文件名/后缀匹配。名单之外的凭据样式（如 `db_password`、`prod.env.bak`）或压缩/编码变体（如 `id_rsa.zip`、`cert.base64`）不会命中，可能被读入基线缓存并展示 diff。**加强防线（v0.11/v0.13）**：`respectGitignore` 开启时，**根 + 各层 `.gitignore`（含嵌套仓库自己的）** 中忽略的文件一律不读入基线、不产生审阅项——把自定义敏感文件加入任意一层 `.gitignore` 即可获得等价保护；另支持 `extraIgnoreFiles` 自配工作区外的忽略文件（基础层，低优先）。**请勿在包含此类文件的工作区中使用本插件，或将敏感文件置于忽略范围之外**。
- **撤销/重做的 TOCTOU 窗口**：`applyFileWrite` 在路径校验与写入之间存在极短时间窗口；若本地恶意进程恰好在窗口内把目标文件替换为指向工作区外的符号链接，写入可能越界。此威胁源（本地恶意进程）本身已具备文件系统权限，插件无法完全防范。
- **临时文件权限**：`dsh-dr-tmp-orig-*` 临时文件在 Windows 上受 `%TEMP%` 用户目录（NTFS ACL）隔离保护；但 `chmod 600` 在 Windows/网络文件系统上不保证生效，共享机器或 SMB/NFS 挂载的临时目录下，其他用户可能读取这些包含源代码的临时文件。编辑器打开期间文件保留在磁盘，由 OS 定期清理；插件另登记临时文件并在**创建超过 2 小时后尝试删除**（编辑器仍占用时删除失败被忽略，下轮重试）。
- **调试工具 `drvw_debug`**：注册为模型工具（仅包含**只读**调试动作：`state`/`scan`，已移除 `revertAll`；cwd 限制为当前会话工作区；scan 有 2 秒节流且为**完全 dry-run**——只统计变更，不写 items/groups/contentCache/基线、不推进 rev）。提示注入仍可能诱导模型调用它并向模型暴露当前工作区信息——模型本身已具备工作区文件访问能力，此风险与直接使用 fs/shell 工具相当。
- **资源消耗**：扫描/基线缓存有上限（`maxFiles` / `primeMaxFiles` / `primeMaxChars`，可配置），但设置过大会显著增加内存与扫描耗时；待审阅项在内存中保留原文/修改文/当前文三份，长会话内存持续增长。**自动回收（v0.9）**：每 60 秒维护一次——工作区超过 10 分钟无任何会话活动（页面关闭/无对话）时释放其 fs.watch 句柄与定时器（重新激活时自动重建）；`contentCache` 超过 40000 条时按插入序淘汰最旧条目（被淘汰文件的后续 diff 退回 git 补读或「原始未知」）。
- **实时预览（live 模式）的资源与可靠性**：`detectMode=live` 会对每个访问过的工作区维持一个递归 `fs.watch` 句柄（Windows，多工作区切换时句柄累积，随插件卸载释放）；watcher 事件仅作触发信号——去抖窗口内的文件名会累积成集合逐文件比对，目录级事件或路径过多（事件集合上限 1000）时转全量，另有 8 秒事件静默自动全量兜底，因此丢事件不会漏检、只会延迟；文件变动频繁的工作区会带来周期性增量比对开销。该模式仅 Windows 实现，非 Windows 自动回退回合模式。
- **实时撤销的两写者竞态（开启 `liveRevert` 时）**：进行中的文件可能仍被 AI 改写——你撤销后 AI 的后续写入可能覆盖已恢复的内容（版本冲突检测能拒绝「撤销前已被改」的撤销，但无法阻止「撤销成功后 AI 又写」）。建议在 AI 停笔该文件时撤销。
- **Git 补读**：为恢复基线预算外文件的原始内容，插件会在 git 仓库中执行只读的 `git show HEAD:<relPath>`（经宿主 shell，10 秒超时）。**调用前会拒绝含通配符（`*` `?` `[` `]`）、`$`、反引号、控制字符（含换行）或绝对路径的文件名**，并做平台感知的单引号转义——杜绝路径解释歧义与命令注入；退出码非 0、输出含 `fatal:`/`ERR:` 前缀或超过 2MB 的读取结果一律视为失败并放弃补读（退回「原始未知」）。该命令仅读取，不修改任何文件。

## 已知限制

- **删除 / 重命名不跟踪**：插件只跟踪「原位修改」。删除文件无法产生审阅项（也无法撤销删除）；重命名会被识别为「旧路径删除 + 新路径新增」，两者都不在审阅范围内。
- **实时预览不覆盖新文件**：与回合模式一致，新建文件只进缓存、不产生审阅项（「仅跟踪修改」），实时预览同样只对「基线已存在且版本变化」的文件产生项。
- **实时 diff 是展开时刻的快照**：AI 继续写该文件时，已展开的实时 diff 不会自动刷新——折叠后重新展开可见最新内容。
- **git 补读的原文不可撤销**：来自 git HEAD 的原文（`gitOriginal`）仅供 diff 展示；会话开始前若已有未提交本地修改，HEAD 内容 ≠ 会话前实际内容，撤销会吞掉这部分工作，因此**仅可保留**。
- **大工作区截断（可配置）**：遍历达到 `maxFiles`（默认 20000）上限时停止，`getState` 返回 `truncated: true`，dock 会显示带当前上限的警示；基线预读上限 `primeMaxFiles`（默认 6000）/ `primeMaxChars`（默认 48MB）也可在 设置 → Diff 审阅插件 调整。注意：上限设得过大可能显著增加内存占用与扫描耗时。单文件超过 2MB 不读入基线，计入 dock 的「N 个文件因过大/不可读未纳入」提示（`skippedCount`）。
- **临时原始文件**：打开外部 diff 时，原始内容以 `dsh-dr-tmp-orig-*` 前缀写入**系统临时目录**（OS 自动清理，不污染工作区、不会进入 git）；若宿主沙箱不允许写系统临时目录，则回退写入工作区 `.dsh-dr-tmp-orig/` 子目录（建议加入 `.gitignore`）。
- **外部编辑器权限**：「其他打开方式」以完全沙箱访问（`danger-full-access`）启动外部编辑器/资源管理器进程——仅在你主动点击时发生，用于让 GUI 应用正常运行。
- **路径边界防护**：扫描与写回均校验解析后的真实路径（含软链接解析）必须位于工作区根目录内，越界的 symlink/junction 不纳入对比、revert/redo 拒绝写回。
- **编辑器路径控制字符校验**：`saveEditorConfig` 拒绝含换行/控制字符的路径（路径最终进入 PowerShell 命令，杜绝脚本注入面）。
- **会话标题依赖 dsh 生成**：会话组标签优先显示 dsh 会话标题（`session/title` 事件）；新会话首回合尚未生成标题时显示会话短 id 占位，回合结束后自动更新。

## 开发

```bash
npm run build      # 从 src/ 生成 lib/（含 lib/types/index.d.ts 类型声明）
npm test           # vitest 单元测试（纯函数：路径/边界/敏感名单/diff/gitignore，39 用例）
npm run verify:pack # 打包产物门禁：files 清单 / 语法 / client banner / host 导出形状 / 版本一致性
npm pack --dry-run  # 完整发布链（prepack = build + test + verify:pack）
```

- `src/index.ts` 为宿主半（ESM，`name`/`inject`/`apply`），`src/host/util.ts` 为纯函数工具（可单测），`src/host/typert.ts` 为 typert 描述符（wire 契约）
- `src/client/index.ts` 为客户端半（打包为 `window.__ModuleLoader__.load` 格式），`scripts/build.mjs` 将 host 多文件与 client 单文件转至 `lib/`
- `src/types/index.d.ts` 为手写的公开面类型声明（运行时源码为无注解的纯 JS），build 复制至 `lib/types/`；`scripts/verify-pack.mjs` 为发布门禁（对应 rich-file-review 的 `test:pack`）

## 版本历史

| 版本 | 内容 |
|---|---|
| v0.4.x | 通信迁移到官方 **typert RPC**（agent 注入，会话绑定不可伪造）；HTTP 路由降级为过渡回退；安全加固（会话隔离 fail-closed、redo 守卫、大文件退化提示、fetchItem 竞态修复） |
| v0.5.x | **实时预览**（`detectMode=live`，Windows fs.watch + 增量版本比对 + 事件静默兜底）；live 启动时机修复（首个 getState 登记会话）；事件累积与 8 秒兜底 |
| v0.6.x | live 项可展开 diff / 外部打开；live 撤销（v0.6.0）；修复 live 展开卡「加载 diff…」（getItem 会话校验豁免） |
| v0.7.0 | 实时撤销改为设置项 **`liveRevert`**（默认关闭，opt-in） |
| v0.8.0 | **移除过渡 HTTP 路由与 client fetch 回退**——typert 为唯一通信通道，无 HTTP 攻击面（CSRF/DNS 重绑定等配套防护随之删除） |
| v0.9.0 | **内存自动回收**：空闲工作区（10 分钟无活动）释放 fs.watch 句柄与定时器；`contentCache` 超 40000 条淘汰最旧；git 补读拒绝含 `$`/反引号的文件名（纵深防御） |
| v0.10.0 | **健壮性**：实时检查挂入 scanChain 串行队列（不与回合扫描并发）；`removeLivePath` 改精确路径匹配（POSIX 大小写敏感）；外部 diff 临时文件 2 小时后自动清理；live 块 UI 标注「工作区级」 |
| v0.11.0 | **敏感加强（.gitignore）**：工作区根 `.gitignore` 中忽略的文件不读入基线、不产生审阅项、不可撤销（纯函数匹配器 + 单测；仅支持根 `.gitignore`） |
| v0.11.1 | `.gitignore` 排除改为设置项 **`respectGitignore`**（默认开启，可关闭） |
| v0.12.0 | **评审修复**：跨会话操作统一为「当前工作区」语义（reviewSession 支持 `targetSessionId` 同工作区校验；getItem 返回错误对象不再卡「加载 diff…」）；live 静默兜底改**指数退避**（空闲不再每 5 秒全量扫描）；`agentSessionId` 显式取值；调试扫描独立会话 + 不推进基线；基线失败可重试；state 比对补 `truncated`/`limits`；渲染期副作用移入 effect；页面隐藏暂停轮询；清理死代码/版本文案 |
| v0.13.0 | **嵌套 .gitignore + 自定义忽略文件**：遍历读取每一层 `.gitignore`（各管各的子树、深层规则优先、父层规则也作用于嵌套仓库内部——比 git 更保守）；新增设置 `extraIgnoreFiles` 支持工作区外自定义忽略文件（基础层，纯只读匹配） |
| v0.14.0 | **评审修复**：`drvw_debug` scan 改**完全 dry-run**（不再覆盖 contentCache 导致真实审阅项被静默跳过、不再残留幽灵项）；.gitignore 逐行容错（坏行丢弃其余生效）+ 规则条数上限 5000 + `**/` 根级匹配；revert/redo 前补忽略校验；.gitignore 规则层 TTL 缓存 + 从 entries 判断存在性（消除无效 IO）；baselineError 清除、`_fallbackMs` 复位、keepSession 错误展示 |
| v0.14.1 | **评审微修**：字符类长度上限（防 ReDoS 自伤）；会话隔离语义变更标注版本号；`checkLiveFile` 与 `walkWorkspace` 的 gitignore 判定路径等价性说明 |
| v0.15.0 | **评审修复**：单条 gitignore 模式长度上限 1024（防正则爆栈 DoS）+ 匹配 test 包 try/catch；**规则条数上限 5000 → 2000**（长度上限已遏制 DoS，2000 足够日常）；`realPathBlocked` 只检查工作区根以下相对段（工作区在 build/ 下不再整体失效）+ Windows 盘符路径大小写折叠（.SSH/.NODE_MODULES 命中）；gitignore 规则缓存加版本校验（消除 30 秒 fail-open）+ symlink 越界不读；`pickStore` 移除最近活跃桶回退（fail-closed）；live 事件集合硬上限 1000 |
| v0.15.1 | **匹配结果缓存（R1 性能项）**：同一文件跨 walk/live/审查的重复 gitignore 正则匹配改为文件级结果缓存（TTL 30s，规则集变化即清空）——消除 live 兜底全量/回合末全量的重复匹配成本；规则上限保持 2000（不降，避免功能损失） |
| v0.15.2 | **评审修复（P2）**：`giCachedUpTo` 缓存查询前置（命中零 FS 开销）；`cachedGitignoreRules` 接受外部 version（walk 省 stat）；dry-run scan 输出 `changedCount` 且跳过 diff 计算；单模式通配符上限 64（闭合指数回溯 ReDoS）；失效矩阵补全（extraLayers/saveEditorConfig 清缓存、版本相同不清匹配缓存）、getItem null 出口、空闲释放清缓存 |
| v0.16.0 | **功能性迭代**：跳过文件可观测性（`skippedCount`，dock 提示"N 个文件因过大/不可读未纳入"）；新文件跟踪（设置 `trackNewFiles`，默认关，仅展示不可撤销）；冲突拒绝引导语；gitOriginal 降级提示；非 Windows 禁用 live 选项（前置提示）；「清理已处理」按钮（清除 kept/reverted 记录，手动清理出口） |
| v0.16.1 | **工程化（对比 rich-file-review 补齐）**：TypeScript 类型声明（`lib/types/index.d.ts`，exports 带 types 字段）；打包产物门禁 `verify:pack`（files 清单/语法/banner/导出形状/版本一致性，对应对方 `test:pack`）；prepack 全链 = build + test + verify |
| v0.16.2-0.16.4 | **typert 传输修复（首次端到端跑通）**：v0.4 起 client 用 src-json codec + 单参数调用，被宿主 client loader 静默拒绝——v0.4.x 的 HTTP fetch 回退一直掩盖该缺陷，v0.8 删回退后暴露。修复：client 打印真实错误（不再静默）；descriptor 改用 strict codec（host `z.any()` / client 鸭子 zod schema，透传语义不变）。**升级旧版本后务必硬刷新/无痕窗口验证** |
| v0.16.5 | **typert 调用约定修正（真正的端到端可用）**：v0.16.2-0.16.4 虽能连上，但 client 调用约定错误导致数据调用全部失败（dock 永远"未识别"、设置保存失败，host 日志却一切正常）。修正：命名空间方法签名 = (lookup 参数, 业务参数...)，client **显式传 sessionId 作 lookup 参数**（官方模式，`(undefined, request)` 占位会让 request 落错位被 host 拒绝）；返回 `RemoteResult` 信封须解包 `.value`（不解包则业务字段全 undefined）；host 返回须纯 JSON 安全（含 undefined 值被 gateway 边界校验拒绝，itemFull 修复 + verify-pack 新增 undefined 字段门禁）。**验证纪律：RPC 能连上、UI 能渲染 ≠ 数据调用正确，必须看 client 实际收到的响应** |

## 许可

MIT

## 碎碎念

本项目的大部分代码是在 AI 辅助下完成的，作者本人也是边学边摸索，技术水平和精力都有限。插件目前用于我自己的工作流，所以顺手开源。
测试的不充分，如果你在使用中遇到 bug，欢迎提 issue，但我可能没有能力或时间去解决所有复杂问题。非常欢迎有能力的大佬直接 Fork 修改或提交 PR。本项目随缘维护，感谢大家的包容和理解！

早期版本，代码质量不一定高，也有一些上帝函数的问题，请见谅！
