---
decision_status: accepted
realization_status: partial
supersedes: []
superseded_by: []
tickets: []
---
# ADR 0007 — 协调类 App 的统一开发哲学：有门卫的共享状态机

- 状态：**已接受（架构决策）**，配套原语尚未实施（2026-08-11）
- 前置：`doc/development/agentic-app-module-system-design.md` §2.1（防错与授权是两条线）、§15.1（状态归属表）；
  [ADR 0002](./0002-agentic-app-publisher-trust-and-capability-grants.md)（发布者信任与授权）；
  [ADR 0005](./0005-backend-composition-combinators.md)（组合子边界）；
  [ADR 0006](./0006-view-wakeup-channel.md)（wake 通道）
- 现状实现：declared App（`app.yaml` + SES `actions.ts` + `projection.ts` + 组合声明）已实现本哲学的
  **单用户版本**；本 ADR 决定的是它的共享维度与固化为默认范式的边界。

---

## 1. 背景

平台的目标场景（多人棋局、员工状态协作、审批/看板/投票等）本质上都是**结构化多方协调**：
若干用户对同一份状态做受规则约束的语义变更，其他人以某种视角观看。此前平台对这类需求没有
统一答案：状态被硬编码为每账户一条私有流（`scope: {kind:"account"}`），事件作者被记为 App id，
没有推送、没有角色、没有观众。为一个棋局引入"房间/邀请/成员生命周期"子系统则是过度设计。

同时存在一个结构性矛盾：平台的权限层是彻底悲观的（fail-closed、封闭字段集、digest 寻址），
而产品哲学是乐观的（agent 写错可以事后修，因为动作历史完整归档）。两者都对，但此前所有变更
无差别支付悲观税，乐观收益却未闭环。

## 2. 决定

> **App 是一台有门卫的共享状态机：M 是带 ACL 的事件溯源状态对象；写操作是封闭语义动作集，
> 先过权利门（平台，fail-closed），再过规则门（App 纯函数，沙箱内，可修复）；V 是通用模块绑
> 投影路径；动作历史即审计面和修复面。**

六条原则：

1. **每个 App 必须声明它的 M 属于三类之一**（见 §3）：guarded event log（默认）、CRDT 文档、
   外部资源。协调类 App 一律第一类，不得混用两个事实源。
2. **权利与正确性分两道门。** 平台只判"该 principal 对该状态对象持有哪类权利"（ACL/角色成员判定，
   Cedar/capability 层的本职）；"该动作在当前状态下是否合规"是 App 的纯函数，跑在 SES 沙箱里。
   规则门判错的最坏结果是本 App 自己事件流里的一条坏事件，属于 §2.1 定义的"非恶意实现错误"，
   靠事件历史修复，不靠审批预防。**领域规则永不进入 policy 引擎或可信组合根。**
3. **共享 = 状态对象的 ACL + 角色，不引入房间/邀请/会话子系统。** 创建共享实例即设定 ACL；
   角色占位即绑定 principal；观众是 reader。"房间"不是实体，是"对象 + 它的 ACL"的同义词。
4. **写操作永远是封闭语义动作集**（`app.yaml` 声明、参数有界），不是自由字节或整文件替换。
   动作历史（app-state commit 链：actor、action、参数摘要、代码 digest、hash 链）即修复面；
   禁止为"更灵活"引入通用 `invoke` 或原始写。
5. **V 只绑投影 + 发已声明动作。** 只有出现新的交互形态才写新 View 模块，且必须通用
   （`board.grid` 是，`chess-board` 不是）。App 专属前端代码量是"缺失原语"的信号。
6. **纯 JS 依赖在打包期内联进沙箱源码**，digest 覆盖内联字节；运行时零 import 不变。
   内联物必须无 ambient authority（无网络、无 Node builtin），由打包器保证。

## 3. M 的三分类（与设计文档 §15.1 对齐）

| 类别 | 事实源 | 并发模型 | 适用 | 本 ADR 约束 |
|---|---|---|---|---|
| guarded event log | app-state commit 链 | 乐观 `expectedRevision` + 规则门 | 协调类（棋局、审批、看板、状态板） | 是，默认 |
| CRDT 文档 | Yjs update log | CRDT 合并代数 | 高频并发编辑 | 否（既有 CRDT 面） |
| 外部资源 | Runner 文件、agent 会话等 | provider 各自定义 | 资源工作台类 | 否（既有 provider 面） |

## 4. 配套原语（实施任务界定，非本 ADR 交付）

| # | 原语 | 内容 |
|---|---|---|
| P1 | 共享 scope + ACL | `app.yaml` 声明 `state.scope: shared`；实例创建设定 writers/readers；分享链接占位；门 1 查 ACL |
| P2 | 真实 actor | 事件 `by` 记 principal（用户名对发布者投影代码可见，沿用 agent inbox 披露先例） |
| P3 | 角色 | manifest 声明角色集；动作声明角色约束；占位时绑定；dispatch 时核对 |
| P4 | viewer 上下文 | host 盖章的"你是谁/什么角色"只读展示字段；View 仍无 authority |
| P5 | wake 泛化 | 共享实例的 app-state commit 向成员活跃 frame 扇出无内容 wake（沿 ADR 0006 语义） |
| P6 | 打包期内联 | esbuild 纯 JS 内联进 `actions.ts` 编译产物，进 backend 代码 digest |

前端配套：`board.grid/v1` 通用棋盘模块（N×M 格、内容绑投影路径、点击发带坐标 propose、高亮集）。

## 5. 明确不做

- **不把领域规则放进 Cedar、capability gate 或 ADR 0005 组合子。** 组合子层只留给通用横切件
  （锁、审计、限流、尺寸）；"每个游戏一个可信部署"会摧毁 declared App 免部署安装的价值。
- **不建房间/邀请/成员生命周期子系统。**
- **不做按 principal 过滤的投影（v1）。** 信息不对称游戏（暗牌、战争迷雾）需要 `projectFor(role)`，
  这是已知演进位，不是 v1 范围；v1 投影全员同构 + viewer 盖章字段。
- **不改变 CRDT 面与外部资源面的任何既有边界。**

## 6. 验收判据

1. 象棋 App（双人 + 观众 + agent 解说）专属代码 ≤ 400 行，全部为声明或纯函数，零可信代码变更；
2. 第二个协调类 App 复用 `board.grid` 或既有 `data.*` 模块，零新后端；
3. ACL/角色判定有独立测试与审计记录；规则门拒绝产生 refusal 事件而非 authority 错误；
4. 事件流可经 MCP 读面被 agent 读取，含真实 actor，支撑"事后修复"闭环。
