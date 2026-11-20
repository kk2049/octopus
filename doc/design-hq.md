# HQ:科研并行工作台设计(事件日志 + 投影 + 单一动作层)

> **历史文档。** 记录 2026-07 HQ 首轮纵切及未完成阶段，且混有已退役的浏览器实现；当前行为从 `packages/bot/src/hq/`、`packages/dashboard-web/src/pages/hq/` 及其最近包级文档进入。

> 状态:**阶段 1+2 已实现(2026-07-25)** —— 事件日志与投影(`packages/bot/src/hq/`)、
> ops 单一动作层、`/hq` 页面与 `/api/hq/*`、以及秘书的 `hq` MCP 工具全部上线。
> **未实现**:阶段 3 夜间流水线(含反重复的结构化 diff)、阶段 4 活层、阶段 5 dispatch 类 op。
> 实现与本文的偏差记在文末「实现记录」。设计撰于 2026-07-24。
> 需求源:用户同时推进多个科研项目(不同 target / ddl / 卡点),context switch
> 成本高。需要一个既是晨报、又是工作日志、又能看到 agent 在干什么、还能决定
> 下一步的东西。交互形态已通过样机迭代五轮定稿,见
> `doc/mockups/daily-brief/index.html`(静态样机,数据虚构,挂 :8920)。
> 本文只定义**背后是什么**:存什么、秘书分析到什么程度、按钮对应什么动作、
> 以及"人点按钮"与"跟秘书说话"如何是同一件事的两个面貌。


> **⚠ 2026-08-06（v4 Phase 1）起，本文的浏览器一侧已被取代。**
> 面板的全部浏览器代码现在是 `packages/dashboard-web` 的 React 单包，本文提到的
> `hq-page.ts` 等模板字符串渲染器已删除。**服务端契约（API、SSE 协议、授权、投递语义）不变**，
> 所以本文关于「服务端要保证什么」的部分仍然有效；关于「页面怎么拼出来」的部分请读
> `doc/adr/0003-dashboard-react-frontend.md` 与 `packages/dashboard-web/CLAUDE.md`。

---

## 需求与非目标

**需求**

- 每个项目有一份"恢复包":切回来时 2 分钟内重建心智模型,而不是翻日志
- 全局视图只回答一个问题——**现在该把注意力放在哪**;其余项目折叠成心跳
- 内容必须是 agent 工作流的**副产品**:人只消费和纠正,不生产。需要人维护的
  系统会在人最忙时最先崩溃
- 页面上每一条论断可溯源到具体会话;压缩失真可当场纠正
- **一体两面**:人在页面上能做的每件事,秘书在对话里也能做,反之亦然

**非目标**

- 不做团队协作/多人共享看板(单人视角;人的协作走飞书)
- 不做甘特图、工时统计、燃尽图这类项目管理度量
- 不追实时。文字层每晚一次即可;活层秒级~分钟级足够(见「两层更新频率」)
- 不替代 transcript viewer:本系统只做**压缩视图**,原始会话仍归 viewer

---

## 核心决策一:事件日志 + 投影,而不是可变状态文件

早期设想是每项目一份 `state.md`,夜间 agent 改写它。**放弃**,理由:

1. 可变状态文件的每次覆写都在销毁信息。「合作者从 Chen 换成小李」若直接改
   字段,"曾经是 Chen"这个事实连同它引出的分工决策一起消失;
2. agent 压缩会出错。错误覆写进状态文件后,后续所有摘要在错误地基上累积,
   且无法区分"agent 推断的"与"人确认的";
3. 当前段("最后一段没闭环的东西")本质是**集合运算**的结果,不是一段文字。
   用文字存它,就必须靠 LLM 每晚重新总结,于是每晚都有重新出错的机会。

改为:**每项目一条 append-only 事件日志(`timeline.jsonl`),页面是它的投影。**

- 过去 = 上一次 `segment_close` 之前的定点事件
- 现在 = 最后一次 `segment_close` 之后,尚未被 resolve 引用的 open item 集合
- 未来 = `plan_set` 减去 `plan_drop` 的当前状态
- 事实(ddl/人/目标)= 各 key 的最后一次 `fact_set`/`correction`

