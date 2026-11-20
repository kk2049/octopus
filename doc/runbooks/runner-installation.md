# Runner 安装、服务与 workspace 运维

> **现行。** 适用于 macOS 当前用户 LaunchAgent、使用 systemd user manager 的 Linux，以及 Windows 当前用户计划任务。

## 第一次安装

在 Dashboard 总览的“接入章鱼端点”选择目标平台，填写设备名并签发；也可以在飞书私聊发送 `/runner-token <设备名>`，Windows 使用 `/runner-token <设备名> windows`。复制返回的短命令到目标机器执行：macOS/Linux 用 shell，Windows 用 PowerShell。

安装流程会：

1. 通过 HTTPS 下载公开安装器、Runner bundle 和 SHA-256 摘要，校验摘要与 JavaScript 语法；
2. 兑换十分钟有效且只能使用一次的 enrollment；永久 `rt_` 设备凭据只写入目标机器的受限文件（Unix mode-0600、Windows protected ACL），不进入浏览器、聊天或命令历史；
3. 安装 bundle、配置和日志目录到 `~/.octopus/runner/`，安装命令到 `~/.local/bin/octopus-runner`（Windows 为 `octopus-runner.cmd`）；
4. macOS 注册当前用户 LaunchAgent；Linux 注册并启动 systemd user service；Windows 注册当前用户、`Limited` 权限的登录自启计划任务；
5. 等待 Gateway 报告设备在线，再给出真实结果。

macOS/Linux 目标机需要 Node.js 20 或更高版本、`curl`，Linux 还需要可用的 systemd user manager。Unix 安装器不使用 `sudo`，也不自动安装或升级系统 Node.js。Linux 若要求用户注销后仍常驻，可在手工安装参数中使用 `--linger`；这可能触发管理员授权，默认不开启。

Windows 安装器需要 PowerShell 5.1 或更高版本，并使用 Git Bash 提供与其他平台一致的 shell 语义；缺少 Node.js 22 或 Git for Windows 时会通过 `winget` 安装。通常在普通 PowerShell 中运行；只有目标机的 winget/软件策略要求时，才按明确错误提示以管理员身份重试。安装器不启用 WSL。Windows Runner 继续固定为仅执行环境：提供 shell、文件与 workspace，不扫描 session、不启动 Agent/Codex/DSH/知识索引能力。

安装会把 `~/.local/bin` 加入当前用户后续终端的 PATH：Unix 幂等维护 `~/.zprofile`（macOS zsh）或 `~/.profile` 中的一段自有 marker；Windows 修改当前用户的 PATH 环境变量。当前终端若还找不到命令，打开一个新终端，或先执行绝对路径（Windows：`%USERPROFILE%\.local\bin\octopus-runner.cmd`）。

首次安装时同时登记目录：

```sh
sh /tmp/octopus-runner-install.sh \
  --server https://bot.example.com \
  --enroll re_... \
  --workspace /absolute/project/path
```

Windows 可下载 Dashboard 返回的 `.ps1` 后传入 `-Workspace 'C:\absolute\project'`；日常更推荐安装完成后运行：

```powershell
octopus-runner workspace add "C:\Users\alice\project" --label project
```

## 命令表

