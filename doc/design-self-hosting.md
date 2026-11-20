# 自举开发流水线(Self-Hosting)设计

2026-10-08：新增可显式切换的 GitLab 主线与全局租约、独立不可变 Release、本地原生 CLI 工单绑定。现行迁移契约见 [GitLab development](runbooks/gitlab-development.md)；下面的 Head 权威描述保留为切换前架构及托管工单适配器说明。

> **2026-09-15 工单聊天统一 Runner**：Head 旧执行器已废弃，生产入口关闭；
> 仅保留显式 Vitest 注入的冻结夹具及仍被使用的类型/历史读取工具，禁止新增生产兼容调用。
> 工单通过普通 Runner session 控制面启动、续发、停止。启动中的补充等原始输入被接收后
> 进入同一会话；`steer_only` 拒绝启动替代轮次。新任务检查 `steer-only/v1` 能力声明。
> `chat_paused` 独立于开发/部署状态，停止后不会被未读消息自动唤醒，明确继续或空闲时
> 新发消息才恢复。`delivered_turn` 只表示收件箱被哪轮认领，发送结论以独立回执为准。
> 续发先持久化 operation id；断线查询原回执，未知结果不自动重发。

> **当前名称与工作树映射（2026-08-10）**：本文较早段落中的 `main`/`trunk`
> 表示“可部署水位”这个角色，当前实际分支是 `v4`，已验证回滚锚是
> `v4-stable`。主参考工作树、feature worktree、本地/远端权威与清理流程以
> `doc/runbooks/development-workflow.md` 为准；本文保留状态机与信任模型的设计理由。