**投影是纯函数**:`fold(timeline.jsonl) → view`。`.cache/` 随时可删可重建,
投影逻辑写错也不毁数据。这一条是整个设计的安全底座。

**为什么不用 SQLite**:hq 要能 `cat`、能 git diff、能在 CLI 里直接看和改
(用户明确要求 CLI 亲和)。JSONL 的追加在 git 里是干净的单行 diff;表结构的
迁移成本也不必背。bot.db 仍存索引/缓存类数据,但**不是真相**。

**为什么不是纯 markdown**:事件需要稳定 id、机器可读的引用关系
(`resolve.ref → item.id`)。markdown 做这个必然长出脆弱的解析约定。折中是
分层:**结构化的进 jsonl,叙述性的进 markdown**(见「文字层」)。

---

## 核心决策二:三类数据,三种纪律

"秘书要分析到什么程度"的答案在这张表里。

| 类别 | 谁产出 | 例子 | 存放 | 出错代价 |
|---|---|---|---|---|
| **观测** | 确定性代码,零 LLM | commit hash、会话时间/设备/轮数、"已跑 6 小时"、"停滞 3 天"、ddl 倒数、测试通过数 | 不存,随时算 | 无(可复算) |
| **断言** | 需归属与确认 | 决策、里程碑、ddl、人、"agent 称已完成" | `timeline.jsonl`,**永久** | 高(污染永久) |
| **推断** | LLM 自由发挥 | 晨报散文、"周日压力反超"、建议 | `prose/`,**可丢弃** | 低(重生成即可) |

**页面上大部分"丰富"来自第一类,不需要 LLM。** 真正需要模型的只有两件事:

1. **会话收尾分类**(窄任务,便宜可验证):把每场会话的结尾归为
   `claims_done` / `abandoned` / `asking_user` / `running`。这是"待验收"和
   "进行中"两格的来源;
2. **决策抽取**(危险任务):从对话里认出"这里做了一个决定"。

### 纪律:越永久,越需要确认

| 产物 | 谁能直接写 | 理由 |
|---|---|---|
| prose | agent 直接写 | 每晚重生成,错了自愈 |
| open item | agent 直接写 | 会被闭环消解,生命周期短 |
| **timeline 定点** | 仅两种情况自动入库 | 永久,不可自愈 |

timeline 自动入库的两种情况:**(a)** 人在会话里明确表态("就用 256 吧"/
"这个方案不要了"),模型只做抽取不做推断;**(b)** `segment_close` 归档时,
把该段的交付固化成一个定点。其余一律作为 open item 排在当前段里,等人确认
或自然消解。

**预期校准(重要)**:样机展示的是用了几周之后的成熟形态。第一天的 timeline
会很稀疏、字段大量缺失——**缺就不渲染,绝不编**。丰富度靠人在右栏对话时
逐步长出来。一条真决策胜过二十条半幻觉。

---

## 目录布局

落在**每用户私有记忆目录**下(`User.memoryDir`,已由 `session/path-jail.ts`
做 realpath jail、`plugins/machines` 提供无 shell 的读写工具),天然多用户隔离,
不需要新的隔离机制。

```
<memoryDir>/hq/                     ← 一个 git 仓库
  GOALS.md                          人写:长期目标、项目优先级。agent 只读
  inbox.md                          跨项目待办;agent 追加提议,人处理完删行
  projects/<slug>/
    project.yaml                    人写/低频:一句话、主攻、people、sources
    timeline.jsonl                  ← 唯一真相,append-only
    prose/current.md                当前段的叙述(可重生成,带 provenance)
  daily/2026-07-24.md               晨报(生成物)
  .cache/                           投影结果 + 扫描游标。**可随时删**,不入 git
    projection/<slug>.json
    cursor.json
```

`project.yaml`:

```yaml
slug: diffusion-ablation
one_line: 做扩散模型结构消融的系统研究,目标 ICML'27 投稿。
focus: 搞清楚哪些结构组件真正贡献了性能。
kind: ICML 投稿
people: [self, chen]
sources:                    # 决定哪些会话算这个项目 —— 规则匹配,不用 LLM
  - { device: mbp-office, cwd_prefix: ~/work/diffusion-ablation }
  - { device: aws-dev,    cwd_prefix: ~/work/diffusion-ablation }
  - { repo: git@github.com:me/diffusion-ablation.git }
```

