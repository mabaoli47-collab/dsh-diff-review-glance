# 代码质量重构 TODO（技术债清单）

> 状态：**待办**（发布后实施；当前优先功能与稳定）
> 关联版本：v0.3.10 之后
> 背景：README「碎碎念」已公开承认早期版本代码质量与"上帝函数"问题，此处给出可执行的解决路线图。

## 现状诊断

| 文件 | 规模 | 问题 |
|---|---|---|
| `src/index.ts`（host 半） | ~1045 行单文件 | 7 种职责挤在一个 `apply` 闭包：diff 算法 / 路径标识 / 状态扫描 / 文件审阅 / 编辑器命令 / 通信事件 / settings。上帝函数：`scan`（~78 行）、`getState`（~70 行）、`buildEditorCommand`（~35 行 + 超长 PowerShell 字符串）、`walkWorkspace` |
| `src/client/index.ts`（client 半） | ~535 行单文件 | 拉取逻辑 + 7 个组件（DockPanel / ItemRow / DiffView / TurnTailView / EditorSettingsView / StatusBadge / LineText）+ CSS 全在 `apply` 内 |
| `scripts/build.mjs` | 单文件拼接 | 只处理 `src/index.ts` 与 `src/client/index.ts` 两个入口，无模块图支持（拆分文件需改造） |
| 测试 | 无 | 重构前必须先补验证基线 |

## 已拍板决策

- **时机**：发布后再实施，不阻塞当前功能开发。
- **client 拆分**：引入 **esbuild**（devDependency）替代手写拼接打包 client 组件（dsh 生态亦用 bundler，需验证 `window.__ModuleLoader__` 包装兼容）。

## 路线图（按序执行，每步保持行为不变）

### 阶段 0：验证基线（前置，不可跳过）
- `scripts/smoke.mjs`：加载 lib 产物，断言 host 导出 `name/inject/apply`、client 为合法 ModuleLoader 包装；`node --check` 全部产物。
- `scripts/api-smoke.ps1`：宿主运行后对 `/dsh-diff-review` 做只读冒烟（getState / getItem），核对关键字段（workspaceId / sessionKnown / sessions / limits）。
- 此后每步重构跑一遍，防止回归。

### 阶段 1：host 拆纯函数（零行为变化）
- `src/host/diff.ts`：`splitLines` / `lcsOps` / `charHl` / `toViewRow` / `finalizeRows` / `computeDiff`（纯算法，可单测）。
- `src/host/path.ts`：`canonCwd` / `turnKey` / `shortSessionId` / `relOf`（纯字符串）。
- `src/host/config.ts`：默认常量 + `readConfig` + settings schema 注册（注入 settings 服务）。
- `src/host/editor.ts`：`buildEditorCommand`（模板拆常量表）/ `writeTempOriginal`（注入 fs / sandboxPolicy）。
- 配套改造 `build.mjs`：遍历 `src/**/*.ts` → `lib/**/*.js`，相对 import 用 `.js` 扩展名（Node ESM 原生支持），保留 import type 剥离。

### 阶段 2：拆上帝函数
- `scan`：拆「变更收集」（文件对比）与「item 生成」（diff + 存储）两个函数。
- `getState`：拆 `buildGroups` / `buildPending` / `buildSessions` 三个组装函数。
- `buildEditorCommand`：PowerShell 脚本模板拆成常量数组 + 拼接函数。
- `DockPanel`：拆子组件 `WorkspaceHeader` / `SessionGroup`。

### 阶段 3：client 拆分（esbuild）
- `scripts/build.mjs` 引入 esbuild：打包 `src/client/index.ts` → `lib/client.js`（banner 包装 ModuleLoader），支持组件多文件。
- 组件按职责拆文件：`components/DockPanel.tsx`、`components/ItemRow.tsx`、`components/DiffView.tsx`、`components/TurnTailView.tsx`、`components/EditorSettingsView.tsx`、`store.ts`（拉取/状态逻辑）。
- 验证 ModuleLoader 包装与 React `require('react')` 兼容。

### 阶段 4：补单测（可选，推荐）
- vitest 测纯函数：`canonCwd` / `turnKey` / `computeDiff` / `readConfig` 解析（含 0/非法值回退）。

## 硬约束（重构不得违反）

- **不改 API schema**：`getState` 返回字段（workspaceId / sessionKnown / sessions / groups / pending / limits 等）保持兼容，client 无感。
- **不引入框架 / 状态管理库**：仅允许 esbuild（构建层）；业务层不新增依赖。
- **不重写 diff 算法**：LCS + 字符级高亮逻辑保持不变（已实测可用）。
- **事件 / 工具 / 路由契约不变**：`agent/status`、`agent/turn-stopping`、`drvw_debug`、`/dsh-diff-review` 路由签名保持。
- 每阶段提交前跑阶段 0 验证基线。

