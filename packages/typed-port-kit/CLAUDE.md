# Typed Port Kit — 造 typed port 的机床

> 2026-08-07 新增（平台收敛计划 P1 契约层，决定 5）。
> 计划：`doc/development/agentic-app-platform-convergence-plan.md` §决定 5、§四支线池 4/5/6
> 交付：`doc/development/typed-port-kit-worklog.md`

## 一句话

三个 typed port 各自写了一遍的东西——统一 reply 形状、拒绝码闭集、到达校验、propose 映射、
流的记账、MCP 面——抽成**可组合的小函数**。目标（决定 5）：**新 port 从约 1000 行降到约 200 行声明**。

**它不是运行时框架。** 这里没有任何东西会启动、调度、重试、缓存、订阅或持有全局状态；
唯一有状态的对象是一个 `PortLifecycle`，而它归 App。port 只组合它需要的那几块，
**reviewer 因此看得见它没有组合哪几块**。

## 它里面没有身份，而且加不进去

没有 owner / username / app / scope / instance handle / grant / capability / context id /
canonical path / cookie / URL——不是被过滤，是**没有**。一个返回它们的 helper 只能编造。

## 依赖：零第三方，两个 workspace 包

和 `@claude-bot/workspace-files-contract`（本 kit 抽取自它）**完全相同的两个**：

| 依赖 | 为什么不是复制一份 |
|---|---|
| `@claude-bot/resource-stream-contract` | 流 ABI + 拒绝机制（`IssueBag` 一族）+ issue 词表。复制会造出 `IssueBag` 的**第三份**实现，而那个文件的文件头已经在解释为什么有第二份；dev-conventions 记着浏览器信任规则那次「两份实现，在五处漂移」 |
| `@claude-bot/agent-module-contract` | 标识符文法。一个本 kit 接受、binding plan 拒绝的 contract id = 一个接不上线的 port，所以文法只有一份，且住在引用它的那份文档旁边 |

两者自身零依赖，所以闭包里没有 React / DOM / Node / Bot / 任何知道 capability 是什么的东西。

## 文件

| 文件 | 职责 |
|---|---|
| `src/reply.ts` | `PortReply<T, C>`、`PortRefusal<C>`、有界 message 构造。**拒绝码是类型参数**——没声明词表的 port 在自己的类型签名里就说了 |
| `src/refusals.ts` | `refusalVocabulary()` 声明闭集（重复/坏文法/fallback 不在集内 = **加载即抛**）；`fold()` 把认不出的码折进 fallback；`foldRefusalInto()` 跨词表翻译 |
| `src/declaration.ts` | **单一真相**：`declareContract()`。action 是 **record 不是数组**，所以 `A = keyof`，`call("send_txt")` 是编译错误 |
| `src/wire.ts` | 传输常量：8 键 × 512 字符、`resource.` 前缀、`binding`/`handle`/`seq` 三个保留参数名 |
| `src/params.ts` | 声明 → 扁平 wire 字符串（`encodeWireParams`），以及服务端方向（`decodeWireParams`）；`canonicalJson` |
| `src/arrival.ts` | 七类到达校验里的四个通用件 + `PortLifecycle` |
| `src/remote.ts` | `createRemoteCall()`：declaration + transport → 一次跑完全部检查的调用 |
| `src/stream.ts` | `createRemoteStreamSource()`：`RemoteTextSource` 的记账，泛化后的一份 |
| `src/mcp.ts` | `mcpToolsOf(declaration)` → `{name, description, inputSchema}[]`，**纯数据**，零 MCP SDK |
| `src/conformance.ts` | （从 `./testing` 导出）契约性质跑一遍 + 一个**会撒谎的传输** |

## 七类到达校验，一个都不能少

| # | 检查 | 谁做 | 不做会怎样 |
|---|---|---|---|
| 1 | 回复是不是一个回复 | `readProposalAnswer` | 一个非对象回复变成 `undefined.ok`，抛进组件树 |
| 2 | 拒绝码折进闭集 | `RefusalVocabulary.fold` | 把新版 Host 的词表**当成有意义的**渲染出来 |
| 3 | payload 过自己的 reader | 契约自己的 reader（经 `call.read`） | 「对面是我们自己的代码」下个 release 就不成立了 |
| 4 | **答的是不是问的那一个** | `echoMatches` / `EchoRule` | reader 抓不到：给 `/b` 的目录列表对 `/b` 完全合法，而消费者用 ref 当键 → 悄悄挂错子树 |
| 5 | 一个答案的两半互证 | `corroborate` | header 说 40 字节、流给的是别的东西；`totalBytes` 是**唯一**能识破「传输层提前 EOF」的字段 |
| 6 | 字节**实测**不采信 | `createRemoteStreamSource` | 一个低报的块把整条流的计费做废 |
| 7 | `await` 之后复查 destroyed | `PortLifecycle.guard` | 卸载到一半的面板收到迟到的答案；而只 `return gone()` 不 `discard` 就是泄漏一条流 |

第 4 条最容易漏，第 7 条最容易写得**差一点**（在 await **之前**查不够）。

## 加载即抛的清单

