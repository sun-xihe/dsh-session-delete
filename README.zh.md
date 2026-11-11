# dsh-session-delete

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 加一个能力：**已归档的会话可以永久删除**。

DSH 本身只提供"归档 / 恢复"——归档只是把会话从侧栏隐藏起来，日志仍然留在磁盘上。这个插件在会话右键菜单里加一个「删除会话」动作，仅对已归档的会话显示，确认后把会话从磁盘上真正删掉。

## 功能

- **右键菜单入口**：会话右键菜单里新增「删除会话」（危险色），只有当前在归档集合中的会话才会出现；未归档的会话既看不到入口，宿主也会拒绝请求。
- **设置页管理面板**：设置 → **归档会话** 列出归档集合里的每一个会话，包括侧栏永远不显示的**空白会话**（没有产生任何事件的 New Session），并标注「空白 / 记录缺失 / 运行中」。
- **二次确认与强制删除**：删除前弹出确认框，说明操作不可撤销；如果会话仍被当前 dsh web 进程里的空闲 Agent 持有，确认框会说明原因并再给一次「强制删除」，而真正在跑的会话始终被拒绝。
- **级联清理**：删除一个会话时，一并删除它的子智能体会话记录（`origin: "subagent"` 的后代）；普通 fork 是独立会话，**不会**被删除。
- **同步簿记**：除了会话日志目录，还会清理：
  - 工作区注册表里的归档集合（`archivedSessionIds`）；
  - 每个工作区的会话归属（`sessionIds`，工作区本身保留）；
  - `session_projcache` 里该会话的投影检查点（派生缓存）。
