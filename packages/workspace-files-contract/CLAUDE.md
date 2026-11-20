# Workspace Files Contract — `workspace-files/v1` 至 `v4`

> **2026-10-20：分页与分段写，不新增版本。** `maxEntries`/`maxRoots`/`maxWriteTextBytes` 只是单次调用窗口。
> `list_directory`/`refresh_roots` 多可选请求参数 `after`：目录游标即上一页末行 `<kind>/<label>`（本契约全序
> keyset，翻页间增删不重不漏），roots 游标即末个 root ref。回复形状不变（`truncated` 本义即「末行之后还有」），
> 已安装 bundle 的严格 reader 收到逐字节相同的回复，故**无需 v5**；续页自证（每行须在游标之后）。`replace_text`
> 多 `stage/upload/offset/size`：超窗文本按字节与 JSON 编码长度切窗分段上传，commit 才做同一 CAS 与原子替换；
> 旧 Host 把每一步当畸形一次性替换拒绝。见 `paging.ts`、`upload.ts`；v1 golden 不变。

> **2026-10-09：v4 增加 `resolve_file_link`。** 会话文件链接提交 `sessionRef + href`，
> Markdown 后续链接提交 `fileRef + href`；两种来源互斥。路径是请求数据，不能指定用户或设备。
> 服务端以当前 owner 校验会话来源并读取 split 执行位置，Runner 在实际设备按会话 cwd 定位，
> 通过 `access_owner_files` 直接 stat；不依赖目录根枚举或逐层 listing。
> 回应回显 source/href，并给出原有文件 ref、位置及用于稳定批注的 root 显示信息。
> **共享实例禁用此入口**，仍以已授权的 device/workspace/operation 和撤销状态限定每次读取。
> v1–v3 动词集合不变。下文“只能提交 listing label”描述旧版本及受限工作区分支；
> 本人访问以 Runner OS 用户可访问的文件为范围，允许 OS 可解析的 symlink。

> **2026-08-22 新增 `workspace-files/v4`**（工单 #317）：v3 媒体预览之外增加
> `download_file -> download_workspace_file`。它接受 provider 已铸的普通文件 ref，返回
> `application/octet-stream` header + 按 256 KiB 窗口拉取的 byte stream（2026-10-20 起不限总大小，见下）。新 operation 是刻意的权限边界：
> v3 的 `read_workspace_binary` 只披露 PNG/JPEG/GIF/WebP/PDF 预览，不能用旧同意下载其它格式。
> v1–v3 的 action closed set、port 表面与 contract id 全部冻结。
>
> **2026-10-20 限窗口、不限总量**：文本、媒体与下载都按有界窗口读取，设备端每个文件版本只做一次
> 整文件 pass（digest + UTF-8 判定，按 stat 版本键缓存），窗口本身 O(window)。因此 `maxTextBytes`、
> `WORKSPACE_MEDIA_LIMITS.maxBytes` 与 `resource-stream/v1` 的整流上限都只是数值表示上界，不是策略。
> 需要整份放进页面的视图自带预算：`wholeTextBytes`（文本整份载入，超出时显示前一段并可「载入全部」）、
> `WORKSPACE_MEDIA_LIMITS.previewBytes`（媒体内嵌预览，超出时先询问）；下载与 MCP 窗口读取没有预算。
>
> **2026-08-18 新增 `workspace-files/v3`**：在 v2 目录身份上增加受内容识别约束的
> PNG/JPEG/GIF/WebP/PDF 有界预览；其它普通文件仍可列出，但 v3 不提供通用下载。

> **2026-08-10 新增 `workspace-files/v2`**（工单 #49，目录关联地基）：v1 **加一个可选
> `directoryKey`**，出现在 root、`directory` 条目与目录列表信封上。**同样的四个动词、同样的权限
> 词元、同样的 Runner operation、同样的 capability Object**——它不是更宽的 ask，一个 release
> 绑 v1 还是 v2，用户被问到的是同一件事。
>
> **为什么是新版本而不是给 v1 加字段**：v1 的 reader **拒绝未知字段**，而那条拒绝是承重的。一个
> 开始往 v1 binding 里发新字段的 producer，会让每个 v1 消费者拒绝**整份**列表——那是契约被违反
> 时的正确行为，不是一次迁移。
>
> **key 是什么**：有界、opaque、不可逆的**相等令牌**。相等 = 同一个真实目录；不等 = 不许联结；
> **缺席 = 没有承诺**，绝不回落到比 label/basename。它**不是地址**：本契约没有任何方法接受它作为
> 输入，可信侧也**不保存任何反向索引**。详见 `src/directory-key.ts` 与
> `doc/deliveries/2026-08-10-workspace-directory-join-v2.md`。
>
> **v1 的冻结方式是 golden 测试而不是「不许改那些文件」**：v2 刻意**共用** v1 的 reader 与 remote
> client（到达校验复制一份就会漂移，而漂移的落点正是「看起来完整的截断文件」）。所以 `src/remote.ts`
> 的公开工厂仍然是 `createRemoteWorkspaceFilesPort(transport, binding)` **两个参数**——给它加一个
> 可选版本参数会让每一处既有调用点都变成「本可以要求另一个契约」的调用点——而
> `src/v1-frozen.test.ts` 用 golden 值钉住 v1 的词表、上限、16 个 refusal、6 个 action id 与两份答案。