| 命令 | 行为 |
|---|---|
| `octopus-runner status [--json]` | 显示服务状态、Gateway 在线状态、设备、扫描根和版本 |
| `octopus-runner start` | 启动已安装的用户服务 |
| `octopus-runner stop` | 停止服务；Agent hooks/MCP/prompt/launcher 保持安装（Runner 停止期间静默失效），不删除安装配置或 workspace 登记 |
| `octopus-runner restart` | 重启用户服务；完整模式下 Runner 管理的 Agent 会话保留恢复标记，Windows 仅执行模式不启动 Agent |
| `octopus-runner logs [-f] [-n 200]` | 仅排查旧日志；新版常驻 Runner 不保存操作或运行输出 |
| `octopus-runner logs --clear` | 清空固定的旧 Runner 日志；返回清理字节数与失败路径，不读取内容 |
| `octopus-runner doctor` | 检查配置、权限、服务自启/恢复配置、Gateway 和每个 workspace 的当前可访问性 |
| `octopus-runner agents list [--json]` | macOS/Linux 本机查看 Agent 候选、选中入口、解释器、版本和失效原因 |
| `octopus-runner agents bind <claude\|codex\|omp> <绝对路径> [--interpreter <绝对路径>]` | 本机显式绑定一个安装；后续启动读取，无需重启 |
| `octopus-runner agents unbind <claude\|codex\|omp>` | 取消显式绑定，恢复自动选择 |
| `octopus-runner agents exec <claude\|codex\|omp> [CLI 参数…]` | 在本机以注册表选中的程序执行；opt-in Codex 启动器复用此入口 |
| `octopus-runner update` | 鉴权下载、强制校验摘要和语法、原子替换并重启；启动失败自动回滚上一 bundle |
| `octopus-runner workspace list [--json]` | 列出登记、稳定的 `workspace_id`、本机路径及可用状态 |
| `octopus-runner workspace add <目录> [--label <名称>]` | 以 realpath 登记一个现存目录；旧写法 `<目录> <名称>` 仍兼容 |
| `octopus-runner workspace remove <workspace_id>` | 撤销此目录的后续 workspace 文件/命令权限，不删除目录 |
| `octopus-runner workspace rename <workspace_id> <名称>` | 修改展示名称，不改变 id 或根目录 |
| `octopus-runner enroll --server <url> --enroll <code>` | 用新的一次性 enrollment 替换设备登记并重启 |
| `octopus-runner config show` | 显示非秘密安装配置；不会打印 token |
| `octopus-runner version` | 显示当前 bundle 内容摘要前缀 |
| `octopus-runner uninstall [--force]` | 先向服务器撤销设备凭据，再移除服务、CLI、适用的 Agent 集成和安装目录 |
| `octopus-runner help` | 显示内置帮助 |

`run --foreground` 是排错入口：先 `stop`，再在当前终端运行 `octopus-runner run --foreground`，避免两个进程使用同一设备凭据同时连接。

macOS/Linux 的后台 Runner 使用本机 Agent 可执行文件注册表。启动和每分钟资产盘点会检查已知安装位置；每次新建进程还会复核入口、真实目标与解释器。已知位置包括旧 `agent_path`、服务启动时的绝对 PATH 目录、`~/.local/bin`、`~/bin`、`/usr/local/bin`、`/usr/bin`、macOS 的 `/opt/homebrew/bin`，以及 `~/.nvm/versions/node/<版本>/bin`。不会执行 shell 初始化文件、调用包管理器或递归扫描 home/workspace。

默认选择顺序是：本机显式绑定；服务 PATH（含已捕获的 `agent_path`）中第一个通过信任检查的安装，即终端按同一 PATH 会运行的程序；PATH 中没有可用安装时，上次仍有效的自动选择；唯一可消歧的安装。每次操作都重新按 PATH 解析，PATH 前面新装或移除的程序在下一次操作生效，自动选择缓存不会压过 PATH 顺序。nvm 的 `alias/default` 可声明确切版本、数字版本前缀、`node`/`stable` 或有限的别名链；按该声明解析，不根据文件修改时间推测版本。复杂别名（如 `lts/*`）、自定义 nvm 根及其它版本管理器的动态 shim 需要显式绑定。多个独立安装无法消歧时显示 `multiple_installations`，不会自动选择版本最高的副本。

显式绑定保存在 `~/.octopus/runner/agent-bindings.json`，自动选择缓存保存在同目录的 `agent-selections.json`，两者均仅限本机用户读写。常规升级可跟随已选入口的安全软链接或 nvm 已声明 default；PATH 之外发现的新的无关安装不会覆盖原选择。绑定或旧选择失效时报告原因，不悄悄切到另一份程序。自定义位置示例：

