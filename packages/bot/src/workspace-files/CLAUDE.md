# Workspace Files — 可信 provider（六读两写）

> 2026-08-06 新增（v4 只读资源地基）；同日拆出**独立 capability Object**（v4 trusted resource binding）
> 并接入生产（v4 read-only workspace browser）。
> **2026-08-07 增加第一个写**（P6a 文件写入纵切）：`replace_workspace_text`，expected-digest CAS +
> 原子替换 + mutation receipt。Object 因此升到 **v2**，权限契约多出**第三份**
> （`sessions-workspace-write/v1`，九词元）。
> **已接生产（读）**：`bootstrap-v3` 构造这个平面（与 Runner 共用**同一次** `claimTransport()`），
> Dashboard 把它交给 provider catalog。当前 Session Plus self-service release 声明写能力；本人可信
> 页面显式领取 CAS 写的静默条款，App Agent 与共享文档 plane 不继承。
> 契约：`packages/workspace-files-contract/`、`packages/resource-stream-contract/`
> 目录与接线：`packages/bot/src/agent-resources/CLAUDE.md`
> 交付：`doc/deliveries/2026-08-06-resource-stream-workspace-files-foundation.md`、
> `doc/deliveries/2026-08-06-trusted-resource-binding-foundation.md`、
> `doc/deliveries/2026-08-06-read-only-workspace-browser.md`、
> `doc/development/workspace-write-worklog.md`

## 它是自己的 Object，不是 Runner Object 的新方法

```text
runner-account-v2:<owner>            账户 Runner，原闭集、原身份，一行没动
workspace-files-runner-v6:<owner>    本目录的六个读 + 两个写，独立版本演进
```

第一版把两个 operation 加进 `RUNNER_OPERATIONS`，于是账户 Object 必须升到 v3——升版本身是对的
（内核把 operation 闭集当身份持久化），**但那条路是错的**：照这样，每装一个后端模块都会把全体账户
的 capability 与**未决批准卡**作废一次。所以两个 Object 分开：operation 身份、root、slot、grant、
撤销与下一次升版**互不相干**；共享的只有受信 `RunnerTransport`（`../runner/dispatch.ts` 一份实现）。

**v1 → v2（2026-08-07）是这条设计第一次被用到。** 加 `replace_workspace_text` 必须升版：`putObject`
对不同的 operation 列表直接抛；就算能注册，`authorityFor` 只在 auto-allow 条款变化时重铸 root，而
历史上 `modify` 不改 root 条款，于是老 root 会永远只握着三个读。工单 #101 将 owner root 的闭集
上限扩到本 Object 的全部四项，并由 child grant 显式领取写的静默条款；没有显式领取的调用仍产生卡。升版
**只作废本平面**的 root 与未决卡——账户平面、bot 主机扫描平面、其它模块一律不受影响；而
`grant_intents` 记的是 operation 名字加权限契约 digest，不是 Object id，所以**用户已经给过的同意
不会因为这次升版而消失**。

**v3 → v4（2026-08-22，工单 #317）只新增通用文件下载。** 既有
`read_workspace_binary` 仍只表达已披露的 PNG/JPEG/GIF/WebP/PDF 内嵌预览；把其它普通文件复用到这个
词元会让同一份旧同意静默变宽。因此新增 `download_workspace_file`，Object prefix 升 v4，只撤销本平面
root/card；Session Plus 也以新 permission digest 重新同意。所有下载窗口——包括首块之后的 pull——都用
新 operation；实现仍复用同一套 regular-file、workspace containment 与逐窗口回包校验（总大小上限已于 2026-10-20 去掉，见「两个不明显的决定」）。

**v4 → v5（2026-08-26，工单 #399）只新增本人 Runner 的绝对路径读取。** 新
`access_owner_files` 词元不复用或改写旧 workspace 词元；它只在当前 owner 的 scope 中铸 `/` opaque root，
由 Runner OS 账号决定路径是否可访问。Workspace registry、containment、CAS 写入和历史授权保持原义。

