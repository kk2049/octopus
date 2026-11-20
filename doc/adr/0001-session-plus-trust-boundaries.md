---
decision_status: accepted
realization_status: implemented
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0001 — Session Plus 的浏览器信任域、进程边界与数据归属

> 状态：**已接受**，随 M0/M1 实施落地（2026-08-04）
> 适用范围：`session-plus` 这个第一方 Agentic App 探针，以及它给主站带来的连带改动
> 上位文档：`doc/development/session-plus-agentic-app-roadmap.md`（产品契约）、
> `doc/development/session-plus-m0-m1-implementation-brief.md`（本轮任务书）
> 实施记录：`doc/development/session-plus-m0-m1-worklog.md`

---

## 1. 背景与决策要解决的问题

Session Plus 的目的不是再造一张会话页面，而是**用真实复杂度检验隔离**：一个由 Agent
生成、将来可能由普通用户分发的应用，能不能在不触碰主站凭据、不共享主站进程命运的前提下
提供有用的界面。

那要求先把三件事钉死，之后 M2–M6 的设计自由度都在这三件事之内：

1. 浏览器里哪些东西属于可信外层，哪些属于不可信视图；
2. 应用代码跑在哪个进程里、坏掉会带走什么；
3. 状态归谁写、谁读。

本 ADR 记录这三件事在 M0/M1 的**已实施**结论，以及每条结论**当下的诚实边界**。

---

## 2. 四种 identity，绝不互相推导

```text
stableAppId              = session-plus          状态与授权的主键
publisher                = octopus:first-party   谁为这份包背书
packageDigest            = sha256(被服务的 assets)  运行身份，编进主机名
permissionContractDigest = sha256(申请的权限契约)    决定持久授权能不能继续用
```

代码在 `packages/bot/src/session-plus/identity.ts`，四个值分别有测试钉住。

**为什么必须分开**：

- 状态与授权按 `stableAppId` + publisher 记账。换一次构建就换一个 URL，**不能**因此
  丢掉应用的历史，也不能悄悄变成第二个应用。
- `packageDigest` 是运行身份：它编进主机名
  `app-<digest 前 20 位>.apps.<域>`，所以「那个 iframe 里跑的是哪一版代码」可以**从地址栏
  回答**，而不是从部署日志回答。改一个字节 → 换 origin → 旧 frame 与新 origin 跨域 →
  任何缓存下来的文档属于一个已经没人服务的主机。
- `permissionContractDigest` 回答的是另一个问题：**它要什么**。两者答案不同步——代码变了但
  契约没变，可以保留用户授权（引擎侧 `host/versions.ts` 早就是这条线）；契约**扩大**必须
  fail closed。若由其中一个推导另一个，则「改错别字」会看起来像权限变更，而「权限变更」会
  看起来像一次普通发版。

M1 的权限契约是**空的**：页面只渲染假数据、只提议假动作。空契约仍然有 digest，因为「空」
是一个会变的值，M3 接上 `list_sessions` 时它是一次可见的 diff 而不是从零长出来的东西。

---

## 3. 浏览器：两个信任域，一条通道

```text
https://bot.example.org                     ← 可信 Dashboard Shell
┌─────────────────────────────────────────────────────────┐
│ 导航 | 身份 chip | 退出 | 批准 pill                       │
│ 浏览器 Session（__Host- cookie）· CSRF · 未来的 handle    │
│                    │ 一条转交的 MessagePort(唯一被支持的  │
│                    │ 应用协议;自导航见 §3.5)              │
└────────────────────┼────────────────────────────────────┘
                     ▼
https://app-<digest20>.apps.example.org     ← 不可信 Agent View
┌─────────────────────────────────────────────────────────┐
│ sandbox="allow-scripts"（不含 allow-same-origin）         │
│ 无 Cookie · 无 CSRF · 无 handle · 读不到父页 DOM           │
│ 主动联网 API 全被挡；只渲染 projection，只**提议**动作      │
└─────────────────────────────────────────────────────────┘
```

### 3.1 为什么是独立 origin，而不是主站的一个路径