```sh
octopus-runner agents list
octopus-runner agents bind codex /absolute/custom/bin/codex
octopus-runner agents bind claude /absolute/claude-cli.js --interpreter /absolute/node
octopus-runner doctor
```

macOS 的 `/opt/homebrew` 与 `/usr/local` 内，当前用户或 root 所有、内置 `admin` 组（gid 80）可写的目录属于支持布局，包括 `bin`、`Cellar`、`Caskroom`。这项兼容只适用于目录，不放行组可写的程序文件、其它组、其它所有者、前缀外祖先或世界可写路径；软链接的真实目标和解释器仍分别检查。不要为让 Runner 通过而修改 Homebrew 的目录权限。

普通 `agents bind` 只选择安装，不增加信任。确实需要使用其它本机共享安装时，可用 `agents bind codex /absolute/shared/codex --trust-installation` 明确接受该安装目前的所有者与组成员可替换程序。例外只记录此次检查的确切路径、uid/gid 和可写位；移到另一位置或这些属性变化后重新检查，失效不自动换安装。该选项不允许世界可写路径，不授予远端会话/文件权限，不影响注册表文件的私有保护。旧绑定没有例外，不会被升级为更宽授权。

`agents list` 的失败候选包含本机 `detail`（检查阶段、触发路径、uid/gid、mode 和规则）。不可用的后端在资产中上报闭集 `diagnostic_code`，以及触发拒绝的那一个路径和规则（`diagnostic_detail`，如 `group_writable`）；网页在“Agent 后端不可用”与 Sessions+ 启动拒绝旁显示它们，只给设备主人，共享来源的申请者只看到诊断码和规则。uid/gid、mode 与候选列表仍只在本机。旧服务忽略新字段并继续使用 v1 的 `probe_failed` 等兼容分类。程序缺失、策略拒绝、解释器缺失、绑定失效与未登录是不同状态。

遇到 `unsafe_permissions` 时，`agents list` 还会输出本机 `recovery`，说明检查原因及有条件的修复命令。已登录不代表安装路径可信：Runner 以当前用户身份执行 CLI，其程序、解释器或上级目录可被其他用户替换，会影响登录凭据和工作区。`0775` 可能是有意的共享安装，不能仅凭权限值要求所有人一律修改。

- 本人拥有的个人安装：确认无需保留组写权限后，仅对 `detail.path` 指出的路径移除相应写权限；提示会对路径作 shell 引用。不使用递归 `chmod`，也不修改系统或他人目录。重新检查可能发现下一个需要处理的路径。
- 确需共享的安装：设备主人核对所有者和组成员后，按上面的 `--trust-installation` 流程显式绑定；程序可能被这些人替换。世界可写路径和注册表元数据不能使用此例外。
- 修复后再次运行 `octopus-runner agents list`，确认检测通过；等待下一次资产上报（约一分钟），刷新网页设备资产后再创建会话。程序发现、账号登录和远端资源授权仍分别检查。

脚本的解释器进入同一启动方案。nvm 的 Node 脚本必须有同一版本目录内的 Node，不用不相关的系统 Node 代替。程序探测和启动使用一致的路径；登录状态仍由实际账号环境检查，注册表不存凭据、不切换账号。旧 `agent_path` 字段及本机生命周期捕获保留用于兼容/回滚，常见安装的发现不再要求用户打开终端并手动 restart。

`doctor` 在**后台配置环境**中显示资产状态，`agents list` 展示完整本机路径、解释器和候选原因；这些本机诊断不等于正在运行的服务进程快照。页面接收版本、有界状态，以及不可用安装的诊断码与触发路径。缺少可选 Agent 不令单纯执行环境的健康检查失败。Windows 或显式仅执行模式不扫描、探测或持久化 Agent 注册表。

