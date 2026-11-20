import { RUNNER_CAPABILITY_TOOLS } from "./tools.js";
import { RUNNER_EXTENSION_OPERATIONS, type RunnerExtensionCapabilities } from "../runner/extension-capability.js";
import type { MeetingTranscriptionCapabilities } from "../meeting-transcription/capability.js";
import { MEETING_TRANSCRIPTION_ACTIONS, parseMeetingTranscriptionRequest } from "@claude-bot/runner/meeting-transcription-protocol";
import { MEETING_TRANSCRIPTION_TOOLS } from "./tools.js";
import { MCP_MEETING_TRANSCRIPTION_OPERATION_IDS } from "./catalog.js";
import type { SessionOperationCoordinator } from "../sessionhub/operations.js";
import { SharedManagementError, type SharedAppManagement } from "../app-registry/shared-management.js";
/**
 * McpSurface — the trusted body behind `POST /api/mcp`.
 *
 * ── Where authority comes from, per tool group ──────────────────────────────
 *
 *   sessions    `SessionHubService`, called with a principal assembled from the
 *               authenticated token — the SAME service and the SAME permission
 *               intersection every `/api/sessions*` route uses, so an mcp_
 *               token can never see more than the owner's own dashboard can.
 *               Nothing here re-implements a session decision.
 *   workspace   a `workspace-files-runner-v2` capability grant derived for the
 *               owner with exactly the operations the `service:mcp` grant makes
 *               effective, wrapped in the SAME `WorkspaceFilesService` scope
 *               port Session Plus uses. Every read is one `gate.invoke`; the
 *               write queues the Gate's approval card.
 *   documents   the `crdt-doc/v1` provider (`agent-resources/crdt-doc-provider`)
 *               opened with a synthetic trusted context — refs, base64 checks,
 *               the read/edit split and the update rate limit are the
 *               provider's, not a second copy here.
 *   memory      a `user-memory-v1` capability grant derived for the owner with
 *   skills      exactly the operations the `service:mcp` grant makes effective;
 *               ditto `user-skills-v1`. Every call is one `gate.invoke` on the
 *               plane's own Object — the jail, the bounds and the approval
 *               cards are the plane's, not a second copy here.
 *   apps        the declared-App directory the composition serves. Every call
 *               is ONE agent turn through `AppInstanceService` — the SAME
 *               open/dispatch door a page button and an app-agent turn drive,
 *               with an `agent` principal (`session: false`) the manifest door
 *               refuses `human_only` actions for. Admission ceilings, manifest
 *               normalisation, the SES rules door and the audited commit are
 *               all the coordinator's; nothing here re-implements a decision,
 *               and the commit-log read face is the App's own State history.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 *
 * `owner` and `credential` arrive from the transport's authenticated identity
 * and NOTHING in a tool argument can name an owner, a device or a workspace —
 * the tool tables in `tools.ts` are closed. A resource handle a caller sends
 * back (`resource_id`, `ref`, `doc`) is decoded/looked up and re-checked
 * against the token's owner; a foreign or forged one produces zero frames on
 * anybody's device. Memory paths and skill names are RELATIVE names inside a
 * per-owner Object whose root the binding fixed, jailed by the plane.
 *
 * ── Scope lifetime ──────────────────────────────────────────────────────────
 *
 * Workspace refs and document refs are minted per (token, rights-set) scope
 * and cached so that a ref from one answer resolves in the next call. The
 * scope is torn down — refs dead first, then streams, then the grant — when
 * the token is revoked, when the owner's `service:mcp` grant is revoked or
 * narrowed, when the effective rights CHANGE (the next call reopens with the
 * new rights and old refs die with the old authority), and on shutdown.
 * Memory/skill scopes hold no refs, only the capability grant; they follow
 * the same lifetime, and tearing one down HARD-destroys its Context so the
 * cards it queued die with the authority that queued them.
 */

import { createHash, randomUUID } from "node:crypto";
import type { RuntimeJson } from "@claude-bot/app-runtime";
import { RESEARCH_APP } from "@claude-bot/research-canvas-contract";
import { CRDT_DOC_CONTRACT, CRDT_DOC_DECLARATION } from "@claude-bot/crdt-doc-contract";
import { wireActionOf, type McpToolDefinition } from "@claude-bot/typed-port-kit";
import {
  WORKSPACE_FILES_CONTRACT_V2,
  appendWorkspaceTextWindows,
  replaceWorkspaceTextInWindows,
  workspaceListCursorAfter,
  workspaceTextWindows,
  type WorkspaceFilesReply,
  type WorkspaceTextUploadSteps,
} from "@claude-bot/workspace-files-contract";
import { crdtDocProvider } from "../agent-resources/crdt-doc-provider.js";
import type { ResourceProviderContext, ResourceProviderDefinition } from "../agent-resources/types.js";
import type { AppInstanceService, OpenAgentAppInstance } from "../app-registry/app-instance.js";
import type { CrdtDocumentDescriptor } from "../crdt-doc/types.js";
import type { CrdtDocumentStore } from "../crdt-doc/store.js";
import { PermissionService } from "../permissions/service.js";
import { autoAllowedOperations, effectiveOperations } from "../permissions/effective.js";
import { FEISHU_FILE_MAX_BYTES, FEISHU_PRIVILEGED_OPERATIONS, FEISHU_USER_OPERATIONS } from "../feishu/catalog.js";
import { LARK_CLI_TOOL } from "../feishu/lark-cli.js";
import type { DocsWorkspaceFiles } from "../feishu/docs-files.js";
import { DocsAddonError } from "../feishu/docs-addon-auth.js";
import { appActionTool } from "../app-core/manifest.js";
import type { HubPrincipal, HubSessionSummary, SessionHubService } from "../sessionhub/service.js";
import { RunnerWorkspaceFilesBackend } from "../workspace-files/runner-backend.js";
import { WorkspaceFilesService, type WorkspaceFilesScopePort } from "../workspace-files/service.js";
import type { WorkspaceFilesAuthority } from "../workspace-files/types.js";
import {
  MCP_APPS_OPERATION_IDS,
  MCP_CATALOG,
  MCP_CRDT_OPERATION_IDS,
  MCP_FEISHU_OPERATION_IDS,
  MCP_MEMORY_OPERATION_IDS,
  MCP_SKILL_OPERATION_IDS,
  MCP_SUBJECT_ID,
  MCP_WORKSPACE_OPERATION_IDS,
  MCP_EXECUTION_OPERATION_IDS,
  MCP_KNOWLEDGE_OPERATION_IDS,
} from "./catalog.js";
import {
  APP_DISPATCH_TOOL,
  APP_TOOLS,
  CRDT_LIST_TOOL,
  CRDT_TOOLS,
  FEISHU_TOOLS,
  SEND_FILE_BY_PATH_OPERATION,
  MEMORY_TOOLS,
  SESSION_TOOLS,
  SKILL_TOOLS,
  WORKSPACE_TOOLS,
  SESSION_EXECUTION_TOOL,
  readToolArgs,
  toolDefinitionOf,
  type McpToolGroup,
  type McpToolSpec,
  EXECUTION_TOOLS,
  KNOWLEDGE_TOOLS,
  FEISHU_DOC_TOOLS,
  FEISHU_DOC_SHARE_TOOLS,
  FEISHU_SHARED_DOC_TOOLS,
  SESSION_START_TOOL,
} from "./tools.js";
import type { McpTokenPolicy } from "./tokens.js";
import { PROJECTION_WINDOW_CHARS, projectionWindow } from "./projection-window.js";
import { MCP_AGENT_ACCOUNT_TOOL_GROUPS } from "./policy-contract.js";
import { SESSION_READ_ONLY_OPERATIONS, type SessionExecutionRegistry } from "./session-execution.js";
import type { TicketDevelopmentRegistry } from "./ticket-development.js";
import type { ExecutionScopeGrant, ExecutionScopePickup } from "../execution-workspace/scope-issuer.js";
import { OPEN_WORKSPACE_EXECUTION } from "../execution-workspace/scope-issuer.js";
import { createLogger } from "../logger.js";
import type { DiscussionCapabilities } from '../discussions/capability.js';
import { DISCUSSION_OPERATION_IDS } from '../discussions/capability.js';
import { DISCUSSION_TOOLS } from './tools.js';
import type { SlotGrant } from '../runner/account-authority.js';

const log = createLogger("mcp-surface");

/** Who is calling, assembled by the transport from the authenticated token. */
export interface McpPrincipal {
  owner: string;
  /** One-way handle of the presented token (`mcp:<hash16>`); scopes Contexts. */
  credential: string;
  /** Credential-local attenuation. Undefined for browser/dt and pre-v38 tokens. */
  policy?: McpTokenPolicy;
  /**
   * The native session that made this call, when the trusted transport knows
   * it: the local Runner bridge resolves it from the calling CLI's process.
   * It names "self" for the docs tools and is never taken from arguments.
   */
  caller?: { device: string; source: string; sessionId: string };
}

/**
 * The Feishu Docs agent surface, bound late by the composition (it is built
 * after this surface). It receives each docs tool's validated arguments whole,
 * by tool name, so no layer in between can drop a declared field.
 */
export interface McpFeishuDocsPlane {
  call(tool: string, owner: string, args: Record<string, unknown>, caller?: McpPrincipal["caller"]): Promise<unknown>;
}

/**
 * A Feishu document share link's whole surface, bound late like the docs
 * plane. `caller` comes from the authenticated token (its owner, credential
 * handle and the share its policy names); `call` authorizes every call afresh
 * and runs it on the share's own document.
 */
