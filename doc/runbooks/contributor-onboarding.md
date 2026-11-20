# 贡献者(实习生)接入与评审通道

## 结果

一个没有飞书、没有 GitHub 的新同学可以:用管理员签发的 `dt_` 密钥登录;在自己电脑上
用 Docker 起一个带 Runner 的开发容器;在 `/tickets` 提交**自己的**工单,由 bot 主机上的
agent 开发、在他的容器里编译和跑相关测试;`devpipe_submit` 把候选提交推到 GitLab 的
`contrib/<用户>/ticket-<id>` 分支并跑完整 CI,通过后自动建 MR,进入维护者的评审队列;
维护者批准后,一张批量合并工单由维护者名下的 agent 受控合入 `v4`。

贡献者**看不到**别人的工单、会话、agent 和运行机,不能 land、不能 deploy。

## 角色与能力位

| 能力位 | 含义 | 授予方式 |
|---|---|---|
| `contribute` | 进 `/tickets`、`/architecture`;只看/改自己的工单;落地走评审通道 | `/admin` 勾选 |
| `dev` | 共享开发工作间(所有工单、会话);落地直接 ff 合入 | `/admin` 勾选,蕴含 `contribute` |
| `deploy` | 上线、人工 land、**审批合并提案、执行批量合并** | `/admin` 勾选,蕴含 `dev` |
| `admin` | 跨用户读、`/admin`、`/apps` | `config.yaml` `dashboard.admins` |

Cedar 里对应的动作是 `Contribute`(`packages/bot/src/dashboard/authz.ts`);工单路由的
对象级过滤在 `routes/tickets.ts` 的 `mayViewTicket`。


## 验收 agent 账号

线上验收使用专用本地账号 `codex_acceptance`，当前权限为 `dev`（自动包含 `contribute`），不授予 `deploy` 或 `admin`。本机 token 位于 `/home/ubuntu/.config/octopus/codex-acceptance.token`，文件权限为 `600`，只供验收 agent 读取，不复制到仓库、prompt、日志或工单消息。

该账号可独立作为共享测试中的用户 A 或用户 B。需要验证“用户 A 开发、授权给用户 B、再交付给 lht”时，使用真实的 A/B 身份链路；不要通过管理员 key 给 `lht` 反复签发登录 key。`POST /api/admin/dashboard-token` 会替换同用户名的旧 key，只有用户明确要求轮换指定用户时才允许调用。

### 受托开发的完整操作授权（2026-10-10）

用户已明确取消“不能用管理员 token 代替”的工作流限制。具有开发权限并受 `lht` 委托的 agent，在当前委托任务范围内可以使用已有开发、管理员及运维权限完成所需操作，包括业务数据构建、空间成员管理、App 授权、验收准备、问题修复和正常门禁下的合入。普通用户会话过期、测试账号缺少权限或空间成员关系时，agent 应自行使用可信管理入口解决，不要求用户重复执行已授权的操作。

`codex_acceptance` 是独立被测用户，不是受托 agent 的权限上限。管理员可以准备演示数据和授予测试所需成员、App 权限；需要验证角色隔离、跨用户共享或撤销时，再以相应独立身份发起真实请求。记录管理员准备动作、实际被测身份、目标和结果，不能用管理员请求成功来证明普通用户权限正确。

复用服务端现有 `/home/ubuntu/lht/octopus-dev/dashboard-token.txt` 及现有可信运维入口。优先平台管理 API；必须通过服务侧维护入口处理时，复用类型化服务和现有校验、保留权限审计，避免直接修改业务表绕过不变量。管理员凭据保持在受控操作环境，不打印、提交或交给无关客户端。不要调用 `POST /api/admin/dashboard-token` 解决普通登录过期：该接口会轮换真实用户 key。

通过 `scripts/ops/land.sh` 或 `devpipe_submit` 完成正常合入门禁。人工合入接口要求 `deploy`，测试账号的 403 不代表委托人没有权限；使用既有受托运维权限即可。部署及 App 激活何时继续以 `AGENTS.md`「Deployment is explicit」为准，普通开发仍以成功合入为默认交付点。

## 一、开号(维护者,1 分钟)

1. `/admin` → 「本地账户」:填 username(如 `lilei`)与显示名 → 「创建本地账户」。
   页面只显示一次 `dt_` 登录密钥,复制后私下交给本人;丢了就在该用户行点「签发登录密钥」
   轮换(旧密钥立即失效)。
2. 在上表给该用户勾 **contribute**。不要勾 dev/deploy。
3. API 等价:`POST /api/admin/local-user {username, display_name}`、
   `POST /api/admin/dashboard-token {username}`、
   `POST /api/admin/grant {username, capability: "contribute", value: true}`(均需 Administer)。

新账户默认:可登录、可用 Sessions+(首次需在可信外层确认发布者)、可在「总览」给自己签发
设备令牌、可用权限中心;零跨用户读取。

