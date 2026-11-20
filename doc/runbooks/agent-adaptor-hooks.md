# Claude Code / Codex Agent adaptor

> 2026-08-12。适用于设备上的 `@claude-bot/runner`。Runner 只向 Bot 建立原有 outbound WebSocket；新增控制端点仅绑定 `127.0.0.1`，不会开放公网 listener。PID、进程组、规范路径、transcript 路径和本机控制端点都不会投影到 Bot / Agent View。

## 一键安装

Runner 现在默认以 `RUNNER_AGENT_HOOKS=install` 启动，每次启动幂等安装 Session Plus 所需的 runtime integration：内容未变时不写文件、不留备份。普通 Agent 的跨 Runner MCP/prompt 是另一条默认关闭的设备策略，见 `doc/runner-local-agent-bridge.md`。手动检查或安装使用同一份常驻构建：

```bash
node /path/to/runner.js integrations install
node /path/to/runner.js integrations status
```

常驻启动的自动安装是 fail-open：遇到用户自有 launcher 或已有配置格式错误时记录警告并继续提供 Runner；显式 `integrations install` 则返回非零，便于分发工具报告冲突。

bundle 包含：

- Claude Code 与 Codex marker-owned lifecycle hooks；
- `~/.local/bin/octopus-codex`：显式选择共享 app-server 的 Codex TUI 启动器；
- 对已有用户配置的保留式合并、仅在确实修改文件时写 mode-0600 时间戳备份、临时文件 + rename 原子替换；
- Codex hook trust review 提示。

`RUNNER_AGENT_HOOKS=manual` 保持所有配置不变；`off` 在启动时移除 marker-owned hooks 与 `octopus-codex`（不影响按 `RUNNER_LOCAL_MCP` 管理的 MCP/prompt）。旧的 `hooks install|status|uninstall` 只管理 hooks，保留兼容。完整卸载使用：

```bash
node /path/to/runner.js integrations uninstall
```

`octopus-runner stop`、restart 与 Runner 自更新交接不修改任何集成：hooks、`octopus-codex`、全局 MCP/prompt 和 `octopus-runner-mcp` 保持原样。Runner 停止期间 hook 报告器连不上本机 socket 即静默退出（Codex Stop 仍输出 `{}`），`octopus-codex` 回落到普通本机 CLI，MCP 服务立即只列出固定工具、调用时报告 Runner 不可用。只有 `octopus-runner uninstall`（或上面的 `integrations uninstall`）执行 marker-owned 清理，覆盖 Runner 写过 hooks 的每个 Codex 账号 home。用户自己的 hooks、MCP 条目、workspace Agent 文档和 workspace-scoped MCP 配置不在清理集合内。

安装器从不覆盖不带 Octopus marker 的 `octopus-codex`。Codex 首次加载用户 hooks 时仍需要用户在 `/hooks` 中核对并信任命令。

## 状态模型

`control_mode` 仅保留为旧客户端兼容别名。路由只读取以下四个相互独立的事实：

- provider session：Claude / Codex 的持久 session id；
- attachment：`hook_observer`、`terminal_tmux`、`claude_sdk`、`codex_app_server`、`legacy_exec` 或 `none`；
- control lease：当前语义 writer 是 `terminal`、`protocol` 或无人持有；
- turn / interaction：当前轮次状态，以及单次提问或权限请求。

公开能力由这些事实推导，不由一个“模式字符串”反向猜测。

## 用户可见能力矩阵

| 当前 attachment | 普通发送 | 中途追加 | 原生停止 | 显式“交给 Octopus 托管” |
|---|---|---|---|---|
| 无活动 CLI / idle session | Claude Agent SDK resume；Codex app-server resume | 当前托管轮次内使用 native steer | SDK/app-server interrupt | 不显示 |
| 普通外部 CLI，且精确落在唯一可写 tmux pane | 用 `tmux load-buffer` + `paste-buffer` 发送，终端继续持有 lease | 同一路由；不另起 headless writer | 不承诺 | 可选；精确结束 CLI 后 native resume |
| 外部 CLI，仅有 hook 证据或 pane 不唯一 | 拒绝，提示回 CLI 输入 | 不承诺 | 不承诺 | 可选；仅精确进程身份成立时显示 |
| `octopus-codex` TUI | 同一 app-server thread 空闲时 `turn/start`、活动时 `turn/steer`；协议失败才退回安全 tmux | native `turn/steer` | Runner 已附着该 turn 时可显式 native interrupt；TUI 保持终端 lease | 可选 |
| Octopus 托管轮次 | `priority: now`（Claude）或 `turn/steer`（Codex） | native steer | 显示“停止当前托管轮次” | 不显示 |
| hook 缺失 / 失效 | transcript-only 兼容；idle 时仍可 native resume | 不猜进程或 pane | 不显示 | 不显示 |

普通发送永远不会因为网页出现就杀掉用户的 CLI。接管是独立、human-only 的 `takeover_session` 意图：审批参数冻结 `takeover:true` 后，Runner 才对同一 `(pid, /proc starttime, boot id)` 依次执行 SIGINT、短等待、SIGTERM，等待 transcript 稳定，再用 provider-native transport resume。它不会按进程名扫描，也不会自动 SIGKILL；原轮次已经产生的副作用不会回滚。

