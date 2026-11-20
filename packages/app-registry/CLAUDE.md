# @claude-bot/app-registry — 不可变 Agentic App release 登记处

> 2026-08-06 新增（v4 `v4-agent-app-registry`）。设计依据：
> `doc/development/agent-view-react-hot-plug-design.md` §4「热插拔的目标语义」。
> 交付记录：`doc/development/agent-app-registry-worklog.md`
>
> **本包仍然只做 release 与持久化地基**，本身一行未变。**2026-08-06（v4 热更新）已经把它接进
> 生产**：bot 侧的接线在 `packages/bot/src/app-registry/`，管理面在 `/apps`。
> **2026-08-07（平台收敛 P2）起 bot 侧是多 App 的**：`release-host.ts` 是按 stable app id 查的
> catalog，激活顺序在 `hosted-app.ts`（每个 App 一个实例），`adapter.ts` 是平台接口而
> `session-plus-adapter.ts` 是第一份实现。本包的 API 一行未变——它本来就按
> `(stableAppId, publisher)` 记指针。
> 交付说明：`doc/deliveries/2026-08-06-agent-app-hot-release.md`、
> `doc/development/platform-generalization-p2-worklog.md`。

## 一句话

一个**受信**的登记处：安装内容寻址的不可变 release，并在**不重启进程**的前提下原子地
换掉 active 指针。它记录 release 事实与激活，**不是** App 信任、不是权限意图、也不是
capability 授权。

## 为什么要有它

今天 Session Plus 在 `bootstrap-v3.ts` 里从源码树推出**一个** release 并在进程内
memoize（`sessionPlusIdentity()`）——于是「换掉正在服务的 release」和「重启进程」是同一个
动作，而「哪一版在跑」的答案存在于一次启动的内存里。本包把 release 变成一个**独立于服务它
的进程**而存在的东西：安装是一次显式调用，激活是一行元数据，崩溃恢复有定义。

## 四种 identity，绝不互相推导

```text
stableAppId              状态与同意按它记账
publisher                谁背书这些字节
packageDigest            运行身份 → 主机名 app-<前20位>（完整 release）
permissionContractDigest 它被允许申请什么（本层视为不透明）
```

**package digest 覆盖什么**：identity、执行 profile、精确命名的资产清单（每个资产带自己的
digest）、声明的 view/backend 组成、源码见证、确定性构建输入。

**刻意不覆盖什么**，以及为什么：

- `evidence` 里的**子 digest 不是身份**。它们由已经被覆盖的输入算出来，所以把它们折进去只会
  让一个**错误的声明**去铸造一个不同的身份，而不是被拒绝。它们在校验时被**重算并比对**：
  evidence 与自己的清单不符 = 拒绝，不是改名。
- `permissionContractDigest` 是**另一根轴**。合进来会让「加宽权限」看起来像一次发版、
  让「改个错别字」看起来像一次权限变更——正是 `session-plus/identity.ts` 与 engine
  `host/versions.ts` 已经划过的那条线。本包**不计算**契约 digest（那是权限层
  `contractDigestOf()` 的唯一实现），只记录它。

`DESCRIPTOR_FIELD_COVERAGE` 把这件事**逐字段写下来**，测试断言它是穷尽的——将来给
descriptor 加一个字段却没决定它算不算身份，是一次测试失败而不是一个静默选择。

## 三条不可协商的规则（改这里之前先读）

1. **artifact 先于引用它的行落地。** 崩溃可以留下一个**没人引用的 artifact**（安全，
   `reconcile()` 会报告），但**永远不可能让一个不完整的 release 变成 active**。manifest 是
   完成标记：blob 先写，manifest 最后写，各自 fsync+rename。
2. **资产名字永远不会变成路径。** 磁盘上每个文件都由**我们自己算出来的 digest** 命名
   （`blobs/<xx>/<sha256>`、`releases/<packageDigest>.json`）。所以「安装写到
   `../../etc/cron.d`」不是一个会被忘记的检查，而是一条**不存在的代码路径**。名字仍然在
   `descriptor.ts` 里按白名单校验——那是给将来把 release 铺到文件系统上的**下游**消费者的。
3. **重装的判据是「每一条记录下来的事实都相同」。** 相同 = 幂等无操作；任何一处不同 =
   **响亮的冲突**。安静地保留旧的，等于向人报告一个他没做过的决定。

## 文件

| 文件 | 职责 | 关键性质 |
|---|---|---|
| `descriptor.ts` | 规范 descriptor、digest 框架、纯校验 | 无 I/O、无 DB。长度前缀 + 字段标签的注入式框架（裸拼接会让两个不同 release 撞上）；`describeRelease()` 是构建方那一半，`install()` 从真实字节**重算**而不是相信它 |
| `ports.ts` | 两个窄 port + `InstallProvenance` | 全同步（与 `better-sqlite3`/app-state 同一习惯，顺序好读也好测）；**没有 delete**——没有破坏性文件操作的登记处不可能有「删错目标」的 bug |
| `content-store.ts` | 内容寻址的 artifact 存储 | 0700 目录、`O_NOFOLLOW` 读（被换成软链的 blob 是错误不是泄漏）、原子提升、根路径拒绝 `~`/`$`/相对路径/家目录本身；fault 注入点让崩溃语义可测 |
| `memory-catalog.ts` | 参考实现 | 让领域包不带数据库也能测；bot 的 SQLite adapter 对着同一套行为 |
| `registry.ts` | 受信 installer：install/activate/resolve/reconcile/subscribe | 事件**只在事务提交之后**发出，且不带秘密与 authority；事件订阅者抛异常不会掀翻已提交的写 |

