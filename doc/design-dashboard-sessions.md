# Dashboard v2 — 个人密钥登录 + 会话浏览器 + append

> **历史文档。** 记录 2026-07 Dashboard v2 的会话浏览器设计，浏览器实现已被 v4 React 前端取代；当前前端边界读 `doc/adr/0003-dashboard-react-frontend.md` 与 `packages/dashboard-web/CLAUDE.md`。

> 2026-07-23。需求来自用户:「把 dashboard 做成联网前端,直接看到所有注册用户的
> Claude Code / Codex session,类比 Claude Code 的展示方法 review 整个 history,
> 甚至往后 append」。两项用户拍板:**管理员全局视角不明示**;**append 限定本人**。


> **⚠ 2026-08-06（v4 Phase 1）起，本文的浏览器一侧已被取代。**
> 面板的全部浏览器代码现在是 `packages/dashboard-web` 的 React 单包，本文提到的
> `sessions-page.ts`、`session-view.ts` 等模板字符串渲染器已删除。**服务端契约（API、SSE 协议、授权、投递语义）不变**，
> 所以本文关于「服务端要保证什么」的部分仍然有效；关于「页面怎么拼出来」的部分请读
> `doc/adr/0003-dashboard-react-frontend.md` 与 `packages/dashboard-web/CLAUDE.md`。

## 1. 认证:为什么是「每用户密钥 → cookie」而不是 mTLS

旧状态:全局唯一 `dashboard.auth_token`,靠 `?token=` 挂在 URL 上,没有"你是谁"。

用户说的「本地装了 key 才能看」字面对应 mTLS 客户端证书,但签发/安装/轮换的
UX 比现状更糟,且移动端痛苦。等价且轻得多的实现:

- **双层身份**:config `auth_token` 仍是管理密钥(全量视角);每用户一把 `dt_`
  密钥(migration v12 `dashboard_tokens`,sha256 落库、明文只出现一次、
  UNIQUE(username) — 重签即作废旧钥,泄露链接的补救就是再发一次 /dashboard)。
- **登录即种 cookie**:`GET /login?token=…` 校验后种 HttpOnly + SameSite=Lax
  cookie(一年),之后浏览器就是"装了 key 的设备":URL 干净、自动进入密钥
  对应的权限范围。Bearer/query 继续可用(脚本);显式凭据优先于 cookie。
- **分发走飞书**:`/dashboard` 命令签发密钥并回登录链接——身份分发骑在已有的
  飞书绑定上,用户全程不用手摸 token。威胁模型与私聊消息等价(能看你飞书
  私聊的人本来就能冒充你对 bot 说话)。
- CSRF:SameSite=Lax 阻止跨站 fetch/POST 携带 cookie;GET 端点无副作用。
- 未配 `auth_token` 保持旧语义:开放模式,人人都是管理身份(绑内网口用)。

放弃的方案:mTLS(UX)、每请求签名(过度)、飞书 OAuth 全套(依赖飞书网页
授权域名配置,MVP 不值)。

## 2. 会话浏览器

### 数据源与合并

一个用户的会话可能在两类地方,浏览器后端把两路**并集**后按 `(source,id)` 去重
(Runner 条目优先),再按 last_activity 排序:

1. **在线 Runner 设备** — `gateway.rpcForUser()` 原有 list/search/read 动词,
   多设备扇出合并、summary 带 device 标签;
2. **bot 主机 scan home** — 与秘书完全相同的优先级
   (`secretary.scan_homes[user]` > `SESSIONS_SCAN_HOME` > 用户托管 home),
   直接 import scan 层函数,标记伪设备名 `bot-host`。

去重的必要性:dev 环境里 dev-laptop Runner 的 `RUNNER_SCAN_HOME` 与
scan_homes 指向同一个目录,不去重会全部双份。

### rich 解析(parse.ts 新增,flat 模式一字未动)

flat 解析是给秘书略读的:工具调用压成逗号串、tool_result 整个丢弃。review UI
需要 Claude Code 式的展示,因此新增 `parseSessionRich()`:

- 消息 = 有序 `RichBlock[]`(text / thinking / tool);
- **工具调用与结果跨行配对**:Claude 的 tool_result 在下一条 user 行
  (tool_use_id 匹配),Codex 是独立 `*_output` 事件(call_id 匹配);
- thinking 保留但单独成块(前端折叠);
- 每块独立封顶(input 2k / output 4k / thinking 4k / text 20k 字符),
  超限打 `truncated:true`——一个巨型工具结果不能撑爆一页;
- Codex 去重规则与 flat 一致(event 通道压过 response_item message 流)。

分页:`readSession` 增加 `rich:true + offset`,对**整个**会话做诚实分页
(返回 total_messages/offset),默认最后一页。参数走原有 `read_session`
RPC 动词透传,网关/Runner 传输层零协议改动;旧版 Runner 返回 flat 形状,
前端识别 `blocks` 缺失自动降级渲染。

