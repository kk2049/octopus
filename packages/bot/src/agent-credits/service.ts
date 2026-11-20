import { createHash } from "node:crypto";
import { publicCodexEmailLabel, publicCodexQuota } from "@claude-bot/runner/inventory";
import { SESSION_CLI_KINDS } from "@claude-bot/agent-sessions-contract";
import type { AuthorizationService } from "../authorization/service.js";
import { resourceUri } from "../authorization/namespace.js";
import type { AuthorizationResource } from "../authorization/types.js";
import type { RunnerManagedCompletion } from "@claude-bot/runner/gateway-protocol";
import type { RunnerDeviceStatus } from "../runner/gateway.js";
import type { Store } from "../store/store.js";

export const RUN_AGENT_OPERATION = "run_agent" as const;
export const AGENT_RUNTIME_KIND = "agent-runtime" as const;
const EXTERNAL_SYSTEM = "octopus-agent-runtime";
const MAX_SHARED_RUNTIMES = 64;
const SESSION_CLI_KIND_SET = new Set<string>(SESSION_CLI_KINDS);

export interface BorrowedAgentRuntime {
  alias: string;
  /** Trusted caller account; never included in the placement projection. */
  holder: string;
  owner: string;
  device: string;
  resourceId: string;
  balance: number;
}

export type BorrowedRuntimeResult =
  | { ok: true; runtime: BorrowedAgentRuntime }
  | { ok: false; status: 403 | 409; error: string };

export interface AgentRuntimeCreditServiceOptions {
  store: Store;
  authorization: AuthorizationService;
  /** Gateway-local, owner-bound inventory. */
  devices: (owner: string) => readonly RunnerDeviceStatus[];
  /** Explicit provider whitelist; production supplies dashboard.admins. */
  hostOwners: readonly string[];
}

export interface AgentRuntimePermitState {
  configured: boolean;
  effective: boolean;
  available: boolean;
  fingerprint: string;
}

function runtimeKey(owner: string, device: string): string {
  return createHash("sha256").update(JSON.stringify([owner, device]), "utf8").digest("hex").slice(0, 32);
}

function runtimeResourceId(owner: string, device: string): string {
  return `agent-runtime:${runtimeKey(owner, device)}`;
}

function runtimeAlias(resourceId: string): string {
  return `agent-${createHash("sha256").update(resourceId, "utf8").digest("hex").slice(0, 16)}`;
}

function tokenTotal(completion: RunnerManagedCompletion): number {
  const usage = completion.usage;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return count(usage?.tokens_in) + count(usage?.tokens_out) + count(usage?.tokens_cached);
}

/**
 * Trusted bridge from canonical run_agent intent to one narrow cross-owner
 * runtime placement. It never opens a file/shell capability: execution scopes
 * remain rooted in the caller and only dispatch routing crosses owners.
 */
export class AgentRuntimeCreditService {
  private readonly hostOwners: ReadonlySet<string>;

  constructor(private readonly options: AgentRuntimeCreditServiceOptions) {
    this.hostOwners = new Set(options.hostOwners.map((owner) => owner.trim()).filter(Boolean));
    this.syncHostRuntimes();
  }

  /** Idempotently register current provider devices as canonical shared resources. */
  syncHostRuntimes(): AuthorizationResource[] {
    const resources: AuthorizationResource[] = [];
    for (const owner of [...this.hostOwners].sort()) {
      const domainId = `agent-runtime-domain:${runtimeKey(owner, "domain")}`;
      const existingDomain = this.options.authorization.getDomain(domainId);
      if (existingDomain && (
        existingDomain.kind !== "shared"
        || existingDomain.authority.kind !== "owner"
        || existingDomain.authority.id !== owner
      )) {
        throw new Error("agent-runtime domain identity conflicts with an existing authorization domain");
      }
      if (!existingDomain) {
        this.options.authorization.upsertDomain({
          id: domainId,
          kind: "shared",
          title: `${owner} 的共享 Agent 运行机`,
          authority: { kind: "owner", id: owner },
          historyPolicy: "all",
        });
      }
      for (const row of this.options.devices(owner)) {
        const resourceId = runtimeResourceId(owner, row.device);
        const uri = resourceUri("object", "agent-runtime", owner, row.device);
        const externalId = `${owner}:${row.device}`;
        const existing = this.options.authorization.getResource(resourceId);
        if (existing && (
          existing.uri !== uri
          || existing.owner !== owner
          || existing.domainId !== domainId
          || existing.kind !== AGENT_RUNTIME_KIND
          || existing.externalRef.system !== EXTERNAL_SYSTEM
          || existing.externalRef.id !== externalId
        )) {
          throw new Error("agent-runtime resource identity conflicts with an existing authorization resource");
        }
        resources.push(existing ?? this.options.authorization.upsertResource({
          id: resourceId,
          uri,
          owner,
          domainId,
          kind: AGENT_RUNTIME_KIND,
          title: `Agent 运行机 · ${row.device}`,
          sensitivity: "sensitive",
          // Include owner in the external id so equal device labels owned by
          // different people cannot alias under the global uniqueness index.
          externalRef: { system: EXTERNAL_SYSTEM, id: externalId },
        }));
      }
    }
    return resources;
  }