`people` 里的标识指向 bot 已有的用户/联系人记录,飞书 `open_id` 从那里取
(见「飞书」节),**不在 hq 里重复存身份信息**。

---

## 事件 schema

每行一个 JSON 对象。公共字段:

| 字段 | 说明 |
|---|---|
| `id` | 单调递增可排序 id(ULID)。被 `ref` 引用 |
| `t` | 事件类型 |
| `at` | ISO 时间戳 |
| `by` | `human` / `agent:<sessionId>` / `pipeline:<runId>` —— **归属必填** |
| `evidence` | 可选,证据引用数组:`sess:<device>/<source>/<id>#<turn>` 或 `archive:<snapshotId>` |
| `conf` | 可选,模型置信度(仅 agent 产出时) |

### 类型

```jsonc
// 定点:决策
{"t":"decision","text":"batch size 固定 256,不再扫参",
 "why":"显存打满时 256 是最大稳定值;扫参边际收益低于 ddl 压力",
 "data":"exp-037~040 四组对比,256 与 512 相差 0.3 点",
 "commit":"a91c3f2"}

// 定点:里程碑
{"t":"milestone","text":"基线复现达标(acc 71.3)","data":"三次重跑 71.1/71.3/71.4"}

// 事实(notable 的 key 同时是定点:ddl / people)
{"t":"fact_set","key":"ddl","value":"08-03","prev":"08-01","reason":"用户在对话中告知,未说明原因"}

// 当前段的条目
{"t":"item_open","bucket":"block","text":"eval split 12 条 md5 命中训练集",
 "meta":"需要裁决处理方式,agent 无法自行决定",
 "decision":{"opts":[{"t":"回滚数据管线,重建 split","d":"约两天","rec":true},
                     {"t":"仅去重后继续","d":"半天"}],
             "why":"agent 倾向前者:ddl 还有 5 天,两天成本吃得下"}}
{"t":"item_open","bucket":"verify","text":"gym wrapper 测试 8/10 通过",
 "meta":"agent 称完成 · 剩 2 个 flaky 它认为与代码无关"}

// 条目消解
{"t":"item_resolve","ref":"<item id>","outcome":"verified|rejected|done|dropped","reason":"…"}
// 裁决
{"t":"choice_made","ref":"<item id>","choice":0,"rationale":"…"}
// 归档:当前段并入时间线
{"t":"segment_close","summary":"环境交付,测试全绿","includes":["<item ids>"]}
// 未来
{"t":"plan_set","slot":"p1","kind":"act|ddl","text":"重跑受影响的 6 组实验",
 "why":"若选回滚,exp-038 之前的结论全部需重跑","dep":"取决于裁决结果","when":"+2天"}
{"t":"plan_drop","ref":"p1"}
// 更正:永不改写原事件
{"t":"correction","ref":"<event id>","field":"data","value":"acc 71.3 → 69.8",
 "reason":"读错了 eval.log 的列,第 3 列是 EMA 权重"}
// 派发(有外部副作用的动作,留痕)
{"t":"dispatch","kind":"investigate|delegate|message","target":"…","payload":"…","result":"<ref>"}
```

`bucket` 四值,对应样机当前段的四格:
`block`(卡住·等你)/ `run`(进行中)/ `verify`(agent 称已完成,待验收)/ `todo`(还没开始)。

**`verify` 这一格是本设计的关键**:它把"agent 说做完了"与"真的做完了"分成两个
状态。无人值守的 agent 工作恰恰在这里出错;不给它一个显式状态,人就只能靠记忆
盯着。

---

## 投影规则

```
fold(events) →
  facts:   各 key 的最后一次 fact_set/correction
  past:    最后一个 segment_close(含)之前的 decision | milestone |
           fact_set(key ∈ notable) | segment_close,按 at 升序
  open:    最后一个 segment_close 之后的 item_open,
           排除被 item_resolve.ref 命中的;按 bucket 分组
  future:  plan_set 减去 plan_drop,按 when 排序
  corrections: 按 ref 索引,渲染时叠加到目标事件上(原文保留,标注"已更正")
```

