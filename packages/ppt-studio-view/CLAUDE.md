# PPT Studio View

## 一句话

一个声明式、账户隔离的 Agentic App：复用 `deck-model/v1` 与三块 deck View，浏览器通过
`data.form/v1` 把需求投递给 release 声明的 `presenter` agent；agent 默认只有路由/安全基线，
通过 `load_skill` 按需取得 strategy/visual/authoring/template/review/export 原子技能。

## 信任与状态

- `deck-model/v1` 是唯一可编辑事实源；Typst 只是派生文本。
- View 只有现有 MessagePort，不知道 owner、路径、grant 或 agent backend。
- 本 App 是九资产 `modular-v1`，没有 `view/resource-bindings.json`，权限契约为空，因此实际文件
  操作范围也是空。`image.ref` 只是不可解析的不透明显示值。
- `ask_presenter` 是 `binding: agent` 且 `human_only`；可信 Host 把唯一 `prompt` 参数放入当前账户
  inbox。agent 无法调用它给自己排队。
- `load_skill` 返回 release 内联的指令文本，但 durable event 只记录技能名；其余 agent tool 仍走
  与画布按钮相同的 App action door。

## 已知边界

- 现有平台没有 `typst-compiler/v1` 或 binary artifact/download typed port，故只展示/复制 Typst，
  不声称 PDF/PPTX 或目录下载。
- App agent plane 当前只支持 `account:<owner>`；deck 也不是 Y.Doc。因此不提供跨用户实时协作。
  未来应以 deck semantic transaction + CRDT provider 实现，不能把整份 JSON 塞进文本 CRDT。

## 构建与测试

```bash
pnpm --filter @claude-bot/ppt-studio-view build
npx vitest run --project ppt-studio-view --maxWorkers=1
pnpm run app:pack:ppt-studio -- --out /tmp/ppt-studio.json
```

View 源码变化后必须重建 `dist/`；它被 gitignore，但打包器会用 source digest 拒绝陈旧产物。