  registerRuntime(owner: string, device: string): AuthorizationResource {
    if (!this.hostOwners.has(owner)) throw new Error("owner is not configured as an agent-runtime provider");
    const row = this.options.devices(owner).find((candidate) => candidate.device === device);
    if (!row) throw new Error("agent-runtime device is not registered to that owner");
    this.syncHostRuntimes();
    const resource = this.options.authorization.getResource(runtimeResourceId(owner, device));
    if (!resource) throw new Error("agent-runtime resource registration failed");
    return resource;
  }

  /** Provider-owned resources available to its dedicated Permission Studio adapter. */
  managedResources(owner: string): AuthorizationResource[] {
    if (!this.hostOwners.has(owner)) return [];
    this.syncHostRuntimes();
    // Retain revoked/offline device resources in the management projection so
    // their exact permits can still be removed. They never enter a borrower's
    // placement projection unless the owner-bound device inventory resolves.
    const domainId = `agent-runtime-domain:${runtimeKey(owner, "domain")}`;
    const resources = this.options.authorization.listResources({ owner, domainId, limit: 2_000 });
    if (resources.length >= 2_000) throw new Error("agent-runtime resource inventory reached the safe management limit");
    return resources.filter((resource) =>
      resource.kind === AGENT_RUNTIME_KIND && resource.externalRef.system === EXTERNAL_SYSTEM);
  }

  permitState(owner: string, resourceId: string, username: string): AgentRuntimePermitState | null {
    const resource = this.managedResources(owner).find((candidate) => candidate.id === resourceId);
    if (!resource || username === owner || !this.options.store.getUser(username)) return null;
    const subject = { type: "user" as const, id: username };
    const permit = this.options.authorization.listPermits({
      subject,
      resourceId,
      operation: RUN_AGENT_OPERATION,
      limit: 2,
    })[0];
    const available = this.options.devices(owner)
      .some((candidate) => runtimeResourceId(owner, candidate.device) === resourceId);
    const configured = permit?.mode === "allow";
    const effective = available && configured && this.options.authorization.decideAccess({
      subject,
      resourceId,
      operation: RUN_AGENT_OPERATION,
    }).result === "allow";
    return {
      configured,
      effective,
      available,
      fingerprint: createHash("sha256").update(JSON.stringify([
        owner,
        resourceId,
        username,
        permit?.id ?? null,
        permit?.mode ?? null,
        permit?.createdAt ?? null,
        available,
        effective,
      ]), "utf8").digest("hex"),
    };
  }

  setRuntimePermit(owner: string, resourceId: string, username: string, allow: boolean, actor: string): void {
    const resource = this.managedResources(owner).find((candidate) => candidate.id === resourceId);
    if (!resource) throw new Error("unknown provider-owned agent-runtime resource");
    if (!this.options.store.getUser(username) || username === owner) throw new Error("unknown or ineligible credit holder");
    if (allow) {
      const available = this.options.devices(owner)
        .some((candidate) => runtimeResourceId(owner, candidate.device) === resourceId);
      if (!available) throw new Error("agent-runtime device is no longer registered to that owner");
      this.options.authorization.putPermit({
        subject: { type: "user", id: username },
        resourceId,
        operation: RUN_AGENT_OPERATION,
        mode: "allow",
        authority: { kind: "owner", id: owner },
        source: "admin",
        createdBy: actor,
      });
      return;
    }
    this.options.authorization.revokePermit({
      subject: { type: "user", id: username },
      resourceId,
      operation: RUN_AGENT_OPERATION,
      authority: { kind: "owner", id: owner },
      revokedBy: actor,
    });
  }

  grantRuntime(owner: string, device: string, username: string, actor: string): void {
    const resource = this.registerRuntime(owner, device);
    this.setRuntimePermit(owner, resource.id, username, true, actor);
  }

  revokeRuntime(owner: string, device: string, username: string, actor: string): boolean {
    const resource = this.options.authorization.getResource(runtimeResourceId(owner, device));
    if (!resource) return false;
    const before = this.permitState(owner, resource.id, username)?.configured === true;
    this.setRuntimePermit(owner, resource.id, username, false, actor);
    return before;
  }

