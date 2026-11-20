# Agent View Build — 确定性构建与产物加载

Node-only 工具链：当前 App 的 React 组件输出为 ESM release，包含固定入口/CSS、显式 module
manifest 和按需加载的 chunks/workers。缺失、截断或与当前源码不同的产物都拒绝发布。
架构见 `doc/development/shared-app-frontend.md`。

## 入口

- `.`：`agentViewViteConfig()`；传 `appId` 选择当前 ESM 格式。
- `./release`：source/output digest、manifest、当前源码校验；不把 Vite 引入 Bot 运行时。
- `./runtime`：共享 import specifier、`octopus-ui/v1` ABI 与 module entry schema。
- `./module-assets`：构建文件到 release 资产的映射，以及激活前完整集合检查。
- `./scope-css`：App surface 作用域，保留 keyframe 步骤。

## 发布约束

1. ESM 使用 `octopus:app-module-vite-2` builder；React/Ant/SDK 由宿主 import map 提供。
   仅无 appId 的旧 fixture 使用 `octopus:agent-view-vite-1`，保留两文件 IIFE/内联转义规则。
2. `agent-view.entry.json` 枚举入口、CSS、所有命名 UTF-8 辅助资产；仅 JS/MJS/CSS/JSON/SVG，
   不接受未声明文件、目录穿越、sourcemap 或外部 CDN。Worker 和 chunk 文件名保持平面。
3. 每份资产都有大小和 digest，sourceDigest 覆盖源码树、配置、锁文件与主题 registry。
   本工具链本身也是 App source root。所有产物必须在精确 checkout 重建，不共享 worktree dist。
4. App CSS scope 包含 appId 和 未加 scope 的 CSS digest 前 16 个十六进制字符；主题令牌从唯一 registry 注入。
   仅测试或文档变化仍要求校验/重建，但相同输出字节不制造新的 packageDigest。
5. packageDigest 表示发布资产字节与声明/配方；没有人为版本号升级步骤。格式或 ABI 改变需显式版本化。

## 验证

在 4090 运行 `pnpm exec vitest run --project node --maxWorkers=1 packages/agent-view-build`、
本包 typecheck，以及所有受影响 App 的真实构建。构建器通过包自引用读取 Node 侧子入口，
避免 Node 与 Vite 对 `.js` → `.ts` 的不同解析行为。