**v5 → v6（2026-09-25，工单 #668）增加独立 `replace_owner_text`。** 本人根的保存由 exact App ask
与 grant 交集的 `ownerFilesWritable` 投影控制，复用同一 CAS/原子替换；不复用旧读取或 workspace 写权限。
共享 scope 和会话执行凭据不继承此权利。Session Plus self-service/v7 需重新同意，旧 v6 保持只读本人根。

**它们唯一必须一起变的是设备集合**：`RunnerCapabilities.onTargetSetChanged()` 让签发/替换/删除设备
凭据时**先**撤销两个平面的 root、**再**写新凭据。

准确说清楚失败时会发生什么（不要过度承诺）：**所有 listener 都会被尝试**；**同步**抛异常的 listener
会让 `mintDeviceToken` 抛出，新凭据不写。而把释放交给异步的 listener（provider 目录就是这样）在那一刻
**已经返回**了，所以它后续 `close()` 失败只会被记录，不会挡住签发——这是对的，不是缺口：这条 listener
欠的性质是「此刻起不能再开始新的调用」，而先 `revokeAccount` 已经建立了它。

## 目录关联键（2026-08-10，工单 #49）

`directory-key.ts` 是**唯一**把一个真实目录变成可比较令牌的地方。HMAC 输入固定为
`domain·owner·publisher·app·device·workspaceId·relativePath`（保长 JSON 元组，同 `refs.ts` 的手法），
输出 `dk1_` + 128 bit base64url。

三条要记住的：

1. **一个进程一个铸造器，由组合根交给两条投影**（会话投影与 `workspace-files/v2` provider）。
   两个实例 = 两个密钥 = **静默地永远不联结**，没有任何报错——所以这条约束写在构造处而不是靠约定。
2. **没有反向索引。** 没有任何东西把 key 映回目录，所以提交一个 key 找不到会接受它的代码路径。
   ref vault 靠随机性得到的性质，这里靠「单向且没人查表」得到；也正因如此 key 可以投影，而
   workspace id 与相对路径不可以。
3. **密钥是进程级的、不落盘，只在 bot 重启时轮换**——resource generation、grant 变更、设备凭据变更
   都**不**轮换（它们改的是「能读什么」，不是「哪个目录是哪个」）。key 只在一个标签页内比较，而
   instance handle 本来就活不过重启。

`WorkspaceFilesScope` 因此多两个**可选**输入：`contract`（这个 scope 按哪一版作答，缺省 v1）与
`directoryKey`（一个**已绑定身份**的函数——service 不该学会 publisher 与 app）。缺省两个都不给 =
逐字节的 v1 行为，而且 v1 scope 走 v1 的 reader，所以「v1 binding 拿不到 v2 答案」在**生产侧**也被检查。

## 一句话

把一个 opaque ref 重新绑定成 `(device, workspace_id, relative path)`，交给 Runner，把答案投影回
`workspace-files/v1`。**这里不计算第二套权限**——它调一个 authority seam，生产环境那个 seam 是
App Context 下的 ControllerRun，最终判定仍然只有 capability Gate。

```text
ref  ->  vault.resolve(scope, owner, kind)  ->  binding  ->  backend  ->  authority  ->  Gate  ->  device
```

当前 owner-local release 另有一条显式分支：可信组合先把 scope 绑定到登录用户，provider 才为该用户的
每台 Runner 铸一个 label 为 `/` 的 opaque root。这个 root 下的读取统一花费
`access_owner_files` token，由 Runner 的 OS 账号判断文件是否可访问，不查 workspace registry、
不比较 `directoryKey`、也不做 workspace containment。旧的 workspace binding、operation 与 containment
逐字保留，供回滚以及未来跨用户/细粒度共享使用；两条分支从不互相 fallback。

顺序就是安全内容：伪造 ref、跨 scope、跨 owner、scope 已关、kind 错配，**五种全部停在第二步**，
所以没有 Runner frame、没有批准卡、笔记本上什么都没发生。这比「那次调用会被拒绝」强。

