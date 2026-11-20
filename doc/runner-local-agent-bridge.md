# Runner 本地 Agent 桥

> **现行。** 说明 Codex、Claude Code、OMP 如何经本机 Runner 的稳定反向长连操作同一 Octopus 用户的其他 Runner。

## 正常使用路线

1. 每台机器以对应 OS 用户运行一个常驻 Runner。Runner 只向 Octopus Gateway 建立出站 WebSocket，不要求两台机器能互相 SSH 或直连。
2. 完整模式 Runner 自更新到支持 `runner-local-mcp/v1` 的版本后，会在该 OS 用户的私有目录创建 mode-0600 Unix socket，并安装可发现的 `~/.local/bin/octopus-runner-mcp` launcher。`octopus-runner-mcp discover` 会输出 Codex、Claude、OMP 共用的标准 STDIO descriptor，但不写任何客户端配置；新安装默认**不**修改三者的用户级 MCP 或 prompt。`RUNNER_EXECUTION_ONLY=1` 的目标专用 Runner 连 socket/launcher 也不启动或上报。
3. `RUNNER_LOCAL_MCP=managed`（默认）由 Dashboard 的设备级“普通 Agent 默认注入”开关决定是否向已安装 CLI 注册名为 `octopus` 的 STDIO MCP，并追加 marker-owned 路由提示。新设备及从旧版本升级的设备均默认关闭。
4. 用户用真实浏览器会话打开 Dashboard 总览，在自己的 Runner 行分别设置两件事：是否给普通 Agent 默认注入，以及调用桥后的“禁用”“每次审批”“完全授权”档位。两者都不需要重装 Runner 或重签 token。
5. 获得工具的本地 Agent 遇到明确的远端环境需求时，先调用 `octopus_list_execution_targets`，再使用返回的精确 `device` 和 `workspace_id` 调用文件或命令工具。需要联系独立或历史 Agent 会话时，使用 `list_recent_sessions` / `search_sessions` 取得不透明 `resource_id`，再 `read_session` 或 `send_session_message`；续发由账号所有者逐次批准，`approval_required` 或不确定结果不得自动重试。

会话工具与三个客户端自己的 subagent 工具不是替代关系：当前 Codex/Claude/OMP 父会话创建、列出或联系自己的原生子 Agent 时继续使用 provider-native 工具。Octopus 会话工具只处理持久化的外部/跨 Runner 会话；列表若返回 `input_mode=parent_owned`，只能联系其精确 `parent_resource_id`，不得向子会话猜测输入或静默转发。

注入 prompt 与 MCP server instructions 都把 Octopus 描述为可选通道，不会覆盖用户明确指定的 transport。用户要求裸 SSH 或其他可用通道时应照其选择执行；所选通道不可用时应如实说明，只把 Octopus 作为备选，不得静默替换或坚持改走 Octopus。只有实际选择 `octopus_*` 后，才要求先列 targets、使用精确 `device/workspace_id` 并遵守审批。

链路为：

```text
Codex / Claude / OMP
  → STDIO MCP 子进程（无设备 key）
  → 本 OS 用户的 mode-0600 Unix socket
  → 常驻 Runner 已认证 WebSocket
  → Octopus Gateway（从连接派生用户与发起设备）
  → 同用户目标 Runner
  → 目标 Runner 已登记 workspace
```

## Runner 文件互传

`octopus_copy_file` 支持远端→本机、本机→远端、远端→远端的异步二进制复制；
`octopus_get_file_transfer` 查询进度，`octopus_cancel_file_transfer` 取消。
目标发现额外返回当前 Runner 的 `local_target`；省略目标设备时复制到它的指定 workspace。
文件总大小与总时长不限，内存按 1 MiB 数据块使用；默认不覆盖已有文件。
完整参数、审批、摘要覆盖与失败语义见 [Runner 文件互传](./runner-file-transfer.md)。

## 三档权限

| 模式 | 行为 |
|---|---|
| `disabled` | 不列目标、不建立租约、不执行；默认值 |
| `manual` | 允许发现目标和只读浏览；写文件与运行命令进入现有 Octopus 待批准队列 |
| `full_access` | 在选定的远端 workspace 内自动允许桥接提供的读、写、命令工具 |