export interface McpFeishuDocSharePlane {
  toolNames(caller: McpDocShareCaller): readonly string[];
  call(caller: McpDocShareCaller, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A document assistant's share is usable now (bound to its live scope, active, card not known gone); throws the refusal otherwise. */
  assistantUsable(caller: McpDocShareCaller): void;
  /** The same before each of its calls, its card looked for again once its lease ran out (`authorize`). */
  assistantAuthorize(caller: McpDocShareCaller): Promise<void>;
}
/** `via: 'assistant'` only after the caller's read-only session scope resolved here; never from arguments. */
export interface McpDocShareCaller { shareId: string; owner: string; credential: string; via?: "assistant" }

/** Ungated document tools (owner decision 2026-10-18); each call is audited and the owner is notified in Feishu. */
const DOCS_TOOLS: readonly McpToolSpec[] = [...FEISHU_DOC_TOOLS, ...FEISHU_DOC_SHARE_TOOLS, SESSION_START_TOOL];

/** An image that travels beside a result as an MCP image block, never inside its JSON text. */
export interface McpImage {
  mimeType: string;
  /** Base64. */
  data: string;
}

export type McpToolOutcome =
  | { ok: true; result: unknown; images?: readonly McpImage[] }
  | { ok: false; code: string; message: string };

/** A workspace authority the composition opened for one owner's MCP scope. */
export interface McpWorkspaceAuthorityGrant {
  authority: WorkspaceFilesAuthority;
  writable: boolean;
  close: () => void;
}

/**
 * A capability grant over one per-owner directory plane (user memory /
 * skills). Structurally satisfied by the planes' `SlotGrant`: `request` is
 * one `gate.invoke`, `destroy` is the HARD Context teardown.
 */
export interface McpUserFilesGrant {
  request(
    operation: string,
    args: Record<string, unknown>,
  ): Promise<
    | { status: "succeeded"; result: unknown }
    | { status: "approval_required"; pendingCallId: string }
    | { status: "denied"; reason: string }
    | { status: "failed"; reason: string }
    | { status: "unknown"; reason: string }
  >;
  destroy(): void;
}

/**
 * One declared App, as much of it as this surface needs. Structurally
 * satisfied by the dashboard's `DeclaredAppSurface` — declared here so the
 * surface names what it uses instead of importing the panel's option types.
 */
export type McpAppInstancePort = Pick<
  AppInstanceService,
  "actionSurface" | "sharedRoles" | "openAgentTurn" | "closeInstance" | "dispatch" | "readLog"
>;

export interface McpDeclaredApp {
  stableAppId: string;
  publisher: string;
  title: string;
  /** Null while nothing is activated — listable, not operable. */
  packageDigest: string | null;
  service: McpAppInstancePort | null;
  unavailable: string | null;
}

export interface McpAppsDirectory {
  management?: SharedAppManagement;
  list(): readonly McpDeclaredApp[];
  get(stableAppId: string): McpDeclaredApp | null;
  /** Membership-filtered shared instances; absent for a legacy composition. */
  instancesFor?(stableAppId: string, owner: string): readonly {
    instance: string;
    role: string;
    creator: string;
    status: string;
    members: number;
  }[];
}

/** What the surface needs from `UserMemoryCapabilities` / `UserSkillsCapabilities`. */
export interface McpUserFilesPlane {
  open(o: {
    username: string;
    purpose: string;
    rights: readonly string[];
    autoAllow?: readonly string[];
    metadata?: Record<string, string>;
  }): McpUserFilesGrant | null;
}

export interface McpFeishuGrant {
  slot: string;
  capabilities: {
    request(slot: string, operation: string, args: unknown): Promise<
      | { status: "succeeded"; result: unknown }
      | { status: "approval_required"; pendingCallId: string }
      | { status: "denied"; reason: string }
      | { status: "failed"; reason: string }
      | { status: "unknown"; reason: string }
    >;
    /** The kernel's view of a call this grant left waiting for approval. */
    result(pendingCallId: string): {
      state: "pending" | "claimed" | "rejected" | "expired" | "finished";
      outcome: "succeeded" | "failed" | "unknown" | null;
      result: unknown;
      reason: string | null;
    } | null;
  };
  destroy(): void;
}

export interface McpFeishuPlane {
  /** Catalogued operations whose reviewed downstream tool passed startup verification. */
  runnable(): ReadonlySet<string>;
  open(o: {
    username: string;
    purpose: string;
    kind: "session";
    rights: readonly string[];
    autoAllow?: readonly string[];
    metadata?: Record<string, string>;
  }): McpFeishuGrant | null;
  openPrivileged(o: {
    username: string;
    purpose: string;
    kind: "session";
    rights: readonly string[];
    metadata?: Record<string, string>;
  }): McpFeishuGrant | null;
}

/** What the surface needs from `ExecutionScopeCapabilities`: a per-token grant over the issuer Object. */
export interface McpExecutionScopePlane {
  open(o: {
    username: string;
    purpose: string;
    rights: readonly string[];
    autoAllow?: readonly string[];
    metadata?: Record<string, string>;
  }): ExecutionScopeGrant | null;
}

export interface McpSurfaceOptions {
  runnerCapabilities?: RunnerExtensionCapabilities;
  /** Trusted fixed route; the authenticated principal supplies owner. */
  meetingTranscription?: { capabilities: MeetingTranscriptionCapabilities; device: string };
  discussions?: DiscussionCapabilities;
  knowledge?: { sources?(owner:string,action:string,args:Record<string,unknown>):unknown; repair?(owner:string,action:string,args:Record<string,unknown>):Promise<unknown>; context(owner: string, query: string, subject?: string): Promise<unknown>; annotate(owner: string, subject: string, body: string): unknown; investigate(owner: string, subject: string, investigation: unknown): unknown };
  hub: SessionHubService;
  sessionOperations?: Pick<SessionOperationCoordinator, "submit" | "endCredential">;
  permissions: PermissionService;
  /**
   * Open a workspace-files capability grant for one owner with exactly these
   * rights, or null when the account holds nothing (no device, no plane).
   * Supplied by the composition root — this module decides WHICH rights from
   * the recorded grant, never whether the deployment has the plane.
   */
  openWorkspaceAuthority?: (o: {
    owner: string;
    credential: string;
    rights: readonly string[];
    autoAllow: readonly string[];
  }) => McpWorkspaceAuthorityGrant | null;
  /** The process's ref vault / stream broker / projection layer. */
  workspaceFilesService?: WorkspaceFilesService;
  /**
   * The collaborative-document plane, when the composition registered one.
   * Absent = the crdt tool group does not exist (a clean seam for the
   * composition that lands the store).
   */
  crdt?: {
    store: CrdtDocumentStore;
    documentsFor: (owner: string) => readonly CrdtDocumentDescriptor[];
  };
  /**
   * The user-memory capability plane, when the composition built one. Absent
   * = the memory tool group does not exist and the consent card does not ask
   * about it. This module decides WHICH rights from the recorded grant; the
   * plane owns the directory, the jail and the bounds.
   */
  memory?: McpUserFilesPlane;
  /** The user-skills capability plane; same seam shape as `memory`. */
  skills?: McpUserFilesPlane;
  /**
   * The declared-App directory, when the composition serves declared Apps.
   * Mirrors the `crdt` seam: absent — e.g. `bootstrap-v3` without a composer —
   * means the apps tool group does not exist and the consent card does not ask
   * about it. Every call through it is one agent turn at the SAME
   * `AppInstanceService` door a page button drives; this module holds no App
   * state and caches no instance.
   */
  apps?: McpAppsDirectory;
  /** Reviewed user-OAuth Feishu capability plane; never a tenant credential. */
  feishu?: McpFeishuPlane;
  /** Exact owner-scoped privileged ceiling from feishu_gateway.privileged_users. */
  feishuPrivilegedRights?: (owner: string) => readonly string[];
  /**
   * Files on the calling session's own device, resolved and read exactly as
   * the Feishu Docs image path does (`DocsWorkspaceFiles`: the device places
   * the path in a registered workspace; reads use the owner's read-only
   * Workspace Files authority). Bound late by the composition.
   */
  callerFiles?: () => Pick<DocsWorkspaceFiles, "resolve" | "read"> | null;
  /** For approval hints in refusal text (…/pending). */
  publicUrl?: string;
  /** Live post-Gate authority for internally minted split-placement tokens. */
  sessionExecution?: SessionExecutionRegistry;
  /** Placing agents into Feishu documents and starting agents; absent when the docs add-on is not composed. */
  feishuDocs?: () => McpFeishuDocsPlane | null;
  /** Feishu document share links: the only surface a `feishuDocShare` token reaches. */
  feishuDocShares?: () => McpFeishuDocSharePlane | null;
  /** Project tools exist only for an internally authenticated, currently bound research run. */
  research?: {list(principal: McpPrincipal): McpToolDefinition[]; call(principal: McpPrincipal, name: string, args: unknown): Promise<McpToolOutcome>};
  /** Separate live ticket-turn authority; absent from all ordinary MCP grants. */
  ticketDevelopment?: TicketDevelopmentRegistry;
  /**
   * The on-demand execution-scope issuer Object, when the composition built
   * one next to `sessionExecution`. Absent = the `execution` tool group does
   * not exist and the consent card does not ask about it.
   */
  executionScopes?: McpExecutionScopePlane;
}

interface WorkspaceScope {
  owner: string;
  rightsKey: string;
  port: WorkspaceFilesScopePort;
  close: () => void;
}

interface CrdtScope {
  owner: string;
  rightsKey: string;
  state: unknown;
  refs: ReadonlyMap<string, CrdtDocumentDescriptor>;
  context: ResourceProviderContext;
}

interface UserFilesScope {
  owner: string;
  rightsKey: string;
  grant: McpUserFilesGrant;
}

interface FeishuScope {
  owner: string;
  rightsKey: string;
  ordinary: McpFeishuGrant | null;
  privileged: McpFeishuGrant | null;
  /** Calls left waiting for approval, by args key, so a retry collects instead of asking twice. */
  pending: Map<string, string>;
}

interface ExecutionScopeHold {
  owner: string;
  rightsKey: string;
  grant: ExecutionScopeGrant;
  /** Undecided/decided opens by args key, so a retry after approval collects instead of re-asking. */
  pending: Map<string, string>;
}

type UserFilesGroup = "memory" | "skills";

export class McpSurface {
  private runnerCapabilityScopes = new Map<string, { owner: string; key: string; grant: SlotGrant; pending: Map<string, string> }>();
  private transcriptionScopes = new Map<string, { owner: string; key: string; grant: SlotGrant; pending: Map<string, string> }>();
  private discussionScopes = new Map<string, { owner: string; key: string; grant: SlotGrant; pending: Map<string, string> }>();
  private workspaces = new Map<string, WorkspaceScope>();
  private crdtScopes = new Map<string, CrdtScope>();
  /** Per-token capability grants over the two per-owner directory planes. */
  private userFiles: Record<UserFilesGroup, Map<string, UserFilesScope>> = {
    memory: new Map(),
    skills: new Map(),
  };
  private feishuScopes = new Map<string, FeishuScope>();
  private executionScopes = new Map<string, ExecutionScopeHold>();
  private crdtProvider: ResourceProviderDefinition | null = null;
  private capturedRefs: ReadonlyMap<string, CrdtDocumentDescriptor> | null = null;
  private generation = 0;
  private closed = false;
  private readonly detachExecutionRelease: (() => void) | undefined;

  constructor(private opts: McpSurfaceOptions) {
    this.detachExecutionRelease = opts.sessionExecution?.onRelease?.((owner, credential) => {
      this.releaseAccountTools(owner, credential);
    });
    if (opts.crdt) {
      this.crdtProvider = crdtDocProvider({
        openGrant: (context) => this.openCrdtGrant(context),
        onScopeOpened: (_context, refs) => {
          this.capturedRefs = refs;
        },
      }) as ResourceProviderDefinition;
    }
    // A revoked or narrowed `service:mcp` grant must close what it opened, not
    // merely stop the next scope: the row is already safe when this runs.
    opts.permissions.onRevoked((event) => {
      if (event.subjectType === "service" && event.subjectId === MCP_SUBJECT_ID) this.releaseOwner(event.owner);
    });
  }

  get workspaceComposed(): boolean {
    return Boolean(this.opts.openWorkspaceAuthority && this.opts.workspaceFilesService);
  }

  get crdtComposed(): boolean {
    return Boolean(this.opts.crdt && this.crdtProvider);
  }

  get memoryComposed(): boolean {
    return Boolean(this.opts.memory);
  }

  get skillsComposed(): boolean {
    return Boolean(this.opts.skills);
  }

  get executionComposed(): boolean {
    return Boolean(this.opts.executionScopes && this.opts.sessionExecution);
  }

  get appsComposed(): boolean {
    return Boolean(this.opts.apps);
  }

  get feishuComposed(): boolean {
    return Boolean(this.opts.feishu);
  }

  // ── tools/list: the caller's effective permissions, as a tool list ──

