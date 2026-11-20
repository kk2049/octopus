# Agent Text View — presentation-only 文本表面

## 一句话

`@claude-bot/agent-text-view` 是文件查看器和编辑器共用的展示层：唯一的 CodeMirror 6 表面、统一的
文档 header / metadata / 拒绝 / reload / digest chrome。它持有 CodeMirror **挂载期**的 buffer、undo、
selection、search 与 clean baseline，但不持有 typed port、资源授权、CAS/保存结局、panel lifecycle 或
可跨 remount 的文档 store。

## 边界

- 输入只有已读取的文本、调用方选择的 opaque `docKey`、纯展示 `TextDocumentMetadata`、clean token 与回调；
  不依赖 workspace-files/CRDT/prompt 等任何资源域 contract。
- 不读取或猜测路径，不按 label 推断语言；当前只展示 `text/plain; charset=utf-8`。
- 不发 capability proposal，不打开 channel，不 fetch，不使用 worker、动态 import 或 CDN。
- CodeMirror 只出现在 `src/components/CodeMirrorTextSurface.tsx`。运行时样式走两条路，**两条都要在**：
  有 nonce 时喂 `EditorView.cspNonce`（未发布/开发形态的文档）；**已发布的 release 文档没有 nonce**
  ——它是 `style-src '''sha256-…'''` 加不可变缓存，所以 `style-mod` 那个 `<style>` 被浏览器拒绝
  （`.sheet` 为 null，不报错）。此时把它的 `textContent` 通过 `adoptDocumentStyles()` 采纳为
  constructable stylesheet。只采纳**这一次构造新出现的那个元素**，且只在文档确实拒绝了它时采纳；
  不按内容嗅探，也不遍历文档里所有被拒的 `<style>`——那等于把同一条修复交给 transcript 渲染出来的东西。
- 查找来自静态打包的官方 `@codemirror/search`；只读状态由 `EditorState.readOnly` 控制，因此查找面板
  不显示替换控件。`Mod-S` 只在可编辑状态注册。
- 不逐键把整份字符串提升到 React。surface 只在 clean/dirty 位翻转时调用 `onDirtyChange`；保存按钮通过
  handle、`Mod-S` 通过回调，在那一次显式动作里物化全文。
- 读取时把 CRLF、LF、CR（包括混用）都识别为逻辑行；保存时使用文件里第一个已有换行符作为整份输出约定，
  避免单一分隔符把其余真实换行留在同一个 CodeMirror 行块里。

## 状态所有权

| 状态 | 所有者 |
|---|---|
| 文本 snapshot、stream、refusal | 消费模块 / typed port |
| 当前 buffer、clean baseline、undo、selection、search、wrap | 已挂载的 CodeMirror 表面 |
| dirty boolean 的 React 镜像、base digest、save/conflict | 编辑模块 |
| panel dirty、close pending、tab/focus/open/reuse | workspace coordinator |
| split/tab 排列和移动手势 | Dock presentation adapter |

`docKey` 变化会建立一份新 EditorState 并清空 history；同一 key 的 stream 更新只在只读或仍 clean 时同步，
不能覆盖已经开始输入的 buffer。`cleanToken` 只推进比较 baseline：保存飞行中发生的后续输入仍保持 dirty。

这不是 durable draft store。Dockview 使用 `renderer: "always"`，普通 move/reorder 与手机 maximization 保持
renderer subtree，因而保留 buffer；真正 remount、语义关闭或 View reload 会丢弃它。本包不使用
localStorage/App State 掩盖卸载，也没有按 port/ref 保存多文档的 registry。

## 公开面

- `CodeMirrorTextSurface`：行号、history、显式查找、wrap、line intent、dirty transition 和
  clean baseline；可选保存键只在 editable 时存在。
- 普通光标/选区不高亮其它同词；原生选区使用 accent/contrast，只有显式查找才显示匹配。
  查找使用官方面板与命令、中文 phrases；网格随表面实际宽度切换，窄 Dock 栏与手机都不挤压控件。
  只读切换重建替换控件时保留查询、选项与输入焦点；保存回调变化不重建查找面板。
- `CodeMirrorTextSurfaceHandle`：显式 `getText()` / `focus()`；不是持久化 API。
- `DocumentPane`：两个模块共用的 header、读取拒绝、metadata、reload/close 与 digest。
- `displayTextSize`：纯展示字节格式化，避免 Viewer 与 Editor 各写一份。

窄屏的 `DocumentPane` 只占一行：语义文件名保留并截断，媒体详情与 digest 隐藏，重读/关闭保留可访问名称
和 44px 触摸目标但只画图标。宽屏仍显示完整文案与元数据。

## 测试

```bash
pnpm exec vitest run --project agent-text-view --maxWorkers=1
npx tsc --noEmit -p packages/agent-text-view/tsconfig.json
```

`surface.test.tsx` 覆盖行号、混合换行符、显式查找、只读无替换、可编辑替换、wrap、`Mod-S`、nonce、stream 不误报
dirty 与逐键只发布 dirty transition；
`architecture.test.ts` 钉住 presentation-only 依赖和零网络/worker/dynamic import。
`surface.browser.test.ts` 在 Chromium 中加载真实共享组件和 Dashboard/Sessions+ 构建 CSS，验证六主题
明暗选区对比度、Ctrl-F/Escape、替换与 900/480/320px 栏宽的控件几何。先在隔离 CI 构建
`@claude-bot/dashboard-web` 和 `@claude-bot/session-plus-view`；可用 `TEXT_SURFACE_SCREENSHOT_DIR`
将截图集中输出到本次 CI 任务的临时目录。

**样式是否真的生效，只有真浏览器能证明**（工单 #253）：jsdom 不执行 CSP，`textContent` 断言在
样式全丢时同样通过。`packages/bot/src/session-plus/browser.e2e.test.ts` 因此断言 `.cm-scroller`
计算出来是 `flex`，且 `.cm-content` 在 `.cm-gutters` **右边**而不是下面——那正是这次故障在屏幕上
的样子：文件名、大小、工具条，然后 1 2 3 … 19，正文在折叠线以下。
