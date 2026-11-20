/** Stable, dependency-free vocabulary and codec for `mcp-token-policy/v1`. */
export const MCP_TOOL_GROUPS = [
  "sessions",
  "workspace",
  "crdt",
  "memory",
  "skills",
  "apps",
  "feishu",
  "tentacle",
  "execution",
  "knowledge",
  "discussions",
  "transcription",
  "runner_capabilities",
] as const;

export type McpToolGroup = typeof MCP_TOOL_GROUPS[number];

/** Account tools shared by the local Runner bridge and managed agents. */
export const MCP_AGENT_ACCOUNT_TOOL_GROUPS = ["sessions", "feishu", "discussions", "transcription", "runner_capabilities"] as const;

export const MCP_TOKEN_POLICY_SCHEMA = "mcp-token-policy/v1" as const;

/** Generic tokens attenuate account grants; internal scopes also require a live issuer. */
export interface McpTokenPolicy {
  schema: typeof MCP_TOKEN_POLICY_SCHEMA;
  groups: readonly McpToolGroup[];
  apps?: {
    ids?: readonly string[];
    instances?: readonly string[];
    actions?: readonly string[];
  };
  /** Internal ticket authority; never accepted by the public token mint route. */
  ticketDevelopment?: {
    ticketId: number;
    turn: number;
    developmentId: string;
  };
  /** Present only on an internally minted, post-Gate session credential. */
  sessionExecution?: {
    operationId: string;
    runtimeDevice: string;
    executionDevice: string;
    workspaceId: string;
    /**
     * `read_only`: a Feishu document assistant (`feishu/doc-assistants.ts`).
     * Its tools are the three workspace reads and the shared-document tools
     * of `docShare`, nothing else; the groups are exactly ["workspace"]. A
     * decoder that predates the value refuses it, so a rollback fails closed.
     */
    permissionProfile: "full_access" | "manual" | "read_only";
    /** read_only only: the one via='assistant' document share it reaches. */
    docShare?: string;
  };
  /**
   * Internal: one Feishu document share link (`feishu/doc-share.ts`). The
   * token reaches the shared-document tools of that one share and nothing
   * else; never accepted by the public mint route.
   */
  feishuDocShare?: {
    shareId: string;
  };
}

const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A Feishu document share id, as `feishu/doc-share.ts` mints it. */
export const FEISHU_DOC_SHARE_ID = /^shr_[0-9a-f]{24}$/;
/**
 * Every field a stored policy may carry. The decoder rebuilds a policy from
 * the fields it knows, so a field it does not know — a restriction added by a
 * newer version, or corruption — would be dropped and the token would become
 * broader. Such a policy is refused instead.
 */
const POLICY_FIELDS: ReadonlySet<string> = new Set(["schema", "groups", "apps", "ticketDevelopment", "sessionExecution", "feishuDocShare"]);
const APP_SELECTOR_FIELDS: ReadonlySet<string> = new Set(["ids", "instances", "actions"]);
/** The same refusal one level down: an unknown restriction inside the execution scope is not dropped. */
const EXECUTION_FIELDS: ReadonlySet<string> = new Set(["operationId", "runtimeDevice", "executionDevice", "workspaceId", "permissionProfile", "docShare"]);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function names(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error("MCP policy allowlist 无效");
  const out = [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error("MCP policy allowlist 只能包含字符串");
    const name = item.trim();
    if (!name || name.length > maxLength || !POLICY_NAME.test(name)) throw new Error("MCP policy allowlist 名称无效");
    return name;
  }))].sort();
  return out;
}

/** Build the canonical v1 policy accepted by both the mint route and decoder. */
export function mcpTokenPolicy(input: {
  groups?: unknown;
  appIds?: unknown;
  appInstances?: unknown;
  appActions?: unknown;
}): McpTokenPolicy {
  const rawGroups = input.groups ?? [...MCP_TOOL_GROUPS];
  if (!Array.isArray(rawGroups) || rawGroups.length > MCP_TOOL_GROUPS.length) throw new Error("工具组列表无效");
  const groups = [...new Set(rawGroups.map((group) => {
    if (typeof group !== "string" || !(MCP_TOOL_GROUPS as readonly string[]).includes(group)) {
      throw new Error(`未知 MCP 工具组：${String(group)}`);
    }
    return group as McpToolGroup;
  }))];
  if (!groups.length) throw new Error("至少选择一个 MCP 工具组");
  const ids = names(input.appIds, 32, 64);
  const instances = names(input.appInstances, 64, 96);
  const actions = names(input.appActions, 64, 64);
  const hasAppSelectors = ids !== undefined || instances !== undefined || actions !== undefined;
  return {
    schema: MCP_TOKEN_POLICY_SCHEMA,
    groups,
    ...(hasAppSelectors ? { apps: { ...(ids !== undefined ? { ids } : {}), ...(instances !== undefined ? { instances } : {}), ...(actions !== undefined ? { actions } : {}) } } : {}),
  };
}