tmux 只承担文本输入，不承担 provider 状态机：必须能从精确 CLI PID 的 `/proc/<pid>/fd/0` 证明唯一 pane，且 pane 不能处于 copy mode、dead 或 ambiguous。Claude Code 还要求输入框就绪：粘贴前读 tmux 的光标可见性、位置与光标所在行，只有光标可见、该行以 `❯`（旧版 `│ >`）开头、光标紧跟提示符且其后只有空白或灰色占位提示时才写入；选择框、面板、确认对话框（会隐藏光标）或输入框里已有未发出的文字时，以 `terminal_composer_busy` 拒绝且一个字节都不写，属于“未发送”，可以安全重试。文本通过 stdin 装入 tmux buffer，不拼接 shell 命令。粘贴与 `C-m` 提交之间留出 TUI 消化窗口；发送后最多等待约 2.5 秒，只有同一 pane 出现可见变化才报告成功。超时属于“无法确认”而非可安全重试的失败：网页会建议回本机 CLI 核对，或确认未执行后显式接管，Runner 不自动重发。

## 托管 transport

### Claude Code

Runner 保持一个官方 Agent SDK streaming `Query` 直至当前 turn 结束：首条消息以 `next` 进入；活动轮次的后续消息以 `now` steer；停止按钮调用 SDK `interrupt()`。轮次完成后 attachment 关闭，因此用户仍可回到 CLI 对同一 session 继续工作。

`canUseTool` 将 `AskUserQuestion` 与未被 Claude 自身规则预先允许的工具权限投到同一张 provider-neutral 网页卡。SDK 使用用户 PATH 中的 `claude`，环境变量会完整继承。续写没有 `claude -p` 回退：托管通道在取得 prompt 前失败时报告一次明确失败，取得 prompt 之后的错误保持结果未知，都不重放。

### Codex

Runner 常驻一个 `codex app-server --listen ws://127.0.0.1:0`，并使用 `thread/start|resume`、`turn/start|steer|interrupt`。它支持 `request_user_input`、命令执行审批、文件修改审批和追加权限审批；允许只作用于当前 turn。

动态端点只写入私有 endpoint 文件；`octopus-codex` 会同时验证记录的 PID 仍存在且 URL 是 `ws://127.0.0.1:*`，再执行 `codex --remote`。普通 `codex` 不会被冒充成共享协议客户端。当前发布版 CLI 的 Unix transport 与主分支文档存在握手差异，因此这里选择已经实测可用的 loopback WebSocket；不是公网监听。

续写没有 `codex exec resume` 回退：托管通道在 `turn/start` 前失败（例如线程已有其他 writer）时报告一次明确失败；`turn/start` 发出后即使响应丢失也不重放，避免重复 provider work。

## 提问、权限与收据

- 外部 Claude TUI：会话被网页观察时，`AskUserQuestion` / `PermissionRequest` 可由同步 hook 暂停并显示；无观察租约时立即 fail-open 回本机 TUI。
- 托管 Claude / Codex：交互由 SDK / app-server 的双向协议承载，不依赖 CLI 屏幕抓取。
- 回答只接受本人真实网页登录会话；interaction id 单次消费。
- pending interaction 解决后会持久化一条紧凑收据。普通答案只保留摘要；secret answer 永不落盘，只显示“已提交私密回答”。Runner 重启或页面重载后卡片仍保持折叠状态。

## 本机文件与网络

- hook socket：优先 `$XDG_RUNTIME_DIR/octopus-runner/hooks.sock`，否则使用当前 uid 专属的 mode-0700 临时目录；socket 为 `0600`。
- Codex endpoint 文件：同一私有运行目录中的 `codex-app-server.endpoint`，mode `0600`，内容为 owned app-server PID 与 loopback URL。
- 观测状态：`~/.octopus/agent-runtime.json`；交互收据：`~/.octopus/agent-interactions.json`；两者均为私有本机状态。
- 网络：新增 Codex listener 由 OS 选择动态端口且只绑定 `127.0.0.1`；不使用公开演示端口，也不改变 Runner 到 Bot 的 outbound 连接。

精确进程和 tmux 关联依赖 Linux `/proc`。macOS 会诚实退化为 hook 观测；Windows 保留原有扫描/resume，不启动当前 Unix hook IPC。

## 排障

1. `integrations status` 应显示 Claude / Codex hooks 与 `octopus-codex` launcher。
2. 在两个 CLI 的 `/hooks` 核对 Runner 构建路径与 trust 状态；确认 Runner 与 CLI 属于同一 OS 用户。
3. `command -v octopus-codex` 应命中 `~/.local/bin/octopus-codex`；启动时若共享端点不可用，它会明确提示并安全回退到普通 `codex`。
4. 外部 CLI 的普通发送若被拒，检查它是否位于独占 tmux window/pane；Runner 不会对裸终端或歧义 pane 注入按键。
5. Claude 托管结果应报告 `agent-sdk`，Codex 应报告 `app-server`；已取得 prompt 所有权后的错误不会触发旧 CLI 重放。
6. 页面仍显示已回答卡片时，检查 roster 投影里的 interaction 是否为 `status=resolved`；新版 Runner 会把这条收据跨重启保存。
