---
decision_status: accepted
realization_status: implemented
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0004 — Dashboard 的 HTTP 传输层交给 Fastify

- 状态：**已实施**（2026-08-06，v4 Phase 2）
- 影响面：`packages/bot/src/dashboard/{http,server,schemas}.ts`、`packages/web-trust/src/gate.ts`
- 前一步：[ADR 0003](./0003-dashboard-react-frontend.md)（浏览器层改 React）
- 相关：`doc/handover-security-migration.md` §10–§12、§18（v3 Host 先走过同一条路）

---

## 1. 为什么

面板的服务端曾经自己实现整层 HTTP：`createServer` 回调、一条按
`req.method` + `url.pathname` 逐个 `if` 判断的约 900 行分发链、一个既缓冲又 gzip
又负责加固头的 `send()`、架在它上面的 `json()`、以及一个读有界 body 的 `body()`。

这些都是**通用 HTTP 基础设施**，每一样都有一份公开的已知失效清单，而且每一样在本仓库
里都已经真的出过事：

| 手写件 | 它产生过的缺陷 |
|---|---|
| `body()` | 答完 413 之后返回 `{}`，handler 照跑——超长 POST `/api/deploy` 真的部署了缺省目标 |
| `send()` | 加固头只加在**走过这个 helper** 的回复上 |
| if 链 | 路径在两处出现（分发 + 路由表），不一致时两个方向都静默 —— 这正是 P1-4 的形状 |
| 手写 gzip | `gzipSync` 跑在事件循环上 |

判据不是行数，是「已知失效模式有没有被别人编码进去」（`dev-conventions.md`）。答案是有：
`fastify@5` 的路由器、`@fastify/helmet`、`@fastify/compress`、Fastify 的 `bodyLimit` 与
content-type parser。而且**仓库里已经有先例**——v3 Host 2026-07-30 走的就是这条路，两个
surface 用同一套框架比用两套省一次学习和一次审查。

## 2. 决定

### 2.1 装配：`dashboard/http.ts`

一个 `buildPanelApp()`：插件、content-type parser、错误处理、404 处理、加固头钩子。
路由**不在这里**注册——那是 `server.ts` 的事，分开是为了让「哪些路由在门后面」是一个
结构问题。

用的插件与**明确不用**的插件（每一条都要能说出理由，见 `http.ts` 顶部注释）：

| 用 | 为什么 |
|---|---|
| `fastify@5` | 路由表、生命周期、`bodyLimit`、schema 校验 |
| `@fastify/helmet` | 加固头上到**每一条回复**，包括没人记得的那条 |
| `@fastify/compress` | 流式、正确协商 q 值/`identity`/`x-no-compression`，不占事件循环 |

| 不用 | 为什么 |
|---|---|
| `@fastify/cookie` | Cookie 名字与属性由 `@claude-bot/web-trust` **一起**决定（`__Host-` 要求 `Secure`，少了它的删除会被浏览器丢掉）。第二份序列化器正是那份契约要消灭的漂移 |
| `@fastify/session` 等会话插件 | 已经有一套服务端 opaque 会话：可撤销、idle + 绝对过期，并且 Context / 流 / 租约都按它派生的 credential handle 绑定 |
| `@fastify/cors` | 面板从来不发 `Access-Control-Allow-Origin`；它算出的 Origin 允许列表是给 mutation gate 用的，不是给浏览器预检用的 |
| `@fastify/static` | `assets.ts` 已经做了解析 + canonical 校验 + 扩展名白名单，无目录列表、无 index 回退。通用静态插件要被配置**回**这个形状 |
| `@fastify/rate-limit` | 反代之后所有请求共用一个 socket 地址，唯一能区分人的键是凭据；按别的键限流会把不同用户合并 |

Fastify 的三个非默认配置，每个都是安全内容：

- `trustProxy: false`——devpipe 的回环判定与 cookie 的 `Secure` 标志都是本进程对**自己
  所在网络**的判断，转发头是调用方写的字。回环判定另外直接读 socket 地址。