  listTools(input: string | McpPrincipal): McpToolDefinition[] {
    const principal = typeof input === "string" ? { owner: input, credential: "compat" } : input;
    const owner = principal.owner;
    if (principal.policy?.feishuDocShare) return this.sharedDocTools(principal, principal.policy.feishuDocShare.shareId);
    if (principal.policy?.ticketDevelopment) {
      return this.opts.ticketDevelopment?.listTools(principal) ?? [];
    }
    if (principal.policy?.sessionExecution?.permissionProfile === "read_only") {
      return this.assistantTools(principal, principal.policy.sessionExecution.docShare ?? "");
    }
    if (principal.policy?.sessionExecution) {
      if (!this.opts.sessionExecution?.resolve(principal)) return [];
      return [
        ...WORKSPACE_TOOLS.map((spec) => toolDefinitionOf(spec)),
        toolDefinitionOf(SESSION_EXECUTION_TOOL),
        ...this.listAccountTools(principal),
        ...this.opts.research?.list(principal) ?? [],
        ...(this.opts.knowledge && this.groupAllowed(principal, "knowledge")
          ? KNOWLEDGE_TOOLS.filter((spec) => (spec.name !== "knowledge_sources" || this.opts.knowledge?.sources) && (spec.name !== "knowledge_repairs" || this.opts.knowledge?.repair)).filter((spec) => effectiveOperations(this.mcpView(owner)).includes(spec.gate.operation)).map(toolDefinitionOf) : []),
      ];
    }
    const out = this.listAccountTools(principal);
    if (this.workspaceComposed || this.crdtComposed || this.memoryComposed || this.skillsComposed || this.appsComposed || this.feishuComposed || this.executionComposed || this.opts.knowledge || this.opts.discussions) {
      const ops = new Set(effectiveOperations(this.mcpView(owner)));
      if (this.opts.knowledge) for (const spec of KNOWLEDGE_TOOLS) {
        if (spec.name === "knowledge_sources" && !this.opts.knowledge.sources || spec.name === "knowledge_repairs" && !this.opts.knowledge.repair) continue;
        if (this.groupAllowed(principal, spec.group) && ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
      }
      if (this.workspaceComposed) {
        for (const spec of WORKSPACE_TOOLS) {
          if (this.groupAllowed(principal, spec.group) && ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
        }
      }
      if (this.crdtComposed && this.groupAllowed(principal, "crdt")) {
        if (ops.has(CRDT_LIST_TOOL.gate.operation)) out.push(toolDefinitionOf(CRDT_LIST_TOOL));
        for (const tool of CRDT_TOOLS) if (ops.has(tool.gate.operation)) out.push(tool.definition);
      }
      if (this.memoryComposed) {
        for (const spec of MEMORY_TOOLS) {
          if (this.groupAllowed(principal, spec.group) && ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
        }
      }
      if (this.skillsComposed) {
        for (const spec of SKILL_TOOLS) {
          if (this.groupAllowed(principal, spec.group) && ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
        }
      }
      if (this.appsComposed && this.groupAllowed(principal, "apps")) {
        for (const spec of APP_TOOLS) {
          if (spec.name.startsWith("app_shared_") && !this.opts.apps?.management) continue;
          if (ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
        }
        if (ops.has(APP_DISPATCH_TOOL.gate.operation)) out.push(APP_DISPATCH_TOOL.definition);
      }
      if (this.executionComposed) {
        for (const spec of EXECUTION_TOOLS) {
          if (this.groupAllowed(principal, spec.group) && ops.has(spec.gate.operation)) out.push(toolDefinitionOf(spec));
        }
      }
    }
    return out;
  }

  private listAccountTools(principal: McpPrincipal): McpToolDefinition[] {
    const hubOps = new Set(effectiveOperations(this.opts.hub.effective(principal.owner)));
    const ops = new Set(effectiveOperations(this.mcpView(principal.owner)));
    return [
      ...SESSION_TOOLS.filter(spec => hubOps.has(spec.gate.operation)),
      ...(this.opts.discussions ? DISCUSSION_TOOLS.filter(spec => ops.has(spec.gate.operation)) : []),
      ...(this.opts.runnerCapabilities ? RUNNER_CAPABILITY_TOOLS.filter(spec => ops.has(spec.gate.operation)) : []),
      ...(this.opts.meetingTranscription ? MEETING_TRANSCRIPTION_TOOLS.filter(spec => ops.has(spec.gate.operation)) : []),
      ...(this.feishuComposed ? FEISHU_TOOLS.filter(spec => ops.has(spec.gate.operation)) : []),
      ...(this.opts.feishuDocs?.() ? DOCS_TOOLS : []),
    ].filter(spec => this.groupAllowed(principal, spec.group)).map(toolDefinitionOf);
  }

  /** Ungated by owner decision (see DOCS_TOOLS); audited, and the docs service notifies the owner. */
  private async callDocsTool(principal: McpPrincipal, spec: McpToolSpec, rawArgs: unknown): Promise<McpToolOutcome> {
    const plane = this.opts.feishuDocs?.();
    if (!plane) return refuse("unavailable", "飞书文档卡片在这个 Octopus 上没有启用。");
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    try {
      const result = await plane.call(spec.name, principal.owner, args.value, principal.caller);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 400) : "操作没有完成";
      return refuse("refused", message);
    }
  }

  // ── a Feishu document share link: its tools and nothing else ──

  /** The shared-document tools the share's rights allow; no session, runner, App or other Feishu tool exists for it. */
  private sharedDocTools(principal: McpPrincipal, shareId: string): McpToolDefinition[] {
    const allowed = new Set(this.opts.feishuDocShares?.()?.toolNames({ shareId, owner: principal.owner, credential: principal.credential }) ?? []);
    return FEISHU_SHARED_DOC_TOOLS.filter((spec) => allowed.has(spec.name)).map(toolDefinitionOf);
  }

  private async callSharedDoc(principal: McpPrincipal, shareId: string, name: string, rawArgs: unknown, via?: "assistant"): Promise<McpToolOutcome> {
    const plane = this.opts.feishuDocShares?.();
    const caller = { shareId, owner: principal.owner, credential: principal.credential, ...(via ? { via } : {}) };
    const spec = FEISHU_SHARED_DOC_TOOLS.find((candidate) => candidate.name === name);
    // As in tools/list: a tool this share does not hold is no tool at all.
    if (!spec || !plane?.toolNames(caller).includes(name)) return refuse("unknown_tool", `没有名为 ${name} 的工具。`);
    const audited = (out: McpToolOutcome) => this.audited(principal, spec.gate.operation, `${name} · ${shareId}`, out);
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return audited(refuse("invalid_params", args.message));
    try {
      return audited({ ok: true, result: await plane.call(caller, name, args.value) });
    } catch (error) {
      return audited(sharedDocRefusal(error, name, shareId));
    }
  }

  // ── a Feishu document assistant: one read-only workspace and its one share ──

  /**
   * An explicit list, not a filter of the account's: the three workspace reads
   * and the shared-document tools of the assistant's own share, while its
   * read-only scope lives and its share is usable. No account, knowledge,
   * research or command tool is ever reached from here, whatever the owner
   * granted in /permissions.
   */
  private assistantTools(principal: McpPrincipal, shareId: string): McpToolDefinition[] {
    const caller = this.assistantCaller(principal, shareId);
    const plane = this.opts.feishuDocShares?.();
    if (!caller || !plane) return [];
    try { plane.assistantUsable(caller); } catch { return []; }
    const shared = new Set(plane.toolNames(caller));
    if (!shared.size) return [];
    return [
      ...WORKSPACE_TOOLS.filter((spec) => (SESSION_READ_ONLY_OPERATIONS as readonly string[]).includes(spec.name)),
      ...FEISHU_SHARED_DOC_TOOLS.filter((spec) => shared.has(spec.name)),
    ].map(toolDefinitionOf);
  }

  private async callAssistantTool(principal: McpPrincipal, shareId: string, name: string, rawArgs: unknown): Promise<McpToolOutcome> {
    const caller = this.assistantCaller(principal, shareId);
    if (!caller) return refuse("no_authority", "这个会话执行凭证已过期或不再存活");
    const workspace = WORKSPACE_TOOLS.find((spec) => spec.name === name && (SESSION_READ_ONLY_OPERATIONS as readonly string[]).includes(spec.name));
    if (!workspace && !FEISHU_SHARED_DOC_TOOLS.some((spec) => spec.name === name)) return refuse("unknown_tool", `没有名为 ${name} 的工具。`);
    const plane = this.opts.feishuDocShares?.();
    if (!plane) return refuse("no_authority", "飞书文档共享在这个 Octopus 上没有启用");
    // The share is the assistant's one switch: paused, ended or its card gone, every tool stops.
    try { await plane.assistantAuthorize(caller); } catch (error) {
      return this.audited(principal, workspace?.gate.operation ?? name, `${name} · ${shareId}`, sharedDocRefusal(error, name, shareId));
    }
    if (workspace) return this.audited(principal, workspace.gate.operation, name, await this.callWorkspaceTool(principal, workspace, rawArgs));
    return this.callSharedDoc(principal, shareId, name, rawArgs, "assistant");
  }

  /** The assistant's caller of its share: only while its read-only scope is live and names this very share. */
  private assistantCaller(principal: McpPrincipal, shareId: string): McpDocShareCaller | null {
    const scope = this.opts.sessionExecution?.resolve(principal);
    if (!scope || scope.permissionProfile !== "read_only" || scope.docShare !== shareId) return null;
    return { shareId, owner: principal.owner, credential: principal.credential, via: "assistant" };
  }

  private feishuRights(owner: string): string[] {
    if (!this.feishuComposed) return [];
    const privilegedCeiling = new Set(this.opts.feishuPrivilegedRights?.(owner) ?? []);
    return MCP_FEISHU_OPERATION_IDS.filter((operation) =>
      this.opts.feishu!.runnable().has(operation)
      && (!FEISHU_PRIVILEGED_OPERATIONS[operation] || privilegedCeiling.has(operation)));
  }

  private mcpView(owner: string) {
    return this.opts.permissions.effectiveFor({
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      owner,
      requested: [
        ...(this.opts.runnerCapabilities ? this.opts.runnerCapabilities.accountOperations(owner) : []),
        ...(this.opts.discussions ? this.opts.discussions.accountOperations(owner) : []),
        ...(this.opts.meetingTranscription ? this.opts.meetingTranscription.capabilities.accountOperations(owner) : []),
        ...(this.opts.knowledge ? MCP_KNOWLEDGE_OPERATION_IDS : []),
        ...(this.workspaceComposed ? MCP_WORKSPACE_OPERATION_IDS : []),
        ...(this.crdtComposed ? MCP_CRDT_OPERATION_IDS : []),
        ...(this.memoryComposed ? MCP_MEMORY_OPERATION_IDS : []),
        ...(this.skillsComposed ? MCP_SKILL_OPERATION_IDS : []),
        ...(this.appsComposed ? MCP_APPS_OPERATION_IDS : []),
        ...(this.feishuComposed ? this.feishuRights(owner) : []),
        ...(this.executionComposed ? MCP_EXECUTION_OPERATION_IDS : []),
      ],
    });
  }

  // ── tools/call ──

  async callTool(principal: McpPrincipal, name: string, rawArgs: unknown): Promise<McpToolOutcome> {
    if (this.closed) return refuse("unavailable", "服务正在关闭。");
    if (principal.policy?.feishuDocShare) return this.callSharedDoc(principal, principal.policy.feishuDocShare.shareId, name, rawArgs);
    if (principal.policy?.ticketDevelopment) {
      return this.opts.ticketDevelopment
        ? this.audited(principal, name, name, await this.opts.ticketDevelopment.callTool(principal, name, rawArgs))
        : refuse("no_authority", "这个工单开发凭证不再存活");
    }
    if (principal.policy?.sessionExecution?.permissionProfile === "read_only") {
      return this.callAssistantTool(principal, principal.policy.sessionExecution.docShare ?? "", name, rawArgs);
    }
    if (principal.policy?.sessionExecution) {
      if (!this.opts.sessionExecution?.resolve(principal)) {
        return refuse("no_authority", "这个会话执行凭证已过期或不再存活");
      }
      if (name.startsWith('research_') && this.opts.research) return this.audited(principal, name, name, await this.opts.research.call(principal, name, rawArgs));
      if (name === SESSION_EXECUTION_TOOL.name) {
        const args = readToolArgs(SESSION_EXECUTION_TOOL, rawArgs);
        return args.ok
          ? await this.opts.sessionExecution.runCommand(principal, args.value)
          : refuse("invalid_params", args.message);
      }
      const scopedWorkspace = WORKSPACE_TOOLS.find((spec) => spec.name === name);
      if (scopedWorkspace) return await this.callWorkspaceTool(principal, scopedWorkspace, rawArgs);
      const group = this.toolGroup(name);
      const accountTool = group && (MCP_AGENT_ACCOUNT_TOOL_GROUPS as readonly string[]).includes(group);
      if (!accountTool && !(this.opts.knowledge && KNOWLEDGE_TOOLS.some(spec => spec.name === name))) {
        return refuse("unknown_tool", `没有名为 ${name} 的工具。`);
      }
    }
    const group = this.toolGroup(name);
    if (group && !this.groupAllowed(principal, group)) {
      // Match tools/list: a capability hidden by this credential does not
      // become discoverable through a different error vocabulary.
      return refuse("unknown_tool", `没有名为 ${name} 的工具。`);
    }
    const runnerCapability = this.opts.runnerCapabilities ? RUNNER_CAPABILITY_TOOLS.find(spec => spec.name === name) : undefined;
    if (runnerCapability) return this.audited(principal, runnerCapability.gate.operation, name, await this.callRunnerCapability(principal, runnerCapability, rawArgs));
    const transcription = this.opts.meetingTranscription ? MEETING_TRANSCRIPTION_TOOLS.find(spec => spec.name === name) : undefined;
    if (transcription) return this.audited(principal, transcription.gate.operation, name, await this.callTranscription(principal, transcription, rawArgs));
    const session = SESSION_TOOLS.find((spec) => spec.name === name);
    const discussion = this.opts.discussions ? DISCUSSION_TOOLS.find(spec => spec.name === name) : undefined;
    if (discussion) return this.audited(principal, name, name, await this.callDiscussion(principal, discussion, rawArgs));
    const knowledge = this.opts.knowledge ? KNOWLEDGE_TOOLS.find((spec) => spec.name === name) : undefined;
    if (knowledge) {
      if (!effectiveOperations(this.mcpView(principal.owner)).includes(knowledge.gate.operation)) return refuse("no_authority", "需要单独授权知识工具；既有 MCP 授权不会自动授予。");
      const args = readToolArgs(knowledge, rawArgs);
      if (!args.ok) return refuse("invalid_params", args.message);
      try {
        if (name === "knowledge_sources" && !this.opts.knowledge!.sources || name === "knowledge_repairs" && !this.opts.knowledge!.repair) throw new Error("知识工作流尚不可用");
        const result = name === "knowledge_sources" ? await this.opts.knowledge!.sources!(principal.owner,String(args.value.action),args.value)
          : name === "knowledge_repairs" ? await this.opts.knowledge!.repair!(principal.owner,String(args.value.action),args.value)
          : name === "knowledge_context"
          ? await this.opts.knowledge!.context(principal.owner, String(args.value.query), args.value.subject ? String(args.value.subject) : undefined)
          : name === "knowledge_investigate" ? await this.opts.knowledge!.investigate(principal.owner, String(args.value.subject), Object.fromEntries(Object.entries(args.value).filter(([key]) => key !== "subject")))
          : await this.opts.knowledge!.annotate(principal.owner, String(args.value.subject), String(args.value.body));
        return this.audited(principal, knowledge.gate.operation, name, { ok: true, result });
      } catch (error) {
        return this.audited(principal, knowledge.gate.operation, name, refuse("knowledge_refused", error instanceof Error ? error.message.slice(0, 400) : "知识服务拒绝"));
      }
    }
    if (session) return await this.callSessionTool(principal, session, rawArgs);
    const docs = DOCS_TOOLS.find((spec) => spec.name === name);
    if (docs && this.opts.feishuDocs?.()) return this.audited(principal, docs.gate.operation, name, await this.callDocsTool(principal, docs, rawArgs));
    const workspace = WORKSPACE_TOOLS.find((spec) => spec.name === name);
    if (workspace) return this.audited(principal, workspace.gate.operation, name, await this.callWorkspaceTool(principal, workspace, rawArgs));
    const memory = MEMORY_TOOLS.find((spec) => spec.name === name);
    if (memory) {
      return this.audited(principal, memory.gate.operation, name, await this.callUserFilesTool(principal, "memory", memory, rawArgs));
    }
    const skill = SKILL_TOOLS.find((spec) => spec.name === name);
    if (skill) {
      return this.audited(principal, skill.gate.operation, name, await this.callUserFilesTool(principal, "skills", skill, rawArgs));
    }
    const feishu = this.feishuComposed ? FEISHU_TOOLS.find((spec) => spec.name === name) : undefined;
    if (feishu) {
      return this.audited(principal, feishu.gate.operation, name, await this.callFeishuTool(principal, feishu, rawArgs));
    }
    const execution = this.executionComposed ? EXECUTION_TOOLS.find((spec) => spec.name === name) : undefined;
    if (execution) {
      return this.audited(principal, execution.gate.operation, name, await this.callExecutionTool(principal, execution, rawArgs));
    }
    if (this.crdtComposed && name === CRDT_LIST_TOOL.name) {
      return this.audited(principal, CRDT_LIST_TOOL.gate.operation, name, this.callCrdtList(principal));
    }
    const crdt = this.crdtComposed ? CRDT_TOOLS.find((tool) => tool.definition.name === name) : undefined;
    if (crdt) {
      return this.audited(principal, crdt.gate.operation, name, await this.callCrdtTool(principal, crdt.action, rawArgs));
    }
    const app = this.appsComposed ? APP_TOOLS.find((spec) => spec.name === name) : undefined;
    if (app) return this.audited(principal, app.gate.operation, name, await this.callAppTool(principal, app, rawArgs));
    if (this.appsComposed && name === APP_DISPATCH_TOOL.definition.name) {
      return this.audited(
        principal,
        APP_DISPATCH_TOOL.gate.operation,
        name,
        await this.callAppDispatch(principal, rawArgs),
      );
    }
    return refuse("unknown_tool", `没有名为 ${name} 的工具。`);
  }

  /** The MCP-surface activity record. Session tools are audited by the hub. */
  private audited(principal: McpPrincipal, operation: string, tool: string, out: McpToolOutcome): McpToolOutcome {
    this.opts.permissions.audit({
      owner: principal.owner,
      subjectType: "service",
      subjectId: MCP_SUBJECT_ID,
      operation,
      resource: tool,
      decision: out.ok ? "allow" : out.code === "approval_required" ? "pending" : "deny",
      reason: out.ok ? null : `${out.code}: ${out.message}`.slice(0, 200),
    });
    return out;
  }

  // ── sessions ──

  private hubPrincipal(principal: McpPrincipal): HubPrincipal {
    // `session: false`: a bearer is never a browser approval (the Cedar
    // `Approve` rule). Sending to the token owner's OWN sessions needs no
    // approval at all (O1); the hub's owner check still refuses anybody else's.
    return { username: principal.owner, admin: false, session: false, credential: principal.credential };
  }

  private async callSessionTool(principal: McpPrincipal, spec: McpToolSpec, rawArgs: unknown): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const hub = this.opts.hub;
    const p = this.hubPrincipal(principal);
    const owner = principal.owner;
    try {
      switch (spec.name) {
        case "list_recent_sessions": {
          const roster = await hub.roster(p, owner, {
            limit: Number(args.value.limit ?? 50),
            source: String(args.value.source ?? "all"),
            sinceHours: args.value.since_hours === undefined ? undefined : Number(args.value.since_hours),
            ...(args.value.device === undefined ? {} : { device: String(args.value.device) }),
            ...(typeof args.value.cursor === "string" && args.value.cursor ? { cursor: args.value.cursor } : {}),
            includeSessionPlus: true,
          });
          if (roster.restricted) return refuse("no_authority", roster.restricted.explanation);
          return {
            ok: true,
            result: {
              sources: roster.sources,
              returned: roster.returned,
              sessions: roster.sessions.map(compactSession),
              ...(roster.errors ? { errors: roster.errors } : {}),
              ...(roster.nextCursor ? { next_cursor: roster.nextCursor } : {}),
            },
          };
        }
        case "search_sessions": {
          const found = await hub.search(p, owner, String(args.value.query ?? ""), {
            limit: Number(args.value.limit ?? 15),
            source: String(args.value.source ?? "all"),
            ...(args.value.since_hours !== undefined ? { since_hours: Number(args.value.since_hours) } : {}),
            ...(typeof args.value.cursor === "string" && args.value.cursor ? { cursor: args.value.cursor } : {}),
            _octopus_include_session_plus: true,
          });
          if (!found.ok) return refuse(found.status === 403 ? "no_authority" : "unavailable", found.error);
          const data = found.data as { results?: Array<Record<string, unknown>> };
          return {
            ok: true,
            result: {
              ...found.data,
              results: (data.results ?? []).map((hit) => ({
                ...hit,
                session: compactSession(hit.session as HubSessionSummary),
              })),
            },
          };
        }
        case "read_session": {
          const handle = hub.decodeResourceId(String(args.value.resource_id ?? ""));
          if (!handle) return refuse("invalid_params", "resource_id 无法识别 — 请先用 list/search 拿到它。");
          if (handle.owner !== owner) {
            // Zero frames for a foreign handle, and the deny is recorded where
            // the owner can see somebody tried.
            this.opts.permissions.audit({
              owner,
              subjectType: "service",
              subjectId: MCP_SUBJECT_ID,
              operation: "read_session",
              resource: "read_session",
              decision: "deny",
              reason: "foreign_resource_id",
            });
            return refuse("forbidden", "这个 resource_id 不属于当前令牌的账号。");
          }
          const callArgs: Record<string, unknown> = { id: handle.sessionId, rich: true };
          callArgs.max_messages = Number(args.value.max_messages ?? 200);
          for (const key of ["offset", "before", "block", "char_offset"] as const) {
            if (args.value[key] !== undefined) callArgs[key] = Number(args.value[key]);
          }
          if (typeof args.value.field === "string") callArgs.field = args.value.field;
          if (handle.cliKind === "claude" || handle.cliKind === "codex") callArgs.source = handle.cliKind;
          callArgs._octopus_include_session_plus = true;
          const out = await hub.read(p, owner, handle.device, callArgs);
          if (!out.ok) return refuse(out.status === 403 ? "no_authority" : "unavailable", out.error);
          return { ok: true, result: out.data };
        }
        case "send_session_message": {
          const handle = hub.decodeResourceId(String(args.value.resource_id ?? ""));
          if (!handle) return refuse("invalid_params", "resource_id 无法识别 — 请先用 list/search 拿到它。");
          if (handle.owner !== owner) {
            this.opts.permissions.audit({
              owner,
              subjectType: "service",
              subjectId: MCP_SUBJECT_ID,
              operation: "append_session",
              resource: "send_session_message",
              decision: "deny",
              reason: "foreign_resource_id",
            });
            return refuse("forbidden", "这个 resource_id 不属于当前令牌的账号。");
          }
          if (!this.opts.sessionOperations) return refuse("unavailable", "持久会话操作服务尚未组成；未发送输入。");
          const accepted = await this.opts.sessionOperations.submit("mcp:sessions", p, {
            owner, device: handle.device, source: handle.cliKind, sessionId: handle.sessionId,
            prompt: String(args.value.prompt ?? ""), operation: "append_session",
          });
          if (accepted.ok) {
            const { view } = await accepted.settled;
            if (view.status === "waiting_approval") return refuse("approval_required",
              `${view.message}${view.pendingCallId ? ` (${view.pendingCallId})` : ""}；原操作 ${view.id}，无需重复发送。`);
            if (["failed", "rejected", "unknown"].includes(view.status)) return refuse(
              view.status === "unknown" ? "indeterminate" : "unavailable", `${view.message}；原操作 ${view.id}，请查看原会话。`);
            return { ok: true, result: { accepted: true, operation_id: view.id, status: view.status,
              ...(view.newSessionId ? { new_session_id: view.newSessionId } : {}) } };
          }
          const out = accepted;
          const code = out.status === 400
            ? "invalid_params"
            : out.status === 403
              ? "no_authority"
              : out.status === 409
                ? "busy"
                : "unavailable";
          return refuse(code, out.error);
        }
        default:
          return refuse("unknown_tool", `没有名为 ${spec.name} 的工具。`);
      }
    } catch (err) {
      log.warn({ err, tool: spec.name, owner }, "mcp session tool failed");
      return refuse("unavailable", err instanceof Error ? err.message : String(err));
    }
  }

  // ── workspace files ──

  private async callWorkspaceTool(
    principal: McpPrincipal,
    spec: McpToolSpec,
    rawArgs: unknown,
  ): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const scoped = this.workspacePort(principal, spec.gate.operation);
    if (!scoped.ok) return scoped;
    const port = scoped.port;
    switch (spec.name) {
      case "list_session_workspaces": {
        const after = typeof args.value.after === "string" ? args.value.after : undefined;
        const out = await port.refreshRoots(after);
        if (!out.ok) return refuse(out.code, out.message);
        // `next_after` is this tool's convenience, not a contract field: the
        // cursor is the last root's ref, stated so an agent need not derive it.
        const last = out.value.roots.at(-1);
        return { ok: true, result: { ...out.value, ...(out.value.truncated && last ? { next_after: last.ref } : {}) } };
      }
      case "list_workspace_entries": {
        const after = typeof args.value.after === "string" ? args.value.after : undefined;
        const out = await port.listDirectory(String(args.value.ref ?? ""), after);
        if (!out.ok) return refuse(out.code, out.message);
        const next = out.value.truncated ? workspaceListCursorAfter(out.value.entries) : null;
        return { ok: true, result: { ...out.value, ...(next ? { next_after: next } : {}) } };
      }
      case "read_workspace_text": {
        // One window per call (one device read): a file of any size is read by
        // following next_offset, and no answer holds more than one window.
        const offset = typeof args.value.offset === "number" ? args.value.offset : 0;
        const maxBytes = typeof args.value.max_bytes === "number" ? args.value.max_bytes : undefined;
        const out = await port.readTextWindow(String(args.value.ref ?? ""), offset, maxBytes);
        if (!out.ok) return refuse(out.code, out.message);
        const window = out.value;
        return { ok: true, result: { document: window.document, offset: window.offset, bytes: window.bytes,
          next_offset: window.nextOffset, eof: window.eof, text: window.text } };
      }
      case "replace_workspace_text": {
        const out = await this.replaceWorkspaceText(port, args.value);
        if (!out.ok) {
          if (out.code === "approval_required") {
            return refuse(
              "approval_required",
              out.staged
                // Approving one step of a staged write does not complete it:
                // each later step needs its own call, so say what will happen.
                ? `这次分段写入的一步已生成待批准卡（${this.pendingUrl()}）；批准它只会执行这一步，文件不会因此被替换。`
                  + "当前授权下每一步都需单独批准，请改为授权直接写入后重新整份写入。"
                : `这次写入已生成待批准卡，请文件所有者在 ${this.pendingUrl()} 批准；批准后写入自动执行，可用 read_workspace_text 复核结果。`,
            );
          }
          return refuse(out.code, out.message);
        }
        return { ok: true, result: out.value };
      }
      default:
        return refuse("unknown_tool", `没有名为 ${spec.name} 的工具。`);
    }
  }

  /**
   * One `replace_workspace_text` call: a whole text of any size up to this
   * tool's window, or one explicit step of a staged write for a file larger
   * than that. Either way every device call carries one window and spends the
   * same write operation; the whole form is staged internally exactly like a
   * remote editor's save.
   */
  private async replaceWorkspaceText(
    port: WorkspaceFilesScopePort,
    value: Record<string, unknown>,
  ): Promise<WorkspaceFilesReply<unknown> & { staged?: boolean }> {
    const ref = String(value.ref ?? "");
    const expectedDigest = String(value.expected_digest ?? "");
    const upload = String(value.upload ?? "");
    const steps: WorkspaceTextUploadSteps = {
      whole: (text) => port.replaceText(ref, { expectedDigest, text }),
      begin: () => port.beginTextUpload(ref, { expectedDigest }),
      append: (token, offset, text) => port.appendTextUpload(ref, { upload: token, offset, text }),
      commit: (token, sizeBytes) => port.commitTextUpload(ref, { upload: token, expectedDigest, sizeBytes }),
    };
    if (value.stage === undefined) {
      if (typeof value.text !== "string") {
        return { ok: false, code: "invalid_request", message: "整份写入需要 text。" };
      }
      const text = value.text;
      const staged = workspaceTextWindows(text).length > 1;
      return { ...(await replaceWorkspaceTextInWindows(text, steps)), staged };
    }
    if (value.stage === "begin") return { ...(await steps.begin()), staged: true };
    if (value.stage === "commit") {
      const size = typeof value.size === "number" ? value.size : -1;
      return { ...(await steps.commit(upload, size)), staged: true };
    }
    if (typeof value.text !== "string" || typeof value.offset !== "number") {
      return { ok: false, code: "invalid_request", message: "stage=append 需要 upload、offset 与 text。" };
    }
    // An append may carry more than one device window; it is fed through in
    // order, each window addressed by its own offset.
    const appended = await appendWorkspaceTextWindows(steps, upload, value.offset, workspaceTextWindows(value.text));
    return appended.ok
      ? { ok: true, value: { upload, sizeBytes: appended.value }, staged: true }
      : { ...appended, staged: true };
  }

  /**
   * The cached scope port for one token, reopened whenever the EFFECTIVE
   * rights set changed — old refs die with the old authority, which is the
   * point rather than a nuisance.
   */
  private workspacePort(
    principal: McpPrincipal,
    operation: string,
  ): { ok: true; port: WorkspaceFilesScopePort } | { ok: false; code: string; message: string } {
    if (principal.policy?.sessionExecution) {
      const port = this.opts.sessionExecution?.workspacePort(principal);
      return port
        ? { ok: true, port }
        : refuse("no_authority", "这个会话执行凭证已过期或不再存活");
    }
    if (!this.workspaceComposed) return refuse("no_authority", "这套部署没有组合工作区文件平面。");
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view);
    const rights = MCP_WORKSPACE_OPERATION_IDS.filter((op) => effective.includes(op));
    if (!rights.includes(operation)) {
      const entry = view.entries.find((e) => e.operation === operation);
      return refuse("no_authority", entry?.explanation ?? "这个操作还没有在 /permissions 的「MCP 接入」卡里授权。");
    }
    // The token owner's OWN workspaces (the scope below is bound to
    // `principal.owner`): every granted operation is silent (O1), including a
    // write granted before it became auto-allowable. Nothing here reaches
    // another account's workspace.
    const autoAllow = rights.filter((op) => !MCP_CATALOG.operation(op)?.alwaysApprove);
    const rightsKey = JSON.stringify([rights, autoAllow]);
    const held = this.workspaces.get(principal.credential);
    if (held && held.rightsKey === rightsKey) return { ok: true, port: held.port };
    if (held) this.dropWorkspaceScope(principal.credential);
    const grant = this.opts.openWorkspaceAuthority!({
      owner: principal.owner,
      credential: principal.credential,
      rights,
      autoAllow,
    });
    if (!grant) {
      return refuse("no_authority", "当前没有可派生的工作区权限（需要至少一台已注册的设备）。");
    }
    // Generation-suffixed: a closed scope key never resolves again by design,
    // and a rights change must not inherit a half-closed vault.
    const scope = JSON.stringify(["mcp-workspace", principal.owner, principal.credential, this.generation++]);
    const port = this.opts.workspaceFilesService!.open({
      scope,
      owner: principal.owner,
      backend: new RunnerWorkspaceFilesBackend(grant.authority),
      writable: grant.writable,
      contract: WORKSPACE_FILES_CONTRACT_V2,
    });
    this.workspaces.set(principal.credential, {
      owner: principal.owner,
      rightsKey,
      port,
      // Refs first (closeScope), then the capability grant: the reverse order
      // would leave resolvable refs pointing at a surrendered authority.
      close: () => {
        void this.opts.workspaceFilesService!.closeScope(scope).catch(() => undefined);
        grant.close();
      },
    });
    return { ok: true, port };
  }

  private dropWorkspaceScope(credential: string): void {
    const held = this.workspaces.get(credential);
    if (!held) return;
    this.workspaces.delete(credential);
    try {
      held.close();
    } catch {
      /* the scope is already unreachable; a failed teardown must stay local */
    }
  }

  // ── user memory / skills (the two per-owner directory planes) ──

  private async callUserFilesTool(
    principal: McpPrincipal,
    group: UserFilesGroup,
    spec: McpToolSpec,
    rawArgs: unknown,
  ): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const scoped = this.userFilesScope(principal, group, spec.gate.operation);
    if (!scoped.ok) return scoped;
    let out;
    try {
      // Field names equal the kernel operation's argument names, so the
      // validated value passes through the Gate unchanged.
      out = await scoped.grant.request(spec.gate.operation, args.value);
    } catch (err) {
      log.warn({ err, tool: spec.name, owner: principal.owner }, "mcp user-files tool failed");
      return refuse("unavailable", err instanceof Error ? err.message : String(err));
    }
    switch (out.status) {
      case "succeeded":
        return { ok: true, result: out.result };
      case "approval_required":
        return refuse(
          "approval_required",
          `这次修改已生成待批准卡，请所有者在 ${this.pendingUrl()} 批准；批准后自动执行，可用对应的读取工具复核结果。`,
        );
      case "denied":
        return refuse("no_authority", out.reason);
      default:
        // failed | unknown — the adapter's own refusal (jail, bounds, absence).
        return refuse(out.status, out.reason);
    }
  }