先把话说准（这一段原先写错了，2026-08-04 改正）：`sandbox="allow-scripts"` 而**不含**
`allow-same-origin` 时，被框住的文档拿到的是一个 **opaque origin**——它读不到父页 DOM，
`document.cookie` 甚至会抛 `SecurityError`。所以「同源路径上的 iframe 能读主站 DOM」对
**这个已经沙箱化的 frame 而言是不成立的**，写成那样是一句错话。

独立 origin 买到的是另外两件**它确实买到**的东西：

1. **那次导航本身。** 沙箱作用于**文档**，不作用于**请求**：如果 View 的 URL 在主站主机上，
   浏览器发出的那一次（以及此后每一次自导航）HTTP 请求都会带上该主机的 Cookie。文档随后
   拿不到它们，但它们已经离开浏览器、进入了服务端与沿途的日志。Cookie 按 **host** 划分，
   不按 origin、不按端口——所以只有换主机名才挡得住这件事，换端口不行。
2. **不是只剩一个 HTML 属性。** 同源方案里，两个信任域之间只隔着 `sandbox` 这一个属性：
   第一个为了「修滚动条」加上 `allow-same-origin` 的人，会在没有碰任何名字里带 security 的
   东西的情况下同时打开 Cookie、DOM 与凭据。独立 origin 让**浏览器**执行边界，
   sandbox 属性是第二道锁而不是唯一那道。

这也是 §3.5 那条残留为什么只能被「独立、且只发布静态文档的 origin」收住。

### 3.2 App 域的响应契约（`packages/web-trust/src/frame.ts`，两个 surface 共用）

```text
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-<每次响应新生成>';
  style-src  'nonce-<同上>';
  img-src data:;
  connect-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors <主站的精确 origin>
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cache-Control: no-store
没有 Access-Control-Allow-*
没有 Set-Cookie
```

`frame-ancestors` 是**精确 origin 列表**，`viewFrameCsp()` 对任何含 `*` 的条目直接抛错。
理由是两个方向都会漏：主站 CSP 的 `frame-src` 写通配就等于允许框住**任何**包；App 域的
`frame-ancestors` 写通配就等于允许**任何页面**框住这个视图并驱动它。

`connect-src 'none'` 挡住的是**主动联网 API**：`fetch`、`XMLHttpRequest`、`WebSocket`、
`EventSource`（真浏览器逐条验过）。它**不**阻止一个被框住的文档导航自己的 browsing
context——这一条见 §3.5，并且是本轮实测出来的，不是推断。所以可执行的说法是收窄过的那句：

> **MessagePort 是唯一被支持的应用协议；主动连接 API 与外部目的地都被挡住；自导航是浏览器
> 的一个残留，被限制在第一方静态发布 origin 内，并在那里 fail closed。**

视图自己在页面上做一次 fetch 自检并显示结果，所以一个放宽了 `connect-src` 的部署会在人正在
看的那个页面上说出来。

### 3.3 握手与通道

- View 加载后向 `window.parent` post 一个常量字符串（`targetOrigin: "*"`——沙箱 frame 是
  opaque origin，说不出父页 origin，父页也匹配不了它的）。
- 可信外层**只认自己创建的那个 window**（`event.source === frame.contentWindow`），一代只
  转交一个端口，重复握手被计数并忽略。另外校验 `event.origin === "null"`——那是**绊线**不是
  第二个身份：沙箱 frame 的 opaque origin 就序列化成这个字符串，报别的值说明沙箱被改过
  （比如有人加了 `allow-same-origin`），而没有这条检查的话那种改动在运行时**什么都不会变**。
- 反方向也校验一次：视图**只接受来自 `window.parent` 的**端口。今天没有别的窗口够得着它，
  但同 origin 的兄弟 frame 可以通过 `parent.frames[]` 找到它并抢先塞一条自己的通道，而先到的
  那条就是它会留下的那条。
- 每个端口闭包持有它那一代的 generation：重建之后旧端口既被 `close()`，其消息也被 generation
  判据丢弃。两个机制都承重，测试各钉一条。