热更新只影响后续进程，不中断已运行的 Agent。私有共享 Codex app-server 在所有托管连接释放后、下一次使用时采用新程序；供外部 TUI 使用的公共本机 host 无法证明所有外部使用者已释放，因此保留现有进程直到自然退出或正常服务生命周期结束。注册表不授予会话接管权限，缺少精确进程绑定的旧会话仍拒绝接管。首次换用新版 Runner 仍走正常 bundle 升级交接。

## workspace 示例

```sh
octopus-runner workspace add "/Users/kk2048/Desktop/tmp/codex-workspace" --label codex-workspace
octopus-runner workspace list
octopus-runner doctor
```

返回的 `ws_...` 才是远端工具应使用的 `workspace_id`。登记表位于 `~/.octopus-runner/workspaces.json`，与安装目录分离；卸载不会删除登记表、项目文件或 Agent session/transcript。

## 平台限制与排错

- macOS 的 Desktop、Documents、Downloads 等目录可能受 TCC 保护。`doctor` 若显示 workspace 不可访问，请在“系统设置 → 隐私与安全性 → 文件与文件夹”中给实际运行 Node.js 的终端/可执行文件授权；安装器不能代替用户授予该权限。
- macOS GUI 自动化只在 Runner 的 uid 正好拥有 `/dev/console`、当前存在已登录 Aqua 会话、允许机器操作且系统自带 `osascript` / `screencapture` / `sips` 可执行时上报。满足条件并升级到支持 `runner-macos-gui/v1` 的 bundle 后，总览才显示该设备的 GUI 自动化开关；Linux 与 Windows 当前不会显示。
- 开启总览开关只允许同账号 Agent 发现并发起本机授权，不会直接开放屏幕。首次实际请求时，Mac 会先显示 Octopus 的 15 分钟确认框；同意后还会触发/检查 macOS TCC。请在“系统设置 → 隐私与安全性”中给实际运行 Runner 的 Node/Runner 进程授予“屏幕录制”和“辅助功能”，再重新请求。Runner 不会代替用户修改这些系统权限。
- macOS 实机验收：从另一台已启用本地 Agent 桥的 Runner 列出该 Mac，发起 GUI 请求并在 Mac 本机同意；确认右上角停止浮层可见，只返回主屏截图；按“截图 → 点击/滚动/拖动 → 再截图”验证坐标；验证文字和按键；最后分别验证浮层停止、总览关开关、源 MCP 退出和 15 分钟到期后后续动作都被拒绝。测试时只打开无敏感数据的窗口。
- Linux 安装报 `systemctl --user` 不可用时，先确认该发行版/容器启动了 systemd user manager。本流程不伪造一个无监督的后台守护进程；非 systemd 发行版需另行增加明确的服务适配器。
- Windows 的 winget 可能把 Node.js 装成用户级便携 ZIP。安装器会刷新当前进程的用户/系统 PATH，并检查 WinGet 的用户/系统命令链接；已有 Node.js < 20 不会遮住合格版本。旧安装器若在 winget 显示成功后仍报找不到 Node，完全退出并重新打开终端，先验证 `node -v`，再签发新的十分钟 enrollment 重试；此错误本身不代表需要管理员权限。
- Windows 安装若提示缺少 `winget`，先从 Microsoft Store/企业软件中心安装 App Installer；若依赖安装被策略拒绝，可由管理员预装 Node.js ≥ 20 与 Git for Windows，再重新执行同一安装命令。Runner 不会回退到 WSL 或不受监督的后台窗口。
- Windows PowerShell 5.1 依赖安装器响应开头的 UTF-8 BOM 正确读取中文诊断。如果错误中出现 `鏍煎紡` 一类乱码并伴随 parser error，说明拿到了修复前或被代理改写的 `.ps1`；删除 `%TEMP%\octopus-runner-install.ps1`，确认服务端已更新后重新签发并执行，不要手工修补乱码脚本。
- Windows `status` 显示任务存在但不在线时，运行 `octopus-runner logs` 和 `doctor`。计划任务只在当前用户登录会话内运行；本流程不创建 SYSTEM 服务，也不承诺用户未登录时常驻。
- `status` 中 `service=active` 但 `gateway=offline` 表示本机进程在运行、服务器尚未看到该设备；`gateway=unreachable` 表示状态 API 本身不可达或凭据被拒。继续看 `logs` 和 `doctor`。
- `uninstall` 默认 fail closed：服务器凭据无法撤销时不清理本机，以免留下不可见的有效 key。只有明确接受服务器凭据暂未撤销时才用 `--force`。
- 服务文件和 CLI wrapper 记录安装时的 Node.js 绝对路径。若系统包管理器移除了该路径，重新执行安装命令，或修复 Node 后重新安装服务。

