import { ManagedExecutionsRepository } from "./repositories/managed-executions.js";
import { ResearchCanvasRepository } from './repositories/research-canvas.js';
import { SessionSharesRepository } from "./repositories/session-shares.js";
import { FeishuDocsSharesRepository, FeishuDocsSpeakersRepository } from "./repositories/feishu-docs-shares.js";
import { FeishuDocsBoardsRepository } from "./repositories/feishu-docs-boards.js";
import { FeishuDocShareLinksRepository } from "./repositories/feishu-doc-share-links.js";
import { FeishuDocAssistantsRepository } from "./repositories/feishu-doc-assistants.js";
import { WorkspaceGrantsRepository } from "./repositories/workspace-grants.js";
import { DiscussionsRepository } from "./repositories/discussions.js";
/**
 * SQLite persistence layer using better-sqlite3.
 * Manages all 7 tables: users, user_identities, sessions, rounds,
 * channel_bindings, user_settings, group_config.
 */

import Database from "better-sqlite3";
import { AuthorizationRepository } from "../authorization/repository.js";
import { MIGRATIONS } from "./migrations.js";
import { AppCatalogRepository } from "./repositories/app-catalog.js";
import { DevTicketsRepository } from "./repositories/dev-tickets.js";
import { CreditLedgerRepository } from "./repositories/credit-ledger.js";
import { KnowledgeRepository } from "./repositories/knowledge.js";
import { KnowledgeChatsRepository } from "./repositories/knowledge-chats.js";
import { KnowledgeRetrievalRepository } from "./repositories/knowledge-retrieval.js";
import { KnowledgeRepairsRepository } from "./repositories/knowledge-repairs.js";
import { KnowledgeSourcesRepository } from "./repositories/knowledge-sources.js";
import { MergeProposalsRepository } from "./repositories/merge-proposals.js";
import { ResourceWaitersRepository } from "./repositories/resource-waiters.js";
import { RunnerArtifactsRepository } from "./repositories/runner-artifacts.js";

export type {
  PendingRunnerBundleRow,
  RunnerBundleActivationAuditRow,
} from "./repositories/runner-artifacts.js";

export type {
  AppDeclarationRow,
  AppHotswapApprovalRow,
  AppHotswapApprovalState,
  AppHotswapClaimResult,
  AppReleaseActivateOutcome,
  AppReleaseActivationRow,
  AppReleaseRemoveOutcome,
  AppReleaseRow,
  PendingAppReleaseRow,
} from "./repositories/app-catalog.js";

// ── Row Types ──

export interface UserRow {
  username: string;
  uid: number;
  home_dir: string;
  created_at: string;
}

export interface IdentityRow {
  provider: string;
  external_id: string;
  username: string;
  label: string | null;
  created_at: string | null;
}

