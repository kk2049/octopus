# `@claude-bot/agent-data-view` — 通用数据 UI 模块

> **2026-08-07（平台收敛计划 P4）**：`data.list/v1`、`data.detail/v1`、`data.form/v1` 三个模块 +
> 一个 `app-data/v1` typed port + 一个轻 provider。它们是**实例配置（决定 7）的第一个真实消费者**：
> 同一份实现被 composition 里两条 instance 配成「收件箱」和「归档箱」，模块里没有任何分支。

---

## 这个包是什么

| 文件 | 职责 |
|---|---|
| `src/port.ts` | `app-data/v1`：App **自己的**投影 + 动作面，作为 typed port；`createAppDataPort()` 把 App 的一条通道适配上来 |
| `src/adapter.tsx` | `appDataAdapter`：整个 App 的接线**一行**（`providers: { [APP_DATA_CONTRACT]: appDataAdapter }`）。参数按结构类型写成本包自己的 `AppDataChannel`，所以它满足 SDK 的 `PortAdapterFactory` 而本包**不 import** SDK 根入口 |
| `examples/inbox.preview.ts` | **零代码 App**：一份 composition + 模块表 + 那一行接线 + fixture 投影。`src/example.test.tsx` 用它当真实断言，所以它是承重的，不是文档 |
| `src/manifests.ts` | 三份 manifest（纯数据，Node 侧 release builder 要读，所以不 import React/CSS）+ 三份 `config` 声明 |
| `src/context.tsx` | `AppDataProvider` / `useAppData`：**订阅一次**投影快照，往下传 |
| `src/lib/select.ts` | 纯 reader：点分路径、行归一化、facts、参数声明。全部 `unknown` 进、带 status 出 |
| `src/components/*.tsx` | 三个纯展示组件，props 进、元素出 |
| `src/modules.tsx` | 三个 `ModuleRegistryEntry`：读实例配置、读投影、持有每实例状态、发 `open-resource/v1` |
| `src/harness/` | 内存 port（第二个真实实现），`app:preview` 与测试共用 |

---

## 三条不可协商

1. **模块只认 port，不认通道。** `useProjection()` 在 `@claude-bot/agent-view-react` 的**根入口**，
   而根入口同时 re-export 传输与 wire 常量——View 模块不许 import 它。所以投影经
   `app-data/v1` 这个 port 到达，和 `agent-sessions/v1`、`workspace-files/v1` 同一个形状。
   这是**架构张力的处置**，不是绕路：`architecture.test.ts` 把它钉成类型错误而不是习惯。

2. **`app-data/v1` 不是 `agent-resource-bindings/v1` 的 binding。** 那份文档声明的是**部署**必须
   从受信 provider 目录提供的 typed port；App 自己的投影不是那种东西——它走每个 Agent View 本来
   就有的那一条通道，由 App 自己的后端产出。把它写进 binding plan 等于要求部署安装一个没有任何
   目录服务的 provider，`linkResourceBindings` 会去执行一条不可能成立的接线。manifest 里
   `ports: ["app-data/v1"]` 是模块诚实的依赖声明；App **不**为它声明 binding，而 linker 正好跳过
   这种情况（`if (!declaredContracts.has(port)) continue`，与 `agent-sessions/v1` 今天的处境相同）。

3. **包里没有任何字面 action id。** 唯一存在的那个是 `config.action`——App 作者写在 composition
   里、reviewer 读过的数据。`architecture.test.ts` 禁止 `submit("…")` / `propose("…")` 这种写法。

---

## 配置词表（决定 7）

`config` 是**扁平、有类型、有界**的（嵌套配置就是第二套 schema 语言）。所以「渲染投影的哪一部分」
是一个**点分路径字符串**，「显示哪些字段」是另一个指向投影里已有清单的路径。配置值在这里从不被
当成结构解析。

- **`data.list/v1`**：`source`(必填) `title` `id_key` `title_key` `subtitle_key` `badge_key`
  `tone_key` `empty_text` `limit` `open_kind` `open_view` `default_ref` `notice`。
  `open_kind` 是列表变成导航的开关：设了它，选中一行就发 `open-resource/v1`（ref = 行 id），
  由 composition 的 open 规则决定谁来答；不设就只有本地高亮。`default_ref` 指向投影里的一个 id：
  读者没点过时高亮它（`userOverride ?? derivedDefault`，点过之后数据帧动不了选择）；`notice`
  指向投影里的 `{tone, text}`，作为列表顶部的有界横幅（逾期提醒之类），投影不给值就没有。
