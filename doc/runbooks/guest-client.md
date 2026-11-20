# 访客客户端：让朋友在自己的 Windows 电脑上用你的 Claude Code 和 Codex

> **现行。** 2026-11-13 起：会话以所有者本人的用户和登录直接运行，用系统提示和守卫 hook 把它限定在自己的目录里。
> 2026-11-14 起也提供 Codex：用所有者专门为访客登录的一个 Codex 目录。
> 取代 11-13 早些时候的“独立用户 + Landlock + 主机出口注入登录”方案，以及 11-12 的“CLI 装在朋友电脑上”方案。

## 它是什么

一个双击即装的 Windows 安装包（`OctopusGuest-<设备名>-Setup.exe`），由会话主机（例如 `gpu-box-b`）一条命令生成。

- 朋友双击桌面上的「Claude（Octopus）」，打开的终端窗口（Windows Terminal）里是**在会话主机上运行的原版 Claude Code**。
- 它以主机所有者本人的 Linux 用户、本人的 Claude 登录运行，直连 Anthropic，中间没有代理，也不改写请求。用量计入所有者的订阅。
- 它在主机上的一个目录里干活，有完整的本地工具和文档 skill（PPT、Word、Excel、PDF、画图）。窗口开着时，还能用 `pc` 工具在朋友电脑上执行 PowerShell、收发文件。
- 关掉窗口不会结束会话：智能体在 tmux 里继续工作，再次双击回到原来的会话。
- 朋友电脑上没有智能体，也没有任何凭据。安装包只有 Node 和 Runner，约 22 MB，不需要管理员权限。
- 同时会装一个仅执行模式的 Runner（计划任务 `OctopusGuest`），它是所有者名下的一台设备，所有者的 Agent 可以远程协助这台电脑。
- 「Codex（Octopus）」同理，是主机上的原版 Codex CLI。它用的 Codex 目录是所有者专门为访客登录的（ChatGPT 登录，用量计入所有者的 ChatGPT 套餐），不是所有者自己的 Codex 目录，所以不带所有者的 AGENTS.md、hooks、MCP 和会话记录。主机没配这个目录时，Codex 图标会提示“这台主机没有提供 Codex”。

## 它怎么被限定在自己的目录里

每台访客设备一个目录：`<root>/guests/<设备>/`。会话的 `HOME`、`TMPDIR` 和工作目录（`workspace/`）都在这里。

**不加载所有者的东西。** 命令行参数和环境变量：
- `--setting-sources ""`：不加载所有者的 settings、hooks、插件和 CLAUDE.md。
- `--strict-mcp-config`：只挂 `pc` 这一个 MCP。
- `ENABLE_CLAUDEAI_MCP_SERVERS=false`：不拉所有者在 claude.ai 上的连接器。
- `XDG_RUNTIME_DIR`、`CLAUDE_CODE_TMPDIR` 指向访客自己的目录：会话 socket、草稿和后台任务输出都和所有者的会话分开（默认的 `/tmp/claude-<uid>` 是所有者在用的）。
- `CLAUDE_CONFIG_DIR` 指向所有者的 `~/.claude`：只为用所有者的登录（并和所有者的会话共用刷新锁）。访客的全局状态在那里的 `.claude.json`，会话记录在 `~/.claude/projects/<访客工作目录>/` 下。
- 计划文件（`plansDirectory: .plans`，在工作目录里）和自动记忆（`autoMemoryDirectory`，`<设备>/memory`）放在访客目录里；两者默认都在所有者的 `~/.claude` 下。
- 文档 skill 用 `--plugin-dir` 挂一个只含 `pptx`/`docx`/`xlsx`/`pdf` 的本地插件，所有者的其他 skill 不加载。
- 会伸出本机、进入所有者账号的工具对访客禁用（`permissions.deny`）：
  - `ListAgents`、`SendMessage`：本机会话注册表 `~/.claude/sessions/` 是共用的，访客能借它们给所有者自己的会话发消息，而那些会话权限是全开的；
  - `SendToProject`、`SendToProjectContext`（claude.ai 项目）、`RemoteTrigger`（云端定时 agent）、`DesignSync`、`PushNotification`（会推到所有者的手机）、`SendFeedback`；
  - Artifact 用 `CLAUDE_CODE_DISABLE_ARTIFACT=1` 关掉：页面会发布到所有者的 claude.ai 账号，朋友打不开。
- `/login`、`/logout` 命令关掉（`DISABLE_LOGIN_COMMAND`、`DISABLE_LOGOUT_COMMAND`）：它们会改写所有者的登录文件，把所有者自己的会话也登出。`/feedback`、`/install-github-app` 也关掉，它们以所有者的身份行事。