  /**
   * The cached capability grant for one token over one plane, reopened when
   * the EFFECTIVE rights change — the cards the old grant queued die with its
   * Context, which is the point rather than a nuisance.
   */
  private userFilesScope(
    principal: McpPrincipal,
    group: UserFilesGroup,
    operation: string,
  ): { ok: true; grant: McpUserFilesGrant } | { ok: false; code: string; message: string } {
    const plane = group === "memory" ? this.opts.memory : this.opts.skills;
    if (!plane) {
      return refuse("no_authority", group === "memory" ? "这套部署没有组合中心记忆区平面。" : "这套部署没有组合技能库平面。");
    }
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view);
    const groupIds = group === "memory" ? MCP_MEMORY_OPERATION_IDS : MCP_SKILL_OPERATION_IDS;
    const rights = groupIds.filter((op) => effective.includes(op));
    if (!rights.includes(operation)) {
      const entry = view.entries.find((e) => e.operation === operation);
      return refuse("no_authority", entry?.explanation ?? "这个操作还没有在 /permissions 的「MCP 接入」卡里授权。");
    }
    // Granted own-memory/own-skill operations are silent (O1) whether or not
    // the stored row predates them being auto-allowable; only what the catalog
    // still marks per-call (removing a skill) asks.
    const autoAllow = rights.filter((op) => !MCP_CATALOG.operation(op)?.alwaysApprove);
    const rightsKey = JSON.stringify([rights, autoAllow]);
    const held = this.userFiles[group].get(principal.credential);
    if (held && held.rightsKey === rightsKey) return { ok: true, grant: held.grant };
    if (held) this.dropUserFilesScope(group, principal.credential);
    const grant = plane.open({
      username: principal.owner,
      purpose: group === "memory" ? "MCP · 中心记忆区" : "MCP · 技能库",
      rights,
      autoAllow,
      metadata: { surface: "mcp" },
    });
    if (!grant) return refuse("no_authority", "当前没有可派生的权限（账号或目录可能已不存在）。");
    this.userFiles[group].set(principal.credential, { owner: principal.owner, rightsKey, grant });
    return { ok: true, grant };
  }