### 前端(sessions-page.ts,自包含 vanilla JS)

- 侧栏:设备 → **严格按 cwd 的可折叠目录树**(2026-07-24,用户点名)。
  `buildDirTree()` 纯函数建树:无会话的单子目录链压缩成一个节点
  (如 `/home/ubuntu`,树从真正分叉处开始),每个目录节点带子树会话数徽标,
  目录里的直接会话与子目录并列展示;设备默认展开、目录默认折叠,当前打开
  会话的祖先链在**数据加载时**自动展开(纯重渲染时不动,不与用户的手动
  折叠打架)。roster 一次拉全(`limit=400`,服务端三处上限同步放开到 500,
  全量解析限并发 4 防内存尖峰),折叠/展开只重渲染内存数据,零网络请求;
  树逻辑用 vm 从渲染产物中提取做单测(`sessions-page.test.ts`);
- 搜索:`search_sessions` 扇出+本地合并,命中片段可点开;
- 刷新:显式按钮(列表/单会话),scan 层无状态现读文件,不做 filewatch;
- 渲染:用户文本气泡原样、助手正文 markdown-lite(围栏代码/行内码/粗体/
  标题,先 escape 后变换,无 XSS 面)、thinking 折叠、工具调用一行
  `▸ Bash · {command:…}` 点开见完整 input + 配对 output(出错红框);
- **工具连击折叠**:连续的纯工具消息(无正文)构成一个 run,整段收进一个
  「⚙ N 个工具调用」`<details>`(默认收起);贴图的 base64
  在 parse 层替换为 `🖼 [图片]` 行内标记(纯图消息不再凭空消失);
- 「加载更早」向前翻页,视口锚定不跳动(已显示条数用计数器而非 DOM 子节点数,
  因为折叠后二者不再相等)。
- **自适应尾窗**(折叠后视觉密度感知):默认打开某会话时,先取尾部 PAGE 条
  (200,服务端 clamp 放宽到 500),再检查这些消息**折叠后**的可见项数
  (`countVisibleUnits`:一段连续纯工具消息计 1 项,余下每条计 1 项);
  若不满 `MIN_TAIL_UNITS`(20)或尾部还没出现任何 user 轮,就向前扩窗
  再取一页,直到条件满足或触达 `TAIL_EXTEND_CAP`(800 raw)。
  「加载更早」同理按可见项步进——一次点击目标是新增 `STEP_TARGET_UNITS`
  (12)项,内部可能触发多次 raw 请求(上限 `STEP_CAP`=600 raw)。
  设计动机:折叠后一屏消耗的信息量与 raw 条数脱钩,80 条全是工具的话
  折出来只有 1 行,不做自适应会显式范围小得没法读;至少覆盖最后一次
  user 输入,让读者永远看得到"这段对话怎么开始的"。

### 性能设计(2026-07-24 复盘后加固)

用户实测"350 条消息的会话打开卡几分钟"。排查结论:**服务端每一环都是
百毫秒级**(rich 解析 40ms、默认页 payload 145KB、loopback RPC 0.1s),
慢的是浏览器与这台机器之间的公网传输——未压缩 JSON 走慢速跨境链路。
对应加固,每层各管一件事:

1. **HTTP 压缩**:正文 >1KB 且客户端表示接受才压,JSON/HTML 实测 ~8×,145KB → ~18KB。
   ~~dashboard `send()` 统一出口~~ → **2026-08-06(v4 Phase 2)起是 `@fastify/compress`**:
   同样的 1KB 阈值,但改为流式(不再 `gzipSync` 占事件循环)、正确协商 q 值与 `identity`,
   并多支持 br(只发 `gzip` 的客户端仍拿 gzip)。SSE 路由 `reply.hijack()` 之后不经过它;
2. **scan 层 summary cache**(`(path, mtime, size)` 键):列表原来每次刷新
   都全量读+解析最近 50 个文件(实测 ~130MB、3.9s,还会长时间阻塞事件循环);
   session 日志是 append-only 的,mtime+size 校验诚实,warm 列表降到毫秒级。
   搜索/digest 天然要读全文,不缓存(known limitation 照旧:FTS 是升级路径);
3. **双源并行**:Runner RPC 与本机 scan 原来串行 await,改为并发;
4. **WS permessage-deflate**(网关侧 offer,ws 客户端默认接受):真实笔记本
   Runner 走住宅上行链路时 transcript 帧同样 ~8×;no-context-takeover
   限制每连接 zlib 内存(3.7G 共享机)。

## 3. append:边界裁决

**只有两条路能碰一个已有 session,取干净的那条**:

- ✅ **headless resume**(本实现):`claude -p <prompt> --resume <id>
  --output-format json --dangerously-skip-permissions` /
  `codex exec resume <id> <prompt> --skip-git-repo-check`,在会话原 cwd、
  由 Runner 进程 execFile(无 shell、prompt 单 argv)执行。