**Codex 会话**（`codex` 的命令行参数，不改 Codex 目录里的配置文件）：
- `CODEX_HOME` 指向访客专用的 Codex 目录（例如 `<root>/codex-home`）。会话记录、输入历史、`/model` 等选择都存在那里，主机上所有访客共用这一个。
- `--no-daemon`：不起共享后台服务，会话随 tmux 一起结束。
- `--sandbox danger-full-access --ask-for-approval on-request`：本地命令直接执行（由守卫盯着），`pc` 工具每次都先问朋友，和 Claude 一致。
- `--disable plugins --disable remote_plugin --disable apps`：不装插件，也不带所有者 ChatGPT 账号里连接的应用。
- `-c check_for_update_on_startup=false`：否则界面会弹“立即升级”，一回车就对所有者的 Codex 执行 `npm install -g`。
- `-c service_tier="default"`：每次会话从标准档开始；朋友在会话里开 `/fast` 只在本次会话有效（会写进专用目录的 config.toml，下次启动又被这个参数盖回去）。
- `-c developer_instructions=…`：和 Claude 相同的系统提示，另外允许读 Codex 自带的 skill（`<Codex 目录>/skills`）和生成图片的暂存目录（`<Codex 目录>/generated_images`）。
- 守卫用 `-c hooks.PreToolUse=[…]` 挂上，并加 `--dangerously-bypass-hook-trust`：Codex 默认只运行在界面里手动“信任”过的 hook，未信任的会被静默跳过。这个 hook 由主机自己写在命令行上，所以跳过信任这一步。`/hooks` 界面里它仍显示“需要审核”，这是正常的，它照样在运行；不要在那里把它关掉。
- 文档 skill 以符号链接放在访客的 `~/.agents/skills/` 下（Codex 在这里找用户自己的 skill），指向共享工具目录里的同一份。
- 专用目录里那个最小的 `config.toml` 也写了不装插件、不带应用、不查更新。

**系统提示**：告诉它只能在自己的目录里工作，不许碰 `/home`、`/root`、`/srv/research`，越界会被立即结束；共享工具目录（skill 及其脚本、Python 和 Node 库）可以读和运行，但不能改。

**守卫 hook**（`guest-guard-script.ts`，匹配所有工具；Claude 经 `--settings` 挂为 PreToolUse，Codex 经 `-c hooks.PreToolUse`）。两边交给 hook 的事件格式相同：shell 命令都是 `Bash` 工具的 `command`，`pc` 工具都叫 `mcp__pc__*`。
- 检查的字段：每种工具只检查指向本机路径的字段——Bash 的命令；Read/Write/Edit 的 `file_path`；Glob 的 `pattern`/`path`；Grep 的 `path`/`glob`；Codex `apply_patch` 补丁头里的文件（Add/Update/Delete File、Move to），不看补丁正文；Codex `view_image` 的 `path`；`pc` 传输在本机一侧的 `path`。
- 拦截的写法：
  - 受保护目录 `/home`、`/root`、`/srv/research`、`/srv/research-archive` 的绝对路径。按路径分隔符边界匹配，经 `..` 规范化后落在以下几处的放行：访客自己的目录、共享工具目录；Claude 会话另放行 Claude 为这个工作目录保存文件的 `~/.claude/projects/<访客工作目录>/`（输出过大时，Claude 会把结果存在那里再读回来）；Codex 会话另放行 `<Codex 目录>/skills` 和 `<Codex 目录>/generated_images`。
  - `../../home` 这类上跳出去的相对路径；
  - `~ubuntu` 这类指定用户的写法；
  - 被引号或反斜杠拆开的词，例如 `/ho""me`；
  - `$CLAUDE_CONFIG_DIR`；
  - `/proc/<pid>/environ` 等。
- 不检查的：写入文件的正文、Grep 的搜索内容、URL，所以文档里提到某个路径不会被误杀。
- 命中后：这次调用被拦下（hook 退出码 2），记入 `<设备>/.octopus/guard.log`，0.3 秒后结束这个智能体自己的 tmux 服务器（socket 由主机经 `OCTOPUS_GUEST_TMUX` 告诉守卫，不碰别的 tmux，也不碰同一访客的另一个智能体）。朋友窗口显示“会话已被 Octopus 守卫结束（原因）”，再按回车开新会话。
- 失败即拦截：hook 命令是 `node guard.mjs || { echo "…" >&2; exit 2; }`，守卫读不懂输入或根本没能运行（例如 node 不见了）时，这次调用被拦下，会话继续。两边都只把“退出码 2”当作拦截，其他非零退出码会照常放行这次调用；Codex 还要求 stderr 里写了原因，否则把退出码 2 也当成 hook 出错，所以兜底分支要输出一句话。

