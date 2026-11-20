# Chat UI Commons — 中立 transcript/chat 展示层

## 一句话

这里是Dashboard 与 Agentic App 都能依赖的中立浏览器展示包：rich transcript 归一、
可见单位与 turn/tool 分组、稳定 `av-chat-*` class/id、距底部滚动保持，以及一份结构 CSS。
它不属于任一发布车道；两个 Host 都只能向内依赖它。

## 边界

- 允许：React、`agent-sessions-contract` 的类型、调用方传入的 ReactNode/renderer/callback，以及
  `./mermaid` 显式入口使用的 DOM-free `beautiful-mermaid`。
- 禁止：Dashboard、Bot、Agent View/App runtime、身份、凭据、协议、MessagePort、网络 API 与持久化。
- 包本身不解析 Markdown、不产生 HTML 字符串，也不使用 `dangerouslySetInnerHTML`。助手正文默认
  以原始 `string` 作为 React text child（literal、fail-closed）；调用方可注入 `renderAssistant(text)`，
  且必须使用其信任域内的严格 sanitizer，不能把 raw HTML 作为降级默认值。
- callbacks 只报告展示意图；资源解析、授权和副作用永远属于调用方。**chat 组件本身没有路径文法**：工具卡片顶部的
  「文件」条来自调用方注入的 `extractFilePaths(text)`——「什么看起来像文件」是工作区问题，而这个包没有
  工作区；不传就还是原来那张卡（工单 #189）。
- `./file-mentions` 是显式 opt-in 的纯展示扫描器，由 Sessions+ 与 Dashboard 分别注入。它只生成字符串，不能解析资源、读取文件或授予权限；默认保留 Sessions+ 的既有行为，工单可显式保留行号。
- `av-chat-*` class、`tr` / `loadOlder` scoped id、稳定 message anchor 都是兼容契约。
- Claude/OMP 的连续「思考 + 工具」按一个 work run 折叠；展开后思考正文直接显示、工具卡按原始顺序交错。
  Claude 的所有过程组默认关闭（含最后一组、执行中），用户的展开选择保持；OMP 的最后一组默认展开，
  `todo` 工具在同一位置显示进度卡，原始 input/output 仍保留在二级详情。Codex 的现有分组不变。

## 入口

| 入口 | 内容 |
|---|---|
| `./transcript`（以及根入口） | entry 归一、visible-unit/turn/work 分组、OMP Todo 进度派生、activity 与纯展示派生 |
| `./transcript-ui` | side-effect-free 的 React chat/turn/group/scroller；OMP work timeline 与 Todo 卡 |
| `./transcript-ui.css` | 共享结构 CSS；由各 Host bundle entry 显式导入 |
| `./file-mentions` | 两域共用的文件引用识别与链接改写；不含资源定位或副作用 |
| `./dom` | 兼容首实例、给 sibling 加 scope 的稳定 DOM id |
| `./composer` | 两条并列的键盘提交策略，IME 合成一律不提交：`handleChatComposerKeyDown` 是响应式的（窄屏 Enter、宽屏 Ctrl/Command+Enter），只给**真正的聊天**用；`handleModifierSubmitKeyDown` 完全不读 viewport，任何宽度下 Enter 都换行、只认 Ctrl/Command+Enter，给工单正文这类「一次输入是一份简报」的输入框用（工单 #180） |
| `./composer-react` | 订阅同一内容断点的 React hook；旋转/分屏时让 chat chrome 同步收纳 |
| `./mermaid` | Host 显式接入的 Mermaid 流程图图片与已解析 `pre` 适配器；不解析 Markdown、不进入默认 transcript renderer |

## Mermaid 流程图

两个 Host 的 Markdown `pre` 都显式使用 `MermaidPre`，只识别 `language-mermaid` 的代码子元素。
普通围栏、行内代码和未注入 renderer 的 transcript 仍然走原来的文本行为。图表内容不成为 Host DOM：
`beautiful-mermaid` 在内存中完成布局，SVG 仅作为 `data:image/svg+xml` 图片交给浏览器；不注入 SVG/HTML，
不启用图表链接、脚本或远程字体，不放宽 Host 的 CSP。排版引擎仅在实际 Mermaid 围栏稳定后异步加载。

当前支持该解析器的流程图（`flowchart` / `graph`）与状态图语法；其它图表类型保留源码并给出失败提示。
源码始终可展开。更新静默 180ms 后绘制，取消过期定时器与异步加载结果，新源码立即隐藏旧图；不缓存跨会话内容。
自动绘制的上限是 16,000 字符 / 400 行 / 200 节点 / 400 边、SVG 1 MB：排版是主线程上的同步计算，
而旧版 App frame 是 hash-only 策略下的 opaque origin，起不了 Worker，所以上限保护的是页面不被一张图卡住。
超限时图表局部降级并给出「仍然绘制」：读者对这一份源码显式接受同步排版代价，该图不受上述上限约束
（按源码文本记忆，流式增长中的围栏不会每次静默都重排）。错误仍只在图表局部降级。
宽图在自身容器中横向滚动，保持文字原始尺寸。Dashboard 注入其语言文案。

## 验证

```bash
pnpm --filter @claude-bot/chat-ui-commons typecheck
pnpm --filter @claude-bot/chat-ui-commons test
```

## 长记录与查找（2026-09-14）

`ChatTranscript` 复用现有 `@tanstack/react-virtual`，超过 40 个显示组时仅挂载可见范围与
overscan；较长的展开工作组/连续正文也使用同一滚动容器进行测量。`ChatScroller` 继续拥有
尾部跟随、触屏手势和历史 prepend 的滚动语义，不引入第二个滚动区域。稳定 absolute entry key
维持折叠与测量身份；当前浏览器 selection 涉及的已挂载行在选择结束前保留。
从未展开的工作组不挂正文；首次展开后的小组在折叠时保留工具节点，长组释放虚拟窗口并由调用方的
折叠 override 恢复状态，避免隐藏列表的零高度测量扩大 DOM。

调用方可传 `showHistoryControls={false}` 移除窗口计数、顶部手动翻页和已读搜索条，自动向上翻页保持不变。
窗口的 `data-av-chat-offset/count/total` 数值属性保留在滚动容器上供验收读取，不依赖可见文案。

“搜索已读取记录”在启用历史控件时默认闭合，不扫描历史；展开后延迟 180ms 处理输入，在完整已加载 group/entry
文本上匹配，定位时展开命中工具卡。继续翻页可扩大已读范围。原生浏览器查找只覆盖已挂载 DOM，
不拦截全页 Ctrl+F。静态消费者可传 `virtualize={false}`；交互聊天默认启用有界行渲染。

动态测量与稳定 key 的上游 API： https://tanstack.com/virtual/latest/docs/api/virtualizer 。