  private dropUserFilesScope(group: UserFilesGroup, credential: string): void {
    const held = this.userFiles[group].get(credential);
    if (!held) return;
    this.userFiles[group].delete(credential);
    try {
      // Hard destroy: a token revocation or a rights change must take the
      // scope's undecided approval cards with it.
      held.grant.destroy();
    } catch {
      /* same as workspace teardown */
    }
  }

  // ── collaborative documents ──

  private openCrdtGrant(context: ResourceProviderContext) {
    const crdt = this.opts.crdt;
    if (!crdt) return null;
    const effective = effectiveOperations(this.mcpView(context.owner));
    if (!effective.includes("read_document")) return null;
    const documents = crdt.documentsFor(context.owner);
    if (!documents.length) return null;
    let open = true;
    return {
      documents,
      mayEdit: effective.includes("edit_document"),
      store: crdt.store,
      /**
       * The MCP face's authority, stated as what it is: the `service:mcp`
       * consent row IS the decision, and this surface has no per-call gate —
       * exactly what its catalog row discloses ("授权即直接生效"). So every
       * request the provider routes through this seam answers "the grant
       * already allowed it", the edit lease is granted without a card, and
       * `alive` follows the scope. Folding this face onto the `crdt-doc-v1`
       * capability plane (per-sitting lease cards, kernel audit) is the
       * recorded follow-up in the 2026-08-10 crdt delivery; until then the
       * honesty lives in the consent text rather than in a gate.
       */
      authority: {
        request: async () => ({ status: "succeeded" as const, result: { granted: true } }),
        result: () => null,
        alive: () => open,
      },
      close: () => {
        open = false;
      },
    };
  }