**防护的边界**：这是防止“不小心碰到”的护栏，不是安全边界。
- 会话就是所有者本人，操作系统层面什么都挡不住。
- 守卫只看工具调用，挡不住刻意的绕过（变量拼接、脚本里间接读文件、符号链接）。
- 朋友在 Claude 里用 `!` 执行的命令、用 `@` 引用的文件不经过工具调用，守卫看不到；Codex 界面里的 `!` 命令也一样。也就是说，朋友本人等同拿到了所有者用户的 shell，能读到所有者的 Claude 登录文件。这建立在朋友可信的前提上。
- Codex 交给 hook 的只有命令文本：命令的工作目录参数、发给已在运行的交互程序的输入，守卫都看不到。
- Claude 会话的输入历史和会话记录写在所有者的 `~/.claude`（`history.jsonl`、`projects/`）里；Codex 会话的写在访客专用的 Codex 目录里。
- 朋友在 Codex 里执行 `/logout` 只会登出访客专用的 Codex 目录，不影响所有者自己的 Codex；之后要所有者重新登录一次（见下文）。
- 内存由 `launch_prefix`（例如 memguard）按进程树限制。

## pc 工具

- 主机在 `https://127.0.0.1:<port>`（默认 47830）上监听，只处理 `/octopus/pc/*`，把调用转给该访客最近打开的那个终端窗口。证书由本机生成的 CA 签发。
- 每个访客有一个随机口令（`<设备>/.octopus/pc.json`），`pc` MCP 用它表明自己是哪个访客。一个访客只能操作它自己的终端窗口，也就是它自己那台电脑。
- 三个工具：`run_powershell`（在朋友的桌面会话里执行）、`fetch_file`（朋友电脑 → 工作目录）、`send_file`（工作目录 → 朋友电脑）。每次调用 Claude 和 Codex 都会让朋友确认（Codex 可以选“本会话内允许”）。

## 主机：开启访客会话（一次）

```bash
octopus-runner guest host --claude-dir ~/.claude \
  --sessions-root /srv/research/research-b/octopus-guest \
  --sessions-launch-prefix "/srv/research/research-b/bin/memguard --rss-gib 8 --log /srv/research/research-b/octopus-guest/memguard.log --" \
  --sessions-env PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
  --sessions-env NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
octopus-runner guest status
```

- `--sessions-root` 不能在本用户的 home 里（守卫不让访客碰 `/home`）；放在 `/srv/research` 下可以，守卫按访客自己的目录放行。
- `--sessions-launch-prefix` 是一整串命令，按空白切分，所以路径里不能有空格；传 `""` 清除。
- 主机需要 `python3`（PTY 启动器）、`tmux`、`node`，以及所有者已登录的原生 Claude Code；提供 Codex 时还要有 Codex CLI（按 Runner 启动它的方式找到）。
- 常驻 Runner 约一分钟内生效，之后 inventory 才会报告访客会话可用。关闭：`octopus-runner guest host --off`。
- 第一次有访客连上来时，Runner 会把启动器、守卫、`pc` 服务器、tmux 配置、CA 和文档 skill 插件写到 `<root>/tools`。

提供 Codex（可选）：先建一个只给访客用的 Codex 目录，所有者用自己的 ChatGPT 账号登录一次，再告诉 Runner。每次登录各得一套令牌，和所有者其他地方的 Codex 登录互不影响。

```bash
H=/srv/research/research-b/octopus-guest/codex-home
mkdir -m 700 $H
printf 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n\n[features]\nplugins = false\nremote_plugin = false\napps = false\n' > $H/config.toml
CODEX_HOME=$H codex login --device-auth     # 浏览器打开提示的网址，输入一次性码
octopus-runner guest host --codex-home $H   # 不再提供：--codex-home ""
```

- `--codex-home` 要求目录里已有 `auth.json`，并且不能是本机 Runner 自己的 `CODEX_HOME`。
- 放在会话根目录下但不在 `guests/` 里：守卫不让访客碰它（`/srv/research` 受保护），只放行其中的 `skills/` 和 `generated_images/`。

文档工具链需要手动装一次，所有访客共用：

```bash
T=/srv/research/research-b/octopus-guest/tools
python3 -m venv --system-site-packages $T/python
$T/python/bin/pip install -i https://mirrors.aliyun.com/pypi/simple/ python-pptx python-docx openpyxl xlsxwriter \
  pandas numpy matplotlib seaborn pypdf pdfplumber reportlab pillow lxml defusedxml pdf2image
mkdir -p $T/node && (cd $T/node && npm install --registry=https://registry.npmmirror.com pptxgenjs docx react react-dom react-icons sharp)
```

访客自己 `pip install` 时会装进自己的 HOME（`PIP_USER=1`）；`npm install` 装进当前目录。

## 主机：打包一个朋友