export interface SessionRow {
  id: string;
  claude_session_id: string | null;
  username: string;
  config: string; // JSON
  first_prompt: string;
  status: string;
  total_turns: number;
  total_duration_ms: number;
  total_cost_usd: number;
  workdir: string | null;
  parent_session_id: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoundRow {
  id?: number;
  session_id: string;
  round_num: number;
  prompt: string;
  events: string; // JSON
  result: string;
  turns: number;
  duration_ms: number;
  cost_usd: number;
  created_at: string;
}

export interface CrossUserAclRow {
  asker_username: string;
  target_username: string;
  allowed_tools: string; // JSON array: ["history", "files"]
  require_approval: number;
  created_at: string;
}

export interface RunnerTokenRow {
  token_hash: string;
  username: string;
  device: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface RunnerEnrollmentRow {
  code_hash: string;
  username: string;
  device: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export const RUNNER_GUEST_PROVIDERS = ["anthropic", "openai"] as const;
export type RunnerGuestProvider = typeof RUNNER_GUEST_PROVIDERS[number];

/** A guest client device: its only Octopus authority is a model tunnel to `model_host`. */
export interface RunnerGuestProfileRow {
  username: string;
  device: string;
  /** The owner's own device that serves model egress for this guest. */
  model_host: string;
  /** Canonical comma list, see `RUNNER_GUEST_PROVIDERS`. */
  providers: string;
  created_at: string;
  created_by: string;
}

export const RUNNER_LOCAL_AGENT_BRIDGE_MODES = ["disabled", "manual", "full_access"] as const;
export type RunnerLocalAgentBridgeMode = typeof RUNNER_LOCAL_AGENT_BRIDGE_MODES[number];

export interface RunnerDevicePolicyRow {
  username: string;
  device: string;
  local_agent_bridge_mode: RunnerLocalAgentBridgeMode;
  default_agent_injection: 0 | 1;
  gui_automation_enabled: 0 | 1;
  updated_at: string;
  updated_by: string;
}

export interface DashboardTokenRow {
  token_hash: string;
  username: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * One MCP access token. Many per user; revocation marks rather than deletes,
 * so "this credential existed and ended on this date" stays answerable.
 */
export interface SharedAppInstanceRow {
  app_id: string;
  instance_key: string;
  creator: string;
  created_at: string;
  status: string;
}

export interface SharedAppMemberRow {
  app_id: string;
  instance_key: string;
  username: string;
  role: string;
  joined_at: string;
}

/** `external-app-host/v1` (v49): the one-shot handoff a launch URL carries. */
export interface ExternalAppLaunchGrantRow {
  grant_id: string;
  token_hash: string;
  app_id: string;
  instance_key: string;
  username: string;
  host_id: string;
  host_origin: string;
  release_digest: string;
  authority: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_credential: string | null;
}

/**
 * Redeeming a launch grant: the row, or WHY not.
 *
 * `limit` is kept apart from `invalid` because the two need different sentences
 * on the other end — one says "this link is dead", the other says "you already
 * have as many bindings as this deployment allows".
 */
export type ExternalAppLaunchGrantConsumption =
  | { ok: true; row: ExternalAppLaunchGrantRow }
  | { ok: false; reason: "invalid" | "limit" };

/** `external-app-host/v1` (v49): the standing, bound, revocable credential. */
export interface ExternalAppCapabilityRow {
  credential_id: string;
  secret_hash: string;
  app_id: string;
  instance_key: string;
  username: string;
  host_id: string;
  host_origin: string;
  release_digest: string;
  authority: string;
  grant_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface McpTokenRow {
  token_hash: string;
  username: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Versioned credential-local attenuation; NULL only for pre-v38 rows. */
  policy_json: string | null;
}

/** Durable, bearer-free identity of one split-placement provider session. */
export interface SessionExecutionBindingRow {
  owner: string;
  /** Authenticated owner of the Runner hosting the provider process. */
  runtime_owner: string;
  runtime_device: string;
  /** Canonical agent-runtime resource for a borrowed host; null for owner-local placement. */
  runtime_resource_id: string | null;
  source: "claude" | "codex" | "omp";
  session_id: string;
  operation_id: string;
  execution_device: string;
  workspace_id: string;
  /** `read_only` rows (document assistants) live in their own table (v94); see `saveSessionExecutionBinding`. */
  permission_profile: "full_access" | "manual" | "read_only";
  /** read_only only: the assistant's document share. Null for every other profile. */
  doc_share_id?: string | null;
  token_hash: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Both binding tables as one row set: v58's (full_access, manual) and v94's read-only twin. */
const SESSION_EXECUTION_BINDINGS = `
  SELECT owner, runtime_owner, runtime_device, runtime_resource_id, source, session_id, operation_id,
         execution_device, workspace_id, permission_profile, NULL AS doc_share_id, token_hash, expires_at, created_at, updated_at
    FROM session_execution_bindings
  UNION ALL
  SELECT owner, runtime_owner, runtime_device, runtime_resource_id, source, session_id, operation_id,
         execution_device, workspace_id, permission_profile, doc_share_id, token_hash, expires_at, created_at, updated_at
    FROM session_execution_read_only_bindings`;

/** Durable positive provenance for one Sessions+ split-placement session. */
export interface SessionPlusSplitSessionRow {
  /** Sessions+ account allowed to discover and read this provider session. */
  owner: string;
  /** Authenticated account whose Runner hosts the provider process. */
  runtime_owner: string;
  runtime_device: string;
  /** Canonical shared-runtime resource, or null for an owner-local Runner. */
  runtime_resource_id: string | null;
  source: "claude" | "codex" | "omp";
  session_id: string;
  /** Correlates new Host rows with Runner placement evidence; null is legacy. */
  catalog_id: string | null;
  execution_device: string;
  workspace_id: string;
  /** Display evidence frozen at launch; neither value is path authority. */
  workspace_label: string;
  workspace_display: string;
  created_at: string;
  updated_at: string;
}

/**
 * One browser login. The cookie holds the plaintext id; only its hash lives
 * here, so a database dump does not hand over live sessions.
 */
export interface WebSessionRow {
  token_hash: string;
  username: string;
  csrf_hash: string;
  created_at: string;
  last_seen_at: string;
  absolute_expiry: string;
  revoked_at: string | null;
}

/**
 * One Session Hub chat submission (migration v25).
 *
 * The lifecycle of "I typed something into a session and pressed send" —
 * durable, so a page reload, an approval decided in another tab, or a restart
 * can all still say what happened. See the migration for what is deliberately
 * NOT stored here (the prompt, the transcript).
 */
export interface SessionOperationRow {
  id: string;
  owner: string;
  /** Independent UI/control-plane lifecycle (`hub` | `app:session-plus`). */
  surface: string;
  credential: string;
  resource_id: string;
  device: string;
  cli_kind: string;
  session_id: string;
  input_receipt?: string | null;
  runner_operation_id?: string | null;
  runner_receipt_target?: string | null;
  /** `append_session` | `resume_session`. */
  operation: string;
  args_hash: string;
  pending_call_id: string | null;
  context_id: string | null;
  status: string;
  detail: string | null;
  new_session_id: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** What may be written after the row exists. `id`/`owner` are never patched. */
export type SessionOperationPatch = Partial<
  Pick<
    SessionOperationRow,
    | "input_receipt"
    | "pending_call_id"
    | "context_id"
    | "session_id"
    | "status"
    | "detail"
    | "new_session_id"
    | "started_at"
    | "finished_at"
  >
>;

/**
 * One durable authorisation intent (migration v24).
 *
 * Deliberately NOT an execution decision: the kernel is still the only thing
 * that authorises a call. This row is what a person agreed to, so that a
 * Context can be derived from it later and torn down when it goes away.
 */
export interface GrantIntentRow {
  id: string;
  subject_type: string;
  subject_id: string;
  owner: string;
  resource_type: string;
  resource_id: string;
  /** JSON array of hub operation ids. */
  operations: string;
  /** JSON object; today only `{ autoAllow: string[] }`. */
  terms: string;
  source: string;
  status: string;
  contract_digest: string | null;
  publisher: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
}

/** A pinned dsh tool or session-projection capability Object (migration v40). */
export interface TentacleObjectRow {
  object_id: string;
  kind: "tool" | "projection";
  owner: string;
  device: string;
  resource_key: string;
  schema_digest: string;
  schema_json: string;
  status: "active" | "retired";
  created_at: string;
}

/** Publisher-code trust, separate from capability grants (migration v27). */
export interface AppTrustRow {
  owner: string;
  app_id: string;
  publisher: string;
  profile: string;
  package_digest_at_consent: string;
  follow_updates: number;
  decided_at: string;
  revoked_at: string | null;
}

/** One line in the permission activity record (migration v24). */
export interface PermissionAuditRow {
  id: number;
  at: string;
  owner: string;
  subject_type: string;
  subject_id: string;
  operation: string;
  resource: string;
  decision: string;
  reason: string | null;
  detail: string | null;
}

/** One capability handed to one user from /admin (ticket #15). */
export interface UserGrantRow {
  username: string;
  capability: string;
  granted_by: string;
  granted_at: string;
}

// ── App agents (migration v29) ──

export interface AppAgentCursorRow {
  app_id: string;
  scope_key: string;
  agent: string;
  upto_seq: number;
  created_at: string;
  updated_at: string;
}

export type AppAgentTurnStatus = "running" | "succeeded" | "failed" | "unknown";
export type AppAgentTurnTrigger = "inbox" | "daily" | "manual" | "approval";

export interface AppAgentTurnRow {
  sequence: number;
  id: string;
  app_id: string;
  scope_key: string;
  agent: string;
  owner: string;
  status: AppAgentTurnStatus;
  trigger: AppAgentTurnTrigger;
  from_seq: number;
  upto_seq: number;
  tool_calls: number;
  note: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface AppAgentMessageRow {
  id: number;
  turn_id: string;
  app_id: string;
  scope_key: string;
  agent: string;
  role: "user" | "assistant" | "tool" | "note" | "error";
  content: string;
  tool_name: string | null;
  at: string;
}

/** Which agent, in which scope. Spelled once so no caller invents a key. */
export interface AppAgentKey {
  appId: string;
  scopeKey: string;
  agent: string;
}

// ── Store ──

export class Store {
  readonly sessionShares: SessionSharesRepository;
  readonly feishuDocsShares: FeishuDocsSharesRepository;
  readonly feishuDocsSpeakers: FeishuDocsSpeakersRepository;
  readonly feishuDocsBoards: FeishuDocsBoardsRepository;
  readonly feishuDocShareLinks: FeishuDocShareLinksRepository;
  readonly feishuDocAssistants: FeishuDocAssistantsRepository;
  readonly workspaceGrants: WorkspaceGrantsRepository;
  private db: Database.Database;
  readonly appCatalog: AppCatalogRepository;
  readonly devTickets: DevTicketsRepository;
  readonly credits: CreditLedgerRepository;
  readonly knowledge: KnowledgeRepository;
  readonly knowledgeChats: KnowledgeChatsRepository;
  readonly knowledgeRetrieval: KnowledgeRetrievalRepository;
  readonly knowledgeRepairs: KnowledgeRepairsRepository;
  readonly knowledgeSources: KnowledgeSourcesRepository;
  readonly mergeProposals: MergeProposalsRepository;
  readonly discussions: DiscussionsRepository;
  readonly authorization: AuthorizationRepository;
  readonly resourceWaiters: ResourceWaitersRepository;
  readonly managedExecutions: ManagedExecutionsRepository;
  readonly researchCanvas: ResearchCanvasRepository;
  readonly runnerArtifacts: RunnerArtifactsRepository;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.runMigrations();
    this.sessionShares = new SessionSharesRepository(this.db);
    this.feishuDocsShares = new FeishuDocsSharesRepository(this.db);
    this.feishuDocsSpeakers = new FeishuDocsSpeakersRepository(this.db);
    this.feishuDocsBoards = new FeishuDocsBoardsRepository(this.db);
    this.feishuDocShareLinks = new FeishuDocShareLinksRepository(this.db);
    this.feishuDocAssistants = new FeishuDocAssistantsRepository(this.db);
    this.workspaceGrants = new WorkspaceGrantsRepository(this.db);
    this.appCatalog = new AppCatalogRepository(this.db);
    this.devTickets = new DevTicketsRepository(this.db);
    this.credits = new CreditLedgerRepository(this.db);
    this.knowledge = new KnowledgeRepository(this.db);
    this.knowledgeChats = new KnowledgeChatsRepository(this.db);
    this.knowledgeRetrieval = new KnowledgeRetrievalRepository(this.db);
    this.knowledgeRepairs = new KnowledgeRepairsRepository(this.db);
    this.knowledgeSources = new KnowledgeSourcesRepository(this.db);
    this.mergeProposals = new MergeProposalsRepository(this.db);
    this.discussions = new DiscussionsRepository(this.db);
    this.authorization = new AuthorizationRepository(this.db);
    this.resourceWaiters = new ResourceWaitersRepository(this.db);
    this.managedExecutions = new ManagedExecutionsRepository(this.db);
    this.researchCanvas = new ResearchCanvasRepository(this.db);
    this.runnerArtifacts = new RunnerArtifactsRepository(this.db);
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      )
    `);

    const row = this.db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
    const currentVersion = row?.v ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
        })();
      }
    }
  }

  // ── Users ──

  saveUser(user: UserRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO users (username, uid, home_dir, created_at)
         VALUES (@username, @uid, @home_dir, @created_at)`,
      )
      .run(user);
  }

  loadUsers(): UserRow[] {
    return this.db.prepare("SELECT * FROM users").all() as UserRow[];
  }

  getUser(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  }

  getMaxUid(): number {
    const row = this.db.prepare("SELECT MAX(uid) as max_uid FROM users").get() as { max_uid: number | null };
    return row.max_uid ?? 2000;
  }

  // ── User Identities ──

  saveIdentity(username: string, identity: { provider: string; externalId: string; label?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO user_identities (provider, external_id, username, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(identity.provider, identity.externalId, username, identity.label ?? null, new Date().toISOString());
  }

  resolveIdentity(provider: string, externalId: string): string | undefined {
    const row = this.db
      .prepare("SELECT username FROM user_identities WHERE provider = ? AND external_id = ?")
      .get(provider, externalId) as { username: string } | undefined;
    return row?.username;
  }

  getIdentitiesByUser(username: string): IdentityRow[] {
    return this.db.prepare("SELECT * FROM user_identities WHERE username = ?").all(username) as IdentityRow[];
  }

  /** Delete only the named owner's binding; a matching identity on another account is untouched. */
  deleteIdentity(username: string, provider: string, externalId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM user_identities WHERE username = ? AND provider = ? AND external_id = ?")
      .run(username, provider, externalId);
    return result.changes > 0;
  }

  // ── Sessions ──

  saveSession(session: SessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
         (id, claude_session_id, username, config, first_prompt, status,
          total_turns, total_duration_ms, total_cost_usd, workdir,
          parent_session_id, workspace_id, created_at, updated_at)
         VALUES (@id, @claude_session_id, @username, @config, @first_prompt, @status,
                 @total_turns, @total_duration_ms, @total_cost_usd, @workdir,
                 @parent_session_id, @workspace_id, @created_at, @updated_at)`,
      )
      .run(session);
  }

  // ── Rounds ──

  saveRound(round: Omit<RoundRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO rounds (session_id, round_num, prompt, events, result, turns, duration_ms, cost_usd, created_at)
         VALUES (@session_id, @round_num, @prompt, @events, @result, @turns, @duration_ms, @cost_usd, @created_at)`,
      )
      .run(round);
  }

  // ── User Settings ──

  getSetting(username: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM user_settings WHERE username = ? AND key = ?")
      .get(username, key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(username: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO user_settings (username, key, value)
         VALUES (?, ?, ?)`,
      )
      .run(username, key, value);
  }

  // ── Cross-user ACL ──

  upsertCrossUserAcl(rule: CrossUserAclRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cross_user_acl
         (asker_username, target_username, allowed_tools, require_approval, created_at)
         VALUES (@asker_username, @target_username, @allowed_tools, @require_approval, @created_at)`,
      )
      .run(rule);
  }

  getCrossUserAcl(askerUsername: string, targetUsername: string): CrossUserAclRow | undefined {
    return this.db
      .prepare("SELECT * FROM cross_user_acl WHERE asker_username = ? AND target_username = ?")
      .get(askerUsername, targetUsername) as CrossUserAclRow | undefined;
  }

  listCrossUserAclByAsker(askerUsername: string): CrossUserAclRow[] {
    return this.db
      .prepare("SELECT * FROM cross_user_acl WHERE asker_username = ? ORDER BY target_username")
      .all(askerUsername) as CrossUserAclRow[];
  }

  /** Owner-facing inverse projection: who currently has a rule targeting me. */
  listCrossUserAclByTarget(targetUsername: string): CrossUserAclRow[] {
    return this.db
      .prepare("SELECT * FROM cross_user_acl WHERE target_username = ? ORDER BY asker_username")
      .all(targetUsername) as CrossUserAclRow[];
  }

  // ── Runner tokens (laptop front-end heads) ──

  /** Insert or replace the credential for (username, device). */
  saveRunnerToken(tokenHash: string, username: string, device: string, createdAt: string): void {
    // Update the credential in place: the old token_hash stops authenticating,
    // while the separately authorized per-device policy survives rotation.
    this.db.prepare(`
      INSERT INTO runner_tokens (token_hash, username, device, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username, device) DO UPDATE SET
        token_hash = excluded.token_hash,
        created_at = excluded.created_at,
        last_seen_at = NULL
    `).run(tokenHash, username, device, createdAt);
  }

  getRunnerTokenByHash(tokenHash: string): RunnerTokenRow | undefined {
    return this.db.prepare("SELECT * FROM runner_tokens WHERE token_hash = ?").get(tokenHash) as
      | RunnerTokenRow
      | undefined;
  }

  listAllRunnerTokens(): RunnerTokenRow[] {
    return this.db.prepare("SELECT * FROM runner_tokens ORDER BY username, device").all() as RunnerTokenRow[];
  }

  /** Per-user activity rollup for the dashboard. */
  listUserActivity(sinceIso: string): Array<{ username: string; created_at: string; last_round_at: string | null; recent_rounds: number }> {
    return this.db
      .prepare(
        `SELECT u.username, u.created_at,
           (SELECT MAX(r.created_at) FROM rounds r JOIN sessions s ON r.session_id = s.id WHERE s.username = u.username) AS last_round_at,
           (SELECT COUNT(*) FROM rounds r JOIN sessions s ON r.session_id = s.id WHERE s.username = u.username AND r.created_at >= ?) AS recent_rounds
         FROM users u ORDER BY last_round_at DESC NULLS LAST`,
      )
      .all(sinceIso) as Array<{ username: string; created_at: string; last_round_at: string | null; recent_rounds: number }>;
  }

  listRunnerTokens(username: string): RunnerTokenRow[] {
    return this.db
      .prepare("SELECT * FROM runner_tokens WHERE username = ? ORDER BY device")
      .all(username) as RunnerTokenRow[];
  }

  getRunnerDevicePolicy(username: string, device: string): RunnerDevicePolicyRow | undefined {
    return this.db
      .prepare("SELECT * FROM runner_device_policies WHERE username = ? AND device = ?")
      .get(username, device) as RunnerDevicePolicyRow | undefined;
  }

  setRunnerLocalAgentBridgeMode(
    username: string,
    device: string,
    mode: RunnerLocalAgentBridgeMode,
    updatedAt: string,
    updatedBy: string,
  ): boolean {
    if (!(RUNNER_LOCAL_AGENT_BRIDGE_MODES as readonly string[]).includes(mode)) return false;
    const known = this.db
      .prepare("SELECT 1 FROM runner_tokens WHERE username = ? AND device = ?")
      .get(username, device);
    if (!known) return false;
    this.db.prepare(`
      INSERT INTO runner_device_policies
        (username, device, local_agent_bridge_mode, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username, device) DO UPDATE SET
        local_agent_bridge_mode = excluded.local_agent_bridge_mode,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(username, device, mode, updatedAt, updatedBy);
    return true;
  }

  setRunnerDefaultAgentInjection(
    username: string,
    device: string,
    enabled: boolean,
    updatedAt: string,
    updatedBy: string,
  ): boolean {
    const known = this.db
      .prepare("SELECT 1 FROM runner_tokens WHERE username = ? AND device = ?")
      .get(username, device);
    if (!known) return false;
    this.db.prepare(`
      INSERT INTO runner_device_policies
        (username, device, local_agent_bridge_mode, default_agent_injection, updated_at, updated_by)
      VALUES (?, ?, 'disabled', ?, ?, ?)
      ON CONFLICT(username, device) DO UPDATE SET
        default_agent_injection = excluded.default_agent_injection,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(username, device, enabled ? 1 : 0, updatedAt, updatedBy);
    return true;
  }

  setRunnerGuiAutomationEnabled(
    username: string,
    device: string,
    enabled: boolean,
    updatedAt: string,
    updatedBy: string,
  ): boolean {
    const known = this.db
      .prepare("SELECT 1 FROM runner_tokens WHERE username = ? AND device = ?")
      .get(username, device);
    if (!known) return false;
    this.db.prepare(`
      INSERT INTO runner_device_policies
        (username, device, local_agent_bridge_mode, default_agent_injection,
         gui_automation_enabled, updated_at, updated_by)
      VALUES (?, ?, 'disabled', 0, ?, ?, ?)
      ON CONFLICT(username, device) DO UPDATE SET
        gui_automation_enabled = excluded.gui_automation_enabled,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(username, device, enabled ? 1 : 0, updatedAt, updatedBy);
    return true;
  }

  deleteRunnerToken(username: string, device: string): boolean {
    const res = this.db.prepare("DELETE FROM runner_tokens WHERE username = ? AND device = ?").run(username, device);
    return res.changes > 0;
  }

  getRunnerGuestProfile(username: string, device: string): RunnerGuestProfileRow | undefined {
    return this.db
      .prepare("SELECT * FROM runner_guest_profiles WHERE username = ? AND device = ?")
      .get(username, device) as RunnerGuestProfileRow | undefined;
  }

  deleteRunnerGuestProfile(username: string, device: string): boolean {
    return this.db.prepare("DELETE FROM runner_guest_profiles WHERE username = ? AND device = ?")
      .run(username, device).changes > 0;
  }

  /** Insert or replace the guest profile of one device name. */
  saveRunnerGuestProfile(row: RunnerGuestProfileRow): void {
    this.db.prepare(`
      INSERT INTO runner_guest_profiles (username, device, model_host, providers, created_at, created_by)
      VALUES (@username, @device, @model_host, @providers, @created_at, @created_by)
      ON CONFLICT(username, device) DO UPDATE SET
        model_host = excluded.model_host,
        providers = excluded.providers,
        created_at = excluded.created_at,
        created_by = excluded.created_by
    `).run(row);
  }

  touchRunnerToken(tokenHash: string, seenAt: string): void {
    this.db.prepare("UPDATE runner_tokens SET last_seen_at = ? WHERE token_hash = ?").run(seenAt, tokenHash);
  }

  /** Replace any still-pending installer credential for this exact device. */
  saveRunnerEnrollment(row: Omit<RunnerEnrollmentRow, "consumed_at">): void {
    this.withinTransaction(() => {
      this.db.prepare(`
        DELETE FROM runner_enrollments
        WHERE username = ? AND device = ? AND consumed_at IS NULL
      `).run(row.username, row.device);
      this.db.prepare(`
        INSERT INTO runner_enrollments
          (code_hash, username, device, created_at, expires_at, consumed_at)
        VALUES (@code_hash, @username, @device, @created_at, @expires_at, NULL)
      `).run(row);
      this.db.prepare("DELETE FROM runner_enrollments WHERE expires_at < ?").run(row.created_at);
    });
  }

  /** Atomic one-shot redemption. Expired/consumed/unknown codes are identical. */
  consumeRunnerEnrollment(codeHash: string, now: string): RunnerEnrollmentRow | undefined {
    return this.withinTransaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM runner_enrollments
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at >= ?
      `).get(codeHash, now) as RunnerEnrollmentRow | undefined;
      if (!row) return undefined;
      const changed = this.db.prepare(`
        UPDATE runner_enrollments SET consumed_at = ?
        WHERE code_hash = ? AND consumed_at IS NULL
      `).run(now, codeHash);
      return changed.changes === 1 ? { ...row, consumed_at: now } : undefined;
    });
  }

  // ── Dashboard login tokens (personal web keys; one per user) ──

  /**
   * Replace the user's dashboard key: re-minting invalidates the old one, AND
   * every browser session bought with it. A web session row names only the
   * account, not the key that bought it, so a rotation that left sessions alive
   * would keep a leaked key's logins working for up to the 14-day absolute
   * lifetime — rotation would not be an incident response at all (B12).
   *
   * `keepSessionHash` spares exactly one session: the browser of an owner who is
   * rotating their own key, so the new plaintext stays on the screen they are
   * reading it from. Returns the token hashes of the sessions this call ended,
   * so the caller can tear down what each of them opened.
   */
  saveDashboardToken(tokenHash: string, username: string, createdAt: string, keepSessionHash?: string): string[] {
    return this.withinTransaction(() => {
      this.db.prepare("DELETE FROM dashboard_tokens WHERE username = ?").run(username);
      this.db
        .prepare("INSERT INTO dashboard_tokens (token_hash, username, created_at) VALUES (?, ?, ?)")
        .run(tokenHash, username, createdAt);
      const ended = (this.db
        .prepare("SELECT token_hash FROM web_sessions WHERE username = ? AND revoked_at IS NULL")
        .all(username) as Array<{ token_hash: string }>)
        .map((row) => row.token_hash)
        .filter((hash) => hash !== keepSessionHash);
      const revoke = this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ?");
      for (const hash of ended) revoke.run(createdAt, hash);
      return ended;
    });
  }

  getDashboardTokenByHash(tokenHash: string): DashboardTokenRow | undefined {
    return this.db.prepare("SELECT * FROM dashboard_tokens WHERE token_hash = ?").get(tokenHash) as
      | DashboardTokenRow
      | undefined;
  }

  hasDashboardToken(username: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM dashboard_tokens WHERE username = ? LIMIT 1").get(username),
    );
  }

  deleteDashboardToken(username: string): boolean {
    const res = this.db.prepare("DELETE FROM dashboard_tokens WHERE username = ?").run(username);
    return res.changes > 0;
  }

  touchDashboardToken(tokenHash: string, usedAt: string): void {
    this.db.prepare("UPDATE dashboard_tokens SET last_used_at = ? WHERE token_hash = ?").run(usedAt, tokenHash);
  }

  // ── MCP access tokens (many per user; label + optional TTL + revocation) ──

  saveMcpToken(row: McpTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO mcp_tokens (token_hash, username, label, created_at, expires_at, last_used_at, revoked_at, policy_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.token_hash,
        row.username,
        row.label,
        row.created_at,
        row.expires_at,
        row.last_used_at,
        row.revoked_at,
        row.policy_json,
      );
  }

  /**
   * Resolve a presented token's hash to a LIVE credential row. Revoked and
   * expired rows answer undefined here — the identity path must not have to
   * remember two extra checks — while `listMcpTokens` still shows them.
   */
  getActiveMcpTokenByHash(tokenHash: string, nowIso: string): McpTokenRow | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_tokens WHERE token_hash = ?").get(tokenHash) as
      | McpTokenRow
      | undefined;
    if (!row || row.revoked_at) return undefined;
    if (row.expires_at && row.expires_at <= nowIso) return undefined;
    return row;
  }

  listMcpTokens(username: string): McpTokenRow[] {
    return this.db
      .prepare("SELECT * FROM mcp_tokens WHERE username = ? ORDER BY created_at DESC, token_hash")
      .all(username) as McpTokenRow[];
  }

  /** Owner-scoped on purpose: naming a hash is not authority over its row. */
  revokeMcpToken(username: string, tokenHash: string, revokedAt: string): boolean {
    const res = this.db
      .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE username = ? AND token_hash = ? AND revoked_at IS NULL")
      .run(revokedAt, username, tokenHash);
    return res.changes > 0;
  }

  touchMcpToken(tokenHash: string, usedAt: string): void {
    this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE token_hash = ?").run(usedAt, tokenHash);
  }

  // ── Managed split-session recovery (bearer-free) ───────────────────────

  saveSessionExecutionBinding(row: SessionExecutionBindingRow): void {
    // One session has one binding: a row saved in one table replaces its twin in the other, so a session
    // that was a document assistant's can never also come back as a full scope, nor the reverse.
    this.withinTransaction(() => this.saveSessionExecutionBindingRow(row));
  }

  private saveSessionExecutionBindingRow(row: SessionExecutionBindingRow): void {
    this.db.prepare(`DELETE FROM ${row.permission_profile === "read_only" ? "session_execution_bindings" : "session_execution_read_only_bindings"}
      WHERE owner = ? AND runtime_device = ? AND source = ? AND session_id = ?`).run(row.owner, row.runtime_device, row.source, row.session_id);
    // A read-only scope's row goes where only binaries that know the profile
    // look: an older one reading the v58 table would rebuild it as full.
    if (row.permission_profile === "read_only") {
      this.db.prepare(`
        INSERT INTO session_execution_read_only_bindings (
          owner, runtime_owner, runtime_device, runtime_resource_id, source, session_id, operation_id,
          execution_device, workspace_id, permission_profile, doc_share_id, token_hash,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'read_only', ?, ?, ?, ?, ?)
        ON CONFLICT(owner, runtime_device, source, session_id) DO UPDATE SET
          operation_id = excluded.operation_id,
          execution_device = excluded.execution_device,
          workspace_id = excluded.workspace_id,
          doc_share_id = excluded.doc_share_id,
          token_hash = excluded.token_hash,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(row.owner, row.runtime_owner, row.runtime_device, row.runtime_resource_id, row.source, row.session_id,
        row.operation_id, row.execution_device, row.workspace_id, row.doc_share_id ?? null, row.token_hash,
        row.expires_at, row.created_at, row.updated_at);
      return;
    }
    this.db.prepare(`
      INSERT INTO session_execution_bindings (
        owner, runtime_owner, runtime_device, runtime_resource_id, source, session_id, operation_id,
        execution_device, workspace_id, permission_profile, token_hash,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, runtime_device, source, session_id) DO UPDATE SET
        runtime_owner = excluded.runtime_owner,
        runtime_resource_id = excluded.runtime_resource_id,
        operation_id = excluded.operation_id,
        execution_device = excluded.execution_device,
        workspace_id = excluded.workspace_id,
        permission_profile = excluded.permission_profile,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      row.owner,
      row.runtime_owner,
      row.runtime_device,
      row.runtime_resource_id,
      row.source,
      row.session_id,
      row.operation_id,
      row.execution_device,
      row.workspace_id,
      row.permission_profile,
      row.token_hash,
      row.expires_at,
      row.created_at,
      row.updated_at,
    );
  }

  getSessionExecutionBinding(
    owner: string,
    runtimeDevice: string,
    source: string,
    sessionId: string,
    nowIso: string,
  ): SessionExecutionBindingRow | undefined {
    return this.db.prepare(`
      SELECT * FROM (${SESSION_EXECUTION_BINDINGS})
       WHERE owner = ? AND runtime_device = ? AND source = ? AND session_id = ?
         AND expires_at > ?
    `).get(owner, runtimeDevice, source, sessionId, nowIso) as SessionExecutionBindingRow | undefined;
  }

  listActiveSessionExecutionBindings(nowIso: string): SessionExecutionBindingRow[] {
    return this.db.prepare(`
      SELECT * FROM (${SESSION_EXECUTION_BINDINGS})
       WHERE expires_at > ?
       ORDER BY owner, runtime_device, source, session_id
    `).all(nowIso) as SessionExecutionBindingRow[];
  }

  /** Exact authenticated runtime coordinates; used only for recovery/accounting events from that socket. */
  getSessionExecutionBindingByRuntime(
    runtimeOwner: string,
    runtimeDevice: string,
    source: string,
    sessionId: string,
    nowIso = "0000-01-01T00:00:00.000Z",
  ): SessionExecutionBindingRow | undefined {
    return this.db.prepare(`
      SELECT * FROM (${SESSION_EXECUTION_BINDINGS})
       WHERE runtime_owner = ? AND runtime_device = ? AND source = ? AND session_id = ?
         AND expires_at > ?
       ORDER BY updated_at DESC
       LIMIT 1
    `).get(runtimeOwner, runtimeDevice, source, sessionId, nowIso) as SessionExecutionBindingRow | undefined;
  }

  /** Every stored binding of one document assistant's share, live or expired. */
  listReadOnlySessionExecutionBindings(docShareId: string): SessionExecutionBindingRow[] {
    return this.db.prepare(`
      SELECT * FROM (${SESSION_EXECUTION_BINDINGS})
       WHERE permission_profile = 'read_only' AND doc_share_id = ?
    `).all(docShareId) as SessionExecutionBindingRow[];
  }

  deleteSessionExecutionBinding(
    owner: string,
    runtimeDevice: string,
    source: string,
    sessionId: string,
    tokenHash: string,
  ): boolean {
    let changes = 0;
    for (const table of ["session_execution_bindings", "session_execution_read_only_bindings"]) {
      changes += this.db.prepare(`
        DELETE FROM ${table}
         WHERE owner = ? AND runtime_device = ? AND source = ? AND session_id = ? AND token_hash = ?
      `).run(owner, runtimeDevice, source, sessionId, tokenHash).changes;
    }
    return changes > 0;
  }

  // ── Durable Sessions+ split-session provenance (v67) ────────────────

  saveSessionPlusSplitSession(row: SessionPlusSplitSessionRow): void {
    const existing = this.getSessionPlusSplitSession(
      row.owner,
      row.runtime_device,
      row.source,
      row.session_id,
    );
    if (existing && (
      existing.runtime_owner !== row.runtime_owner
      || existing.runtime_resource_id !== row.runtime_resource_id
      || existing.execution_device !== row.execution_device
      || existing.workspace_id !== row.workspace_id
      || (existing.catalog_id !== null && row.catalog_id !== null && existing.catalog_id !== row.catalog_id)
    )) {
      throw new Error("Sessions+ split session provenance cannot be rebound");
    }
    this.db.prepare(`
      INSERT INTO session_plus_split_sessions (
        owner, runtime_owner, runtime_device, runtime_resource_id, source,
        session_id, catalog_id, execution_device, workspace_id,
        workspace_label, workspace_display, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, runtime_device, source, session_id) DO UPDATE SET
        catalog_id = COALESCE(session_plus_split_sessions.catalog_id, excluded.catalog_id),
        workspace_label = CASE
          WHEN excluded.workspace_label <> '' THEN excluded.workspace_label
          ELSE session_plus_split_sessions.workspace_label
        END,
        workspace_display = CASE
          WHEN excluded.workspace_display <> '' THEN excluded.workspace_display
          ELSE session_plus_split_sessions.workspace_display
        END,
        updated_at = excluded.updated_at
    `).run(
      row.owner,
      row.runtime_owner,
      row.runtime_device,
      row.runtime_resource_id,
      row.source,
      row.session_id,
      row.catalog_id,
      row.execution_device,
      row.workspace_id,
      row.workspace_label,
      row.workspace_display,
      row.created_at,
      row.updated_at,
    );
  }

  getSessionPlusSplitSession(
    owner: string,
    runtimeDevice: string,
    source: string,
    sessionId: string,
  ): SessionPlusSplitSessionRow | undefined {
    return this.db.prepare(`
      SELECT * FROM session_plus_split_sessions
       WHERE owner = ? AND runtime_device = ? AND source = ? AND session_id = ?
    `).get(owner, runtimeDevice, source, sessionId) as SessionPlusSplitSessionRow | undefined;
  }

  listSessionPlusSplitSessions(owner: string, limit = 500): SessionPlusSplitSessionRow[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit) || 500));
    return this.db.prepare(`
      SELECT * FROM session_plus_split_sessions
       WHERE owner = ?
       ORDER BY updated_at DESC, runtime_device, source, session_id
       LIMIT ?
    `).all(owner, bounded) as SessionPlusSplitSessionRow[];
  }

  // ── dsh tentacle capability Objects (pinned definitions, never credentials) ──

  saveTentacleObject(row: TentacleObjectRow): void {
    this.db
      .prepare(
        `INSERT INTO tentacle_objects
           (object_id, kind, owner, device, resource_key, schema_digest, schema_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_id) DO NOTHING`,
      )
      .run(
        row.object_id,
        row.kind,
        row.owner,
        row.device,
        row.resource_key,
        row.schema_digest,
        row.schema_json,
        row.status,
        row.created_at,
      );
  }

  getTentacleObject(objectId: string): TentacleObjectRow | undefined {
    return this.db.prepare("SELECT * FROM tentacle_objects WHERE object_id = ?").get(objectId) as
      | TentacleObjectRow
      | undefined;
  }

  listTentacleObjects(owner?: string): TentacleObjectRow[] {
    return owner
      ? (this.db
          .prepare("SELECT * FROM tentacle_objects WHERE owner = ? ORDER BY created_at, object_id")
          .all(owner) as TentacleObjectRow[])
      : (this.db
          .prepare("SELECT * FROM tentacle_objects ORDER BY owner, created_at, object_id")
          .all() as TentacleObjectRow[]);
  }

  // ── Shared App instances (v37, ADR 0007 P1) ──

  /** Instance + creator membership in one transaction: no memberless rooms. */
  createSharedAppInstance(row: SharedAppInstanceRow, creatorRole: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO app_shared_instances (app_id, instance_key, creator, created_at, status)
           VALUES (?, ?, ?, ?, 'open')`,
        )
        .run(row.app_id, row.instance_key, row.creator, row.created_at);
      this.db
        .prepare(
          `INSERT INTO app_shared_members (app_id, instance_key, username, role, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.app_id, row.instance_key, row.creator, creatorRole, row.created_at);
    })();
  }