模式是发起 Runner 的设备策略，不是目标 Runner 的策略。典型配置是 AWS 开发机 `full_access`，`lht-val15-ci` 保持 `disabled`；后者仍能作为被操作的执行目标。

Dashboard 展示三个不同事实：是否默认注入、持久化的授权模式、在线 Runner 报告的本机 MCP/CLI 注册状态。设置不把“不支持该协议的旧 Runner”伪装成已可用；Runner 升级并重连后状态会刷新。

## 会话生命周期与自动恢复

Workspace 执行权限由已认证连接和本地 MCP 客户端共同持有，不再借用浏览器的
15 分钟 Context 池，也不再为这个进程内作用域签发 24 小时 bearer。用户无需续签。
每次调用仍经过 capability Gate；Dashboard 模式、设备身份、目标 workspace 都是权限边界。
发起端断连、客户端退出、关闭桥或撤销相关设备时立即释放。普通操作被拒绝不会撤销整个会话。
真正发给外部客户端的 MCP bearer 仍保留原有的有界有效期。

MCP STDIO 进程在 resident 重启后会自行重连；Gateway 重启后会重新建立绑定相同目标与
workspace 的作用域。并发首次调用共用一次 open。服务端在命令派发前明确返回
`lease_missing` / `lease_expired` 时，桥最多自动重建一次；旧 ID 不会跨连接复活。
权限变化会拒绝正在打开的旧会话，即使档位随后改回，也不能发布那次未完成的授权。

已发出的命令如果回包丢失，仍报告结果不确定，不自动重放。审批请求不会通过重连
得到自动批准；Mac GUI 的本机 15 分钟同意也不自动续期。升级前已经运行的旧版 MCP
子进程需重载一次，之后才具有这些恢复行为。

设备重新登记只撤销其设备分支及覆盖整个设备集合的旧授权。CI/会话等精确绑定其他
设备的分支继续有效，包括尚待批准的调用。该限制保存在持久权限根上，子授权不能
靠修改 Context metadata 改选设备；账号整体撤销仍覆盖全部分支。

## macOS GUI 自动化

GUI 自动化是独立的目标机能力，不继承 `manual` / `full_access` 的 workspace 权限，也不把 Dashboard 开关当成一次远程操作授权。总览只在在线 Runner 确认自己是当前登录用户拥有的 macOS 图形会话、允许机器操作并具备系统截图工具时显示“允许 Agent 发现并请求操作此 Mac”。打开后仅发生两件事：服务端保存默认关闭的设备策略，并把该 Mac 加入同账号本地 MCP 的目标列表；屏幕内容和输入权限仍然没有被授予。

一次实际操作必须沿下面的链路进行：

1. 发起 Agent 所在 Runner 已启用本地 Agent 桥，并把 `octopus` MCP 接给该 Agent；目标 Mac 与发起 Runner 必须是同一 Octopus 用户的两台不同设备。
2. Agent 先调用 `octopus_list_execution_targets`，从返回的精确 `device` 选择带 `gui_automation` 的目标。GUI-only 目标可以没有 workspace，也不因此取得 shell 或文件权限。
3. 只有用户明确要求操作目标 Mac 后，Agent 才调用 `octopus_request_gui_control`。服务端不使用 Dashboard 审批兜底；目标 Mac 本机弹出原生对话框，用户可拒绝、等待超时或同意未来最多 15 分钟。
4. 同意后，目标 Mac 桌面右上角持续显示一个小型悬浮停止面板。用户点击“立即终止远程操作”、15 分钟到期、发起 MCP 退出、任一 Runner/Gateway 连接断开、Runner 停止或总览关闭开关，都会使租约失效并撤下浮层。
5. Agent 用 `octopus_capture_screen` 取得主屏幕 JPEG 和左上角原点的图像坐标，再使用 `octopus_gui_click`、`octopus_gui_scroll`、`octopus_gui_drag`、`octopus_gui_type_text` 或 `octopus_gui_key_press`。每次坐标动作都会消费上一张截图，下一次坐标动作必须先重新截图；执行结果不确定时不得自动重试。完成后应主动调用 `octopus_release_gui_control`。

