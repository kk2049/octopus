/**
 * The vocabulary the permission centre speaks — subjects, resources, operations
 * and the stable human labels for what an operation actually does.
 *
 * ── Why a catalog rather than "render the kernel tables" ────────────────────
 *
 * A capability id, a Context id and a slot name are implementation. Showing
 * them to a person answers none of the five questions a permission screen has
 * to answer (who / over what / may do what / under which conditions / why it is
 * still valid), and worse, it invites the browser to send one back — at which
 * point the browser is choosing its own authority.
 *
 * So this file is the projection's dictionary: stable ids that mean something
 * to a person, mapped onto the closed operation names the Gate actually
 * enforces. Nothing here grants anything. It is data for a view, plus the one
 * mapping (`runnerOperation`) that keeps the UI's name and the kernel's name
 * from becoming two authorization systems — which is the failure the execution
 * plan calls out by name.
 */

import { RUNNER_OPERATIONS } from "../runner/capability.js";

/** Who a grant is made to. */
export type SubjectType = "service" | "app" | "agent";

/**
 * What a grant is over. `runner-account` covers every device the account has
 * registered; `runner-device` narrows to one. The device set cannot change
 * under a live grant — registering one revokes the account root first — so the
 * account form is not a loophole, it is the coarse end of the same axis
 * (root CLAUDE.md, "Object 是账号不是机器").
 */
export type ResourceType = "runner-account" | "runner-device";

/**
 * The stable risk labels §8 asks for. They are attached to OPERATIONS, not to
 * subjects, so "this app may execute commands" and "this agent may execute
 * commands" read identically and neither can be dressed down.
 */
export type RiskLabel =
  | "读取私密内容"
  | "修改"
  | "执行命令"
  | "对外发送"
  | "跨用户披露"
  | "特权服务"
  | "枚举与状态";

export interface OperationInfo {
  /** The name the UI, the API and the audit log all use. */
  id: string;
  /** The Runner operation the Gate actually enforces. */
  runner: string;
  title: string;
  /** One sentence a person can act on. Not a restatement of the title. */
  description: string;
  effect: "observe" | "read" | "modify" | "execute";
  risk: RiskLabel;
  /**
   * Whether a durable grant can remove per-call approval. Cross-user and
   * sharing operations keep this true; owner-bound first-party actions may set
   * it false and opt into `mayAutoAllow`.
   */
  alwaysApprove: boolean;
  /** May a grant let this run unsupervised inside its exact owner-bound scope? */
  mayAutoAllow: boolean;
  /** Human-facing class of data that leaves the resource boundary. */
  disclosure?: string;
}

/**
 * Immutable vocabulary injected for one subject.
 *
 * The mapping is presentation-only: `kernelOperation()` names the exact Gate
 * operation. Session Plus deliberately uses identical ids, while the legacy
 * Session Hub retains its finer UI aliases.
 */
export interface OperationCatalog {
  readonly operations: readonly OperationInfo[];
  readonly ids: readonly string[];
  readonly autoAllowable: readonly string[];
  operation(id: string): OperationInfo | undefined;
  kernelOperation(id: string): string | undefined;
  kernelOperationsFor(ids: readonly string[]): string[];
}

export function defineOperationCatalog(
  name: string,
  input: readonly OperationInfo[],
  knownKernelOperations?: Readonly<Record<string, unknown>>,
): OperationCatalog {
  const operations = Object.freeze(input.map((row) => Object.freeze({ ...row })));
  const byId = new Map<string, OperationInfo>();
  for (const op of operations) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(op.id)) throw new Error(`${name} catalog: invalid operation id "${op.id}"`);
    if (byId.has(op.id)) throw new Error(`${name} catalog: duplicate operation "${op.id}"`);
    if (op.alwaysApprove && op.mayAutoAllow) {
      throw new Error(`${name} catalog: operation "${op.id}" cannot be both always-approve and auto-allowable`);
    }
    if (knownKernelOperations && !Object.prototype.hasOwnProperty.call(knownKernelOperations, op.runner)) {
      throw new Error(`${name} catalog: "${op.id}" maps to unknown kernel operation "${op.runner}"`);
    }
    byId.set(op.id, op);
  }
  const ids = Object.freeze(operations.map((op) => op.id));
  const autoAllowable = Object.freeze(operations.filter((op) => op.mayAutoAllow).map((op) => op.id));
  return Object.freeze({
    operations,
    ids,
    autoAllowable,
    operation: (id: string) => byId.get(id),
    kernelOperation: (id: string) => byId.get(id)?.runner,
    kernelOperationsFor: (requested: readonly string[]) => {
      const out = new Set<string>();
      for (const id of requested) {
        const operation = byId.get(id)?.runner;
        if (operation) out.add(operation);
      }
      return [...out].sort();
    },
  });
}

