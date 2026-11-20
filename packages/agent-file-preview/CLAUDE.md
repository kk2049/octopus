# Agent File Preview — 文件呈现

`@claude-bot/agent-file-preview` 把已由 workspace-files typed port 披露的媒体字节呈现在 受信 ESM
Agent View 内。它拥有媒体流生命周期、PDF.js canvas 绘制，以及 Markdown 相对图片从 listing 标签链到
opaque ref 的解析；不拥有目录枚举、panel 布局、下载、编辑或权限判断。

## 边界

- PDF.js 主程序和独立 module worker 随 ESM release 发布；每份预览用 PDFWorker.create({ port }) 持有实际 Worker，关闭、加载失败与启动错误都释放它。不使用 globalThis.pdfjsWorker 或主线程 loopback。
- PDF 页面按原始纵横比组成浏览器式连续纵向文档；滚动接近页面时才取页和绘制，ResizeObserver 按
  当前可用宽度在 120ms 稳定后重绘；拖动期间 CSS 缩放旧位图。预览容器从顶部开始排版，不能用垂直居中把长文档顶部推到滚动原点之外。
- canvas **过采样**（`src/pdf-scale.ts`）：每 CSS 像素至少 2、最多 3 个设备像素，由浏览器降采样。
  dpr 上限曾经是 2，dpr=3 的手机因此白白丢掉三分之一分辨率，dpr=1 的桌面把 A4 画成约 115 DPI。
  显示宽度上限只在 CSS（`.av-pdf`）里写一次，测量侧不得复制这个数字。
- 桌面 PDF 只接管 `Ctrl/Command + 滚轮`，手机只接管同时存在的双指距离变化；两者都在 100%–200%
  间围绕指针/双指中点局部缩放。普通滚轮与单指触摸仍用于连续滚动、选区和批注，不依赖 iframe 外的整页缩放。
- 位图会**还回去**：绘制边距 700px、释放边距 1600px（两个 IntersectionObserver，中间是迟滞）。
  释放只清 canvas 位图，保留已解析的 page proxy 与 text layer，所以回滚不重新解析、离屏选区仍可解析。
- 预览只接收 typed port 已披露的字节，不增加目录/网络读取或权限判断。worker URL 只引用同一受信 ESM release 产物，optional resource fetch 与 WASM 仍关闭。
- 批注的未保存 note 可选接入 App 提供的浏览器草稿 seam；新批注必须用完整文件键与完整选区锚点分键，编辑必须用完整文件键与批注 id 分键。键超出 Host 上限时放弃恢复，禁止截断或按文件模糊恢复。保存/取消先写空墓碑，持久批注仍只认 App projection。
- Markdown 文件链接在共享 Viewer 中使用同一 listing 标签链，经 typed-port `resolvePath` 取得 opaque ref 后才交给 Dock；缺失、拒绝和超时就地显示，不重试，切换文档后丢弃旧答复。
- Markdown 图片只接受相对地址。根 ref 和标签链来自实际 listing；`resolvePath` 在可信侧逐层重验并铸出
  图片 ref。HTTP(S)、data URL、根绝对地址、越过 workspace 根和非图片目标都只显示占位。
- 媒体读取沿用 workspace-files/v3 的顺序分块和一次请求纪律；协议不限总大小，超过 `previewBytes` 的文件先询问再整份载入（2026-10-20）。PDF.js 禁用 WASM/worker fetch，
  解码图像最多 4000 万像素、单页 canvas 最多 8 Mpx（≈32 MiB 位图），并保留下载作为失败退路。

## 验证

```bash
pnpm --filter @claude-bot/agent-file-preview typecheck
pnpm vitest run packages/agent-file-preview/src/pdf-scale.test.ts
pnpm vitest run packages/agent-workspace-files-view/src/lib/markdown-images.test.ts
pnpm vitest run packages/bot/src/session-plus/browser.e2e.test.ts
```

真实浏览器测试必须证明 PDF 使用独立 worker 且关闭时释放、拖动/缩放后宽度跟随容器，并且文件树与聊天链接打开的 Markdown 图片都来自 blob、PDF 两页 canvas 已绘制、
手机宽度能自然纵向滚动且第一页顶部可见，并且没有 PDF iframe。jsdom 不运行 Chrome PDF 扩展或 CSP，
不能代替这条证据。

PDF.js API依据：https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFWorker.html；官方module Worker打包示例：https://github.com/mozilla/pdf.js/blob/master/external/dist/webpack.mjs。
