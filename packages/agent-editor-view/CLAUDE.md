# Agent Editor View — 可复用的文本编辑器模块

> 2026-08-07 新增（平台收敛计划 §决定 8「写路径顺序」的第二步，P6b）。
> 计划：`doc/development/agentic-app-platform-convergence-plan.md`
> 前一棒（写路径后端）：`doc/development/workspace-write-worklog.md`
> 交付：`doc/development/editor-p6b-worklog.md`

## 一句话

`workspace.editor/v1`：打开一个 `workspace-text` 资源，读它，改它，提交一次
**带预期 digest 的整份替换**——并且诚实地显示那次提交的真实结局。

它同时是 `open-resource/v1` **intent context 的第一个真实消费者**（`context.line`）。

## 三件必须先知道的事

### 1. 「已保存」不是保存的常态结局

`replace_workspace_text` 永远逐次批准（`alwaysApprove`，而 `modify` 在账户 root 的 auto-allow 之外）。
所以一次保存的**正常**返回是 `approval_required`：编辑已经提交，要有人在别处点头，而**执行结果回给
那个点头的人**，不回到这个 port。

于是面板的状态是 `submitted`：一句话 + 一个「重新读取」按钮，**没有轮询、没有倒计时、没有自动重试**。
重新读取只拿文件快照，不能证明可信审批已批准或拒绝；因此 `submitted` 警示在当前 tab 挂载期内保留，
保存继续 fail closed。关闭/重新读取都不会撤销待批准调用；不希望写入时必须在可信审批栏拒绝。
自动重发一次被 Gate 拒绝的调用不是「最终一致」，是给一个已经有卡的人再排一张卡。

五个结局在 `lib/save.ts` 里是纯函数（`saveStateFrom`），脱离 DOM 可测：
`saved` / `submitted` / `conflict`(`digest_mismatch`) / `refused` / `saving`。

**2026-10-20：保存没有大小上限。** 超过一次调用窗口（256 KiB）的文本由 port 分段上传
（begin → append × N → commit，commit 才做 CAS 与原子替换），编辑器只调用一次 `replaceText`。
仍不能保存的只有超过整份载入预算的文档——它停在部分读取，永远到不了 `ready`。逐次批准的 scope 里，
分段保存的第一步就会生成一张卡，而批准它只会开始分段、不会完成保存，所以 `saveStateFrom(answer,
{ staged: true })` 给出如实的 `submitted` 文案（并同样 fail closed，不再生成第二张卡）。

### 2. `read_only` 被记住，其它拒绝不被记住

`read_only` 是**结构性**的：这个 scope 的授权只覆盖读。看到一次就收起保存控件——与
`other` 条目没有 ref 所以没有按钮是同一条纪律（「打不开的东西不给控件」）。
`digest_mismatch`/`unavailable`/`too_large` 都是关于**这一次**的，缓冲区和按钮都留着。

注意区分两句话：`workspaceFilesCanWrite(port)` 说的是**这个 port 会不会写**（传输能不能装下），
`read_only` 说的是**这个 scope 允不允许写**。混成一句的 UI 要么藏起一个能用的按钮、要么给出一个坏按钮。

### 3. CodeMirror 只准出现在共享文本包里

`@claude-bot/agent-text-view` 的 `CodeMirrorTextSurface.tsx` 是唯一集成点，本包的
`components/CodeSurface.tsx` 只是兼容薄封装，`architecture.test.ts` 钉住。共享表面拥有**挂载期**的
CodeMirror buffer / undo / baseline 比较，只在 dirty 位变化时回报一个 boolean，只在显式保存时物化整份
文本；本包拥有 port、`baseDigest`、CAS、批准/冲突结局和 dirty 的 React 投影。它们不是第二份文档 store。
这里只记两条会咬人的：

- **不装语言包/高亮**。契约只声明 `text/plain; charset=utf-8`，按 label 猜语言就是把显示名当路径读。
- **它在运行时注入 `<style>`，而 View 文档是 `style-src 'nonce-…'`**。不喂
  `EditorView.cspNonce` 的话样式被浏览器丢掉——**不报错**，只是编辑器没有行号、没有光标、文字溢出，
  而且**只在真浏览器里**这样。nonce 来自 SDK 的 `documentStyleNonce()`（`@claude-bot/agent-view-react/ui`），
  它在模块求值那一刻从 `document.currentScript.nonce` 读一次并私有持有。

