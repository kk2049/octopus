# 定位一次 CI 红灯

写给接手 GitLab CI 修复票的 agent 和人。`doc/runbooks/testing.md` 讲的是怎么跑
测试,这一篇讲的是**测试已经挂了、你只有一份日志时怎么办**。

这份 runbook 存在的原因是一组实测数字:本仓库 136 个工单分支里 **58 个是 CI 修复
票**(43%),其中 26 个最终只改了 ≤2 个文件。也就是说,一半的修复票花掉一整个
agent 的启动、上下文和落地排队,只为了改一行断言——定位成本远高于修复成本。

## 这条通道的规矩(2026-08-18)

修复票不是普通工单。每天北京时间 04:00 的一次全量扫描聚合当天所有
`v4` 增量;红灯后按以下契约闭环:

1. **必须在本机跑**完整失败清单点名的文件——改之前跑一遍(看见它红),改之后
   再跑一遍(看见它绿)。全量套件仍然不在本机跑。
2. **落地门禁会替你重跑清单**(受 24 文件资源上限约束)。任何已选文件仍红就拒绝
   合入(`refusal=roster`)。
3. 修复落地后立即启动完整 GitLab CI,而不是等第二天。它是本票收尾门禁:
   红灯把全部新错误和扩大后的失败文件并集送回**同一张票、同一个 provider
   session**继续 fix-forward;绿灯才结束。
4. 自动修复没有「试两次就停」上限。每轮仍必须保护已有功能与工单原意;不得为了
   变绿放宽正确断言或回滚当天功能。连续红灯是新证据,不是换 agent 丢上下文的理由。
5. 修复 agent 同时拿到上一次全绿以来的**全部 commit**。关联到普通工单时包含
   用户原始输入与 agent 修改总结;关联到 CLI 落地时包含交付结果报告。先从增量
   找共同根因,再看失败文件。
6. **每次落地(不只修复票)门禁还会重跑本次 diff 涉及的测试文件**:
   diff 里的 `*.test.*` 文件,加上每个改动源文件 `X.ts(x)` 现存的同名兄弟
   `X.test.ts(x)`。拒绝码是 `changed_tests`,与 roster 步骤共用构建和预算。

关掉 roster 步骤的开关是 `selfhosting.ci_roster_gate: false`(只关本地清单
门禁,不会关闭夜间全量扫描或修复后的全量收尾门禁)。

## 你可能有一台真机(2026-08-17 起)

配了 `selfhosting.ci_machine` 且那台设备在线时,修复票的提示词里会多一段:你拥有
指向 **lht-val15 常驻 CI 容器**的 `machine_*` 工具(exec / 读 / 写),**直接执行,
不弹批准卡**。那个容器与跑全量套件的 job 同镜像、同 Node 22、同 pnpm,而且
node_modules 与 Playwright 浏览器是热的——所以"改一行再跑一遍"是秒级。

正确用法是**在容器里闭环**:复现 → 改 → 跑 → 直到清单全绿 → 把 `git diff` 带回
自己的 worktree 落地。不要在容器里 commit,也不要用它绕开落地门禁——门禁在开发
节点上重跑清单,是兜底。

容器只解决**环境**问题;代码由流水线维护——每轮修复开始前它会把容器检出增量同步到
当前基线(`ops/ci-container/sync-base.sh`),提示词里会写明同步到了哪个 sha,所以
直接 `git checkout <失败 sha>` 即可。同步失败时提示词会明说,那时才需要自己确认
容器停在哪。容器里的工作树每轮会被 `reset --hard`,是草稿纸,不要在里面 commit。
部署与排查见 `ops/ci-container/README.md`。

## 如果点名文件**单独跑是绿的**

这是一整类失败,历史上最贵的一类,先认出来再动手:

1. **单独跑一遍。** 绿了就说明这不是这个文件的 bug,而是**进程级串扰**——CI 每 40 个
   文件共用一个长驻进程(`.gitlab-ci.yml` 的分批循环)。这时改 fixture 一定是错方向:
   `bootstrap-v3.test.ts` 被连续三张票各改一次都没修对,因为三次都只单独跑它。
2. **按 CI 的真实批次复现。** 不要自己用 `vitest list` 重算分批——**那个顺序不稳定**,
   同一个 sha 在两台机器上算出的第 5 批文件集不同(实测:CI 的 batch 5 有
   `agent-module-contract/*` 与 `plugins/sessions/*`,本地重算的那批没有;用例数
   517 vs 459)。真实清单在**失败 job 的 junit 产物**里:

   ```
   GET /projects/<proj>/jobs/<job>/artifacts   →  reports/vitest-junit-<批次>.xml
   <testsuite name="..."> 就是那一批实际跑过的文件
   ```

3. **批次之间还有磁盘副作用。** 同一个 job 里 batch 1..N 依次在同一个容器同一棵树上
   跑;前面的批次可能改了树上的产物。只复现「那一批」仍然可能是绿的,要复现整段顺序。

顺带记住:批次组成不稳定意味着**同一个串扰 bug 会时红时绿**,而且「上一版验证过了」
不构成它已被修好的证据。

## 你会收到什么

修复票的正文里是**解析过的失败清单**,不是日志尾巴。自 2026-08-18 起这份清单是
**完整的**:红灯批次会把所有 Vitest 批次跑完再判失败。此前 job 在第一个失败批次
就中止,一次红灯只暴露最先失败的那一批——2026-08-17 连续九批红灯就这样把一个
架构预算失败藏到了最后。所以现在:如果清单里只有一个文件,那就真的只有一个文件;
不要再假设后面还藏着别的。

