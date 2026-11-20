# Organizational knowledge retrieval journeys

This reviewed fixture is the authority for retrieval evaluation. Each qrel is graded only against records returned by the unified query path; a node that merely exists in the graph does not count. J025–J030 are individual hard gates.

```octopus-journeys
{
  "schema_version": 1,
  "targets": {
    "recall_at_10": 0.85,
    "ndcg_at_10": 0.85,
    "mrr": 0.7,
    "forbidden_at_10": 0,
    "judged_noise_at_10": 0.2
  },
  "journeys": [
    {
      "id": "J001",
      "class": "architecture",
      "title": "手机端从 chat 页面点导航却跳到了文件面板，这个需求触碰哪些能力与原则？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J001.1",
          "query": {
            "code_index": "none",
            "text": "修正手机端会话导航与文件页返回入口\n手机端的 session➕ui 跳转有问题，有文件打开时，如果从 chat 页面点导航，没有跳转到导航，而是跳转到了文件。另外文件页面顶部画蛇添足，在导航左边多了一个返回会话的按钮。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "sessions-plus.mobile",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "capability",
              "value": "sessions-plus.files",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": ".claude/rules/frontend-stability.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "stable semantic identity",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "手机端跨界面交互",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J002",
      "class": "architecture",
      "title": "手机网络上聊天里的文件链接点开失败，该先核对哪条纪律？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J002.1",
          "query": {
            "code_index": "none",
            "text": "Session Plus 聊天文件链接解析\n审查一下 sessionsplus 关于从聊天里面识别文件，然后点击之后替我打开的管线，我在手机操作，被告知任务失败不能打开，尽管超链接存在"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "sessions-plus.files",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": "packages/agent-sessions-view/CLAUDE.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "directoryKey",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "可见文件链接不等于端到端可打开",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J003",
      "class": "architecture",
      "title": "工单系统的 CI 始终修不对，这是什么类型的问题，历史上怎么定的？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J003.1",
          "query": {
            "code_index": "none",
            "text": "解决工单系统ci始终修复不对的问题\n这不正常，理论上来说ci修对一次之后就应该绿了，还是测不过，继续修。我觉得这明显不对，ci agent 应该在 lht-val15 上一个 session 修到绿。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "devpipe.ci",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": ".claude/rules/devpipe-and-ops.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "roster",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "post-submit",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J004",
      "class": "architecture",
      "title": "只改了一个 App 的源码，发布时是否应该触发全局重建？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J004.1",
          "query": {
            "code_index": "none",
            "text": "App 热发布与待发布债务\n只有 App 待发布时不再触发全局重建；chat-ui-commons 变化时要为 Session Plus 记录待发布债务，不能静默漂移。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "app-release",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "App release 影响集",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "待发布",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J005",
      "class": "architecture",
      "title": "给 Runner 加一个公开 URL 校验，要先知道哪些放置与信任裁决？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J005.1",
          "query": {
            "code_index": "none",
            "text": "Runner 公开 URL 强制 wss 校验\nRunner 注册时公开 URL 必须是 wss，运行机与执行机的分离不能因为这个校验被绕过。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "runner.placement",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": "doc/adr/0009-runner-placement-and-session-mcp.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "运行机",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J006",
      "class": "architecture",
      "title": "优化审批默认权限与通过交互时，哪些机械约束不能碰？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J006.1",
          "query": {
            "code_index": "none",
            "text": "优化审批系统的默认权限和权限通过交互\n审批系统的默认权限太严，权限通过的交互也不顺，优化一下。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "dashboard.identity-access",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "AUTH-001",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "AUTH-002",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J007",
      "class": "architecture",
      "title": "增加一个打断 agent 的按钮，要区分哪些 provider 语义？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J007.1",
          "query": {
            "code_index": "none",
            "text": "增加打断 agent 的按钮\n工单 Agent chat 和 Session+ 都要能中断正在运行的 agent，但 hosted 的 agent 和终端里的其实有很大区别，stop 必须可恢复、不能毁掉 CLI。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "sessions-plus.agent-lifecycle",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "Provider 与接入模式",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J008",
      "class": "architecture",
      "title": "修飞书功能前应读哪条路径规则？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J008.1",
          "query": {
            "code_index": "none",
            "text": "检查并且修正整个飞书功能\n飞书卡片和消息通道最近有问题，全面检查修正。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "feishu",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": ".claude/rules/feishu.md",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J009",
      "class": "decision",
      "title": "改 file-link.ts 之前，当时为什么把链接解析改成有序候选、又为什么搬到可信侧？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J009.1",
          "query": {
            "code_index": "none",
            "text": "改 file-link.ts 之前，当时为什么把链接解析改成有序候选、又为什么搬到可信侧？",
            "paths": [
              "packages/agent-sessions-view/src/lib/file-link.ts"
            ]
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": "packages/agent-sessions-view/CLAUDE.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "有序候选",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "可信侧",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J010",
      "class": "decision",
      "title": "ADR 0005（后端组合子）是现行裁决吗？实现了吗？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J010.1",
          "query": {
            "code_index": "none",
            "text": "ADR 0005 后端组合是可信组合根里的组合子 是否已经实现"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "decision:adr:0005",
              "relevance": 3,
              "max_rank": 10
            },
            {
              "match": "field",
              "value": "decision:adr:0005",
              "field": "status",
              "expected": "active",
              "relevance": 3,
              "max_rank": 10
            },
            {
              "match": "field",
              "value": "decision:adr:0005",
              "field": "realization",
              "expected": "planned",
              "relevance": 3,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J011",
      "class": "decision",
      "title": "octopus-convergence-line 是现行裁决还是提案？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J011.1",
          "query": {
            "code_index": "none",
            "text": "Octopus 收敛 留 让 线 convergence line 是否现行"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "decision:adr:2026-08-15-octopus-convergence-line",
              "relevance": 3,
              "max_rank": 10
            },
            {
              "match": "field",
              "value": "decision:adr:2026-08-15-octopus-convergence-line",
              "field": "status",
              "expected": "proposed",
              "relevance": 3,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J012",
      "class": "decision",
      "title": "改 land-gate.ts 要遵守哪些现行纪律、最近落地改了什么？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J012.1",
          "query": {
            "code_index": "none",
            "text": "改 land-gate.ts 要遵守哪些现行纪律、最近落地改了什么？",
            "paths": [
              "packages/bot/src/devpipe/land-gate.ts"
            ]
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": ".claude/rules/devpipe-and-ops.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": "2026-08-21-knowledge-retrieval-stopgap.json",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "merge --ff-only",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J013",
      "class": "decision",
      "title": "Session Plus 的实例过期后为什么不再自动刷新文档？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J013.1",
          "query": {
            "code_index": "none",
            "text": "Session Plus stale instance 过期 自动刷新 文档 reload"
          },
          "qrels": [
            {
              "match": "text_contains",
              "value": "explicit reload",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J014",
      "class": "decision",
      "title": "改 TicketsPage.tsx 前要检查哪些稳定性原则与复发模式？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J014.1",
          "query": {
            "code_index": "none",
            "text": "改 TicketsPage.tsx 前要检查哪些稳定性原则与复发模式？",
            "paths": [
              "packages/dashboard-web/src/pages/TicketsPage.tsx"
            ]
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": ".claude/rules/frontend-stability.md",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "generation/abort guard",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "异步刷新会覆盖当前身份",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J015",
      "class": "code",
      "title": "收藏的会话要置顶，代码在哪个模块？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J015.1",
          "query": {
            "code_index": "none",
            "text": "Sessions Plus 收藏置顶\n收藏的会话应该排在最近会话前面，导航栏里置顶显示。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "sessions-plus.navigation",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "Pinned order",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J016",
      "class": "code",
      "title": "修 PDF 预览要看哪些文件与测试？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J016.1",
          "query": {
            "code_index": "none",
            "text": "修复会话+在线打开与预览 PDF\n希望 sessions+ 可以支持在线打开和预览 pdf，但是似乎不工作，报 resource.open_media unavailable。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "sessions-plus.files",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "可见文件链接不等于端到端可打开",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J017",
      "class": "code",
      "title": "部署冷启动超时该改哪里？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J017.1",
          "query": {
            "code_index": "none",
            "text": "修复部署冷启动超时预算\n线上部署冷启动 173 秒超过了观察窗口，deploy.sh 误判失败。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "devpipe.deploy",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "readiness",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J018",
      "class": "code",
      "title": "Runner 双机放置涉及哪些模块？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J018.1",
          "query": {
            "code_index": "none",
            "text": "Runner 与 Agent 跨机放置\nAgent 运行机和执行机要能分开在两台 Runner 上，会话级 MCP 凭证跟着走。"
          },
          "qrels": [
            {
              "match": "capability",
              "value": "runner.placement",
              "relevance": 3,
              "slots": [
                "contract_principle"
              ],
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": "doc/adr/0009-runner-placement-and-session-mcp.md",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J019",
      "class": "history",
      "title": "手机端输入框换行自动提交的问题以前出过吗？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J019.1",
          "query": {
            "code_index": "none",
            "text": "手机端交互优化\n手机端的聊天输入框默认提示词太长，工单系统似乎被配置成换行自动提交了，这不符合预期。"
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": "patterns.jsonl",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "text_contains",
              "value": "手机端跨界面交互",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J020",
      "class": "history",
      "title": "GitLab CI 红灯反复修不好的历史根因是什么？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J020.1",
          "query": {
            "code_index": "none",
            "text": "夜间 CI 与持续修复闭环\nGitLab CI 每天北京时间 04:00 聚合扫描 v4，session 在每次修复落地后立即接受完整 CI，到绿灯收尾。"
          },
          "qrels": [
            {
              "match": "text_contains",
              "value": "CI 修复因短路",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J021",
      "class": "history",
      "title": "共享包改了但 App 没发布，这类事以前怎么发生的？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J021.1",
          "query": {
            "code_index": "none",
            "text": "补齐 Session Plus 的 Chat UI 发布债务路径\nchat-ui-commons 变化时要为 Session Plus 记录待发布债务，防止 releasePaths 静默漂移。"
          },
          "qrels": [
            {
              "match": "text_contains",
              "value": "App release 影响集",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J022",
      "class": "history",
      "title": "并发落地后 CI 失败被错误归因给当前票，历史上怎么处理？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J022.1",
          "query": {
            "code_index": "none",
            "text": "保留 worktree 到 landed SHA 的因果链\n并发落地后系统只能说失败可能来自其它 commit 却仍路由当前票，要求保留 tree、branch、commit、landed SHA 的链。"
          },
          "qrels": [
            {
              "match": "text_contains",
              "value": "因果链",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J023",
      "class": "history",
      "title": "#61 当时为什么没有给不存在的目录加存在性探针？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J023.1",
          "query": {
            "code_index": "none",
            "text": "#61 当时为什么没有给不存在的目录加存在性探针？",
            "paths": [
              "packages/agent-sessions-view/src/lib/directory-index.ts"
            ]
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": "2026-08-11-ticket-61",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J024",
      "class": "history",
      "title": "多分块 PDF 预览失败的根因记录在哪？",
      "hard_gate": false,
      "steps": [
        {
          "id": "J024.1",
          "query": {
            "code_index": "none",
            "text": "多分块 PDF 预览 receiver 流 分块 失败"
          },
          "qrels": [
            {
              "match": "source_ref_contains",
              "value": "media-stream-receiver",
              "relevance": 2,
              "max_rank": 10
            },
            {
              "match": "source_ref_contains",
              "value": "pdf",
              "relevance": 2,
              "max_rank": 10
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J025",
      "class": "parity",
      "title": "Ticket #324 external OMP idle append recovers the complete parity obligation and exact evidence",
      "hard_gate": true,
      "steps": [
        {
          "id": "J025.1",
          "query": {
            "text": "An externally started OMP session is idle in tmux. Append one new message safely without takeover or replay, and identify the provider-neutral action and conformance tests.",
            "input_ref": "ticket:324",
            "filters": {
              "lifecycle": "current",
              "providers": [
                "omp"
              ],
              "launchModes": [
                "external-tmux"
              ],
              "states": [
                "idle"
              ],
              "actions": [
                "append"
              ]
            },
            "code_index": "matching"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "capability_contract:agent-loop-parity",
              "relevance": 3,
              "max_rank": 3,
              "slots": [
                "contract_principle"
              ]
            },
            {
              "match": "record_id",
              "value": "obligation:agent-loop-parity/full-stack-provider-parity",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "contract_principle"
              ]
            },
            {
              "match": "record_id",
              "value": "scenario:agent-loop-parity/external-omp-idle-append",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "scenarios"
              ]
            },
            {
              "match": "record_id",
              "value": "source:ticket:227",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "sources_requirements"
              ]
            },
            {
              "match": "record_id",
              "value": "decision:cur:b01:157:5",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "sources_requirements",
                "decisions_exceptions"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/symbol/operation-submit",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "actions_symbols"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/test/external-omp-test",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "tests_evidence"
              ]
            }
          ],
          "forbidden": [
            {
              "record_id": "risk:cur:b29:227:14",
              "slots": [
                "contract_principle",
                "scenarios",
                "sources_requirements",
                "decisions_exceptions",
                "actions_symbols",
                "tests_evidence"
              ]
            }
          ],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J026",
      "class": "parity",
      "title": "Independent bilingual paraphrase retrieves the same parity chain",
      "hard_gate": true,
      "steps": [
        {
          "id": "J026.1",
          "query": {
            "text": "外部启动的 OMP 卡在 tmux 空闲界面；send a follow-up once, keep exact pane authority, and show the neutral frontend/backend action plus tests, not just transcript rendering.",
            "filters": {
              "lifecycle": "current",
              "providers": [
                "omp"
              ],
              "launchModes": [
                "external-tmux"
              ],
              "states": [
                "idle"
              ],
              "actions": [
                "append"
              ]
            },
            "code_index": "matching"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "capability_contract:agent-loop-parity",
              "relevance": 3,
              "max_rank": 3,
              "slots": [
                "contract_principle"
              ]
            },
            {
              "match": "record_id",
              "value": "source:ticket:227",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "sources_requirements"
              ]
            },
            {
              "match": "record_id",
              "value": "decision:cur:b01:157:5",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "sources_requirements",
                "decisions_exceptions"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/symbol/operation-submit",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "actions_symbols"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/test/external-omp-test",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "tests_evidence"
              ]
            }
          ],
          "forbidden": [
            {
              "record_id": "risk:cur:b29:227:14",
              "slots": [
                "contract_principle",
                "scenarios",
                "sources_requirements",
                "decisions_exceptions",
                "actions_symbols",
                "tests_evidence"
              ]
            }
          ],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J027",
      "class": "negative",
      "title": "No organizational record mandates a managed vector vendor",
      "hard_gate": true,
      "steps": [
        {
          "id": "J027.1",
          "query": {
            "text": "Which managed vector database vendor is mandated for the unrelated payments.vendor capability?",
            "filters": {
              "lifecycle": "current",
              "capabilities": [
                "payments.vendor"
              ]
            },
            "code_index": "none"
          },
          "qrels": [],
          "forbidden": [
            {
              "text_contains": "Pinecone"
            },
            {
              "text_contains": "Qdrant"
            }
          ],
          "expected_unknown": [
            "no_grounded_answer"
          ],
          "no_answer": true,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J028",
      "class": "lifecycle",
      "title": "#239 supersedes the old #227 mid-turn limitation",
      "hard_gate": true,
      "steps": [
        {
          "id": "J028.1",
          "query": {
            "text": "Can an OMP ticket receive a message during the running turn, and what happened to the OMP 17.3.5 limitation?",
            "filters": {
              "lifecycle": "all",
              "capabilities": [
                "tickets.agent-runtime"
              ]
            },
            "code_index": "none"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "decision:cur:b29:239:5",
              "relevance": 3,
              "max_rank": 5,
              "slots": [
                "decisions_exceptions"
              ]
            },
            {
              "match": "record_id",
              "value": "risk:cur:b29:227:14",
              "relevance": 2,
              "max_rank": 10,
              "slots": [
                "unknown_conflicts"
              ]
            }
          ],
          "forbidden": [
            {
              "record_id": "risk:cur:b29:227:14",
              "slots": [
                "contract_principle",
                "scenarios",
                "sources_requirements",
                "decisions_exceptions",
                "actions_symbols",
                "tests_evidence"
              ]
            }
          ],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J029",
      "class": "waiver",
      "title": "OMP manual profile waiver applies only to its complete scope",
      "hard_gate": true,
      "steps": [
        {
          "id": "J029.1",
          "query": {
            "text": "For a managed OMP launch with the manual permission profile, is the asymmetry waived and how must it fail?",
            "filters": {
              "lifecycle": "current",
              "providers": [
                "omp"
              ],
              "launchModes": [
                "managed"
              ],
              "states": [
                "manual-profile"
              ],
              "actions": [
                "launch"
              ]
            },
            "code_index": "matching"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "exception:agent-loop-parity/omp-manual-profile",
              "relevance": 3,
              "max_rank": 5,
              "slots": [
                "decisions_exceptions"
              ]
            },
            {
              "match": "record_id",
              "value": "desired_conformance:agent-loop-parity/omp-manual-profile",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "contract_principle"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/test/omp-manual-test",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "tests_evidence"
              ]
            }
          ],
          "forbidden": [
            {
              "record_id": "exception:agent-loop-parity/codex-account-fallback",
              "slots": [
                "decisions_exceptions"
              ]
            },
            {
              "record_id": "exception:agent-loop-parity/claude-bilingual-interaction",
              "slots": [
                "decisions_exceptions"
              ]
            }
          ],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    },
    {
      "id": "J030",
      "class": "sha",
      "title": "Symbol-to-design retrieval fails closed when the code-index SHA is stale",
      "hard_gate": true,
      "steps": [
        {
          "id": "J030.1",
          "query": {
            "text": "What parity obligation and tests govern SessionPlusOperationBinding.submit?",
            "symbol": {
              "path": "packages/bot/src/session-plus/operation-binding.ts",
              "qualified_name": "SessionPlusOperationBinding.submit"
            },
            "filters": {
              "lifecycle": "current"
            },
            "code_index": "matching"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "obligation:agent-loop-parity/provider-neutral-operation-port",
              "relevance": 3,
              "max_rank": 5,
              "slots": [
                "contract_principle"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/symbol/operation-submit",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "actions_symbols"
              ]
            },
            {
              "match": "record_id",
              "value": "artifact:octopus/test/operation-binding-test",
              "relevance": 3,
              "max_rank": 10,
              "slots": [
                "tests_evidence"
              ]
            }
          ],
          "forbidden": [],
          "expected_unknown": [],
          "no_answer": false,
          "max_chars": 7000
        },
        {
          "id": "J030.2",
          "query": {
            "text": "What parity obligation and exact tests govern SessionPlusOperationBinding.submit at this checkout?",
            "symbol": {
              "path": "packages/bot/src/session-plus/operation-binding.ts",
              "qualified_name": "SessionPlusOperationBinding.submit"
            },
            "filters": {
              "lifecycle": "current"
            },
            "code_index": "stale"
          },
          "qrels": [
            {
              "match": "record_id",
              "value": "obligation:agent-loop-parity/provider-neutral-operation-port",
              "relevance": 3,
              "max_rank": 5,
              "slots": [
                "contract_principle"
              ]
            }
          ],
          "forbidden": [
            {
              "record_id": "artifact:octopus/symbol/operation-submit",
              "slots": [
                "actions_symbols"
              ]
            },
            {
              "record_id": "artifact:octopus/test/operation-binding-test",
              "slots": [
                "tests_evidence"
              ]
            }
          ],
          "expected_unknown": [
            "code_index_stale"
          ],
          "no_answer": false,
          "max_chars": 7000
        }
      ]
    }
  ]
}
```