/** NULL is the explicit backward-compatible pre-v38 policy: no attenuation. */
export function decodeMcpTokenPolicy(encoded: string | null): McpTokenPolicy | undefined {
  if (encoded === null) return undefined;
  const value = JSON.parse(encoded) as unknown;
  if (!plainObject(value)) throw new Error("invalid MCP token policy");
  if (value.schema !== MCP_TOKEN_POLICY_SCHEMA) throw new Error("unknown MCP token policy schema");
  if (Object.keys(value).some((key) => !POLICY_FIELDS.has(key))) throw new Error("unknown MCP token policy field");
  if (value.feishuDocShare !== undefined) {
    // Exclusive: exactly {schema, groups: [], feishuDocShare: {shareId}}.
    const scope = value.feishuDocShare;
    if (!plainObject(scope) || Object.keys(value).length !== 3
      || !Array.isArray(value.groups) || value.groups.length !== 0
      || Object.keys(scope).length !== 1 || typeof scope.shareId !== "string" || !FEISHU_DOC_SHARE_ID.test(scope.shareId)) {
      throw new Error("invalid MCP Feishu document share policy");
    }
    return { schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], feishuDocShare: { shareId: scope.shareId } };
  }
  if (value.ticketDevelopment !== undefined) {
    const scope = value.ticketDevelopment;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)
      || !Array.isArray(value.groups) || value.groups.length !== 0
      || value.sessionExecution !== undefined || value.apps !== undefined) {
      throw new Error("invalid MCP ticket development policy");
    }
    const development = scope as Record<string, unknown>;
    const { ticketId, turn, developmentId } = development;
    if (Object.keys(development).some((key) => !["ticketId", "turn", "developmentId"].includes(key))
      || typeof ticketId !== "number" || !Number.isSafeInteger(ticketId) || ticketId < 1
      || typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1
      || typeof developmentId !== "string" || developmentId.length > 128
      || !POLICY_NAME.test(developmentId)) {
      throw new Error("invalid MCP ticket development policy");
    }
    return { schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], ticketDevelopment: { ticketId, turn, developmentId } };
  }
  const apps = value.apps;
  if (apps !== undefined && (!plainObject(apps) || Object.keys(apps).some((key) => !APP_SELECTOR_FIELDS.has(key)))) {
    throw new Error("invalid MCP app policy");
  }
  const app = apps as Record<string, unknown> | undefined;
  const policy = mcpTokenPolicy({
    groups: value.groups,
    appIds: app?.ids,
    appInstances: app?.instances,
    appActions: app?.actions,
  });
  const rawExecution = value.sessionExecution;
  if (rawExecution === undefined) return policy;
  if (!rawExecution || typeof rawExecution !== "object" || Array.isArray(rawExecution)) {
    throw new Error("invalid MCP session execution policy");
  }
  const execution = rawExecution as Record<string, unknown>;
  if (Object.keys(execution).some((key) => !EXECUTION_FIELDS.has(key))) throw new Error("unknown MCP session execution field");
  const operationId = boundedExecutionName(execution.operationId, 128);
  const runtimeDevice = boundedExecutionName(execution.runtimeDevice, 64);
  const executionDevice = boundedExecutionName(execution.executionDevice, 64);
  const workspaceId = boundedExecutionName(execution.workspaceId, 64);
  const permissionProfile = execution.permissionProfile;
  if (
    !operationId || !runtimeDevice || !executionDevice
    || !/^ws_[0-9a-f]{24}$/.test(workspaceId)
    || (permissionProfile !== "full_access" && permissionProfile !== "manual" && permissionProfile !== "read_only")
  ) throw new Error("invalid MCP session execution policy");
  if (permissionProfile !== "read_only") {
    if (execution.docShare !== undefined) throw new Error("invalid MCP session execution policy: docShare requires read_only");
    return {
      ...policy,
      sessionExecution: { operationId, runtimeDevice, executionDevice, workspaceId, permissionProfile },
    };
  }
  // A document assistant: one device (the agent and its workspace together),
  // one document share, and no group beyond the workspace reads.
  const docShare = execution.docShare;
  if (typeof docShare !== "string" || !FEISHU_DOC_SHARE_ID.test(docShare) || runtimeDevice !== executionDevice
    || policy.apps !== undefined || policy.groups.length !== 1 || policy.groups[0] !== "workspace") {
    throw new Error("invalid MCP read-only execution policy");
  }
  return {
    ...policy,
    sessionExecution: { operationId, runtimeDevice, executionDevice, workspaceId, permissionProfile, docShare },
  };
}