持久化在 bot 侧：migration v28 的 `app_releases` / `app_release_activations`，adapter 是
`packages/bot/src/app-registry/store-catalog.ts`。用现有 `Store` 而不是第二个 SQLite 句柄——
同一个 `bot.db` 上的第二个写者这件事，仓库已经付过一次学费（capability 内核的单写者租约）。

## 发布权限：显式 API，不是目录 watcher

生产发布**只有**一条路：调用 `install()` / `activate()`。**没有实现任何目录监听**——watcher
会让「谁能写文件」成为部署权限，而那不是文件系统该做的决定。将来的开发模式 watcher 可以喂给
**同一个** `install()`，拿到同一套校验。

本包**自己不做任何鉴权**：每个方法都是受信操作，谁能发布由调用方决定（和 `Store` 一样）。
`installedBy`/`activatedBy` 是**记录**，不是 authority。生产那道门已经装好：`/apps` 与五条
`/api/apps*` 全部是 `dashboard/authz.ts` 里的 `Administer` 规则 + mutation gate，且在没有组合
registry 的进程上一律 404（不是 403——那套组合里这个服务不存在）。

## 诚实边界

- **没有发布者签名验证**，也不打算假装有。`provenance.signatureVerification` 只有 `"none"`
  一个成员，写别的值会被**拒绝**而不是被忽略——一个没人检查却让人安心的字段比没有更坏。
  `provenance.kind` 只区分 `platform-built`（本平台从声明的源码构建）与
  `external-attestation`（拿到时已经构建好，那段话是某人的说法）。
- **provenance 不进 package digest**：它是**这次安装**的事实，不是字节的属性。所以它由
  release 行携带，且重装时不一致 = `provenance_conflict`。
- **磁盘不会自己变小**。uninstall 只标记元数据，artifact 留在盘上成为无引用内容，
  `reconcile()` 会列出来。回收是一次**显式的、单独授权的**破坏性操作，本轮刻意不做。
- **`resolveActive` 用的是便宜检查**（manifest 在、blob 齐、大小对），逐资产的精确比对发生在
  `readAsset()`——所以按位腐坏的字节不会被吐出去，但「盘上有一个坏 blob」要等 `reconcile()`
  或一次真实读取才会被发现。
- **管理目录使用 `reconcile({ verification: "manifest" })`**，只检查 manifest、文件类型和大小，
  返回的管理投影明确标记 `verification: "manifest"`。普通列表请求不遍历读取历史发布包的内容；
  无参数 `reconcile()` 仍执行完整内容校验，`readAsset()` 的摘要校验也不受目录检查模式影响。
- **本包不知道 App 状态、trust、grant 和审计存在**。port 里没有任何方法够得到它们，所以
  「deactivate 不清数据」是结构性的而不是一句承诺；永久清除数据明确不在范围内。

## 测试

```bash
npx vitest run packages/app-registry --maxWorkers=1
npx vitest run packages/bot/src/app-registry packages/bot/src/store --maxWorkers=1
npx tsc --noEmit -p packages/app-registry/tsconfig.json
```

| 文件 | 测什么 |
|---|---|
| `descriptor.test.ts` | 金标 digest（框架一改，历史上每个 origin 都会变，所以那必须是一次带失败测试的刻意动作）；输入顺序无关；字节在资产之间搬家会换 digest；**每个 covered 字段的变异都换 digest，只改契约 digest 不换**；覆盖表穷尽；畸形 identity/清单/schema 版本/未知字段；穿越与非规范化名字；限额与**有界诊断**（控制字符被中和）；payload 与清单逐字节比对；**本包源码里没有字面控制字节** |
| `content-store.test.ts` | 名字永远不落到路径上（放一个 `../../../../tmp/pwned` 进去）；同内容只存一次；digest 与字节不符拒绝写入；manifest 没落地 = 整个 release 读作不存在且 tmp 不留垃圾；manifest 落地后崩溃可恢复；只认精确名字；**软链 blob 被拒**；同长度改字节被 `verify` 抓到且 `read` 返回 null；坏 manifest = 缺席；根路径守卫 |
| `registry.test.ts` | artifact 先于行；幂等重装只发一次事件；契约/provenance 冲突；声称签名验证被拒；校验失败**零写入**；artifact 写失败不留行；行活着但 artifact 丢了会被修复；激活换指针并报告替换了谁；**候选不可用时上一版原样留任**；跨 app/publisher 拒绝；并发激活的确定性结果；resolve 在缺失/损坏/无法重新校验时 fail closed；停用与卸载不擦除任何东西且可重新激活；事件顺序、无秘密、监听器内可见已提交状态、监听器抛异常不影响其它；reconcile 分辨 active/备用/孤儿；重启后同一份 durable 状态解析出同一个 release |
| `../bot/src/app-registry/store-catalog.test.ts` | migration v28 **只增表**（无 ALTER/DROP/写既有表）；两个 CHECK 词表在库里生效；真实 `Store` 往返；**重启**恢复；重启后 artifact 丢失 fail closed；**同一个库文件上两个连接**的确定性激活与去重安装；列表顺序；**停用+卸载之后 `app_trust`/`grant_intents`/`permission_audit` 一行不少** |