`segment_close` 之后立即开启新的一段;归档时仍未 resolve 的 item **不丢弃**,
由 ops 层复制成新段的 `item_open`(带 `carried_from` 指回原 id),保证
"未闭环的东西不会因为归档而蒸发"。

---

## ops 层:一体两面的实现点

**不做两条写入路径。** 定义一组 operation,Web UI 与秘书 agent 都是它的客户端:

```
   Web UI 按钮 ──POST /api/hq/<op>──┐
                                     ├─► ops(schema 校验 → 权限 → 幂等/去重 →
   秘书 agent ──MCP tool call───────┘         追加事件 → 失效投影缓存 → 审计)
                                                          ↓
                                                   timeline.jsonl
```

于是"agent 能做的 = 人能做的"是**结构性保证**,而不是两边分别实现再祈祷一致。
"跟秘书说句话,它自动找到对应工具"就是普通的 tool use——这个模式在本仓库已经
跑通五个 MCP 插件(`delegate` / `board` / `sessions` / `machines` /
`project-creator`),新增一个 `plugins/hq` 即可。

### op 清单

**record —— 只追加事件。瞬时、免费、可逆(追加补偿事件)。**

| op | UI 入口 | 事件 |
|---|---|---|
| `hq_note_decision` | (对话为主) | `decision` |
| `hq_note_milestone` | (对话为主) | `milestone` |
| `hq_set_fact` | recap 行内编辑 | `fact_set` |
| `hq_add_item` | 当前段「+」 | `item_open` |
| `hq_update_item` | 条目行内编辑 | `correction`(ref → item) |
| `hq_resolve_item` | 「我验收了」/「不对,退回」 | `item_resolve` |
| `hq_record_choice` | 「选第一条」 | `choice_made` + 后继 `item_open(todo)` |
| `hq_close_segment` | 「这段闭环了·归档」 | `segment_close` + 结转未闭环项 |
| `hq_plan_set` / `hq_plan_drop` | 未来项编辑 | `plan_set` / `plan_drop` |
| `hq_correct` | 任意条目的「改一下」 | `correction` |
| `hq_write_prose` | 左栏直接改简报 | 写 `prose/`(见下节) |

**dispatch —— 真的会发生事情。花钱、动外部世界、需二次确认。**

| op | UI 入口 | 动作 |
|---|---|---|
| `hq_dispatch_investigation` | 「让 agent 再查查」 | 起 headless 会话调查,复用 `/api/sessions/append` 那条链路(在**设备主人自己的机器**上花他自己的额度) |
| `hq_delegate_task` | 「交给 agent 做」 | 走既有 `router/delegate.ts` 审批队列 |
| `hq_send_message` | 「让秘书催一下」 | 经飞书发给活人 —— **不可撤回** |

**read**

`hq_read_state`(投影)、`hq_read_timeline`(原始事件,带分页)、
`hq_read_prose`。会话搜索复用既有 `plugins/sessions`。

### UI 上两类动作必须长得不一样

record 类按钮点了就生效、可撤销;dispatch 类必须带确认,并在确认框里写清代价
("会在 aws-dev 上起一个 Claude Code 会话,消耗该设备主人的额度" /
"会以 bot 身份把这条消息发给 Prof. Chen,发出后无法撤回")。这条纪律与既有
delegate 审批卡片同源,不新建概念。

### 权限

- HTTP 侧走 dashboard 既有双层身份:每用户 `dt_` 密钥只能操作自己的 hq;
- MCP 侧的工具在 Router 注入时绑定已解析的 `User`,hq 根目录**永远来自
  resolved User,不从参数取**(与 `MACHINES_MEMORY_DIR` 同一模式);
- 管理密钥:**可读不可写**。与既有裁决一致(全量视角只读;写入/append 严格限本人)。

---

## 反重复:靠操作形状,不靠检查器

这类系统头号死因是**条目跨夜复读**:今晚生成"缺 3 篇文献",明晚再生成一条几乎
一样的,一周后当前段堆了 20 条重复,人就不看了。