## 文件和回滚边界

- 安装状态：`~/.octopus/runner/config.json`、`token`、`standalone.js`、`standalone.prev.js`、`logs/`；根目录和凭据均限制为当前用户。
- macOS 服务：`~/Library/LaunchAgents/org.example.octopus-runner.plist`。
- Linux 服务：`${XDG_CONFIG_HOME:-~/.config}/systemd/user/octopus-runner.service`。
- Windows 服务：`%USERPROFILE%\.octopus\runner\octopus-runner-task.ps1` 定义的当前用户 `OctopusRunner` 计划任务。
- CLI：Unix 为 `~/.local/bin/octopus-runner`，Windows 为 `%USERPROFILE%\.local\bin\octopus-runner.cmd`；卸载只移除安装器自己维护的 PATH 项。
- 更新失败优先自动回滚 `standalone.prev.js`。若服务定义损坏，重新执行最新安装命令会重写托管 bundle、配置和服务定义。
- 服务端 Runner bundle 与 Bot checkout 是两个交付轴。影响 bundle 的工单合入后，`/tickets` 会显示“Runner bundle 待激活”；完整部署通过健康门后从已部署 checkout 自动激活，失败时工单保持待上线并显示错误。不要因为 Bot 部署成功就认定客户端已更新，也不要只替换公开下载文件：Gateway 在线自更新、installer 和下载路由必须继续共用同一 active digest。

## 自动更新与版本验收

更新顺序是：部署含该提交的 Bot → 激活 standalone artifact → 设备获知目标 SHA → 校验与原子安装 → 重启运行 → Gateway 收到新进程报告的 SHA。服务端 active 指针只证明包已可供下载，不证明设备已更新。

- Gateway 每 15 秒检查晚激活的新包。设备明确请求过包而 5 分钟仍未报告目标 SHA 时，在 RPC/peer/local bridge/DSH 空闲后重新协商；未请求更新的禁用客户端不会被循环断开。
- 自动更新先保留当前运行文件，再原子替换 managed 文件。OS service 的首次交接也保留旧进程作为更新 shim；shim 子进程更新才退出 75。新子进程 30 秒内异常退出时，恢复上一运行文件并跳过该坏 SHA；其它新 SHA 仍可正常更新。无可读摘要时才保守禁用该回退进程的自更新。
- 服务停止时，shim 把 SIGTERM/SIGINT 转发给自己启动的 Runner 并等待退出；14 秒仍未退出则终止该子进程。不会把停止误判为坏包并重启，也不向整个进程组发信号，保留 Linux KillMode=process 对 detached Agent 的保护。
- `octopus-runner status --json` 同时列出磁盘版本、Gateway 回报的 `running_sha`、`target_sha` 和 `update_status`。`current` 才表示该设备正在运行服务端当前包；`pending/updating/retry_pending` 仍未完成，`disabled/blocked` 分别表示显式禁用或坏包隔离，字段缺失是 `unknown`。
- `octopus-runner update` 等待该设备在线且报告下载的确切 SHA，才打印更新成功。超时恢复上一版本文件并尝试重启；若文件已被另一更新替换，拒绝覆盖它并报告未确认。
- 离线设备会在重连时更新；持续执行或隧道会推迟重协商；磁盘/权限/网络故障仍可能阻止更新。部署验收应逐一核对本次关注设备的 SHA，不能把全局 artifact 激活或 `service=active` 当作客户端验收。