```
测试文件 7 失败 / 282 通过;用例 70 失败 / 3504 通过
解析出 12 条失败,分布在 3 个文件:

● packages/agent-view-react/src/workspace/WorkspaceShell.test.tsx (9 条)
  ↳ WorkspaceShell > ArrowLeft wraps to the last tab @483:36
     AssertionError: expected <span class="av-tab" /> to be <span class="av-tab" />
     同文件还有:ArrowRight 越界 / Home 回到首个 …

● packages/bot/src/session-plus/architecture-budget.test.ts
  ↳ keeps the runtime under 4000 lines @149:74
     AssertionError: expected 4544 to be less than or equal to 4000
```

生成它的是 `packages/bot/src/devpipe/ci-trace-digest.ts`。它替换掉的是
`trace.slice(-5_000)`:在触发这次改动的那批红灯里,那 5000 字节有 15% 是 ANSI
转义、27% 是 `2026-08-10T07:51:40.665385Z 01E ` 这样的逐行时间戳前缀、约 4% 是
有效信息,并且因为是**字节尾巴**而不是结构尾巴,70 条失败里只露出了 1 条。

摘要认不出结构时(基础设施故障、镜像拉取失败),你拿到的是**清洗过的**日志尾部,
标题会写「日志尾部(未识别出测试失败)」。这种情况通常不是你的代码问题,见下面
第 4 类。

## 先读三个数字,再读任何一行代码

1. **失败文件数**。1 个文件 = 1 次修复;5 个文件横跨 3 个包 = 先怀疑是一个共同
   成因(某个契约、某个 fixture、某个默认值变了),不要顺着清单一条条改。
2. **失败用例数 ÷ 失败文件数**。一个文件里挂 9 条,几乎一定是同一个成因;9 个
   文件各挂 1 条,才是九件事。
3. **通过数**。`282 通过 / 7 失败` 是局部回归;`3 通过 / 280 失败` 是套件根本没
   跑起来(见第 4 类),别去改断言。

## 五类成因,按出现频率

| 类别 | 长相 | 该做的事 |
|---|---|---|
| 断言漂移 | `expected "执行中…" ...` 之类,值只差装饰字符/空格/顺序 | 改断言去对齐**组件实际渲染的东西**,不要改组件去迁就断言 |
| fixture 漂移 | 失败集中在 `*.test.ts` 的构造数据上,常伴随某个默认值刚改过 | 找那次改默认值的提交,把 fixture 对齐它;通常一处改动能修掉整批 |
| 架构预算 | `architecture-budget.test.ts` 里 `expected 4544 to be less than or equal to 4000` | 这**不是**测试坏了。它在说某个模块超出了写死的行数上限。要么真的拆,要么在提交信息里说清为什么抬高上限 |
| 套件没起来 | 通过数极低;或摘要落到「未识别出测试失败」;或出现 `error TS****` | 编译/安装/环境问题。修构建,不要碰断言 |
| 基础设施 | `runner_system_failure`、镜像拉取失败、超时 | **不是测试失败**。流水线会把它记为 aborted;确认一下就说明情况,不要制造无意义 commit |

## 三个历史上真实踩过的坑

- **修一半就交。** 早期的修复票常常修掉清单里第一条就 submit,后续 CI 继续红,
  再拉起一个新 agent,历史被切得很碎。现在一次红灯给出全部解析错误;如果修复后
  的完整验证仍红,证据回到同一 session,失败文件清单取并集。动手前先数一遍,
  确认共同根因和全部影响,不要只修最先打印的一条。
- **修一个主线上已经修好的问题。** 一批 CI 钉的是某个**历史 sha**,而 `v4` 顶端
  可能早就往前走了。动手前先跑一次:

  ```bash
  git log --oneline <失败 sha>..v4        # 这中间有没有人已经修过
  git diff v4..HEAD                        # 你的 worktree 和当前主线差什么
  ```

  如果 `git diff v4..HEAD` 是空的、而失败断言在当前主线上已经改对了,那就是一批
  过期批次(stale batch)。**说明情况,不 submit。**
- **把整份日志读进上下文。** 摘要里的 GitLab job URL 永远保留着,原始日志一直
  在那儿。只有当摘要明确不够(例如你需要看某条用例的完整 diff)时才去开它,并且
  只开那**一个** job 的 trace。

## 本机复现的成本

这台开发机是 2 核 / 3.8 GB。默认并行度会把它撑爆,症状是一批 5 秒超时和
`TypeError: fetch failed`——那是资源饥饿,不是断言失败。所以:

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/<失败文件所在目录>
npx vitest run --project web --maxWorkers=1 packages/dashboard-web/src/<目录>
```

**只跑失败清单点名的那个目录。** 工单 agent 的默认约束是不在本机跑测试(见
`AGENTS.md`),CI 修复票是这条约束唯一被**反过来**写的通道(#219)——但也仅限于
跑摘要点名的那几个文件。落地门禁跑的就是这条命令的等价形式:

```bash
npx vitest run --maxWorkers=1 --no-file-parallelism <失败清单里的文件…>
```

不带 `--project`:根 `vitest.config.ts` 会按 include 规则把每个文件分给对的
project(node / web / 各 App),这也是 `.gitlab-ci.yml` 跑全量的写法,所以在这里
绿和在 CI 里绿是同一件事。

## 相关

- 完整测试矩阵与落地语义:`doc/runbooks/testing.md`
- 开发分支、worktree 与落地顺序:`doc/runbooks/development-workflow.md`
- 摘要生成器与其取舍:`packages/bot/src/devpipe/ci-trace-digest.ts`