## 文件

| 文件 | 唯一职责 |
|---|---|
| `capability.ts` | 独立 Object：五个 observe/read + 一个 modify 的封闭表（**没有** `path`/`directory`）、自己的 policy（只认精确批准证据或 grant 条款，批准人固定为 Object owner）、复用 `AccountAuthority` 的单 root + pool、`attachToRunnerLifecycle()` |
| `authority.ts` | 把 `WorkspaceFilesAuthority` 这条 seam 闭合到 Gate 上：`call` = 一次 `grant.request`。`devices()` **不过 Gate**（gateway 本地在线状态，不产生任何 frame），所以封闭表里也**没有** `__list_devices` |
| `types.ts` | 两个窄 seam：`WorkspaceFilesAuthority`（能碰哪些设备、碰它意味着什么）与 `WorkspaceFilesBackend`（一次工作区读是什么）。契约拒绝携带的东西全在这个文件里 |
| `refs.ts` | ref vault：192 bit 随机、**从不解析**、同 scope 同资源稳定、`closeScope` 一次清干净 |
| `runner-backend.ts` | 真实 Runner adapter。逐字段复核设备回包（它在别人的笔记本上），并复用设备端**同一个** `workspaceRelativePathProblem` |
| `service.ts` | 每个 scope 一个 `WorkspaceFilesScopePort`；文本/媒体/下载流的 pull source；`closeScope()` 的拆解顺序；按 scope 声明的版本选 projection reader；v4 下载对**每个**窗口注入独立 `downloadBinary` reader，绝不在 chunk 0 后回落到媒体 operation；`resolvePath`（工单 #243）仍只对 v2+ binding 暴露 |
| `directory-key.ts` | `WorkspaceDirectoryKeys`：进程级 HMAC 铸造器（见上一节） |
| `directory-index.ts` | `list_session_workspaces` 设备回复的唯一归一器 + sessions-plane 有界 per-instance/device 快照。两个 capability plane 复用解析语义，但不复用 disclosure/授权结论：files 只取 roots，sessions 只有在自己的 Gate 成功后才记 association；缓存命中不跳过 Gate |

## 三条不可协商

1. **ref 是保管的，不是编码的。** 把 `(device, workspace, path)` 编进 ref 再解出来，等于让 ref 成为
   消费者的一句**主张**，此后每条路径都变成检查者。vault 反过来：ref 不携带任何信息，提交它不是
   在主张什么，rebind 是一次查表。
2. **设备回包是不可信输入。** 子条目的 `relative_path` 必须**恰好**等于父路径 + 名字（否则一台被
   改过的设备可以让 provider 给 `../../.ssh/id_rsa` 铸一个 ref）；文本窗口必须自洽（`bytes` 等于
   `text` 的 UTF-8 长度、从请求的位置开始、不超过请求量+3、`bytes===0 && !eof` 直接拒绝——那会让
   消费者永远 pull 下去）。
3. **拆解顺序：先 ref 后流。** `closeScope()` 先让 ref 全部失效（此后开不出任何新东西），再取消流。
   反过来写的话，取消流时抛异常就会留下一条还能重新开始的路。

## 两个不明显的决定

- **一个 scope 的 port 有两张脸，但只有一个状态机。** 同进程消费者拿 `ResourceStream` 对象；
  MessagePort 后面的消费者拿一个 handle（对象过不去）。两者寻址的是 broker 里**同一条**记录，所以
  「对一个结束了」不可能「对另一个还开着」。`openTextForTransport` / `pullStream` / `closeStream`
  是可信侧专用——`WorkspaceFilesPort` 上没有 handle 这个词，所以模块说不出一个。
- **`openText` 先读一个窗口，把它当 chunk 0 缓存住。** 所以第一次 pull 花费**零**次设备读，
  而「一次 pull 最多一次后端读」仍然成立。header 里的 size/digest/mtime 也来自这一次读。
