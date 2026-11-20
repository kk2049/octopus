# Agent Resources — 受信 provider 目录

> 2026-08-06 新增（v4 trusted resource binding）；同日接入生产（v4 read-only workspace browser）。
> **谁构造它**：`DashboardServer` 在可信 composition 阶段 `register()` + `seal()`，并把窄句柄交给
> `SessionPlusAppService`。只有 inventory 里带 `agent-resource-bindings/v1` 的 release 够得到它。
> 任务书：`doc/development/trusted-resource-binding-foundation-task.md`、
> `doc/development/read-only-workspace-browser-production-task.md`
> 交付：`doc/deliveries/2026-08-06-trusted-resource-binding-foundation.md`、
> `doc/deliveries/2026-08-06-read-only-workspace-browser.md`

## 一句话

App 用纯数据说「我需要 `workspace-files/v1`」，**部署者**说「这个 contract 由这个 provider 满足」，
可信外层对每个 App 实例调一次 `openInstance()` 拿一个窄句柄，目录在**第一次用到**时按
(owner, publisher, app, instance, binding) 打开一个 provider scope，在句柄/实例/账号/进程结束时关掉它。

## 身份绑定一次，不是每次 dispatch 带一遍

```ts
const handle = catalog.openInstance({
  owner, publisher, app, packageDigest, permissionContractDigest, instance, plan,
});
await handle.dispatch({ action, params });   // 只有这两个方法
await handle.close();
```

`publisher` 与 `permissionContractDigest` 不是装饰：stable app id 由发布者自己挑，两个发布者可以都叫
`notes`，所以 publisher 进 key（否则它们共享 ref、stream 与退休记录）；而 provider 的 grant resolver
必须按**这个实例被打开时的那份契约**求交集，去查「此刻最新的契约」等于让一次激活重新解释一个已经被
同意过的标签页。三个字段做有界格式校验，**失败拒绝打开**——回落到默认 publisher / 默认契约就是替
授权层编造答案。

**没有**「顺便把 identity 一起传进来」的公开入口。这不是人体工学，是三条只有这样才成立的性质：

1. **实例在读任何东西之前就存在。** 一个还没发过资源请求就被关掉的标签页，是一个**登记过、然后被
   退休**的实例；它通道上迟到的那条消息撞到的是一个已关闭的句柄。换成「首次调用时才登记」，那条
   消息会在标签页消失几分钟后**第一次**打开一个 provider。
2. **设备集合变化时分得清两个标签页。** `closeOwner` 退休这个账号**全部**句柄，包括从没读过东西的
   那些。只认识「已打开的 scope」的目录做不到——旧标签页和新标签页那时都没有 scope。
3. **plan 是快照。** `openInstance` 当场把 `binding → contract` 冻住。之后谁再改那个 plan 对象，都改不了
   一个已经发出去的句柄能够到什么。

`register()` 同样是快照：contract、action 闭集与三个方法在注册那一刻读一次，所以 `seal()` 之后调用方
改 descriptor（往 `actions` 里 push、把 `dispatch` 换掉）对目录没有任何影响。`openInstance` 与
`dispatch` 都**只在 seal 之后**可用。

## 分工，写死

| 谁 | 说什么 |
|---|---|
| App（release 资产） | `agent-resource-bindings/v1`：需要哪些 contract、哪个模块实例接哪个 binding。**没有** provider 包名 / import / URL / owner / device / workspace id / Context / grant / token / 启动命令 / 版本范围 |
| 部署者（composition root） | `register()` 逐个装、`seal()` 封存。没有 watcher、没有 `npm install`、没有 URL import、没有 App 提供的 callback |
| Host（本目录） | 按 plan 解析 binding → contract → provider → closed action，然后开 scope、派发、关 scope |
| provider | 组合已有的东西（capability grant、backend、service），**不新增权限模型** |

这是 Backstage 的规则（backend instance 显式装配，插件只声明依赖），不是它的包加载器。

## dispatcher 的四个问题，顺序就是安全内容

```text
1. 哪个 binding？      ← 从 App 的 plan（可信文档），不是从 action 字符串
2. 哪个 contract？     ← 那个 binding **声明**的，不是提议里写的
3. 哪个 provider？     ← 精确 contract 查表，找不到就是拒绝，**没有通用 proxy 兜底**
4. 这个 action 在不在 provider 的封闭集合里？
```

伪造 wire 字符串的 View 停在第 1 步：它说出的 binding 不在 plan 里。**没有 `invokeArbitrary`**——
provider 接口上根本没有这个形状。

## 三条不明显的决定

1. **scope key 是派生的，不是传进来的。** `[owner, publisher, app, instance, binding]`。调用方能选 key
   就能选别人的 key，而 ref 与 stream 正是按这个字符串 scope 的。提议里的 `owner`/`scope`/`instance`
   **不被读取**——比「被拒绝」强，因为不存在一个我们会去比较的值。
