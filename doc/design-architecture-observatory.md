> **2026-08-09 移植说明**：本设计文档随分析器一起从 `dev/codex-architecture-observatory` 分支移植。
> 原独立 Vite/Cytoscape 视图层已退役；视图层现为 `packages/dashboard-web` 的「架构」页（`/architecture`），
> 分析器包只负责生成 `.generated/atlas.json` 快照。文中关于旧 web 视图的段落按此理解。

# Architecture Observatory：面向持续 code review 的交互式架构切面

## 结论

Octopus 不需要另一张“当前看起来正确”的架构图。它需要一个能随每次提交重新计算、能区分事实与主张、能从宏观异常下钻到精确源码的审阅面。

本设计采用混合模型：

1. 编译器和依赖解析器自动生成可重复的结构事实；
2. 一份集中清单定义稳定的模块语言、信任域、关键流程和系统约束；
3. 只在编译器看不懂的语义转换旁加稀疏的 `@architecture` 注释；
4. React + Cytoscape 将同一模型投影成多个可交互切面，而不是把所有概念塞进一张图；
5. 每个结论保留证据等级与源码入口，避免“图上有一条线”被误读成证明。

实现位于 `packages/architecture-observatory`，清单位于 `architecture/atlas.json`。

## 对当前仓库的评估

### 已经做对的部分

Octopus 并非没有架构，恰恰相反，它已经有一批质量很高的局部架构机制：

- `packages/capability-kernel` 以唯一 Gate、绑定后的 Context/slot/Object 和 TCB 预算表达 complete mediation；
- Dashboard 用 Fastify 的 pre/guarded scope、路由表双向完整性和 Cedar 把“漏写授权”变成 fail closed；
- Agent View 用独立 origin、独立 bundle、MessagePort 的 proposal-only 协议表达不可信边界；
- v3 composition root 用“不构造服务”表达结构性最小权限，并显式记录生命周期逆序关闭；
- app registry、state process、capability store 分别把不可变身份、单一事实源、单写者和崩溃恢复写进代码与测试；
- ADR、`CLAUDE.md`、TCB reading guide、handover 文档和大量反例测试解释了“为什么”。

问题不是缺少知识，而是知识分散在模块说明、长篇设计文档、测试和少数关键函数中。每天几千行变化后，人无法稳定回答：

- 一个模块现在实际依赖谁，测试便利性是否掩盖了生产耦合；
- 一次请求从不可信输入到真实副作用，在哪一步绑定身份、在哪一步授权、批准后是否重新过门；
- 哪些文件进入 TCB，最近是不是无意扩大；
- 一个文档主张是编译器推导、测试保证，还是只有实现者声明；
- 宏观异常具体从哪条 import 或哪个控制点开始读。

最终首轮扫描覆盖 501 个 TypeScript/JavaScript 源文件、3,458 个可执行符号、5,028 条可解析调用、141 组跨模块依赖和 280 组外部依赖。规模已经超过“读一遍代码后手画图”能够持续维护的范围。

### 当前可见的架构信号

初始 atlas 映射 36 个职责模块、11 个信任/部署域、5 条关键流程和 19 条系统约束。扫描可以直接复用仓库已有的 TCB 预算，当前可信闭包为 716 代码行，baseline 为 705，仍在 50 行容差内。

模块非测试值依赖图仍有两个跨模块强连通分量：一个是 `engine-core` / `engine-host` 两模块；另一个实际包含 15 个模块，`agent-session → bot-core → agent-session` 只是其最短循环见证，不是整个 SCC 成员列表。它们不是由本工具修复的：观测台在依赖剖面中压缩 SCC、标出所有环内模块，关键骨架仅保留最短循环见证；“全部边”仍可查看完整环内关系。后续应判断是组合根反向依赖、模块切分口径过细，还是需要抽出 port。测试文件产生的边单独进入 test 图层，不参与该循环结论；构建/发布工具等非测试源码仍算模块耦合，不能被含混地称为“生产 bundle”。

初始 19 条约束中，10 条机械约束通过，`MOD-001` 失败，8 条语义主张保持 `review`。外部依赖约束保留所有 package/core-module 边，但对浏览器能力使用真实入口的值依赖闭包；因此同包 Node 侧构建工具不会误报，入口实际可达的 Node 能力仍会失败。

## 理论基础：系统不是一张图