这些是**本 bundle 编译进来的数据**里的编程错误，不是不可信输入；先例是 `moduleLockOf()`。
让它在加载时炸掉，是为了不让一个拼写错误变成「只在没人测的那种情况下才错」的分支。

- 拒绝码闭集：空 / 重复 / 非 `[a-z][a-z0-9_]*` / fallback 不在集内
- contract id 不合 `agent-resource-bindings/v1` 的文法
- action id、参数名、operation 词元不是 plain identifier
- 参数或 action 没有 description / summary（**那是 agent 要读的东西**）
- `json` 字段没声明 `maxLength`（那会让一次提议无法度量）
- `pattern` 没锚定或带 flag（JSON Schema 的 `pattern` 默认不锚定、且没有 flag）
- `enum`/`pattern` 用在非 string 上，`schema` 用在非 json 上
- `createRemoteCall` 拿到一个 wire 装不下的 declaration，或它声明了 `binding`/`handle`/`seq`
- `createRemoteCall` 的 `invalidRequest`/`closed` 不在该契约的词表里
- `mcpToolsOf` 派生出的工具名不合 MCP 文法，或 `only` 点名了不存在的 action

## 两张脸，各套各的传输上限

决定 5 写死的性质：**contract 是单一真相，MCP 面可机械派生**，但 wire 的
「8 键 × 512 字符」**不约束 MCP 面**（桥跑在可信进程里，收有界结构化 JSON）。

> **2026-08-07（P6b 的 wire 裁决）**：512 是**没人声明过的**参数的上限。一个 action 里
> **最多一个**参数可以在契约里声明更大的上限，封顶 `maxDeclaredValueLength`（384 KiB）；
> 两个大参数在声明期就是 wireProblem（一条消息装不下两个）。`wireValueLimit(field)` 是
> **唯一**的那份定义，`encodeWireParams`（客户端）与可信 dispatcher（`packages/bot/src/
> agent-resources/wire-limits.ts`）都读它——所以「能发什么」和「会收什么」不可能变成两个数字。
> 放宽的是**编译进可信进程的数据**，不是调用方的一句话：dispatcher 先用 App 的 binding plan
> 把 binding 名解析成 contract，再查自己那份 declaration；发明的名字一律回落到 512。

所以一个字段可以在一张脸上合法、另一张上不合法。处置是**分开**的：

- 形状错误 → `declareContract` **抛**；
- 只是 wire 装不下 → 记进 `declaration.wireProblems`，**不抛**（MCP-only 契约是可表达的）；
- 但 `createRemoteCall` 见到非空 `wireProblems` **拒绝构造**，并把字段名和数字写进错误。

这条防的是：一个「结构上就发不出去」的 port 被建出来，然后在第一次调用时变成一句
调用方无从判断的拒绝。

`json` 字段是这条规则的活例子：wire 上是它的**有界 JSON 编码**，MCP 上是**嵌套 schema 本身**。

## 为什么 MCP 面要派生而不是手写

仓库里唯一一个现成的生成器 `gatewayToolDescriptors()`（`packages/bot/src/feishu/catalog.ts`）
从一份带 `maxLength`/`min`/`max`/`description` 的声明里，只发出 `{ type }`。代码没错，
是**形状**允许一个上限只存在于一边——而看不见上限的模型会超过它，然后为一个它从没被告知的
理由被拒绝。本 kit 的派生器逐条带上所有已声明的界，并且每条都有测试。

`additionalProperties: false` 是默认。全仓今天只有 `devpipe/mcp-server.ts` 写了它；
没有它，模型编出来的多余参数会到达一个忽略它的 handler——**在模型看来那叫「被接受了」**。

## 明确不做

- **不引 `@modelcontextprotocol/sdk`**（连 devDep 都不引）。派生器只出 JSON 数据，
  挂 MCP server 的是可信侧；这样契约包在浏览器 bundle、release adapter 和测试里都能加载。
- **不做 JSON Schema 校验器**。`json` 字段的嵌套 schema 是作者写的片段，本 kit 只**嵌入**它；
  真正校验到达值的是契约自己的 reader。在这里造一个，就是每个 reader 的第二份、更弱的实现。
- **不给 port 加通用 `call(action, params)`**。`createRemoteCall` 不是 port——port 是具名方法。
  一个通用方法正是组件说出 App 从没打算暴露的 operation 的方式。
- **不做重试、缓存、订阅、连接池**。被 Gate 拒绝的读重发一次，就是把一次撤销变成一串批准卡。
- **不新增第二条通道，不 bump `session-plus/2`。**

## 测试

```bash
node_modules/.bin/vitest run --project node packages/typed-port-kit --maxWorkers=1
npx tsc --noEmit -p packages/typed-port-kit/tsconfig.json
```

`stream.test.ts` 是恶意输入那一组：低报/高报字节、跳号、别的流的帧、坏帧、
与实收不符的 `end`、**对着 `totalBytes` 的提前 EOF**、超出总长的块——**各终止一次**。
`remote.test.ts` 钉住「本地编码失败时一个提议都不发」（`calls` 为空），以及 destroy 之后
在途的值走 `discard` 而不是交回。`conformance.test.ts` 反过来测这套测试工具本身：
一个会抛的 port、一个说出闭集外拒绝码的 port、一个 contract 对不上的 port 都必须被**报告出来**。