- **预读一个窗口（2026-10-20）。** 交出一块后立刻发起下一窗口的设备读（`ReadAhead`），让「浏览器→Host」
  与「Host→Runner」两段往返重叠；任何时刻最多领先一个窗口，一次 pull 仍最多触发一次后端读，预读失败
  变成下一次 pull 的拒绝，关闭后丢弃。代价是提前关闭时最多多读一个窗口。
- **每个窗口都带整份文件的 digest 与 size，provider 每次都比对。** 设备那侧不保存游标（无状态），
  所以没有服务端读取位置会过期或错位，「文件在读到一半时被改了」变成一次 `unavailable` 拒绝，而不是两个
  版本的无缝拼接。2026-10-20 起设备端每个文件版本只做一次整文件 pass（digest + UTF-8），按
  `dev/ino/size/mtimeNs/ctimeNs` 版本键缓存（racy 窗口内不缓存），窗口本身 O(window)；窗口前后 fstat
  版本键不变才作答。于是文本、媒体与下载都不再有总大小上限（1 GiB 文件 4096 个窗口设备端总计约 2.6 s）。

## 写这一半（2026-08-07）

一个动词：`replaceText(ref, {expectedDigest, text})`。它是 **CAS**，不是 write：设备打开文件、对
**已打开的 fd** 验整份文件的 sha256，不符就 `digest_mismatch` 且**一个字节都不写**；相符才写同目录
临时文件 → fsync → chmod 回原权限位 → `rename` 覆盖。`rename` 在同一目录内是原子的，所以进程被杀、
磁盘写满、断电只会留下**整份旧文件或整份新文件**，绝不会是截断的混合体——这就是决定 12 唯一升格的那条
要求（App 写挂了不能丢数据）。

四条落在这一层的规则：

1. **root 是上限，child 才决定是否免批。** owner root 覆盖本 Object 的完整闭集，但普通 child 不显式
   领取 `replace_workspace_text` 的 auto-allow 时仍产生批准卡。当前本人可信 Session Plus 页面只有在
   release 契约与 owner active grant 的交集都包含该静默条款时才领取；App Agent 与跨用户 plane 不继承。
2. **`retrySafe: true` 是显式声明的**，与 `modify` 的默认相反。理由是 CAS：重跑要么把同一次编辑
   应用到同一个版本，要么发现 digest 不符而拒绝，**不存在被应用两次的输入**。中断恢复因此把它
   退回给人决定，而不是判成 `unknown`。
3. **`writable` 是 grant 的投影，不是第二个授权者。** `WorkspaceFilesScopeGrant.writable` 由
   `workspace-grant.ts` 从**同一份 rights** 读出；`false` 只是把 kernel 的 `denied` 换成
   `read_only`（一句关于组合的话），并省掉一次 frame 与一张卡。`true` 不授予任何东西，Gate 仍按
   同一个 child grant 的 auto-allow 或批准证据作最终决定。
4. **回执要能被复核。** 设备回包里的 `previous_digest` 必须等于我们发出的前提、`size` 必须等于我们
   发出的文本的 UTF-8 长度，否则 `unavailable`——一张写着「已保存」的回执如果描述的是另一次写入，
   比失败更坏。这一条在 adapter 与 service 各查一次（service 是铸回执的那一层）。

**2026-10-20 起只限窗口**：一次写调用仍 ≤256 KiB（Gate 封顶 512 KiB 编码参数），更大的文本分段：
`begin/append/commitTextUpload` 每步都是同一写 operation 的一次 Gate 调用；设备按 offset 写同目录 0600
临时文件，commit 才做同一套重扫 CAS + fsync + chmod + rename（每设备 ≤16 个、闲置 10 分钟清扫、任一步
被拒即丢弃）。令牌由本层铸造，设备 id = `sha256(scope, owner, token)` 截断，本层无上传状态；`retrySafe`
逐步成立（begin 幂等、append 按 offset 识别重放、commit 消费上传）；参数 schema 非身份，不升 Object 版本。
列表 `after`（`<kind>/<name>`）须经设备回显，无回显即旧 Runner → `too_large`（升级 Runner）；roots 保持后端
顺序、从游标 root 之后续页（游标 root 已注销则拒绝）；`resolvePath` 逐页找 label。
## 明确没做

