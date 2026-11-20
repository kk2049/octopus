/** Shared declaration for local stdio and internally scoped ticket MCP. */
import type { McpToolDefinition } from "@claude-bot/typed-port-kit";
import { LANDING_KNOWLEDGE_SCHEMA } from "./landing-knowledge.js";

// Ticket #16: parallel coding + serial merge. `devpipe_claim_workspace` is
// gone — there is nothing to claim before typing (each ticket has its own
// worktree). submit is the whole merge phase, atomic, and it also carries
// the base-rebase and the "who landed ahead of me" report.
export const DEVPIPE_TOOLS: McpToolDefinition[] = [
  {
    name: "devpipe_workspace_sync",
    description: "把 Head 当前基线同步到本票已经绑定的 Runner 开发树。若基线已前移，在 Runner 完成 rebase、冲突处理和复验后重新提交；不隐式重写开发成果。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devpipe_ci_job",
    description: "在本票已授权的 workspace provider 上提交/查询/读取日志/取消持久任务。start 绑定当前已提交 SHA。request_key 是幂等身份，断线沿用原 key 查询，unknown 不得换 key 重放。prepare=true 先准备精确源码，成功后使用其他任务 key 编译或测试。",
    inputSchema: { type: "object", additionalProperties: false, required: ["action", "request_key"], properties: {
      action: { type: "string", enum: ["start", "status", "log", "cancel"] }, request_key: { type: "string", minLength: 1, maxLength: 80 },
      command: { type: "string" }, prepare: { type: "boolean" },
      timeout_ms: { type: "number", minimum: 1000, maximum: 2700000 },
      offset: { type: "number", minimum: 0 }, length: { type: "number", minimum: 1, maximum: 65536 },
    } },
  },
  {
    name: "devpipe_ci_sync",
    description:
      "把本票 worktree 已提交的精确 HEAD 同步到本轮专属的 CI 容器工作区,不拿合并锁。" +
      "本地完成一批 commit 后调用;如果 devpipe_submit 返回 base_changed_review,在审查并修复并发变更后必须再调用一次。" +
      "成功返回 checkout_dir,随后用 machine_exec 在该目录完成相关编译和少量测试。未提交改动会被拒绝。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devpipe_submit",
    description:
      "完成编译和相关小测试、所有改动 commit 后调用(原子的合并阶段):检查保护路径与(App 工单的)路径域、记录可信边界路径提示 → 抢合并锁 → " +
      "rebase 到最新基线。若期间有其它工单落地,返回 base_changed_review 和 landed_ahead、同轮继续持锁且不合入;" +
      "agent 必须 review、devpipe_ci_sync、重新编译和测试后再 submit。同一 token 重入后继续跑薄门禁 → " +
      "ff 合入基线 → 把 knowledge 与精确 landing range 一起写入台账 → 释放锁 → 记录受影响 App 的待发布 release(不在 land 时改变生产)。" +
      "Agent 必须按最终 diff 声明 delivery:full_deploy(可信/服务代码)、app_releases(仅非可信 App/View,apps 精确列全)、或 none(仅文档/测试);" +
      "系统独立重算路径和 App 影响集,漏报、多报或把底层代码冒充 App-only 都返回 delivery_scope。" +
      "knowledge 是强制字段:写清保留的需求、决策、非目标、风险、验证，以及本轮实际确认/取代的 context key。" +
      "specifications 可选，只做记录:写了就逐条给出 kind/statement/strength/provenance/realized_by/verified_by 并指向候选提交中的精确文件；不写或只覆盖部分需求不会被拒绝。" +
      "命中的现行架构约束会自动带上声明的回归测试。context_keys/supersedes 只接受语句末尾 ⟨…⟩ 里的记录 id(或 ticket:<n>);" +
      "引用不存在的 id 会被拒绝;与现行非目标字面重叠而未点名的记录只会以提示回到工单,不阻断。" +
      "tests 参数只是 CI 工作区不可用时的本机兜底,不能替代 submit 前的隔离环境验证。全量套件仍由后台批次运行。" +
      "合并锁被占用会返回 queued,结束本轮等唤醒;rebase 冲突会释放锁把 worktree 停在 " +
      "冲突里由你解掉;点名的测试失败会释放锁并把日志尾喂给你(每轮 submit 次数有限)。可信边界路径只会在成功合入后留下提示,不会阻断合并。" +
      "App 工单的改动越出该 App 的包集合时返回 app_scope 并拒绝合入——那道门**没有任何放行方式**,请撤掉越界改动或请用户另开普通工单。" +
      "**如果这次落地留下了任何要用户拍板的事(某一半你决定不做、你自作主张选了一条路想让用户确认、" +
      "或者你建议另起工单),必须同时给 open_question**——否则工单会显示成「已完成」,你那句话就埋在对话里没人会回。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge: LANDING_KNOWLEDGE_SCHEMA,
        delivery: {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: {
            mode: {
              type: "string",
              enum: ["full_deploy", "app_releases", "none"],
              description:
                "按最终 diff 选择:可信服务/契约/构建依赖=full_deploy；仅 App/View=app_releases；仅文档或测试=none。",
            },
            apps: {
              type: "array",
              maxItems: 16,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 64 },
              description: "mode=app_releases 时必填最终 diff 影响的精确完整 App id 集；其它 mode 省略。",
            },
          },
        },
        open_question: {
          type: "string",
          maxLength: 300,
          description:
            "这次落地之后仍然需要用户决定的那一件事,一句话。给了它,工单在面板上显示为「🙋 等你回复」而不是已完成;" +
            "用户一回复就自动清除。细节写在你的回复正文里,这里只放那一个问题。",
        },
        retrieval_feedback: {
          type: "array",
          maxItems: 8,
          description: "可选的显式检索反馈。只能引用启动包或 devpipe_context 返回的 kr_… trace id；不接受自由文本。",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["trace_id", "code"],
            properties: {
              trace_id: { type: "string", pattern: "^kr_[0-9a-f]{32}$" },
              code: {
                type: "string",
                enum: [
                  "helpful",
                  "not_helpful",
                  "missing_slot",
                  "code_index_stale",
                  "vector_unavailable",
                  "no_grounded_answer",
                  "wrong_lifecycle",
                  "wrong_scope",
                ],
              },
              slot: {
                type: "string",
                enum: [
                  "contract_principle",
                  "scenarios",
                  "sources_requirements",
                  "decisions_exceptions",
                  "actions_symbols",
                  "tests_evidence",
                  "landings_patterns",
                  "unknown_conflicts",
                ],
              },
              expected_record_id: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$",
              },
            },
          },
        },
        tests: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
          description:
            "这一轮要跑的测试。留空=一个都不跑。两种写法:`project:<名字>`(整个 vitest project)," +
            "或一个路径(会在拥有它的 project 里跑)。例:[\"packages/bot/src/devpipe\", \"project:session-plus-view\"]",
        },
      },
      required: ["knowledge", "delivery"],
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_app_hotswap",
    description:
      "`app.hot_replace` 的 Agentic App 工单入口。app / expected_commit / source 都是对本票已落地闭包的断言，不是选择器；" +
      "流水线从可信闭包选择 checkout，pack 后重新计算并安装确切 digest，再创建 Dashboard Administer 审批。" +
      "正常返回 approval_required：activation 尚未发生，agent 必须立即结束本轮，不得轮询、重试或自行批准。",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", minLength: 1, maxLength: 60 },
        expected_commit: { type: "string", pattern: "^[0-9a-f]{7,64}$" },
        source: { type: "string", enum: ["landed_ticket"] },
      },
      required: ["app", "expected_commit", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_app_release",
    description:
      "兼容的 Agentic App release 申请入口。agent 发起时只会 pack → install 确切 digest → 创建 app_hotswap_approvals，" +
      "不会 activate；返回 approval_required 后必须结束本轮，等待 Dashboard Administer 用户批准。" +
      "无 app 参数时只读取本工单、本次落地 commit 的完整 release 债务，可一次准备多 App 候选，绝不选择其它工单。" +
      "显式完整部署后的 drain 仍按既有操作员授权自动发布，不等待此审批。",
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          maxLength: 60,
          description:
            "要发布的 App id(例如 `session-plus`)。留空 = 发布本次合入欠着的那些(流水线自己记录的),这是常规用法。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_ask",
    description:
      "把「这一轮结束了,但有一件事要你拍板」记到工单上。面板会把这张工单显示为「🙋 等你回复」而不是已完成/待上线," +
      "用户回复后自动清除。**不落地的轮次**(讨论工单、只给方案的一轮、或者你决定某一半不做)用它;" +
      "**落地的轮次**直接在 devpipe_submit 里给 open_question 即可,不用再调一次。" +
      "传空字符串表示撤回:你后来自己想明白了、不再需要用户回答。",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          maxLength: 300,
          description: "需要用户决定的那一件事,一句话;空字符串 = 撤回未决问题。",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_sources",
    description: "读取本票最早未处理的人类来源；read_ref 分段读取单条原文（每段最多 24000 字符，回答带 next_offset 时把它作为 offset 继续读到结束；source_sha256 始终覆盖完整原文）。items 按原文分类并把要求/约束/修正映射到 specifications 的完整 statement，问题/背景/无关说明排除理由。翻页不算处理；hash 变化必须重读。仅绑定本票，不接收其它 ticket id。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      after: {type:"integer",minimum:-1}, limit: {type:"integer",minimum:1,maximum:20}, read_ref: {type:"string",maxLength:200}, offset: {type:"integer",minimum:0},
      items: {type:"array",maxItems:20,items:{type:"object",additionalProperties:false,required:["ref","source_sha256","disposition","statements","reason"],properties:{
        ref:{type:"string",maxLength:200},source_sha256:{type:"string",pattern:"^[0-9a-f]{64}$"},
        disposition:{type:"string",enum:["requirement","constraint","revision","question","context","irrelevant"]},
        statements:{type:"array",maxItems:20,items:{type:"string",maxLength:400}},reason:{type:"string",maxLength:400},
      }}},
    }},
  },
  {
    name: "devpipe_context",
    description:
      "按路径精确扩展系统知识:传入你已定位的受影响文件或目录(仓库相对路径),返回这些路径所属模块的现行原则、机械约束与验证命令、" +
      "相关决策/需求/非目标/风险、最近落地与复发模式,每条带来源与置信度。可选 question 对语句做一次词法检索。" +
      "启动提示里的「相关系统知识」是按能力推断的粗包;动手改代码前用本工具核对精确范围,并把实际依赖的记录 id(每条语句末尾 ⟨…⟩ 内)写进 submit 的 knowledge.context_keys。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: { type: "string", minLength: 1, maxLength: 300 },
          description: "仓库相对路径,文件或目录。例:[\"packages/agent-sessions-view/src/lib/file-link.ts\"]",
        },
        question: { type: "string", maxLength: 300, description: "可选:要查的一句话,例如“点击文件链接打不开”。" },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_conflict_read",
    description:
      "读取本工单绑定的知识冲突 id 与全部已保存用户批注。冲突 id 由单票 token 固定,不接受调用方选择其它冲突;" +
      "未保存的浏览器草稿不会出现。回答批注疑问或改知识前先调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devpipe_conflict_resolve",
    description:
      "本工单通过 devpipe_submit 成功合入后,把它绑定的知识冲突记为已处理。" +
      "未合入、未绑定冲突或 token 不属于当前轮都会拒绝;自然语言回复不能代替这个终态回执。",
    inputSchema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          maxLength: 600,
          description: "说明落地修改了什么、为什么满足用户批注。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "devpipe_status",
    description: "查看工单状态、合并锁归属、与基线的提交差距、本轮剩余 submit 次数。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "devpipe_rename",
    description:
      "读完需求后给当前工单生成具体标题(详情页顶部那一行)。每张新工单开工时调用一次;用户不负责写标题。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 2,
          maxLength: 60,
          description:
            "新标题(2-60 字符)。**不要**在标题里放会话号、日期、或「讨论: 」这类前缀——UI 会自己带 #<id>。",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

export const DEVPIPE_OP_BY_TOOL: Readonly<Record<string, string>> = {
  devpipe_workspace_sync: "workspace-sync",
  devpipe_ci_sync: "ci-sync",
  devpipe_ci_job: "ci-job",
  devpipe_submit: "submit",
  devpipe_app_hotswap: "app-hotswap",
  devpipe_app_release: "app-release",
  devpipe_ask: "ask",
  devpipe_context: "context",
  devpipe_sources: "sources",
  devpipe_conflict_read: "conflict-read",
  devpipe_conflict_resolve: "conflict-resolve",
  devpipe_status: "status",
  devpipe_rename: "rename",
};


/** Visibility is selected per trusted turn, never at Bot module import time. */
export function devpipeToolsForTicket(hasKnowledgeConflict: boolean): McpToolDefinition[] {
  return DEVPIPE_TOOLS.filter((tool) => hasKnowledgeConflict
    || (tool.name !== "devpipe_conflict_read" && tool.name !== "devpipe_conflict_resolve"));
}
