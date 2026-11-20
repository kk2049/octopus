# Showcase View — 模块演示（被声明的 App，纯数据）

> SDK 与布局内核：`packages/agent-view-react/CLAUDE.md`
> 通用数据模块：`packages/agent-data-view/CLAUDE.md`
> 模块 ABI：`packages/agent-module-contract/CLAUDE.md`
> 被声明的 App 与 release 形状：`packages/bot/src/app-registry/declared-adapter.ts`

## 一句话

一个**被声明的 App**（`pack → install → activate`，不改一行可信代码）的完整两半：浏览器半边由
`@claude-bot/agent-data-view` 与 `@claude-bot/agent-deck-view` 已有的**六个模块**拼成，App 自己
**没有一个组件**；后端半边是四个 release 资产里的 `actions.ts` / `projection.ts`。

## 组合

```text
navigation  data.list/v1（收件箱）+ data.list/v1（归档箱）+ deck.outline/v1（幻灯缩略图栏）
primary     deck.slide/v1（16:9 幻灯画布，就地编辑）
secondary   data.detail/v1（一条笔记）
bottom      data.form/v1（写一条）+ deck.typst/v1（Typst 源码）      （.showcase-foot）
open        data-record → data.detail/v1 @secondary rebind
            deck-slide  → deck.slide/v1  @primary   rebind
            deck-typst  → deck.typst/v1  @bottom    rebind
            data-form   → data.form/v1   @bottom    rebind（本组合无人 raise，声明性保留）
```

收件箱与归档箱是**同一个 `data.list/v1`**，靠 instance config 的两个 `source` 变成两件事——这正是
决策 7 的验收场景。

## 这里刻意没有的东西

| 没有 | 为什么 |
|---|---|
| `view/resource-bindings.json` | **被声明的 App 不能绑定用户资源**。`declared-adapter.ts` 对十资产的 `modular-v2` 形状直接拒绝（`resource_bindings_not_allowed`），因为 typed port、provider 与 Gate 认的契约都是平台代码的决定。它的权限契约是**空的**。本 release 是**九资产的 `modular-v1`** |
| adapter / `bindings` | 同上。六个模块要的 `app-data/v1` 是 App **自己**的投影与动作面，从每个 Agent View 本来就有的那条通道来，不是任何部署安装的 provider |
| 组合以外的 action 字符串 | 两个 action id 只出现在 `src/plan.ts` 的 composition 里（和 `app/app.yaml` 的 `actions:` 键）。模块提议的是 `config.action` / `config.command_action` |
| `agents:` | 平台的 agent 平面默认关闭，而且今天只接 Session Plus 的 manifest loader——写在这里是**看起来生效的死数据**。理由写在 `app/app.yaml` 里 |
| 身份类 hook | View 从不被告知 owner/app/scope/instance，`useIdentity` 之类只能编造 |

## 文件

| 文件 | 职责 |
|---|---|
| `src/main.tsx` | 入口。**没有 `StrictMode`**——发布的 View 不能与测过它的东西行为不同 |
| `src/App.tsx` | 一个 `StandardApp` + 一个标题条 + 一处 slot chrome 覆盖。没有别的 |
| `src/plan.ts` | module lock + composition，以及它们作为 release 资产的**规范字节**。依赖轻（无 React、无 CSS），因为 Node 侧的 packer 也要读它 |
| `src/modules.ts` | 六个 registry entry（manifest + 组件）。与 `plan.ts` 分开，就是为了让上面那句话成立 |
| `src/paths.ts` | **Node 侧**：产物在哪、构建命令是什么、**八棵源码树**决定它。少列一棵 = 一次真实修改变得不可见 |
| `src/styles/app.css` | 主题：文档、标题条、底栏那一处 chrome。模块自己的样式在模块包里 |
| `app/app.yaml` | 两个 runtime action 的声明。`add_note` 的参数声明与 `projection.ts` 的 `addNoteParams` 是**同一份**（表单由它生成） |
| `app/actions.ts` | SES Compartment 里的纯事件生产者，**没有 import**。`deck_command` 内联了 `deck-model/v1` 命令词表的一个子集，理由写在文件头 |
| `app/projection.ts` | 纯折叠。也产出模块要读的静态声明（`detailFields` / `addNoteParams` / `stats`）与一份种子 deck |
| `examples/showcase.preview.ts` | `pnpm run app:preview` 的 plan，用的是**同一份** composition 与**真的** `project()` |

## 构建与测试

```bash
pnpm --filter @claude-bot/showcase-view build     # dist/agent-view.js + .css + build-manifest.json
npx tsc --noEmit -p packages/showcase-view/tsconfig.json
npx vitest run --project showcase-view --maxWorkers=1
pnpm run app:preview -- packages/showcase-view/examples/showcase.preview.ts
```

**改了那九个包里的任何源码就必须重新构建**——`SHOWCASE_VIEW_SOURCE` 覆盖
`showcase-view` / `agent-data-view` / `agent-deck-view` / `deck-model-contract` /
`resource-stream-contract` / `agent-module-contract` / `agent-view-react` / `web-trust` /
`agent-view-build`（构建配方，2026-08-11 拆出，不进 bundle 但决定产物）
九棵源码树加九个 package.json 与 lockfile。用旧源码构建出来的产物是**自洽的**（digest 与那些字节
相符、主机名与那个 digest 相符），唯一不对的是它不是树里的代码。