2. **关闭之后永不重开。** 关闭是一个决定（实例结束了 / 设备凭据换了）；懒重开会让那个决定失效——
   一个刚被撤销的 port 会用新授权重新开始作答，而没有人做过这个决定。`openInstance` 对一个已退休的
   instance id **抛异常**：新标签页 = 新 instance id，那才是重新决定的地方。
3. **provider 的异常与它的原文都不过界。** 这条路径上抛出的错误正是唯一稳定携带 canonical path 的
   东西（Node 的 `fs` 错误天生带路径），所以 catch 之后只留一个 `unavailable`。

## 关闭的顺序

`handle.close()` / `closeInstance` / `closeOwner` / `shutdown` 都汇到**每个实例一条**的拆解：
**同步**把实例标成 closed、把 key 退休、从活表里删掉、把 scope 取出来，然后**同步**调 provider 的
`close`；返回的 promise 只是「已经开着的东西」的释放。所以「关闭开始后不能再 open/call/mint ref」在
**返回时**就成立。同一个实例的多个 close 调用共享**同一个** promise。

provider 的 `close` 失败（同步抛或异步 reject）会被记录并吞掉：那时实例已经够不着了，把它抛出去只会
让一次**已经完成**的撤销看起来像失败的。它漏的是句柄，不是权限。

Workspace Files provider 自己那一层再细一步：**先 refs、再 streams、最后 grant**。反过来写的话，
取消流时抛异常就会留下一批还能解析的 ref，而持有它们的 port 是从一个已经没了的授权派生出来的。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | provider 是什么（contract + 封闭 action 集 + open/dispatch/close）、可信调用者**一次性**传什么、四个目录级 refusal code |
| `catalog.ts` | register/seal 的快照、`openInstance` 与窄句柄、四个问题、scope 派生与懒开、退休与关闭语义 |
| `workspace-files-provider.ts` | **两个注册、一份实现**（2026-08-10）：`workspaceFilesProvider` 服务 `workspace-files/v1`，`workspaceFilesProviderV2` 服务 `/v2`——同一个 service、同一条 grant 接缝、同一组 action，只多投影一个 `directoryKey`。两次注册而不是一个 provider 兼服两版，因为目录把一个 binding 解析成**恰好一个** contract，而一个 release 说哪一版是它 plan 里的事；**按调用决定就是从 View 说的话里决定**。两版的封闭 action 集也在这里分叉（2026-08-17，工单 #243）：v2 多一个 `resource.resolve_path`（可信侧一次跑完 chat 链接的逐层 listing 下钻，权限词元仍是 `list_workspace_entries`），v1 保持冻结的六个——v1 binding 提这个动词停在目录的封闭集检查。共用 service （一个 ref vault、一个 broker）是安全的：scope key 里本来就带 binding 名。两者都是：一个部署提供的 `openGrant(context)` 授权 seam + `RunnerWorkspaceFilesBackend` + `WorkspaceFilesService`，五个 action 到 port 方法。**「这个 scope 能不能读、要不要每次批准」不在这里决定**——那是 `session-resource/workspace-grant.ts`，因为它是同意流程的问题 |

## 测试

```bash
npx vitest run --project node packages/bot/src/agent-resources
```

| 文件 | 证明什么 |
|---|---|
| `catalog.test.ts` | 重复注册 / 封存后注册 / 空白与非法 descriptor / 缺方法一律抛错；**descriptor 与 plan 的快照**（seal 后改 `actions`、`contract`、`dispatch`，或改 plan 的 bindings，都不改变行为）；seal 之前不能 openInstance；跨 App 的 plan、空身份、重复与已退休的 instance id 抛错；未声明 binding、未安装 contract、封闭集外 action **全部在 provider 被打开之前**停下（断言的是 open/call 次数）；**从未读过的句柄被 close / 被 closeOwner 之后第一次 dispatch 不 open**、而新 instance 仍可用；四个 close caller 与 provider `close` 的同步重入都等同一个未提前完成的 promise；provider 抛异常或 close 失败时路径与原文都不过界 |
| `contract-boundary.test.ts` | 读 `packages/workspace-files-contract/src` 的源码：不 import 可信侧、依赖恰好两个 contract 包、代码里没有身份字段名、没有第二条通道或 `fetch`/动态 `import()`、port 上没有通用 invoke。**放在这里**是因为读文件要 `node:fs`，而那个包的 tsconfig 刻意是 `"types": []` |
| `workspace-files.e2e.test.ts` | **纵向**：typed port → 远端 client → 目录 → capability Gate → 真 WebSocket → 真设备实现 → 真 temp home，再原路回来。伪造/跨 scope/错 kind 的 ref、别的账号、未声明的 binding、封闭集外的 action **零 frame**；换设备凭据后立即拒绝；无 auto-allow 时是一张批准卡而不是一次读 |