早期方案是在 ops 层做文本相似度闸(命中即拒绝创建)。**放弃**——阈值要调、
既有误伤又有漏网,复杂度买不到可靠性。

正确的做法是**让 reconcile 这一步的操作形状表达不出"盲目追加"**:

夜间流水线的 reconcile 阶段拿到的不是一张白纸,而是**当前段的全部 open item
(带 id)**;它必须返回一份**针对已知集合的结构化 diff**:

```jsonc
{ "existing": [ {"id":"i7","action":"keep"},
                {"id":"i8","action":"update","meta":"测试已 10/10"},
                {"id":"i9","action":"propose_resolve","outcome":"done","why":"…"} ],
  "new":      [ {"bucket":"block","text":"…","why_not_existing":"与 i7 不同点在于…"} ] }
```

每个已有条目都必须被显式处置,新增项必须说明"为什么不是已有的某一条"。于是
重复不是被检查器拦下来的,而是**没有产生它的操作路径**。这既比相似度匹配简单,
也比"在 prompt 里嘱咐它别重复"可靠。

配套两点:

- **保留一个零成本兜底**:规范化文本完全相同则直接合并(去空白/标点后比对)。
  没有阈值、没有误伤,几行代码;
- **交互路径不受此约束**:人在对话里让秘书 `hq_add_item` 时,人就在回路里,
  不需要任何闸。**这道约束属于夜间流水线阶段,不属于 ops 层**——ops 保持薄。

---

## 文字层:provenance 与"不许覆盖人写的"

`prose/current.md` 用块标记:

```markdown
<!-- hq:block id=b3 by=agent at=2026-07-24T02:31 -->
消融 exp-041~043 跑完,验证集 acc 71.3 → 69.2;查 eval split 发现 12 条与训练集重复。
<!-- /hq:block -->
```

- 人在左栏改了某块 → 该块 `by` 变 `human`,其内容此后**只有人能改**
- **夜间重生成永不覆盖 `by=human` 的块**。这条不做,人手改两次之后就再也不信
  这个页面了
- 但 agent **可以在人写的块旁边挂东西**:追加带 `attached_to=<块 id>` 的
  附注块,渲染时紧贴目标块显示(缩进/竖线),`kind` 三种:

  | kind | 用途 |
  |---|---|
  | `supplement` | 补充人没写到的新观测("此后 exp-044 也复现了这个现象") |
  | `dissent` | 与人写的内容矛盾("我的观察与上面不同:…") |
  | `stale` | 提示已过时("这段写于 07-21,其后 ddl 已改为 08-03") |

  附注块随时可被人一键采纳(并入人写的块)或删除;人删附注不影响 timeline 事件。
  这样"人写的不被动"和"agent 有话能说"两件事都成立

---

## 夜间流水线

`cron` 每晚一次 + 页面上「重新消化」手动触发,两者同一条代码路径。

| 阶段 | 做什么 | 用不用 LLM |
|---|---|---|
| **collect** | 按 `cursor.json` 取自上次以来 mtime 变过的会话。数据源与 transcript viewer 相同:在线 Runner ∪ bot 主机 scan home | 否 |
| **attribute** | 会话 → 项目。按 `project.yaml.sources` 的 cwd 前缀 / repo 规则匹配;匹配不上的进「未归属」桶等人认领 | 否 |
| **classify** | 每场会话收尾归类:`claims_done`/`abandoned`/`asking_user`/`running` | 窄 LLM |
| **reconcile** | 先 `hq_read_state`,再决定:更新已有 item / 提议 resolve / 新增(受反重复闸约束) | LLM,但受闸 |
| **record** | 调 ops 追加事件。仅明确表态与归档进 timeline 定点 | — |
| **prose** | 生成当前段叙述与 `daily/<date>.md`;每条论断必须带 evidence 引用 | 自由 LLM |
| **deliver** | `git commit`(一次运行 = 一个 commit)+ 自动 `push`(失败不阻断);飞书推晨报卡片 | 否 |

**离线设备的诚实记账**:笔记本夜间常关机。白天 Runner 在线时把会话增量镜像到
bot 主机(复用 archive 的落盘路径);夜间用镜像。对昨夜始终离线且镜像过期的设备,
晨报明确标注「X 未纳入(最后镜像 07-23 19:40)」,**不假装全量**。