## 自启与故障恢复

| 平台 | 默认启动时机 | 异常恢复 | 未登录时开机启动 |
|---|---|---|---|
| Windows | 当前用户登录，Limited 计划任务 | 无控制台宿主与 PowerShell 循环恢复 Node；调度器重试宿主失败 | 默认不支持 |
| macOS | 当前桌面用户登录，LaunchAgent RunAtLoad | KeepAlive，失败后节流重启 | 默认不支持 |
| Linux | systemd user service enable | Restart=on-failure，间隔 3 秒 | 需 linger=yes |

运行 `octopus-runner doctor` 查看实际服务是否启用、自恢复配置和启动时机。
Linux 使用 `loginctl show-user "$USER" --property=Linger --value` 查询；
需要未登录启动时由机器所有者显式执行 `loginctl enable-linger "$USER"`，
或安装时使用 `--linger`。默认安装不自动提升权限。

## Windows 驻留与旧安装迁移

Windows 当前支持已登录用户的无窗口后台任务。安装终端可以关闭；管理员安装不会
把任务变成 SYSTEM 服务，也不会让它在注销后继续运行。`OctopusRunner` 继续使用
当前用户、Interactive、Limited，在登录时启动，允许电池供电下启动和持续运行。

托管任务格式 4 使用本机 .NET Framework 编译的小型 GUI 子系统宿主作为计划任务 Action。
宿主用 `CreateNoWindow=true`、`UseShellExecute=false` 启动 PowerShell 重启循环；
控制台分配在进程创建时禁用，避免 Windows Terminal 忽略 `-WindowStyle Hidden`
而留下空白窗口。宿主本身加入 `KILL_ON_JOB_CLOSE` Job 并等待子进程；任务停止或宿主
异常终止时，其 Node、更新 shim 和普通子进程一起退出。宿主 exe 按源码摘要命名，
升级不会覆盖正在执行的文件；无需额外运行库、VBScript 或更改系统默认终端。
Windows 的远程 `restart` 先给同一任务登记一个 5 秒后的一次性启动，再停止当前任务，
避免重启命令作为任务子进程被一并终止后无人负责重新启动。一次性触发器使用固定 ID，
反复重启不会累积触发器，登录触发器保留。

新 bundle 的 `daemon` 启动会对比并幂等迁移已有托管脚本/任务 Action 与 Settings，
保留原有任务身份、权限级别和触发器；登记失败恢复原脚本，后续启动重试。
已经运行的旧 PowerShell 包装器在下一次服务启动后采用新格式。停止/重启会按本安装的
Node 路径和 daemon 入口清理旧包装器遗留进程，不匹配其他 Node 程序。
`status --json` 的 `service_details` 显示 `windowless_action`、登录类型、权限级别、
电源条件和重试设置；`doctor` 另行通过 Task Scheduler COM 查询登录自启与宿主 Action。
这些是任务配置证据，不是屏幕可见性探测。升级已有格式 2 后，执行一次
`octopus-runner restart` 才会替换当前旧包装器；重装或下一次登录也会采用新宿主。
企业策略若禁止本机编译/执行该宿主，迁移会明确失败并保留旧脚本。

### 执行端日志隐私

