# 自主科研工作台 v2：契约映射

## 集成轮廓

保留 `research-program` 的 bespoke Agent View 与现有 action/projection，不把项目目录或成员权力下放进 iframe。新增的“项目工作台侧栏”属于可信 Dashboard Host：它根据当前用户的共享实例成员关系列出项目，选择一个实例后仍只给 iframe 该实例的一份 viewer-scoped projection。

## 原型状态 → 权威事实

| 原型状态 | 权威来源 | View 可见性 |
|---|---|---|
| 一级“自主科研”入口 | 服务端导航元数据；仅在本部署声明 `research-program` 时出现 | 不进入 iframe |
| 可访问项目列表 | shared-instance membership 目录；服务端逐实例重走成员门并生成 viewer-scoped projection | 不进入 iframe |
| 项目人类标题、归档状态 | 各实例 projection 的 `project.title` / `project.archived`，仅作可信导航文本 | iframe 仍只见当前实例自己的字段 |
| 当前项目 | URL 中可选的不透明 instance key，或服务端优先选择未归档且同时有会话/文档的项目，同类再按投影活动时间取最新 | iframe 不见 key，只收当前 projection |
| 最新会话与主导文档 | 当前实例 projection 的 `sessions`、`transcripts`、`lead_agent`、`lead_document` | 当前 View 正常可见 |
| 当前角色与可写 controls | 当前实例 viewer evidence 生成的 `viewer_role` / `controls` | 当前 View 正常可见 |
| 成员、席位和创建者管理能力 | trusted shared-instance store 与现有成员 API | 不进入 iframe；只在可信侧栏呈现 |
| App release、后端和 frame 状态 | Trusted Host 当前 release 与 MessagePort host snapshot | 不进入 App 业务 projection |

## 用户意图 → 精确动作

| 用户意图 | 集成动作 | 生命周期 |
|---|---|---|
| 从一级入口进入 | 对 `/apps/research-program/open` 发完整文档请求 | 服务端重新鉴权；无项目进入空工作台，有项目直接打开默认项目 |
| 切换项目 | 导航到同一路径并带 server-minted `instance` lookup key | 完整文档请求重新走成员门；不写 App event |
| 折叠项目卡片 | React/native disclosure 的本地显示状态 | 不请求服务端，不改变当前项目 |
| 复制分享链接 | 可信页面从当前 app id + instance key 组成现有 share URL | clipboard pending/成功/失败只在可信层 |
| 加入项目 | `POST /api/apps/research-program/shared-instances/:key/join`，参数只有声明角色 | pending 禁止重复；成功原地 reload；拒绝保留侧栏与可重试选择 |
| 添加/改角色 | 现有 creator-only `.../:key/members` | pending；服务端重新判断创建者、用户、角色和席位 |
| 移除成员 | 现有 creator-only `.../:key/members/remove` | pending；创建者不可被移除 |
| 新建项目 | 现有 shared-instance create，固定选择 declared `owner` | 成功直接打开新实例；失败留在空/当前工作台 |
| App 内业务变更 | 继续由 View 通过 `usePropose` 提交 manifest 中既有 action | `useProposals` pending/refusal + 权威 projection 确认 |

## Actor → 可见能力

- Owner：项目导航、分享、成员表和成员管理；View 内按 projection controls 配置/归档/绑定。
- Member：项目导航与分享；可信侧栏只显示成员摘要，不渲染 creator-only 管理表；View 内按 controls 发布与绑定。
- Viewer：项目导航、分享与只读工作台；业务写动作由 projection 移除。
- 未加入用户：同一个可信工作台侧栏显示可用席位和加入按钮；没有 iframe，也不能看到目标项目 projection。
- 无项目用户：同一个工作台壳层显示“创建科研项目”，不经过实例 hash 列表。

## 契约差距与处理

1. 当前共享实例列表只有 key/role/成员数，无法提供人类项目名。增加 `AppInstanceService` 的只读、成员约束 projection snapshot seam；它复用当前 release、共享成员门、viewer evidence、App State 和 Runtime projector，不创建 tab handle，也不绕过任何门。
2. 当前 `/apps/<id>/open` 无 instance 时总渲染 hash picker。仅当可信目录确认当前 App 是 `research-program` 时改为 workspace presentation：已有实例直接打开优选的可访问项目，无实例显示空工作台；其它 declared Apps 保持原 picker。
3. 当前加入和成员管理是独立卡片页。复用同一现有 API，但将 research-program 的控件组合进可信侧栏；通用 App 页面不受影响。
4. “最近访问项目”的持久偏好尚无权威来源。干净入口不伪造访问历史：先选未归档项目，再选会话/文档齐全的工作台，同类按 viewer-scoped projection 中的最新活动时间决定，最后才回退 `created_at`；用户明确带 instance URL 时始终尊重该选择。

## 保留与调整

- 保留：opaque-origin iframe、单 MessagePort、publisher trust、URL lookup key、成员/席位门、App actions、projection controls、现有 transcript/file-intent 主体。
- 调整：全局入口层级、shared-instance 默认落点、可信外层项目导航、成员/加入信息架构。
- 不做：让不可信 View 枚举实例、把成员表/owner/key 写进 projection、把项目标题当 authority、用 SPA 跳转跳过逐页鉴权。
