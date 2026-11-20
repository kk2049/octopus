# @claude-bot/engine — v3 探针

> ⚠ **工作假设，非 ground truth**。本包是从活系统（hq/ops、devpipe pump、live.ts、session-view）提炼的探针实现，以实践修正。六个牵引问题（前端构造 / 按钮→逻辑 / MCP→同一逻辑 / agent⟷GUI 互感 / 状态机设计 / race 防治与一致性）的阶段性答案见 `doc/v3-probe-report.md`。
>
> **要写应用？读 `REFERENCE.md`**（一页纸 schema：app.yaml/页面/组件目录/handler 契约/locals/seed）。本文件讲哲学，那份讲语法——实验 #5 证明只有哲学没有手册时，开发者被迫逆向样例。

## 五原语

| 原语 | 文件 | 一句话 |
|---|---|---|
| StateStore | `store.ts` | per-(app,scope) append-only 事件日志，唯一 durable 真相 |
| Actions | `dispatch.ts` | 单门：按钮/HTTP/agent 工具都进 `dispatch()`，校验+谓词+署名只发生一次；handler 在沙箱进程里跑，拿到的是一次性的 `ctx.capabilities` |
| Projection | `projection.ts` + `runtime/sandbox.ts` | 纯函数 fold(events)→view，按 (revision, module mtime) 记忆化，**温热插**；执行在沙箱子进程内 |
| AgentPlane | `agent/plane.ts` + 三 adapter（`openai.ts` 进程内 loop、`cli.ts` claude-code/codex）+ `agent/session-view.ts`（统一中间层）+ `agent/shim-registry.ts`+`mcp-shim.ts` | agent = 有 inbox 的东西；一个 pump 管所有（consume-at-start/瞬时重试/并发上限/重启回捡）；**运行时按 agent 选 adapter/model/effort/MCP 授予**（`agents/<name>/config.json`，合并语义，⚙ 面板可改，下一轮生效）；CLI 面工具经 per-turn shim token 回环同一 dispatch 门；三种 loop 的日志归一成 `ViewEntry` 词表 → 富/简两种呈现共用；`ask_user` 内建问询卡；transcript/cursor/cli.json/last-mcp.json 落 `agents/<name>/` |
| Binding | `manifest.ts`（T2 数据：pages/locals/deadlines/flows）+ `cards/`（目录/双渲染器）+ `host/server.ts`+`host/factory-page.ts`（内核） | 页面 = 数据；`deadlines`=租约形时钟（引擎到点以 system:deadline 投事件，fold 保纯）；`/factory`=解剖/拖拽组装/prompt/MCP 授予工作台（保存过 loader 校验+落审计） |

## 已活体验证（2026-07-27 探针首日）

页面壳→SSE 订阅-投影-补丁→dispatch→双面渲染（web + 飞书卡 JSON）全链路；跨用户三道墙（写拒/读拒/admin 只读透镜）；纯函数改文件不重启生效；坏 YAML 保留旧配置+横幅报错；真 LLM（gpt-5.6-sol）聊天→pump→调 `close_item`（与按钮同门）→事件署名 `agent:hq/page@lht`。

## 两法则（写代码前先读）

1. **发现自动、授权不自动**：渲染给用户 U 的动作，U 的绑定 agent 自动可枚举可调（`listActions`）——走同一个谓词，事件署名 `agent:<app>/<agent>@<user>`。页面不铸造权限；谓词是**词表**（`any/owner/admin`）不是代码。`owner` 谓词 admin 不通过（代写=伪造署名，工单#15 口径）。`humanOnly` 留给死人开关类。
2. **热插拔是材质属性**：数据（manifest/page/连线）真热插；纯函数（投影/handler）按 mtime 重 import 温热插；内核（连接/pump/本包）drain 重启。

## 一致性模型