  getSharedAppInstance(appId: string, instanceKey: string): SharedAppInstanceRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_shared_instances WHERE app_id = ? AND instance_key = ?")
      .get(appId, instanceKey) as SharedAppInstanceRow | undefined;
  }

  getSharedAppMember(appId: string, instanceKey: string, username: string): SharedAppMemberRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_shared_members WHERE app_id = ? AND instance_key = ? AND username = ?")
      .get(appId, instanceKey, username) as SharedAppMemberRow | undefined;
  }

  listSharedAppMembers(appId: string, instanceKey: string): SharedAppMemberRow[] {
    return this.db
      .prepare("SELECT * FROM app_shared_members WHERE app_id = ? AND instance_key = ? ORDER BY joined_at, username")
      .all(appId, instanceKey) as SharedAppMemberRow[];
  }

  /**
   * Occupy one role seat, capacity-checked INSIDE the transaction so two
   * concurrent joins cannot both pass the count. Returns false when the seat
   * is taken, the user already joined, or the instance is not open.
   */
  addSharedAppMember(appId: string, instanceKey: string, username: string, role: string, max: number, at: string): boolean {
    return this.db.transaction(() => {
      const instance = this.getSharedAppInstance(appId, instanceKey);
      if (!instance || instance.status !== "open") return false;
      if (this.getSharedAppMember(appId, instanceKey, username)) return false;
      if (this.isSharedAppMemberRemoved(appId, instanceKey, username)) return false;
      const seated = this.db
        .prepare("SELECT COUNT(*) AS n FROM app_shared_members WHERE app_id = ? AND instance_key = ? AND role = ?")
        .get(appId, instanceKey, role) as { n: number };
      if (seated.n >= max) return false;
      this.db
        .prepare(
          `INSERT INTO app_shared_members (app_id, instance_key, username, role, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(appId, instanceKey, username, role, at);
      return true;
    })();
  }

  /** Add or move one managed member, checking the destination seat atomically. */
  setSharedAppMember(
    appId: string,
    instanceKey: string,
    username: string,
    role: string,
    max: number,
    at: string,
  ): boolean {
    return this.db.transaction(() => {
      const instance = this.getSharedAppInstance(appId, instanceKey);
      if (!instance || instance.status !== "open") return false;
      const current = this.getSharedAppMember(appId, instanceKey, username);
      if (current?.role === role) return true;
      const seated = this.db
        .prepare("SELECT COUNT(*) AS n FROM app_shared_members WHERE app_id = ? AND instance_key = ? AND role = ? AND username <> ?")
        .get(appId, instanceKey, role, username) as { n: number };
      if (seated.n >= max) return false;
      this.db.prepare(
        `INSERT INTO app_shared_members (app_id, instance_key, username, role, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id, instance_key, username) DO UPDATE SET role = excluded.role`,
      ).run(appId, instanceKey, username, role, at);
      // The creator seating somebody is the one way back in after a removal.
      this.db.prepare("DELETE FROM app_shared_removals WHERE app_id = ? AND instance_key = ? AND username = ?")
        .run(appId, instanceKey, username);
      return true;
    })();
  }

  /**
   * Remove one member and remember it, so the share link they still hold
   * cannot seat them again; only `setSharedAppMember` (the creator) re-adds.
   */
  removeSharedAppMember(appId: string, instanceKey: string, username: string, at = new Date().toISOString()): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        "DELETE FROM app_shared_members WHERE app_id = ? AND instance_key = ? AND username = ?",
      ).run(appId, instanceKey, username).changes > 0;
      if (changed) {
        this.db.prepare(
          `INSERT INTO app_shared_removals (app_id, instance_key, username, removed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(app_id, instance_key, username) DO UPDATE SET removed_at = excluded.removed_at`,
        ).run(appId, instanceKey, username, at);
      }
      return changed;
    })();
  }

  isSharedAppMemberRemoved(appId: string, instanceKey: string, username: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM app_shared_removals WHERE app_id = ? AND instance_key = ? AND username = ?",
    ).get(appId, instanceKey, username));
  }

  closeSharedAppInstance(appId: string, instanceKey: string): boolean {
    return this.db.prepare(
      "UPDATE app_shared_instances SET status = 'closed' WHERE app_id = ? AND instance_key = ? AND status = 'open'",
    ).run(appId, instanceKey).changes > 0;
  }

  listSharedAppInstancesFor(appId: string, username: string): SharedAppInstanceRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM app_shared_instances i
         JOIN app_shared_members m ON m.app_id = i.app_id AND m.instance_key = i.instance_key
         WHERE i.app_id = ? AND m.username = ? ORDER BY i.created_at DESC, i.instance_key DESC`,
      )
      .all(appId, username) as SharedAppInstanceRow[];
  }

  /**
   * One window of `listSharedAppInstancesFor`, in the same total order
   * (`created_at` DESC, then `instance_key` DESC). `before` is the last row of
   * the previous window: a keyset, so instances created or left while someone
   * pages neither shift nor repeat the rows still ahead of them.
   */
  listSharedAppInstancesPageFor(
    appId: string,
    username: string,
    options: { limit: number; before?: { createdAt: string; instanceKey: string } },
  ): SharedAppInstanceRow[] {
    const limit = Math.max(1, Math.floor(options.limit));
    const before = options.before;
    return this.db
      .prepare(
        `SELECT i.* FROM app_shared_instances i
         JOIN app_shared_members m ON m.app_id = i.app_id AND m.instance_key = i.instance_key
         WHERE i.app_id = ? AND m.username = ?
           ${before ? "AND (i.created_at < ? OR (i.created_at = ? AND i.instance_key < ?))" : ""}
         ORDER BY i.created_at DESC, i.instance_key DESC
         LIMIT ?`,
      )
      .all(
        appId,
        username,
        ...(before ? [before.createdAt, before.createdAt, before.instanceKey] : []),
        limit,
      ) as SharedAppInstanceRow[];
  }

  // ── External App host bindings (v49, `external-app-host/v1`) ──
  //
  // Both tables store only sha256 digests of the credentials they describe.
  // Nothing here decides authority: the service re-reads App trust, the
  // instance's status, the caller's seat and the active release on every call,
  // and a row that survives one of those changing simply fails closed.

  /**
   * How many bindings one account already holds for one App, INCLUDING the
   * launch grants it has not redeemed yet.
   *
   * Counting only live capabilities would make the ceiling advisory: a person
   * (or a page bug, or a script holding their session) could mint N grants
   * while the count was still zero and redeem all of them afterwards. An
   * unconsumed, unexpired grant is a binding that is about to exist, so it
   * occupies a slot until it is spent or dies.
   */
  countExternalAppBindings(username: string, appId: string, nowIso: string): number {
    const capabilities = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM app_external_capabilities
         WHERE username = ? AND app_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(username, appId, nowIso) as { n: number };
    const grants = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM app_external_launch_grants
         WHERE username = ? AND app_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(username, appId, nowIso) as { n: number };
    return capabilities.n + grants.n;
  }

  /**
   * Write one launch grant, or refuse because the ceiling is already reached.
   *
   * The count and the insert are ONE transaction: two requests racing on the
   * same account must not both read `max - 1` and both write.
   */
  reserveExternalAppLaunchGrant(row: ExternalAppLaunchGrantRow, max: number, nowIso: string): boolean {
    return this.db.transaction(() => {
      if (this.countExternalAppBindings(row.username, row.app_id, nowIso) >= max) return false;
      this.createExternalAppLaunchGrant(row);
      return true;
    })();
  }

  createExternalAppLaunchGrant(row: ExternalAppLaunchGrantRow): void {
    this.db
      .prepare(
        `INSERT INTO app_external_launch_grants
           (grant_id, token_hash, app_id, instance_key, username, host_id, host_origin,
            release_digest, authority, created_at, expires_at, consumed_at, consumed_credential)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.grant_id,
        row.token_hash,
        row.app_id,
        row.instance_key,
        row.username,
        row.host_id,
        row.host_origin,
        row.release_digest,
        row.authority,
        row.created_at,
        row.expires_at,
        row.consumed_at,
        row.consumed_credential,
      );
  }

  /**
   * Redeem one launch grant, ONCE.
   *
   * The mark and the read are one transaction, so two concurrent exchanges of
   * the same fragment cannot both be handed a credential: the loser sees zero
   * changed rows and gets the same refusal a replay gets. An expired row is
   * left untouched — it is already dead, and consuming it would erase the
   * distinction between "too late" and "already used".
   */
  consumeExternalAppLaunchGrant(
    tokenHash: string,
    credentialId: string,
    nowIso: string,
    max: number,
  ): ExternalAppLaunchGrantConsumption {
    return this.db.transaction((): ExternalAppLaunchGrantConsumption => {
      const row = this.db
        .prepare("SELECT * FROM app_external_launch_grants WHERE token_hash = ?")
        .get(tokenHash) as ExternalAppLaunchGrantRow | undefined;
      if (!row || row.consumed_at || row.expires_at <= nowIso) return { ok: false, reason: "invalid" };
      // The ceiling again, over LIVE capabilities only: this grant was counted
      // when it was minted and is about to stop being a grant, so counting it
      // twice would refuse the last legitimate redemption. Re-asked here at all
      // because a grant may be redeemed long after the state that admitted it —
      // a person could have spent their slots from another page in between.
      const live = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM app_external_capabilities
           WHERE username = ? AND app_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(row.username, row.app_id, nowIso) as { n: number };
      if (live.n >= max) return { ok: false, reason: "limit" };
      const changed = this.db
        .prepare(
          `UPDATE app_external_launch_grants SET consumed_at = ?, consumed_credential = ?
           WHERE grant_id = ? AND consumed_at IS NULL`,
        )
        .run(nowIso, credentialId, row.grant_id).changes;
      if (changed === 0) return { ok: false, reason: "invalid" };
      return { ok: true, row: { ...row, consumed_at: nowIso, consumed_credential: credentialId } };
    })();
  }

  getExternalAppLaunchGrant(grantId: string): ExternalAppLaunchGrantRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_external_launch_grants WHERE grant_id = ?")
      .get(grantId) as ExternalAppLaunchGrantRow | undefined;
  }

  /** Housekeeping: a redeemed or long-dead handoff has nothing left to prove. */
  deleteExpiredExternalAppLaunchGrants(beforeIso: string): number {
    return this.db
      .prepare("DELETE FROM app_external_launch_grants WHERE expires_at <= ?")
      .run(beforeIso).changes;
  }

  createExternalAppCapability(row: ExternalAppCapabilityRow): void {
    this.db
      .prepare(
        `INSERT INTO app_external_capabilities
           (credential_id, secret_hash, app_id, instance_key, username, host_id, host_origin,
            release_digest, authority, grant_id, created_at, expires_at, last_used_at,
            revoked_at, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.credential_id,
        row.secret_hash,
        row.app_id,
        row.instance_key,
        row.username,
        row.host_id,
        row.host_origin,
        row.release_digest,
        row.authority,
        row.grant_id,
        row.created_at,
        row.expires_at,
        row.last_used_at,
        row.revoked_at,
        row.revoked_reason,
      );
  }

  /**
   * Resolve a presented secret's hash to a LIVE binding. Revoked and expired
   * rows answer undefined here — the transport must not have to remember two
   * extra checks — while `listExternalAppCapabilities` still shows them.
   */
  getActiveExternalAppCapability(secretHash: string, nowIso: string): ExternalAppCapabilityRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM app_external_capabilities WHERE secret_hash = ?")
      .get(secretHash) as ExternalAppCapabilityRow | undefined;
    if (!row || row.revoked_at) return undefined;
    if (row.expires_at <= nowIso) return undefined;
    return row;
  }

  /**
   * One binding by its PUBLIC id.
   *
   * The revalidation a live stream runs needs to re-ask "is this binding still
   * alive" without holding the secret in memory for the life of the connection.
   * Knowing an id is not authority: this returns the row whatever its state,
   * and every caller decides what a revoked or expired one means.
   */
  getExternalAppCapability(credentialId: string): ExternalAppCapabilityRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_external_capabilities WHERE credential_id = ?")
      .get(credentialId) as ExternalAppCapabilityRow | undefined;
  }

  listExternalAppCapabilities(username: string, appId: string): ExternalAppCapabilityRow[] {
    return this.db
      .prepare(
        `SELECT * FROM app_external_capabilities WHERE username = ? AND app_id = ?
         ORDER BY created_at DESC, credential_id`,
      )
      .all(username, appId) as ExternalAppCapabilityRow[];
  }

  /** Owner-scoped on purpose: naming a credential id is not authority over it. */
  revokeExternalAppCapability(
    username: string,
    credentialId: string,
    revokedAt: string,
    reason: string,
  ): ExternalAppCapabilityRow | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM app_external_capabilities WHERE credential_id = ? AND username = ?")
        .get(credentialId, username) as ExternalAppCapabilityRow | undefined;
      if (!row || row.revoked_at) return undefined;
      this.db
        .prepare(
          `UPDATE app_external_capabilities SET revoked_at = ?, revoked_reason = ?
           WHERE credential_id = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, reason, credentialId);
      return { ...row, revoked_at: revokedAt, revoked_reason: reason };
    })();
  }

  touchExternalAppCapability(credentialId: string, usedAt: string): void {
    this.db
      .prepare("UPDATE app_external_capabilities SET last_used_at = ? WHERE credential_id = ?")
      .run(usedAt, credentialId);
  }

  /**
   * Remove a user and everything that references them. Account teardown has to
   * be complete: a leftover runner token or identity row is a credential that
   * outlives the account it belonged to.
   */
  deleteUser(username: string): boolean {
    return this.withinTransaction(() => {
      this.db.prepare("DELETE FROM runner_tokens WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM dashboard_tokens WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM session_execution_bindings WHERE owner = ?").run(username);
      this.db.prepare("DELETE FROM mcp_tokens WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM web_sessions WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM user_identities WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM user_settings WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM user_grants WHERE username = ?").run(username);
      // A deleted account's grants go with it. Leaving them would mean
      // re-creating the username silently restores every permission the old
      // holder had handed out.
      this.db.prepare("DELETE FROM grant_intents WHERE owner = ?").run(username);
      this.db.prepare("DELETE FROM app_trust WHERE owner = ?").run(username);
      this.db.prepare("DELETE FROM workspace_grants WHERE owner = ? OR grantee = ?").run(username, username);
      // An external App binding is a credential in somebody else's hands; it
      // must not survive the account it was minted by and for.
      this.db.prepare("DELETE FROM app_external_capabilities WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM app_external_launch_grants WHERE username = ?").run(username);
      this.db.prepare("DELETE FROM permission_audit WHERE owner = ?").run(username);
      return this.db.prepare("DELETE FROM users WHERE username = ?").run(username).changes > 0;
    });
  }

  // ── Server-side web sessions (migration v23) ──

  createWebSession(row: WebSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO web_sessions (token_hash, username, csrf_hash, created_at, last_seen_at, absolute_expiry, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(row.token_hash, row.username, row.csrf_hash, row.created_at, row.last_seen_at, row.absolute_expiry);
  }

  getWebSession(tokenHash: string): WebSessionRow | undefined {
    return this.db.prepare("SELECT * FROM web_sessions WHERE token_hash = ?").get(tokenHash) as
      | WebSessionRow
      | undefined;
  }

  touchWebSession(tokenHash: string, at: string): void {
    this.db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?").run(at, tokenHash);
  }

  revokeWebSession(tokenHash: string, at: string): void {
    this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ?").run(at, tokenHash);
  }

  /** Housekeeping: drop rows past their absolute expiry (or long revoked). */
  pruneWebSessions(nowIso: string): number {
    const res = this.db.prepare("DELETE FROM web_sessions WHERE absolute_expiry < ? OR revoked_at < ?").run(nowIso, nowIso);
    return res.changes;
  }

  /**
   * Every session belonging to one user, newest first, including dead ones —
   * the "where am I logged in" list. Callers decide what to show; hiding an
   * expired row here would make "log out everywhere" untestable.
   */
  listWebSessions(username: string): WebSessionRow[] {
    return this.db
      .prepare("SELECT * FROM web_sessions WHERE username = ? ORDER BY last_seen_at DESC")
      .all(username) as WebSessionRow[];
  }

  /**
   * Revoke every live session of one user. Returns how many rows moved, so the
   * caller can report "3 sessions ended" rather than a bare ok.
   *
   * `revoked_at IS NULL` in the WHERE is what makes this idempotent: pressing
   * "log out everywhere" twice must not rewrite the timestamp of a session that
   * was already ended, because that timestamp is the audit answer to "when".
   */
  revokeAllWebSessions(username: string, at: string, exceptTokenHash?: string): number {
    const sql = exceptTokenHash
      ? "UPDATE web_sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL AND token_hash <> ?"
      : "UPDATE web_sessions SET revoked_at = ? WHERE username = ? AND revoked_at IS NULL";
    const args = exceptTokenHash ? [at, username, exceptTokenHash] : [at, username];
    return this.db.prepare(sql).run(...args).changes;
  }

  // ── Grant intents (migration v24) ──

  /**
   * Write a grant intent. Replaces by primary key so re-granting the same
   * (subject, owner, resource) is one row with a new operation set rather than
   * a pile of history that makes "which one is in force" a guess.
   */
  saveGrantIntent(row: GrantIntentRow): void {
    this.db
      .prepare(
        `INSERT INTO grant_intents
           (id, subject_type, subject_id, owner, resource_type, resource_id, operations, terms,
            source, status, contract_digest, publisher, created_by, created_at, expires_at,
            revoked_by, revoked_at)
         VALUES (@id, @subject_type, @subject_id, @owner, @resource_type, @resource_id, @operations,
                 @terms, @source, @status, @contract_digest, @publisher, @created_by, @created_at,
                 @expires_at, @revoked_by, @revoked_at)
         ON CONFLICT(id) DO UPDATE SET
           operations = excluded.operations,
           terms = excluded.terms,
           source = excluded.source,
           status = excluded.status,
           contract_digest = excluded.contract_digest,
           publisher = excluded.publisher,
           created_by = excluded.created_by,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           revoked_by = excluded.revoked_by,
           revoked_at = excluded.revoked_at`,
      )
      .run(row);
  }

  getGrantIntent(id: string): GrantIntentRow | undefined {
    return this.db.prepare("SELECT * FROM grant_intents WHERE id = ?").get(id) as GrantIntentRow | undefined;
  }

  /** Every grant touching one account, whatever its status. */
  listGrantIntents(owner: string): GrantIntentRow[] {
    return this.db
      .prepare("SELECT * FROM grant_intents WHERE owner = ? ORDER BY subject_type, subject_id")
      .all(owner) as GrantIntentRow[];
  }

  /** Across all accounts — the admin's read-only cross-user view. */
  listAllGrantIntents(): GrantIntentRow[] {
    return this.db
      .prepare("SELECT * FROM grant_intents ORDER BY owner, subject_type, subject_id")
      .all() as GrantIntentRow[];
  }

  /**
   * Mark a grant revoked. Returns false when there was nothing live to revoke,
   * so a caller can tell "I just closed it" from "it was already closed" —
   * which decides whether the expensive Context teardown needs to run.
   */
  revokeGrantIntent(id: string, by: string, at: string): boolean {
    return (
      this.db
        .prepare("UPDATE grant_intents SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE id = ? AND status = 'active'")
        .run(by, at, id).changes > 0
    );
  }

  // ── App publisher trust (migration v27) ──

  saveAppTrust(row: AppTrustRow): void {
    this.db.prepare(
      `INSERT INTO app_trust
         (owner, app_id, publisher, profile, package_digest_at_consent,
          follow_updates, decided_at, revoked_at)
       VALUES (@owner, @app_id, @publisher, @profile, @package_digest_at_consent,
               @follow_updates, @decided_at, @revoked_at)
       ON CONFLICT(owner, app_id, publisher) DO UPDATE SET
         profile = excluded.profile,
         package_digest_at_consent = excluded.package_digest_at_consent,
         follow_updates = excluded.follow_updates,
         decided_at = excluded.decided_at,
         revoked_at = excluded.revoked_at`,
    ).run(row);
  }

  getAppTrust(owner: string, appId: string, publisher: string): AppTrustRow | undefined {
    return this.db.prepare(
      "SELECT * FROM app_trust WHERE owner = ? AND app_id = ? AND publisher = ?",
    ).get(owner, appId, publisher) as AppTrustRow | undefined;
  }

  listAppTrust(owner: string): AppTrustRow[] {
    return this.db.prepare(
      "SELECT * FROM app_trust WHERE owner = ? ORDER BY app_id, publisher",
    ).all(owner) as AppTrustRow[];
  }

  revokeAppTrust(owner: string, appId: string, publisher: string, at: string): boolean {
    return this.db.prepare(
      `UPDATE app_trust SET revoked_at = ?
       WHERE owner = ? AND app_id = ? AND publisher = ? AND revoked_at IS NULL`,
    ).run(at, owner, appId, publisher).changes > 0;
  }

  // ── Permission activity record (migration v24) ──

  recordPermissionAudit(row: Omit<PermissionAuditRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO permission_audit (at, owner, subject_type, subject_id, operation, resource, decision, reason, detail)
         VALUES (@at, @owner, @subject_type, @subject_id, @operation, @resource, @decision, @reason, @detail)`,
      )
      .run(row);
  }

  /**
   * Newest-first activity for one account, optionally filtered. Filters are
   * exact matches on purpose — a LIKE here would turn a subject id somebody
   * chose into a pattern over everybody's rows.
   *
   * `limit` bounds one page, not the history: `beforeId` is an exclusive
   * keyset cursor (the last id of the previous page), so walking pages reaches
   * the oldest retained row with no gap or repeat while new rows are appended.
   */
  listPermissionAudit(
    owner: string,
    filter: { subjectId?: string; operation?: string; decision?: string; limit?: number; beforeId?: number } = {},
  ): PermissionAuditRow[] {
    const where = ["owner = ?"];
    const args: unknown[] = [owner];
    if (filter.beforeId !== undefined) {
      where.push("id < ?");
      args.push(filter.beforeId);
    }
    if (filter.subjectId) {
      where.push("subject_id = ?");
      args.push(filter.subjectId);
    }
    if (filter.operation) {
      where.push("operation = ?");
      args.push(filter.operation);
    }
    if (filter.decision) {
      where.push("decision = ?");
      args.push(filter.decision);
    }
    // 501: one page of the route's 500-row window plus the row that proves
    // another page exists.
    const limit = Math.max(1, Math.min(501, Math.floor(filter.limit ?? 100)));
    args.push(limit);
    return this.db
      .prepare(`SELECT * FROM permission_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...args) as PermissionAuditRow[];
  }

  /**
   * Housekeeping: delete up to `limit` of the oldest records written before
   * `before` (ISO time). Only the first `limit` rows by id are examined — rows
   * are appended in time order, so a short count means the backlog is gone, and
   * a step never scans the table.
   */
  prunePermissionAudit(before: string, limit = 500): number {
    return this.db
      .prepare(
        "DELETE FROM permission_audit WHERE id IN (SELECT id FROM permission_audit ORDER BY id LIMIT ?) AND at < ?",
      )
      .run(limit, before).changes;
  }

  // ── Capability grants (ticket #15) ──

  /** Capabilities granted to one user. Admin-ness is config, never a row. */
  listUserGrants(username: string): UserGrantRow[] {
    return this.db
      .prepare("SELECT * FROM user_grants WHERE username = ? ORDER BY capability")
      .all(username) as UserGrantRow[];
  }

  listAllUserGrants(): UserGrantRow[] {
    return this.db.prepare("SELECT * FROM user_grants ORDER BY username, capability").all() as UserGrantRow[];
  }

  /** Idempotent: re-granting refreshes who granted it and when. */
  grantCapability(username: string, capability: string, grantedBy: string, grantedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO user_grants (username, capability, granted_by, granted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(username, capability) DO UPDATE SET granted_by = excluded.granted_by,
                                                          granted_at = excluded.granted_at`,
      )
      .run(username, capability, grantedBy, grantedAt);
  }

  revokeCapability(username: string, capability: string): boolean {
    const res = this.db
      .prepare("DELETE FROM user_grants WHERE username = ? AND capability = ?")
      .run(username, capability);
    return res.changes > 0;
  }

  // ── Transactions ──

  /**
   * Execute a function within a SQLite transaction.
   * Automatically commits on success, rolls back on error.
   */
  withinTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Session operations shared by Hub and App surfaces (migrations v25-v26) ──

  /**
   * States a submission can still move on from. Written out rather than
   * inferred from "not terminal", because the two lists are read for different
   * reasons: this one decides what a duplicate submission JOINS, and it must
   * never include a state whose work is over.
   */
  static readonly LIVE_SESSION_OPERATION_STATUSES = ["submitted", "waiting_approval", "running"] as const;

  createSessionOperation(row: SessionOperationRow): void {
    this.db
      .prepare(
        `INSERT INTO session_operations
           (id, owner, surface, credential, resource_id, device, cli_kind, session_id, operation, args_hash,
            pending_call_id, context_id, status, detail, new_session_id,
            submitted_at, started_at, finished_at, updated_at, input_receipt, runner_operation_id, runner_receipt_target)
         VALUES (@id, @owner, @surface, @credential, @resource_id, @device, @cli_kind, @session_id, @operation,
                 @args_hash, @pending_call_id, @context_id, @status, @detail, @new_session_id,
                 @submitted_at, @started_at, @finished_at, @updated_at, @input_receipt, @runner_operation_id, @runner_receipt_target)`,
      )
      .run({ ...row, input_receipt: row.input_receipt ?? null, runner_operation_id: row.runner_operation_id ?? null,
        runner_receipt_target: row.runner_receipt_target ?? null });
  }

  /**
   * Owner-scoped by parameter, not by convention: an operation id is opaque and
   * a caller that has one from somewhere else must not be able to read it.
   */
  getSessionOperation(id: string, owner: string): SessionOperationRow | undefined {
    return this.db.prepare("SELECT * FROM session_operations WHERE id = ? AND owner = ?").get(id, owner) as
      | SessionOperationRow
      | undefined;
  }

  /** For the approval routes, which know a pending call id and nothing else. */
  getSessionOperationByPending(pendingCallId: string): SessionOperationRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM session_operations WHERE pending_call_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(pendingCallId) as SessionOperationRow | undefined;
  }

  /**
   * The live submission for one intent, if any — what makes a second click on
   * the same button join the first instead of queueing a second turn.
   */
  findLiveSessionOperation(
    owner: string,
    surface: string,
    resourceId: string,
    argsHash: string,
  ): SessionOperationRow | undefined {
    const marks = Store.LIVE_SESSION_OPERATION_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM session_operations
         WHERE owner = ? AND surface = ? AND resource_id = ? AND args_hash = ? AND status IN (${marks})
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(owner, surface, resourceId, argsHash, ...Store.LIVE_SESSION_OPERATION_STATUSES) as
      | SessionOperationRow
      | undefined;
  }

  /**
   * One owner's submissions, newest first, one bounded window at a time.
   * `beforeId` is an exclusive keyset cursor (an operation id this owner owns,
   * typically the last row of the previous window); `sequence` is monotonic, so
   * walking windows reaches the oldest record without gaps or repeats.
   */
  listSessionOperations(
    owner: string,
    o: { sessionId?: string; surface?: string; limit?: number; beforeId?: string } = {},
  ): SessionOperationRow[] {
    const limit = Math.max(1, Math.min(201, o.limit ?? 50));
    const where = ["owner = ?"];
    const params: unknown[] = [owner];
    if (o.sessionId) { where.push("session_id = ?"); params.push(o.sessionId); }
    if (o.surface) { where.push("surface = ?"); params.push(o.surface); }
    if (o.beforeId) {
      where.push("sequence < (SELECT sequence FROM session_operations WHERE id = ? AND owner = ?)");
      params.push(o.beforeId, owner);
    }
    return this.db
      .prepare(`SELECT * FROM session_operations WHERE ${where.join(" AND ")} ORDER BY sequence DESC LIMIT ?`)
      .all(...params, limit) as SessionOperationRow[];
  }

  /** Every submission that still claims to be in flight, oldest first. */
  listLiveSessionOperations(surface?: string): SessionOperationRow[] {
    const marks = Store.LIVE_SESSION_OPERATION_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM session_operations WHERE status IN (${marks})${surface ? " AND surface = ?" : ""}
         ORDER BY sequence ASC`,
      )
      .all(...Store.LIVE_SESSION_OPERATION_STATUSES, ...(surface ? [surface] : [])) as SessionOperationRow[];
  }

  /**
   * One window of the submissions whose Runner receipt can still be observed,
   * newest first. `beforeSequence` is the exclusive keyset cursor the previous
   * window's `next` returned; walking windows reaches every such row (startup
   * recovery used to see only the newest 500 and left the rest unobserved).
   */
  listRecoverableSessionOperations(
    o: { beforeSequence?: number; limit?: number } = {},
  ): { rows: SessionOperationRow[]; next: number | null } {
    const limit = Math.max(1, Math.min(500, o.limit ?? 500));
    const rows = this.db.prepare(`SELECT * FROM session_operations
      WHERE runner_operation_id IS NOT NULL AND status IN ('running', 'unknown') AND sequence < ?
      ORDER BY sequence DESC LIMIT ?`)
      .all(o.beforeSequence ?? Number.MAX_SAFE_INTEGER, limit + 1) as Array<SessionOperationRow & { sequence: number }>;
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? page.at(-1)!.sequence : null };
  }

  updateSessionOperation(id: string, patch: SessionOperationPatch & { updated_at: string }): void {
    const cols = Object.keys(patch).filter((k) => k !== "id" && k !== "owner");
    if (cols.length === 0) return;
    const set = cols.map((c) => `${c} = @${c}`).join(", ");
    this.db.prepare(`UPDATE session_operations SET ${set} WHERE id = @id`).run({ ...patch, id });
  }

  /**
   * Claim the single owner notice one Runner completion receipt may produce.
   * Receipts are replayed after every reconnect, so this is keyed by receipt
   * identity. A receipt completed before `notBefore` is no longer news, and
   * rows that old are pruned in the same transaction. Timestamps are ISO-8601
   * UTC so that text order is time order.
   */
  claimManagedCompletionNotice(
    notice: { owner: string; device: string; provider: string; turnId: string; completedAt: string },
    notBefore: string,
  ): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM managed_completion_notices WHERE completed_at < ?").run(notBefore);
      if (notice.completedAt < notBefore) return false;
      return this.db.prepare(`INSERT OR IGNORE INTO managed_completion_notices
        (owner, device, provider, turn_id, completed_at) VALUES (?, ?, ?, ?, ?)`)
        .run(notice.owner, notice.device, notice.provider, notice.turnId, notice.completedAt).changes === 1;
    })();
  }

  /** Housekeeping: an operation record is evidence, but not forever. */
  pruneSessionOperations(owner: string, keep = 200): number {
    const marks = Store.LIVE_SESSION_OPERATION_STATUSES.map(() => "?").join(",");
    const retained = Math.max(0, keep);
    return this.db
      .prepare(
        `DELETE FROM session_operations
         WHERE owner = ? AND status NOT IN (${marks}) AND id NOT IN (
           SELECT id FROM session_operations WHERE owner = ? ORDER BY sequence DESC LIMIT ?
         )`,
      )
      .run(owner, ...Store.LIVE_SESSION_OPERATION_STATUSES, owner, retained).changes;
  }

  // ── App agents: cursors and transcripts (migration v29) ──

  /** Every (app, scope, agent) this process has ever run a turn for. */
  listAppAgentCursors(appId?: string): AppAgentCursorRow[] {
    return appId
      ? this.db.prepare("SELECT * FROM app_agent_cursors WHERE app_id = ? ORDER BY scope_key, agent").all(appId) as AppAgentCursorRow[]
      : this.db.prepare("SELECT * FROM app_agent_cursors ORDER BY app_id, scope_key, agent").all() as AppAgentCursorRow[];
  }

  getAppAgentCursor(key: AppAgentKey): AppAgentCursorRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_agent_cursors WHERE app_id = ? AND scope_key = ? AND agent = ?")
      .get(key.appId, key.scopeKey, key.agent) as AppAgentCursorRow | undefined;
  }

  /**
   * Register an agent without consuming anything.
   *
   * This is what puts an account into the `daily` trigger's population: the
   * scheduler deliberately has no account enumerator, so it fires only for
   * (app, scope, agent) triples that have a cursor row — that is, ones somebody
   * has actually used at least once.
   */
  ensureAppAgentCursor(key: AppAgentKey): AppAgentCursorRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO app_agent_cursors (app_id, scope_key, agent, upto_seq, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(app_id, scope_key, agent) DO NOTHING`,
      )
      .run(key.appId, key.scopeKey, key.agent, now, now);
    return this.getAppAgentCursor(key)!;
  }

  /**
   * Consume-at-start: advance the cursor and open the turn in ONE transaction.
   *
   * The two must not be separable. Advancing without a turn row loses the
   * evidence that anything consumed those messages; opening a turn without
   * advancing lets a crash between the two replay a batch whose tool calls have
   * already had their effect. `upto` is checked against the stored cursor so a
   * second pump on the same agent cannot claim the same range twice.
   */
  claimAppAgentInbox(input: {
    key: AppAgentKey;
    owner: string;
    turnId: string;
    trigger: AppAgentTurnTrigger;
    /** Exclusive lower bound = the cursor this claim expects to find. */
    fromSeq: number;
    /** Inclusive upper bound the cursor moves to. */
    uptoSeq: number;
  }): AppAgentTurnRow | null {
    const now = new Date().toISOString();
    return this.db.transaction((): AppAgentTurnRow | null => {
      const current = this.getAppAgentCursor(input.key);
      if (!current || current.upto_seq !== input.fromSeq) return null;
      if (input.uptoSeq < input.fromSeq) return null;
      this.db
        .prepare("UPDATE app_agent_cursors SET upto_seq = ?, updated_at = ? WHERE app_id = ? AND scope_key = ? AND agent = ?")
        .run(input.uptoSeq, now, input.key.appId, input.key.scopeKey, input.key.agent);
      const row: Omit<AppAgentTurnRow, "sequence"> = {
        id: input.turnId,
        app_id: input.key.appId,
        scope_key: input.key.scopeKey,
        agent: input.key.agent,
        owner: input.owner,
        status: "running",
        trigger: input.trigger,
        from_seq: input.fromSeq,
        upto_seq: input.uptoSeq,
        tool_calls: 0,
        note: null,
        started_at: now,
        finished_at: null,
        updated_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO app_agent_turns
             (id, app_id, scope_key, agent, owner, status, trigger, from_seq, upto_seq, tool_calls, note, started_at, finished_at, updated_at)
           VALUES
             (@id, @app_id, @scope_key, @agent, @owner, @status, @trigger, @from_seq, @upto_seq, @tool_calls, @note, @started_at, @finished_at, @updated_at)`,
        )
        .run(row);
      return this.getAppAgentTurn(input.turnId)!;
    })();
  }

  getAppAgentTurn(id: string): AppAgentTurnRow | undefined {
    return this.db.prepare("SELECT * FROM app_agent_turns WHERE id = ?").get(id) as AppAgentTurnRow | undefined;
  }

  finishAppAgentTurn(id: string, status: Exclude<AppAgentTurnStatus, "running">, note: string | null, toolCalls?: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE app_agent_turns
            SET status = ?, note = ?, tool_calls = COALESCE(?, tool_calls), finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(status, note, toolCalls ?? null, now, now, id);
  }

  listAppAgentTurns(key: AppAgentKey, limit = 20): AppAgentTurnRow[] {
    return this.db
      .prepare(
        `SELECT * FROM app_agent_turns
          WHERE app_id = ? AND scope_key = ? AND agent = ?
          ORDER BY sequence DESC LIMIT ?`,
      )
      .all(key.appId, key.scopeKey, key.agent, Math.max(1, Math.min(200, limit))) as AppAgentTurnRow[];
  }

  /**
   * Settle whatever a previous process left in flight.
   *
   * Called once at construction of the plane, before any turn can start. A row
   * that still says `running` from a previous lifetime is a claim nothing in
   * this process can support — so it becomes `unknown`, and nothing is
   * re-dispatched. Returns the ids so the caller can leave a transcript note.
   */
  listRunningAppAgentTurns(): AppAgentTurnRow[] {
    return this.db.prepare("SELECT * FROM app_agent_turns WHERE status = 'running' ORDER BY sequence").all() as AppAgentTurnRow[];
  }

  recoverAppAgentTurns(note: string): string[] {
    const now = new Date().toISOString();
    return this.db.transaction((): string[] => {
      const rows = this.db.prepare("SELECT id FROM app_agent_turns WHERE status = 'running'").all() as { id: string }[];
      if (!rows.length) return [];
      this.db
        .prepare("UPDATE app_agent_turns SET status = 'unknown', note = ?, finished_at = ?, updated_at = ? WHERE status = 'running'")
        .run(note, now, now);
      return rows.map((row) => row.id);
    })();
  }

  addAppAgentMessage(
    key: AppAgentKey,
    turnId: string,
    role: AppAgentMessageRow["role"],
    content: string,
    toolName?: string,
  ): AppAgentMessageRow {
    const at = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO app_agent_messages (turn_id, app_id, scope_key, agent, role, content, tool_name, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(turnId, key.appId, key.scopeKey, key.agent, role, content, toolName ?? null, at);
    return {
      id: Number(res.lastInsertRowid),
      turn_id: turnId,
      app_id: key.appId,
      scope_key: key.scopeKey,
      agent: key.agent,
      role,
      content,
      tool_name: toolName ?? null,
      at,
    };
  }

  /** The tail, oldest-first, so a caller can replay it straight into a loop. */
  listAppAgentMessages(key: AppAgentKey, limit = 120): AppAgentMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM app_agent_messages
          WHERE app_id = ? AND scope_key = ? AND agent = ?
          ORDER BY id DESC LIMIT ?`,
      )
      .all(key.appId, key.scopeKey, key.agent, Math.max(1, Math.min(500, limit))) as AppAgentMessageRow[];
    return rows.reverse();
  }

  /** Keep the newest `keep` transcript rows for one agent; return how many went. */
  pruneAppAgentMessages(key: AppAgentKey, keep = 400): number {
    return this.db
      .prepare(
        `DELETE FROM app_agent_messages
          WHERE app_id = ? AND scope_key = ? AND agent = ?
            AND id NOT IN (
              SELECT id FROM app_agent_messages
               WHERE app_id = ? AND scope_key = ? AND agent = ?
               ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(key.appId, key.scopeKey, key.agent, key.appId, key.scopeKey, key.agent, Math.max(1, keep)).changes;
  }

  // ── Lifecycle ──

  close(): void {
    this.db.close();
  }
}