function boundedExecutionName(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : "";
}

/**
 * Internal policy builder; the public mint route never accepts these fields.
 * Typed to the two ordinary profiles: account groups can never be combined
 * with `read_only` (see `mcpDocAssistantPolicy`).
 */
export function mcpSessionExecutionPolicy(
  input: Omit<NonNullable<McpTokenPolicy["sessionExecution"]>, "permissionProfile" | "docShare"> & { permissionProfile: "full_access" | "manual" },
  options: { accountTools?: boolean } = {},
): McpTokenPolicy {
  const canonical = decodeMcpTokenPolicy(JSON.stringify({
    // Account tools retain their own grants. Only trusted managed launches
    // opt in; an on-demand workspace credential cannot acquire account tools.
    ...mcpTokenPolicy({ groups: ["workspace", "knowledge", "discussions",
      ...(options.accountTools ? MCP_AGENT_ACCOUNT_TOOL_GROUPS : [])] }),
    sessionExecution: input,
  }));
  if (!canonical?.sessionExecution) throw new Error("invalid MCP session execution policy");
  return canonical;
}

/**
 * A Feishu document assistant's session credential: the workspace group only,
 * one device, and the one assistant share it may reach. Like every internal
 * policy it goes back through the decoder, so the builder cannot make a shape
 * the decoder would refuse.
 */
export function mcpDocAssistantPolicy(input: {
  operationId: string; device: string; workspaceId: string; docShare: string;
}): McpTokenPolicy {
  const policy = decodeMcpTokenPolicy(JSON.stringify({
    schema: MCP_TOKEN_POLICY_SCHEMA,
    groups: ["workspace"],
    sessionExecution: {
      operationId: input.operationId, runtimeDevice: input.device, executionDevice: input.device,
      workspaceId: input.workspaceId, permissionProfile: "read_only", docShare: input.docShare,
    },
  }));
  if (policy?.sessionExecution?.permissionProfile !== "read_only") throw new Error("invalid MCP read-only execution policy");
  return policy;
}

/**
 * No generic tool groups: this credential reaches one document share and
 * nothing else. A decoder that predates the field refuses it too (an empty
 * group list is not a valid generic policy), so a rollback fails closed.
 */
export function mcpFeishuDocSharePolicy(shareId: string): McpTokenPolicy {
  const policy = decodeMcpTokenPolicy(JSON.stringify({ schema: MCP_TOKEN_POLICY_SCHEMA, groups: [], feishuDocShare: { shareId } }));
  if (!policy?.feishuDocShare) throw new Error("invalid MCP Feishu document share policy");
  return policy;
}

/** No generic tool groups: this credential is only a live ticket-turn relay. */
export function mcpTicketDevelopmentPolicy(
  ticketDevelopment: NonNullable<McpTokenPolicy["ticketDevelopment"]>,
): McpTokenPolicy {
  const policy = decodeMcpTokenPolicy(JSON.stringify({
    schema: MCP_TOKEN_POLICY_SCHEMA, groups: [],
    ticketDevelopment: {
      ticketId: ticketDevelopment.ticketId, turn: ticketDevelopment.turn,
      developmentId: ticketDevelopment.developmentId,
    },
  }));
  if (!policy?.ticketDevelopment) throw new Error("invalid MCP ticket development policy");
  return policy;
}
