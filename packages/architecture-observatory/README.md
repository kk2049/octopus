# Architecture Observatory

这是 Octopus 的可重复生成的架构分析器。它不是一张手画的大图，而是把三类证据合成同一份 atlas：

- TypeScript 与 dependency-cruiser 推导的文件、模块、import 和函数调用事实；
- `architecture/atlas.json` 中少量、稳定的职责边界与系统级约束；
- 靠近真实控制点的 `@architecture` 注释，以及已有测试、文档和 TCB 预算。

架构页的「模组」剖面也由同一次扫描产生：导出且显式类型化的 `AgentModuleManifest` 自动进入 View 列，
`declareContract`/`ContractDeclaration` 提供中文功能与 action 目录，导出的 `ResourceProviderDefinition` factory
进入可信 Provider 列；生产 `catalog.register(factory())` 决定是否标为已注册。箭头只表达 View→contract、
contract→Provider 与未来可静态证明的 Provider→Provider 关系，不再把普通 `package.json` import 冒充生态依赖。
Capability Kernel、Host、Registry、Runner 和构建工具属于平台底座，留在系统/依赖剖面而不进入可组合模组目录。

总览的 circle packing 仍以 `architecture/atlas.json` 中的稳定职责模块为主，但不会再让新代码静默缩进
一个固定的 `Unmapped source` 圆。每次分析都会对照 workspace manifests 与真实源码：一个 package 只要
含有尚未被显式最长路径前缀归属的源码，就自动得到独立的待归类模块，代码行数、依赖和 Git 触达也随
当前 checkout 重算。自动模块留在 `unmapped` 信任区并产生 finding；只有人工清单能把它提升到具体职责
和信任域。

视图层已迁入 `packages/dashboard-web` 的架构页；本包只负责生成 `.generated/atlas.json` 快照。

依赖剖面的“非测试值”是源码级 value import，包含构建/发布工具，不等同某个部署产物。需要约束具体 bundle 时，在 `forbid-external.entrypoints` 声明真实入口，分析器会沿非测试、非 type-only 文件边计算闭包；入口缺失会失败而不是静默通过。

依赖扫描从已确认的源码文件清单起步。workspace import 即使在本地构建后解析到 `dist/`，其直接边仍会保留，但分析器不会跟进生成物；因此先后执行 package build 不会改变模块依赖图。

模块档案把运行时和值依赖的 `runtimeFanIn/runtimeFanOut` 与仅类型依赖的
`typeOnlyFanIn/typeOnlyFanOut` 分开计算和展示。为旧消费方保留的 `fanIn/fanOut`
现在是 runtime-only 别名；不能用它推断类型耦合已经消失。

## 本地运行

```bash
# 强制生成新快照（第一次约 1–2 分钟）
pnpm --filter @claude-bot/architecture-observatory analyze

# 输入没有变化时复用快照
pnpm --filter @claude-bot/architecture-observatory analyze:cached

# 机器约束失败、无法判定或分析器严重异常时返回非零
pnpm --filter @claude-bot/architecture-observatory check
```

快照在 `.generated/atlas.json`，不进 Git。快照含源码路径、短摘录、commit 与架构调查结果，**不得作为无鉴权公网静态站发布**。

Dashboard 组合会对它实际运行的 checkout 做自动对账：启动后立即比较 `HEAD` 与当前快照，缺失或
过期就后台分析并按 commit 留档；失败后每 5 分钟重试。这里的 commit 是已部署、正在运行的版本，
不是尚未部署的 `v4` 中间水位。页面上的「重新分析」保留为显式刷新入口。

注册 CI workspace provider 的部署会把自动和手动分析都交给该 Runner 的独立 `architecture`
工作区，复用现有 CI 单执行槽、owner 授权和持久任务回执。服务只比较版本、读取页面及快照，
并接收精确已部署 commit 的压缩产物；不会因 Runner 离线而回退到本机全仓分析。
没有配置 CI workspace provider 的其它部署保持既有本地分析行为。