- `exposeHeadRoutes: false`——授权表里没有 HEAD 规则，自动派生 HEAD 会造出「路由到了、
  门又拒绝」的路由，读起来像是被服务的。
- `ajv: { coerceTypes: false, useDefaults: false, removeAdditional: false }`——**会改写请求
  的 schema 没有校验请求**。开着强制转换，`{persona: {}}` 会变成字符串 `"[object Object]"`，
  声明的类型什么也没说。

### 2.2 两个 scope，而不是一张豁免名单

```
root:  parsers / helmet / compress / errorHandler / notFoundHandler / onRoute 记录
 ├─ register(pre)      onRequest = surface 门（按路由声明的 PRE_ROUTES id）
 │    /ui/*  /login  /logout  /download/runner.js  /api/devpipe/*
 └─ register(guarded)  onRequest = identify → mutationGate → authorizeRoute → 303
      其余全部
```

Fastify 的 scope 是**封装**：注册在 `guarded` 里的路由跳不过那个钩子，注册在 `pre` 里的
路由**看得见**地在外面。这比「gate 里按名字豁免五条路径」强，因为后者的失效是一条新路径
被悄悄加进豁免。

### 2.3 钩子的位置就是安全内容

Fastify 的顺序是 `onRequest → preParsing → 解析 body → preValidation → 校验 → preHandler →
handler`。门放在 **`onRequest`**，也就是 body 被读之前，所以：

- 没有凭据 + 坏 JSON = **401**（不是 400）；
- 没有权限 + 少字段 = **403**（不是「你少了一个字段」）；
- 表外路径 + 任何 body = **404**。

body 里才有目标账号的路由（`api.settings` / `api.sessions.append` / `api.permissions.*` …）
保持两段式：粗粒度授权在门里对**调用者自己的账号**做，handler 解析出真实目标后再问一次
**同一份** `mayRead` / `mayWriteAs`。

### 2.4 路由表与授权表的双向一致

每条路由在 `config.routeId` 上声明它按 `authz.ts` 的哪条规则被服务；`DashboardServer.routes`
把 Fastify 自己那份表暴露出来；`dashboard/routes.test.ts` 双向走它：

1. 每条**注册的**路由都声明了一条存在的规则（没有无规则的 handler——P1-4 的形状）；
2. 每条**规则**都有路由（没有无 handler 的规则——读起来像被服务、实际 404）；
3. 对每条路由，**路由器匹配到的规则**与**表对同一条具体路径匹配到的规则**是同一条。

门本身仍然按**路径**问表，而不是读声明的 id：两者一致由上面的测试证明，而直接问表让两个
方向都 fail closed。读 id 会把第 1 条变成一条自己给自己授权的路由。

### 2.5 `panelHandler` 与回调式钩子（一个不明显的坑）

Fastify 的 `wrap-thenable.js`：一个 `async` handler 如果通过 `reply.send()` 作答然后
resolve 成 `undefined`，Fastify **会再发一次**（它只在 payload 有定义、或 socket 已经写完
时才跳过）。不压缩时第一次发送是同步完成的，第二次是 no-op，什么也看不出来；**压缩之后**
第一次发送是一条还没跑完的 pipeline，第二次赢——页面 200、每个头都对、body 零字节。

所以：

- 每条路由都过 `panelHandler()`，由它 `return reply`，而不是四十个 handler 各自记得；
- 两个 `onRequest` 钩子是**回调式**的，作答之后**不调用 `done()`**——那是直接中止链，
  而不是依赖那一刻 `reply.sent` 恰好是什么（压缩会让它在一段时间里是 `false`）。

SSE 路由是唯一还碰裸 `ServerResponse` 的地方：`reply.hijack()` 之后 socket 归它自己，没有
serializer、没有 `onSend` 钩子、没有压缩。随之而来的规则写在 `hijack()` 的注释里：**一条
流式路由所有可能的拒绝都必须发生在 hijack 之前**，因为之后已经没有 reply 对象可以用来拒绝了。

### 2.6 `web-trust` 里少了一个函数，多了一个更小的