- 每 (app,scope) 一条**串行 dispatch 链**：读投影→跑纯 handler→一次 write 追加整批事件。race 靠结构消灭，app 代码零锁。
- 事件封皮 `seq/at/by` 由引擎盖章，handler 无法伪造署名。
- 崩溃撕尾：读侧跳过残行，下次 append 自动换行起笔（store.test.ts 有验证）。
- **一次 dispatch 只写自己那条日志**（SEC-01，2026-07-31）：`ActionResult.deliveries` 与 `InstanceDeps.deliver` 已删。原来那个口子同时错三样——写发生在 ControllerRun 关闭之后（不过任何 gate）、目标/事件类型/正文由 handler 自选、scope 又当文件路径片段（`../` 能改存储位置）。跨用户是**显式 operation**（`host/delivery.ts`：`send_report`/`reply_report`，effect=modify、`retrySafe: true` 因为按 `delivery_id` 幂等），走统一 Gate：收件人由可信目录规范化（不是路径）→ **收件方信箱的接收策略**（默认拒绝，只认显式接收授权）→ 授权条款放行或逐次批准 → 引擎写固定 envelope（作者 `system:delivery/<发送人>`）。存储层另有独立的根边界断言：app/scope 必须是标识符，日志路径必须落在 dataDir 内。

## 权限与运行时边界（本轮接线）

