---
decision_status: accepted
realization_status: implemented
supersedes: []
superseded_by: []
tickets: [259]
---
# ADR 0009：Agent 运行机、执行机与会话 MCP 必须显式分离

- 状态：**已接受并实现**（2026-08-19）
- 适用范围：Runner 注册与调度、Sessions+ 新建会话、会话级 MCP 凭证、远程 Agent 工具暴露
- 交付记录：[Runner 放置与会话级 MCP](../deliveries/2026-08-19-runner-placement-and-session-mcp.md)

## 1. 结果

Octopus 的新会话现在有两个互不替代的物理位置：

- **Agent 运行机**（`runtimeDevice`）：宿主 Claude Code、Codex 或 OMP 进程；
- **执行机**（`executionDevice`）：解析已登记工作区，并实际执行命令和文件读写。

默认模式继续把两者放在同一 Runner。Sessions+ 的“进阶放置”才允许用户分别选择两台在线设备和执行机上的一个不透明 `workspace_id`。因此 `runner1` 可以只宿主 Claude/Codex/OMP，`val15` 可以没有 Agent 后端、只提供 shell 与工作区文件能力。

这不是把任意远程路径挂给 Agent。跨机放置只接受执行 Runner 已登记的工作区；真实路径由执行机本地解析，Agent 运行机只得到一个会话级 MCP 入口。

## 2. Runner 自发现与权威性

每个 Runner 进程启动时生成 `runner-inventory/v1` 快照并随注册帧提交，在线期间每五分钟重新探测并发送更新：

- 三个 Agent 后端分别探测可执行文件与版本；Codex 还单独探测登录状态，因此安装了 `codex exec-server` 但没有模型凭据的执行机不会被误报成 Agent 运行机；
- 后端声明能否安全分机。Claude 与 OMP 通过关闭内建工具实现；Codex 仅在版本至少为 `0.147.0`、具备 app-server environment/exec-server 协议时声明支持；
- 执行侧声明平台、架构、shell、workspace-files、已登记工作区数量和无模型凭据即可使用的 Codex exec-server；
- 快照不得包含 home、PATH、真实工作区路径、环境变量或凭据。

Gateway 对 schema、枚举、数量和字符串长度重新校验；未知或畸形 inventory 整体丢弃，不猜测能力。Sessions+ 投影只合并当前在线 Runner 的有界事实。一个设备未报告某项能力等于“未知/不可选”，不等于“允许”。

Inventory 以进程启动快照建立基线，并每五分钟在同一已认证连接上更新。Gateway 只接受完整合法的新快照；畸形更新不覆盖最后一次有效事实。安装或移除 CLI、修改 Runner 工作区注册表后不需要重连，Sessions+ 最迟在下一次刷新周期看到新资产。

## 3. 放置请求与校验链

View 只能提出：

- `runtime_device`；
- `device`（执行机）；
- `workspace_id`；
- CLI、模型、effort、权限档位和首条需求。

它不能提出 owner、credential、capability、MCP URL、token、真实执行路径或批准结论。

可信侧按以下顺序处理：

1. Session Plus binding 从当前投影重新解析运行机、执行机、工作区与后端；
2. 相同物理机沿用原有本地启动；不同机器必须同时满足“运行机后端可用且可分机”“执行机在线且有 shell/workspace-files”“工作区属于该执行机”；
3. capability Gate 审批包含两台设备和工作区 id 的精确请求；
4. Gate 允许后，dispatch preparer 才铸造会话执行凭证并把请求路由到 Agent 运行机；
5. 运行机重新校验远程模式与 provider/exec-server 条件；缺事实、版本过旧、凭据过期或原会话放置不匹配时失败关闭。

`runtimeDevice` 和 `executionDevice` 都进入启动 fingerprint；同一个请求 id 不能在不同物理边界上重放成另一次启动。

## 4. 会话级 MCP 凭证

跨机启动不复用用户的通用 MCP token。可信后端在 Gate 允许后为这次启动铸造单独的 `mcp_` 凭证；数据库只保存 hash，明文只存在于可信服务与每轮运行机代理的内存中。其 policy 固定绑定：

- owner；
- 初始 operation id；
- Agent 运行机；
- 执行机；
- `workspace_id`；
- 权限档位；
- `workspace` 工具组。

Runner 返回 provider session id 后，可信服务把 live scope 再绑定到 `(owner, runtimeDevice, provider, sessionId)`。同一会话的 `append_session`/`resume_session` 只有再次通过各自 Gate 后，dispatch preparer 才把同一个仍存活的 scope 交给运行机重建本轮通道。凭证最长存活 24 小时；过期、撤销或可信服务重启后没有 live scope，不能续跑为本地执行。

对应的 live scope 同时持有两个可撤销 grant：workspace-files grant 与独立的 execution-workspace command grant。执行工具仍为四个工作区工具和 `run_workspace_command`；文件根列表固定到选定执行机和 `workspace_id`，命令调用由服务端补入这两个值，模型不能改写。

