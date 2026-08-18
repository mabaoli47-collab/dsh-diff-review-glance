# dsh-diff-review 概念梳理与 Schema 设计

> 状态：设计稿（v0.3.6 现状盘点 + 目标模型），待确认后实施
> 关联版本：v0.3.6（当前）、目标 v0.3.7

## 1. 三层概念定义

| 概念 | 定义 | 标识 | 生命周期 |
|---|---|---|---|
| **工作区 Workspace** | 磁盘目录（dsh 会话的 `session.header.cwd`），插件为其建立独立基线 | `canonCwd`（统一分隔符 + 去尾斜杠 + Windows 盘符小写） | 进程内常驻；首个会话活动时创建 |
| **会话 Session** | dsh 的 agent 会话，持有自己的工作区与轮次计数 | `agent.session.id` | dsh 会话生命周期；一个会话绑定一个工作区 |
| **对话轮次 Turn** | 会话内的一次完整对话回合（`agent/turn-stopping` 的 `turn`），**按会话从 1 递增** | 会话内唯一：`turn` 号 | 回合结束时创建并触发扫描 |
| **审阅项 ReviewItem** | 某一轮次中某文件"仅修改"的 diff 记录 | 全插件唯一：`sessionId::turn::path` | 创建后直至 keep/revert/redo |

**核心不变量：**
- turn 号**只在会话内唯一**；不同会话可以有相同 turn 号。
- 一个工作区可被多个会话使用（`Workspace → Session` 一对多）。
- 一个会话只属于一个工作区（`Session → Workspace` 多对一，当前实现下为绑定关系）。
- 完整定位一个审阅项需要三元组：`(workspaceId, sessionId, turn, path)`。

## 2. 现状盘点（v0.3.6）与缺陷证据

### 2.1 当前载体

| 概念 | 当前实现 | 位置 |
|---|---|---|
| 工作区 | `STORES: Map<canonCwd, store>`；store 持有 `baseline / fileMeta / contentCache / groups / items / lastTurn / session` | `src/index.ts` `makeStore` |
| 会话 | 仅 `SESSION_CWDS: Map<sessionId, cwd>`（会话→工作区键映射）+ `store.session`（最近引用的 agent.session，用于沙箱 policy） | `src/index.ts` L33、`agent/status` / `agent/turn-stopping` |
| 轮次 | `store.groups: Map<turn, group>`（**工作区级**键）、`store.lastTurn = max(lastTurn, turn)` | `src/index.ts` `getGroup` / `scan` |
| 审阅项 | `id = turn + ':' + c.path`、`group.items: Map<path, item>` | `src/index.ts` scan L326 |

### 2.2 已确认的缺陷（同一工作区、多个会话时）

1. **item id 碰撞**：`id = turn:path` 不含会话维度。会话 A 与 B 各自第 3 轮修改 `src/a.ts` → 完全相同的 id → `if (s.items.has(id)) continue`（scan L327）**静默吞掉后写会话的修改记录**。
2. **groups 撞键**：`getGroup(s, turn)` 按 turn 键。A 的 turn 3 与 B 的 turn 3 合并进同一 group，`group.items.set(path, item)` 后写覆盖先写。
3. **turnTail 串数据**：client 端 `snap.groups.find(g => g.turn === turn)`（`src/client/index.ts` TurnTailView）——groups 是**工作区级**的，当前会话第 N 段面板可能渲染**其他会话**的第 N 段数据。
4. **lastTurn 语义混乱**：跨会话取 max，无法表达"某个会话进行到第几轮"。
5. **dock 混排**：pending 列表按 turn 倒序混排所有会话，无会话标识，用户无法区分归属。
6. **会话元数据缺失**：`SESSION_CWDS` 只存 cwd，无会话的 lastTurn/标题；`store.session` 是最近引用，同工作区多会话时沙箱 policy 可能解析到错误会话（影响小，cwd 相同，但语义不严谨）。