**成本**:靠 mtime 增量 + summary cache(既有)封顶;全量重扫仅在手动触发时发生。

---

## 两层更新频率:活层 vs 文字层

用户明确要求这一页**全天挂着**。而每晚生成一次的页面到下午三点就是过期报纸,
这是该形态最可能的死法。故分两层:

| 层 | 内容 | 频率 | 成本 |
|---|---|---|---|
| **活层** | 哪个 agent 正在跑、自上次看过之后哪些项目有新会话、item 计数、ddl 倒数 | 分钟级轮询(或复用 live-view 的 SSE) | 零 LLM,只读 mtime + runner 状态 |
| **文字层** | 叙述、判断、建议 | 每晚一次 + 手动 | LLM |

页面顶部的「自你 09:12 看过之后…」band 属于活层;正文属于文字层,并明确标注
"文字消化仍是昨夜 02:30 的版本"。样机的「时间旅行」开关就是在演示这个分层。

---

## 页面形态(已定稿,详见样机;实际实现为四栏,见「布局修订」)

三栏:**左栏导航 + 活层 | 中栏内容 | 右栏秘书对话**。

- 左栏一级 = 今日简报 + 项目列表(按"要你介入 / 自行推进"分组);
  二级 = 选中项目的**线性时间线**(过去在上、现在居中、未来在下),
  作为节点导航。展开更早历史时,更早的条目从上方长出,整体下移,线不断
- 中栏渲染被选中的节点:默认落在**当前段**;过去节点显示
  为什么/依据/何时(深链会话)/提交;未来节点显示为什么/前置/时间