目标 Runner 只接受服务端持有的不透明 `grant_id`；该 id 不进入 Agent 的 MCP 参数、目标枚举或 Dashboard。能力使用独立的 `runner_gui_automation` slot 和精确目标设备 scope，不扩大既有 Runner account、workspace 或跨用户边界。首版只处理主显示器和 macOS；Windows、Linux、多显示器及同一 Runner 自操作均不在当前范围。

## workspace 局部发现与手动注册

默认关闭只约束 Runner 管理的**用户级**配置，不禁止项目自己声明能力。需要远端操作的单个 workspace 可以：

0. 先运行 `octopus-runner-mcp discover` 取得当前 OS 用户的绝对 launcher 路径和 provider-neutral STDIO descriptor；现有客户端若不支持 MCP hot reload，需要按输出明确重载，不能把“配置已写”说成“当前会话已接入”。

1. 在该 CLI 支持的 workspace-scoped MCP 配置（例如 Claude Code 的项目 `.mcp.json`）中，把 `octopus` STDIO server 的 command 指向当前用户的绝对路径 `~/.local/bin/octopus-runner-mcp`；
2. 在 workspace 自己的 `AGENTS.md`、`CLAUDE.md` 或等价 Agent 指令里写入本页开头的路由约束：先列目标，只使用返回的精确 `device` / `workspace_id`，不猜目标、不绕过审批；
3. 保持 Dashboard 的授权档位为所需的 `manual` 或 `full_access`。局部注册只让工具可发现，不替代服务端策略。

Runner 的 managed reconcile 和显式卸载清理只触碰用户 Home 下列出的 marker-owned 全局文件，不扫描或改写 workspace，因此局部 MCP 配置和 Agent 文档会原样保留。工单 Agent/Session Plus 的可信启动链路也继续按会话单独挂载自己的 MCP 与 prompt，不依赖普通 Agent 的默认注入开关。

## 权限与多用户边界

- Runner token 只证明设备身份。设备策略另表保存，因此 Runner 自更新和 token 轮换不会把旧 token 静默升级为跨设备发起权限，也不会清掉用户已明确设置的模式。
- Gateway 完全忽略消息体里的 owner/runtime identity；它只使用已经认证的 Runner WebSocket 所绑定的 `(username, device)`。
- 每个租约同时绑定到已认证 WebSocket 和发起它的本地 Unix-socket 客户端。STDIO 正常关闭会等待租约释放；本地 Agent 崩溃、被终止或与 `open` 回包竞态断开时，常驻 Runner 也会代为关闭。连接断开、token 撤销或策略变化同样清空租约；租约跨连接、跨设备、跨用户都不能复用。
- STDIO 子进程和 CLI 配置里没有 `rt_` 或内部 `mcp_`。连接作用域只有 Bot 进程内的 principal，不创建可传递的 bearer。
- 单机多用户必须各自以普通 OS 用户运行 Runner。socket 父目录是 0700、socket 是 0600；不得用 root Runner 扫描或代管多个 home，也不得把 socket 放进共享目录。
- 所有文件工具都绑定到目标 Runner 已登记的 workspace；相对路径不接受绝对路径或 `..`。写入使用读取返回的 digest 做 compare-and-swap。

当前的访问控制器是明确的 **owner-only** 策略：Gateway 只交给它“已认证的发起用户/设备”和“不可信的目标设备/workspace 选择”，默认控制器只从发起用户自己的设备集合枚举并签发作用域。协议消息里的 `owner`、`target_owner` 等附加字段会被丢弃。

Agent 会话的共享所有权不通过这个设备目标控制器猜测。Sessions+ 跨 owner 启动时，Host 已持久化调用者 owner、运行机 owner、精确 provider session 与 placement：调用者从自己的选择性 catalog 看见并操作该会话，运行机 owner 从自己的本机 provider roster 看见同一会话。MCP 只消费这份既有正向证据；授权撤销后 catalog 读写随即拒绝，不接受客户端提交 owner 或另一台机器的会话路径。