> 2026-08-06 新增（v4 只读资源地基）。
> 任务书：`doc/development/resource-stream-workspace-files-foundation-task.md`
> 交付：`doc/deliveries/2026-08-06-resource-stream-workspace-files-foundation.md`

## 一句话

消费者可以枚举**它被给到的**工作区、在里面走目录、把文本、受支持媒体或通用普通文件当**有界 pull
流**读出来。它**说不出**路径、说不出哪台机器、也说不出自己是谁——这三样不是被过滤，是 ABI 里**没有**。

## View-visible 字段就是边界

可以带：opaque `ref`、显示 label、`file|directory|other`、显示用 source/workspace label、
size/mtime/media type、SHA-256 digest、是否超过可打开上限。

**不得**带：owner/username/credential/app/scope/instance handle、device routing id、
Runner `workspace_id`、relative path/canonical path/home/URL、grant/capability/context/pending-call id。

`sourceLabel` 是**显示文本**，由可信组合决定，而且它不是 gateway 用来路由的那个 selector——
port 上没有任何方法接受一个 label 作为输入。

## 三条容易写错的规则

1. **`other` 条目不发 ref。** symlink、socket、设备文件只被「报告」，消费者手里**没有东西可提交**。
   「不跟随 symlink」因此是结构性的，而不是每个新调用点都要记得写的检查。reader 也拒绝一个带了
   ref 的 `other` 条目——那说明生产者写错了。
2. **拒绝一律 resolve。** 「没权限」「要先批准」「太大了」「不是文本」都是给人看的答案，不是异常。
   这条路径上抛异常，就是让一个 viewer 把带 canonical path 的 stack trace 显示出来。
3. **`openText` 给的是 header + stream，不是整份文件。** 想一次拿全文的组件必须自己 pull 完，
   那正是这个契约要的有界、可取消行为。

## 两个词表

`WORKSPACE_FILES_ACTIONS`（三个动词）与 `WORKSPACE_FILES_OPERATIONS`（每个动词花掉哪个权限词元）
不是一一对应的同一件事，理由与 `agent-sessions/v1` 相同：**说出**一个组合请求什么是消费者的事，
**授予**它是可信 Host 的 catalog 的事。

```text
refresh_roots   -> list_session_workspaces    （已存在的登记表枚举）
list_directory  -> list_workspace_entries     （本契约新增）
open_text       -> read_workspace_text        （本契约新增）
```

所以这套只读路径一共只往 Runner 的封闭表里加**两个**名字。

## v2 的三条规则

1. **key 只许在目录上。** root、`directory` 条目、列表信封各一个；`file` 与 `other` 上出现一律拒绝
   （与「`other` 不许带 ref」同一条纪律）——给文件铸一个 key 就是邀请消费者把文件行和目录行联结起来。
2. **v2 的 reader 是「剥掉那一个字段 → 交给 v1 → 贴回来」。** 这样「v2 = v1 + 一个 key」是代码**说**
   的，不是注释**声称**的；改了 v1 接受什么，v2 不可能还接受旧的那套。
3. **v2 起初不新增任何 action id 或参数**（2026-08-17 起有一个例外，见下节）。提议里本来就没有
   contract——可信 dispatcher 从 App 的 binding plan 解析 binding → contract，那是一份 View 改不了
   的文档。`remote-v2.test.ts` 仍断言两个 client 对**共享六个动词**发出的提议**逐字节相同**。

## v2 的 resolve 动词（2026-08-17，工单 #243）

`resource.resolve_path`（`src/resolve.ts`）：拿一个已铸的目录 ref 加一串**子项 label**，一次往返换回
最终条目的 ref。动机是 chat 文件链接原来每层路径一次 View↔Host 往返，手机网络上一条 14 层的路径就是
14 次断链机会——观测到的失败正是设备链路在下钻中途抖断。