  private crdtScope(
    principal: McpPrincipal,
    operation: string,
  ): { ok: true; scope: CrdtScope } | { ok: false; code: string; message: string } {
    if (!this.crdtComposed) return refuse("no_authority", "这套部署没有组合协作文档存储。");
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view);
    if (!effective.includes(operation)) {
      const entry = view.entries.find((e) => e.operation === operation);
      return refuse("no_authority", entry?.explanation ?? "这个操作还没有在 /permissions 的「MCP 接入」卡里授权。");
    }
    const rightsKey = JSON.stringify(MCP_CRDT_OPERATION_IDS.filter((op) => effective.includes(op)));
    const held = this.crdtScopes.get(principal.credential);
    if (held && held.rightsKey === rightsKey) return { ok: true, scope: held };
    if (held) this.dropCrdtScope(principal.credential);
    const context: ResourceProviderContext = {
      owner: principal.owner,
      publisher: "first-party",
      app: "mcp",
      packageDigest: "mcp-surface",
      permissionContractDigest: "mcp-surface",
      instance: `mcp-${this.generation}`,
      binding: "docs",
      contract: CRDT_DOC_CONTRACT,
      scope: JSON.stringify(["mcp-crdt", principal.owner, principal.credential, this.generation++]),
    };
    this.capturedRefs = null;
    const state = this.crdtProvider!.open(context);
    const refs = this.capturedRefs;
    this.capturedRefs = null;
    if (!state || !refs) {
      return refuse("no_authority", "当前没有可访问的协作文档。");
    }
    const scope: CrdtScope = { owner: principal.owner, rightsKey, state, refs, context };
    this.crdtScopes.set(principal.credential, scope);
    return { ok: true, scope };
  }

  private dropCrdtScope(credential: string): void {
    const held = this.crdtScopes.get(credential);
    if (!held) return;
    this.crdtScopes.delete(credential);
    try {
      void this.crdtProvider?.close(held.state, held.context);
    } catch {
      /* same as workspace teardown */
    }
  }

  private callCrdtList(principal: McpPrincipal): McpToolOutcome {
    const scoped = this.crdtScope(principal, CRDT_LIST_TOOL.gate.operation);
    if (!scoped.ok) return scoped;
    return {
      ok: true,
      result: {
        documents: [...scoped.scope.refs.entries()].map(([ref, doc]) => ({ ref, label: doc.label })),
      },
    };
  }

  private async callCrdtTool(principal: McpPrincipal, action: string, rawArgs: unknown): Promise<McpToolOutcome> {
    const declared = CRDT_DOC_DECLARATION.byAction[action as "open_doc" | "apply_update" | "read_updates"];
    if (!declared) return refuse("unknown_tool", `没有对应动作 ${action}。`);
    const gate = declared.operation === "edit_document" ? "edit_document" : "read_document";
    const scoped = this.crdtScope(principal, gate);
    if (!scoped.ok) return scoped;
    // Flat string params, exactly what the provider's contract reader decodes;
    // unknown keys are refused so an invented argument is never "accepted".
    if (rawArgs === undefined || rawArgs === null) rawArgs = {};
    if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return refuse("invalid_params", "arguments 必须是对象");
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(declared.params, key)) {
        return refuse("invalid_params", `未声明的参数：${key}`);
      }
      if (typeof value !== "string") return refuse("invalid_params", `${key} 必须是字符串`);
      params[key] = value;
    }
    const answer = await this.crdtProvider!.dispatch(
      scoped.scope.state,
      wireActionOf(action),
      params,
      scoped.scope.context,
    );
    return answer.ok ? { ok: true, result: answer.result } : refuse(answer.code, answer.message);
  }

  // ── declared Apps (state through AppInstanceService; ACL administration through the trusted shell service) ──

  /** The apps group holds no per-token scope to cache: nothing to reopen, nothing to tear down. */
  private appsGate(principal: McpPrincipal, operation: string): { ok: false; code: string; message: string } | null {
    if (!this.appsComposed) return refuse("no_authority", "这套部署没有组合可操作的 App 目录。");
    const view = this.mcpView(principal.owner);
    if (!effectiveOperations(view).includes(operation)) {
      const entry = view.entries.find((e) => e.operation === operation);
      return refuse("no_authority", entry?.explanation ?? "这个操作还没有在 /permissions 的「MCP 接入」卡里授权。");
    }
    return null;
  }

  private groupAllowed(principal: McpPrincipal, group: McpToolGroup): boolean {
    return !principal.policy || principal.policy.groups.includes(group);
  }

  private toolGroup(name: string): McpToolGroup | null {
    const spec = [...RUNNER_CAPABILITY_TOOLS, ...MEETING_TRANSCRIPTION_TOOLS, ...DISCUSSION_TOOLS, ...SESSION_TOOLS, ...WORKSPACE_TOOLS, ...MEMORY_TOOLS, ...SKILL_TOOLS, ...APP_TOOLS, ...FEISHU_TOOLS, ...EXECUTION_TOOLS, ...KNOWLEDGE_TOOLS, ...DOCS_TOOLS]
      .find((candidate) => candidate.name === name);
    if (spec) return spec.group;
    if (name === CRDT_LIST_TOOL.name || CRDT_TOOLS.some((tool) => tool.definition.name === name)) return "crdt";
    if (name === APP_DISPATCH_TOOL.definition.name) return "apps";
    return null;
  }

  /** Token policy is only an additional allowlist; the App door remains authoritative. */
  private appPolicyGate(
    principal: McpPrincipal,
    appId: string,
    instanceKey?: string,
    action?: string,
  ): { ok: false; code: string; message: string } | null {
    const policy = principal.policy?.apps;
    if (!policy) return null;
    if (policy.ids && !policy.ids.includes(appId)) return refuse("no_authority", "这个 MCP 令牌不允许访问该 App。");
    if (instanceKey && policy.instances && !policy.instances.includes(instanceKey)) {
      return refuse("no_authority", "这个 MCP 令牌不允许访问该共享实例。");
    }
    if (action && policy.actions && !policy.actions.includes(action)) {
      return refuse("no_authority", "这个 MCP 令牌不允许提交该 App 动作。");
    }
    return null;
  }

  private appTarget(
    appId: string,
  ): { ok: true; app: McpDeclaredApp; service: McpAppInstancePort } | { ok: false; code: string; message: string } {
    const app = this.opts.apps!.get(appId);
    if (!app) return refuse("unknown_app", "没有这个 App — 先用 app_list 看可用的 id。");
    if (!app.service) return refuse("unavailable", app.unavailable ?? "这个 App 在本进程没有后端。");
    return { ok: true, app, service: app.service };
  }

  /**
   * One tool call = one agent turn at the SAME door a tab drives: open
   * (admission, State read, sandbox projection), do the work, destroy. Nothing
   * survives this scope, so a token end, a grant revocation or a release
   * activation between two calls is honoured by the next call opening anew —
   * `SessionPlusAgentBackend.openTurn`'s lifetime, without the standing plane.
   */
  private async inAppTurn<T>(
    principal: McpPrincipal,
    service: McpAppInstancePort,
    instanceKey: string | undefined,
    work: (turn: OpenAgentAppInstance) => Promise<T>,
  ): Promise<T> {
    const turn = await service.openAgentTurn({
      owner: principal.owner,
      agent: "mcp",
      useMemberRole: true,
      turnId: randomUUID(),
      ...(instanceKey ? { instanceKey } : {}),
    });
    try {
      return await work(turn);
    } finally {
      service.closeInstance(turn.handle, turn.principal);
    }
  }

  private async callAppTool(principal: McpPrincipal, spec: McpToolSpec, rawArgs: unknown): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const gate = this.appsGate(principal, spec.gate.operation);
    if (gate) return gate;
    if (spec.name.startsWith("app_shared_")) {
      const management = this.opts.apps?.management;
      if (!management) return refuse("unavailable", "当前部署未组合共享项目管理。");
      const appId = String(args.value.app ?? "");
      const instance = String(args.value.instance ?? "");
      const policy = this.appPolicyGate(principal, appId, instance || undefined, spec.name);
      if (policy) return policy;
      if (spec.name === "app_shared_create" && principal.policy?.apps?.instances) {
        return refuse("no_authority", "限定既有实例的令牌不能创建新项目。");
      }
      try {
        const owner = principal.owner;
        let result: Record<string, unknown>;
        switch (spec.name) {
          case "app_shared_create": result = management.create(owner, appId, String(args.value.role)); break;
          case "app_shared_members": result = management.members(owner, appId, instance); break;
          case "app_shared_set_member": result = management.setMember(owner, appId, instance, String(args.value.member), String(args.value.role)); break;
          case "app_shared_remove_member": result = management.removeMember(owner, appId, instance, String(args.value.member)); break;
          case "app_shared_close": result = management.close(owner, appId, instance); break;
          default: return refuse("unknown_tool", "未声明的共享管理操作。");
        }
        return { ok: true, result: { app: appId, ...result } };
      } catch (error) {
        if (error instanceof SharedManagementError) return refuse(error.code, error.message);
        // A store/invalidation failure may follow a committed mutation. Do not invite a retry.
        return refuse("unknown", "共享管理结果未确认；请核对成员或实例状态后再操作。");
      }
    }
    switch (spec.name) {
      case "app_list":
        return this.appList(principal);
      case "app_read_projection": {
        const appId = String(args.value.app ?? "");
        const instanceKey = typeof args.value.instance === "string" ? args.value.instance : undefined;
        const policy = this.appPolicyGate(principal, appId, instanceKey);
        if (policy) return policy;
        const target = this.appTarget(appId);
        if (!target.ok) return target;
        const path = typeof args.value.path === "string" ? args.value.path : "";
        const cursor = typeof args.value.cursor === "number" ? args.value.cursor : 0;
        try {
          return await this.inAppTurn(principal, target.service, instanceKey, async (turn) => {
            const window = projectionWindow(turn.projection, path, cursor);
            if (!window.ok) return refuse("invalid_params", window.message);
            return {
              ok: true as const,
              result: {
                app: target.app.stableAppId,
                ...(instanceKey ? { instance: instanceKey } : {}),
                revision: turn.revision,
                ...window.value,
              },
            };
          });
        } catch (err) {
          log.warn({ err, app: target.app.stableAppId, owner: principal.owner }, "mcp app projection failed");
          return refuse("unavailable", err instanceof Error ? err.message : String(err));
        }
      }
      case "app_read_log": {
        const appId = String(args.value.app ?? "");
        const instanceKey = typeof args.value.instance === "string" ? args.value.instance : undefined;
        const policy = this.appPolicyGate(principal, appId, instanceKey);
        if (policy) return policy;
        const target = this.appTarget(appId);
        if (!target.ok) return target;
        const read = await target.service.readLog(principal.owner, {
          ...(typeof args.value.instance === "string" ? { instanceKey: args.value.instance } : {}),
          sinceSeq: Number(args.value.since_seq ?? 0),
          limit: Number(args.value.limit ?? 50),
        });
        if (!read.ok) return refuse(read.code, read.message);
        return {
          ok: true,
          result: {
            app: target.app.stableAppId,
            ...(typeof args.value.instance === "string" ? { instance: args.value.instance } : {}),
            head: read.head,
            commits: read.commits.map((commit) => ({
              seq_from: commit.seqFrom,
              seq_to: commit.seqTo,
              at: commit.at,
              actor: commit.actor,
              action: commit.action,
              dispatch_id: commit.dispatchId,
              params_hash: commit.paramsHash,
              backend_code_digest: commit.backendCodeDigest,
              event_count: commit.eventCount,
            })),
          },
        };
      }
      default:
        return refuse("unknown_tool", `没有名为 ${spec.name} 的工具。`);
    }
  }

  private appList(principal: McpPrincipal): McpToolOutcome {
    const appPolicy = principal.policy?.apps;
    const apps = this.opts.apps!.list().filter((app) => !appPolicy?.ids || appPolicy.ids.includes(app.stableAppId)).map((app) => {
      const surface = app.service?.actionSurface("agent") ?? null;
      const instances = this.opts.apps!.instancesFor?.(app.stableAppId, principal.owner) ?? [];
      return {
        app: app.stableAppId,
        title: app.title,
        publisher: app.publisher,
        package_digest: surface?.release.packageDigest ?? app.packageDigest,
        backend_code_digest: surface?.release.backendCodeDigest ?? null,
        state_scope: surface?.stateScope ?? null,
        ...(surface?.stateScope === "shared"
          ? { roles: app.service?.sharedRoles(), instances: [...instances].filter((row) => !appPolicy?.instances || appPolicy.instances.includes(row.instance)) }
          : {}),
        ...(app.unavailable ? { unavailable: app.unavailable } : {}),
        // The agent half of the same `app.yaml` table the door normalises
        // against; `human_only` actions are absent here AND refused there.
        actions: (surface?.actions ?? [])
          .filter((row) => !appPolicy?.actions || appPolicy.actions.includes(row.name))
          .map((row) => appActionTool(row.name, row.spec)),
      };
    });
    return { ok: true, result: { apps } };
  }

  private async callAppDispatch(principal: McpPrincipal, rawArgs: unknown): Promise<McpToolOutcome> {
    const gate = this.appsGate(principal, APP_DISPATCH_TOOL.gate.operation);
    if (gate) return gate;
    // The top level is the closed schema the tool published, checked by hand
    // because `params` is a map the shared field tables cannot express.
    if (rawArgs === undefined || rawArgs === null) rawArgs = {};
    if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return refuse("invalid_params", "arguments 必须是对象");
    const input = rawArgs as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== "app" && key !== "instance" && key !== "action" && key !== "params") {
        return refuse("invalid_params", `未声明的参数：${key}`);
      }
    }
    const appId = input.app;
    const action = input.action;
    const instanceKey = input.instance;
    if (typeof appId !== "string" || !appId || appId.length > 64) {
      return refuse("invalid_params", "app 必须是 app_list 给出的稳定 id");
    }
    if (typeof action !== "string" || !action || action.length > 64) {
      return refuse("invalid_params", "action 必须是 app_list 给出的动作名");
    }
    if (instanceKey !== undefined && (typeof instanceKey !== "string" || !instanceKey || instanceKey.length > 96)) {
      return refuse("invalid_params", "instance 必须是 app_list 给出的共享实例标识");
    }
    const params = input.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) return refuse("invalid_params", "params 必须是对象");
    const policy = this.appPolicyGate(
      principal,
      appId,
      typeof instanceKey === "string" ? instanceKey : undefined,
      action,
    );
    if (policy) return policy;
    // research-v2's declared dispatcher forwards to another contract action.
    // Both names must survive token attenuation; App/member/capability checks
    // still run at the existing door. A discovery wrapper cannot widen a token.
    if (appId === RESEARCH_APP && action === "tools_invoke") {
      const tool = (params as Record<string, unknown>).tool;
      if (typeof tool !== "string" || !tool || tool.length > 160)
        return refuse("invalid_params", "tool 必须是已登记的项目动作名");
      const nestedPolicy = this.appPolicyGate(principal, appId, typeof instanceKey === "string" ? instanceKey : undefined, tool);
      if (nestedPolicy) return nestedPolicy;
    }
    const target = this.appTarget(appId);
    if (!target.ok) return target;
    // Undeclared param KEYS are refused here against the same manifest surface
    // the door normalises with — `normalizeSessionPlusAction` copies declared
    // fields and ignores the rest, which is right for a button wire and wrong
    // for a model that reads silence as acceptance. An action absent from the
    // agent surface (unknown, or `human_only`) falls through untouched so the
    // DOOR states the refusal: one authority, not two.
    const declared = target.service.actionSurface("agent")?.actions.find((row) => row.name === action);
    if (declared) {
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(declared.spec.params, key)) {
          return refuse("invalid_params", `未声明的参数：${key}`);
        }
        if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          return refuse("invalid_params", `参数 ${key} 必须是字符串、数字或布尔`);
        }
      }
    }
    try {
      return await this.inAppTurn(principal, target.service, typeof instanceKey === "string" ? instanceKey : undefined, async (turn) => {
        const answer = await target.service.dispatch(turn.handle, turn.principal, { action, params });
        if (!answer.ok) return refuse(answer.code, answer.message);
        return {
          ok: true as const,
          result: {
            app: target.app.stableAppId,
            ...(typeof instanceKey === "string" ? { instance: instanceKey } : {}),
            action,
            revision: answer.revision,
            result: answer.result,
            ...renderedProjection(answer.projection),
          },
        };
      });
    } catch (err) {
      log.warn({ err, app: target.app.stableAppId, owner: principal.owner }, "mcp app dispatch failed");
      return refuse("unavailable", err instanceof Error ? err.message : String(err));
    }
  }

  // ── Feishu (reviewed user OAuth plus deployment-ceilinged privileged tools) ──

  private feishuScope(
    principal: McpPrincipal,
    operation: string,
  ): { ok: true; grant: McpFeishuGrant; pending: Map<string, string> } | { ok: false; code: string; message: string } {
    if (!this.feishuComposed) return refuse("no_authority", "这套部署没有组合飞书能力平面。");
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view);
    const rights = this.feishuRights(principal.owner).filter((candidate) => effective.includes(candidate));
    if (!rights.includes(operation)) {
      const entry = view.entries.find((row) => row.operation === operation);
      return refuse(
        "no_authority",
        entry?.explanation ?? "这个飞书操作未获 MCP 授权，或未列入该用户的部署级特权白名单。",
      );
    }
    const ordinaryRights = rights.filter((candidate) => !FEISHU_PRIVILEGED_OPERATIONS[candidate]);
    const privilegedRights = rights.filter((candidate) => Boolean(FEISHU_PRIVILEGED_OPERATIONS[candidate]));
    const auto = autoAllowedOperations(view);
    const autoAllow = ordinaryRights.filter((candidate) => auto.includes(candidate));
    const rightsKey = JSON.stringify([ordinaryRights, autoAllow, privilegedRights]);
    const wantsPrivileged = Boolean(FEISHU_PRIVILEGED_OPERATIONS[operation]);
    const held = this.feishuScopes.get(principal.credential);
    if (held && held.rightsKey === rightsKey) {
      const grant = wantsPrivileged ? held.privileged : held.ordinary;
      return grant
        ? { ok: true, grant, pending: held.pending }
        : refuse("no_authority", "当前飞书身份无法派生这项权限。");
    }
    if (held) this.dropFeishuScope(principal.credential);
    const ordinary = ordinaryRights.length
      ? this.opts.feishu!.open({
          username: principal.owner,
          purpose: "MCP · 飞书（用户 OAuth）",
          kind: "session",
          rights: ordinaryRights,
          autoAllow,
          metadata: { surface: "mcp" },
        })
      : null;
    const privileged = privilegedRights.length
      ? this.opts.feishu!.openPrivileged({
          username: principal.owner,
          purpose: "MCP · 飞书（特权）",
          kind: "session",
          rights: privilegedRights,
          metadata: { surface: "mcp" },
        })
      : null;
    const grant = wantsPrivileged ? privileged : ordinary;
    if (!grant) {
      try { ordinary?.destroy(); } catch { /* never published */ }
      try { privileged?.destroy(); } catch { /* never published */ }
      return refuse("no_authority", "飞书后端尚未校验完成、身份未连接，或当前没有可派生的飞书权限。");
    }
    const pending = new Map<string, string>();
    this.feishuScopes.set(principal.credential, {
      owner: principal.owner,
      rightsKey,
      ordinary,
      privileged,
      pending,
    });
    return { ok: true, grant, pending };
  }

  private async callFeishuTool(
    principal: McpPrincipal,
    spec: McpToolSpec,
    rawArgs: unknown,
  ): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const scoped = this.feishuScope(principal, spec.gate.operation);
    if (!scoped.ok) return scoped;
    let gateArgs = args.value;
    if (spec.gate.operation === SEND_FILE_BY_PATH_OPERATION && gateArgs.path !== undefined) {
      const { path: mention, ...rest } = gateArgs;
      if (rest.file_base64 !== undefined) return refuse("invalid_params", "path 与 file_base64 只能二选一。");
      const source = await this.callerFileSource(principal, String(mention));
      if (!source.ok) return source;
      gateArgs = { ...rest, ...source.args };
    }
    // An approved call runs when the owner approves it; asking again with the
    // same arguments collects that run instead of raising a second card for a
    // write that may already have happened.
    const argsKey = createHash("sha256")
      .update(JSON.stringify([spec.gate.operation, Object.entries(gateArgs).sort(([a], [b]) => a.localeCompare(b))]))
      .digest("hex");
    const waiting = scoped.pending.get(argsKey);
    if (waiting) {
      const view = scoped.grant.capabilities.result(waiting);
      if (view?.state === "pending" || view?.state === "claimed") {
        return refuse("approval_required", `这次飞书操作仍在等待本人在 ${this.pendingUrl()} 批准（${waiting}）。`);
      }
      scoped.pending.delete(argsKey);
      if (view?.state === "finished") {
        return view.outcome === "succeeded"
          ? feishuSuccess(spec.gate.operation, view.result)
          : refuse(view.outcome ?? "failed", view.reason ?? "飞书操作失败。");
      }
      if (view?.state === "rejected" || view?.state === "expired") {
        return refuse("no_authority", view.state === "rejected" ? "本人拒绝了这次飞书操作。" : "这次飞书操作的待批准卡已过期，请重新发起。");
      }
      // No view: the scope was rotated or the process restarted; ask afresh.
    }
    let out;
    try {
      out = await scoped.grant.capabilities.request(scoped.grant.slot, spec.gate.operation, gateArgs);
    } catch (error) {
      log.warn({ err: error, owner: principal.owner, operation: spec.gate.operation }, "MCP Feishu call failed");
      return refuse("unavailable", error instanceof Error ? error.message : String(error));
    }
    if (out.status === "succeeded") return feishuSuccess(spec.gate.operation, out.result);
    if (out.status === "approval_required") {
      scoped.pending.set(argsKey, out.pendingCallId);
      // Uncollected decisions are not kept forever; the oldest goes first.
      while (scoped.pending.size > FEISHU_PENDING_MAX) scoped.pending.delete(scoped.pending.keys().next().value!);
      return refuse(
        "approval_required",
        `这次飞书操作已生成待批准卡，请本人在 ${this.pendingUrl()} 批准；批准后用完全相同的参数再调用一次即可取回结果，不要换参数重发（${out.pendingCallId}）。`,
      );
    }
    return refuse(out.status === "denied" ? "no_authority" : out.status, out.reason);
  }

  /**
   * A file on the caller session's own device, as the gate arguments of a
   * by-reference send: where it is (device from the trusted caller, workspace
   * and relative path from the device's own placement), its size and SHA-256.
   * The device and session never come from tool arguments; without a caller
   * session there is no device to name, so the answer says what is needed.
   */
  private async callerFileSource(principal: McpPrincipal, mention: string): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; code: string; message: string }> {
    const caller = principal.caller;
    if (!caller) {
      return refuse("invalid_params", "按路径发文件需要知道你在哪台设备上：只有经本机 Runner 桥接的 Agent 会话带有调用方会话（由 Runner 认定），这个连接没有。"
        + `请从这样的会话调用，或改用 file_base64（一次能力调用最多约 378 KB）。`);
    }
    const files = this.opts.callerFiles?.();
    if (!files) return refuse("unavailable", "这个 Octopus 没有接通工作区文件，无法按路径发送文件；请改用 file_base64。");
    try {
      const target = await files.resolve({ owner: principal.owner, device: caller.device, cliKind: caller.source, sessionId: caller.sessionId }, mention);
      const content = await files.read(principal.owner, caller.device, target);
      if (content.kind !== "file") return refuse("invalid_params", `${mention} 是一个目录，不是文件。`);
      if (!content.size) return refuse("invalid_params", "文件是空的；飞书不接收空文件。");
      if (content.size > FEISHU_FILE_MAX_BYTES) {
        return refuse("too_large", `文件有 ${(content.size / 1048576).toFixed(1)} MB；飞书 im/v1/files 只接收 30 MB 以内的文件。`);
      }
      const hash = createHash("sha256");
      let seen = 0;
      for await (const part of content.chunks) {
        seen += part.length;
        hash.update(part);
      }
      if (seen !== content.size) return refuse("refused", "文件在读取过程中变化了，请重试。");
      return { ok: true, args: {
        source_device: caller.device,
        source_workspace: target.workspace.workspaceId,
        source_path: target.relativePath,
        file_size: content.size,
        file_sha256: hash.digest("hex"),
      } };
    } catch (error) {
      if (error instanceof DocsAddonError && error.status === 404) {
        return refuse("not_found", `${mention}：${error.message}。文件须在这台设备已登记的某个工作区里（可以先放进当前工作目录），或者用 file_base64。`);
      }
      return refuse("refused", error instanceof Error ? error.message.slice(0, 400) : "无法读取这个文件");
    }
  }

  private dropFeishuScope(credential: string): void {
    const held = this.feishuScopes.get(credential);
    if (!held) return;
    this.feishuScopes.delete(credential);
    try { held.ordinary?.destroy(); } catch { /* already unreachable */ }
    try { held.privileged?.destroy(); } catch { /* already unreachable */ }
  }

  // ── on-demand execution scopes (the dsh remote-backend door) ──

  /**
   * One token asks for (or lists targets for) a session-execution scope over
   * the owner's own device. The call goes through the execution-scope Object's
   * Gate with the caller's credential handle injected as `issuer`; a success
   * answers with a pickup the registry redeems in memory, once, for this same
   * principal — the plaintext never rides a Gate result.
   *
   * An `approval_required` is remembered by its args key: the caller retries the
   * SAME call after the owner decides and collects the finished outcome through
   * the kernel's own result view instead of raising a second card.
   */
  private async callExecutionTool(
    principal: McpPrincipal,
    spec: McpToolSpec,
    rawArgs: unknown,
  ): Promise<McpToolOutcome> {
    if (principal.policy?.sessionExecution) return refuse("unknown_tool", `没有名为 ${spec.name} 的工具。`);
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse("invalid_params", args.message);
    const scoped = this.executionScope(principal, spec.gate.operation);
    if (!scoped.ok) return scoped;
    const hold = scoped.hold;
    const isOpen = spec.name === OPEN_WORKSPACE_EXECUTION;
    const gateArgs: Record<string, unknown> = isOpen ? { ...args.value, issuer: principal.credential } : args.value;
    const argsKey = JSON.stringify([spec.gate.operation, Object.entries(gateArgs).sort(([a], [b]) => a.localeCompare(b))]);

    const collected = hold.pending.get(argsKey);
    if (collected) {
      const view = hold.grant.capabilities.result(collected);
      if (view && (view.state === "pending" || view.state === "claimed")) {
        return refuse("approval_required", `这次签发仍在等待本人在 ${this.pendingUrl()} 批准（${collected}）。`);
      }
      hold.pending.delete(argsKey);
      if (view && view.state === "finished") {
        if (view.outcome === "succeeded") return this.redeemExecution(principal, view.result);
        return refuse(view.outcome ?? "failed", view.reason ?? "签发失败");
      }
      if (view && (view.state === "rejected" || view.state === "expired")) {
        return refuse("no_authority", view.state === "rejected" ? "本人拒绝了这次签发。" : "这次签发的待批准卡已过期，请重新发起。");
      }
      // No view: the Context was rotated or the process restarted; fall through to a fresh ask.
    }

    let out;
    try {
      out = await hold.grant.request(spec.gate.operation, gateArgs);
    } catch (err) {
      log.warn({ err, tool: spec.name, owner: principal.owner }, "mcp execution-scope tool failed");
      return refuse("unavailable", err instanceof Error ? err.message : String(err));
    }
    switch (out.status) {
      case "succeeded":
        return isOpen ? this.redeemExecution(principal, out.result) : { ok: true, result: out.result };
      case "approval_required":
        hold.pending.set(argsKey, out.pendingCallId);
        return refuse(
          "approval_required",
          `这次签发已生成待批准卡，请本人在 ${this.pendingUrl()} 批准；批准后用完全相同的参数再调用一次即可领取凭证（${out.pendingCallId}）。`,
        );
      case "denied":
        return refuse("no_authority", out.reason);
      default:
        return refuse(out.status, out.reason);
    }
  }

  private redeemExecution(principal: McpPrincipal, result: unknown): McpToolOutcome {
    const pickup = result && typeof result === "object" ? (result as Partial<ExecutionScopePickup>).pickup : undefined;
    const issued = typeof pickup === "string" ? this.opts.sessionExecution?.redeem(pickup, principal) : null;
    if (!issued) return refuse("unavailable", "签发的凭证已无法领取（可能已过期或被撤销），请重新发起。");
    return { ok: true, result: issued };
  }

  private executionScope(
    principal: McpPrincipal,
    operation: string,
  ): { ok: true; hold: ExecutionScopeHold } | { ok: false; code: string; message: string } {
    const plane = this.opts.executionScopes;
    if (!plane || !this.opts.sessionExecution) return refuse("no_authority", "这套部署没有组合远程执行作用域签发面。");
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view);
    const rights = MCP_EXECUTION_OPERATION_IDS.filter((op) => effective.includes(op));
    if (!rights.includes(operation)) {
      const entry = view.entries.find((e) => e.operation === operation);
      return refuse("no_authority", entry?.explanation ?? "这个操作还没有在 /permissions 的「MCP 接入」卡里授权。");
    }
    const auto = autoAllowedOperations(view);
    const autoAllow = rights.filter((op) => auto.includes(op));
    const rightsKey = JSON.stringify([rights, autoAllow]);
    const held = this.executionScopes.get(principal.credential);
    if (held && held.rightsKey === rightsKey) return { ok: true, hold: held };
    if (held) this.dropExecutionScope(principal.credential);
    const grant = plane.open({
      username: principal.owner,
      purpose: "MCP · 远程执行作用域",
      rights,
      autoAllow,
      metadata: { surface: "mcp", credential: principal.credential },
    });
    if (!grant) return refuse("no_authority", "当前没有可派生的签发权限（需要至少一台已注册的设备）。");
    const hold: ExecutionScopeHold = { owner: principal.owner, rightsKey, grant, pending: new Map() };
    this.executionScopes.set(principal.credential, hold);
    return { ok: true, hold };
  }

  private dropExecutionScope(credential: string): void {
    const held = this.executionScopes.get(credential);
    if (!held) return;
    this.executionScopes.delete(credential);
    try { held.grant.destroy(); } catch { /* already unreachable */ }
  }

  // ── lifecycle ──

  private releaseAccountTools(owner: string, credential: string): void {
    this.dropRunnerCapability(credential);
    this.dropTranscription(credential);
    this.dropDiscussion(credential);
    this.dropFeishuScope(credential);
    this.opts.hub.releaseCredential(owner, credential);
    this.opts.sessionOperations?.endCredential(owner, credential);
  }

  /** One token ended: its refs, streams, grants and hub Contexts go with it. */
  releaseCredential(owner: string, credential: string): void {
    this.releaseAccountTools(owner, credential);
    this.dropWorkspaceScope(credential);
    this.dropCrdtScope(credential);
    this.dropUserFilesScope("memory", credential);
    this.dropUserFilesScope("skills", credential);
    this.dropExecutionScope(credential);
    this.opts.sessionExecution?.releaseCredential(credential);
    this.opts.ticketDevelopment?.releaseCredential(credential);
  }

  /** A Runner identity changed: retire exact-device scopes and broad rosters. */
  releaseRunnerDevice(owner: string, device: string): void {
    for (const [credential, scope] of this.runnerCapabilityScopes) if (scope.owner === owner) this.dropRunnerCapability(credential);
    this.opts.sessionExecution?.releaseDevice(owner, device);
    // These scopes deliberately cover the owner's whole device roster. The
    // exact-device execution scopes above, documents and external services
    // have independent lifecycles.
    for (const [credential, scope] of [...this.workspaces]) {
      if (scope.owner === owner) this.dropWorkspaceScope(credential);
    }
    for (const [credential, scope] of [...this.executionScopes]) {
      if (scope.owner === owner) this.dropExecutionScope(credential);
    }
  }

  /** The owner's `service:mcp` authority changed: every scope of theirs ends. */
  releaseOwner(owner: string): void {
    for (const [credential, scope] of this.runnerCapabilityScopes) if (scope.owner === owner) this.dropRunnerCapability(credential);
    for (const [credential, scope] of this.transcriptionScopes) if (scope.owner === owner) this.dropTranscription(credential);
    for (const [credential, scope] of this.discussionScopes) if (scope.owner === owner) this.dropDiscussion(credential);
    this.opts.sessionExecution?.releaseOwner(owner);
    this.opts.ticketDevelopment?.releaseOwner(owner);
    for (const [credential, scope] of [...this.workspaces]) {
      if (scope.owner === owner) this.dropWorkspaceScope(credential);
    }
    for (const [credential, scope] of [...this.crdtScopes]) {
      if (scope.owner === owner) this.dropCrdtScope(credential);
    }
    for (const group of ["memory", "skills"] as const) {
      for (const [credential, scope] of [...this.userFiles[group]]) {
        if (scope.owner === owner) this.dropUserFilesScope(group, credential);
      }
    }
    for (const [credential, scope] of [...this.feishuScopes]) {
      if (scope.owner === owner) this.dropFeishuScope(credential);
    }
    for (const [credential, scope] of [...this.executionScopes]) {
      if (scope.owner === owner) this.dropExecutionScope(credential);
    }
  }

  close(): void {
    this.closed = true;
    for (const credential of this.runnerCapabilityScopes.keys()) this.dropRunnerCapability(credential);
    for (const credential of this.transcriptionScopes.keys()) this.dropTranscription(credential);
    for (const credential of this.discussionScopes.keys()) this.dropDiscussion(credential);
    this.opts.sessionExecution?.close();
    this.detachExecutionRelease?.();
    this.opts.ticketDevelopment?.close();
    for (const credential of [...this.workspaces.keys()]) this.dropWorkspaceScope(credential);
    for (const credential of [...this.crdtScopes.keys()]) this.dropCrdtScope(credential);
    for (const group of ["memory", "skills"] as const) {
      for (const credential of [...this.userFiles[group].keys()]) this.dropUserFilesScope(group, credential);
    }
    for (const credential of [...this.feishuScopes.keys()]) this.dropFeishuScope(credential);
    for (const credential of [...this.executionScopes.keys()]) this.dropExecutionScope(credential);
  }

  private pendingUrl(): string {
    const base = (this.opts.publicUrl ?? "").replace(/\/+$/, "");
    return base ? `${base}/pending` : "/pending";
  }


  private dropRunnerCapability(credential: string): void {
    this.runnerCapabilityScopes.get(credential)?.grant.destroy();
    this.runnerCapabilityScopes.delete(credential);
  }
  private async callRunnerCapability(principal: McpPrincipal, spec: McpToolSpec, raw: unknown): Promise<McpToolOutcome> {
    const parsed = readToolArgs(spec, raw);
    if (!parsed.ok) return refuse("invalid_params", parsed.message);
    const view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view), auto = autoAllowedOperations(view);
    const rights = Object.keys(RUNNER_EXTENSION_OPERATIONS).filter(op => effective.includes(op));
    const autoAllow = rights.filter(op => auto.includes(op));
    if (!rights.includes(spec.gate.operation)) return refuse("no_authority", "Grant Runner capabilities separately in /permissions.");
    const key = JSON.stringify([principal.owner, rights, autoAllow]);
    let scope = this.runnerCapabilityScopes.get(principal.credential);
    if (scope && scope.key !== key) { this.dropRunnerCapability(principal.credential); scope = undefined; }
    if (!scope) {
      const grant = this.opts.runnerCapabilities!.open(principal.owner, rights, autoAllow);
      if (!grant) return refuse("no_authority", "Runner capability authority unavailable.");
      scope = { owner: principal.owner, key, grant, pending: new Map() };
      this.runnerCapabilityScopes.set(principal.credential, scope);
    }
    const live = () => !this.closed && this.runnerCapabilityScopes.get(principal.credential) === scope
      && effectiveOperations(this.mcpView(principal.owner)).includes(spec.gate.operation)
      && (!principal.policy?.sessionExecution || Boolean(this.opts.sessionExecution?.resolve(principal)));
    const argsKey = JSON.stringify([spec.gate.operation, Object.entries(parsed.value).sort(([a], [b]) => a.localeCompare(b))]);
    const pending = scope.pending.get(argsKey);
    if (pending) {
      const result = scope.grant.capabilities.result(pending);
      if (!live()) return refuse("no_authority", "Runner capability grant revoked.");
      if (result?.state === "pending" || result?.state === "claimed") return refuse("approval_required", `Approve at ${this.pendingUrl()} (${pending}).`);
      scope.pending.delete(argsKey);
      if (result?.state === "finished") return result.outcome === "succeeded" ? { ok: true, result: result.result } : refuse(result.outcome === "unknown" ? "indeterminate" : result.outcome ?? "failed", result.reason ?? "Runner capability failed.");
      return refuse("no_authority", "Approval expired or was revoked.");
    }
    try {
      const out = await scope.grant.request(spec.gate.operation, parsed.value);
      if (!live()) return refuse("no_authority", "Runner capability grant revoked; a dispatched effect may have completed. Do not retry.");
      if (out.status === "succeeded") return { ok: true, result: out.result };
      if (out.status === "approval_required") {
        scope.pending.set(argsKey, out.pendingCallId);
        return refuse("approval_required", `Approve at ${this.pendingUrl()}, then submit identical arguments to retrieve the result (${out.pendingCallId}).`);
      }
      return refuse(out.status === "unknown" ? "indeterminate" : out.status, out.reason);
    } catch { return refuse("indeterminate", "Runner capability result unavailable; do not retry with a new request_id."); }
  }

  private dropTranscription(credential: string): void {
    this.transcriptionScopes.get(credential)?.grant.destroy();
    this.transcriptionScopes.delete(credential);
  }

  private async callTranscription(principal: McpPrincipal, spec: McpToolSpec, rawArgs: unknown): Promise<McpToolOutcome> {
    const parsed = readToolArgs(spec, rawArgs);
    if (!parsed.ok) return refuse("invalid_params", parsed.message);
    const action = Object.keys(MEETING_TRANSCRIPTION_ACTIONS).find(key => MEETING_TRANSCRIPTION_ACTIONS[key as keyof typeof MEETING_TRANSCRIPTION_ACTIONS].operation === spec.gate.operation) as keyof typeof MEETING_TRANSCRIPTION_ACTIONS;
    try { parseMeetingTranscriptionRequest(action, parsed.value); }
    catch (error) { return refuse("invalid_params", error instanceof Error ? error.message : "invalid transcription request"); }
    const plane = this.opts.meetingTranscription!, view = this.mcpView(principal.owner);
    const effective = effectiveOperations(view), auto = autoAllowedOperations(view);
    const rights = MCP_MEETING_TRANSCRIPTION_OPERATION_IDS.filter(op => effective.includes(op)), autoAllow = rights.filter(op => auto.includes(op));
    if (!rights.includes(spec.gate.operation)) return refuse("no_authority", "请在 /permissions 的 MCP 接入中单独授权录音转写；既有执行或会议授权不会自动扩大。");
    const key = JSON.stringify([plane.device, rights, autoAllow]);
    let scope = this.transcriptionScopes.get(principal.credential);
    if (scope && (scope.owner !== principal.owner || scope.key !== key)) { this.dropTranscription(principal.credential); scope = undefined; }
    if (!scope) {
      const grant = plane.capabilities.open({ username: principal.owner, device: plane.device, purpose: "MCP recording transcription", kind: "agent-run", rights, autoAllow });
      if (!grant) return refuse("no_authority", "录音转写设备授权不可用。");
      scope = { owner: principal.owner, key, grant, pending: new Map() };
      this.transcriptionScopes.set(principal.credential, scope);
    }
    const live = () => !this.closed && this.transcriptionScopes.get(principal.credential) === scope
      && effectiveOperations(this.mcpView(principal.owner)).includes(spec.gate.operation);
    const args = { ...parsed.value, device: plane.device };
    const argsKey = JSON.stringify([spec.gate.operation, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);
    const pending = scope.pending.get(argsKey);
    if (pending) {
      const result = scope.grant.capabilities.result(pending);
      if (!live()) return refuse("no_authority", "录音转写授权已撤销。");
      if (result?.state === "pending" || result?.state === "claimed") return refuse("approval_required", `等待本人在 ${this.pendingUrl()} 批准录音转写 (${pending})。`);
      scope.pending.delete(argsKey);
      if (result?.state === "finished") return result.outcome === "succeeded" ? { ok: true, result: result.result } : refuse(result.outcome ?? "failed", result.reason ?? "录音转写失败。");
      return refuse("no_authority", "录音转写批准已过期、拒绝或撤销。");
    }
    try {
      const out = await scope.grant.request(spec.gate.operation, args);
      if (!live()) return refuse("no_authority", "录音转写授权已撤销。");
      if (out.status === "succeeded") return { ok: true, result: out.result };
      if (out.status === "approval_required") { scope.pending.set(argsKey, out.pendingCallId); return refuse("approval_required", `请本人在 ${this.pendingUrl()} 批准录音转写，再用原参数领取结果 (${out.pendingCallId})。`); }
      return refuse(out.status, out.reason);
    } catch { return refuse("unavailable", "录音转写调用失败；用相同作业标识核对状态，勿创建新作业重试。"); }
  }

  private dropDiscussion(credential: string): void {
    this.discussionScopes.get(credential)?.grant.destroy();
    this.discussionScopes.delete(credential);
  }
  private async callDiscussion(principal: McpPrincipal, spec: McpToolSpec, rawArgs: unknown): Promise<McpToolOutcome> {
    const args = readToolArgs(spec, rawArgs);
    if (!args.ok) return refuse('invalid_params', args.message);
    const view = this.mcpView(principal.owner), effective = effectiveOperations(view), auto = autoAllowedOperations(view);
    const rights = DISCUSSION_OPERATION_IDS.filter(op => effective.includes(op)), autoAllow = rights.filter(op => auto.includes(op));
    if (!rights.includes(spec.name)) return refuse('no_authority', '请在 /permissions 的 MCP 接入中授权会议能力；既有飞书授权不会自动扩大。');
    const key = JSON.stringify([rights, autoAllow]);
    let scope = this.discussionScopes.get(principal.credential);
    if (scope && (scope.owner !== principal.owner || scope.key !== key)) { this.dropDiscussion(principal.credential); scope = undefined; }
    if (!scope) {
      const grant = this.opts.discussions!.open(principal.owner, rights, autoAllow);
      if (!grant) return refuse('no_authority', '会议服务当前不可用');
      scope = { owner: principal.owner, key, grant, pending: new Map() };
      this.discussionScopes.set(principal.credential, scope);
    }
    const argsKey = JSON.stringify([spec.name, Object.entries(args.value).sort(([a], [b]) => a.localeCompare(b))]);
    const pending = scope.pending.get(argsKey);
    if (pending) {
      const result = scope.grant.capabilities.result(pending);
      if (result?.state === 'pending' || result?.state === 'claimed') return refuse('approval_required', `等待本人在 ${this.pendingUrl()} 批准会议操作 (${pending})。`);
      scope.pending.delete(argsKey);
      if (result?.state === 'finished') return result.outcome === 'succeeded' ? { ok: true, result: result.result } : refuse(result.outcome ?? 'failed', result.reason ?? '会议操作失败');
      return refuse('no_authority', '会议批准已过期、拒绝或撤销；请由本人重新发起。');
    }
    try {
      const out = await scope.grant.request(spec.name, args.value);
      if (out.status === 'succeeded') return { ok: true, result: out.result };
      if (out.status === 'approval_required') { scope.pending.set(argsKey, out.pendingCallId); return refuse('approval_required', `请本人在 ${this.pendingUrl()} 批准会议操作，批准后用原参数领取结果 (${out.pendingCallId})。`); }
      return refuse(out.status, out.reason);
    } catch { return refuse('unavailable', '会议服务调用失败，请查看会议记录后决定是否重试。'); }
  }
}