> **2026-09-15 Runner 开发与 Head 合入边界**：配置受管开发后，新票先在已授权的
> Runner parent 下建立按 Head/site 与 repository 区分的源码副本，再为本票登记持久
> child worktree。模型所在设备可以不同，原生 shell/文件和附件仍固定到该 child。
> 不再让新票 agent 通过 SSH 操作 Head 源码。各票可以在 `specConcurrency` 内并行；
> 同一开发树的 prepare/sync/export 独立互斥，Head 仍只有原有 Git/合入锁与
> `v4` fast-forward writer。提交先导入并核验不可变 candidate；`base_moved` 由
> agent 调用 `devpipe_workspace_sync`，在 Runner 原树 rebase、解冲突和复验，
> Head 不代改 Runner 的成果。本票本轮 devpipe MCP 凭据走私有配置、续轮重新授权，
> 不进入 prompt，也不扩大普通 session/MCP 权限。已有 session/operation 的旧票
> 保留原 placement、SID、worktree 和历史，不因升级隐式迁移或重播。
> 可执行流程以 [开发工作流](runbooks/development-workflow.md#managed-runner-development-tickets)
> 为准；下文早期“开发串行”“Head 本地 agent”及统一代 rebase 的描述仅用于历史对照。

> 秘书系统自己开发自己:共享工单队列 → 串行开发 → 独立上线动作 → 自动验证工单。
> 状态:**阶段 1+2 已实现并活体启用(2026-07-25 首轮部署闭环验证)**。
> 与本设计的偏差如实记录:①验证工单为单人判定 MVP(任一 assignee 判定生效,
> 非逐人 checklist);②verify_tickets 由 bot 生成(supervisor 只翻状态,比设计更薄);
> ③部署通知发触发人/assignees 私聊,未建开发协作群;④stable 用分支而非 tag
> (语义同,水位线=`git update-ref`);⑤`/deploy stable` 即回滚部署,revert 工单
> 自动生成未做(人工提修复票)。分支模型落地:trunk=水位线,stable=已验证水位,
> 运行树 `/home/ubuntu/lht/octopus-run`(detached)由 supervisor 管理。

> **2026-08-18 当前实现补充:**合入默认不等待全量测试。GitLab CI 每天北京时间
> 04:00 在 `lht-val15` 项目专属 Runner 上对当天累积的 `v4` 跑一次完整扫描。
> 红灯携带全部解析错误、上次全绿以来的全部 commit 及相关工单原始输入/修改结果,
> 并进入一张持续的修复工单;每次修复落地立即跑完整验证,红灯回到同一 session
> 继续 fix-forward,绿灯才收尾并推进 `v4-stable`。上线与 CI 解耦,是独立的显式部署
> 操作(部署按钮/`scripts/ops/deploy.sh`),何时由 agent 继续以 `AGENTS.md`「Deployment is explicit」为准。下文历史设计以本段、路径规则和 runbook
> 为准。

> **2026-08-24 合并锁协调补充:**`v4` 仍只有一个合入者，但锁释放不再广播唤醒
> 所有等待工单。等待者按首次碰锁顺序进入 FIFO；释放只给队首发一条定向消息，并
> 给它一段有界拿锁租约。租约内后来者不能插队；队首未及时 submit 时，旧预留失效、
> 下一位被唤醒，迟到者再次 submit 只能排到队尾。通知失败会把该等待者轮转到队尾
> 并立即尝试下一位；全部通知失败时有界退避，避免热循环。排序、token 围栏、超时
> 和计时器清理由 `devpipe/wake-lock.ts` 独立拥有，pipeline 只提供工单资格判断和
> inbox 唤醒。

> **2026-08-25 合并锁恢复补充:**等待意图与首次排队时间写入 SQLite，进程内协调器
> 仍只拥有 holder、reservation、token 围栏与计时器。重启时 pipeline 按持久 FIFO
> 顺序恢复非取消工单并定向唤醒队首；`landed` 是对话的历史开发轴，不会让后续提交
> 失去资格。排队、拿锁、释放、选择、送达、失败轮转、丢弃、超时、取消与恢复均写
> 结构化日志。持锁操作不跨重启恢复：被中断 turn 仍由既有 restart inbox 续接。

> **2026-08-27 交付分类补充:**提单人只描述需求，不再预判 App 工单或整机任务；
> 普通入口统一创建 simple，讨论仍走独立入口。实现完成后，Agent 在
> `devpipe_submit` 按最终 diff 声明 `full_deploy`、`app_releases` 或 `none`，
> 流水线独立重算路径与 App 影响集。`app_releases` 只接受 App 组合与明确的非可信
> 共享 View 包，声明的 App 集必须与实际 fan-out 完全一致；Bot 壳、可信契约、
> `web-trust`、构建工具和锁文件即使改变 App digest，也仍要求完整部署。一个共享
> View 改动可登记多 App release，逐 App pack/install/健康检查/activation；它们不
> 冒充跨 App 原子事务。历史 `kind=app` 行继续按原单 App 路径域兼容。

> **2026-08-28 基线复验持锁补充:**`devpipe_submit` 发现基线前移并完成无冲突
> rebase 后，返回 `base_changed_review` 但不再释放合并锁。同一存活 agent 轮次在锁内
> 审查 `landed_ahead`、必要修补、同步隔离 CI 并复验，再用原 token 重入 submit；
> 其它票不能在这个窗口再推进 `v4`，因而不会造成连续 rebase/复验。锁不跨
> 轮次或重启恢复：轮次结束、取消或中断仍自动释放，冲突和门禁失败仍显式释放。

---

## 目标与非目标

**目标**

- 所有用户共享一个开发工单面板:左侧最近工单列表(每票摘要 + 双轴状态徽标),中间当前活跃任务(实时进度,链接 transcript viewer 围观),底部排队区
- 两条道:**讨论并发、开发串行**——工单一进来就跑第一轮推理(不必等队列),但同一时刻只有一张票在改代码、只有一个部署在进行
- 开发与上线**解耦**:开发合入主线不等待全量测试,不碰线上;上线是独立的、显式触发的动作
- 上线可从飞书/网页触发,不依赖任何人 SSH + 本地 CLI
- 上线由主系统之外的独立小系统(supervisor)监督执行,失败自动回滚
- 上线成功后自动生成**验证工单**:列出动过的部件 + 各票验收标准 checklist,发给触发人和各票提单人
- 面板持续暴露「已开发未上线 N | 已上线未验证 M」(纯信息,**不设 WIP 上限**——积压是该上线的理由,不是该停工的理由,工单 #2 裁决)

**非目标**

- 不做进程内热重载(hot reload)。"热更新"= drain 式重启 + 健康门 + 回滚,复用现有机制,不为省 10-20s 飞书真空窗引入新的脆弱层
- 不做全自动验收。验收环节永远留人(全自动闭环会缓慢腐化:文档漂移、debt 无人察觉)
- 不做蓝绿/零停机(飞书单 WS 客户端限制,已知不可行)

---

## 信任环模型(稳定性的来源)

自更新系统的经典死法是"更新器把自己更新坏了"。解法不是把更新做聪明,而是分层不动点——越内环越蠢、越少改:

| 环 | 内容 | 谁能改 | 坏了怎么办 |
|----|------|--------|-----------|
| **环 0(冻结层)** | supervisor 脚本、git 历史、`stable` tag、db 备份、SSH 逃生通道、webhook 逃生通知 | 只有人(agent 的 diff 碰保护路径 → 强制转人工审) | 人修;因为只有几十行 shell,基本不会坏 |
| **环 1(受控层)** | bot 本体代码(运行树,pinned 到已部署 sha) | 只能经流水线:门禁 → 合 main → supervisor 部署 | 自动回滚到 stable |
| **环 2(自由层)** | agent 的开发 worktree | dev agent 随便折腾 | 删掉重来,影响不到任何人 |

只要环 0 独立存在,最坏情况是"一次坏部署被自动回滚",而不是系统变砖。

---

## 运行树 / 开发树分离(前置改造)

现状:live bot 用 `tsx packages/bot/src/index.ts` 直接跑在 `/home/ubuntu/lht/octopus-secretary` 源码树上——编辑的树就是运行的树,任何人(或 agent)改一行,下次重启就上线了。必须拆开:

- **运行树**:`/home/ubuntu/lht/octopus-secretary` 保留为运行树,但进入自举流程后由 supervisor 管理,始终 `git checkout --detach <已部署 sha>`。"线上跑的是什么"永远有精确 sha 可答、可回滚
- **开发树**:每张票一个 `git worktree`(如 `/home/ubuntu/lht/octopus-worktrees/ticket-<id>`,分支 `ticket/<id>-<slug>`),dev agent 只在这里干活,门禁也在这里跑
- 运行时目录 `/home/ubuntu/lht/octopus-dev`(config.yaml、bot.db、归档)不在仓库内,天然不被 agent 的 repo 操作触及
- 阶段 1 期间人类开发者(Claude Code)仍可直接用运行树;"运行树只认 committed sha"的纪律从阶段 2(supervisor 上线)开始强制

---

## 工单模型:双轴状态

一张票有两条独立进度轴,面板上是两个徽标:

**开发轴 `dev_status`**

```
讨论道(并发,spec_concurrency 上限,只读代码)
  queued → speccing → ┬ simple : ready_to_dev(不等人)
                      └ complex: spec_ready ──(人点按钮 / agent 认出「开始实现吧」)──→ ready_to_dev
开发道(串行,唯一改代码的地方)
  ready_to_dev → developing → gating → gated
                     ↑____________|   (门禁失败带日志回 developing,自修限 2 次,超限 → needs_human)
  侧出口:awaiting_reply(复杂票提问,**让出开发槽**,用户回复后回队首)、needs_human、cancelled
```

**工单类型 `kind`(工单 #2 引入)= agent 的提问权限**

- `simple`:**禁止提问**。歧义由 agent 自己拍板,集中写进方案的「## 假设」小节;方案一出立即进开发,全程无人等待。飞书 `/dev 标题 | 描述` 默认建这种
- `complex`:允许在**会改变方案走向**的问题上提问——方案里写「## 待确认」,或开发中输出 `<<ASK-USER>>` 哨兵停下来问;排队时优先于 simple
- 复杂票的自决开工:修订轮如果认定用户已明确批准(如「可以了,就这样开始实现吧」),末行输出 `<<START-IMPLEMENT>>`,流水线剥离哨兵后直接进开发。哨兵只认末行精确匹配,认不出就退回人工按钮(面板按钮在输入框上方,不在页头——确认是对话的最后一句话)

- `speccing`:秘书读工单,产出简短实现方案(改哪些模块、是否涉及迁移、**验收标准**)。**工单一创建就跑这一轮**,不排队等——它只读代码,没有并发风险,而让人盯着「暂无会话」是纯粹的浪费。验收标准后面直接变成验证工单的 checklist
- `gating`:在 worktree 里跑 `tsc --noEmit` + `npx vitest run` + 无飞书 e2e 仿真,全离线,不碰线上
- `gated`:rebase 到最新 main、复跑门禁、合入 main。此后这张票"已开发",等上线

**部署轴 `deploy_status`**(gated 之后才有意义)

```
pending(未上线) → deploying → live_unverified(已上线待验证) → verified ✅
                                        └→ reverted(验证不通过,已回退/待 revert)
```

**串行的边界(工单 #2 收窄)**

- 串行槽 = `developing` + `gating` 两个状态,即**只有改代码的轮次串行**。`claimNextDevTicket` 的事务就是这个保证
- 讨论道并发,上限 `selfhosting.spec_concurrency`(默认 16;2026-10-20 前为 2)。早先的理由是内存:每轮是一个 `claude` 进程,机器 3.7G 且与线上 bot 共用;现在各轮在 Runner 设备上执行,这个上限只约束 Head 侧的调度扇出,设备负载由容器限额和每个工作区的作业槽约束
- **停住的票一律不占槽**:`spec_ready` / `awaiting_reply` / `needs_human` 都是 parked。一张卡住的票不该冻结整个队列——这与去掉 WIP 闸是同一个判断的两面
- **没有 WIP 上限**:gated 积压不再阻止新票开工;面板照旧显示积压数,该上线时上线
- `已上线未验证` 不阻塞下一次部署,但再次触发上线时弹二次确认并明示"回滚锚点将跨越未验证的变更"

**主干积压模型(设计决断)**

票过门禁即合入 main,而非各自挂在分支上等部署。理由:N 个漂浮分支互相 rebase/冲突是指数级痛苦;主干积压让"未上线的东西"精确等于 `stable..main` 区间,面板一个数字说清。代价:回退单个 feature 要走 revert commit(生成一张 revert 工单走同一流水线);积压深度靠及时上线的节奏控制,而不是靠停工闸(工单 #2 去掉了 WIP 上限)。

---

## 人机交互:工单页 = 实时会话

> 依赖通用能力「会话实时视图」,设计见 `doc/design-session-live-view.md`。

**接入入口**(用户怎么进来):① dashboard 顶部导航「开发」tab(统一壳层,
见 `doc/design-dashboard-shell.md`);② 飞书 `/dev` 命令回工单页链接(骑现有
`/dashboard` 的 dt_ 登录链路,点开即登录态);③ 开发协作群每张状态卡片带
「在网页打开」按钮直达对应工单。

**建单表单**(网页表单 + 飞书 `/dev new` 对话式,字段一致):

- 标题 + 需求描述(自由文本,speccing 阶段会被细化,不必一次写全);
- **模型**:默认 `opus`(CLI 别名,始终解析到最新一代 opus),下拉可换;
- **effort**:默认 `high`,提供 `xhigh` 选项(更慢更贵,留给难票;表单注明);
  传递方式实现时按装机 CLI 版本确认(`--effort` / settings 注入),
  两者都不可用则如实降级并记 known limitation;
- **权限**:dev agent 固定 `--dangerously-skip-permissions`,表单只展示说明
  **不提供关闭开关**——headless 轮次会死在第一个权限门上(与 append 机制的
  既有裁决同理),想要带权限门的开发就不该走自动流水线。

**页面布局**(dashboard 新页,登录态复用现有 dt_/管理密钥体系):左侧工单列表
(活跃置顶 → 排队区 → 已完成),右侧 = 选中工单的**会话视图**(复用抽出的
`session-view.js` 渲染模块 + live 订阅)+ 底部输入框。飞书侧对等:开发协作群
收状态卡片(spec 待确认 / 门禁失败 / gated / 上线结果),对工单卡片回复
等价于网页输入——两个面共享同一 inbox,谁先到谁排前。

**dev agent 运行形态:bot 主机上的 headless Claude Code 轮链**

- 每张票 = 一个真实 Claude Code 会话:首轮
  `claude -p --session-id <预生成 uuid> <spec prompt>` 在票的 worktree cwd
  启动,后续每轮 `claude -p --resume <sid>`。**会话 id 在进程起来之前就写进
  DB**,面板因此第一秒就能打开 transcript——否则首轮那几分钟页面只会说
  「工单还没进入开发」,而它其实跑得好好的(工单 #2 修复)。配套的
  `turn_started_at`(开跑前写、返回后清)是"确实有轮次在跑"的权威信号,
  压过任何从日志尾部做的猜测。JSONL 自然落进
  bot 主机 scan home → transcript viewer / live 视图**零改动可见**,这是选
  CLI 轮链而非 Agent SDK 内嵌会话的决定性理由;
- bot 主机 executor 不经过 shell。Claude 轮自工单 #183 起是 spawn + 双向
  JSONL,prompt 走 stdin 首条流式消息,整轮保持通道打开;Codex 轮自工单 #234
  起复用 Runner 的 `CodexManagedSession`,通过官方 app-server JSON-RPC 的
  `turn/start` / `turn/steer` 驱动同一轮(见上文对话一节);
- 会话推进**只能由票状态机驱动**(speccing 轮 / 开发轮 / 门禁自修轮 /
  用户消息轮)。`/api/sessions/append` 对 bot-host **维持只读裁决不变**——
  工单消息走 `/api/tickets/:id/message`,是流水线代持的受控轮次,不是给
  用户 bot 主机 shell;
- 边界如实记录:dev agent 以 ubuntu 账号 + `--dangerously-skip-permissions`
  跑在 bot 主机,理论上摸得到 config/bot.db——与今天人类开发者(Claude Code)
  权限相同,并非新增面。约束靠:worktree cwd + prompt 纪律(禁读运行时目录)
  + transcript 全员可见形成的社会审计 + 保护路径门禁;长期出路是把 dev agent
  挪到专用 Runner 机执行。

**对话(讨论/细化需求):轮中注入优先,inbox 兜底**(工单 #183 修订了原来的
「turn-based + inbox,不做轮中注入」)

- 输入 → `POST /api/tickets/:id/message` → 落 `ticket_messages`(记 who/via);
- agent 空闲 → 立即起一轮 resume,prompt 逐条带 `[用户A via web]: …` 署名
  (共享开发频道,所有登录用户可发言,agent 需要知道在跟谁说话);
- **agent 在跑 → 先交给正在跑的那一轮**。Claude Code 用
  `--input-format stream-json` 保持 stdin,后续消息带 `priority: "now"`;
  Codex 用 app-server `turn/steer`。两者都在 provider 的下一个安全边界
  (通常就是当前工具调用返回之后)进入当前工作,不另起一个 CLI 进程;
- **写入顺序即诚实边界**:消息先落库为未读,transport 接住之后才 `delivered_turn`
  盖章;Claude 的 pipe write 同步返回,Codex 等 `turn/steer` RPC 确认。确认前
  页面仍显示「待送达」;provider 拒绝、连接失败或那一轮已在收尾,就退回原来的
  inbox 语义,由下一轮冲洗。
  被某次失败尝试吞掉的注入消息,由重试 prompt 显式带上——inbox 已经盖过章,冲不
  出来了;
- 排队中的票(还没轮到)没有会话:留言暂存为工单评论,speccing 首轮 prompt
  一并带入;
- speccing 的方案确认(`spec_approved`)= 网页按钮 + 飞书卡片双投放,点谁都行。

**detach 语义**:一切状态在服务端(JSONL + 工单行 + inbox),浏览器关掉、
断网、换设备都不影响推进;重开 = 历史全量(现有 read 路径)+ live 续订
(SSE 断线重连见通用能力文档)。关键节点由飞书通知兜底,不依赖网页在线。

**已完成工单的补充需求:fork 续跑,不绕队列**

- 已完成票的页面保留输入框,提交 = 创建 **follow-up 票**(`parent_ticket_id`
  链到父票),**照常进队列**——补充需求不能成为绕过串行约束的后门;
- 轮到它时:从当前 main 开新 worktree,`claude -p --resume <父会话id>
  --fork-session` fork 出**新会话**(父会话作为已完成票的档案保持不可变),
  前端自动跟随新 id;
- 首轮 prompt 自动前缀:`git log --oneline <父票合入sha>..main` 摘要 +
  「距上次会话代码已有变化,先审视变化再处理用户的新意图」;
- 旧版 CLI 无 `--fork-session` 时退化:开全新会话 + 注入父会话 digest
  (scan 层已有 digest 能力),语义如实告知前端。

**顶部额度条:流水线花的是这台机器的订阅**(工单 #4,已实现)

工单页原本只能"看它跑",看不到它**花掉了什么**。dev agent 的每一轮 headless
`claude` 都记在 bot 主机自己的 Claude 订阅上,所以"现在还能不能再开一张票"
是工单页的一等事实,不该靠 ssh 进去跑 `/usage` 才知道。

- **数据源** = CLI 自己 `/usage` 读的那个端点(`GET
  api.anthropic.com/api/oauth/usage`),凭证取 `~/.claude/.credentials.json`
  里的 OAuth access token。这是**客户端内部契约,不是公开 API**,因此
  `devpipe/quota.ts` 全链防御式解析:优先吃通用的 `limits[]`(`kind=session`
  / `weekly_all` / `weekly_scoped`,后者按 `scope.model.display_name` 自动成
  卡——今天是 Fable,明天多出别的 scoped 窗口无需改代码),缺失时回退扁平的
  `five_hour`/`seven_day`;认不出的条目直接丢弃,整份认不出就报
  `unavailable`,前端隐藏额度条,**工单页其余部分不受影响**。
- **凭证只读不刷新**:refresh 是会轮换的,抢刷等于让人类的交互式登录失效。
  过期就如实说"在本机跑一次 claude 即可刷新"。token 不出 `quota.ts`。
- **只给百分比**:响应里的 `extra_usage`/`spend`(美元额度、已用 credits)
  刻意不进 API 输出——工单要的是三个窗口,而 `/tickets` 对所有登录用户共享
  可见,金额不是应该顺手泄露的东西。
- **形式是 meter 不是环**:单个"用量对上限"的比率,标准形式是一条轨道
  (填充=已用,大字=剩余),三个窗口并排成 KPI 行;三个环等于三张两片饼。
  严重度(80%/95% 阈值,**本地判定**而非信上游的 `severity`)靠 图标+文字+
  色 三重编码,因为琥珀色在浅色底上低于 3:1,颜色不能独自承担含义。
- **节流**:服务端成功缓存 60s、失败 30s 且并发去重,前端同频轮询——多开几个
  标签页也只有每分钟一次上游调用。

---

## 表结构(草案)

```sql
-- 工单
CREATE TABLE dev_tickets (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- 原始需求
  requester_user_id TEXT NOT NULL,
  spec TEXT,                       -- speccing 产出:方案 + 验收标准(JSON)
  model TEXT NOT NULL DEFAULT 'opus',   -- claude --model;'opus' 别名始终解析到最新 opus
  effort TEXT NOT NULL DEFAULT 'high',  -- 'high' | 'xhigh'
  dev_status TEXT NOT NULL DEFAULT 'queued',
  deploy_status TEXT,              -- gated 后置为 'pending'
  branch TEXT, commit_sha TEXT,    -- gated 时的合入 commit
  session_id TEXT,                 -- dev agent 的会话(headless CLI 轮链),面板/live 视图直接引用
  parent_ticket_id INTEGER,        -- follow-up 票链到父票(fork 续跑,见人机交互节)
  gate_attempts INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);

-- 工单对话 inbox:网页/飞书双面共享;agent 空闲即冲洗成一轮 resume
CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
  author_user_id TEXT NOT NULL,
  via TEXT NOT NULL,               -- 'web' | 'feishu'
  body TEXT NOT NULL,
  delivered_turn INTEGER,          -- NULL=排队中;盖章=被那一轮消费(含轮中注入)
  created_at INTEGER
);

-- 部署意图:bot 只写,supervisor 领取执行
CREATE TABLE deploy_intents (
  id INTEGER PRIMARY KEY,
  target_sha TEXT NOT NULL,        -- 默认触发时的 main HEAD
  base_sha TEXT,                   -- supervisor 填:部署前线上 sha
  triggered_by TEXT NOT NULL,      -- user id
  notify_channel TEXT,             -- 回报结果的 chat/channel
  status TEXT NOT NULL DEFAULT 'requested',
    -- requested → claimed → building → restarting → health_gate
    --   → confirm_wait → succeeded | rolled_back | failed
  confirm_deadline INTEGER,        -- supervisor 填:健康门通过时刻 + confirm_timeout_s
  confirm_decision TEXT,           -- 'alive' | 'rollback';NULL=存活确认窗内未决
  confirm_by TEXT, confirm_at INTEGER,
  detail TEXT,                     -- 各阶段日志摘要 / 失败原因(含回滚原因:
                                   -- health_gate_failed | confirm_timeout | user_rollback)
  notified INTEGER DEFAULT 0,      -- 新 bot 起来后补发结果卡片用
  created_at INTEGER, updated_at INTEGER
);
-- 同时只允许一个活跃意图
CREATE UNIQUE INDEX idx_active_intent ON deploy_intents(status)
  WHERE status IN ('requested','claimed','building','restarting','health_gate','confirm_wait');

-- 验证工单(上线成功后 supervisor 落库、新 bot 分发)
CREATE TABLE verify_tickets (
  id INTEGER PRIMARY KEY,
  intent_id INTEGER NOT NULL REFERENCES deploy_intents(id),
  ticket_ids TEXT NOT NULL,        -- 本次上线包含的 dev_tickets(JSON array)
  modules_touched TEXT NOT NULL,   -- diff --stat → 模块映射(JSON)
  checklist TEXT NOT NULL,         -- 各票验收标准聚合(JSON)
  assignees TEXT NOT NULL,         -- 触发人 + 各票提单人
  status TEXT NOT NULL DEFAULT 'open',  -- open → passed | failed
  created_at INTEGER, updated_at INTEGER
);
```

bot 与 supervisor 共用 bot.db(已是 WAL);supervisor 只做短事务(领取意图、推进 status、落验证工单),用 `sqlite3` CLI + `busy_timeout` 即可。

---

## 上线流水线

**触发面(不依赖本地 CLI)**

- 飞书:`/deploy` 命令,或工单卡片上的「上线」按钮
- dashboard:部署页按钮(登录态 = 现有 dt_/管理密钥体系)
- 权限:config 里一个 `deployers` 用户白名单;不在名单只能提单不能上线
- bot 收到触发:校验(无活跃意图、目标 sha 可达)→ **先发救援卡(见下)** → 写 `deploy_intents` → 回执"已排队,系统将短暂重启,飞书约有 10-20s 静默"

**救援卡(触发即发,先发后动)**

设计动机:部署失败的最坏形态是"新版起不来、回滚版也起不来、bot 彻底哑了"——
此时用户要手动回到 CLI 牵着 agent 修,而他需要的全部坐标必须**在系统还活着时
就已经发出去**。所以救援卡在写部署意图**之前**发(飞书 notify channel +
开发协作群;网页部署面板同步展示同一份内容),全静态文本,后端挂掉后仍躺在
飞书消息历史里可查:

```
🚀 部署 #42 · 触发人 张三 · 2026-07-25 14:03
target main@abc1234 ← base def5678(回滚锚 stable@9abcdef)
包含工单:
  #17 增加X — session 018f2a…(worktree /home/ubuntu/lht/octopus-worktrees/ticket-17)
  #19 修复Y — session 0190c4…(worktree …/ticket-19)
⏱ 上线后 5 分钟内,任一用户在飞书确认卡或网页横幅点「存活确认」,
  超时自动回滚到 base(点「立即回滚」可即刻回退)
──若部署失败且系统未自动恢复──
1. SSH bot 主机(接入教程里的地址)
2. 看 supervisor 日志:/home/ubuntu/lht/octopus-dev/supervisor.log
3. 手动回滚:cd /home/ubuntu/lht/octopus-secretary
   && git checkout stable && scripts/dev-restart.sh
4. 牵 agent 修复:cd <上面的 worktree> && claude --resume <session id>
   (它带着这张票的全部上下文;或在运行树现起 claude)
5. db 备份:/home/ubuntu/lht/octopus-dev/backups/(supervisor 部署前自动留)
```

明确记录:**执行替换的不是 agent,是 supervisor(环 0 的哑 bash)**,这是
有意设计——环 0 不能依赖模型和 API 的可用性。"出事后人牵的 agent" = 救援卡里
列出的各票 dev session(`claude --resume` 即满血上下文接管),或运行树里
现起的新 Claude Code;救援卡的职责就是把这些坐标在事前送到用户手里。

**supervisor 执行(环 0,主系统之外)**

独立常驻进程(systemd user 单元,`Restart=always`;机器无 systemd user 时用 cron `@reboot` + flock 守护),约百行 bash,轮询间隔 5s:

1. 领取意图(`requested → claimed`,记录 `base_sha` = 运行树当前 HEAD)
2. **备份 `bot.db`**(wal checkpoint 后 copy 到 `DATA_DIR/backups/`,保留最近 5 份)
3. 运行树 `git fetch && git checkout --detach <target_sha>` → `pnpm -r build`;build 失败 → checkout 回 base_sha,意图置 `failed`,老 bot 全程无感
4. drain 停旧进程(复用 dev-restart.sh 的逻辑:SIGTERM → 等 PID 消失,上限 DRAIN_WAIT_S)
5. 起新进程,**健康门**:90s 内出现 ready 行 + `/health` 连续 3 次 200
6. 健康门通过 → 意图置 `confirm_wait`,进入**存活确认窗**(见下):轮询
   `confirm_decision`,拿到 `alive` → 意图置 `succeeded`、生成 `verify_tickets` 行;
   窗内超时或用户点「立即回滚」→ 走回滚阶梯
7. **回滚阶梯**:部署启动后的任何失败都先回 **`base_sha`**(上一个部署,
   几分钟前还活着,最小意外);base 也过不了健康门 → 回 `stable` tag
   (最后一个全验证版);stable 也失败 → webhook 喊人 + 停手等 SSH。
   build 失败特殊:进程未动,checkout 回 base 即可,老 bot 全程无感

**存活确认窗(死人开关,`selfhosting.confirm_timeout_s` 默认 300)**

健康门只能证明"进程起来了",证明不了"用户还够得着它"——飞书 WS 被抢、
公网口没监听这类失败,`/health` 全程绿灯。所以健康门之后再加一道**需要
人手的门**:新版本上线后 5 分钟内,必须有人从任一端点一下,否则自动回滚。

- 新 bot 启动读到 `confirm_wait` 意图 → 立即两路发确认入口:**飞书卡片**
  (触发人 + 开发群,「✅ 系统存活确认」「⛔ 立即回滚」两键)+ **dashboard
  全站横幅**(壳层级,任何页面可见)。触发上线时的回执就预告
  "上线后 5 分钟内需点存活确认,否则自动回滚——别点完部署就走人";
- **任一登录用户、任一端,点击都算数**(这道门验证"系统活着且有人够得着",
  不是审批权限;`confirm_by` 记录是谁)。飞书点击走卡片回调 = 证明 WS 收发
  链路活;网页点击走 `POST /api/deploy/confirm` = 证明公网入口活;
- **计时器归 supervisor**(环 0):bot 只负责把点击写成 `confirm_decision`;
  窗口从健康门通过时刻起算。bot 若坏到把点击写不进 DB,点了也等于没点——
  如实回滚,这正是想要的语义;
- 「⛔ 立即回滚」= `confirm_decision='rollback'`,supervisor 见之立即回滚,
  用户肉眼发现不对时不必干等 5 分钟,也不必 SSH。

**结果通知闭环**

- 新 bot 启动时扫 `deploy_intents` 中 `succeeded/rolled_back 且 notified=0` 的行:分发验证工单卡片、给 `notify_channel` 补发结果、置 `notified=1`。回滚后起来的是旧版 bot,同样能读这张表报忧;结果卡片按 `detail` 里的回滚原因如实区分「新版起不来」和「没人按下存活确认」
- **双重失败**(回滚后的 bot 也起不来):supervisor 直接调飞书**自定义机器人 webhook**(独立于主 app,不占 WS,不依赖 bot 代码)喊人 + SSH 逃生。webhook URL 写在 supervisor 自己的 env 文件里,属于环 0

**验证工单内容**

- 本次包含的票:`base_sha..target_sha` 区间内各票的 gated commit
- 动过的部件:`git diff --stat base..target` → 路径到模块的映射表(维护在 supervisor 侧一个静态文件,或直接按顶层目录归并)
- checklist:各票 speccing 阶段写下的验收标准逐条列出
- 分发对象:触发上线的人(验整体健康)+ 每张票的提单人(验自己的 feature)
- 全部勾完 → `verify_tickets.status=passed` → **`stable` tag 前移到 target_sha**(stable 是回滚锚点,只有全验证的 sha 配得上);任何一条不通过 → 该票 `deploy_status=reverted`,自动生成 revert 工单(revert commit 走正常流水线),或提单人选择"修复向前"生成 fix 工单

---

## 人工道落地:`POST /api/land`(工单 #5,已实现)

**问题**:工单道的合入在流水线进程内串行(全局 git 锁),人工道的 `scripts/ops/land.sh`
则在自己的进程里跑门禁、挪 `staging` ref。两串互不相知 = 秒级竞态窗:一张票刚过门禁
准备 ff 的同一秒,land.sh 也在挪 staging,后动者盖掉先动者,或让先动者合入一棵门禁
没见过的树。land.sh 的 flock 只挡另一个 land.sh。

**做法**:把这一步搬进流水线,`DevPipeline.land(branch, who)`:

1. **锁外**快速校验:分支存在、不是 base 自身、`staging` 是它的祖先(否则让人先 rebase)、
   确有新提交、没有另一个 land 在跑(直接拒绝而不是排队——排队者醒来时祖先关系已过期);
2. **锁内**(与工单道 `mergeToBase` 同一把锁)依次:准备 detached `_land` worktree →
   跑门禁(与工单道**同一个 `gate` 注入点**)→ 复核 base 未被带外移动 → 经按 base 分支隔离的 `_base-*`
   worktree `merge --ff-only`。

**两个取舍,都是有意的**:

- **整段持锁**(而不是"锁外跑门禁 + 锁内复核")。代价真实:一次落地会让流水线的
  worktree 创建、rebase、工单合入停等一整轮门禁(数分钟)。理由是落地低频,而 base
  分支上的丢失更新不可重试;把复杂度换成等待是划算的。
- **门禁跑在 detached `_land` worktree 上**,不在缓冲分支自己的工作树里。后者是活的
  办公桌(另一个 agent 可能正在改),未提交文件会被门禁测到却不会被落地——测的和落的
  必须是同一棵树。`clean -fd`(不带 `-x`)保住 `node_modules`,第二次落地不重装。

带外(有人直接敲 `git`)是全局锁唯一管不到的移动者,所以门禁跑完还要复核一次 base;
不一致就报 `base_moved` 拒绝,而不是落一个门禁没见过的 sha。

**保护路径检查不在人工道执行**——它约束的是 agent 产出(工单道 `gateTurn` 里的
merge-base diff),而人工道恰恰是 `scripts/`、`.claude/rules/` 这些路径唯一的合法
入口:人改、人 review、人落地。权限边界在 `deployers` 名单上,不在 diff 上。

`scripts/ops/land.sh` 改为 API 优先、bot 不可达才回退本地(保留 flock 并打印竞态告警)。
`scripts/` 是保护路径,补丁由人贴入:见 `doc/handover-api-land.md`(含接口表、
land.sh/common.sh 全文与验收步骤)。

---

## 保护路径与迁移约束

- **保护路径**(agent diff 触碰即门禁标红、强制人工审):`scripts/supervisor*`、`scripts/dev-restart.sh`、`.claude/rules/`、部署相关 systemd 单元文件
- `config.yaml` / 密钥在运行时目录,不在仓库内,agent 的 repo 操作天然摸不到;dev agent 的 session 在 transcript viewer 全员可见,更不能让它去读密钥
- **DB 迁移 additive-only**:只加表/加列,不改不删——旧代码必须能跑在新 schema 上,这样回滚只回代码不回数据,不丢消息。门禁 grep 迁移 diff 中的 `DROP/ALTER ... DROP COLUMN` 等,命中即转人工。db 备份是最后兜底,不是常规回滚手段

---

## 资源约束(3.7G 共享内存)

build、dev agent、线上 bot 三者不叠峰:

- 门禁 build 在开发槽内串行发生;与之并发的只有讨论轮(纯推理,不 build)
- 串行流水线在这台机器上不只是偏好,是刚需

---

## 分阶段落地

| 阶段 | 内容 | 风险 |
|------|------|------|
| **1** | `dev_tickets` 表 + 面板(dashboard 页)+ 秘书在 worktree 开发/门禁/合 main,产出摘要;上线仍由人跑 `dev-restart.sh` | 低。等于把"现在用 Claude Code 干的事"搬进系统并对所有用户开放 |
| **2** | supervisor + 部署意图 + 飞书/网页触发 + 健康门 + 自动回滚 + db 备份 + 验证工单 | 中。"自更新"真正上线的时刻;supervisor 本身要人写、人审、然后冻结 |
| **3** | 打磨:revert 工单自动化、WIP 参数调优、验证超时提醒升级 | 低 |

验收环节永远留人,不设阶段 4。

---

## 2026-07-25 重构:agent 原生会话模型(工单 #12,已实现)

> 本节之前的「双轴状态」「两条道」描述保留作历史背景;实现已被下述模型替换。

**触发事故**:#11 verified 之后用户在工单对话框发消息,消息落库为「待送达」但没有任何 lane 会调度终态票——状态机的每一条接缝都是消息可以掉进去的洞。

**反转控制**:与其正向构造状态机去驱动 agent,不如把工单当成**普通对话**,把「改代码的权力」做成 agent 主动申请的**工具**:

- `dev_status` 收敛为三值:`open`(对话进行中)/ `landed`(已 ff 合入基线,仍可继续对话)/ `cancelled`。提问、报错、方案确认全部是**消息**;migration v19 把旧十值映射过来(gated→landed,其余→open)。
- **一个 turn pump**:非 cancelled 且有未读 inbox 的票就跑一轮(并发 = `spec_concurrency`)。建票时把 body 落成首条未读消息,于是「新建 / 用户追问 / landed 后 follow-up / 锁释放唤醒 / 重启唤醒」是**同一个触发器**,不存在第二种调度路径。
- **两个工具承载开发权**(per-turn bearer token → dashboard `/api/devpipe/*` loopback → pipeline 内存中的同一份实现;CLI 侧 `--mcp-config` + `--strict-mcp-config` 挂 `dist/devpipe/mcp-server.js`):
  - `devpipe_claim_workspace`:抢**全局唯一开发锁**(旧串行开发道的实体化)+ 在全局 git 锁内把 worktree rebase 到 base tip,返回缺席期间的 ff 提交清单;rebase 冲突把 worktree 留在冲突态、指导 agent **当场**解掉。锁被占 → 返回占用者,agent 把计划写进回复结束本轮;放锁时 pipeline 给每个等待票投一条未读消息(又是同一个触发器)。
  - `devpipe_submit`:保护路径 merge-base diff → 脏树/无提交检查 → 门禁(install+tsc+全量 vitest,**不持 git 锁**)→ 与人工道 `land()` 同一把 git 锁内 `ffBaseTo` **ff-only** 合入。ff-only 本身就是新鲜度不变量:门禁后 base 被(人工 land / 带外)推进,ff 必然失败,返回 `base_moved` 让 agent 重新 claim(重新 rebase)再交——旧的 `baseMovedRetried` 补偿逻辑整个删除。门禁失败回日志尾,agent 原地修再交(每轮 `max_gate_attempts` 默认 3 次);成功即置 `landed` + `deploy_status=pending` + 放锁。
- **失败与终止的语义**:轮次崩溃 = 票留在 `open`,原因写 `error` 列 + 对话注记,用户回一句话即重试(没有 needs_human 状态);轮末未 submit 的锁自动释放(已 commit 工作留在票分支);轮被杀后迟到的 submit 被 **ghost guard** 拒绝(token 随轮次死亡,门禁白跑但不落无人负责的代码);重启时 `clearDevTurnMarkers` 返回被打断票 id,逐个投「重启打断」唤醒消息补上被吞掉的续跑。
- **kind 退化为 prompt 纪律**:simple = 首轮就 claim→实现→submit 一轮闭环、禁提问;complex = 先出方案、等用户在对话里明确认可再动手,认可与否由 agent 从对话语义判断——`<<ASK-USER>>`/`<<START-IMPLEMENT>>` 哨兵删除。
- **存活判定**:`turn_started_at` 照旧;transcript stall 检测新增 `isExternallyBusy` 回调——门禁在一次 MCP 工具调用里可静默十几分钟,工具在途时不判挂死;CLI 进程给 `MCP_TOOL_TIMEOUT=45min`。
- **兼容面**:`approveSpec`/`requeue` 路由保留为 shim(发一条对话消息),`scripts/ops/ticket.sh` 零改动;人工道 `POST /api/land` 原样保留(与 submit 共享 `ffBaseTo` 这唯一的 base 写入点);部署编排(DeployService/supervisor)只把筛选条件从 `gated` 换成 `landed`。

**残留边界**:复杂票的「等认可」没有机器强制,agent 抢跑只能靠门禁与取消兜底;轮失败时该轮 inbox 已消费,重试轮靠会话上下文捡起;锁/等待队列/token 是内存态(重启即清,靠唤醒消息续);mid-rebase worktree 可能跨轮存在(下次 claim 提示收尾)。

## 已知风险与开放问题

- 每次自部署都有 10-20s 飞书真空窗(平台限制);部署频率被串行流水线天然节流,可接受
- dev agent 在 bot 主机跑,烧 bot 的 API 额度;共享队列 = 共享成本,是否按提单人记账待定
- 未验证部署之上叠加新部署:警告 + 二次确认后放行(硬阻塞会把小修补丁场景逼疯),代价是回滚锚点更远
- supervisor 与 bot 共写 SQLite:WAL + 短事务 + busy_timeout 下安全,但 supervisor 侧必须保持"只碰三张表、事务毫秒级"的纪律
- 主干积压模型下,单票回退 = revert commit,若后续票与它有代码耦合,revert 可能冲突 → 此时自动转人工
- 存活确认窗要求**部署后 5 分钟内有人在场**,触发人别点完就走(回执有预告)。超时回滚是保守误伤:系统可能明明健康只是没人点,代价是多一次重启回到 base——按设计取向,宁可白滚一次,不可让无人看管的新版本过夜