没有 create / append / patch / delete / watch / diff，也**没有 preimage 与 undo**——回执里的
`undo` 恒为 `"unsupported"`，因为没有任何地方保存旧内容。Mutation Ledger（`groupId`/`actor`/
`summary`/`status`）同理不发：那些字段描述的是一个还不存在的持久台账，发出去等于报告一次没人在追踪的操作。

**原子替换的两个诚实边界**：`rename` 换的是目录项，所以指向旧 inode 的**其它硬链接**保留旧内容；
两次 open 之间没有锁，所以 CAS 买到的是「不会静默丢失」而不是互斥（同一 OS 账号下的并发写手本来就在
威胁模型之外）。

`WorkspaceFilesAuthority` 这条接缝**已经闭合到 Gate 上**：生产实现是
`../session-resource/workspace-grant.ts`（契约 → grant 交集 → 本平面 operation → capability Context），
Dashboard 与纵向 e2e 用的是**同一个函数**——两份实现意味着被测的那份才是对的。

## 测试

```bash
npx vitest run --project node packages/bot/src/workspace-files packages/bot/src/resource-stream
npx vitest run --project node packages/bot/src/agent-resources
```

| 文件 | 证明什么 |
|---|---|
| `capability.test.ts` | 封闭表是三读一写且 schema 里没有 path/directory；写的 effect 是 `modify`、`retrySafe` 显式为 true；owner-local child 可显式领取写 auto-allow，未领取时仍产生批准卡；只到被点名的那台设备、够不到别的账号、握着本平面**到不了** `exec`；**两个 Object 互不影响**（注册/使用本平面不动既有 v2 root，一张未决卡仍可批准；撤销任一方不动另一方）；换设备凭据时**先关本平面再写新凭据**，**同步**抛异常的 listener 让新凭据不写、其余 listener 仍被跑过 |
| `refs.test.ts` | ref 不含资源信息、同 scope 稳定、跨 scope/owner/kind 一律拒绝、closeScope 只清自己 |
| `service.test.ts` | 投影字段边界、symlink 无 ref、超限标记、五种 ref 拒绝**零后端调用**、流中途撤销/文件被改/后端抛异常、早关与 scope close 精确释放；**写**：回执字段与两个 mutation id 不重复、设备回执与请求不符即 `unavailable`、只读 scope 与坏请求**零后端调用**、后端根本不会写时答 `read_only` |
| `directory-key.test.ts` | 相等/不等的六个维度、两个进程永不相等、输入不出现在输出、JSON 元组不被分隔符欺骗、拒绝铸造优于铸造更弱的 key |
| `service-v2.test.ts` | v1 scope 投影逐字段不变且过 v1 reader；v2 keys root/目录/信封而非 file 与 symlink；同名兄弟/跨工作区同名/嵌套同名互不相等；两个 owner 与两个 app 不同；**把 key 当 ref 提交 = `unknown_ref` 且零后端调用** |
| `windows.conformance.test.ts` | **纵向**（2026-10-20）：1,200 条目按游标列全且每条各一次、翻页间增删不重不漏、`resolvePath` 找到第一页之后的名字、旧 Runner 忽略游标时提示升级；roots 按后端顺序分页、游标 root 被注销时拒绝；3 MiB 经 begin/append/commit 保存、过期编辑在 commit 被 CAS 拒绝且新文件完好、上传绑定 scope、只读 scope 零 frame |
| `conformance.test.ts` | **纵向**：temp home + 真 workspace registry + 真 `handleRpc` + 真 adapter + 契约 reader，逐条对应任务书的八条，外加写的四条（真替换与回执自洽、过期写与只读 scope、伪造/跨 scope/kind 错配的写零 frame、写的回答里没有规范路径） |