Windows 与 macOS 上的常驻 Runner（包括前台 `run --foreground`）不输出日志，不记录
远程命令、路径、请求正文或命令结果；这些多是个人机器，磁盘也常吃紧。RPC 仍把
stdout/stderr/退出码返回调用方，由调用方的 Agent 会话保留。CLI 的 `status`、`doctor`
和 MCP stdio 协议继续正常返回结果。Windows 包装器丢弃所有输出；macOS 服务重定向到
`/dev/null`；进程内输出也静默，升级 shim 不继承日志描述符。

Linux（服务器、容器）保留日志（2026-10-20 起恢复）：常驻进程照常输出，含
`machine-op` 审计行；systemd 单元不设 null 输出，写入 journal，容器写入容器日志。
此前版本加到 systemd 单元的 `StandardOutput=null` / `StandardError=null` 会在下次
常驻启动时去掉并 `daemon-reload`，在其后的一次重启生效。

Windows/macOS 每次常驻启动会清空本安装 `logs` 目录中的 `runner.out.log`、`runner.err.log`、
`stdout.log`、`stderr.log`。仅处理普通单链接文件，拒绝软链接、硬链接或重定向的目录；
保留零长度文件以兼容旧包装器持有的句柄。`logs --clear` 可检查清理失败。
自定义 supervisor 文件和 OS journal 需在运维侧核对归属后清理；不得为了清理一个
Runner 而 vacuum 掉其它服务的共享 journal。离线端在下次更新启动时执行同一迁移。

本策略针对 Runner 的隐式执行日志。显式 CI/知识构建任务的产物、用户命令主动创建的
文件，以及实际运行模型一侧的原生 Agent 会话属于各自工作负载；不以日志清理名义
删除。执行环境仍不是对管理员隐藏进程、文件或内存的隔离边界。

普通远程 shell、Python launcher 及升级子进程使用 Windows 隐藏窗口选项。显式 GUI
程序或系统提权对话框不属于控制台窗口；本设置不拦截用户主动要求的桌面操作。
Windows 的 `config.json` 可设置 `execution_path`（绝对目录数组），仅在 Runner 环境
中优先使用已安装的实际工具。例如将 Python 安装目录放在 WindowsApps 的商店别名
之前，避免 `python` 打开安装界面；不改机器的全局 PATH，也不替远程请求安装软件。

每个 scan home 还有一个不携带数据的本机实例锁（Windows named pipe / Unix 私有
socket），阻止重复 Runner 抢占同一设备。升级交接先释放本机资源与锁，再启动新进程。

实机回归位于 `packages/runner/src/service-manager.windows.test.ts`：创建随机命名的
临时任务和假 daemon，枚举 Node、PowerShell 及 GUI 宿主的原生窗口（包含 PseudoConsoleWindow），
验证没有控制台窗口、旧定义迁移、崩溃恢复、从任务内部请求 restart、
stop 后子进程消失；最终删除临时任务和目录，不操作已安装的 Runner。

## 旧版本的升级入口

`runner-gateway/v1` 的认证 register/bundle 请求形状保持稳定，新字段均为增量字段。
没有 protocol 字段的最老注册格式仍可认证；无效或已撤销的凭据仍被拒绝。
旧客户端缺少业务能力只代表相应业务不可用，不要求先具备新功能才能下载更新。
没有摘要或更新器的极老客户端、未来不兼容的 Node 主版本，不能凭这个契约保证自动升级。

发布验收可额外指定一份保留的真实历史包（不覆盖生产 artifact）：

```sh
RUNNER_TEST_HISTORICAL_BUNDLE=/absolute/path/to/retained-runner.js \
  pnpm exec vitest run --project node --maxWorkers=1 \
  packages/bot/src/runner/self-update.e2e.test.ts -t 'historical installed Runner'
```

该用例先激活当前包，再让离线的历史安装版回连，模拟外部服务重启旧版的退出交接，
最终以 Gateway 收到当前 SHA 验收。日常 CI 继续跑普通/安装版的真实进程升级、丢包、
坏包回退、后续修正版及停止信号用例；历史包验收需显式提供保留 artifact。