/**
 * The Session Hub operation catalog (execution plan §5).
 *
 * `live_session` and `read_session` share ONE underlying Runner read, and that
 * is stated rather than hidden: a live tail IS a repeated read. What the
 * separate hub-level operation buys is a separate thing to grant and revoke —
 * "you may open my transcript" and "you may hold an open stream bound to your
 * browser session" are different amounts of exposure over time, and revoking
 * the second must close streams without closing the page. The Gate cannot see
 * that difference, so the hub enforces it above the Gate and says so here.
 *
 * `resume_session` likewise executes through `append_session`. Distinct
 * authorization and audit identity, one execution path — which is exactly what
 * §5 permits ("可以与 append 共用底层执行，但授权和审计语义明确").
 */
export const SESSION_HUB_OPERATIONS: readonly OperationInfo[] = [
  {
    id: "list_sessions",
    runner: "list_recent_sessions",
    title: "列出会话",
    description: "看见你设备上有哪些 Claude Code / Codex / omp 会话、在哪个目录、最近何时活动。不读正文。",
    effect: "observe",
    risk: "枚举与状态",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "search_sessions",
    runner: "search_sessions",
    title: "搜索会话",
    description: "在你设备的会话记录里按关键字检索，返回命中片段。会看到匹配处的正文。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "read_session",
    runner: "read_session",
    title: "读取会话正文",
    description: "打开一个会话的完整 transcript：你说过的话、模型的回答、工具调用与结果。",
    effect: "read",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "live_session",
    runner: "read_session",
    title: "实时跟随会话",
    description: "保持一条随会话增长的实时流。底层与「读取会话正文」是同一次读取，但它是持续的——撤销它会立刻断开正在跟随的页面。",
    effect: "observe",
    risk: "读取私密内容",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  // O1: sending to one's OWN session is the owner acting on their own
  // resource. It is an ordinary grant term (default on in the bootstrap
  // grant) rather than a per-call approval, so the owner's scripts and MCP
  // agents are as silent as their browser. Other accounts never hold this row.
  {
    id: "append_session",
    runner: "append_session",
    title: "续跑会话",
    description: "在你的设备上，用你自己的 CLI 额度，为某个会话跑一轮新的指令；本人提交（网页、脚本或 MCP）默认免批准。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
  {
    id: "resume_session",
    runner: "append_session",
    title: "恢复会话",
    description: "与「续跑会话」同一条执行路径，但授权与审计分开记：恢复的是一个已经结束的会话；本人提交默认免批准。",
    effect: "execute",
    risk: "执行命令",
    alwaysApprove: false,
    mayAutoAllow: true,
  },
];

export const SESSION_HUB_CATALOG = defineOperationCatalog(
  "session hub",
  SESSION_HUB_OPERATIONS,
  RUNNER_OPERATIONS,
);

export function sessionHubOperation(id: string): OperationInfo | undefined {
  return SESSION_HUB_CATALOG.operation(id);
}

/** Every hub operation id, in catalog order (the order the UI renders). */
export const SESSION_HUB_OPERATION_IDS: readonly string[] = SESSION_HUB_CATALOG.ids;

/** Hub operations a grant may let run unsupervised: every one of them (O1). */
export const SESSION_HUB_AUTO_ALLOWABLE: readonly string[] = SESSION_HUB_CATALOG.autoAllowable;

/**
 * Hub operation → Runner operation. The one place the two vocabularies meet.
 *
 * Asserted against the closed Runner registry at module load: a catalog entry
 * naming an operation the kernel does not have would produce a permission
 * screen describing a right that can never be exercised, and — worse — an
 * "effective" answer the Gate would disagree with.
 */
export function runnerOperation(hubOperationId: string): string | undefined {
  return SESSION_HUB_CATALOG.kernelOperation(hubOperationId);
}

/** The Runner operations a set of hub operations reduces to. Deduped, sorted. */
export function runnerOperationsFor(hubOperationIds: readonly string[]): string[] {
  return SESSION_HUB_CATALOG.kernelOperationsFor(hubOperationIds);
}

// ── subjects ──

export interface SubjectInfo {
  type: SubjectType;
  /** Stable id: "session-hub", "dev-factory", "reports", "reports/page". */
  id: string;
  title: string;
  /** Who ships it. Shown so a grant is visibly to a publisher, not to a name. */
  publisher: string;
  description: string;
  /**
   * Is there an execution path that actually CONSUMES a grant for this subject?
   *
   * The default composition contains `session-hub`. A feature may explicitly
   * inject another subject only together with the catalog and execution path
   * that consume its row (Session Plus is the first example).
   *
   * An uncomposed v3 App or Agent is `false` — and that is not a placeholder for
   * "soon". A row with no consumer would be decoration, and a decorative
   * permission control is worse than none because a reader would revoke it and
   * believe something happened.
   *
   * A trusted service is `false` for a different reason: it did not get its
   * authority from a grant at all (execution plan §3.3).
   */
  enforced: boolean;
  /**
   * A trusted service is NOT a sandboxed app and the UI must not imply that it
   * went through an ordinary grant. It gets a badge, its real boundaries listed,
   * and no "authorise" button (execution plan §3.3).
   */
  trustedService?: {
    /** The fixed principal the executor runs as. */
    principal: string;
    /** The boundaries a reader should be able to check. */
    boundaries: string[];
  };
}

/** One explicitly composed subject and the vocabulary used to project it. */
export interface SubjectCatalogEntry {
  info: SubjectInfo;
  catalog: OperationCatalog;
  /**
   * What this subject asks for right now, when that can change between
   * releases. Trusted composition data, supplied by the composition root; a
   * subject with a fixed ask omits it and the whole catalog is the answer.
   */
  declared?: (owner?: string) => readonly string[];
  /** Whether the generic permission page may mutate this subject's row. */
  userManaged: boolean;
  /**
   * Release identity written beside a user grant. Optional for stable services;
   * Apps use it so the generic grant route need not know any App by name.
   */
  grantIdentity?: {
    publisher: string;
    contractDigest: string;
  };
}

/** The first-party surfaces the permission centre knows about by construction. */
export const SESSION_HUB_SUBJECT: SubjectInfo = {
  type: "service",
  id: "session-hub",
  title: "会话中心",
  publisher: "first-party",
  enforced: true,
  description:
    "从网页汇总、查看并续跑你自己设备上的 Claude Code / Codex / omp 会话。它只授权会话操作——"
    + "CLI 在你机器上还能碰什么，由那台设备的配置决定，不由这里决定。",
};

export const SESSION_HUB_SUBJECT_ENTRY: SubjectCatalogEntry = Object.freeze({
  info: SESSION_HUB_SUBJECT,
  catalog: SESSION_HUB_CATALOG,
  userManaged: true,
});

/**
 * Dev Factory, described honestly (execution plan §3.3).
 *
 * It is listed so a reader can SEE it and see what it may do; it is not
 * grantable here, because it did not get its authority from a grant. Claiming
 * otherwise on this screen would be the specific lie the plan forbids.
 *
 * ── What changed, and why it had to (v3 bootstrap) ──────────────────────
 *
 * The old list read like a containment story: "工作区固定在每张工单自己的 git
 * worktree 内", "写入基线只有一条路径". Both sentences are true of how the agent
 * is MEANT to work and neither is a boundary. The dev agent runs as the bot
 * process's own OS account with `--dangerously-skip-permissions`: the worktree
 * is its working directory, not a jail, and `devpipe_submit` is the only
 * *intended* path to the baseline, not the only possible one — it has a shell,
 * so it has git, the filesystem and the network.
 *
 * Describing a convention as a boundary is the more dangerous kind of wrong: it
 * invites someone to hand out `dev` as if the blast radius were a directory. In
 * this phase the containment is the ACCESS GATE — only trusted people get `dev`
 * — and the honest list has to say so, so that the eventual privilege-reduction
 * design is chosen on the real picture rather than on this paragraph.
 */
export const DEV_FACTORY_SUBJECT: SubjectInfo = {
  type: "service",
  id: "dev-factory",
  title: "开发工厂",
  publisher: "first-party",
  enforced: false,
  description:
    "自举开发流水线：工单对话、独立 worktree、门禁、ff-only 合入与部署。它是**受信系统服务**，"
    + "本阶段刻意保留主机开发者级别的完整权限——不是一个被沙箱或统一权限门约束的普通 App Agent。"
    + "唯一的边界是准入：只有被授予 dev 的人能用它，而 dev 应当只给受信任的人。",
  trustedService: {
    principal: "system:dev-factory",
    boundaries: [
      "⚠ 以 bot 进程的 OS 账号运行，并带 --dangerously-skip-permissions:可执行任意命令、"
        + "读写该账号可及的任何文件、访问网络与已登录的 CLI 凭据。权限等同这台主机上的人类开发者",
      "worktree 是它的工作目录，不是沙箱:它有 shell，因此不受目录限制",
      "devpipe_submit(保护路径 → 合并锁 → 门禁 → ff-only)是**约定的**合入路径，"
        + "用来保证「测过的内容 = 要合入的内容」;它不是一道能拦住这个 agent 的技术边界",
      "真正的边界是准入:只有被授予 dev 的用户能驱动它，上线另需 deploy 授权",
      "部署由 supervisor、健康门、存活确认与 stable 水位控制，可回滚",
      "工单对话与 agent transcript 对所有获授 dev 的用户可见",
      "去特权化设计推迟到系统架构清楚之后，本页不假装它已经发生",
    ],
  },
};

/**
 * The same contract, compressed to the one line a startup inventory can hold.
 *
 * Shared by both entry points so the sentence an operator reads in the log
 * cannot drift from the one a user reads on `/permissions` — the previous
 * version said "固定 repo/worktree/门禁边界", which is exactly the containment
 * claim that is not true.
 */
export const DEV_FACTORY_INVENTORY_NOTE =
  "自举开发流水线:受信主机开发者权限(bot 进程 OS 账号 + --dangerously-skip-permissions,"
  + "worktree 是工作目录不是沙箱);边界是准入——仅授予 dev 的用户可驱动,上线另需 deploy";

export const TRUSTED_SERVICE_PRINCIPALS: Readonly<Record<string, string>> = {
  "dev-factory": "system:dev-factory",
};
