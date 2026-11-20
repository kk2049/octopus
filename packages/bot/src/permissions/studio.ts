/**
 * Permission Studio is a projection and command facade, not an authority.
 *
 * It makes the repository's several real policy planes readable as one map,
 * but keeps their enforcement/source labels intact. Mutations are routed only
 * to an adapter that already owns the corresponding execution boundary:
 * generic GrantIntent rows, future App-install defaults, and exact run_agent
 * permits for the shared-runtime adapter. Every compatibility relation stays
 * read-only rather than being dual-written through a second UI.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  PermissionStudioApplyResponse,
  PermissionStudioDomain,
  PermissionStudioEditableMode,
  PermissionStudioExplanation,
  PermissionStudioExplainResponse,
  PermissionStudioExplainStep,
  PermissionStudioHolder,
  PermissionStudioPermit,
  PermissionStudioPolicy,
  PermissionStudioProjection,
  PermissionStudioResource,
} from "@claude-bot/dashboard-web/contract";
import { resourceUri } from "../authorization/namespace.js";
import type { AuthorizationService } from "../authorization/service.js";
import type {
  AccessDecision,
  AppInstallDefaultProfile,
  AuthorizationResource,
  PolicyCondition,
  PolicyValueRef,
} from "../authorization/types.js";
import type { AgentRuntimePermitState } from "../agent-credits/service.js";
import { decodeMcpTokenPolicy } from "../mcp/policy-contract.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  sessionPlusContractCovering,
} from "../session-resource/contract.js";
import type { SharedAppMemberRow, Store } from "../store/store.js";
import { TENTACLE_INVOKE_OPERATION, TENTACLE_READ_EVENT_OPERATION, TENTACLE_SUBJECT_ID } from "../tentacle/contract.js";
import type { TentacleService, TentacleShareView } from "../tentacle/service.js";
import { SESSION_HUB_SUBJECT } from "./catalog.js";
import type { SubjectType } from "./catalog.js";
import type { GrantIntent, PermissionService } from "./service.js";

const PROPOSAL_TTL_MS = 5 * 60_000;
const MAX_PROPOSALS_PER_OWNER = 64;
const MAX_PROPOSALS_TOTAL = 4_096;
const MAX_LEGACY_CROSS_USER_HOLDERS = 200;

const STUDIO_NAMESPACE = "studio:";
const DEFAULT_RESOURCE_PREFIX = `${STUDIO_NAMESPACE}app-defaults:`;
const DEFAULT_HOLDER_ID = `${STUDIO_NAMESPACE}app-default`;
const DEFAULT_OPERATIONS = ["observe", "read", "modify", "execute"] as const;
type DefaultOperation = (typeof DEFAULT_OPERATIONS)[number];

interface GenericGrantProposal {
  kind: "generic-grant";
  id: string;
  owner: string;
  actor: string;
  subjectType: SubjectType;
  subjectId: string;
  operation: string;
  mode: PermissionStudioEditableMode;
  activeContractDigest: string | null;
  baseline: string;
  expiresAt: number;
}

interface AppDefaultProposal {
  kind: "app-default";
  id: string;
  owner: string;
  actor: string;
  operation: "modify" | "execute";
  mode: PermissionStudioEditableMode;
  baseline: string;
  expiresAt: number;
}

interface AgentRuntimeProposal {
  kind: "agent-runtime";
  id: string;
  owner: string;
  actor: string;
  resourceId: string;
  username: string;
  allow: boolean;
  baseline: string;
  expiresAt: number;
}

type StudioProposal = GenericGrantProposal | AppDefaultProposal | AgentRuntimeProposal;

export interface PermissionStudioAgentRuntimePort {
  managedResources(owner: string): AuthorizationResource[];
  permitState(owner: string, resourceId: string, username: string): AgentRuntimePermitState | null;
  setRuntimePermit(owner: string, resourceId: string, username: string, allow: boolean, actor: string): void;
}

export interface PermissionStudioOptions {
  store: Store;
  permissions: PermissionService;
  authorization: AuthorizationService;
  /** Dedicated command path for provider-owned shared Agent runtimes. */
  agentRuntimes?: PermissionStudioAgentRuntimePort | null;
  tentacle?: Pick<TentacleService, "shares"> | null;
  devFactoryEnabled?: () => boolean;
  activeSessionPlusContractDigest?: () => string | null;
  now?: () => number;
}

export interface PermissionStudioExplainInput {
  owner: string;
  actor: string;
  resourceId: string;
  holderId: string;
  operation: string;
  proposedMode?: PermissionStudioEditableMode;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function opaqueHandle(namespace: string, value: string): string {
  return createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 16);
}

function holderId(type: string, id: string): string {
  return `${type}:${id}`;
}

function parseGenericHolder(id: string): { type: SubjectType; id: string } | null {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) return null;
  const type = id.slice(0, colon);
  if (type !== "service" && type !== "app" && type !== "agent") return null;
  return { type, id: id.slice(colon + 1) };
}

function parseUserHolder(id: string): string | null {
  if (!id.startsWith("user:")) return null;
  const username = id.slice("user:".length);
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(username) ? username : null;
}

function genericResourceId(owner: string): string {
  return `${STUDIO_NAMESPACE}runner-account:${owner}`;
}

function personalDomainId(owner: string): string {
  return `${STUDIO_NAMESPACE}personal:${owner}`;
}

function modeFor(intent: GrantIntent | null, operation: string, alwaysApprove: boolean): PermissionStudioEditableMode {
  if (!intent || intent.status !== "active" || !intent.operations.includes(operation)) return "deny";
  if (alwaysApprove) return "ask";
  return intent.autoAllow.includes(operation) ? "allow" : "ask";
}

function genericFingerprint(
  permissions: PermissionService,
  owner: string,
  type: SubjectType,
  id: string,
  activeContractDigest: string | null,
): string {
  const intent = permissions.get(type, id, owner);
  return digest({
    declared: [...permissions.declaredOperations(type, id, owner)],
    intent: intent
      ? {
          id: intent.id,
          operations: intent.operations,
          autoAllow: intent.autoAllow,
          status: intent.status,
          source: intent.source,
          contractDigest: intent.contractDigest,
          publisher: intent.publisher,
          createdAt: intent.createdAt,
        }
      : null,
    activeContractDigest,
  });
}

function finalVerdict(mode: PermissionStudioEditableMode, effective: boolean, reason: string): string {
  if (mode === "deny") return "拒绝：许可集合里没有这个操作。";
  if (!effective) return `已配置为${mode === "allow" ? "默认允许" : "每次询问"}，但此刻不可用：${reason}`;
  return mode === "allow"
    ? "允许：当前许可和实际资源能力都有效，可在精确范围内执行。"
    : "可提出请求：每一次调用仍需通过批准门。";
}

function genericSteps(input: {
  owner: string;
  holderTitle: string;
  mode: PermissionStudioEditableMode;
  effective: boolean;
  explanation: string;
  source: string | null;
  alwaysApprove: boolean;
}): PermissionStudioExplainStep[] {
  return [
    {
      stage: "authority",
      title: "个人权限根",
      detail: `${input.owner} 是该资源域的 owner；App、Agent 和服务不会继承 owner 身份。`,
      verdict: "通过",
    },
    {
      stage: "domain_audience",
      title: "个人域 · owner 受众",
      detail: `关系仅覆盖 ${input.owner} 的账户资源，不会扩展到其他用户或共享工作区。`,
      verdict: "范围已固定",
    },
    {
      stage: "permit_ceiling",
      title: `${input.holderTitle} 的许可 / 安装上限`,
      detail: input.mode === "deny"
        ? "操作不在许可集合中；空白就是拒绝。"
        : input.alwaysApprove
          ? `许可来源：${input.source ?? "无"}。此操作被目录强制为每次询问，不能改成静默允许。`
          : `许可来源：${input.source ?? "无"}；配置模式为${input.mode === "allow" ? "默认允许" : "每次询问"}。`,
      verdict: input.mode,
    },
    {
      stage: "enforcement",
      title: "实际执行门",
      detail: input.explanation,
      verdict: input.effective ? "当前有效" : "当前不可用",
    },
  ];
}