- **中英双语**：跟随 DSH 语言设置，其余语言回退到英文。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add git+https://github.com/sun-xihe/dsh-session-delete.git
```

### 本地目录安装

```bash
git clone https://github.com/sun-xihe/dsh-session-delete.git
dsh plugin --profile web add /绝对路径/dsh-session-delete
# 或先从源码打包：
npm pack ./dsh-session-delete
dsh plugin --profile web add /绝对路径/dsh-session-delete-0.2.0.tgz
```

该包声明了 `dsh.bundle.patch`，`dsh plugin` 会把它自动追加到 profile 的 `dsh.profile.bundles` 层栈里。

启用 HMR 的 profile 会自动重载配置；**浏览器页面需要刷新一次**，新的浏览器插件才会进入 `window.__DSH_BOOT__` 的模块图。未启用 HMR 时重启 `dsh web`。

### 卸载

```bash
dsh plugin --profile web remove dsh-session-delete
```

插件只新增一个路由和若干浏览器注册项，卸载不会动任何会话数据。

## 使用

### 从侧栏删除

1. 在侧栏把要删除的会话**归档**（右键 → 归档会话，或行内归档按钮）。
2. 打开侧栏视图选项 → 显示已归档（或"仅看已归档"），让归档会话重新出现。
3. 右键该会话 → **删除会话** → 确认「永久删除」。

删除成功后，会话行消失；如果当前是"仅看已归档"视图且没有其它归档会话，列表显示空状态。

### 从设置页删除（空白会话、侧栏看不到的会话）

打开 设置 → **归档会话**，这里直接列出归档集合的每个 id：

- **空白会话**（只有 header、没有事件）在侧栏永远不会成行——空白行只在"当前 New Session"时显示，而归档会话不可能是当前会话，所以只能在管理面板里删除；
- 标注「记录缺失」的条目表示归档集合里还有 id，但磁盘日志已经不存在，删除它只是清理簿记；
- 标注「运行中」的会话不能删除，需要先停止。

### 强制删除

如果确认框提示"仍被当前 dsh web 进程持有"，说明该会话自本次进程启动后被打开过：DSH 会把空闲 Agent 一直留在内存里，并持有日志目录的 `flock` 写锁。此时确认框会再给一次**强制删除**：移除磁盘上的日志与簿记，内存里的旧会话要重启 dsh web 才消失。建议强制删除后刷新页面。

## 删除到底删了什么

| 数据 | 处理 |
| --- | --- |
| 会话 JSONL 日志目录（`$DSH_HOME/sessions/<项目>/<会话 id>/`） | 整个目录递归删除 |
| 子智能体会话日志（`origin: "subagent"` 的后代） | 一并删除 |
| 普通 fork（独立会话） | **保留** |
| 工作区归档集合 `archivedSessionIds` | 移除该 id |
| 工作区会话归属 `sessionIds` | 移除该 id（工作区保留） |
| 会话投影缓存 `session_projcache` | 删除该会话的检查点 |
| 附件（内容寻址的共享对象） | 不删除（可能被其它会话引用） |
| 其它会话对它的引用快照 | 不删除（引用时已写入对方日志） |

## 安全设计

删除是不可逆操作，宿主半侧做了这些约束：

- **只删已归档**：请求到达时重新读取工作区注册表的归档集合，不在集合里就拒绝（`409 not-archived`）。菜单是否显示不影响这条规则。
- **运行中的会话一票否决**：任一待删会话（含子智能体后代）的 Agent 还在跑（`status === "running"`）时拒绝（`409 session-active`），`force` 也不能绕过。
- **空闲但仍被持有**：会话自本次进程启动后被打开过时，DSH 会把空闲 Agent 留在内存并持有写锁；默认拒绝（`409 session-live`），只有第二次明确的 `force: true` 才删除磁盘记录，并在日志里留一条警告。
- **路径校验**：只接受与 JSONL 后端布局一致的定位——日志文件所在目录必须恰好以会话 id 命名，且必须是真实目录（不是符号链接）。不匹配就拒绝（`500 unsafe-layout`），不会递归删除更大的路径。
- **鉴权**：HTTP 路由复用 DSH 的 `connection.requestRejection()`，即 Host/Origin 栅栏 + 签名浏览器 Cookie 校验；跨站请求被 `403` 拒绝，未登录请求被 `401` 拒绝。缺少 `connection` 服务时**失败关闭**（也返回 401）。
- **请求约束**：只接受 `POST` + `application/json`，请求体上限 8 KiB，并拒绝非对象 JSON。

## 实现

```
dsh-session-delete/
├── cordis.patch.yml        # bundle 层：插入 host 行 dsh-session-delete
├── lib/index.js            # 宿主半侧：删除算法 + POST /dsh-session-delete/delete
├── lib/client.js           # 浏览器半侧：右键菜单项 + 确认对话框
├── locale/{zh,en}.json     # 插件管理页显示文案
└── test/                   # node:test 单测（删除算法、路由、浏览器注册）
```

- 宿主半侧是普通 Cordis 插件，注入 `webServer`、`sessionPersistence`、`workspaceRegistry`、`connection`。
- 浏览器半侧通过 `window.__ModuleLoader__.load({ id, factory })` 注册，向 `contextMenus` 注册 `target: "session"` 的贡献项，向 `shell.overlay` 注册确认框，向 `contextMenu.icon` 注册垃圾桶图标。
- 页面到宿主的调用走同源 `fetch`，路径按 `document.baseURI` 拼接，反代子路径部署也能用。

## 开发与测试

```bash
cd dsh-session-delete
npm test        # node --test test/*.test.mjs
```

单测覆盖：子智能体级联与 fork 保留、归档守卫、运行中/空闲 Agent 守卫与强制删除、恶意布局拒绝、真实目录删除、工作区/归档/缓存簿记、路由鉴权与错误映射、设置页面板与确认框状态。

> 以 `file:` 方式安装后，pnpm 会把包硬链接进 profile 的 `node_modules`；改完源码需要重新安装（`dsh plugin --profile web remove dsh-session-delete` 后重新 `add`，或直接修改 `node_modules/dsh-session-delete` 里的副本），浏览器端还要再刷新一次页面。

## 已知限制

- 只支持 JSONL 会话后端（DSH 默认后端）；其它持久化后端会被拒绝，而不是猜测删除方式。
- 会话从未落盘（进程内 pending）时无法删除，返回 `no-artifact`。
- 自本次 dsh web 启动后被打开过的会话会一直被空闲 Agent 持有写锁；删除这类会话需要「强制删除」（或先重启 dsh web）。强制删除后内存里的旧会话不会自动消失，建议刷新页面。
- 删除不清理 `session_projcache` 之外的其它派生数据；DSH 的会话查询索引是按需对账的派生索引，会在下次检索时自行收敛。
- 浏览器插件需要刷新页面才生效；桌面 Electron 壳体不走 Web 路由，本插件面向 Web GUI。

## 许可证

[MIT](LICENSE)