/** A shared-document refusal, in the words written for a caller outside the account; anything else stays in the log. */
function sharedDocRefusal(error: unknown, tool: string, share: string): { ok: false; code: string; message: string } {
  if (!(error instanceof DocsAddonError)) {
    log.warn({ err: error, tool, share }, "shared document call failed");
    return refuse("unavailable", "操作没有完成，请稍后重试");
  }
  const status = error.status;
  const code = status === 400 ? "invalid_params" : status === 403 ? "no_authority" : status === 404 ? "not_found" : status === 409 ? "conflict"
    : status === 413 ? "too_large" : status === 429 ? "busy" : "unavailable";
  return refuse(code, error.message);
}

function refuse(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message: message.slice(0, 400) };
}

/** Approval cards one Feishu scope remembers for collection by an identical retry. */
const FEISHU_PENDING_MAX = 64;

const LARK_CLI_OPERATIONS: ReadonlySet<string> = new Set(
  Object.values(FEISHU_USER_OPERATIONS).filter((entry) => entry.tool === LARK_CLI_TOOL).map((entry) => entry.operation),
);
const MCP_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const MCP_IMAGES_MAX = 16;

/**
 * A successful Feishu call. lark-cli results carry the PNG/JPEG/WEBP files a
 * command wrote (slide screenshots) as base64; those leave the JSON as image
 * blocks, so a client renders them and a model never reads them as text. The
 * JSON keeps each file's metadata and the 1-based number of its image.
 */