function agentRuntimeSteps(
  owner: string,
  username: string,
  mode: PermissionStudioEditableMode,
  effective: boolean,
): PermissionStudioExplainStep[] {
  return [
    {
      stage: "authority",
      title: "共享运行机 owner",
      detail: `${owner} 只授予 ${username} 使用 provider 进程的权利，不转移主机身份。`,
      verdict: "owner-bound",
    },
    {
      stage: "domain_audience",
      title: "精确资源 × 精确用户",
      detail: `关系固定为 ${username} × 当前 agent-runtime × run_agent；不会继承给 App、Agent 或其他设备。`,
      verdict: "tuple-bound",
    },
    {
      stage: "permit_ceiling",
      title: "run_agent 精确许可",
      detail: mode === "allow" ? "存在显式 ALLOW；撤销后新的启动和续跑立即拒绝。" : "没有显式 ALLOW，空白就是拒绝。",
      verdict: mode,
    },
    {
      stage: "enforcement",
      title: "积分 + 分离执行硬门",
      detail: mode === "allow"
        ? "派发前重查余额；provider 在 owner Runner，workspace-files、shell 与 terminal 只从持有者自己的 execution Runner 派生。"
        : "不会解析真实 provider 设备，也不会派发。",
      verdict: mode === "allow" && effective ? "当前有效" : "拒绝",
    },
  ];
}

function defaultMode(profile: AppInstallDefaultProfile, operation: DefaultOperation): PermissionStudioEditableMode {
  if (operation === "observe") return profile.observeMode;
  if (operation === "read") return profile.readMode;
  if (operation === "modify") return profile.writeMode;
  return profile.executeMode;
}

function defaultLabel(operation: DefaultOperation): string {
  return ({
    observe: "枚举与状态",
    read: "读取自己的数据",
    modify: "修改自己的数据",
    execute: "执行工具或命令",
  } as const)[operation];
}

function defaultExplanation(owner: string, operation: DefaultOperation, mode: PermissionStudioEditableMode): PermissionStudioExplanation {
  return {
    verdict: `新 App 授权草稿默认：${mode === "allow" ? "默认允许" : mode === "ask" ? "每次询问" : "拒绝"}`,
    summary: "这只是下一次安装时的表单初值，不会给任何现有 App 增加权限。",
    steps: [
      {
        stage: "authority",
        title: "个人权限根",
        detail: `${owner} 仍需对每个新 App 做一次安装授权。`,
        verdict: "安装时决定",
      },
      {
        stage: "domain_audience",
        title: "仅限 owner 自有数据",
        detail: "这个默认值不适用于其他用户、组织强制域或共享工作区。",
        verdict: "范围已固定",
      },
      {
        stage: "permit_ceiling",
        title: `${defaultLabel(operation)}的草稿默认`,
        detail: `已保存的草稿默认是 ${mode.toUpperCase()}；当前尚无通用 App 安装页消费它。接入后也只能预填待确认草稿，不能直接授权。`,
        verdict: mode,
      },
      {
        stage: "enforcement",
        title: "不会直接执行",
        detail: "读取默认配置不会派生 capability；只有用户确认安装后，实际调用才会到达 kernel Gate。",
        verdict: "无直接赋权",
      },
    ],
  };
}

function authorityLabel(kind: "owner" | "organization", id: string): string {
  return kind === "owner" ? `资源 owner · ${id}` : `组织强制权限源 · ${id}`;
}

function describePolicyValue(value: PolicyValueRef): string {
  return "fact" in value ? `事实 ${value.fact}` : JSON.stringify(value.value);
}

function describePolicyCondition(condition: PolicyCondition): string {
  switch (condition.op) {
    case "all":
      return `全部满足（${condition.conditions.map(describePolicyCondition).join("；")}）`;
    case "any":
      return `任一满足（${condition.conditions.map(describePolicyCondition).join("；")}）`;
    case "not":
      return `不满足（${describePolicyCondition(condition.condition)}）`;
    case "eq":
      return `${describePolicyValue(condition.left)} = ${describePolicyValue(condition.right)}`;
    case "in":
      return `${describePolicyValue(condition.value)} 属于 [${condition.set.map((value) => JSON.stringify(value)).join(", ")}]`;
    case "gte":
      return `${describePolicyValue(condition.left)} ≥ ${describePolicyValue(condition.right)}`;
    case "ancestor":
      return `${describePolicyValue(condition.ancestor)} 是 ${describePolicyValue(condition.descendant)} 在 ${condition.hierarchy} 中的祖先`;
  }
}

function describeSelector(values: readonly string[] | undefined, fallback: string): string {
  return values?.length ? values.join("、") : fallback;
}

