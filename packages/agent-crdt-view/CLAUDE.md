# Agent CRDT View — 协作文档模块（文档列表 + 文档面板）

> 2026-08-07 新增（平台收敛计划 P6c，决定 8 的 CRDT 压力测试）。
> 2026-08-10 升级为用户可见的文档产品（见下「范围决定的变更」）。
> 契约：`packages/crdt-doc-contract`（`crdt-doc/v1`；2026-10-20 起模块同时声明 `crdt-doc/v2`——
> 同一个 `CrdtDocPort`，适配器把超过一个窗口的答复按资源流拉完、把超过一个窗口的推送按字节偏移分段，
> 文档与未同步改动都不再有总大小上限；Session Plus 绑定 v2）
> 交付记录：`doc/development/crdt-p6c-worklog.md`、
> `doc/deliveries/2026-08-09-crdt-declarable.md`、
> `doc/deliveries/2026-08-10-crdt-doc-app.md`

## 一句话

两个模块：`crdt.doc-list/v1`（「文档」侧栏，枚举本 scope 被授予的文档并发
`open-resource/v1` 意图）与 `crdt.note/v1`（文档面板：默认渲染阅读页，
「编辑」切到带 Markdown 工具栏的源码编辑，改动去抖后推送 diff，wake 提示
到达且会话干净时自动拉取合并）。

## 范围决定的变更（2026-08-10，产品 owner 拍板）

本文件旧版写着「不做富文本编辑器——本纵切是架构探针，textarea 足够」。
产品 owner 推翻了这条**范围**决定：文档面板现在要求与云文档对齐的阅读与
书写体验。变更的是范围，不是平台约束——`.claude/rules/crdt.md` 六条硬约束
与下面「三条不可协商」全部照旧，`architecture.test.ts` 仍然逐条锁死。
实现路径刻意保守：`Y.Text` 继续存 **Markdown 源**（字符级并发合并不变），
阅读用 SDK 的 sanitising `Markdown` 原语排版渲染，编辑是 textarea + 纯函数
工具栏（`lib/markdown-edit.ts`），**不是** TipTap/ProseMirror + `Y.XmlFragment`
——那要把重编辑器拖进不可信 bundle 并迁移文档模型，值得单独一批评审。

## 三条不可协商

1. **不装任何 Yjs provider。** `y-websocket` / `y-webrtc` / `y-indexeddb` /
   `y-protocols` / `@hocuspocus/*` 各自带连接，而 `connect-src 'none'` 下这个
   bundle 只有一条 MessagePort，且它只会 `propose`。按**包名**禁止。
2. **不轮询。** `setInterval` 被架构测试禁掉。远端改动的到达方式是 ADR 0006
   的 wake：可信侧转发一条**无内容**提示帧，模块收到后**自己决定**是否发起
   一次照常过 Gate 的读——而且只在会话干净时。任何一次拒绝
   （`approval_required` 最要紧）都让后续 wake 退化为「有新改动」标记，
   直到人点「同步」。十条 wake 跟在一次拒绝后面 = 十次渲染、零次提议。
3. **推送必须合并。** 本地编辑先攒（默认 600ms 去抖），推送的是对服务端
   状态向量的 diff（`Y.encodeStateAsUpdate(doc, serverVector)`）。

## wake 怎么进来（模块不碰 SDK 根入口）

模块包只许 import `/ui` 与 `/workspace`，而 wake token 挂在 SDK 根入口的
transport 快照上。于是 token 作为**数据**流动：App（组合根，可以读根入口）
用 `useAgentViewSnapshot().wakes` 取出，经 `<CrdtDocProvider wakes={…}>` 传进
来，`modules.tsx` 对 token 变化 `useEffect` → `session.wake()`。不传 wakes 的
旧 App 得到的行为与从前逐字相同：手动同步，无提示。

## 状态归属

| 状态 | 归属 | 理由 |
|---|---|---|
| `Y.Doc` 副本、pending、同步周期、remoteHint | **挂载实例**（`NoteSession`） | 一个 panel = 一个协作者 |
| 文档列表（一次 `list_docs`，显式刷新） | doc-list 模块实例 | 枚举是能力型读，不能因为两个实例就花两次以上 |
| port、wake tokens | Provider（context，由 App 供给） | 每个 App 只有一条通道 |
| 编辑/预览模式、选区 | View 组件 | 从不落库 |

## 文件

| 文件 | 职责 |
|---|---|
| `manifests.ts` | 纯数据：`crdt.note/v1` + `crdt.doc-list/v1`（Node 侧 release builder 要读它） |
| `lib/textdiff.ts` | textarea 的整段值 → 一次最小 CRDT 编辑，不切代理对 |
| `lib/markdown-edit.ts` | 工具栏命令 = (text, selection) → (text, selection) 纯函数；全部是可往返的 toggle |
| `lib/session.ts` | 副本、去抖、单飞同步周期、wake 冷却（ADR 0006 §6.3）、origin 标记 |
| `components/CollabNote.tsx` | 文档面板：标题栏、状态、编辑/预览、工具栏。拒绝**渲染**不抛 |
| `components/DocList.tsx` | 「文档」侧栏的展示件。**它按内容占高**（`crdt-note.css` 里对自己 panel 的 `flex: none`）：`navigation` 是流式 slot，默认每个 panel `flex: 1`，一条空文档栏会和目录索引平分整列；零文档收敛成一行标题栏，**但拒绝仍然照常渲染**——「不让你读」和「这里没有东西」不是同一件事（工单 #61） |
| `modules.tsx` | manifest + 挂载；`useSyncExternalStore`；wake token → `session.wake()` |
| `harness/memory-port.ts` | 第二个真实实现：进程内 `Y.Doc`，含 `listDocs` 与中途注入拒绝 |

## 测试

```bash
npx vitest run --project agent-crdt-view --maxWorkers=1
```

| 文件 | 证明什么 |
|---|---|
| `lib/textdiff.test.ts` | 编辑 round-trip；范围最小；emoji 不被切开 |
| `lib/markdown-edit.test.ts` | 每个工具栏命令是 toggle；选区存活；空文档与越界选区不炸 |
| `lib/session.test.ts` | 两客户端同位置并发收敛；拉下来的不回推；拒绝不丢文本不自动重试；**wake 干净时拉取、一次拒绝后零 dispatch、人工同步恢复** |
| `modules.test.tsx` | 预览默认/编辑切换；工具栏作用于选区；StrictMode；两 panel 两副本；**doc-list 一次枚举、点击发 intent、显式刷新**；wake 冷却在真实挂载下成立 |
| `architecture.test.ts` | 无可信侧 / 无 `node:*` / 只用 SDK 窄入口 / 无 Yjs provider 包 / 无 action 字符串 / 无 `setInterval` |
