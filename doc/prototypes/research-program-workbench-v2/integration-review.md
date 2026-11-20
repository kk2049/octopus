# 自主科研工作台 v2：集成审查

## 结论

C3 通过。C0 的“一级入口 → 同窗口项目导航 → 当前项目工作台”层级保留下来；加入、分享、成员管理和 Agent 接入也都在同一可信侧栏完成。默认入口不再显示共享实例 hash 卡片，有项目时直接打开工作台，无项目时保留同一壳层的空状态。

## 原型与实现对照

| C0 交互 | 最终集成 | 裁决 |
|---|---|---|
| 所有已登录用户的一级“自主科研”入口 | Dashboard 服务端导航；仅在本部署声明 `research-program` 时出现 | 保留；共享 bearer 不代表具名用户，不显示个人项目入口 |
| 可折叠的项目树与人类可读名称 | Trusted Host 按 membership 列出有界项目，逐个重走 viewer projector 后只取标题/归档展示字段 | 保留；目录不进入 iframe |
| 点项目原地切换工作台 | 导航到同一 App 路径的显式 `instance` URL，每次完整走服务端鉴权 | 保留；没有用 SPA 状态跳过门禁 |
| 默认最近项目 | 无可信跨设备访问偏好时，优先未归档且会话/文档齐全的项目，同类按 viewer-scoped projection 的活动时间取最新 | 有意偏差；不伪造持久化“最近访问”，显式 URL 永远优先 |
| 加入/邀请/成员不跳中间页 | 沿用现有 shared-instance API，但将控件放进同一可信项目侧栏 | 保留；未加入时不挂 iframe，也不披露项目投影 |
| 手机窄屏不丢项目上下文 | 左栏变为有界高度的顶部区，工作台紧随其后 | 保留；390px 真浏览器检查无水平溢出 |

## 信任与生命周期审查

- 项目 key、成员行、席位、外部宿主和分享 URL 只存在 Dashboard boot props，`TrustedShell` 没有将它们传入 Agent View。
- 目录投影限制为 64 个去重 key，一次保留 Runtime 预算；每行在投影前后都重新检查实例、membership 与 role。
- 加入请求只携带 manifest 已声明的 role；按钮 pending 时禁用，失败后保留当前侧栏并显示有界拒绝文本。
- 项目折叠状态是纯本地 UI 状态；项目切换是新的完整页请求，不会重放业务 action。
- 通用 declared App 的实例选择器和加入界面不变；这个 bespoke Host 组合只对 `research-program` 生效。

## 最终判定

- 交互层级：通过。
- 信任边界：通过。
- pending / refused / empty / invitation / archived 状态：通过。
- 键盘与语义结构：通过；使用 native `details`/`summary`、`nav`、`aside` 和状态文本。
- 响应式：通过。
- 未决材料性产品决策：无。