2026-09-25（#665）补齐托管 Agent 的账号工具：可信启动及续轮签发的会话 policy 额外包含本地 Runner 桥共用的 `sessions`、`feishu`、`discussions` 分组。`tools/list` 和 `tools/call` 复用账号既有的 Session Hub / MCP 授权、飞书 OAuth 及逐用户特权白名单；使用发起会话的 owner，不能借用提供模型的运行机 owner。账号工具仍要求 live scope，scope 释放、撤销、到期或轮换时一并销毁派生权限和待审批请求。原有知识与科研工具保留各自独立授权。

按需签发的 DSH 执行凭证与本地桥的 workspace lease 不因这次对齐取得会话或飞书工具。旧凭证的持久 policy 保持原样；可信续轮/恢复轮换的新托管凭证采用当前工具目录。memory、skills、CRDT、Apps 和其他未包含的工具仍返回 `unknown_tool`。

`full_access` 只把这五项执行工具设为 auto-allow；`manual` 的命令与文件操作仍走现有 approval。飞书写入、特权操作及会话续发仍走各自原有审批，Agent 自身的权限档位不能扩大账号授权。

## 5. 凭据不得进入模型配置

后端将 token 交给 Agent 运行机，不直接交给 Claude/OMP/Codex provider：

1. Runner 为每一轮启动一个仅监听 loopback、路径不可猜的 `ScopedMcpProxy`；
2. provider 只看见无凭据的 `http://127.0.0.1:<port>/session/<nonce>/mcp`；
3. proxy 删除来路 Authorization，再向可信 MCP endpoint 注入会话 token；
4. provider 启动前必须经该路径完成 `initialize` 和受限 `tools/list` 探测；不能到达正确 scope 时失败关闭；
5. provider 的 MCP DELETE 在会话凭证模式下只关闭本轮 loopback transport，不撤销可续跑的 session scope；明确启动失败由 trusted dispatch 生命周期释放，TTL/账户撤销/服务关闭销毁全部 live grants；
6. 非 loopback 明文上游被拒绝，远端上游必须使用 HTTPS。

Claude SDK 在跨机模式下设置 `tools: []`，只注册 `octopus_execution` MCP server；OMP 使用 `--no-tools` 并读取 Runner 在隔离控制目录逐轮更新的 `.mcp.json`。两者的 cwd 都是 Runner 私有控制目录，不是执行工作区路径。

Codex 使用上游原生 environment 协议：运行机 app-server 通过仅 loopback 的 relay 连接执行机上的 `codex exec-server`，`environment/info` 返回的 target-native cwd 同时写入 thread cwd 与 `environments[].cwd`，shell/文件调用因此在执行机工作区发生。运行机使用持久但隔离的 `CODEX_HOME`：只复制 `auth.json`，不继承用户/项目 MCP、Apps、plugins、skills、prompts、instructions 或 config；每线程 config 关闭 Apps/plugins，MCP 列表只含 `octopus_execution`。同一 thread 续跑时重新建立 exec-server tunnel 和 loopback MCP。

Runner 在 launch journal 旁持久保存不含路径和凭据的 `(session id, provider, execution device, workspace id)` 放置记录。运行机或进程重启后可用可信服务仍存活的 scope 重建通道；若可信服务已重启、scope 过期或调用缺少凭据，Runner 根据该记录拒绝本地 fallback，绝不会把原本在 `val15` 的会话静默续跑到 `runner1`。

所有设备侧预启动失败都写入 launch journal，原 operation id 之后只重放同一失败，不会变成无证据的 `unknown`，也不会再次启动。后端重启后即使数据库 token 行尚未过期，也没有 live scope，调用失败关闭。

## 6. 拒绝的替代方案

- **把执行机路径传给 Agent 运行机**：路径只在执行机命名空间内有意义，还会泄露不必要的主机信息。
- **复用用户通用 MCP token**：其工具集合和生命周期都大于一条 Agent 会话，无法证明最小权限。
- **只靠 MCP 客户端配置隐藏工具**：客户端不是权限边界；`tools/list` 与 `tools/call` 必须在第一方服务端使用同一 policy 和 live scope 过滤。
- **用 prompt 要求 Codex 不调用本地 shell**：模型约定不能关闭 provider 内建工具。
- **自动选择一个“看起来可用”的离线或旧 inventory**：缺失事实不得提升为权限。

## 7. 后续兼容规则

新增 Agent 后端只有在 Runner 能证明其本地工具可完全禁用或原生重定向到所选执行环境、工作目录可隔离、且 MCP 配置不需要把凭据写入 provider 可见配置时，才可声明 `split_execution: true`。新增执行资产必须扩展 inventory schema 并同步做 Gateway 校验、投影裁剪、UI 解释和 trusted-side 校验；不得把自由格式 capability map 直接暴露给 View。