同一 commit 复用原任务，服务重启不取消远端分析；产物中断后按已收字节续传，校验完成才原子替换。
离线或损坏产物保留旧快照并显示失败原因。已终结的失败任务也保留原回执，不在五分钟循环中
无限重跑；需处理失败原因并通过后续部署创建新 commit 的任务。页面刷新成功产物会直接复用。
Git 输入优先利用目标工作区已有祖先提交，已有同一 HEAD 时不传源码；初次空工作区仍需要一次种子包。
出站日志标注用途、commit 和载荷大小，不包含下载 token；载荷大小不等同云账单的实际网络字节。

## 哪些信息写在哪里

模块、信任域、流程入口和系统级约束写在 [`architecture/atlas.json`](../../architecture/atlas.json)。[`architecture/schema.json`](../../architecture/schema.json) 描述完整字段并供编辑器检查；运行时加载器另外拒绝错误根结构、重复 ID、未知 zone 和缺少路径归属等关键错误。

import、类型引用、调用、行数、复杂度和 Git 触达由工具推导，不写注释。只有编译器无法可靠推断的语义转换才靠近实现标注，例如：

```ts
// @architecture flow=capability-invocation step=mandatory-policy after=freeze-args role=gate label="Mandatory Object policy" condition="arguments remain valid" outcome=policy-decision authority="Object-owned policy" enforces=AUTH-002
const decision = await policy.decide(request);
```

约束如下：

- 一条标注必须是 TypeScript/JavaScript 的真实注释，字符串里的同形文本会被忽略；
- 属性是空格分隔的 `key=value`，含空格的值用引号；
- 流程节点至少写 `flow` 和 `step`，有前驱时写 `after=a,b`；
- 分支节点写 `condition`、`outcome`和实际使用的 `authority`；离开声明 scope 的叶子必须写 `terminal=true`；
- `architecture/atlas.json` 为每条 flow 声明 `coverage.scope/exclusions`，`flow-complete` 同时校验必需步骤、边和终点；
- `enforces=A,B` 是实现者的可审阅主张，不会被伪装成机器证明；
- 标注应落在真正完成身份绑定、授权、重绑定、提交或关闭的语句旁，不要给每个函数贴标签。

完整的方法、约束矩阵和生态选择见 [`doc/design-architecture-observatory.md`](../../doc/design-architecture-observatory.md)。

## 改动入口

| 目标 | 文件 |
|---|---|
| 调整模块/信任域/流程/约束 | `architecture/atlas.json` |
| 临时豁免一条精确失败见证 | `architecture/waivers.json` |
| 扩展静态事实 | `src/analyzer/` |
| 扩展输出数据契约 | `src/shared/model.ts` |
| 调整模组自动发现与分类 | `src/analyzer/module-ecosystem.ts` |
| 调整总览中新 package 的自动可见性 | `src/analyzer/paths.ts` |

## 验证

```bash
pnpm --filter @claude-bot/architecture-observatory typecheck
pnpm --filter @claude-bot/architecture-observatory test
```

`check` 与 `analyze` 不同：`analyze` 忠实生成当前状态，即使存在架构违反；`check` 会在机器约束失败、无法判定或分析器严重异常时返回非零。

## 临时豁免精确见证

已知且明确接受的架构债只能在 [`architecture/waivers.json`](../../architecture/waivers.json) 中按单条失败见证豁免，不能豁免整条约束。先从生成快照的 `constraints[].violations[].witness` 复制原值，再记录 `reason`、`owner`、`created_at` 和必填的 `expires_at`；例如模块路径见证是 `path:view -> trusted-ui`，外部依赖见证是 `external:view -> node:fs`。

未过期且精确命中的见证进入 `waivedViolations`；如果一条约束的失败见证全被覆盖，其状态为 `waived`，`check` 打印清单并继续以 0 退出。部分命中仍保留 `fail`。到期豁免立即失效，原见证恢复失败，同时产生清理 finding；未命中当前失败见证的有效条目产生 `stale waiver` finding。`unknown` 代表证据不足，不能用 waiver 降级。文件格式见 [`architecture/waivers.schema.json`](../../architecture/waivers.schema.json)。