## 功能演进方向（待评估 / 待实施）

> 以下为功能增强方向，不属于"代码质量重构"，按优先级（P2 功能增强 / P3 体验优化）记录，实施前需先评估可行性与风险。

### 1. 文件系统 Watcher 机制（秒级增量刷新）— P2

- **背景**：当前检测完全依赖 `agent/turn-stopping` 后的全量 `walkWorkspace` 版本对比。大项目（数万文件）每次全量扫描开销大，且文件修改后要等到回合结束才被检测。
- **价值**：引入原生文件监听，实现秒级增量状态刷新；降低扫描延迟与开销。
- **实施要点**：
  - 调研 dsh fs 服务是否暴露 watch（当前服务方法仅 resolve/stat/readText/listDir/writeText 等，无 watch）——很可能需要在 host 侧直接 `import('node:fs')` 用 `fs.watch` 监听工作区。
  - 事件去抖：批量写入会触发大量事件，需合并（如 100ms 去抖）。
  - 跨平台：`fs.watch` 默认非递归，Windows 上需手动递归注册目录集合；注意事件丢失/重复。
  - 与现有回合末全量扫描的关系：watcher 增量为主、回合末全量兜底（防漏）。
- **风险**：watch 可靠性（事件丢失）、内存占用（目录注册表）、与沙箱/权限的交互需验证。

### 2. Git 版本库感知（git status/diff 提取基线）— P2

- **背景**：当前基线是纯内存缓存（`walkWorkspace` + `contentCache`），重启即失、内存开销大；Git 项目本身已有权威版本历史。
- **价值**：优先回落 `git status` / `git diff` 提取变更，比纯内存基线更轻量、准确；并可支撑重启后的基线恢复。
- **实施要点**：
  - 检测工作区是否为 git 仓库（`.git` 存在）→ 优先用 `git status --porcelain` / `git diff`（经 shell 服务或子进程）提取变更文件。
  - 只读 git 操作无副作用；git 未跟踪文件仍需内存基线兜底（两者互补）。
  - 大仓库 `git status` 也有成本，需评估与全量 walk 的取舍。
- **风险**：非 git 项目回退现有机制；子进程执行开销、git 命令失败处理（.git 损坏/权限）。

### 3. 三方冲突处理（revert 冲突弹窗 + 合并预览）— P3

- **背景**：`applyFileWrite` 检测到文件被外部修改（`expectedContent` 不匹配）时直接返回 `conflict` 拒绝写回，用户只看到错误文案。
- **价值**：冲突时提供弹窗提醒 + 差异合并预览（当前工作区内容 vs 撤销后原始内容），让用户决定「强制覆盖 / 放弃」。
- **实施要点**：
  - client `doReview` 收到 `conflict` → 展示合并预览 UI（三方：当前 / 原始 / 将写入）。
  - host `reviewItem` 返回更丰富的冲突信息（含当前文件内容），client 渲染 diff。
  - 「强制覆盖」需显式用户确认（可能丢弃外部新修改）。
- **风险**：强制覆盖可能丢失用户新修改——UI 必须明确警告；预览渲染成本。

### 4. 外部编辑器跨平台适配（macOS / Linux）— P3

- **背景**：`buildEditorCommand` 硬编码 PowerShell 语法（`Start-Process`/`Get-Command`/`Test-Path`），Linux/macOS 上「其他打开方式」直接语法错误不可用（当前仅 Windows 部署正常）。
- **实施要点**：按平台分支——macOS `open -a <app>` / `code`、Linux `xdg-open` / `code`；编辑器探测路径也要平台化（`/usr/bin/code` 等）。
- **注意**：`readOriginalFromGit` 的单引号转义已是平台感知（Windows `''` / POSIX `'\''`），此改动只涉及 `buildEditorCommand`。

### 5. 内存清理（长会话 / 大工作区）— P3

- **背景**：`STORES` 桶与 `s.items`（原文/修改/当前三份全文）无清理机制，长会话内存持续增长（README 风险声明已披露）。
- **实施要点**：可选监听 dsh 会话销毁事件清理对应 `SESSIONS`/`store.sessions`/`STORES` 条目；或为 `s.items` 增加"已审阅项数量上限、超出淘汰最旧"的修剪策略。
- **风险**：激进清理影响历史回看——需先确认 dsh 会话生命周期语义（会话是否 dispose、持久会话如何界定）。