- Boot payload 的权威数据只有 `{t, protocol, projection}`；此外可带无权限的 `appearance` 与
  有界 `recovery` 展示提示。`recovery` 是 View 自己发布、可信外层按账户保存在当前标签页
  `sessionStorage` 的 opaque 字符串；它不含身份、凭据或 canonical path，View 重收后必须用当前
  projection 重新验证每个会话 ref，所有实际读取仍重新走 proposal/Gate。payload 没有浏览器
  session、CSRF、instance handle、owner 或 scope。浏览器端测试直接把浏览器此刻持有的真实 cookie 值拿去比对，
  确认它们没有出现在跨过边界的字节里。
- 视图提议里带的 `owner`/`app`/`scope`/`instance`/`approved` **不被读取**（不是被校验——
  校验意味着存在一个视图能发、而我们会相信的值）。可信外层用自己的 `HOST_BINDING` 作答，
  回执里不含任何身份。

### 3.4 主站 Cookie 迁到 `__Host-`

生产：

```text
__Host-octopus_sess: Secure; HttpOnly; Path=/; 不得出现 Domain
__Host-octopus_csrf: Secure;           Path=/; 不得出现 Domain（故意不设 HttpOnly）
```

`__Host-` 前缀的价值只有一句话：**浏览器会拒绝任何带 `Domain` 的同名 cookie**。开放了不可信
sibling 子域之后，真正的新风险不是「cookie 被偷」，而是「cookie 被**种**」——一个能写
`octopus_sess=…; Domain=example.org` 的兄弟主机可以对主站做会话固定。

由此推出三条实现约束（`packages/web-trust/src/cookies.ts`，面板与 v3 Host 共用）：

1. **名字与属性一起决定**。`__Host-` 要求 `Secure`，所以名字由**设置 `Secure` 的那个布尔**
   （`cookieSecure(public_url)`）挑选。序列化时断言：`__Host-` 而没有 `Secure`、或带
   `Domain`、或 `Path` 不是 `/`，一律抛错——那样的 cookie 浏览器根本不会存，症状只会是
   「登录莫名其妙不生效」。
2. **旧名字是 retired，不是 sibling**。登录与退出都清掉它们，且**永不读取**。留着旧名字可读
   正好就是前缀要堵的那个绕过（攻击者用旧名字 + Domain 种一个，服务端热心地接受）。
   只持有旧 cookie 的浏览器看到登录页，重新粘一次密钥——这是所有框架在会话格式变更时的做法。
3. **本机开发是另一个部署，不是弱化版**。http 上 `__Host-` 用不了（Secure cookie 不会被送回），
   所以那里用不带前缀的一对，启动与页面都明说。生产 https 永远是前缀版。

顺带删掉的一处：共享 `auth_token` 登录时原本会写 `octopus_dash=<原始 bearer>`，而
`identify()` **从来不读它**——一个长期凭据白白存在浏览器里。现在改成清除。

### 3.5 实测出来的一条残留：自导航（2026-08-04 修正）

**先说结论**：在 Chromium 1.62 上实测，`connect-src 'none'` 确实挡住了 `fetch` /
`XMLHttpRequest` / `WebSocket` / `EventSource`；但它**没有**挡住 View 把**自己**的
browsing context 导航到**自己那个 origin** 并带上 query。探针跑过，View 监听器真的收到了
`/?leak=projection-secret`。Chrome 1.62 把 `navigate-to` 报成无法识别的指令，所以**不能**
加上它然后声称修好了。

因此 M1 的诚实处置是三条，都已实施：

1. **外部目的地由可信外层的精确 `frame-src` 挡住。** 这是浏览器执行的，有真浏览器回归测试：
   View 尝试导航到第三方 origin 时，那个 origin 上的服务器**一次请求也收不到**。
2. **第一方发布 origin 只服务那一个裸文档 URL。** 任何 query、任何别的路径、任何非 GET/HEAD
   方法一律 404，**并且绝不重新发出应用代码**（`view-server.ts`）。

   **整个 request target 都是攻击方可选的，不只是 query**（这一条是第二轮复核的修正）：
   `/?leak=secret` 与 `/leak-就是路径` 携带信息的能力完全一样。所以两者都被拒绝，而且
   **两者都不被记录**——我们的代码不写 `req.url` 的任何部分，连长度都不写，因为长度本身也是
   一个信道；计数器 `refusedTargets` 是这条残留的**全部**信号（计数器装不下 payload，日志行
   装得下）。同理，反代示例里 App 域的访问日志**关掉**，而不是「只留路径」——「只留路径」不是
   一个安全的中间选项，它记录的正是另一半信道。这个 origin 上没有任何 App 自有的 API 或后端
   可以指向。
