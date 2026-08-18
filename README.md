# dsh-diff-review

DeepSeek Harness（dsh）Web 的**逐段对话文件修改审阅**插件：每段对话结束后，自动对比工作区文件版本，找出**仅被修改**（不含新增/删除）的文件，生成类似 VS Code Git diff 的双栏对比，供你审阅后**保留 / 撤销 / 重做**。

> 中文文档 · [English README](./README_EN.md)

## 特性

- **多工作区多基线**：每个工作区独立建立基线、独立检测，切换工作区互不干扰；同名文件、同回合号不会互相污染
- **自动检测所有修改来源**：回合末全量版本对比，bash / 编辑器 / write 工具修改的文件都能捕获
- **总审阅栏（常驻）**：输入框上方始终显示「待审阅修改」，0 修改时显示空态，加载中显示进度
- **两级分组（工作区 → 会话）**：dock 展开后先按会话分组，会话组内各项标注来源回合（第 N 段）；同一工作区下的多个会话、同号轮次互不混淆（轮次仅会话内唯一）
- **会话真实标题**：会话组显示 dsh 会话标题（取自会话日志 `session/title` 事件），标题未生成时回退为会话短 id（如 `#356424b9`）
- **回合尾部面板**：每段对话结束处显示「第 N 段对话的文件修改」，默认折叠、点击展开（严格归属当前会话）
- **diff 查看**：LCS 行级 diff + 字符级高亮，支持「只显示改动行」（未改动行折叠为计数）
- **审阅操作**：逐项或按段「全部保留 / 全部撤销」，撤销后支持「重做」
- **外部编辑器打开**：「其他打开方式」→ VS Code / VS2022 打开或 Diff（临时原文件自动写入工作区）
- **标准 settings 配置**：外部编辑器路径通过 settings.yaml 配置，留空自动探测

## 安装

### 通过 npm（发布后）

```bash
dsh plugin --profile web add dsh-diff-review@<version>
```

### 通过本地路径

```bash
# 路径含空格时先复制到无空格临时目录
git clone <repo-url> %TEMP%\dsh-diff-review
dsh plugin --profile web add "file:%TEMP%\dsh-diff-review"
```

安装完成后**重启 dsh**（旧实例持有旧组合，需重启加载新组合）。

## 使用

1. 正常对话、修改文件（任何方式）
2. 回合结束后：
   - 输入框上方出现「待审阅修改」dock（点击展开 → 工作区头部 + 按会话分组；总栏「工作区全部保留」，会话组内「本会话全部保留」）
   - 每段对话尾部出现「第 N 段对话的文件修改」面板（点击展开 → 各文件项）
3. 点击文件项展开 diff（可切换「只显示改动行」）
4. 执行「保留」或「撤销」；「其他打开方式」可在 VS Code / VS2022 中打开文件或 diff

## 配置（设置 → Diff 审阅插件）

| 键 | 说明 | 默认 |
|---|---|---|
| `code` | VS Code 可执行文件路径（`code` 或 `Code.exe`） | 留空自动探测 |
| `devenv` | VS2022 `devenv.exe` 路径 | 留空自动探测 |
| `vsDiffMerge` | VS2022 `vsDiffMerge.exe` 路径（可选） | 留空从 devenv 同侧查找 |
| `maxFiles` | 工作区遍历文件数上限（达到即截断） | `20000` |
| `primeMaxFiles` | 基线预读文件数上限 | `6000` |
| `primeMaxChars` | 基线预读字符预算（单位 MB） | `48` |

配置写入 `~/.dsh/settings.yaml`（命名空间 `dsh-diff-review`）。数字项填 `0` 或非法值回退默认。

## 工作原理

- **多基线 + 会话层**：`STORES: Map<cwd, store>` 每个工作区独立状态桶（基线 / 版本快照 / 内容缓存 / 分组 / 待审阅项）；`SESSIONS: Map<sessionId, {cwd, lastTurn, label}>` 会话注册表；轮次键为 `sessionId::turn`，审阅项 id 为 `sessionId::turn::path`（同一工作区多会话、同号轮次互不冲突）
- **检测时机**：`agent/turn-stopping`（回合结束）触发全量 `walkWorkspace` 版本对比
- **仅跟踪修改**：新文件只缓存不产生审阅项（符合「仅包括修改」）；文件版本变化才生成 diff
- **通信**：host 通过 `webServer` 路由暴露 JSON API，client 用 `fetch` 调用；客户端从 slot standard props 取 `sessionId`，宿主经 `sessionId → cwd` 映射定位工作区桶（纯 GUI 切换工作区也能刷新）；刷新页面后会话标识重新注入即自动恢复识别，不丢失工作区

## 已知限制

- **删除 / 重命名不跟踪**：插件只跟踪「原位修改」。删除文件无法产生审阅项（也无法撤销删除）；重命名会被识别为「旧路径删除 + 新路径新增」，两者都不在审阅范围内。
- **大工作区截断（可配置）**：遍历达到 `maxFiles`（默认 20000）上限时停止，`getState` 返回 `truncated: true`，dock 会显示带当前上限的警示；基线预读上限 `primeMaxFiles`（默认 6000）/ `primeMaxChars`（默认 48MB）也可在 设置 → Diff 审阅插件 调整。注意：上限设得过大可能显著增加内存占用与扫描耗时。
- **临时原始文件**：打开外部 diff 时，原始内容会以 `dsh-dr-tmp-orig-*` 前缀写入工作区的 `.dsh-dr-tmp-orig/` 子目录（`walkWorkspace` 会跳过该目录，不会污染检测）。它们不会被自动删除，建议把 `.dsh-dr-tmp-orig/` 加入 `.gitignore` 或手动清理。
- **外部编辑器权限**：「其他打开方式」以完全沙箱访问（`danger-full-access`）启动外部编辑器进程——仅在你主动点击时发生，用于让 GUI 应用正常运行。
- **本地路由写操作校验来源**：`/dsh-diff-review` 的写/危险操作（撤销、全部保留、打开外部编辑器、保存配置）校验请求 Origin：带跨站 Origin 的请求被拒绝（防浏览器 CSRF 静默触发），同源请求与无 Origin 的本地客户端不受影响。
- **会话标题依赖 dsh 生成**：会话组标签优先显示 dsh 会话标题（`session/title` 事件）；新会话首回合尚未生成标题时显示会话短 id 占位，回合结束后自动更新。

## 开发

```bash
npm run build   # 从 src/ 生成 lib/
```

`src/index.ts` 为宿主半（ESM，`name`/`inject`/`apply`），`src/client/index.ts` 为客户端半（打包为 `window.__ModuleLoader__.load` 格式）。

## 许可

MIT

## 碎碎念

本项目的大部分代码是在 AI 辅助下完成的，作者本人也是边学边摸索，技术水平和精力都有限。插件目前能跑通我自己的工作流，所以顺手开源。
测试的不充分，如果你在使用中遇到 bug，欢迎提 issue，但我可能没有能力或时间去解决所有复杂问题。非常欢迎有能力的大佬直接 Fork 修改或提交 PR。本项目随缘维护，感谢大家的包容和理解！

早期版本，代码质量不一定高，也有一些上帝函数的问题，请见谅！