  /** Viewer-safe runtime inventory. Physical owner/device coordinates stay server-side. */
  projectFor(username: string): Array<Record<string, unknown>> {
    return this.permitted(username).slice(0, MAX_SHARED_RUNTIMES).map(({ runtime, row }) => {
      const inventory = row.inventory;
      const agentBackends = (inventory?.agent_backends ?? []).flatMap((backend) => {
        if (!backend || !SESSION_CLI_KIND_SET.has(backend.kind)) return [];
        return [{
          kind: backend.kind,
          available: row.online && backend.available,
          splitExecution: backend.split_execution === true,
          ...(backend.split_execution_reason ? { splitExecutionReason: backend.split_execution_reason } : {}),
          ...(backend.version ? { version: backend.version.slice(0, 120) } : {}),
          ...(backend.reason ? { reason: backend.reason.slice(0, 64) } : {}),
        }];
      });
      return {
        device: runtime.alias,
        ...(row.display_name ? { deviceLabel: row.display_name.slice(0, 120) } : {}),
        online: row.online,
        sharedAgentRuntime: true,
        creditBalance: runtime.balance,
        agentBackends,
        codexAccounts: (inventory?.ticket_options?.codex_accounts ?? []).slice(0, 27).map((account) => {
          const quota = publicCodexQuota(account.quota);
          const emailLabel = publicCodexEmailLabel(account.emailLabel);
          return { id: account.id, label: account.label,
            ...(emailLabel ? { emailLabel } : {}),
            ...(quota ? { quota } : {}) };
        }),
        // A shared runtime can never become an execution target. These false
        // facts are presentation hints only; scope issuance independently
        // binds execution to the caller's owner and registered workspace.
        execution: {
          platform: "remote",
          arch: "",
          shell: false,
          workspaceFiles: false,
          workspaceCount: 0,
          codexExecServer: false,
        },
      };
    });
  }

  resolveAlias(username: string, alias: string): BorrowedRuntimeResult {
    const found = this.permitted(username).find(({ runtime }) => runtime.alias === alias);
    if (!found) return { ok: false, status: 403, error: "这个共享 Agent 运行机未授权，或授权已经撤销" };
    return this.withBalance(found.runtime);
  }

  /** Dispatch-time recheck, including exact owner/device/resource binding. */
  authorizeResource(
    username: string,
    resourceId: string,
    expectedOwner: string,
    expectedDevice: string,
    requireBalance = true,
  ): BorrowedRuntimeResult {
    const found = this.permitted(username).find(({ runtime }) =>
      runtime.resourceId === resourceId
      && runtime.owner === expectedOwner
      && runtime.device === expectedDevice);
    if (!found) return { ok: false, status: 403, error: "共享 Agent 授权已经撤销；本次运行未发送" };
    return requireBalance ? this.withBalance(found.runtime) : { ok: true, runtime: found.runtime };
  }

  /** Charge a content-free authenticated completion exactly once per provider turn. */
  spendCompletion(
    runtimeOwner: string,
    runtimeDevice: string,
    completion: RunnerManagedCompletion,
  ): { applied: boolean; balance: number } | null {
    const binding = this.options.store.getSessionExecutionBindingByRuntime(
      runtimeOwner,
      runtimeDevice,
      completion.provider,
      completion.logical_session_id ?? completion.session_id,
      "0000-01-01T00:00:00.000Z",
    );
    if (!binding?.runtime_resource_id) return null;
    const spent = tokenTotal(completion);
    // An old provider or failed turn may have no usable accounting. Do not
    // manufacture a zero-value fact that looks like measured usage.
    if (spent <= 0) return null;
    const result = this.options.store.credits.record({
      username: binding.owner,
      delta: -spent,
      reason: "session_spend",
      refKind: "session_execution_turn",
      // The binding operation is the durable authority anchor; the bounded
      // provider turn id prevents later turns in that session from aliasing it.
      refId: `${binding.operation_id}:${completion.turn_id}`,
      createdAt: completion.completed_at,
    });
    return { applied: result.applied, balance: result.balance };
  }

  private withBalance(runtime: BorrowedAgentRuntime): BorrowedRuntimeResult {
    const current = this.options.store.credits.balance(runtime.holder);
    if (current <= 0) {
      return {
        ok: false,
        status: 409,
        error: `Agent 积分余额为 ${current}；提交开发工单后会按实际 token 消耗获得等量积分`,
      };
    }
    return { ok: true, runtime: { ...runtime, balance: current } };
  }

  private permitted(username: string): Array<{ runtime: BorrowedAgentRuntime; row: RunnerDeviceStatus }> {
    this.syncHostRuntimes();
    const subject = { type: "user" as const, id: username };
    const seen = new Set<string>();
    const out: Array<{ runtime: BorrowedAgentRuntime; row: RunnerDeviceStatus }> = [];
    for (const permit of this.options.authorization.listPermits({
      subject,
      operation: RUN_AGENT_OPERATION,
      limit: 1_000,
    })) {
      if (permit.mode !== "allow" || seen.has(permit.resourceId)) continue;
      const resource = this.options.authorization.getResource(permit.resourceId);
      if (
        !resource
        || resource.kind !== AGENT_RUNTIME_KIND
        || resource.externalRef.system !== EXTERNAL_SYSTEM
        || !this.hostOwners.has(resource.owner)
        || resource.owner === username
        || this.options.authorization.decideAccess({ subject, resourceId: resource.id, operation: RUN_AGENT_OPERATION }).result !== "allow"
      ) continue;
      const row = this.options.devices(resource.owner)
        .find((candidate) => runtimeResourceId(resource.owner, candidate.device) === resource.id);
      if (!row) continue;
      seen.add(resource.id);
      const runtime = {
        alias: runtimeAlias(resource.id),
        holder: username,
        owner: resource.owner,
        device: row.device,
        resourceId: resource.id,
        balance: this.options.store.credits.balance(username),
      } satisfies BorrowedAgentRuntime;
      out.push({ runtime, row });
    }
    return out;
  }
}
