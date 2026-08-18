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
