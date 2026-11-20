# Resource Stream Contract — `resource-stream/v1`

> 2026-08-06 新增（v4 只读资源地基）。
> 任务书：`doc/development/resource-stream-workspace-files-foundation-task.md`
> 交付：`doc/deliveries/2026-08-06-resource-stream-workspace-files-foundation.md`

## 一句话

一次**有界、pull-based、可取消**的读，定义成一个 Node 生产者（握着文件句柄）与一个沙箱 bundle
（在 MessagePort 后面）都能同意的形状——而且两边都不需要 import 对方的运行时。

## 为什么不是 `ReadableStream`

WHATWG Streams 已经把 pull source、backpressure 与 cancel 的语义定清楚了
（<https://streams.spec.whatwg.org/>），**语义我们照搬**。不能照搬的是那个**对象**：这条边界的两半
是一个 Node 进程和一个跨 origin 的 iframe，中间只有一条 MessagePort，传一个 `ReadableStream` 对象
不是两边都能依赖的事；而 polyfill 等于把一个 runtime 放进一个**以零依赖为设计**的包里。

所以 ABI 只留 MessagePort adapter 能实现的最小形状：`next()` + 幂等 `close()`。

## 五条由 `createResourceStream` 强制的性质

| 性质 | 失效模式 |
|---|---|
| 同时只有**一次** `next()` in flight | 排队会让生产者「最多一次读未完成」变成礼貌而不是保证 |
| `seq` 从 0 开始、只 +1，**由 guard 赋值** | 生产者自己报序号 = 跳号/倒退是它的自由 |
| **恰好一个** terminal，之后不再 pull 源 | 「结束了又给了一块」 |
| 每块 / 整条 / 块数三个上限，超限 **fail closed**。单块是协议硬上限（窗口）；整条与块数默认只是数值表示上界（2026-10-20 起不限总量），需要整份缓冲的消费者用 caps 自行收窄 | 截断成「看起来完整的文件」——本契约存在的全部理由 |
| `close()` 幂等，且**读取进行中也能取消** | 取消之后又来一块 |

另外两条写在代码里而不是注释里：生产者**抛异常**时错误文本被丢弃（Node 的 `fs` 错误天生带路径，
那是这条边界上唯一稳定泄漏 canonical path 的字段），认不出的 refusal code 一律降级为 `protocol`。

## guard 约束的是「声明」，跨信任边界要自己实测（2026-08-06 更正）

`ResourceStreamPull.bytes` 由生产者声明，guard 拿它去比上限。**可信生产者**在同一个进程里报错数字
只是它自己的 bug（它本来就能把字节交出去）。**跨信任或跨传输**就不是了：采信远端帧里的 `bytes`
会让一个低报的块把整条流的计费做废。所以 adapter 必须**测量自己解出来的 payload**，把测到的值交给
guard，并把「声明与内容不符」当成 `protocol` 终止——这条只能由 adapter 做，因为只有它知道怎么量 T。
worked example：`@claude-bot/workspace-files-contract` 的 `src/remote.ts`。

## v1 明确不做

seek、tee、通用 patch、优先级、durable cursor、跨进程恢复、无限历史。CRDT 将来可以把**有界 update**
当 chunk 用，但不能借此取消 Yjs 自己的因果/状态向量语义。

## 文件

| 文件 | 职责 |
|---|---|
| `src/limits.ts` | 契约 id、上限常量、九个 refusal code、handle 与 digest 文法 |
| `src/stream.ts` | 类型 + `createResourceStream` 状态机（**唯一**实现，所有生产者都过它） |
| `src/envelope.ts` | 传输帧（open/pull/close/chunk/end/refused）与严格 reader |
| `src/issues.ts` | 拒绝机制。**为什么不从 `agent-module-contract` import**：那边刻意不导出它，见文件头 |
| `src/testing.ts` | 最小内存 pull source + `drainResourceStream`。纯 TS，所以留在包里而不是 fixture |

## 测试

```bash
npx vitest run --project node packages/resource-stream-contract
npx tsc --noEmit -p packages/resource-stream-contract/tsconfig.json
```

`src/contract.test.ts` 逐条钉住上面五条性质、caps 只能收窄不能放宽、异常不回显、以及 envelope
reader 的每个拒绝分支（未知字段、外来 contract、坏 handle、越界 seq、编造的 refusal code）。