3. **仍然剩下的**：那次请求本身确实发生了。我们移除的是**记录**，不是**报文**——能观察连接的
   人依然能观察到它。它只可能携带**已经被 declassify 给这个 App 包的东西**（见下），而且落在
   一个只会回 404 的第一方静态 origin 上。这是 M1 的边界，不是一句「已修复」。

**declassification，写成一条规则**：凡是经 MessagePort 交给 View 代码的东西——projection、
动作回执、状态——**一律视为对该 App 包解密（declassified）**：它可以泄漏，我们按「已经泄漏」
来设计。凭据、authority、浏览器 Session、CSRF、instance handle **永不 declassify**，
所以它们不出现在 boot payload、不出现在回执、也不出现在任何 frame URL 里（有测试拿浏览器
此刻真实持有的 cookie 值逐一比对）。M1 declassify 的全部内容是**假投影**。

---

## 4. 进程边界：M1 的诚实限制与 M2 的接缝

**现状（M1）**：Agent View 由**控制面同一个进程**提供，只是监听在另一个端口、以另一个主机名
对外（`packages/bot/src/session-plus/view-server.ts`）。所以：

- 它确实是**另一个 origin**（浏览器边界成立，本轮全部负向测试都基于这一点）；
- 它**不是**另一个故障域：这个进程崩了，控制面与视图一起没。

M1 不假装解决后者。包是静态的，没有应用代码在服务端跑，所以此刻**没有可隔离的东西**；
提前引入一个进程只会得到一个没有内容的进程边界。

**M2 的接缝**写在类型里而不是注释里：配置块 → `resolveSessionPlus()` → `SessionPlusSettings`
→ `new SessionPlusViewServer(settings).start()/stop()`。M2 把这个类换成 App Orchestrator
的客户端（可杀、可重建的 SES worker + 独立 State Service），`bootstrap-v3.ts` 的构造与停机
两行不变。

**反向代理必须做的那件事**（见 §6）：把 App 域的 `Set-Cookie` 剥掉。服务端本来就不发，
这是纵深：将来任何一个中间件、任何一次误配都不该让那个主机名开始持有 cookie。

---

## 5. 数据归属

| 数据 | 归谁 | M1 现状 |
|---|---|---|
| 浏览器 Session / CSRF / 未来的 instance handle | 可信外层 | 已实施：`__Host-` cookie，View 拿不到 |
| projection（视图渲染什么） | 可信外层撰写，投递给 View | 已实施：`demo-projection.ts` 的假数据 |
| 当前选中项、草稿 | View 的本地状态 | 草稿只在 iframe 内；最多四个当前投影会话、活动会话、Dock 展示与手机层可作为无权限恢复提示交给可信外层的账户隔离标签页存储 |
| App durable state（收藏、标签、偏好） | 独立 State Service | **未实施**（M2） |
| Runner transcript | 用户设备 | 不复制进 App 状态（路线图第六节） |

M1 没有任何持久 App 状态，这是刻意的：状态服务的提交协议（临时文件 → fsync → 原子 rename →
目录 fsync → SQLite 事务）是 M2 的内容，在没有真实事件之前实现它只会得到一个没人写的日志。

---

## 6. 部署契约（DNS / 反向代理）

```text
DNS:  bot.example.org            A  <本机>
      *.apps.example.org         A  <本机>        ← 通配 DNS，证书用通配或按需签发

反代:
  https://bot.example.org              → 127.0.0.1:9820   （控制面）
  https://app-<digest20>.apps.example.org → 127.0.0.1:9821（Agent View）
        · 必须原样透传 Host 头（监听器会校验它，不匹配答 421）
        · 必须剥掉上游响应的 Set-Cookie（纵深；服务端本来就不发）
        · 不要加任何 Access-Control-Allow-* 头
```