`readJsonBody(req, maxBytes)` 删除。尺寸上限交给两个 surface 各自的 Fastify `bodyLimit`
——它在 handler 存在之前就拒绝，这是手写读取器永远给不了的性质。**没有**跟着走的是那个
语义决定，而那正是出过事的一半：空 body 是 `{}`、坏 JSON 是说得出口的 400、非对象（`[1,2]`、
`"hi"`、`null`）也是 400。它变成 `parseJsonBodyText(text)`，**两个 surface 都把它注册成
content-type parser**，所以这三个答案不会再分头漂。

统一暴露出一处已经漂了的分歧并把它收紧：**字面 `null` 的请求体**在 v3 Host 上经 `readBody`
归一成 `{}` 被接受，在面板上一直是 400。两侧现在都是 400（与数组/标量同一条消息）。更严的
那个是对的——一个字面 `null` 的 body 不是「什么都没说」的请求，那是空 body（仍然是 `{}`）。

## 3. 明确没有做的

- **不换会话/CSRF 实现**。`@fastify/session` + `@fastify/csrf-protection` 是 `③'`，
  `doc/handover-security-migration.md` §13 已经写清楚为什么它必须与 v3 Host **一起**做：
  只换一侧 = 仓库里两份会话实现，正是 `web-trust` 当初要消灭的形状。而且面板的
  `WebSessions` 还要提供库给不了的三条：绝对过期、时间戳读不出即判过期、会话过期时销毁
  capability Context。
- **不动授权模型**。Cedar 策略、路由表、mutation gate、两段式 body 授权、capability kernel
  一行未改。这是传输迁移。
- **不加 SPA 通配回退**。页面文档仍然在 `authorizeRoute` 之后逐页组合，所以无权页面还是
  403、本组合没建的页面还是 404、未登录还是 401 + 登录屏。
- **不开 HSTS**。`@fastify/helmet` 默认会发，这里显式关掉：TLS 终止在反代，而 HSTS 是**粘的**
  ——浏览器会在几个月里拒绝这个主机名的明文 http。它是一次关于共享域名的运维决定，不该由
  一次传输迁移悄悄做掉。同理 COEP/COOP 也关掉（今天两个都不发）。

## 4. 代价与边界

- **首包多了三个依赖**（`fastify`、`@fastify/helmet`、`@fastify/compress`）。都在维护、
  都已在本仓库的 v3 Host 里用过其中两个。
- **压缩多了 br**（默认协商顺序 br > gzip > deflate）。`accept-encoding: gzip` 的客户端仍然
  拿 gzip，测试钉住了这一条。
- **`vary: accept-encoding` 由我们自己的 `onSend` 钩子无条件补上**：`@fastify/compress`
  只在它动手时加，那对它产出的那条回复是对的，但会留下一条没有 `vary` 的未压缩回复可以被
  共享缓存按忽略编码的键缓存。手写发送器一直是无条件加的。
- **成功的 JSON GET 带弱校验器**（2026-10-15，出口流量）：同一个 `onSend` 钩子在压缩之前给
  200 的 JSON GET 加 `ETag: W/"<sha256 前缀>"` 与 `Cache-Control: private, no-cache`，
  `If-None-Match` 命中时回无 body、无 `Content-Length` 的 304。handler、Gate 与副作用每次
  照常执行，只是不再重发未变的 body；浏览器 HTTP 缓存透明重验并把原 body 交给 `fetch()`。
  已自带 `Cache-Control`/`ETag` 的回复（页面的 `no-store`、bundle）不动；body 里带生成时间
  的读（如 `/api/overview`）永远不会命中。
- **未知路径上的 CSRF 拒绝仍然发生**：404 handler 也跑 identify + mutation gate，和以前
  一样，所以带 cookie 但没有 CSRF 的跨站 POST 到一个不存在的路径仍然是 403 而不是 404。
- **`x-octopus-build` 与加固头不出现在 SSE 上**（hijack 之后没有 `onSend`）。迁移前也是
  这样——那些流走的是 `res.writeHead`，从来没经过 `send()`。