- 右栏秘书:**开场即自曝低置信推断**(如"acc 我从 eval.log 第 3 列读的,
  如果那列不是验证集这个数就是错的"),把纠错从"人想起来才做"变成
  "它主动请求"。每次写入给回执(写了哪个文件几处 + 撤销)

---

## 与既有系统的复用

新造的只有:事件模型 + 投影 + ops 层 + `plugins/hq` + 夜间 reconcile + 页面路由。
以下全部复用:

| 能力 | 既有实现 |
|---|---|
| 会话扫描/解析(双源、缓存) | `plugins/sessions` 的 scan 层、dashboard `/api/sessions*` |
| 证据快照(防原文漂移) | `runner/archive.ts` + migration v8 |
| 起 headless 会话 | `/api/sessions/append` + `packages/runner/src/machine.ts` |
| 委派审批 | `router/delegate.ts` |
| 页面壳层/导航/身份 chip | `dashboard/shell.ts` |
| 双层身份与 cookie 登录 | `dashboard/server.ts` + migration v12 |
| 飞书发送与卡片 | `channel/feishu.ts` + `feishu-card.ts` |
| 路径隔离 | `session/path-jail.ts` |
| 私有目录与无 shell 读写 | `plugins/machines` + `User.memoryDir` |
| 定期任务/清理 | `maintenance/gc.ts` 的调度模式 |

**飞书快速联系**:bot 在身份绑定时已存 `open_id`,正是 AppLink 深链
(`applink.feishu.cn/client/chat/open?openId=…`)所需,无需新增数据。两条路
并存:人名 chip 直接打开飞书会话;「让秘书催一下」由秘书拟稿 →
`hq_send_message` 以 bot 身份发出(需确认)。后者更重要——常见场景不必离开页面。

---

## 风险与未决

1. **决策抽取质量**(最大风险):timeline 永久,抽错永久。缓解=「越永久越需要
   确认」纪律 + 稀疏优于丰富 + `correction` 永远可追加。**接受 timeline 在
   头几周很空。**
2. **条目跨夜复读**:靠 reconcile 的结构化 diff 形状消除(每个已有条目必须
   显式处置,新增须说明为何不是已有的某条)+ 完全同文兜底合并。若实测仍有
   复读,下一步是给 item 加语义 key(如 `bucket + 归一化主语`)由人确认一次,
   而**不是**回到相似度阈值那条路。
3. **归属规则的长尾**:同一 cwd 下做两个项目、或临时目录里干活。先接受
   「未归属」桶 + 人工认领,不追求全自动。
4. **人手改与重生成的冲突**:块级 provenance 解决;但块的粒度定义还需实做时敲定
   (段落级最可行)。
5. **投影性能**:单项目事件量级预计每周几十条,fold 全量即可;若某项目破万条
   再引入 `segment_close` 处的快照(把之前折叠成一个基线对象)。
6. **git 自动 push:已定为开启**(2026-07-24 用户拍板)。每次夜间运行
   `commit` 后自动 push 到配置的 remote;手动触发同理。含义已知悉:科研笔记与
   决策记录会离开本机,remote 的可见性由用户自己选(建议私有仓库)。
   push 失败**不阻断**流水线,只在晨报页脚记一行"未同步",下次成功即消。

---

## 实现顺序建议(每期可独立验收)

1. **骨架**:目录 + 事件 schema + 投影函数 + `hq_read_state`。用手写的
   `timeline.jsonl` 喂样机页面,先把渲染跑通(此时零 LLM)
2. **ops + 插件**:record 类 op 全套 + `plugins/hq` + `/api/hq/*`。此时人已经
   可以用页面按钮和对话把 hq 维护起来——**即便夜间流水线还没有**
3. **夜间流水线**:collect/attribute/classify/reconcile/prose/deliver + cron
4. **活层**:轮询或 SSE、"自上次看过之后"、离线设备记账
5. **dispatch 类 op**:调查/委派/飞书发送,各带确认

第 2 期结束时系统已经可用(人肉驱动),第 3 期才让它自动长内容。这个顺序保证
"agent 写错了人能修"这条路径**先于** agent 开始写而存在。


---

## 实现记录(2026-07-25)

阶段 1+2 落地时与上文的偏差,均为实现中发现的更优解:

- **`correction` 携带 patch 对象而非单个 field/value**。一句「这条改一下」常常同时动
  `context` 与 `next_action`,拆成两个事件会让一次人类修改读起来像两次改动。
- **ops 全部 `async`**,包括纯同步校验的那些。调用方(HTTP handler、MCP dispatch)因此
  只有一条错误路径,不会出现「本该是 rejection 却抛了异常」。
- **MCP 服务端住在 `packages/bot/src/hq/mcp-server.ts`,不是 `plugins/hq/`**。放进独立包就
  必须二选一:复制一份写入逻辑,或者加一跳 HTTP 与一套自己的令牌。留在包内直接 import
  `ops.ts`,「单一动作层」才是字面意义上的单一。工具表与分发拆到 `mcp-tools.ts`,好让
  「工具调用与按钮落到同一份日志」这条性质**能被单测钉住**,而不必起子进程。
- **MCP 事件的作者是 `agent:secretary/<user>`,不是 `agent:<sessionId>`**。插件在 session
  创建之前就要配好,那时拿不到 id;事件真正需要记住的是「这是谁的秘书写的」。
- **`?username=` 会被鉴权而不是被忽略**。原先对 `dt_` 密钥直接忽略该参数,结果是调用方
  以为读到了别人的数据、实际拿到自己的;现在显式 403。
- **管理密钥对工作台只读**(设计文档已写,此处确认实现):transcript viewer 的全量视角是
  「看」,而事件带作者,管理员代写等于伪造署名。
- **`HqContext.at` 支持回填**(实现时补的)。冷启动导入一段已经发生过的历史时,若全部
  盖上导入当天的时间戳,时间线就在撒谎;`at` 让 op 按事件真实发生的日期落库,并且
  事件 id 也随之取该时刻,免得同日内的 tie-break 反向。**只给导入用**——能自选时间戳
  的作者就能改写顺序,所以它不从任何请求参数取值。配套的 `scripts/hq-import.ts` 把
  离线分析产物(见 `doc/experiments/hq-codex-trial/`)按原始日期导入,并把「证据不足」
  与「我不确定」两类内容只写进 prose(可丢弃层),不让未证实的断言变成永久定点。
- **反重复闸暂无代码**。它属于阶段 3 的 reconcile;当前唯一的写入者是人与对话中的秘书,
  两者都在回路里。上线阶段 3 前必须补上,否则夜间复读会立刻把当前段淹掉。

---

## 布局修订与常驻秘书(2026-07-25,工单#7)

阶段 1 把时间线塞进了左栏项目列表下方的折叠区。用起来发现两件事同时被牺牲了:
项目列表不再是「一眼看清全部战线」的那一列(每个项目只剩一个名字),时间线也没有
自己的地方。于是拆成四栏,每一栏只回答一个问题:

| 栏 | 宽度 | 回答的问题 |
|----|------|-----------|
| 项目 | 246px | 我手上有哪些事,各自多急(名字 + 一句话 + ddl + 未闭环数) |
| 时间线 | 186px | 这个项目**过去/今天/未来**分别发生了什么 |
| 正文 | 自适应 | 选中的那个节点具体是什么 |
| 秘书 | 344px | 「帮我改一下」——常驻,不用切页面 |

时间线**比项目列窄**是刻意的:它是一根脊柱,不是文档。

### 三时态的切分规则

`splitTense(projection, today)`(`hq/projection.ts`,纯函数,服务端算):

- **今天** = 今天记下的定点 + 当前段 + **已到期/逾期的计划**。逾期的 ddl 不是「未来的
  打算」,它就杵在今天面前;
- **未来** = 还没到的计划,以及 `when` 写成散文(「本周末」)的那些——**不给它们编一个
  日期**,时间线上的精度必须是真的;
- **过去** = 今天之前的定点。时钟超前的事件宁可显示在今天,也不许消失:切分不得丢节点。

按 bot 主机的**本地日**切,不按 UTC——这条线是给人看的,UTC 边界会让东八区的傍晚
提前变成「明天」。切分放在服务端而不是页面 JS,是为了让它可被单测钉住,并且「今天
是哪天」只有一个定义处。

### 常驻秘书(`hq/chat.ts`)

**它就是第四个面**:工具是 `mcp-tools.ts` 的同一张表,**进程内 dispatch**,写入照样只走
`ops.ts`。不起 MCP 子进程——那会多出一份 schema 与一处校验漂移。作者署名
`agent:hq-chat/<user>`,与飞书秘书的 `agent:secretary/<user>` 区分得开。

给它**全量写权限**是有意的(用户原话:「让我可以通过和他聊天,调整整个工作台里面的
所有东西」)。安全性不来自更窄的工具集,而来自日志本身:每次写入都是一条署名的追加
事件,错了看得见、可追加更正,而不是悄悄改掉。

几个实现取舍:

- **模型独立配置**(`hq.chat_model`,默认 `gpt-5.6-sol` + `reasoning_effort=high`)。它要
  端着整个科研组合并被要求改写它,和聊天机器人不是一个活。没配 `openai.api_key` 时
  秘书自动禁用,工作台其余部分照常;
- **轮次发射即返回,transcript 落 SQLite**。高思考 + 工具循环的一轮经常比任何反代的
  耐心都长;而工作台的承诺是「关掉页面不丢东西」。`hq_chats.running_since` 是「正在跑」
  的唯一真相,重启即清(没有轮次能活过重启),页面 1.5s 轮询;
- **`UPDATE ... WHERE running_since IS NULL` 就是防重**:双击不会花掉两轮;
- **不落 hq 目录**:`ops.commit()` 是 `git add -A`,聊天记录放进去会被逐条提交进研究
  历史仓库。闲聊不是研究史;
- **历史重放把工具活动压成一句 assistant 备注**,不重放严格的 tool_call 协议——重启后的
  进程手里没有那些 tool_call 的结果,喂回半截协议只会让模型困惑;
- **管理密钥可读不可发言**,与工作台其余写入同一条规矩。

### markdown

正文原本是 `escape + white-space:pre-wrap`,秘书写的 `## 标题`、`- 列表` 全以原始符号
显示——这是工单#7 报的「渲染有问题」。修法是把 transcript viewer 已有的 markdown-lite
抽成 `dashboard/md-lite.ts`(CSS + JS 两个字符串,页面自包含的惯例不变),补上列表/引用/
链接/分割线,`/hq`、`/sessions`、`/tickets` 共用同一个实现。转义仍在插入标记之前发生。