function feishuSuccess(operation: string, result: unknown): McpToolOutcome {
  const files = LARK_CLI_OPERATIONS.has(operation) && result && typeof result === "object"
    ? (result as { files?: unknown }).files
    : undefined;
  if (!Array.isArray(files)) return { ok: true, result };
  const images: McpImage[] = [];
  const listed = files.map((file: unknown) => {
    if (!file || typeof file !== "object") return file;
    const { base64, ...rest } = file as Record<string, unknown>;
    if (typeof base64 !== "string") return file;
    if (!MCP_IMAGE_TYPES.has(String(rest.media_type)) || images.length >= MCP_IMAGES_MAX) {
      return { ...rest, omitted: "图片过多或类型不支持，未随结果返回" };
    }
    images.push({ mimeType: String(rest.media_type), data: base64 });
    return { ...rest, image: images.length };
  });
  return { ok: true, result: { ...(result as Record<string, unknown>), files: listed }, ...(images.length ? { images } : {}) };
}

/**
 * A dispatch answer's projection, or a pointer to where it can be read — a
 * truncated JSON document would parse as a smaller state that never existed.
 * `app_read_projection` pages a projection of any size (`projection-window.ts`).
 */
function renderedProjection(projection: RuntimeJson | null | undefined): Record<string, unknown> {
  const value = projection ?? null;
  const chars = JSON.stringify(value)?.length ?? 4;
  if (chars <= PROJECTION_WINDOW_CHARS) return { projection: value };
  return {
    projection_omitted:
      `投影约 ${chars} 字符，超过单次回答 ${PROJECTION_WINDOW_CHARS} 字符的窗口；用 app_read_projection 的 path/cursor 分页读取。`,
  };
}

/** The compact, bounded projection of one session for an agent to read. */
function compactSession(s: HubSessionSummary): Record<string, unknown> {
  return {
    resource_id: s.resourceId,
    ...(s.title ? { title: s.title.slice(0, 240) } : {}),
    device: s.deviceLabel || s.deviceId,
    cli_kind: s.cliKind,
    session_id: s.sessionId,
    project: s.projectLabel,
    cwd: s.cwdDisplay,
    ...(s.started_at ? { started_at: s.started_at } : {}),
    last_activity: s.lastActivity,
    status: s.status,
    resumable: s.resumable,
    // `exec`: a non-interactive run (`codex exec`, a script or harness), not a conversation.
    ...(s.executionMode ? { execution_mode: s.executionMode } : {}),
    ...(s.inputMode ? { input_mode: s.inputMode } : {}),
    ...(s.parentResourceId ? { parent_resource_id: s.parentResourceId } : {}),
    preview: typeof s.preview === "string" ? s.preview.slice(0, 300) : undefined,
    message_count: s.message_count,
  };
}