可直接抄的片段：`doc/deploy/session-plus-proxy.example.conf`（Caddy 与 nginx 两份）。

**本轮不做、也不允许做的事**：不改线上 `/etc/caddy/Caddyfile`、不部署、不重启、不移动 `v3`
水位线。上面这段是**契约**，落地是一次独立的运维动作。

**通配 DNS 与「换一次代码就换一个主机名」怎么共存**：`*.apps` 的通配记录让新 digest 立刻可用，
不需要每次发版改 DNS。证书用通配证书（或反代按需签发）。这条是运维选择，不影响浏览器边界。

---

## 7. 同一 registrable site 是部署选择，不是发布者信任边界

`bot.example.org` 与 `*.apps.example.org` 是不同 **origin**，但同一个 **site**
（`example.org`）。site 层面共享的东西是真实存在的：cookie 的 `Domain` 作用域、
`SameSite` 的判定、以及若干以 site 为粒度的浏览器分区。

对当前第一方 Demo，配合

- `__Host-` cookie（同名 Domain cookie 被浏览器拒绝）；
- 精确 Origin 允许列表 + CSRF 双提交；
- sandbox opaque origin（View 没有可用的 cookie jar）；
- App 域完全不设 cookie、不开 CORS、`connect-src 'none'`；

是可接受的：能被 site 边界削弱的那几条，我们都没有依赖。

后续讨论修正了本 ADR 的早期结论：**运行第三方发布者的 JavaScript 并不以迁到另一个
eTLD+1 为前置条件**。用户选择信任一个发布者/源码包后，交给那个包的 projection 本来就应按
「已向发布者披露」处理；cross-site 不能把已经交给代码的数据变回秘密，也不是 capability
边界。真正的权限边界仍然是：主站凭据和 authority 不跨 iframe，动作只能经可信管线重绑身份并
进入统一 Gate。

另一个 eTLD+1 仍然是有价值的**纵深配置**：它让 `SameSite` 与 site 分区再提供一层隔离，尤其
适合允许发布者自带 JavaScript 的运行 profile；但不是对所有第三方 App 的一刀切上线门槛。
平台可以同时支持声明式 renderer 与 publisher-JS 两种 profile，并在用户信任提示里明确展示。
发布者信任、源码透明、版本更新与 capability grant 的完整决策见
`doc/adr/0002-agentic-app-publisher-trust-and-capability-grants.md`。

---

## 8. 回滚

- **feature flag 关闭**（`session_plus.enabled: false` 或整块缺席）= 路由 404、导航无「会话+」、
  第二个监听器**不被构造**、inventory 里 `sessionPlus: null`。启用与否之外，部署与之前逐字节相同
  （有测试比对两台面板的 `/sessions`）。
- **`/sessions` 从未改变**：渲染器、传输、grant、API、默认落地页都不动。它继续是稳定能力与
  回滚面，这是路线图的硬性要求。
- **配错即拒绝启动**：`enabled: true` 但 origin 不合法/主机名与 digest 不符/缺 `public_url`，
  进程拒绝启动并打印本次构建应当使用的主机名前缀。安静跳过会让运维以为功能开着。
- Cookie 迁移的回滚代价要说清楚：回退到旧版本后，浏览器持有的 `__Host-` cookie 不会被旧版本
  读取，用户需要重新登录一次。会话本身在库里，没有数据损失。

---

## 9. 本 ADR 明确**没有**决定的事

- App Orchestrator / State Service 的进程模型与提交协议（M2）；
- `SessionResource` Object、`start_session` / `list_session_workspaces` 的参数与审批文案（M3/M4）；
- 用户级 App grant 的存储与同意流程（M5，接缝仍是 `GrantLedger.authorize()`）；
- App Store、包签名、第三方发布（明确不在本阶段）。

其中第三方发布的**信任模型**已在 ADR 0002 决定；注册、签名、审核与分发机制仍未实施。

M2–M6 可以在上面这些空白里自由设计，但**不得**改变 §3 的浏览器边界、§3.4 的 Cookie 契约、
§2 的 identity 分工——那三件是本轮固定下来、并且有负向测试守着的东西。