function decisionSteps(decision: AccessDecision): PermissionStudioExplainStep[] {
  const out: PermissionStudioExplainStep[] = decision.steps.map((step) => ({
    stage: step.stage === "validation" || step.stage === "safety"
      ? "domain_audience"
      : step.stage === "rule" || step.stage === "baseline"
        ? "authority"
        : "permit_ceiling",
    title: step.ruleId ? `可信规则 ${step.ruleId}` : step.permitId ? "精确许可" : "授权裁决",
    detail: step.message,
    ...(step.effect ? { verdict: step.effect } : {}),
  }));
  out.push({
    stage: "enforcement",
    title: "执行接线",
    detail: "该 canonical 决定本身是 intent-only；只有标记为已接线的可信 adapter 才能据此收窄 capability，最终调用仍由 kernel Gate 裁决。",
    verdict: decision.enforcement,
  });
  return out;
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

/** Server-authored unified inventory, EXPLAIN, and frozen proposal application. */
export class PermissionStudioService {
  private readonly proposals = new Map<string, StudioProposal>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly opts: PermissionStudioOptions) {
    this.now = opts.now ?? Date.now;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.proposals.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Permission Studio is closed");
  }

  projection(owner: string, canEdit: boolean): PermissionStudioProjection {
    this.assertOpen();
    const coverageNotices: string[] = [];
    const domains = new Map<string, PermissionStudioDomain>();
    const resources = new Map<string, PermissionStudioResource>();
    const holders = new Map<string, PermissionStudioHolder>();
    const permits = new Map<string, PermissionStudioPermit>();
    const policies = new Map<string, PermissionStudioPolicy>();
    const agentRuntimeResources = this.opts.agentRuntimes?.managedResources(owner) ?? [];
    const agentRuntimeIds = new Set(agentRuntimeResources.map((resource) => resource.id));

    const addDomain = (value: PermissionStudioDomain): void => {
      if (!domains.has(value.id)) domains.set(value.id, value);
    };
    const addResource = (value: PermissionStudioResource): void => {
      if (!resources.has(value.id)) resources.set(value.id, value);
    };
    const addHolder = (value: PermissionStudioHolder): void => {
      if (!holders.has(value.id)) holders.set(value.id, value);
    };
    const addPermit = (value: PermissionStudioPermit): void => {
      permits.set(value.id, value);
    };

    const personalId = personalDomainId(owner);
    addDomain({
      id: personalId,
      title: `${owner} 的个人域`,
      kind: "personal",
      authorityLabel: `资源 owner · ${owner}`,
      historyPolicy: "not_applicable",
      description: "App / Agent 只能在用户确认的安装上限内代替 owner 操作；身份本身不会被继承。",
    });
    const accountResourceId = genericResourceId(owner);
    addResource({
      id: accountResourceId,
      uri: resourceUri("object", "accounts", owner, "capabilities"),
      title: "账户级资源集合",
      kind: "runner-account",
      domainId: personalId,
      authorityLabel: `资源 owner · ${owner}`,
      sensitivity: "sensitive",
      sourceSystem: "grant-intents + capability-kernel",
      enforcement: "enforced",
      description: "现有 grant 的安全粒度是账户级；具体设备和 provider 会在派生 capability 时再次收窄。",
    });

    for (const subject of this.opts.permissions.subjects(owner, {
      devFactoryEnabled: this.opts.devFactoryEnabled?.() ?? false,
    })) {
      if (subject.type === "service" && subject.id === TENTACLE_SUBJECT_ID) continue;
      const id = holderId(subject.type, subject.id);
      addHolder({
        id,
        title: subject.title,
        kind: subject.type,
        description: subject.trustedService
          ? `受信系统服务：${subject.trustedService.principal}`
          : subject.description,
      });
      const entry = this.opts.permissions.subject(subject.type, subject.id);
      const requested = [...this.opts.permissions.declaredOperations(subject.type, subject.id, owner)];
      const effective = entry && requested.length > 0 && subject.type === "service" && subject.id === SESSION_HUB_SUBJECT.id
        ? this.opts.permissions.sessionHubEffective(owner)
        : entry && requested.length > 0 && subject.type === "app" && subject.id === SESSION_PLUS_APP_ID
          ? this.opts.permissions.sessionPlusEffective(owner, this.opts.activeSessionPlusContractDigest?.() ?? null)
          : entry && requested.length > 0
            ? this.opts.permissions.effectiveFor({
              subjectType: subject.type,
              subjectId: subject.id,
              owner,
              requested,
            })
            : { entries: [] };
      const intent = this.opts.permissions.get(subject.type, subject.id, owner);
      if (!entry && !subject.enforced) this.addUnenforcedSubject(owner, subject, id, addDomain, addResource, addPermit);
      const declared = new Set(requested);
      const operations = new Set([
        ...requested,
        ...(intent?.status === "active" ? intent.operations : []),
      ]);
      const effectiveByOperation = new Map(effective.entries.map((operation) => [operation.operation, operation]));
      for (const operationId of operations) {
        const current = effectiveByOperation.get(operationId);
        const info = entry?.catalog.operation(operationId);
        const isDeclared = declared.has(operationId);
        const runtimeEffective = Boolean(subject.enforced && isDeclared && current?.effective);
        const runtimeExplanation = !entry
          ? "这是存量 grant 记录，但当前组合没有对应 subject/adapter；它不会产生权限。"
          : !subject.enforced
            ? "当前 subject 没有消费 grant 的执行路径；它不会产生权限。"
            : !isDeclared
              ? "持久 grant 仍包含此操作，但当前 release 未声明它；本页将其显式保留为 dormant，不把它伪装成当前能力。"
              : current?.explanation ?? "当前执行路径无法证明该操作有效。";
        const alwaysApprove = info?.alwaysApprove ?? false;
        const mode = modeFor(intent, operationId, alwaysApprove);
        const editable = Boolean(
          canEdit
          && entry?.userManaged
          && subject.enforced
          && isDeclared
          && intent?.source !== "config",
        );
        const explanation = genericSteps({
          owner,
          holderTitle: subject.title,
          mode,
          effective: runtimeEffective,
          explanation: runtimeExplanation,
          source: intent?.source ?? null,
          alwaysApprove,
        });
        const verdict = finalVerdict(mode, runtimeEffective, runtimeExplanation);
        addPermit({
          id: `generic:${subject.type}:${subject.id}:${operationId}`,
          resourceId: accountResourceId,
          holderId: id,
          operation: operationId,
          operationLabel: info?.title ?? operationId,
          mode,
          verdict,
          editable,
          ...(!editable
            ? { readonlyReason: intent?.source === "config"
                ? "由部署配置管理；请修改配置并重启。"
                : subject.enforced && isDeclared
                  ? "当前查看者不能替资源 owner 改写许可。"
                  : subject.enforced
                    ? "当前 release 未声明这项 dormant 许可；可在下方旧控制面撤销整个 grant。"
                  : "尚未接入实际执行路径，不能创建装饰性授权。" }
            : {}),
          explanation: { verdict, steps: explanation },
        });
      }
    }

    const tentacleShares = this.opts.tentacle?.shares(owner) ?? [];
    this.addCanonical(owner, domains, resources, holders, permits, policies, tentacleShares, agentRuntimeIds);
    this.addAgentRuntimes(owner, canEdit, agentRuntimeResources, resources, holders, permits);
    this.addTentacle(owner, personalId, domains, resources, holders, permits, tentacleShares);
    this.addMcpTokens(owner, accountResourceId, holders, permits);
    this.addSharedApps(owner, domains, resources, holders, permits);
    this.addLegacyCrossUser(owner, personalId, domains, resources, holders, permits, coverageNotices);

    const appDefaults = this.appDefaults(owner, canEdit, addResource, addHolder);
    const sortedDomains = [...domains.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const sortedResources = [...resources.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const sortedHolders = [...holders.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const sortedPermits = [...permits.values()].sort((a, b) =>
      `${a.resourceId}\0${a.holderId}\0${a.operation}`.localeCompare(`${b.resourceId}\0${b.holderId}\0${b.operation}`));
    const sortedPolicies = [...policies.values()].sort((a, b) =>
      `${a.resourceId}\0${a.title}\0${a.id}`.localeCompare(`${b.resourceId}\0${b.title}\0${b.id}`));
    const aliases = this.opts.authorization.listResourceAliases({ owner, limit: 2_000 });
    if (aliases.length >= 2_000) {
      throw new Error("resource alias inventory reached the safe projection limit; refusing a partial permission map");
    }
    const sortedAliases = aliases
      .map((alias) => ({ uri: alias.uri, targetUri: alias.targetUri }))
      .sort((a, b) => a.uri.localeCompare(b.uri) || a.targetUri.localeCompare(b.targetUri));
    const coverage = { complete: coverageNotices.length === 0, notices: coverageNotices };
    const revision = digest({
      owner,
      domains: sortedDomains,
      resources: sortedResources,
      holders: sortedHolders,
      permits: sortedPermits,
      policies: sortedPolicies,
      appDefaults,
      aliases: sortedAliases,
      coverage,
    });
    return {
      version: 2,
      username: owner,
      revision,
      coverage,
      domains: sortedDomains,
      resources: sortedResources,
      aliases: sortedAliases,
      holders: sortedHolders,
      permits: sortedPermits,
      policies: sortedPolicies,
      emptyCell: {
        label: "无直接许可",
        explanation: "空白只表示没有这组 resource/holder 的直接许可。可信规则在独立的 Policy Program 区域展示，旧兼容默认会显式投影；执行时仍须把规则、精确许可和实际 Gate 一起裁决。",
      },
      appDefaults,
    };
  }

  explain(input: PermissionStudioExplainInput): PermissionStudioExplainResponse {
    this.assertOpen();
    this.pruneProposals();
    if (input.resourceId === `${DEFAULT_RESOURCE_PREFIX}${input.owner}` && input.holderId === DEFAULT_HOLDER_ID) {
      return this.explainDefault(input);
    }
    const runtimeHolder = parseUserHolder(input.holderId);
    const runtimeState = runtimeHolder && input.operation === "run_agent"
      ? this.opts.agentRuntimes?.permitState(input.owner, input.resourceId, runtimeHolder) ?? null
      : null;
    if (runtimeState && runtimeHolder) {
      return this.explainAgentRuntime(input, runtimeHolder, runtimeState);
    }
    if (input.resourceId !== genericResourceId(input.owner)) {
      throw new Error("这条关系由专用执行面管理；Permission Studio 只能解释，不能在第二处改写它");
    }
    const holder = parseGenericHolder(input.holderId);
    if (!holder) throw new Error("未知许可持有者");
    const entry = this.opts.permissions.subject(holder.type, holder.id);
    const info = entry?.catalog.operation(input.operation);
    const subject = entry?.info;
    if (!entry || !info || !subject?.enforced || !this.opts.permissions.declaredOperations(holder.type, holder.id, input.owner).includes(input.operation)) {
      throw new Error("这个操作没有已接线的授权契约");
    }
    const existing = this.opts.permissions.get(holder.type, holder.id, input.owner);
    if (!entry.userManaged || existing?.source === "config") throw new Error("这条许可是只读的");

    const activeContractDigest = holder.type === "app" && holder.id === SESSION_PLUS_APP_ID
      ? this.opts.activeSessionPlusContractDigest?.() ?? null
      : null;
    const currentMode = modeFor(existing, input.operation, info.alwaysApprove);
    const requested = input.proposedMode ?? currentMode;
    const normalized: PermissionStudioEditableMode = requested === "allow" && (!info.mayAutoAllow || info.alwaysApprove)
      ? "ask"
      : requested;
    const summary = requested !== normalized
      ? "该操作不能静默执行；ALLOW 已规范化为 ASK。"
      : normalized === currentMode
        ? "模式没有变化。"
        : `模式将从 ${currentMode.toUpperCase()} 变为 ${normalized.toUpperCase()}。`;
    const liveEntry = this.opts.permissions.effectiveFor({
      subjectType: holder.type,
      subjectId: holder.id,
      owner: input.owner,
      requested: [input.operation],
      contractDigest: activeContractDigest,
    }).entries[0];
    const environmentBlockers = new Set([
      "device_revoked",
      "account_lacks_operation",
      "agent_narrowed",
      "parent_revoked",
      "unknown_operation",
    ]);
    const blockedByEnvironment = liveEntry?.reasons.some((reason) => environmentBlockers.has(reason)) ?? true;
    const wouldBeEffective = normalized !== "deny" && !blockedByEnvironment;
    const steps = genericSteps({
      owner: input.owner,
      holderTitle: subject.title,
      mode: normalized,
      effective: wouldBeEffective,
      explanation: normalized === "deny"
        ? "应用后不会为这个操作派生 capability。"
        : blockedByEnvironment
          ? `即使应用该配置，当前执行面仍会拒绝：${liveEntry?.explanation ?? "没有可用的资源 authority。"}`
        : normalized === "ask"
          ? "调用会到达真实 Gate，并在需要时产生冻结的批准请求。"
          : "可信 adapter 仍会按资源现状收窄 capability，真实 Gate 再裁决调用。",
      source: "user",
      alwaysApprove: info.alwaysApprove,
    });
    const response: PermissionStudioExplainResponse = {
      verdict: normalized === "deny" ? "拒绝" : normalized === "ask" ? "每次询问" : "默认允许",
      summary,
      steps,
    };
    if (input.proposedMode !== undefined) {
      const proposal: GenericGrantProposal = {
        kind: "generic-grant",
        id: randomUUID(),
        owner: input.owner,
        actor: input.actor,
        subjectType: holder.type,
        subjectId: holder.id,
        operation: input.operation,
        mode: normalized,
        activeContractDigest,
        baseline: genericFingerprint(
          this.opts.permissions,
          input.owner,
          holder.type,
          holder.id,
          activeContractDigest,
        ),
        expiresAt: this.now() + PROPOSAL_TTL_MS,
      };
      this.remember(proposal);
      response.proposal_id = proposal.id;
    }
    return response;
  }

  apply(owner: string, actor: string, proposalId: string): PermissionStudioApplyResponse {
    if (this.closed) return { status: "refused", message: "Permission Studio 已关闭；没有写入任何许可。" };
    this.pruneProposals();
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.owner !== owner || proposal.actor !== actor) {
      return { status: "refused", message: "提案不存在、已过期，或不属于当前用户；没有写入任何许可。" };
    }
    // One shot even on refusal: a reviewed proposal is never replayable.
    this.proposals.delete(proposalId);
    if (proposal.kind === "app-default") return this.applyDefault(proposal);
    if (proposal.kind === "agent-runtime") return this.applyAgentRuntime(proposal);
    const activeContractDigest = proposal.subjectType === "app" && proposal.subjectId === SESSION_PLUS_APP_ID
      ? this.opts.activeSessionPlusContractDigest?.() ?? null
      : null;
    const current = genericFingerprint(
      this.opts.permissions,
      owner,
      proposal.subjectType,
      proposal.subjectId,
      activeContractDigest,
    );
    if (current !== proposal.baseline) {
      return { status: "refused", message: "许可在预演后已经变化；请重新打开并预演，当前提案未应用。" };
    }
    const entry = this.opts.permissions.subject(proposal.subjectType, proposal.subjectId);
    const operationInfo = entry?.catalog.operation(proposal.operation);
    const existing = this.opts.permissions.get(proposal.subjectType, proposal.subjectId, owner);
    if (!entry?.userManaged || !entry.info.enforced || !operationInfo || existing?.source === "config") {
      return { status: "refused", message: "这条许可已不再可编辑；当前提案未应用。" };
    }
    const operations = new Set(existing?.status === "active" ? existing.operations : []);
    const autoAllow = new Set(existing?.status === "active" ? existing.autoAllow : []);
    if (proposal.mode === "deny") {
      operations.delete(proposal.operation);
      autoAllow.delete(proposal.operation);
    } else {
      operations.add(proposal.operation);
      if (proposal.mode === "allow") autoAllow.add(proposal.operation);
      else autoAllow.delete(proposal.operation);
    }
    const sortedOperations = [...operations].sort();
    const covering = proposal.subjectId === SESSION_PLUS_APP_ID
      ? sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, sortedOperations)
      : null;
    this.opts.permissions.grant({
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      owner,
      operations: sortedOperations,
      autoAllow: [...autoAllow].sort(),
      source: "user",
      createdBy: actor,
      ...(proposal.subjectId === SESSION_PLUS_APP_ID && covering
        ? {
            publisher: SESSION_PLUS_PUBLISHER,
            contractDigest: proposal.activeContractDigest ?? covering.digest,
          }
        : entry.grantIdentity
          ? { publisher: entry.grantIdentity.publisher, contractDigest: entry.grantIdentity.contractDigest }
          : {}),
    });
    return { status: "applied", message: "已应用刚才预演的许可；页面会重新读取服务端有效状态。" };
  }

  private addUnenforcedSubject(
    owner: string,
    subject: ReturnType<PermissionService["subjects"]>[number],
    id: string,
    addDomain: (value: PermissionStudioDomain) => void,
    addResource: (value: PermissionStudioResource) => void,
    addPermit: (value: PermissionStudioPermit) => void,
  ): void {
    if (!subject.trustedService) return;
    const domainId = `${STUDIO_NAMESPACE}organization:trusted-host`;
    const resourceId = `${STUDIO_NAMESPACE}trusted-host:developer-account`;
    addDomain({
      id: domainId,
      title: "受信主机域",
      kind: "organization",
      authorityLabel: "部署与 OS 管理员",
      historyPolicy: "not_applicable",
      description: "主机进程权限不由个人 grant 表约束。",
    });
    addResource({
      id: resourceId,
      uri: resourceUri("file", "octopus", owner, "host"),
      title: "bot 进程可达的主机资源",
      kind: "trusted-host",
      domainId,
      authorityLabel: "部署与 OS 管理员",
      sensitivity: "credential",
      sourceSystem: "trusted-service-composition",
      enforcement: "unenforced",
      description: "工作目录是约定，不是沙箱；这里显示风险，但不能伪装成可撤销的普通许可。",
    });
    const steps: PermissionStudioExplainStep[] = [
      { stage: "authority", title: "部署准入", detail: subject.trustedService.boundaries.join("；"), verdict: "受信" },
      { stage: "domain_audience", title: "主机 OS 域", detail: "不是 owner 的个人 capability 子树。", verdict: "域外" },
      { stage: "permit_ceiling", title: "没有普通 App 安装上限", detail: "这项权限不来自 grant_intents。", verdict: "不可在此编辑" },
      { stage: "enforcement", title: "进程权限", detail: "实际边界是进程 OS 账号、准入和部署门；本页不能撤销。", verdict: "受信系统服务" },
    ];
    addPermit({
      id: `trusted:${subject.type}:${subject.id}`,
      resourceId,
      holderId: id,
      operation: "trusted_host_access",
      operationLabel: "主机开发者级访问",
      mode: "allow",
      verdict: "受信系统服务可通过进程 OS 权限访问；不受本权限引擎约束。",
      editable: false,
      readonlyReason: "只能通过收紧部署/OS 准入来改变，不能在本页伪装成已撤销。",
      explanation: { verdict: "受信系统服务", steps },
    });
  }

  private addCanonical(
    owner: string,
    domains: Map<string, PermissionStudioDomain>,
    resources: Map<string, PermissionStudioResource>,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
    policies: Map<string, PermissionStudioPolicy>,
    tentacleShares: readonly TentacleShareView[],
    agentRuntimeIds: ReadonlySet<string>,
  ): void {
    const canonicalResources = this.opts.authorization.listResources({ owner, limit: 2_000 });
    if (canonicalResources.length >= 2_000) {
      throw new Error("canonical resource inventory reached the safe projection limit; refusing a partial permission map");
    }
    const wiredTentacleObjects = new Set(tentacleShares.map((share) => share.objectId));
    const wiredTentacleRelations = new Set(tentacleShares.map((share) => {
      const operation = share.kind === "tool" ? TENTACLE_INVOKE_OPERATION : TENTACLE_READ_EVENT_OPERATION;
      return `${share.objectId}\0user\0${share.viewer}\0${operation}`;
    }));
    for (const resource of canonicalResources) {
      const domain = this.opts.authorization.getDomain(resource.domainId);
      if (!domain) continue;
      const agentRuntimeWired = agentRuntimeIds.has(resource.id);
      const wired = agentRuntimeWired || (
        resource.externalRef.system === "tentacle"
        && wiredTentacleObjects.has(resource.externalRef.id)
      );
      domains.set(domain.id, {
        id: domain.id,
        title: domain.title,
        kind: domain.kind,
        authorityLabel: authorityLabel(domain.authority.kind, domain.authority.id),
        historyPolicy: domain.historyPolicy,
        description: domain.historyPolicy === "since_join"
          ? "策略声明从加入时起；消费者只有在持有真实事件序列边界时才可启用。"
          : "该域向当前成员开放完整现有状态；每个 consumer 仍需再次检查成员关系。",
      });
      resources.set(resource.id, {
        id: resource.id,
        uri: resource.uri,
        title: resource.title,
        kind: resource.kind,
        domainId: resource.domainId,
        authorityLabel: authorityLabel(domain.authority.kind, domain.authority.id),
        sensitivity: resource.sensitivity,
        sourceSystem: agentRuntimeWired
          ? `${resource.externalRef.system} + exact run_agent permit + split placement`
          : resource.externalRef.system,
        enforcement: wired ? "enforced" : "intent-only",
        description: agentRuntimeWired
          ? "共享资源只路由 provider 进程；每次启动/续跑重查精确许可与积分，workspace、文件和 shell 始终留在持有者自己的 Runner。"
          : wired
          ? "Tentacle adapter 已为至少一条精确 user viewer 关系接线；每条许可仍需看关系级执行状态，App、Agent、service 与 owner-self 不会继承。"
          : resource.externalRef.system === "tentacle"
            ? "Tentacle adapter 或当前 Object 不存在；持久许可只作为 intent 展示。"
            : "已注册 canonical 资源；尚未标记可信执行 adapter 的关系只作为 intent 展示。",
      });
      const resourceRules = this.opts.authorization.listRulesForResource(resource.id);
      const resourcePermits = this.opts.authorization.listPermits({ resourceId: resource.id, limit: 2_000 });
      if (resourcePermits.length >= 2_000) {
        throw new Error(`canonical permit inventory for ${resource.id} reached the safe projection limit; refusing a partial permission map`);
      }
      for (const permit of resourcePermits) {
        // The dedicated adapter below projects both ALLOW and the otherwise
        // invisible DENY cells and owns their frozen mutation path.
        if (agentRuntimeWired && permit.operation === "run_agent" && permit.subject.type === "user") continue;
        const permitWired = resource.externalRef.system === "tentacle"
          && wiredTentacleRelations.has(
            `${resource.externalRef.id}\0${permit.subject.type}\0${permit.subject.id}\0${permit.operation}`,
          );
        const id = holderId(permit.subject.type, permit.subject.id);
        if (!holders.has(id)) {
          holders.set(id, {
            id,
            title: permit.subject.id,
            kind: permit.subject.type,
            description: "canonical exact permit 持有者",
          });
        }
        const decision = this.opts.authorization.decideAccess({
          subject: permit.subject,
          resourceId: resource.id,
          operation: permit.operation,
        });
        const verdict = permitWired
          ? `精确许可配置为 ${permit.mode.toUpperCase()}；当前无请求 facts 的 canonical 预览为 ${decision.result.toUpperCase()}。Tentacle 会在派生 capability 前重算，规则只能继续收窄。`
          : `记录的精确意图为 ${permit.mode.toUpperCase()}，但尚未接入执行 adapter。`;
        permits.set(`canonical:${permit.id}`, {
          id: `canonical:${permit.id}`,
          resourceId: resource.id,
          holderId: id,
          operation: permit.operation,
          operationLabel: permit.operation,
          mode: permit.mode,
          verdict,
          editable: false,
          readonlyReason: permitWired ? "由下方精确对象分享控制管理。" : "尚未接入执行路径，不能在 UI 声称已授权。",
          explanation: { verdict, steps: decisionSteps(decision) },
        });
      }
      for (const rule of resourceRules) {
        const ruleHandle = opaqueHandle("authorization-rule", rule.id);
        const policyId = `policy:${ruleHandle}:${opaqueHandle("policy-resource", resource.id)}`;
        const conditional = rule.when ? describePolicyCondition(rule.when) : null;
        const subjectTypes = describeSelector(rule.match.subjectTypes, "所有主体类型");
        const subjectIds = describeSelector(rule.match.subjectIds, "所有主体 ID");
        const subjectSelector = `${subjectTypes}；${subjectIds}`;
        const operationSelector = describeSelector(rule.match.operations, "所有操作");
        // A rule is not a concrete Tentacle viewer relation. The current
        // adapter rechecks rules only for exact permit tuples and supplies no
        // business facts/hierarchy, so the program inventory stays intent-only
        // until a consumer explicitly attests those capabilities.
        const enforcement = "intent-only" as const;
        const verdict = conditional
          ? `尚未求值：配置效果为 ${rule.effect.toUpperCase()}，需要真实运行时事实。`
          : `静态规则配置为 ${rule.effect.toUpperCase()}；最终仍与精确许可和执行 Gate 合并裁决。`;
        policies.set(policyId, {
          id: policyId,
          title: rule.title,
          resourceId: resource.id,
          authorityLabel: authorityLabel(rule.authority.kind, rule.authority.id),
          effect: rule.effect,
          mandatory: Boolean(rule.mandatory),
          subjectSelector,
          operationSelector,
          condition: conditional,
          verdict,
          enforcement,
          explanation: {
            verdict,
            summary: rule.explanation,
            steps: [
              {
                stage: "authority",
                title: authorityLabel(rule.authority.kind, rule.authority.id),
                detail: rule.mandatory ? "组织 mandatory rule；个人许可不能放宽。" : "可信组合代码提供的 policy program。",
                verdict: rule.mandatory ? "mandatory" : "trusted",
              },
              {
                stage: "domain_audience",
                title: "主体 / 资源选择器",
                detail: `主体：${subjectSelector}；资源：${resource.title}（${domain.title}）；操作：${operationSelector}。`,
                verdict: "selector inventory",
              },
              {
                stage: "permit_ceiling",
                title: conditional ? "运行时条件尚未求值" : "静态规则效果",
                detail: conditional ?? rule.explanation,
                verdict: conditional ? "unknown until runtime" : rule.effect,
              },
              {
                stage: "enforcement",
                title: "执行接线",
                detail: wired
                  ? "Tentacle 只会为 exact permit tuple 重算规则，且当前不提供业务 facts/hierarchy；rule-only 或条件 program 尚未证明完整执行。"
                  : "当前资源没有已证明的执行 adapter；该规则是 intent-only。",
                verdict: enforcement,
              },
            ],
          },
        });
      }
    }
  }

  private addAgentRuntimes(
    owner: string,
    canEdit: boolean,
    runtimeResources: readonly AuthorizationResource[],
    resources: Map<string, PermissionStudioResource>,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
  ): void {
    if (!this.opts.agentRuntimes || runtimeResources.length === 0) return;
    const users = this.opts.store.loadUsers().filter((user) => user.username !== owner).slice(0, 200);
    for (const user of users) {
      const id = holderId("user", user.username);
      if (!holders.has(id)) holders.set(id, { id, title: user.username, kind: "user", description: "Octopus 用户 / Agent 积分持有者" });
    }
    for (const resource of runtimeResources) {
      if (!resources.has(resource.id)) continue;
      for (const user of users) {
        const state = this.opts.agentRuntimes.permitState(owner, resource.id, user.username);
        if (!state) continue;
        const mode: PermissionStudioEditableMode = state.configured ? "allow" : "deny";
        const verdict = !state.configured
          ? "拒绝：没有该用户 × 该运行机 × run_agent 的精确许可。"
          : !state.available
            ? "已配置 ALLOW，但该运行机当前不在 owner 的设备清单中；不会派发。"
          : state.effective
            ? "允许启动或续跑共享 Agent；执行工作区仍强制绑定该用户自己的 Runner，且派发前会重查积分。"
            : "已配置 ALLOW，但 canonical 规则当前仍拒绝；不会派发。";
        permits.set(`agent-runtime:${resource.id}:${user.username}`, {
          id: `agent-runtime:${resource.id}:${user.username}`,
          resourceId: resource.id,
          holderId: holderId("user", user.username),
          operation: "run_agent",
          operationLabel: "使用共享 Agent 算力",
          mode,
          verdict,
          editable: canEdit,
          ...(!canEdit ? { readonlyReason: "只有运行机 owner 本人可以授予或撤销。" } : {}),
          explanation: {
            verdict,
            steps: agentRuntimeSteps(owner, user.username, mode, state.effective),
          },
        });
      }
    }
  }

  private explainAgentRuntime(
    input: PermissionStudioExplainInput,
    username: string,
    state: AgentRuntimePermitState,
  ): PermissionStudioExplainResponse {
    const requested = input.proposedMode ?? (state.configured ? "allow" : "deny");
    // There is deliberately no approval callback on this unattended provider
    // path. ASK must fail closed rather than silently acquiring ALLOW semantics.
    const normalized: PermissionStudioEditableMode = requested === "allow" ? "allow" : "deny";
    const summary = requested === "ask"
      ? "共享 Agent 没有逐次 ASK 执行面；ASK 已规范化为 DENY。"
      : normalized === (state.configured ? "allow" : "deny")
        ? "模式没有变化。"
        : `模式将从 ${state.configured ? "ALLOW" : "DENY"} 变为 ${normalized.toUpperCase()}。`;
    // A missing exact permit is itself why today's decision is DENY. Preview
    // the proposed tuple as wired; apply and every dispatch still recompute
    // the real canonical decision, so a trusted mandatory rule can only
    // narrow this optimistic explanation.
    const effective = normalized === "allow";
    const response: PermissionStudioExplainResponse = {
      verdict: normalized === "allow" ? "允许" : "拒绝",
      summary,
      steps: agentRuntimeSteps(input.owner, username, normalized, effective),
    };
    if (input.proposedMode !== undefined) {
      const proposal: AgentRuntimeProposal = {
        kind: "agent-runtime",
        id: randomUUID(),
        owner: input.owner,
        actor: input.actor,
        resourceId: input.resourceId,
        username,
        allow: normalized === "allow",
        baseline: state.fingerprint,
        expiresAt: this.now() + PROPOSAL_TTL_MS,
      };
      this.remember(proposal);
      response.proposal_id = proposal.id;
    }
    return response;
  }

  private applyAgentRuntime(proposal: AgentRuntimeProposal): PermissionStudioApplyResponse {
    const current = this.opts.agentRuntimes?.permitState(proposal.owner, proposal.resourceId, proposal.username);
    if (!current || current.fingerprint !== proposal.baseline) {
      return { status: "refused", message: "共享 Agent 许可在预演后已经变化；请重新预演，当前提案未应用。" };
    }
    try {
      this.opts.agentRuntimes!.setRuntimePermit(
        proposal.owner,
        proposal.resourceId,
        proposal.username,
        proposal.allow,
        proposal.actor,
      );
      return {
        status: "applied",
        message: proposal.allow
          ? "已授予精确 run_agent 许可；实际派发仍要求正积分与用户自己的执行 Runner。"
          : "已撤销精确 run_agent 许可；新的启动和续跑会立即拒绝。",
      };
    } catch (error) {
      return { status: "refused", message: error instanceof Error ? error.message : "共享 Agent 许可未应用。" };
    }
  }

  private addTentacle(
    owner: string,
    personalId: string,
    _domains: Map<string, PermissionStudioDomain>,
    resources: Map<string, PermissionStudioResource>,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
    shares: readonly TentacleShareView[],
  ): void {
    const canonicalResources = this.opts.authorization.listResources({ owner, limit: 2_000 });
    if (canonicalResources.length >= 2_000) {
      throw new Error("canonical Tentacle lookup reached the safe projection limit; refusing a partial permission map");
    }
    const canonicalByObject = new Map(canonicalResources
      .filter((resource) => resource.externalRef.system === "tentacle")
      .map((resource) => [resource.externalRef.id, resource]));
    for (const share of shares) {
      const canonical = canonicalByObject.get(share.objectId);
      const resourceId = canonical?.id ?? `${STUDIO_NAMESPACE}compat-tentacle:${share.objectId}`;
      if (!resources.has(resourceId)) {
        resources.set(resourceId, {
          id: resourceId,
          uri: canonical?.uri ?? resourceUri(
            "tool",
            "dsh",
            owner,
            share.device,
            share.kind === "tool" ? "tools" : "projections",
            share.resourceKey,
          ),
          title: share.kind === "tool" ? `dsh 工具 · ${share.resourceKey}` : "dsh 会话只读视图",
          kind: share.kind === "tool" ? "tool" : "live-view",
          domainId: canonical?.domainId ?? personalId,
          authorityLabel: `资源 owner · ${owner}`,
          sensitivity: "sensitive",
          sourceSystem: canonical ? "tentacle + canonical-permit" : "legacy grant_intents + tentacle",
          enforcement: "enforced",
          description: "对象/schema 被固定；许可通过 Tentacle capability adapter 和 kernel Gate 执行。",
        });
      }
      const id = holderId("user", share.viewer);
      if (!holders.has(id)) holders.set(id, { id, title: share.viewer, kind: "user", description: "精确对象分享接收者" });
      const operation = share.kind === "tool" ? TENTACLE_INVOKE_OPERATION : TENTACLE_READ_EVENT_OPERATION;
      const relationId = `tentacle:${share.viewer}:${share.objectId}:${operation}`;
      // Prefer the execution-aware share view over the intent-only canonical row.
      for (const [key, value] of permits) {
        if (value.resourceId === resourceId && value.holderId === id && value.operation === operation) permits.delete(key);
      }
      permits.set(relationId, this.tentaclePermit(resourceId, id, operation, share));
    }
  }

  private tentaclePermit(
    resourceId: string,
    holder: string,
    operation: string,
    share: TentacleShareView,
  ): PermissionStudioPermit {
    const current = share.status === "active" && share.effective;
    const verdict = current ? "精确分享当前有效；调用仍需经过固定 schema 的 kernel Gate。" : share.explanation;
    return {
      id: `tentacle:${share.viewer}:${share.objectId}:${operation}`,
      resourceId,
      holderId: holder,
      operation,
      operationLabel: share.kind === "tool" ? `调用 ${share.resourceKey}` : "读取裁剪后的投影事件",
      mode: share.mode,
      verdict,
      editable: false,
      readonlyReason: "请在下方“精确对象分享”控制区撤销或重新分享，避免双写。",
      compatibility: !resourceId.startsWith("resource:tentacle:"),
      explanation: {
        verdict,
        steps: [
          { stage: "authority", title: "对象 owner", detail: `${share.owner} 铸造了固定 schema Object。`, verdict: "通过" },
          { stage: "domain_audience", title: "精确受众", detail: `只分享给 ${share.viewer}，不是账户通配共享。`, verdict: "精确" },
          { stage: "permit_ceiling", title: "对象级许可", detail: share.explanation, verdict: share.mode },
          { stage: "enforcement", title: "Tentacle → capability kernel", detail: "adapter 固定对象、操作和 viewer 后派生 Context；Gate 再校验参数与条款。", verdict: current ? "当前有效" : "不可用" },
        ],
      },
    };
  }

  private addMcpTokens(
    owner: string,
    resourceId: string,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
  ): void {
    const nowIso = new Date(this.now()).toISOString();
    for (const token of this.opts.store.listMcpTokens(owner)) {
      const handle = opaqueHandle("mcp-token", token.token_hash);
      const id = holderId("credential", `mcp-${handle}`);
      const active = !token.revoked_at && (!token.expires_at || token.expires_at > nowIso);
      holders.set(id, {
        id,
        title: `${token.label} · ${handle}`,
        kind: "credential",
        description: "单向句柄；页面不会暴露 token、token hash 或 capability Context。",
      });
      let groups: readonly string[] = ["legacy-all-composed"];
      let appSummary: string | null = null;
      try {
        const policy = decodeMcpTokenPolicy(token.policy_json);
        if (policy) {
          groups = policy.groups;
          const selectorCount = (policy.apps?.ids?.length ?? 0)
            + (policy.apps?.instances?.length ?? 0)
            + (policy.apps?.actions?.length ?? 0);
          if (selectorCount) appSummary = `${selectorCount} 个 App/实例/action 选择器（值不在此投影展开）`;
        }
      } catch {
        groups = ["invalid-policy"];
      }
      for (const group of groups) {
        const operation = `mcp-group:${group}`;
        const verdict = !active
          ? "凭据已撤销或过期。"
          : group === "invalid-policy"
            ? "策略无法解析；认证路径会失败关闭。"
            : "凭据策略允许尝试该工具组；账户/App grant、资源范围与 Gate 仍会继续收窄。";
        permits.set(`mcp:${handle}:${operation}`, {
          id: `mcp:${handle}:${operation}`,
          resourceId,
          holderId: id,
          operation,
          operationLabel: group === "legacy-all-composed" ? "旧令牌：全部当前 MCP 工具组" : `MCP 工具组 · ${group}`,
          mode: active && group !== "invalid-policy" ? "allow" : "deny",
          verdict,
          editable: false,
          readonlyReason: "请在下方 MCP 凭据控制区签发收窄令牌或撤销旧令牌。",
          compatibility: true,
          explanation: {
            verdict,
            summary: appSummary ?? undefined,
            steps: [
              { stage: "authority", title: "owner 签发的凭据", detail: `只显示单向句柄 ${handle}；原始凭据不存储也不投影。`, verdict: active ? "active" : "inactive" },
              { stage: "domain_audience", title: "owner 账户域", detail: "令牌不能把账户本身不持有的能力变出来。", verdict: "attenuation" },
              { stage: "permit_ceiling", title: "MCP token policy", detail: appSummary ? `${group}；${appSummary}` : group, verdict: active ? "allow" : "deny" },
              { stage: "enforcement", title: "凭据认证 + provider/Gate", detail: verdict, verdict: active ? "继续检查" : "拒绝" },
            ],
          },
        });
      }
    }
  }

  private addSharedApps(
    owner: string,
    domains: Map<string, PermissionStudioDomain>,
    resources: Map<string, PermissionStudioResource>,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
  ): void {
    for (const app of this.opts.store.appCatalog.listAppDeclarations()) {
      for (const instance of this.opts.store.listSharedAppInstancesFor(app.app_id, owner)) {
        const handle = opaqueHandle("shared-app", `${app.app_id}\0${instance.instance_key}`);
        const domainId = `${STUDIO_NAMESPACE}workspace:${app.app_id}:${handle}`;
        const resourceId = `${STUDIO_NAMESPACE}shared-app-state:${app.app_id}:${handle}`;
        domains.set(domainId, {
          id: domainId,
          title: `${app.title} 共享工作区`,
          kind: "workspace",
          authorityLabel: `工作区创建者 · ${instance.creator}`,
          historyPolicy: "all",
          description: "当前 shared App 是 folded state；新成员会看到完整现有状态。没有事件序列边界前不能声称 since_join。",
        });
        resources.set(resourceId, {
          id: resourceId,
          uri: resourceUri("object", "apps", owner, app.app_id, handle, "state"),
          title: `${app.title} 的共享状态`,
          kind: "app-shared-state",
          domainId,
          authorityLabel: `工作区创建者 · ${instance.creator}`,
          sensitivity: "normal",
          sourceSystem: "app_shared_instances/members",
          enforcement: "compatibility",
          description: "AppInstanceService 在每次 open/action 时重查成员与角色；这里不展开邀请 key。",
        });
        let visibleMembers: SharedAppMemberRow[];
        if (instance.creator === owner) {
          visibleMembers = this.opts.store.listSharedAppMembers(app.app_id, instance.instance_key);
        } else {
          const ownMembership = this.opts.store.getSharedAppMember(app.app_id, instance.instance_key, owner);
          visibleMembers = ownMembership ? [ownMembership] : [];
        }
        for (const member of visibleMembers) {
          const id = holderId("user", member.username);
          if (!holders.has(id)) holders.set(id, { id, title: member.username, kind: "user", description: "共享 App 成员" });
          const operation = `role:${member.role}`;
          const active = instance.status === "open";
          const verdict = active ? `成员当前以 ${member.role} 角色访问；每次动作仍由 App 的角色契约检查。` : "共享实例已关闭。";
          permits.set(`shared-app:${handle}:${member.username}:${member.role}`, {
            id: `shared-app:${handle}:${member.username}:${member.role}`,
            resourceId,
            holderId: id,
            operation,
            operationLabel: `以 ${member.role} 角色访问`,
            mode: active ? "allow" : "deny",
            verdict,
            editable: false,
            readonlyReason: "请在该共享 App 的成员管理界面调整，避免绕过角色 seat 与 App 契约。",
            compatibility: true,
            explanation: {
              verdict,
              steps: [
                { stage: "authority", title: "工作区权限源", detail: `实例由 ${instance.creator} 创建。`, verdict: "workspace" },
                { stage: "domain_audience", title: "成员表", detail: `${member.username} 于 ${member.joined_at} 加入。历史策略是 all。`, verdict: member.role },
                { stage: "permit_ceiling", title: "App 声明角色", detail: `角色 ${member.role} 只能执行 App 契约显式允许的 action。`, verdict: active ? "allow" : "deny" },
                { stage: "enforcement", title: "AppInstanceService", detail: "open 和每次 action 都重新检查成员关系；浏览器不参与判权。", verdict: active ? "当前有效" : "实例关闭" },
              ],
            },
          });
        }
      }
    }
  }

  private addLegacyCrossUser(
    owner: string,
    personalId: string,
    _domains: Map<string, PermissionStudioDomain>,
    resources: Map<string, PermissionStudioResource>,
    holders: Map<string, PermissionStudioHolder>,
    permits: Map<string, PermissionStudioPermit>,
    coverageNotices: string[],
  ): void {
    const allUsers = this.opts.store.loadUsers().filter((user) => user.username !== owner);
    const explicitRows = this.opts.store.listCrossUserAclByTarget(owner);
    const explicitAskers = new Set(explicitRows.map((row) => row.asker_username));
    const users = allUsers.filter((user) => explicitAskers.has(user.username));
    const selectedIds = new Set(users.map((user) => user.username));
    for (const user of allUsers) {
      if (selectedIds.has(user.username) || users.length >= MAX_LEGACY_CROSS_USER_HOLDERS) continue;
      users.push(user);
      selectedIds.add(user.username);
    }
    const omitted = allUsers.length - users.length;
    if (omitted > 0) {
      coverageNotices.push(
        `旧跨用户兼容面还有 ${omitted} 个没有显式 ACL 的默认 ASK 关系未展开；所有显式 ACL 均已显示。`,
      );
    }
    if (users.length === 0) return;
    const resourceId = `${STUDIO_NAMESPACE}compat-cross-user-query:${owner}`;
    resources.set(resourceId, {
      id: resourceId,
      uri: resourceUri("object", "compat", owner, "cross-user-query"),
      title: "旧跨用户历史 / 文档查询面",
      kind: "legacy-cross-user-query",
      domainId: personalId,
      authorityLabel: `资源 owner · ${owner}`,
      sensitivity: "sensitive",
      sourceSystem: "cross_user_acl + router compatibility default",
      enforcement: "compatibility",
      description: "只覆盖 Router 的飞书/文档/会话历史桥，不代表本地 workspace 或任意文件访问。",
    });
    const explicit = new Map(explicitRows.map((row) => [row.asker_username, row]));
    for (const user of users) {
      const id = holderId("user", user.username);
      if (!holders.has(id)) holders.set(id, { id, title: user.username, kind: "user", description: "Octopus 用户" });
      const row = explicit.get(user.username);
      const allowed = row ? new Set(safeJsonArray(row.allowed_tools)) : new Set(["history", "files"]);
      for (const operation of ["history", "files"] as const) {
        const isAllowed = allowed.has(operation);
        const asks = isAllowed && (!row || row.require_approval === 1);
        const mode: PermissionStudioEditableMode = !isAllowed ? "deny" : asks ? "ask" : "allow";
        const compatibilityDefault = !row;
        const verdict = !isAllowed
          ? "旧 ACL 行明确没有这个工具；Router 会拒绝。"
          : asks
            ? compatibilityDefault
              ? "旧兼容默认：没有 ACL 行仍可提出请求，但每一次都必须由资源 owner 审批。"
              : "ACL 允许提出请求；每一次都必须由资源 owner 审批。"
            : "旧 ACL 明确允许且不要求逐次审批。";
        permits.set(`cross-user:${owner}:${user.username}:${operation}`, {
          id: `cross-user:${owner}:${user.username}:${operation}`,
          resourceId,
          holderId: id,
          operation,
          operationLabel: operation === "history" ? "查询会话历史" : "查询飞书 / 云文档资料",
          mode,
          verdict,
          editable: false,
          readonlyReason: "旧 Router ACL 尚未迁入 canonical command path；本页只揭示实际行为。",
          compatibility: true,
          explanation: {
            verdict,
            steps: [
              { stage: "authority", title: "旧 Router 策略", detail: compatibilityDefault ? "没有 ACL 行，命中历史兼容默认。" : "命中显式 cross_user_acl 行。", verdict: compatibilityDefault ? "compat default" : "explicit" },
              { stage: "domain_audience", title: "精确用户对", detail: `${user.username} → ${owner}；不覆盖其他请求者。`, verdict: "pair-bound" },
              { stage: "permit_ceiling", title: operation === "history" ? "history" : "files", detail: verdict, verdict: mode },
              { stage: "enforcement", title: "Router + owner approval", detail: "请求在执行前重查 ACL；ASK 创建 owner 的批准请求。", verdict: mode },
            ],
          },
        });
      }
    }
  }

  private appDefaults(
    owner: string,
    canEdit: boolean,
    addResource: (value: PermissionStudioResource) => void,
    addHolder: (value: PermissionStudioHolder) => void,
  ) {
    const stored = this.opts.authorization.getAppInstallDefaults(owner);
    const resourceId = `${DEFAULT_RESOURCE_PREFIX}${owner}`;
    addResource({
      id: resourceId,
      uri: resourceUri("object", "policies", owner, "app-install-defaults"),
      title: "新 App 授权草稿默认值",
      kind: "policy-defaults",
      domainId: personalDomainId(owner),
      authorityLabel: `资源 owner · ${owner}`,
      sensitivity: "normal",
      sourceSystem: stored.source === "saved" ? "authorization_owner_defaults" : "built-in defaults",
      enforcement: "intent-only",
      description: "只预填下一次安装授权；读取它永远不会为 App 派生 capability。",
    });
    addHolder({
      id: DEFAULT_HOLDER_ID,
      title: "下一款新 App",
      kind: "app",
      description: "占位符，不是已安装主体，也没有任何权限。",
    });
    const permits = DEFAULT_OPERATIONS.map((operation): PermissionStudioPermit => {
      const mode = defaultMode(stored.profile, operation);
      const fixed = operation === "observe" || operation === "read";
      const explanation = defaultExplanation(owner, operation, mode);
      return {
        id: `app-default:${owner}:${operation}`,
        resourceId,
        holderId: DEFAULT_HOLDER_ID,
        operation,
        operationLabel: defaultLabel(operation),
        mode,
        verdict: explanation.verdict,
        editable: canEdit && !fixed,
        ...(fixed ? { readonlyReason: "owner 自有数据的观察/读取草稿默认固定为 ALLOW；每个 App 仍须一次安装确认。" } : !canEdit ? { readonlyReason: "只有 owner 能修改自己的新 App 草稿默认值。" } : {}),
        explanation,
      };
    });
    return {
      title: "新 App 默认",
      description: "保存为通用 App 安装授权草稿的候选默认值；当前安装流程尚未消费它，也不会修改任何现有 App。",
      permits,
    };
  }

  private explainDefault(input: PermissionStudioExplainInput): PermissionStudioExplainResponse {
    if (!DEFAULT_OPERATIONS.includes(input.operation as DefaultOperation)) throw new Error("未知 App 默认类别");
    const operation = input.operation as DefaultOperation;
    const stored = this.opts.authorization.getAppInstallDefaults(input.owner);
    const current = defaultMode(stored.profile, operation);
    const mode = input.proposedMode ?? current;
    const explanation = defaultExplanation(input.owner, operation, mode);
    const response: PermissionStudioExplainResponse = {
      verdict: explanation.verdict,
      summary: mode === current ? "默认值没有变化。" : `草稿默认将从 ${current.toUpperCase()} 变为 ${mode.toUpperCase()}。`,
      steps: explanation.steps,
    };
    if (input.proposedMode !== undefined) {
      if (operation === "observe" || operation === "read") throw new Error("观察/读取默认值固定为 allow");
      const proposal: AppDefaultProposal = {
        kind: "app-default",
        id: randomUUID(),
        owner: input.owner,
        actor: input.actor,
        operation,
        mode,
        baseline: digest(stored),
        expiresAt: this.now() + PROPOSAL_TTL_MS,
      };
      this.remember(proposal);
      response.proposal_id = proposal.id;
    }
    return response;
  }

  private applyDefault(proposal: AppDefaultProposal): PermissionStudioApplyResponse {
    const current = this.opts.authorization.getAppInstallDefaults(proposal.owner);
    if (digest(current) !== proposal.baseline) {
      return { status: "refused", message: "新 App 默认值在预演后已经变化；请重新预演。" };
    }
    const next = {
      writeMode: proposal.operation === "modify" ? proposal.mode : current.profile.writeMode,
      executeMode: proposal.operation === "execute" ? proposal.mode : current.profile.executeMode,
    };
    this.opts.authorization.setAppInstallDefaults(proposal.owner, next, proposal.actor);
    return { status: "applied", message: "已更新未来 App 安装草稿的默认值；现有 App 权限没有变化。" };
  }

  private remember(proposal: StudioProposal): void {
    const sameOwner = [...this.proposals.entries()].filter(([, current]) => current.owner === proposal.owner);
    if (sameOwner.length >= MAX_PROPOSALS_PER_OWNER) this.proposals.delete(sameOwner[0]![0]);
    if (this.proposals.size >= MAX_PROPOSALS_TOTAL) {
      throw new Error("Permission Studio proposal capacity is full; existing users' proposals were not evicted");
    }
    this.proposals.set(proposal.id, proposal);
  }

  private pruneProposals(): void {
    const now = this.now();
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id);
    }
  }
}