- **HTTP 层是 Fastify 的**（2026-07-30，迁移第③步，v3 先行）：`@fastify/helmet` 出全部加固头（**每一条回复**，不再只是走过 `send()` 的那些——原先 `json()` 应答的路由一个头都没有）、`@fastify/cookie` 管 cookie、`@fastify/cors` 直接吃 `allowedOrigins()` 算出的列表、body 上限交给 Fastify 的 `bodyLimit`（**在 handler 之前**就 413，坏 JSON 是 400 且永远不会变成一个空对象）。手写的 `send()`/`readBody` 已删。**if 链也已删（2026-07-30 收尾）**：每条路由注册到自己的方法，路径只在**路由表**里出现一次——此前它出现两次（注册一次、handler 里再 `if (p === ...)` 匹配一次），两张表必须一致，而不一致时**两个方向都静默**（注册了没匹配 = 掉到链尾 404；匹配了没注册 = 读起来像活的死代码）。这正是面板 P1-4 的形状。`Host.routes` 暴露 router 自己那份表，`hardening.test.ts` 拿它钉两件事：表 = 一份写下来的端点清单；表里每一条都真有 handler 跑起来（500 也算失败——`withViewer(this.apiAct)` 忘了重绑 `this` 就是这个症状）。**唯一还碰裸 `http.ServerResponse` 的是 SSE**：那条路由 `reply.hijack()` 之后自己写 socket，并在注释里说明。**v2 面板 2026-08-06（v4 Phase 2）也迁完了**（`packages/bot/src/dashboard/http.ts`，ADR `doc/adr/0004-dashboard-fastify-transport.md`），所以这一层不再是分叉的；content-type parser 的三条语义（空 body=`{}`、坏 JSON=400、非对象=400）现在由 `@claude-bot/web-trust` 的 `parseJsonBodyText` 提供，**两个 surface 注册同一份**。面板那边多踩到一个本 Host 没有的坑：装了 `@fastify/compress` 之后，一个 `async` handler 用 `reply.send()` 作答再 resolve `undefined` 会被 Fastify **再发一次**（body 变零字节），所以那边每条路由过一个 `return reply` 的包装、钩子写回调式并在作答后不调 `done()`。
- **身份来自会话**：`/login` 用配置里的 `users[].token` 换一张服务端 opaque 会话（+ CSRF secret）；bearer/query 仍可读，但**任何写路由**（`/api/act`、agent send/config、factory save、飞书回调）都要会话 + CSRF + 精确 Origin。凭据通道只有两条（`cookie`/`bearer`），Origin 比对是启动时算好的允许列表——见根 CLAUDE.md「简化以贴近框架」那段。
- **App 身份来自 handle**：开页面时服务端签发 instance handle，绑定 (owner, app, scope, SecurityContext, code digest)。`/api/act` **完全不读** body 的 `app`/`scope`；换代码 digest 即作废 handle 并销毁 App Context（不继承旧 slot）。
- **双 digest + 版本在使用点结算**（SEC-02，2026-07-31，`host/versions.ts`）：`codeDigest`（app.yaml + actions.ts + projection.ts + prompts/**）决定运行身份——变了就轮换 instance handle / App Context / Agent Context / 旧 pending；`presentationDigest`（pages/**）变了什么也不轮换（改文案不该让人重批一次审批）。`permissionContractDigest`（申请的 operations / auto-allow / 投递 operations / publisher）决定**持久授权**能不能继续用：**收窄自动生效，扩大 fail closed**（多出来的 operation 根本不 derive，直到有人 `GrantLedger.authorize()`），publisher 变了则一条都不继承。每动作/每 agent 的收窄**不在**这个 digest 里——plane 拿到的是查表函数不是枚举，digest 不该声称覆盖它读不到的东西；这不是漏洞，因为收窄只会从 `operations ∩ granted` 里减，而那个交集本身是被 digest 覆盖的（`HostCapabilities.contractOf` 里写明了什么时候该补上）。原来的 bug 是 `onSourceChange` 对 `.ts` 直接 return——沙箱按 mtime 重 import 了新代码，Context/handle/待批准却还是旧版本的。现在 `ensureFresh()` 在**每次取 instance / 取 digest 时**按 (mtime,size) 结算版本，watcher 只负责及时和发现新应用；handler 跑一半时文件被改 → 本次调用作废、不落任何事件。声明坏掉但可执行文件没动 = 继续跑上一版（老行为保留）；**声明坏掉且可执行文件也动了 = 该应用 halt**（证明不了跑的是哪一版就不跑）。halt **也会**销毁 handle、Context 和待批准——比较用的是「现在可以跑的那个身份」（halt 时为空串）而不是记录下来的 `code`：halt 不移动 `code`，按 `code` 比较等于一个都不撤，那张卡随后仍能被批准执行，正好是「证明不了哪一版就不跑」的反面。同理，handler 跑一半时**变成 halt** 也算版本变了，该次调用作废。
- **v3 Host 今天的 grant 仍是运维配置**（`GrantLedger.seed(source:"config")`，进程内、随启动重建）。ledger 加的不是一个假装存在的授权后端，而是「声明 ≠ 已授权」这条比较：扩权必须有人点头。`HostCapabilities` 只依赖窄 `GrantResolver` 接口，并在派生 App Context 时把已认证 owner 传入；`GrantLedger` 明确忽略 owner，因而旧 Host 行为不变，而需要账户级持久授权的组合可以实现同一接口，不能另开判定路径。
- **Context 链**：`HostCapabilities` 把 account → AppInstance → ControllerRun / AgentRun 物化成 `derive`。handler 只拿 `ctx.capabilities`（一次 dispatch 的绑定 facade，跑完即销）；agent 每轮一个 AgentRun Context，工具调用从**它**再派生。
- **浏览器分成两个信任域**：Trusted Host（同源，持 Session/CSRF/instance handle，**不渲染任何应用数据**）+ Agent View（`sandbox="allow-scripts"` 的 iframe，opaque origin，CSP `default-src 'none'; connect-src 'none'`）。两者之间**唯一被支持的应用协议**是那条转交过去的 `MessagePort`，View 只能**提议** `{action, params}`，Host 用自己的绑定替换其中一切身份字段。View 的**脚本**永远拿不到 CSRF secret、instance handle 与 cookie（opaque origin，`document.cookie` 直接抛）。两条不要说过头的：`connect-src 'none'` 管的是**主动连接 API**（fetch/XHR/WebSocket/EventSource），不管**自导航**；而 frame 的那次**导航请求**本身是普通请求，会带上服务它的那个 host 的 cookie（沙箱约束的是文档，不是请求）——本 Host 的 view 是同源路由，所以这条在这里是设计上接受的，Session Plus 那种承载不可信包的场景则必须换主机名。
  - **这套 frame 契约现在是共享的**（2026-08-04，`@claude-bot/web-trust/frame.ts`）：sandbox token 集合与那份 CSP 由 `viewFrameCsp`/`viewFrameHeaders` 一处给出，本 Host（`frame-ancestors 'self'`，同源 view）与 bot 侧的 Session Plus（跨 origin，精确 ancestors 列表）是**同一个决定的两种部署**。`frameAncestors` 里出现 `*` 直接抛错——通配在两个方向上都是洞（主站 `frame-src` 通配 = 框住任何包；App 域 `frame-ancestors` 通配 = 任何页面都能框住这个视图并驱动它）。
  - **登录 cookie 的名字也不再是本文件的常量**：`hostCookies(publicUrl)` 与面板共用 `cookieContract()`——https 部署发 `__Host-v3s`/`__Host-v3csrf`（浏览器因此会拒绝同名的 `Domain` cookie），http 部署发不带前缀的一对（`__Host-` 要求 `Secure`，而 http 上 Secure cookie 永远不会被送回）。旧名字 `v3t` 只清不读。
- **渲染器只有一份**（`cards/view-js.ts`）：文本与带引号属性走 `esc`，class/mode/id 这类裸 token 走**白名单** `tok`（改坏的属性仍然是属性），widget 与 allowed-action 查表用 `hasOwnProperty`。
- **应用代码跑在 Hardened JavaScript 的 Compartment 里**（`runtime/sandbox-child.mjs`，2026-07-30 从「Node 权限模型 + netns」迁过来）：`lockdown()` 之后，**一次调用一个新 Compartment**，作用域里只有 JS 语言 + 一张短到能读完的 endowment 表（冻结的 `Date`、`console`、以及本次调用那一个**可撤销**的 capability facade）。`fetch`/`process`/`require`/`setTimeout`/`node:*` **不是被拒绝，是不存在**；`import` 全走我们的 module map（只认应用目录内的相对路径），`eval`/`new Function("…import…")` 在编译期就被 SES 拒掉。语法手册里那张表就是完整边界。
  - **两个机制都承重**：新 Compartment（调用之间没有共享模块作用域）+ 调用结束即 `revoke()` facade。少哪个都漏——`compartment-facts.test.ts` 里留着**反事实**：复用同一个 Compartment 时，`weak` 留下的微任务从模块变量里读到 `strong` 的活 facade，实测花掉 17 次它从没被授予的 `exec`。
  - 子进程还在，但**不再一次调用一个**（稳态 ~2ms/次 vs ~35ms/次；子进程首次启动 ~690ms，其中 `@endo/module-source` 的 JS 解析器约 500ms，一个 (app,scope) 只付一次，约 20 次调用回本）。它现在的三个理由：给 `lockdown()` 一个不含 better-sqlite3/飞书 SDK 的领域；兜住 Compartment 管不了的算力（跑飞的微任务卡的是它，不是 Host）；万一 Compartment 被逃逸，落地的地方是净化过的 env + 无句柄 + 权限模型仍开。**起不来就不跑**，没有进程内回退。
  - fd 3 通道从「可达但不认证」变成**不可达**：写它需要 `node:fs` 或 `process`，应用两个都没有。所以帧只由子进程里的可信管理代码写，`forId` 是它盖的章而不是调用方的主张——这才是一个进程可以同时服务多个安全上下文的原因。
- **部署执行分类**（`runtime/deployment.ts`，SEC-06，2026-07-31）：这台宿主是哪一类，由**运维配置**决定，应用与浏览器都无法自我声明。`cloud-multi-user`（缺省）里**普通 App 的 Agent 后端不得是 `claude-code`/`codex`**；`local-owner` 是单人信任域（保留 CLI，启动即打印「不提供多用户文件隔离保证」）；`trusted-service` 不承载普通 App Agent。它与下面那条**是组合不是合并**，而**顺序就是安全内容**：profile 先答，所以 `secure_mode: false` 到不了这个判定。两种拒绝带不同的 code（`profile_forbids_coding_cli` / `secure_mode`），因为只有后者有开关。唯一的谓词 `appAgentAdapterVerdict` 守住 manifest 加载（**启动即失败**，不是第一轮才提示）、⚙ 运行时覆盖、`send()`、transcript 视图与轮次本身；轮次那一处是迁移场景（旧 `config.json`），**fail closed 且不消费 inbox，刻意不改写成 `openai-loop`**——悄悄换模型就是悄悄换费用与行为。不受禁令影响的是**用户自己机器上已有的 CLI 会话**（Session Hub）、`system:dev-factory`、显式 `local-owner`，所以 `CliLoop` 没有从共享库里删掉。`executionInventory()` 报 `appReachableCodingCli`，那是审计要看的数。
- **安全模式**（`runtime/secure-mode.ts`，默认开）：现在**只管一件事**——`claude-code`/`codex` adapter 以 `--dangerously-skip-permissions` + 宿主全量 env + 同一 OS 用户启动 CLI，是一条完整的绕过通道，因此默认**不可用**（轮次 fail closed 且不消费 inbox，⚙ 面板拒绝选它，v3-host 根本不构造它）。要用必须 `secure_mode: false`，启动即打印"本进程不处于受保护模式"。**应用运行时不再受它管**：迁到 Compartment 之后边界一直在（不像 netns 那样"本机提供不了就只能拒绝启动"），所以 `V3_ALLOW_UNCONFINED_APP_RUNTIME` / `V3_APP_SANDBOX_WRAPPER` / `runtime/confinement.ts`（237 行）整套已删——它们存在的唯一理由是 Node 权限模型不管 socket。
- **`extraMcp` 默认拒绝**：直接交给 CLI 的 MCP 绕过引擎，目录项必须显式写 `trust: sandboxed` 才可授予；其余在保存时报错、在轮次里丢弃。
- **仍然没解决**：①**算力与内存是共享的**——应用留下的微任务循环在它那次调用返回之后还在烧 CPU，endowment 表管不了这个；靠每次调用的超时（杀掉并重起子进程）+ `maxCalls` 定期回收兜。这是可用性代价，不是权限代价。②**Compartment 逃逸（JS 引擎 bug）就是这个子进程的完全失守**——所以子进程留着。③子进程与 Host 同一个 OS 用户；要更强得上容器或独立 uid。

## 已知债/边界

- 单进程契约：所有写者都在进程内（无 flock；带外写者只触发全量重读，不保护并发）。
- 投递的残余边界：`ensureFresh` 是 stat 级检查（每请求几次 `statSync`）；handler 执行**期间**改文件仍会让该次调用作废，但它在作废前已经发出的 capability 调用不会被撤销（没有东西能撤销它们，它们是按开始时那一版 gate 过的）。跨用户投递本身是本地为真、目标写入失败不回滚——但失败会记进发送方日志（`delivery: failed`），不再假装发出去了。
- 热插不再有陈旧缓存：每次调用新建 Compartment，只有**解析后的 ModuleSource** 按 (path, mtime) 缓存（parse 约 5ms，实例化约 0.4ms），所以改完文件下一次调用就是新版本，旧版本连模块作用域都不留。
- deliveries 崩溃窗口：本地已写、对端未达 → 可见可修，不做分布式事务。
- pump / llm fetch 从 bot 包**复制**而非抽取（探针期决定，回并是记录在案的债）。
- openai-loop 面不吃 MCP 授予（进程内无 MCP 客户端）；codex 会话发现法在同主机并发 codex 时有抢错窗；claude/codex 日志格式私有，session-view 全防御解析、认不出即跳过。
- codex exec 的 stdin 必须关（管道下它会无限等 EOF）——已在 `run()` 修，动那段前先读 §9 困难记。

## 测试

```bash
npx vitest run packages/engine
npx tsc --noEmit -p packages/engine/tsconfig.json
```
