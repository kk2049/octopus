# Architecture Observatory

本包是开发工具，不进入 bot、Dashboard 或 Agent View 的生产请求路径。它把仓库事实生成成一个静态 atlas（`.generated/atlas.json`）。视图层已迁入 `packages/dashboard-web` 的架构页。

## 职责边界

```text
architecture/atlas.json       人维护：稳定职责模块、信任域、流程骨架、系统约束
workspace manifests           工具推导：尚未被稳定模块覆盖的新 package
TypeScript Compiler API       工具推导：文件、符号、调用、真实注释
dependency-cruiser            工具推导：解析后的 import 与循环
AgentModuleManifest/ContractDeclaration/Provider factory 工具推导：可组合生态拓扑
git                           工具推导：commit、dirty、变化热点
          │
          ▼
.generated/atlas.json         单一、版本化的只读快照（由视图层消费）
```

- `src/analyzer` 不依赖浏览器层；视图消费方只读 `src/shared/model.ts` 定义的结果。
- `architecture/atlas.json` 不复制 import 图和函数调用；这些事实必须由分析器生成。
- 新 workspace package 不能因为未及时写入清单而挤进一个不变的总圆：有源码且未被任何显式前缀覆盖时，分析器会为它生成独立的 `unmapped` zone 模块并提示人工归类。显式最长前缀始终优先，工具不替人猜信任域或关键级别。
- `moduleEcosystem` 不维护第二份模组清单：View 只认导出的、显式类型化 `AgentModuleManifest`；兼容接缝来自 typed contract declaration；后端只认导出的 `ResourceProviderDefinition` factory 及生产组合根的 `catalog.register()`。普通 workspace import、Capability Kernel、Host 和构建工具不冒充生态模组；无法静态读取的声明必须成为 finding。
- 分析器不把一条注释当证明。`declared`、`executable`、`derived`、未来的 `runtime` 四类证据必须保留等级。
- 测试源的依赖单独记为 `testCount`，不能进入非测试值循环或禁止依赖。“非测试值”包含构建工具；具体产物边界必须使用入口闭包约束。
- 模块依赖剖面分别报告 `runtimeFanIn/runtimeFanOut` 与 `typeOnlyFanIn/typeOnlyFanOut`；兼容字段 `fanIn/fanOut` 只代表 runtime，不能再把 type-only 边混入运行时扇出。
- 生成文件和构建产物不提交。

## `@architecture` 标注纪律

只标编译器不知道的业务语义：一次身份绑定、一个强制门、一处已验证参数的封存、一次跨信任域重绑定、一个生命周期提交点。不要标模块归属、普通调用或 import。

```ts
// @architecture flow=<flow-id> step=<step-id> after=<step-id,...> role=<role> label="human label" condition="branch condition" outcome=<result> authority="trusted basis" terminal=true enforces=<constraint-id,...>
```

- 解析器只读取 AST 识别出的真实注释，严格拒绝无法解析的尾部文本。
- `flow + step` 必须对应 atlas 中的流程；重复锚点、缺锚点和不存在的前驱都产生 finding。
- `after` 表示可能的直接前驱（多个值通常是汇合分支）；关键分支必须写 `condition/outcome/authority`，契约叶子写 `terminal=true`。
- 每条 flow 的 `coverage.scope/exclusions` 决定能声称的覆盖边界。注释契约不是全程序 CFG 证明，不得把“已声明分支齐全”写成“所有运行路径齐全”。
- `enforces` 是实现锚点。若要证明性质，优先给约束添加现有测试的 `executable` evidence，不要把实现注释改名为 `verifies`。
- 标签紧贴真正完成语义的语句；移动实现时一起移动标签。

## 安全与诚实边界

- atlas 包含路径、源码摘录与内部架构，不得作为无鉴权公网静态站发布；任何视图入口只能本地 loopback 使用。
- 当前没有运行时 trace。反射、字符串协议、依赖注入和动态注册可能不在静态调用图里；消费方必须继续展示 `meta.limitations` 所代表的诚实边界。
- 复杂度与 Git 触达是 review 排序信号，不是质量分数。
- `check` 失败不能为了“变绿”直接删约束或扩大 allowlist；要么修依赖，要么在设计文档中说明为何约束口径错误。
- `unknown` 与 `fail` 都必须阻断 `check`；分析器证据不足时不能降级成通过。

## 测试

```bash
pnpm --filter @claude-bot/architecture-observatory typecheck
pnpm --filter @claude-bot/architecture-observatory test
```

| 测试 | 保证 |
|---|---|
| `config.test.ts` / `paths.test.ts` | 清单校验、最长路径归属与未归属不会静默消失 |
| `annotations.test.ts` / `flows.test.ts` | 真注释解析、字符串免疫、流程锚点完整性 |
| `dependencies.test.ts` / `graph.test.ts` / `fingerprint.test.ts` | 值/类型/测试分层、外部包证据、路径、强连通分量与安全缓存失效 |
| `constraints.test.ts` | 禁止路径、入口闭包、声明性主张不冒充证明、最短循环见证 |
| `typescript.test.ts` | 与 capability-kernel TCB 一致的代码行口径 |