## 3. 目标模型

```
Workspace (工作区)                        canonCwd
├── baseline / fileMeta / contentCache    基线（工作区级，与会话无关）
├── sessions: Map<sessionId, SessionData> 会话注册表
└── groups: Map<turnKey, TurnGroup>       turnKey = `${sessionId}::${turn}`

SessionData (会话)                        sessionId
├── cwd: canonCwd                         绑定工作区
├── lastTurn: number                      本会话轮次计数
└── （可选）title: string                 会话标题

TurnGroup (轮次)                          sessionId::turn
├── sessionId / turn
└── items: Map<path, ReviewItem>

ReviewItem (审阅项)                       sessionId::turn::path
├── sessionId / turn / file / relPath
├── original / modified / current / originalMissing
├── status: pending | kept | reverted
└── stats / hunks
```

查询路径：
- 按会话：`SESSION_CWDS[sessionId] → workspace → groups` 过滤 `sessionId`
- 按工作区聚合：`workspace.groups` 全体（面板可切换会话视图）

## 4. Schema

### 4.1 内部存储（host）

```ts
// 替换 SESSION_CWDS：会话注册表
SESSIONS: Map<sessionId, {
  cwd: canonCwd
  lastTurn: number
}>

// store 调整
store.sessions: Map<sessionId, { lastTurn: number }>  // 本工作区关联的会话（反向索引）
store.groups:  Map<turnKey, { sessionId, turn, items: Map<path, item> }>  // turnKey = `${sessionId}::${turn}`
store.items:   Map<itemId, item>                       // itemId = `${sessionId}::${turn}::${path}`
store.lastTurn: 0                                      // 保留为"本工作区所有会话最大轮次"（仅统计用）

// 删除或弃用 store.session 最近引用；policy 解析改为按 SESSIONS 显式传 sessionId
```

### 4.2 事件处理

```ts
ctx.on('agent/turn-stopping', ({ agent, turn }) => {
  const sessionId = agent.session.id
  const cwd = agent.session.header.cwd
  const s = getStore(cwd)
  SESSIONS.set(sessionId, { cwd: canonCwd(cwd), lastTurn: turn })
  s.sessions.set(sessionId, { lastTurn: turn })
  s.lastTurn = Math.max(s.lastTurn, turn)
  ensureBaseline(s)
  scan(s, { sessionId, turn })          // scan 携带会话维度
})
// agent/status 同样登记 SESSIONS 与 s.sessions（不触发扫描）
```

`scan(s, { sessionId, turn })` 内：
- `turnKey = sessionId + '::' + turn`
- `item.id = sessionId + '::' + turn + '::' + path`

### 4.3 getState（client API，v0.3.7 最终版）

```jsonc
{
  "rev": 3,
  "workspaceId": "c:/project",        // 当前工作区 canonCwd
  "workspaceLabel": "project",
  "sessionId": "sess-abc",            // 当前会话（client 传入，回显）
  "sessionKnown": true,               // 会话已映射到工作区（false → 面板显示"未识别"）
  "loading": false,
  "truncated": false,
  "lastTurn": 5,                      // 工作区所有会话的最大轮次（统计用）
  "pendingCount": 3,                  // 工作区全部待审阅数
  "sessions": [                       // ★ 工作区会话总览（按最近活动倒序）
    { "id": "sess-abc", "label": "会话 A", "lastTurn": 3, "pendingCount": 1 },
    { "id": "sess-xyz", "label": "会话 B", "lastTurn": 5, "pendingCount": 2 }
  ],
  "groups": [                         // ★ 整个工作区，按会话聚合（会话内按 turn 升序）
    { "sessionId": "sess-abc", "sessionLabel": "会话 A", "turn": 1, "itemCount": 2, "pendingCount": 1, "status": "partial",
      "items": [ { "id": "sess-abc::1::src/a.ts", "sessionId": "sess-abc", "turn": 1, "relPath": "src/a.ts", "status": "pending", "originalMissing": false, "stats": { "adds": 3, "dels": 1 } } ] },
    { "sessionId": "sess-xyz", "sessionLabel": "会话 B", "turn": 2, "itemCount": 1, "pendingCount": 1, "status": "pending",
      "items": [ /* ... */ ] }
  ],
  "pending": [ /* 整个工作区待审阅，按会话聚合（会话按最近活动倒序、会话内 turn 倒序） */ ]
}
```