Parnas 的信息隐藏原则关注的不是“函数分得够不够小”，而是模块是否围绕容易变化的设计决定建立边界；因此本工具把职责、变化热点、扇入/扇出与依赖方向放在一起，而不是只展示目录树。原论文入口：[On the Criteria To Be Used in Decomposing Systems into Modules](https://citeseerx.ist.psu.edu/document?doi=5d752e29e29b42cc509417699a98d9dca8212c83&repid=rep1&type=pdf)。

Saltzer 与 Schroeder 的 economy of mechanism、fail-safe defaults、complete mediation、least privilege、least common mechanism 等原则说明，权限审阅不能只画“谁能访问谁”，还要展示身份来源、每次检查、衰减、共享机制和失败缺省。[Protection of Information in Computer Systems](https://www.cs.virginia.edu/~evans/cs551/saltzer/)。NIST Zero Trust Architecture 同样强调不能仅因网络位置或所有权给予隐式信任：[NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final)。

ISO/IEC/IEEE 42010 把 architecture description 组织为 stakeholder concern、viewpoint 与 model，而不是一幅全知图：[ISO/IEC/IEEE 42010:2022](https://www.iso.org/standard/74393.html)。C4 提供 context/container/component/code 的分层以及 dynamic/deployment 补充图，并明确强调一致 notation、legend 和不混杂抽象层级：[C4 diagrams](https://c4model.com/diagrams)。本工具借用它的“多个尺度、多个 concern”，但不强迫仓库采用 C4 术语；Octopus 的信任域、TCB、权限流比通用 container 图更重要。

由此得到一个核心判断：**可视化不是最终制品，而是对同一证据模型的可切换查询。**

## 应长期审阅的系统级约束

“模块解耦”和“授权路径不泄露”只是两类。对于长期维护的大型 agentic system，至少需要以下切面：

| Concern | 典型失效 | 自动提取 | 需要增加的语义信息 | 最合适的呈现 |
|---|---|---|---|---|
| 职责与信息隐藏 | 一个变化扩散到不相关模块；组合根反向被业务依赖 | 文件归属、import、扇入/扇出、变化热点 | 模块职责、允许的方向、稳定 port | 信任域内模块图、依赖图、循环见证 |
| 信任与隔离 | 不可信 bundle import 可信 UI；sandbox 获得网络/秘密 | 包/文件依赖、外部依赖 | 信任域、禁止可达关系、边界契约 | 分区图、禁止路径高亮 |
| 身份与授权 | 调用方自报身份；只在入口检查；批准恢复绕过 Gate | 调用与 import 的部分事实 | bind/check/attenuate/recheck/effect 步骤及实施约束 | 权限流程图、TCB 闭包、证据链 |
| 数据权威与来源 | 两份事实漂移；跨边界反射秘密；校验后又使用原输入 | store/import/call 的候选 | authoritative store、canonicalize、rebind、declassify | 数据流、边界转换、来源 inspector |
| 副作用与重放 | 把授权等同幂等；恢复时重复执行 | 调用路径、现有测试入口 | effect kind、retrySafe、commit/unknown 语义 | effect 流、恢复分支、约束卡 |
| 生命周期与故障域 | 接受新流量后才鉴权；停机次序泄漏租约；子进程崩溃带走主进程 | composition/import/call | compose/listen/drain/close、owner、restart boundary | 生命周期时序图、部署域 |
| 资源与可用性 | 无界 body、队列或图；一个租户耗尽共享资源 | 复杂度、循环、配置引用的一部分 | limit、backpressure、timeout、failure scope | 容量约束卡、热点与运行时指标 |
| 契约与演进 | 路由有 handler 无 policy；协议词表漂移；迁移不可回退 | exported symbol、schema/route 测试 | version、closed vocabulary、completeness claim | 契约视图、双向完整性证据 |
| 供应链与交付 | 构建产物陈旧；部署默认指错分支；依赖越界 | package/lock/import/Git | artifact identity、composition inventory、deploy invariant | 构建/部署切面、交付约束 |
| 审计与可观测性 | 日志没有因果坐标；审计本身泄密；静态图漏掉动态注册 | 静态锚点和审计调用 | correlation、redaction、runtime span mapping | 静态/运行时叠图、证据新鲜度 |

初版不假装一次覆盖所有列。它优先落实结构、信任、权限、数据、effect、生命周期和 delivery；资源指标与运行时 trace 留出适配点。

## 信息模型：自动事实、少量声明、分级证据

### 1. 集中清单只保存稳定名词

`architecture/atlas.json` 定义：

- zone：信任/部署边界和颜色；
- module：职责、路径归属、criticality、阅读文档；
- flow：关键流程的入口/外部参与者；
- constraint：系统级主张、严重度、可执行机制或已有证据。

清单是架构词汇表，不复制源码调用关系。最长 path prefix 决定文件归属；没有归属的散落文件进入 `unmapped` finding。
若未归属源码位于 workspace package 中，分析器会先按 package manifest 生成独立的待归类模块，让新包立即改变总览的
模块数量、面积和依赖；生成项仍属于 `unmapped` zone 并产生 finding，不能借自动发现冒充职责或信任分类。

### 2. 编译器负责稳定事实

TypeScript Compiler API 生成文件、符号、函数/方法、复杂度、import site、best-effort 调用边和源码位置。官方 API 入口：[Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)。

dependency-cruiser 负责按仓库真实 tsconfig/exports 解析依赖、类型边、动态 import 和循环。它比自行拼路径规则覆盖更多 Node/TypeScript 解析失效模式：[dependency-cruiser](https://github.com/sverweij/dependency-cruiser)，[API](https://github.com/sverweij/dependency-cruiser/blob/main/doc/api.md)。分析从编译器已经确认的源码清单起步；若 workspace export 在构建后解析到 `dist/`，该直接边仍作为证据保留，但不会继续遍历生成物。因此同一提交不会仅因本地是否先执行过 package build 而改变模块图。

测试依赖独立计数。宏观图把非测试值依赖、type-only 与测试依赖分层；“非测试值”也包含 Vite/build/release 等工具源码，并不冒充某个部署产物的精确 bundle。需要判断具体产物安全边界时，约束必须从声明入口计算可达闭包；`TRUST-002` 就从两个浏览器入口检查 Node 内置能力。用户可以在 UI 中打开测试图层，调查“测试为何需要越界”。

### 3. 注释只保存语义动词

编译器看得见 `authorize()` 被调用，却不知道那是不是本请求唯一且完整的强制门；看得见对象复制，却不知道那一步是在信任边界重绑定。只有这些信息值得进邻近注释：

```ts
// @architecture flow=dashboard-request step=identify after=http-request role=identity label="Bind server-side identity" enforces=AUTH-001
const identity = identify(request);

// @architecture flow=agent-view-proposal step=host-rebind after=host-validate role=boundary label="Copy bounded fields into Host-owned data" enforces=DATA-001
const action = { kind: proposed.kind, params: boundedParams };
```

语法使用可搜索的单行 comment directive，而不是 decorator：它不改变运行时代码、不要求函数必须被包装，也能贴在一次语义转换的具体语句前。解析器读取 AST 的真实 comment trivia；测试 fixture 字符串里的 `@architecture` 不会被误识别。

建议属性：

- `flow` / `step` / `after`：建立流程 DAG；
- `role`：identity、gate、validation、integrity、approval、effect、audit、boundary、state、lifecycle；
- `label`：界面文案；
- `condition` / `outcome`：这条分支什么时候发生，以什么可观察结果离开；
- `authority`：该步骤使用的服务端权限依据，拒绝分支通常为 `none`；
- `terminal=true`：结束“当前声明的 flow scope”，不等于函数、请求或进程必然终止；
- `enforces`：这处实现声称承载的约束；
- `verifies`：只给真正的可执行验证入口使用；
- `boundary` / `data`：未来数据流与跨域适配器的稳定扩展点。

不应增加的信息：普通函数用途、每条调用、模块名、所有 DTO 字段。这些要么可以推导，要么会形成第二份容易漂移的代码说明。

### 4. 证据不能被压成一个绿色勾

| 等级 | 含义 | 能说什么 |
|---|---|---|
| `derived` | 静态工具从当前输入计算 | 当前可见 import/call/闭包满足某个机械条件 |
| `executable` | 存在针对该性质的测试/命令 | 运行并通过后，测试覆盖的反例未发生 |
| `declared` | 清单、文档或实现注释的主张 | 给 reviewer 一个明确调查入口，不能称为证明 |
| `runtime` | 真实 trace/审计投影 | 被采样运行中观察到路径；仍不能证明没观察到的路径不存在 |

机器机制为 `pass/fail`；分析环境或输入不足时为 `unknown`，并与 `fail` 一样阻断 `check`；没有机械机制的语义约束为 `review`。这比用 agent 读完文档后全部涂绿更诚实。

## 分析流水线

```text
workspace manifests + tsconfig + source + git + atlas config
             │
             ├─ TypeScript AST → files / symbols / calls / annotations
             ├─ dependency-cruiser → resolved imports / type / dynamic / cycles
             ├─ git history → churn (attention signal only)
             └─ constraint evaluators → paths / SCC witnesses / flow coverage / TCB
                                      │
                                      ▼
                              atlas.json snapshot
                                      │
                  ┌───────────┬───────┴────────┬───────────┐
                  ▼           ▼                ▼           ▼
              system map   dependencies   control/auth   review queue
```

输入内容、配置、workspace manifests 和 commit 进入 SHA-256 指纹。`dev`/`build` 仅在指纹一致时复用快照；`analyze` 和 `check` 强制重新扫描。因此日常重复打开接近即时，而 CI 不会因为旧缓存获得假绿。

## 初始约束集

初版包含 19 条约束：

- `MOD-001`：非测试值跨模块依赖无环；
- `TRUST-001..003`：不可信 View、可信 Dashboard、边界契约之间的禁止依赖；
- `KERNEL-001`：capability kernel 不反向依赖产品控制面；
- `TCB-001`：直接复用 capability-kernel 的 TCB entry、值 import 闭包、baseline 与 tolerance；
- `FLOW-001..005`：Dashboard request、capability invocation、Agent View proposal、approval resume、v3 lifecycle 的必需步骤、分支边和契约终点都有唯一源码锚点，且前驱存在、流程无环；
- `AUTH-001..003`：服务端身份绑定、唯一 Gate、衰减/撤销等语义主张；
- `ROUTE-001`、`DATA-001`、`EFFECT-001`、`LIFE-001`、`DELIVERY-001`：路由完整性、边界重绑定、重放语义、生命周期和交付完整性。

后七类首先显示为 `review`，因为“有注释/有文档”不等于自动证明。后续可以给某一条约束增加专门 evaluator，或把已有测试结果作为 CI artifact 导入；无需改变 UI 数据模型。

## 交互呈现

### 模组生态

「模组」剖面不复用人工维护的架构 module 清单。分析器从导出且显式类型化的
`AgentModuleManifest` 读取前端模组身份、slot、open kind 与 typed port；端口常量通过 TypeScript symbol
追到声明 package。`declareContract`/`ContractDeclaration` 提供接口中文摘要、action 与 operation；导出的
`ResourceProviderDefinition` factory 才是可信后端模组，生产组合根中的 `catalog.register(factory())` 证明它已安装。
无法静态读取的声明产生 finding，不能静默消失。

呈现上是 `View contribution → typed contract → trusted Provider` 三层。View 按 package 压成一列短行；点击后右栏
用 manifest 的 title、slot、open kind 与 config key 生成带假数据的可交互最小示例和适配说明。搜索、树、聊天、
表单、盘面、幻灯片、文档与状态示例都使用真实 HTML 控件和本地 React 状态，不再用空白条纹冒充界面；它们不连接
Host、身份、typed port 或真实资源，也不把不可信 View 代码导入可信 Dashboard origin。
contract 与 Provider 节点在英文 id/name 下显示中文职责，详情列出 action、权限 operation、消费者、实现者与注册状态。
Provider 之间只有受信组合根能证明的显式依赖才进入 SCC/拓扑排序；当前 catalog 是平的，因此诚实显示无
Provider→Provider 边。普通 workspace import 留在「依赖」剖面。

Capability Kernel、Host、Registry、Runner 与构建工具是平台基础设施，不是 App 可选择、替换或独立分发的生态模块，
所以不进入这张图。`Provider → Gate / Kernel → resource` 是所有受信调用共享的执行路径；它不表示 View 因依赖某个
contract 就获得了权限，授权仍由 scope、grant 与 Gate 决定。

### 系统地图

zone 作为带颜色和 trust 标签的行首，同行模块就是其职责成员；模块颜色重复表达归属，不再用 membership 连线制造额外噪声。系统地图**不画 import**，只回答“职责和信任边界在哪里”，因此不再与依赖剖面重复。trust 等级形成稳定分段，zone 内再按 criticality 与名称排序；每次生成得到可重现位置。

### 依赖剖面

非测试值、类型、测试三个图层独立开关。排版先用 Tarjan 压缩 SCC，再在 condensation DAG 上做最长路拓扑分层，用双向 barycentric sweep 减少交叉；大 SCC 在同一拓扑层内折成紧凑网格，不再把节点摊成一条极宽横线。箭头固定为“调用方 → 被依赖方”；`ENTRY`、`BASE`、`HUB`、`CYCLE` 分别标记入口侧、基础依赖侧、高连接模块和环成员。

默认“关键骨架”不声称是唯一真实依赖图：它在 condensation DAG 上用最大权生成森林保持分量间连通，而不会为了连接大 SCC 的每个成员重新塞满内部边；每个 SCC 都强制保留最短循环见证，再按 import 数、criticality、HUB、ENTRY/BASE 与跨 zone 信号补边。总量预算跟 condensation DAG 的分量数而非原始节点数增长，当前非测试值视图由 101 条边收敛到 29 条。用户可随时切到“全部边”核对被隐藏的依赖。点节点会暂时压暗一跳邻域之外的元素；点边显示真实 import specifier、分类、源码摘录和精确行。

### 控制流与权限流

每条 flow 是一份独立的**关键分支契约**：外部入口和 `coverage.scope/exclusions` 来自清单，内部步骤、分支条件、结果、权限依据与契约终点来自源码邻近标注。`flow-complete` 不再只检查节点名，还检查必需边、必需终点、所有叶节点的结果、重复/悬空锚点和流程环。权限流因此能直接展示“何时拒绝、用什么 authority 释放副作用、批准后如何重检”。

这仍然不是全程序 CFG 完备性证明。注释可以让“已声明的关键分支”与源码同步并可机械检查，却无法单独证明作者没有遗漏一个未声明分支。更强的“所有可能路径”需要针对具体性质的 AST/CFG/taint evaluator、反例测试，必要时再叠加脱敏 runtime trace。

### 局部调用邻域

点任意模块后，inspector 先给出按架构锚点、exported symbol、复杂度排序的源码入口和 `pathPrefixes`，并可复制 `module:<id>` 引用或 `#module=<id>` 深链；而后才进入高信号符图。符号图优先架构锚点、exported symbol 和较高分支复杂度，并只保留静态可解析的内部调用。节点按文件分组，明确报告省略数量。它是从宏观问题进入代码的桥，不是完整 call graph 浏览器。

### 审阅队列

机器违反、声明性约束、证据缺口、未归属文件、无法解析依赖和“体积 × 变化频率”热点统一排队，但保留 signal/severity 区别。热点明确不是质量评分。

Cytoscape 提供 compound node、pan/zoom、事件和多种 layout，且可以在 headless 模式做进一步图分析：[Cytoscape.js documentation](https://js.cytoscape.org/index.html)。视图模型与渲染器分开，未来替换 layout 不会改变分析契约。

对依赖剖面没有新增 Dagre/ELK 一类依赖。仓库已有 Cytoscape，它的 `cose`/`breadthfirst` 可以给通用图排位，但不同时提供“SCC 语义、稳定最长路层级、Octopus criticality/zone 排序和可解释骨架取样”。因此本包用一个无运行时依赖的局部纯函数生成 `preset` 坐标，Cytoscape 仍负责渲染、缩放、命中和下钻。这段自研的特有价值是“布局决策能被单测和解释”，而不是重写 canvas/layout 引擎。

## 生态调查与取舍

### 仓库已有能力

已有 `CLAUDE.md`、ADR、设计/交付文档、route completeness tests、TCB budget、dependency rules 的局部先例。它们保留为权威证据；本工具做索引和横向投影，不重新实现这些业务约束。

### 采用的成熟组件

| 能力 | 选择与维护/兼容性 | 安全、许可证与成本 | 理由 |
|---|---|---|---|
| TypeScript 语义 | 仓库已有 TypeScript 5.9 Compiler API；跟随仓库同一 tsconfig 和版本 | 不增加包与运行时；Compiler API 在工具包内部封装，升级只影响 analyzer | 可得到符号与源码位置，不引入第二个 parser |
| import 解析 | dependency-cruiser 18.1.x；项目持续维护，有正式 API/rules 文档；要求 Node 22，与本仓 Node 22 一致 | MIT；只在生成期运行，约 18 个直接依赖，不进浏览器/生产请求；全量解析是首次扫描的主要时间成本 | 成熟覆盖 TS/Node resolution、exports、type-only、dynamic import 与 cycle；不自行重写 module resolution |
| 交互图 | Cytoscape.js 3.34.x；成熟、持续维护的图 API | MIT、零依赖；本构建约 443 kB minified / 142 kB gzip 的独立 graph chunk，只在本地审阅台加载 | compound nodes、选择事件、pan/zoom/layout 和图算法避免自研 canvas 命中/布局系统 |
| UI | 仓库已有 React 19 + Vite 7 | 没有新的 UI 框架；独立构建，不进入任一产品 trust domain | 与当前工具链一致，组件和纯 view model 可测试 |

`pnpm audit --prod --json` 在整个既有 workspace 仍报告其他依赖树的已知问题；按路径过滤后，本包新增的 `packages/architecture-observatory` 依赖链没有命中 advisory。这个结果只说明 2026-08-07 当天的 registry 数据，不替代后续依赖更新与审计。

### 明确没有采用

- Mermaid、Graphviz、PlantUML、PDF：适合稳定文档和 code review diff，不足以承载多图层筛选、局部下钻与证据 inspector；未来可以从 atlas 增加只读导出，但不作为主界面。
- 自研 TypeScript/Node import resolver：现成解析器已经编码了 exports、tsconfig、ESM/CJS 等失效模式，自研没有额外性质。
- 自研 canvas/D3 图系统：Cytoscape 已提供图交互和 compound semantics，自研只会增加布局与命中测试成本。
- 首版接入 CodeQL/Semgrep：它们适合更深的 taint/pattern query，但会扩大安装、规则维护和 CI 成本。atlas 已留 constraint adapter；当某条具体约束需要跨函数数据流证明时再引入，而不是让全仓可视化依赖重型数据库。
- 首版接入生产 trace：当前任务没有授权部署或处理真实数据。OpenTelemetry 的 context propagation 与 tracing API 是未来适配入口（[Context propagators](https://opentelemetry.io/docs/specs/otel/context/api-propagators/)、[Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)），但 trace 必须经过脱敏、采样和 stable semantic ID 映射后才能进入 atlas。

## 限制与演进

1. 静态调用解析是 best effort。依赖注入、反射、事件名、RPC 字符串和运行时注册可能缺边；界面必须一直显示这一限制。
2. 当前 flow 覆盖了五个明确 scope 内的关键分支，不是编译器生成的全 CFG。真正需要“一条未漏”的分支级证明时应给具体约束写 analyzer/taint query 和反例测试，而不是继续堆注释。
3. Git churn 只看有限提交窗口；它帮助分配注意力，不评价设计好坏。
4. 初次全量扫描在当前机器约需 1–2 分钟。内容指纹使无变化的 `dev/build` 复用快照；未来可把 TypeScript program 与 dependency-cruiser 结果做按文件增量缓存。
5. Constraint waiver 保存在 `architecture/waivers.json`，只按报告给出的精确见证指纹生效，并强制记录 owner、理由、创建时间和到期时间。有效豁免独立显示为 `waived`，部分豁免不掩盖其余失败；过期条目恢复失败并提示清理，未命中当前失败见证的条目标为 `stale waiver`。`unknown` 不可豁免，避免用制度例外掩盖分析证据不足。
6. 当前源码链接使用内部 GitLab 模板。开源前只需替换 `sourceUrlTemplate`；数据模型不绑定平台。
7. 运行时叠图应使用稳定的 flow/step/module ID，绝不能上传参数、cookie、prompt、路径内容或用户数据。

## 安全、部署与回滚

观测台读取源码并生成摘录，输出天然是内部材料。Vite server 固定 loopback；本交付没有修改 Caddy、没有开放 8920–8939 演示端口、没有接触生产数据或运行中 bot。

整个子系统是旁路只读工具。删除 `packages/architecture-observatory`、`architecture/`、七个源文件中的语义注释和根 vitest 注册即可完整回滚，不涉及数据库、网络协议、生产 bundle 或迁移。