边界没有移动，只是走的地方变了：

- **它是问题不是地址。** label 就是 View 原来逐层拿去比对 listing 的那串字符串；可信侧仍然逐层
  `listEntries`、只跟随设备自己报告的普通目录（symlink 仍不可寻址）、答案的 ref 仍从最终 listing 行
  铸出。猜错的代价与从前一字不差：一次「没有这个条目」。
- **权限面零变化。** 每层花的仍是 `list_workspace_entries`，capability Object 封闭表没有新名字，
  auto-allow / 批准语义不变；任一层要批准即以该拒绝终止，一次点击至多一张卡（比逐层更少）。
- **v1 全冻结。** 动词只进 `WORKSPACE_FILES_PROPOSAL_ACTIONS_V2`；v1 的六个 action、port 表面与
  golden 一字未动，v1 remote port 上**没有** `resolvePath` 成员（`resolve.test.ts` 钉住）。
- **回声即绑定。** 答案回显 `base` 与 `path`，client 逐一比对——解析出的 ref 是新铸的，只有回声能把
  答案绑到这次请求上。`path` 参数 ≤ 400 字符（低于 wire 默认 512 上限，所以不需要放宽的 declaration）。

## v1 是只读的

没有 `replace_text`、没有 expected-digest 写入、没有 Mutation Receipt、没有 watch。加任何一个都是
**权限契约变更**，不是重构。

## 文件

| 文件 | 职责 |
|---|---|
| `src/limits.ts` | 契约 id、两个词表、上限、三种 entry kind、十四个 refusal code |
| `src/projection.ts` | View-visible 形状 + 严格 reader（未知字段=拒绝）+ 纯 `utf8ByteLength` |
| `src/port.ts` | `WorkspaceFilesPort` 三个方法、reply/refusal、`workspaceFilesRefusal()` |
| `src/remote-core.ts` | 走 App **已有那一条** MessagePort 的实现，四个版本共享：最小 `ProposalTransport`、全部到达校验与流记账；dialect 只声明 contract/readers 及 resolve/media/download feature flags |
| `src/remote.ts` | v1 的 dialect + `createRemoteWorkspaceFilesPort(transport, binding)`（签名未变） |
| `src/remote-v2.ts` | v2 的 dialect + `createRemoteWorkspaceFilesPortV2` + `WorkspaceFilesPortV2` |
| `src/directory-key.ts` | `dk1_` 文法与 `isWorkspaceDirectoryKey`。**纯**：没有 crypto，铸造在可信侧 |
| `src/projection-v2.ts` | v2 的形状与 reader（剥 → 委托 v1 → 贴回） |
| `src/resolve.ts` | v2 专属 `resolve_path`：label 文法（唯一实现，client 与可信 provider 共用）、`WorkspaceResolvedEntry` 与严格 reader、v2 封闭集常量 |
| `src/media.ts` / `src/remote-v3.ts` | v3 的受支持媒体 header/chunk reader 与 preview port；旧媒体权限语义保持封闭 |
| `src/paging.ts` | 列表全序、`<kind>/<label>` 游标文法与比较器（设备、可信侧、View 共用这一份语义） |
| `src/upload.ts` | 分段写：上传令牌/回复 reader、按字节与编码长度切窗、`replaceWorkspaceTextInWindows`（remote client 与 MCP 共用的一个循环） |
| `src/download.ts` / `src/remote-v4.ts` | v4 的通用普通文件下载 header/chunk reader、独立 operation 与 remote port；`collectWorkspaceDownload` 在契约层校验并收齐有界 stream、逐块报告可信进度，并以 20 秒逐段无进展看门狗结束 open/pull 卡死，但不选择浏览器呈现、不自动重试 |

## 远端 port：复用单端口，不新增通道

Agent View 只有一条 MessagePort（可信外层握手后转交的那条）。第二条通道意味着第二次握手、第二个
generation、第二样要在拆解时关掉的东西——每一样都是「一条陈旧通道还在作答」的落点。所以资源读取就是
一次普通的 `propose(action, params)`，`session-plus/2` wire **一字未动**。

模块拿到的是版本化 port：v1 的基础三方法、v2 resolve、v3 media、v4 download；它始终看不到 action
字符串、binding 名、stream handle 或序号。`destroy()` 归 App（composition root），因为能结束自己传输的
模块也就能结束兄弟模块的。

**action 字符串里没有 contract**：可信 dispatcher 从 App 的 `agent-resource-bindings/v1` plan 解析
binding → contract，而那是一份 View 改不了的文档。

### 五条到达时必须重做的检查