## 二、开发容器(贡献者本人)

见 `ops/dev-container/README.md`。要点:

```bash
OCTOPUS_RUNNER_TOKEN=rt_xxx RUNNER_DEVICE=lilei-dev ops/dev-container/install.sh
```

容器里没有仓库凭据:代码由流水线按工单以一次性 bundle URL 送入(`/api/contrib/bundle/<token>`,
`packages/bot/src/devpipe/bundle-handoff.ts`),推送由 bot 主机完成。

维护者在 `config.yaml` 登记并重启:

```yaml
selfhosting:
  dev_machines:
    lilei: { device: lilei-dev, checkout_dir: /work/octopus }
```

设备必须是该用户自己登记的且在线,否则该工单退回 bot 主机最小范围验证,提示词里不会
出现 machine 工具。

## 三、评审通道的状态机

`merge_proposals` 表(migration v51)每行一个候选;`packages/bot/src/devpipe/contrib-review.ts`
是唯一的状态推进者。

```
devpipe_submit(review lane)
   ├─ 同一套验证:保护路径 / App 路径域 / rebase 到 v4 tip / 点名测试 / 薄落地门禁(tsc + diff 涉及测试)
   └─ 推 contrib/<user>/ticket-<id> → 触发 GitLab pipeline(octopus-contrib-check)
        → ci_pending ──红──▶ ci_failed(失败摘要作为消息投入工单,agent 修复后再 submit → 新提案,旧的 superseded)
              └──绿──▶ awaiting_review(自动建 MR)
                    ├─ 打回 → rejected(原因作为消息投入工单 → agent 修改 → 再 submit)
                    └─ 批准 → approved ──「执行批量合并」──▶ merging
                                   批量合并工单(维护者名下,direct lane)落地后:
                                   ├─ 提案内容在落地结果中 → merged,MR 关闭并留言
                                   └─ 不在 → merge_failed(原因见批量合并工单回复)
```

- 审批入口:`/tickets` 侧栏「贡献者评审队列」(`dev` 可读,`deploy` 可审批/执行);API
  `GET /api/merge-queue`、`POST /api/merge-queue/decide {proposal_id, decision, note}`、
  `POST /api/merge-queue/run {proposal_ids?}`。
- 批量合并工单的 body 由 `buildMergeBatchBody` 生成:按序 `git cherry-pick <base_sha>..<sha>`,
  审查 diff,冲突就地解决,跑涉及的测试,只调用一次 `devpipe_submit`;可疑提案跳过并说明。
  它走的是普通 direct lane:合并锁、薄门禁、知识台账一个不少——`v4` 仍只有一个写者。
- 判定「提案是否已合入」:祖先关系 / `git cherry` patch-id / 提案触及文件内容一致
  (`DevPipeline.proposalApplied`)。

## 四、CI

`.gitlab-ci.yml` 的 workflow 按分支给 pipeline 命名:`v4` → `octopus-v4-batch`(夜间批次
监视器只认这个名字),`contrib/*` → `octopus-contrib-check`。两者共用 `full_suite` 与
`resource_group`,贡献者候选与主线批次串行,互不干扰。

GitLab 侧 bot 令牌是 Developer 角色:能推未保护分支、建 MR、触发 pipeline;不能合并 MR。
MR 由流水线在批量合并落地后关闭,**不要在 GitLab 上点 Merge**。

## 五、验收清单

1. 以贡献者密钥登录:导航只有 总览 / 会话 / 应用市场 / 权限中心 / 开发 / 架构;
   `GET /api/tickets` 只返回自己的工单;打开别人的工单 403;`/api/merge-queue` 403;
   `/api/sessions?username=<别人>` 403。
2. 新建工单后侧栏显示「你是贡献者:……」提示;agent 首轮提示词包含「贡献者评审通道」。
3. 容器在线时,工单对话里出现「隔离 CI 开发环境:设备 <device>」与同步结果。
4. submit 后工单行显示「📤 已提交评审 · CI 运行中」,GitLab 出现 `contrib/<user>/ticket-<id>`
   分支与 `octopus-contrib-check` pipeline;`v4` 未移动。
5. 维护者在评审队列看到提案;打回后贡献者工单收到消息;批准 + 执行后出现批量合并工单,
   落地后提案变 merged、MR 关闭。

## 六、已知边界

- 工单 agent 仍运行在 bot 主机(消耗 bot 主机的模型额度),贡献者容器只做执行/测试机;
  把 agent 运行时搬到贡献者电脑需要把流水线凭据放到不受信机器上,本次不做。
- 首次同步冷装依赖可能超过 Runner 单条命令 5 分钟上限,第二次 `devpipe_ci_sync` 接着装。
- 提案状态的推进依赖 bot 进程轮询 GitLab(20 秒);bot 重启期间的 CI 结果在恢复后补读。