关键点：
- **`groups` / `pending` 覆盖整个工作区、携带 `sessionId`/`sessionLabel`**——dock 按会话分组渲染。
- `turnTail` 的匹配条件从 `g.turn === turn` 改为 `g.sessionId === currentSessionId && g.turn === turn`——会话限定后不再串数据。
- `sessions` 总览供 dock 的会话组标题与「本会话全部保留」按钮使用。
- 会话 label 优先级：`agent.session.header.title` → 会话名 → `#<sessionId 前 8 位>`。

### 4.4 其他动作

| 动作 | 参数 | 作用范围 | 返回 |
|---|---|---|---|
| `getItem` | `itemId` | 不变（id 语义变为含会话维度，客户端透传） | 不变 |
| `review` | `itemId, action` | 不变 | 不变 |
| `reviewGroup` | `sessionId, turn, action` | ★ 限定该会话该轮次 | 不变 |
| `reviewSession` | `sessionId` | ★ 新增：该会话全部待审阅 → kept | `{ ok, kept }` |
| `reviewAll` | — | **工作区全部**（总栏「工作区全部保留」，语义不变） | `{ ok, kept }` |
| `openExternal` | `itemId, editor, diff` | 不变 | 不变 |

> `reviewAll`（总栏按钮）保持"工作区全部"；「本会话全部保留」走新的 `reviewSession`——与两级分组 UI 对齐。

### 4.5 drvw_debug 工具

`execute` 时优先从 `exec.agent.session.id` 取 sessionId 并透传给 `getState`/`scan`，output 的 `groups` 同样限定该会话。

## 5. 实施计划（目标 v0.3.7）

1. **host**：`SESSIONS` 注册表 + `store.sessions` 反向索引 + `groups`/`items` 键改 `turnKey`/`itemId`（`scan`/`getGroup`/`reviewItem`/`itemSummary`/`itemFull` 同步）。
2. **host**：`getState` 返回新 schema（groups/pending 限定当前会话、`sessions` 总览、`lastTurn` 为当前会话值）。
3. **host**：`reviewGroup`/`reviewAll` 限定当前会话；`openExternal`/`review` 透传。
4. **client**：dock 按新 schema 渲染（当前会话标题 + 可选会话切换）；turnTail 依赖会话限定后的 groups 精确匹配；「本工作区全部保留」文案与行为对齐（改为当前会话）。
5. **client**：未识别态文案沿用 v0.3.6。
6. 重建、重装、验证（node --check + grep 中文串 + 多会话同 turn 回归）。

## 6. 展示决策（已确认，v0.3.7 实施依据）

- **总审阅栏显示整个工作区**的待审阅项，**按会话分组**（决策 B）。
- 总栏与工作区头部按钮 =「工作区全部保留」（`reviewAll`，工作区级）。
- 每个会话组标签内按钮 =「本会话全部保留」（`reviewSession`，会话级）。
- 会话组内条目沿用 turn 标签（第 N 段），归属明确。
- 未识别会话（`sessionKnown: false`）显示「未识别（尚无对话记录）」空态，不展示任何工作区数据。

## 7. 兼容性与迁移

- 插件无持久化（进程内状态），重启即重建，**无需数据迁移**。
- item id / turnKey 格式变化仅影响运行中数据（重启后作废），客户端按 host 返回值透传，无硬编码依赖。
- README 需同步更新：「按工作区分组」下补充"按会话隔离轮次"说明。
