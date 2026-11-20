export interface HistoricalKnowledgeSeed {
  id: string;
  title: string;
  body: string;
  tickets: number[];
  paths: string[];
  tests: string[];
  replay_query: string;
  false_positive: string;
  confidence: number;
}

/**
 * Curated recurrence corpus. These are retrieval/evaluation fixtures backed by
 * runtime tickets and shipped regression tests, not new architecture rules.
 */
export const HISTORICAL_KNOWLEDGE_SEEDS: readonly HistoricalKnowledgeSeed[] = [
  {
    id: "mobile-cross-surface-transition-state",
    title: "手机端跨界面交互会丢失输入、导航或滚动状态",
    body: "#180/#189/#228/#256 分别暴露 composer 换行/发送、无 tab 导航、运行中消息投递、历史回填滚动和文件面板抢占导航。后续任务必须区分 surface、viewport、selected identity、route/panel、draft action、scroll anchor 与 arrival order。",
    tickets: [180, 189, 228, 256],
    paths: ["packages/dashboard-web/src/pages/TicketsPage.tsx", "packages/agent-sessions-view/src/components/AgentChat.tsx"],
    tests: ["packages/dashboard-web/src/pages/TicketsPage.test.tsx", "packages/agent-sessions-view/src/components/AgentChat.test.tsx"],
    replay_query: "SELECT group_concat(id),count(*) FROM dev_tickets WHERE (body LIKE '%手机端%' OR body LIKE '%手机版本%') AND (body LIKE '%输入框%' OR body LIKE '%导航%' OR body LIKE '%滑动%') HAVING count(*)>=2",
    false_positive: "#158 是浏览器 swipe-back 抑制，#178 是 quota CSS overflow；都不是 composer/navigation identity 丢失。",
    confidence: 0.98,
  },
  {
    id: "file-affordance-not-open-pipeline",
    title: "可见文件链接不等于端到端可打开或预览",
    body: "#201/#243/#256/#262→#265 覆盖文本链接、resource resolve、面板路由、二进制多窗口流。排查必须记录 clicked href、cwd/directory key、opaque ref、runner、MIME/size、proposal/refusal、window index；不能把所有症状都叫‘文件打不开’。",
    tickets: [201, 243, 256, 262, 265],
    paths: ["packages/agent-sessions-view/src/lib/file-link.ts", "packages/agent-workspace-files-view/src/components/FileViewer.tsx", "packages/agent-workspace-files-view/src/components/MediaViewer.tsx"],
    tests: ["packages/agent-sessions-view/src/lib/file-link.test.ts", "packages/agent-workspace-files-view/src/modules.test.tsx"],
    replay_query: "SELECT group_concat(id),count(*) FROM dev_tickets WHERE body LIKE '%文件%' AND (body LIKE '%打开%' OR body LIKE '%预览%') HAVING count(*)>=2",
    false_positive: "文本空内容、路径 resolve、路由抢占和 PDF receiver 是同一旅程的不同阶段，不应假定同一根因。",
    confidence: 0.98,
  },
  {
    id: "async-refresh-identity-continuity",
    title: "异步刷新会覆盖当前身份、前沿或滚动锚点",
    body: "#138/#144/#228/#240 表明界面抖动、手动刷新、滚动位置丢失背后的 roster polling、transcript frontier、explicit refresh、backfill 和 ticket selection generation 被混称为刷新。必须保留 selected identity、request generation、revision、in-flight boundary、window offset、scroll anchor 和 arrival order。",
    tickets: [138, 144, 228, 240],
    paths: ["packages/agent-sessions-view/src/controller.ts", "packages/dashboard-web/src/pages/TicketsPage.tsx"],
    tests: ["packages/agent-sessions-view/src/controller.test.tsx", "packages/dashboard-web/src/pages/TicketsPage.test.tsx"],
    replay_query: "SELECT group_concat(id),count(*) FROM dev_tickets WHERE body LIKE '%界面抖动%' OR body LIKE '%手动刷新才能%' OR body LIKE '%跳到了过于早的位置%' HAVING count(*)>=2",
    false_positive: "#117 是登录/部署恢复，#189 的刷新键是手动 affordance；都不证明 stale projection 被应用。",
    confidence: 0.97,
  },
  {
    id: "provider-session-lifecycle-vocabulary",
    title: "Provider 与接入模式不同却被统一称为 agent/session",
    body: "#177/#184/#241/#258 的接管、中断、agent chat 重复消息、启动和标题问题需要 provider、launch method、managed/external mode、authoritative session id、action、capability snapshot、permission tier 与 native title source。",
    tickets: [177, 184, 241, 258],
    paths: ["packages/runner/src/agent-control-plane.ts", "packages/runner/src/omp-rpc.ts", "packages/session-plus-view/src/App.tsx"],
    tests: ["packages/agent-sessions-view/src/components/AgentChat.test.tsx", "packages/session-plus-view/src/App.test.tsx"],
    replay_query: "SELECT group_concat(id),count(*) FROM dev_tickets WHERE body LIKE '%接管%' OR body LIKE '%中断 agent%' OR body LIKE '%启动不了新 AGENT%' OR body LIKE '%chat 的标题%' HAVING count(*)>=2",
    false_positive: "#249 的 OMP cold-start RPC timeout 是 transport readiness，不是 lifecycle vocabulary 歧义。",
    confidence: 0.95,
  },
  {
    id: "ci-repair-fanout-not-convergence",
    title: "CI 修复因短路和残缺 failure roster 反复开票而不收敛",
    body: "#219/#248/#255 及密集红灯票显示：每个 red 必须保存 tested/base SHA、完整 roster、全部失败、runner capability、关联 commits→tickets→原始需求及同一 repair session；不能让首个失败或预算中止隐藏其余红灯。",
    tickets: [219, 248, 255],
    paths: [".gitlab-ci.yml", "packages/bot/src/devpipe/ci-roster.ts", "packages/bot/src/devpipe/gitlab-ci.ts"],
    tests: ["packages/bot/src/devpipe/ci-roster.test.ts", "packages/bot/src/devpipe/gitlab-ci.test.ts"],
    replay_query: "SELECT count(*) AS repairs,min(id),max(id) FROM dev_tickets WHERE title LIKE '修复 GitLab CI 红灯%'",
    false_positive: "独立失败可以需要多个 fix；这里的坏行为是同一预算失败连续九批被隐藏和明确的多票循环。",
    confidence: 0.99,
  },
  {
    id: "landing-lineage-causal-gap",
    title: "worktree→tested head→landing range→ticket 因果链曾经缺失",
    body: "#160/#232/#235/#238 显示并发落地后系统只能说失败‘可能来自其它 commit’却仍路由当前票。每次 landing 必须不可变保存 base SHA、submitted head、landed SHA、intervening ticket ownership、changed files/tests 和 gate outcome。",
    tickets: [160, 232, 235, 238],
    paths: ["packages/bot/src/devpipe/pipeline.ts", "packages/bot/src/store/repositories/dev-tickets.ts"],
    tests: ["packages/bot/src/devpipe/pipeline.test.ts", "packages/bot/src/devpipe/ci-change-history.test.ts"],
    replay_query: "SELECT ticket_id,count(*) FROM ticket_messages WHERE via='pipeline' AND body LIKE '%可能来自并行合入的其它 commit;都路由回%' GROUP BY ticket_id",
    false_positive: "警告不证明每次都错配；它证明当时无法作出因果归属，本身就是知识缺口。",
    confidence: 0.98,
  },
  {
    id: "deploy-artifact-readiness-phases",
    title: "构建产物复用与部署 readiness 曾被折叠成一个等待",
    body: "#187/#252 分别暴露重复 build 等待与 cold-start 观察窗误判。必须区分 artifact digest/cache key/test provenance、build/start/lease/ready 时间和各自预算；依赖变化或 cache miss 时重建仍是正确行为。",
    tickets: [187, 252],
    paths: ["scripts/supervisord.sh", "scripts/ops/deploy.sh", "packages/bot/src/devpipe/build-warm.ts"],
    tests: ["packages/bot/src/devpipe/supervisor.e2e.test.ts", "packages/bot/src/devpipe/build-warm.test.ts"],
    replay_query: "SELECT id,title,commit_sha FROM dev_tickets WHERE id IN (187,252) AND (body LIKE '%build%' OR body LIKE '%冷启动%')",
    false_positive: "#187 是冗余构建，#252 是 readiness 窗口不足；并非所有耗时 build 都应复用。",
    confidence: 0.97,
  },
  {
    id: "app-release-impact-drift",
    title: "App release 影响集在全局重建与漏记依赖之间漂移",
    body: "#121/#132 要求保留 changed source→affected App→pending debt→package→activation 的版本化依赖解释，以及 source/runtime digest。共享包变化可合法影响多个 App；坏行为是静默漏债或 App-only 改动触发全局重启。",
    tickets: [121, 132],
    paths: ["packages/bot/src/devpipe/app-scopes.ts", "packages/bot/src/app-registry", "ctl/app-release.ts"],
    tests: ["packages/bot/src/devpipe/app-scopes.test.ts"],
    replay_query: "SELECT id,title,commit_sha FROM dev_tickets WHERE id IN (121,132) AND (body LIKE '%全局重建%' OR body LIKE '%待发布债务%')",
    false_positive: "依赖图证明受影响时重建 App 是正确的；全局 bot restart 与静默漏记才是两端错误。",
    confidence: 0.96,
  },
];
