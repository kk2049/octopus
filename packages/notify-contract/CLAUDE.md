# Notify Contract — `notify/v1`

> 2026-08-07 新增（平台收敛计划 P1 契约层，决定 10）。
> 计划：`doc/development/agentic-app-platform-convergence-plan.md` §决定 10
> 交付：`doc/development/typed-port-kit-worklog.md`

## 一句话

一个 App 可以把一条有界消息投递给一个**它被给到的**收件人引用。
它**说不出**收件人是谁、**列不出**有哪些收件人、**发不了**给没被给到的人，
除了「可信侧收下了」之外**看不到**任何投递细节。

## 它是 `@claude-bot/typed-port-kit` 的第一个消费者

这是检验「kit 到底省了多少」唯一诚实的形式：**声明、reader、port 是一个契约真正要决定的东西，
剩下的全部来自 kit**。实测（代码行，去掉空行与纯注释行）：

| | `workspace-files/v1` | `notify/v1` |
|---|---|---|
| `remote.ts`（纯机械部分） | **308** | **53** |
| 整包非测试源码 | 671 | 337 |

`remote.ts` 那一栏是可比的：两边做的是同一件事。整包那一栏不可比——notify 是 2 个动词、
2 个投影形状，workspace-files 是 3 个动词 + 流 + 6 个投影形状。

## 收件人是不透明 ref，因此 v1 没有枚举

另一条路是「View 交一个 user id / chat id / 邮箱，服务端检查它」——那会让**每个检查者**
都成为安全边界，并且把一份同事名录放进一个不可信 bundle 里。所以收件人是可信侧铸出来的 ref，
只对它有意义，本包对它做的**唯一**操作是相等比较。这与 `workspace-files/v1` 对文件的做法同源。

由此得到一条要写下来的结果：**v1 没有枚举动词**。消费者从 App 投影或 `open-resource/v1` 链接
拿到 ref；它问不出「我能发给谁」。加这个动词是**权限契约变更**（它披露一份同事名单），不是重构。

## 为什么恰好两个动作

两个正好够展示 wire 参数的两种形状——**有界字符串**与**有界结构化值**。
没有第三个，是因为 kit 不会从第三个身上学到任何新东西。

## 一个权限词元，两个 action id

`send_text` 与 `send_card` 都花 `send_notification`：给人发一张卡和发一段话是同一次授权
（「这个 App 可以给你交给它的收件人投递通知」），而 v1 的卡片是**纯展示、无交互元素**。
action id 分开，是为了批准卡与审计记录说出人**实际要求的那一个**——与
`append_session` 下 `append`/`resume` 的分法完全一致。

## 两个投影形状，字段清单就是边界

**卡片**（`NotifyCard`）：`title`（≤60）+ `lines`（≤3 行，每行 ≤100）。

**回执**（`NotifyReceipt`）：回显的 `recipient`、不透明 `deliveryId`、`acceptedAt`。

回执里**不得**有：收件人的姓名/用户名/邮箱/电话/头像/在线状态、chat id、open_id、union_id、
tenant id、**平台自己的 message id**、owner/credential/app/scope/instance handle、
grant/capability/context/pending-call id。

`deliveryId` 是**我们的**：它命名可信侧握着的一行，所以「那条发到了吗」将来可以在不点名任何
平台对象的前提下回答。把平台的 message id 交回去，就是把一个路由句柄漏进一个
「它本来就寻址不到任何东西」的 bundle。

## 三条容易写错的规则

1. **卡片里的控制字符是拒绝，不是清洗。** 卡片是 App **构造**出来的文本，不是到达的文本；
   清洗会悄悄发出与作者所写不同的东西，拒绝会告诉他。（拒绝**消息**是反过来的情形——
   那是别人写的，所以 `portRefusal` 清洗它。）
2. **卡片的界量在编码后的形式上。** 每个字段都守着自己的界，而 JSON 转义才是把编码顶过
   512 的东西。截断会产出一份**解析成别的东西**的文档，所以那是一次 `too_large` 拒绝。
   `contract.test.ts` 构造**最大的合法卡片**并量它——一组加起来超过编码上限的分项界，
   会让最大的合法卡片发不出去。
3. **回执必须是**问的那一个**的回执。** 一份发给别人的回执**能完整通过** `readNotifyReceipt`——
   它对别处完全合法。reader 抓不到，而一个据此渲染「已发送 ✓」的界面会告诉人
   消息去了他选的那个人那里，而它没有。所以 `remote.ts` 上有一条 echo 规则。

## 明确不在本包里

**没有 provider、没有 bot 侧接线、没有飞书。** 本包不知道什么是 chat、什么是 tenant，
也不知道飞书存在。满足这个契约的 provider 是 `packages/bot` 里的**可信代码**，由部署者编写，
像其它平台能力一样走评审与部署（收敛计划·决定 2）。那部分工作**刻意不在本轮范围内**，
`doc/development/typed-port-kit-worklog.md` 的「未做」一节逐条列了它。

port 上也没有 `listRecipients`（权限契约变更）、`whoAmI`（只能编造）、
投递状态订阅与已读回执（那是第二个、有状态的契约）。

## 文件

| 文件 | 职责 |
|---|---|
| `src/contract.ts` | 契约 id、上限、九个拒绝码、**声明**（wire 编码 / MCP 面 / conformance 全部由它派生） |
| `src/projection.ts` | `NotifyCard` / `NotifyReceipt` + 严格 reader + 卡片的规范编码 |
| `src/port.ts` | `NotifyPort` 两个方法、`NotifyReply`、`notifyRefusal`、`NOT_AUTHORISED_REFUSAL` |
| `src/remote.ts` | 走 App **已有那一条** MessagePort 的实现，53 行代码 |
| `src/harness/memory-port.ts` | 第二份真实实现（`./harness` 子入口），无网络、无通道、无可信侧 |

## 测试

```bash
node_modules/.bin/vitest run --project node packages/notify-contract --maxWorkers=1
npx tsc --noEmit -p packages/notify-contract/tsconfig.json
```

`contract.test.ts` 钉住两个词表的精确内容、**最大合法卡片仍能编码进 512**、
转义撑爆时是响亮拒绝、reader 的每条拒绝分支、以及把 `chatId`/`messageId`/`openId`
塞进回执一律被拒。

`remote.test.ts` 用一个**会撒谎的传输**逐条钉住：本地校验失败时**一个提议都不发**
（`calls` 为空）、传输 reject / 非答案 envelope / 未知码 / 空 message 各自的折叠、
**发给别人的回执被拒**、destroy 之后拒绝且不再提议、以及**从不碰流动词**。

`harness/memory-port.test.ts` 把 kit 的 conformance 性质集**同时**跑在内存 port 与
远端 port 上（后者还跑一遍「传输只会 reject」的版本）——这是「组件依赖的是 port 不是传输」
唯一可检验的形式。