```bash
octopus-runner guest pack --device zhang-laptop            # 默认只带 Claude
octopus-runner guest pack --device zhang-laptop --providers anthropic,openai   # Claude 和 Codex 两个图标
octopus-runner guest pack --device zhang-laptop --ttl-days 14
```

- 安装包由两部分组成：
  - **底包**：Node、Runner bundle 和 NSIS 脚本，与设备无关，缓存在 `~/.cache/octopus-guest/base/`，保留最近 3 个。
  - **设备配置**：`guest.json`，内容是登记码、设备名和可用智能体，作为尾部追加在 exe 末尾，格式为 `[json][u32 长度][OCTOPUS-GUEST-V2]`。NSIS 只校验自己的数据，追加的尾部不影响校验。
- 安装时 `guest-install --installer "$EXEPATH"` 读出尾部，写成 `app/guest.json`，并按授权写 `app/agents/<agent>` 标记，NSIS 据此建快捷方式。
- 底包只在服务端 Runner 或 Node 版本变化后的第一次打包时重建（约 20 秒）。之后每次签发新设备或新登记码只需约 0.2 秒：一次服务器请求加一次文件复制。
- 安装包里只有一个一次性登记码，有效期默认 7 天、最长 30 天，装过一次就失效。同名重新签发会让旧登记码作废。
- 产物默认放在 `~/lht/temp/octopus-guest/<设备名>/`。
- 打包需要 `makensis`（`sudo apt-get install -y nsis`）和 `unzip`。
- 上线前测试本地构建：`--runner-bundle packages/runner/dist/standalone.js`，只用于测试。

## 朋友：安装与使用

1. 双击安装包。Windows 可能弹出“已保护你的电脑”（安装包没有代码签名），点“更多信息 → 仍要运行”。
2. 安装到 `%LOCALAPPDATA%\OctopusGuest`，桌面出现「Claude（Octopus）」。快捷方式运行的是后台服务会自动更新的那份 Runner，终端客户端的修复不用重装。
3. 双击图标即可开始。窗口会在 Windows Terminal 里打开（Windows 11 自带）。经典控制台的默认字体缺界面上的符号，会显示成方框。
4. 要给它看自己电脑上的文件，直接告诉它路径，或把文件拖进窗口。做好的文件，它会发到桌面或你指定的位置。
5. 断网会自动重连。智能体退出后，按回车开始新会话。关窗口不影响正在进行的任务。
6. 卸载：开始菜单 → Octopus → 卸载，或在“设置 → 应用”里卸载。卸载会在服务端注销这台设备。

## 运维

```bash
octopus-runner guest sessions                 # 列出访客
octopus-runner guest sessions --stop <设备>    # 结束该访客的 tmux 服务器（Claude、Codex 各一个，只结束它自己的），目录保留
octopus-runner guest sessions --purge <设备>   # 连同目录和口令一起删除
```

- 吊销访客（Dashboard 删除设备，或朋友卸载）后，朋友连不上了，但已经在运行的会话不会自动停止，要执行 `--stop` 或 `--purge`。
- 改了会话规格（新版本 Runner 的参数、环境变量等）后，正在运行的 tmux 服务器仍沿用旧环境，需要 `--stop` 一次。
- 每个访客的 Claude 和 Codex 各用一个 tmux 服务器（`<设备>/.octopus/tmux-claude.sock`、`tmux-codex.sock`）。tmux 里新会话的命令拿到的是服务器启动时的环境，不是这次启动器的；两者共用一个服务器时，后打开的那个会继承先打开那个的环境（Claude 缺了 `CLAUDE_CONFIG_DIR` 会要求登录，Codex 缺了 `CODEX_HOME` 也一样）。
- 用量计入所有者的订阅额度，和所有者自己共用。所有者账号若开着 extra usage，额度用完后会按量计费。Codex 的用量计入所有者的 ChatGPT 套餐。

排错：

- 主机 Runner 日志：
  - `guest session <设备> attached claude`（或 `codex`）：终端已接上。
  - `ended by the guard: …`：守卫结束了会话。详情在 `<设备>/.octopus/guard.log`。
  - `launcher exit 125`：会话没能启动，后面跟着原因。
- 看访客的屏幕：`tmux -S <root>/guests/<设备>/.octopus/tmux-claude.sock capture-pane -p -t claude`（Codex 是 `tmux-codex.sock` 和 `-t codex`）。
- Codex 图标提示“这台访客设备未获准使用 Codex”：打包时没带 `openai`，用 `--providers anthropic,openai` 重新打包。
- Codex 界面要求登录：访客专用目录的登录没了（例如朋友执行了 `/logout`），按上文重新 `codex login --device-auth`。
- 朋友那边窗口显示 `登记已失效`：设备被删了，需要重新打包安装。
- 朋友那边窗口显示 `暂时连不上`：主机 Runner 不在线，或主机没开会话；窗口会自动重试。