## 文件

| 文件 | 职责 |
|---|---|
| `src/manifests.ts` | 纯数据。Node 侧 release builder 要读它，所以不许 import React / CSS / CodeMirror；composition 可用 `browse_view` 指定编辑态返回的只读模块 |
| `src/modules.tsx` | 挂载实例的端口/CAS 状态：dirty boolean、保存状态、reload、`baseDigest`；显式保存才从 surface 取整份文本。没有资源就**渲染 null** |
| `src/components/CodeSurface.tsx` | 兼容导出：转发 shared surface handle，并补 editor DOM hooks |
| `src/components/EditorPane.tsx` | 给共享 `DocumentPane` 补浏览/编辑切换、下载、保存控件与结果横幅。纯展示 |
| `src/lib/save.ts` | 五个结局 + `canSave` 的四个条件。纯函数 |
| `src/lib/line.ts` | `context.line` → 行号或 null。**提示不是命令**：不是数字就忽略，不是拒绝打开 |
| `src/harness/writable-memory-port.ts` | 可写内存 port，**包住**只读那个而不是重写三个读 |

## 状态归属

| 状态 | 所有者 |
|---|---|
| snapshot / stream / read refusal | `agent-workspace-files-view` 的 typed-port reader |
| 当前 buffer / undo / selection / baseline 比较 | 挂载的 `CodeMirrorTextSurface` |
| dirty boolean、`baseDigest`、save/approval/conflict | 本模块实例 |
| panel dirty 标记、close pending、取消/放弃关闭 | workspace coordinator |

surface 的 `onDirtyChange` 只投影 true/false，本包再用 `workspace.setDirty(panelId, dirty)` 报告生命周期事实；
它不授予写权限。所有关闭入口仍只调用 `workspace.close(panelId)`，是否直接关闭或弹出统一的放弃确认由
coordinator 决定，本包不调用 `window.confirm`，Dock adapter 也不另写一套。

草稿的生命周期属于**挂载的这个 panel**，但实际字节只存在 CodeMirror state，不在 React/App State、
localStorage 或数据库里。Dock renderer 使用 `renderer: "always"`，普通拖拽、重排和手机 maximization 保持
同一 subtree；语义关闭、release 重载或真正 remount 会丢弃草稿。若未来要求跨 remount 恢复，那是一个以
`panelId + opaque ref/docKey` 键控的 composition-level 内存 store 决策，不能偷偷塞进这个模块或展示包。

`baseDigest` 是下一次提交的前提：读到的那个，或者**上一次已应用写入的回执里的 `afterDigest`**。
少了后者，同一次会话里的第二次保存会拿一个自己刚刚作废的版本去比较，必然冲突。
成功回执通过 `cleanToken` 推进 surface baseline；如果保存飞行中用户又输入，实时 buffer 与新 baseline 仍
不同，dirty 不会被错误清掉。

## 明确不做

- **不轮询批准结果**（见上）。
- **不做语法猜测、diff、多光标、语言服务**。查找由共享静态 bundle 提供；只读 Viewer 没有替换，编辑态
  保留 CodeMirror 的查找替换。
- **不自己建 provider**：用 App 已经挂好的 `WorkspaceFilesProvider`。第二个 provider = 同一张
  工作区列表的第二次 capability 调用 = 第二张批准卡。
- **不新增第二条通道，不 bump `session-plus/2`**。保存是一次普通的 `propose`。
- **不猜路径、不读 label 当位置、不说 owner/device/workspace id**。契约里没有它们。

## 测试

```bash
node_modules/.bin/vitest run --project agent-editor-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-editor-view/tsconfig.json
```

`modules.test.tsx` 的每条都对应一个「看起来正常」的真缺陷：说「已保存」而其实还等着人点头、
只读 scope 上给出保存按钮、一次编辑发两次提议（第二张卡）、buffer 跨文件存活、
在别人改过的版本上写。共享表面自己的查找、换行、nonce 与快捷键在 `agent-text-view` 测；
`architecture.test.ts` 另外钉住本包不直接引入 CodeMirror 与「本包没有定时器」。