1. **每个响应重新过 reader。** 「对面是我们自己的代码」这句话在下一个 release 就不成立了。
2. **文本块的 `bytes` 实测，不采信。** 跨传输时相信自报值会让低报的块把整条流的计费做废；所以
   `utf8ByteLength(text)` 与帧里的 `bytes` 不一致 = 一次 `protocol` 终止。这条与
   `resource-stream/v1` 的进程内 guard 不冲突：那个 guard 约束的是**可信生产者的声明**，跨信任边界的
   adapter 必须自己量（`resource-stream-contract/src/stream.ts` 文件头已按此更正）。
3. **答案必须是「问的那一个」的答案。** 目录列表回显的 `ref` 与 `openText` 的 `document.ref` 必须等于
   请求的那个 ref。一个「对别处完全合法」的答案 reader 抓不到，而消费者用 `ref` 当树的键——接受它就是
   悄悄把一棵子树挂到别的地方去。
4. **header 与 stream 必须互相印证。** `open_text` 的 metadata `payload`/`mediaType`/`totalBytes`/`digest`
   与 document 必须逐个相等，且 media type 就是本契约声明的那一个。这不是洁癖：`totalBytes` 是**唯一**
   能识破「传输层提前 EOF」的东西——只送一块、然后送一个与已收内容自洽的 `end`，除此之外无从分辨。
5. **`end` 只有与实际收到的内容一致才算 end。** client 自己数 chunk 数与字节数，与 `end` 帧比对，并在
   声明了 `totalBytes` 时要求恰好读完。不一致 = `protocol` 终止（不是 `unavailable`：那是对面违约，
   而且消费者绝不能把它误当成可以续读的部分结果）。

### 每个方法**真的**都 resolve

`ProposalTransport.propose` 在类型上声明 resolve，但实现是别人的。它 **reject**（或返回一个不是对象的
东西）时，三个 port 方法与流的 pull 一律转成有界 `unavailable`——rejection 也正是 stack trace 所在，
而 stack trace 是这条路径上最稳定的 canonical path 载体。

`destroy()` 之后，**已经在途**的 `refreshRoots`/`listDirectory`/`openText` 也不交回数据：每个方法在
`await` 之后重新检查一次。一个卸载到一半的面板收到「迟到的答案」，正是这条检查存在的理由。

## 测试

```bash
npx vitest run --project node packages/workspace-files-contract
npx tsc --noEmit -p packages/workspace-files-contract/tsconfig.json
```

`src/contract.test.ts` 钉住：两个词表的精确内容、把 `device`/`workspace_id`/`relativePath` 塞进
projection 一律拒绝、`other` 不许带 ref 而 file/directory 必须带、digest 必须是 `sha256:`、
文本块只许有 `text`。

`src/remote.test.ts` 用一个**会撒谎的传输**逐条钉住远端 client：提议里只有 binding 与 opaque ref、
拒绝一律 resolve、**传输 reject 也 resolve**（三个方法 + 流中途）、错误类型的 `ok` / `message` / `code`
envelope 也降级为 `unavailable`、未知 code 降级为 `unavailable`、
回显了别的 ref 的目录/文件被拒、header 与 stream 的四个字段不一致被拒、乱序/低报字节/超限/别的流的帧/
坏帧/**与实收不符的 end**/**提前 EOF**/**超出 totalBytes 的块**各**终止一次**并释放一次、终止后不再
pull、`destroy()` 关掉全部并让后续调用拒绝、**在途请求在 destroy 后不交回数据**。

`src/download.test.ts` 另钉住下载 collector：header 到达后与每块都报告 `received/total`；open 或任一
pull 连续 20 秒不推进会结束本次读取并释放现有或迟到的 stream，已经收到的前缀绝不生成 Blob。看门狗
按每段重置而不是限制总耗时，所以持续推进的弱网下载可以运行超过 20 秒；重试仍只能来自下一次显式点击。

`packages/bot/src/agent-resources/contract-boundary.test.ts` 读**本包源码**强制边界：不 import 任何
可信侧（bot/web-trust/runner/kernel/`node:*`）、依赖恰好是两个 contract 包、代码里没有
owner/device/workspace id/relative path/context/grant/pending 这些**字段名**、没有第二条通道或
`fetch`/动态 `import()`、port 上没有通用 invoke。

它**故意不在本包里**：读文件要 `node:fs`，而本包的 tsconfig 是 `"types": []`——没有 ambient Node 类型，
所以源码里写 `Buffer`/`process` 直接过不了编译。为了跑这个测试而加 `@types/node`，恰好会削弱它要证明的
那条边界。放在可信侧读同样的字节，强度一样。