未来若增加受限的跨用户 Runner 委派，应替换这一服务端访问控制器，用持久化关系、目标用户同意、操作/工作区范围和期限共同解析可见目标；不能把客户端声明的用户名当成授权。这样扩展可以改变策略和目标解析，但无需放宽 Gateway 的认证主体边界、连接级租约或 capability Gate。

## lht-val15-ci 的环境含义

当前 `lht-val15-ci` Runner 来自 val15 上的 Octopus CI rootless Docker 环境；它报告并执行的是容器内已登记的 `/work` 工作区，而不是不受约束的物理机 root shell。Runner 名是设备身份，不是“物理机”保证。若以后把同名 token/Runner 移到宿主机，Dashboard 名称不会自动表达这一变化，应使用新的设备名或在运维记录中明确迁移。

AWS ↔ val15 的直接 SSH 和 Runner WSS 故障不是同一条链路。现有 PMTU 事件与缓解见 `~/infra/doc/aws-val15-network-incident-2026-08-22.md`；本桥仍依赖 val15 → Octopus 的 Runner WebSocket 在线，但不依赖 AWS → val15 SSH。

## 配置与排错

- 默认设备策略托管：`RUNNER_LOCAL_MCP=managed`；启动只刷新 launcher、保持现有全局 MCP/prompt 注入不动，连接 Gateway 后按设备开关幂等收敛（内容不变不写文件）。
- 明确的本机 always-on 覆盖：`RUNNER_LOCAL_MCP=install`。这会忽略 Dashboard 默认注入开关，只应在机器所有者有意管理服务环境时使用。
- 保留现有 CLI 配置不动：`RUNNER_LOCAL_MCP=manual`；主动移除 Octopus 全局注入：`off`。
- 已安装 Runner 的常规检查：`octopus-runner status`、`octopus-runner doctor`；完整命令和服务排错见 `doc/runbooks/runner-installation.md`。
- integrations 的低层手动重跑仍可使用托管 bundle：`node ~/.octopus/runner/standalone.js integrations install|status`。
- 本地 MCP launcher：`~/.local/bin/octopus-runner-mcp`。
- 显式发现（只读、不改配置）：`octopus-runner-mcp discover` 或 `octopus-runner-mcp --help`。
- socket：`~/.octopus/runner/local-agent-bridge.sock`；可用 `RUNNER_LOCAL_MCP_SOCKET` 为该 OS 用户改位置。
- 若工具报告 Runner offline，先看本机 Runner 是否已注册；若工具报告未授权，到 Dashboard 总览修改该发起设备的模式；若 Dashboard 显示旧版本不支持，等待自更新并重连或手动升级。
- 若工具报告 lease capacity reached，错误会列出占用槽位的 workspace/GUI 类型、目标设备、workspace id、发起端 MCP 客户端连接、其上报 PID、租约年龄、空闲时间和最近工具。关闭发起 Runner 上不再使用的 Codex/Claude/OMP 会话或对应 `octopus-runner-mcp` 子进程即可触发自动回收；重启被操作的目标 Runner 不会释放这些发起端槽位。workspace 与 GUI 分别限流，workspace 最多 32 条，GUI 最多 8 条。
- 若 macOS Runner 行没有 GUI 自动化开关，确认 Runner 由当前已登录桌面用户的 LaunchAgent 运行、未设置 `RUNNER_EXECUTION_ONLY=1` 或 `RUNNER_ALLOW_MACHINE_OPS=0`，并已升级到报告 `runner-macos-gui/v1` 的 bundle。系统“屏幕录制”和“辅助功能”权限的设置与验收见安装 runbook。
- 自动安装遇到同名但非 Octopus 所有的 MCP 配置或 launcher 时会拒绝覆盖并让 Runner 继续在线，日志会给出冲突路径。
- `octopus-runner stop`、正常重启与自更新交接不修改 hooks、MCP、路由 prompt 与两个 launcher。Runner 停止期间 MCP 立即只列出固定工具，调用时报告 Runner 不可用；只有 `octopus-runner uninstall` 撤销这些 marker-owned 内容。workspace 局部配置不在清理范围内。