- ⏸ tmux send-keys 注入活会话:能实现(machine_exec 今天就能跑),但
  session↔pane 映射靠约定、注入时机不可控,定位 opt-in 实验特性,未做。

裁决记录:

- **仅限本人**(用户拍板):`/api/sessions/append` 要求登录身份 role=user 且
  username 等于目标——管理密钥直接 403。理由:append 在**对方机器**上以
  **对方的 CLI 订阅/额度**执行任意 agent 轮次,这不是"看"而是"花别人的钱
  替别人做事"。
- **bot 主机会话只读**:维持「bot 主机不给 shell」的既有裁决(那台机器上住着
  config/bot.db/所有人归档)。想 append bot 主机上的会话,就在那台机器上跑一个
  Runner——装 Runner 即显式授权 machine ops,边界回到 OS 账号+令牌。
- `--dangerously-skip-permissions` 不是新增攻击面:开着 machine ops 的设备
  本来就有完整 shell(`exec`),而 prompt 只可能来自设备主人本人;不加它
  headless 轮次会死在第一个权限门上。设备侧 `RUNNER_ALLOW_MACHINE_OPS=0`
  一票否决(append 在 MACHINE_WRITE_METHODS 里)。
- **resume 语义如实呈现且版本相关**:实测当前 Claude Code `-p --resume`
  **原地续写同一 session id**(2026-07-23 dev 活体验证,10→12 条);旧版
  CLI 会 fork 出新 id。响应带回 `new_session_id`,前端同 id 刷新、异 id
  自动跳转,两种都对;不做线索归并(诚实优于聪明)。
- 超时链:runner execFile 280s < gateway 机器操作预算 320s。

### 2026-08-12：attachment / lease / turn Agent 控制面

原实现把“观察到进程”“谁能写”“一轮是否活动”压在 `control_mode` 上，无法干净表达外部 CLI、provider protocol 与网页交互的组合。当前 Runner 以 provider session、attachment、control lease、turn、interaction 五个概念建模（操作见 `doc/runbooks/agent-adaptor-hooks.md`）：

- hook 只向 mode-0600 Unix socket 报告 session/event；Runner 从 hook 子进程向上解析真正的 CLI ancestor，并以 `(pid, /proc starttime, boot id)` 标识一次进程 incarnation；
- roster 只投影 attachment / lease / turn 与派生能力；`control_mode` 仅作旧客户端兼容别名，PID、pgid、cwd、endpoint 和 transcript path 留在设备；
- 活动外部 CLI 若能证明独占 tmux pane，普通 append 只向该 pane 发送文本并保持 terminal lease；不能证明就拒绝，不自动 headless resume；
- `octopus-codex` 可让 TUI 与 Runner 进入同一 loopback app-server，从而在保留终端 lease 时 native `turn/start|steer`；普通 Codex TUI 不会被加载到第二个 server；
- 网页托管使用长连接 Claude Agent SDK 或 Codex app-server，支持 native steer、interrupt、提问与权限；轮次完成即释放 attachment，让用户可回 CLI；
- 只有独立的 human-only `takeover_session` 才结束外部 CLI 并 provider-native resume；普通发送不改变所有权；
- hook 缺失、未信任或 Runner 重启只会退化为旧的 transcript-only 兼容水平，不会靠扫描进程名猜测后提供接管按钮。

## 4. 管理视角政策(记录在案)

管理密钥可浏览所有注册用户的会话内容。经用户拍板,此能力**不在任何用户面向
文案(接入教程、/runner-token 回复、登录页)中明示**。工程上的对应事实:
今天的 Runner 协议本来就允许 bot 侧发起 read_session,可见性边界一直是
`RUNNER_SCAN_HOME`(用户自己设)——本次只是给既有能力加了一个 UI。设备侧
的自保开关不变:收窄 RUNNER_SCAN_HOME、或干脆不跑 Runner。

## 5. 测试

| 层 | 文件 | 覆盖 |
|----|------|------|
| rich 解析 | `plugins/sessions/src/parse-rich.test.ts` | 双格式配对/thinking/噪声过滤/截断/分页/flat 不变 |
| append 命令构造+执行 | `packages/runner/src/machine.test.ts` | argv 纯函数、参数校验、假 claude 全链(cwd/full-id/JSON 解析)、ENOENT 诚实报错、门禁 |
| 认证+范围 | `packages/bot/src/dashboard/server-sessions.test.ts` | 登录/登出/cookie、旧 token 行为回归、越权 403、本地源 list/read/search、append 四类拒绝 |
| 真 WS 全链 | `packages/bot/src/e2e/dashboard-sessions.e2e.test.ts` | 网关扇出 list/read/search、append 到假 claude、只读设备拒绝、离线设备报错、双设备去重 |