- **`data.detail/v1`**：`source`(必填) `title` `id_key` `title_key` `body_key` `fields` `empty_text`
  `default_ref` `sections` `thread_key` `thread_title` `menu` `allowed_actions` `variant`。
  **`id_key` 一个键决定整份读法**：设了 = `source` 是集合、按 `resourceRef` 查找；不设 = `source`
  就是这条记录（engine 的 `kv` 用法）。不做形状嗅探——那会让一个面板的行为取决于此刻恰好有多少
  数据，集合一空就变。2026-08-13（工单 #97）加的五样让一条记录成为**完整的工作对象**而不是三块
  失联的面板：`default_ref` 让首屏显示投影选的那条（通常是最新）而不是「请去点左边」；`sections`
  指向 `{字段: 小节标题}`，把记录自己的长文本字段（证据、覆盖说明）渲染成正文后的 Markdown 小节
  ——**跟着这条记录走**，不是永远显示最新那条的第二面板；`thread_key` 把记录里的
  `[{by,at,text,badge,tone}]` 渲染成时间线；`menu`+`allowed_actions` 是记录级动作菜单，与
  `data.actions/v1` 同一个 reader、同一条 allowlist 纪律，菜单条目可声明 `context_param`，弹出的
  表单把**当前记录的 id** 锁进那个参数——「对这条做点什么」从此不需要读者抄 id。`variant: stats`
  把事实表画成统计格。
- **`data.form/v1`**：`action`(必填) `fields`(必填) `title` `submit_label` `hint` `reset_on_success`
  `context_param` `context_value`。
  `fields` 指向投影里该动作的**参数声明**（engine 的 `params` 形状），所以表单是**从后端校验用的
  同一句声明生成**的，不是画在它旁边。提交态按本实例的 `action` 从 proposal ledger 过滤：
  `inflight` 禁用控件并显示 spinner/「提交中…」，`refused` 在表单内显示有界原因并可清除。
  `context_param`/`context_value` 是打开方注入的参数：该字段渲染成锁定值而不是输入框，提交时并回
  payload；**只注入声明里存在的参数**——否则一个 UI 便利就变成了未声明的 wire 字段。

`config.test.ts` 断言「manifest 声明的键」与「模块真的读的键」是同一份列表——多一个是死配置，
少一个会让 composition 在 link 时被拒。

---

## 词表来源与刻意的减法

组件语义移植自 engine 探针的组件目录（`packages/engine/REFERENCE.md`）：`list` / `kv` / `form`，
含「form 从 action params 自动生成」这条已验证设计。**没有搬**的是 YAML 页面机制——v4 的答案是
React 模块 + 五 slot 组合。`actions`（→ `data.actions/v1`）、`timeline`（→ detail 的
`thread_key`）、`banner`（→ list 的 `notice`）在真需求到来时补上了（工单 #97：任务汇总/汇报两个
App 就是那个真需求）；`table` 仍在等它的。

三条边界：
- `object` 类型参数（engine 的 textarea-JSON）**不做**。提议通道只携带字符串。
- 声明超过 `APP_DATA_LIMITS.maxFields`（8）时**整份拒绝**而不是截断——悄悄丢掉最后两个字段的表单
  会提交一个不完整的动作然后报告成功。
- 行 id 会被当成 `ResourceLink.ref`，而 ABI 要求它是**有界可打印 ASCII**。非 ASCII id 的行仍然可以
  本地选中，只是打不开（`workspace.open()` 返回 false）。
- **`projection === null` 是「还没到」不是「路径不存在」**。三个组件都在 status 分支**之前**先看
  `booting`——通道刚开时告诉 App 作者「你的组合写错了」是最坏的一次首屏。

---

## 测试

```bash
node_modules/.bin/vitest run --project agent-data-view --maxWorkers=1

# 看一眼（vite dev + memory port，不 pack 不激活不碰生产）
pnpm run app:preview -- packages/agent-data-view/examples/inbox.preview.ts
```

| 套件 | 钉住什么 |
|---|---|
| `lib/select.test.ts` | 「路径不存在」与「集合为空」是两个答案；原型链够不到；嵌套对象被省略而不是 `[object Object]` |
| `modules.test.tsx` | 三个模块对着**第二个真实 port**（内存实现）跑；**收件箱/归档箱验收场景**走真 shell + 真 composition；配置写错在 link 期就被拒 |
| `example.test.tsx` | 那份**零代码示例**真的能装起来：五个 surface、两个同模块不同用途的列表、open 规则路由、从参数声明生成的表单 |
| `config.test.ts` | 声明与读取是同一份列表 |
| `architecture.test.ts` | 六条依赖边界（无受信侧 / 无传输 / 无根入口 / 无字面 action / 无身份字段 / 无自建通道） |
