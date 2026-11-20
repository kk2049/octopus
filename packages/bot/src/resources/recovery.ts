/**
 * Resource recovery — the tool stays, the call says *when*, the system tells
 * the agent *that it is back*.
 *
 * ── The problem (2026-08-22) ────────────────────────────────────────────────
 *
 * Tools an Octopus-launched agent gets through MCP are dynamic by nature: a
 * laptop Runner, the CI container, a remote DSH, a Feishu MCP backend can all
 * be unreachable for minutes and then return. Until now the devpipe decided
 * at TURN START whether the CI machine was online and either handed the agent
 * `machine_*` tools or did not mention them at all. Three tickets (#296, #299,
 * #301) spent the night of 08-21 with a reachable machine and no tools: their
 * turns had started during a link outage, and when the machine came back
 * nothing told the agent, nothing gave the tools back, and the agent ended its
 * turn with "blocked on infrastructure".
 *
 * ── The three rules this module implements ──────────────────────────────────
 *
 *  1. **Presence is entitlement, availability is per call.** A tool bound to
 *     a resource the caller is entitled to stays in the tool list whether or
 *     not the resource answers right now. Calling it while the resource is
 *     away yields an ordinary, structured failure that names the resource.
 *  2. **An unavailable answer registers a waiter.** The failure text carries a
 *     machine-readable marker (`⟨resource⟩`, see `unavailableMessage`); the
 *     door the agent came through (the capability loopback for MCP tools, the
 *     pipeline for its own syncs) turns it into a waiter keyed by the agent's
 *     scope label. Waiters are persisted so a bot restart mid-outage does not
 *     lose the promise.
 *  3. **Recovery notifies the scope, by scope kind.** Providers announce
 *     "resource X is back" (the Runner gateway on register); the service finds
 *     the waiters and hands each to the notifier registered for its scope
 *     prefix: `dev-ticket/<id>` posts a pipeline message (which wakes an idle
 *     ticket or is streamed into its running turn), `chat-feishu/<user>` sends
 *     a system turn into the user's latest chat session.
 *
 * Resource keys are `<kind>:<id>`; only `runner:<owner>/<device>` exists
 * today, but nothing here knows what a runner is.
 */

import { DependencyUnavailable } from "@claude-bot/capability-kernel";
import { createLogger } from "../logger.js";

const log = createLogger("resource-recovery");

export type ResourceKey = string;

export interface ResourceWaiter {
  /** The agent scope label, e.g. `dev-ticket/296` or `chat-feishu/lht`. */
  scope: string;
  resource: ResourceKey;
  /** Last failure text seen for this (scope, resource). */
  detail: string;
  /** How many unavailable answers this scope collected while waiting. */
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/** Persistence port: the store's repository in production, a Map in tests. */
export interface ResourceWaiterStore {
  upsert(scope: string, resource: ResourceKey, detail: string, at: string): void;
  /** Snapshot without removing: a crash during notification must retain intent. */
  list(resource: ResourceKey): ResourceWaiter[];
  acknowledge(waiter: ResourceWaiter): void;
  /** Legacy explicit take, not used for asynchronous notification. */
  take(resource: ResourceKey): ResourceWaiter[];
  listByScope(scope: string): ResourceWaiter[];
  deleteScope(scope: string): number;
}

/** Deliver one recovery to one scope; false = could not deliver (waiter is kept). */
export type RecoveryNotifier = (waiter: ResourceWaiter) => boolean | Promise<boolean>;

export class InMemoryResourceWaiterStore implements ResourceWaiterStore {
  private readonly rows = new Map<string, ResourceWaiter>();

  upsert(scope: string, resource: ResourceKey, detail: string, at: string): void {
    const key = `${scope}\u0000${resource}`;
    const existing = this.rows.get(key);
    if (existing) {
      existing.detail = detail;
      existing.count += 1;
      existing.last_seen_at = at;
      return;
    }
    this.rows.set(key, { scope, resource, detail, count: 1, first_seen_at: at, last_seen_at: at });
  }

  list(resource: ResourceKey): ResourceWaiter[] {
    return [...this.rows.values()].filter((row) => row.resource === resource).map((row) => ({ ...row }));
  }

  acknowledge(waiter: ResourceWaiter): void {
    const key = `${waiter.scope}\u0000${waiter.resource}`;
    const current = this.rows.get(key);
    if (current?.count === waiter.count && current.first_seen_at === waiter.first_seen_at
      && current.last_seen_at === waiter.last_seen_at) this.rows.delete(key);
  }

  take(resource: ResourceKey): ResourceWaiter[] {
    const out: ResourceWaiter[] = [];
    for (const [key, row] of this.rows) {
      if (row.resource !== resource) continue;
      out.push(row);
      this.rows.delete(key);
    }
    return out;
  }

  listByScope(scope: string): ResourceWaiter[] {
    return [...this.rows.values()].filter((row) => row.scope === scope);
  }

  deleteScope(scope: string): number {
    let n = 0;
    for (const [key, row] of this.rows) {
      if (row.scope === scope) {
        this.rows.delete(key);
        n++;
      }
    }
    return n;
  }
}

export class ResourceRecoveryService {
  private readonly recovering = new Map<ResourceKey, Promise<{ notified: number; kept: number }>>();
  private readonly notifiers: Array<{ prefix: string; notify: RecoveryNotifier }> = [];

  constructor(
    private readonly store: ResourceWaiterStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Register the notifier for every scope whose label starts with `prefix`.
   * The longest matching prefix wins, so `chat-feishu/` and `chat-feishu/x/`
   * can coexist. Returns the unsubscribe.
   */
  registerScope(prefix: string, notify: RecoveryNotifier): () => void {
    const entry = { prefix, notify };
    this.notifiers.push(entry);
    this.notifiers.sort((a, b) => b.prefix.length - a.prefix.length);
    return () => {
      const i = this.notifiers.indexOf(entry);
      if (i >= 0) this.notifiers.splice(i, 1);
    };
  }

  /** A scope just got an unavailable answer for a resource. Idempotent per (scope, resource). */
  note(scope: string, resource: ResourceKey, detail: string): void {
    if (!scope || !resource) return;
    const at = this.now().toISOString();
    this.store.upsert(scope, resource, detail.slice(0, 1_000), at);
    log.info({ scope, resource }, "resource unavailable; waiter recorded");
  }

  /**
   * The resource answers again. Every waiter is handed to its scope's
   * notifier; a waiter whose notifier is missing or reports failure is put
   * back so the next recovery (or a later manual sweep) can retry.
   */
  async recovered(resource: ResourceKey): Promise<{ notified: number; kept: number }> {
    const active = this.recovering.get(resource);
    if (active) return active;
    const task = this.notifyRecovered(resource);
    this.recovering.set(resource, task);
    try { return await task; } finally { this.recovering.delete(resource); }
  }

  private async notifyRecovered(resource: ResourceKey): Promise<{ notified: number; kept: number }> {
    const waiters = this.store.list(resource);
    let notified = 0;
    let kept = 0;
    for (const waiter of waiters) {
      const notifier = this.notifiers.find((n) => waiter.scope.startsWith(n.prefix));
      let ok = false;
      if (notifier) {
        try {
          ok = await notifier.notify(waiter);
        } catch (err) {
          log.warn({ err, scope: waiter.scope, resource }, "recovery notifier threw");
        }
      } else {
        log.warn({ scope: waiter.scope, resource }, "no recovery notifier for this scope; waiter kept");
      }
      if (ok) {
        this.store.acknowledge(waiter);
        notified++;
      } else {
        kept++;
      }
    }
    if (waiters.length) log.info({ resource, notified, kept }, "resource recovered; waiters notified");
    return { notified, kept };
  }

  /** A scope ended (turn over, session destroyed): nothing to notify any more. */
  forget(scope: string): number {
    return this.store.deleteScope(scope);
  }

  pending(scope: string): ResourceWaiter[] {
    return this.store.listByScope(scope);
  }
}

// ── The marker both ends of a call agree on ─────────────────────────────────

const MARK_RE = /资源暂不可达 ⟨([^⟩\s]+)⟩[:：]([\s\S]*)$/;

/** Text every unavailable answer is built from; `parseUnavailable` reads it back. */
export function unavailableMessage(resource: ResourceKey, detail: string): string {
  return `资源暂不可达 ⟨${resource}⟩:${detail.trim()}。已登记等待,资源恢复时会通知本会话;可以先做不依赖它的工作,不要反复重试。`;
}

export function parseUnavailable(text: string | null | undefined): { resource: ResourceKey; detail: string } | null {
  if (!text) return null;
  const m = MARK_RE.exec(text);
  if (!m) return null;
  return { resource: m[1], detail: m[2].trim() };
}

/** Thrown by a trusted dispatch path when the resource behind a call is away. */
export class ResourceUnavailableError extends DependencyUnavailable {
  readonly code = "resource_unavailable";
  constructor(readonly resource: ResourceKey, readonly detail: string) {
    super(resource, detail, unavailableMessage(resource, detail));
    this.name = "ResourceUnavailableError";
  }
}

export function runnerResource(owner: string, device: string): ResourceKey {
  return `runner:${owner}/${device}`;
}

/** `dev-ticket/<id>` → id, or null for any other scope. */
export function ticketScopeId(scope: string): number | null {
  const m = /^dev-ticket\/(\d+)$/.exec(scope);
  return m ? Number(m[1]) : null;
}

export function ticketScope(ticketId: number): string {
  return `dev-ticket/${ticketId}`;
}

/** Normalize only known transport failures; authorization/provider failures stay terminal. */
export function resourceTransportFailure(error: unknown, resource: ResourceKey): ResourceUnavailableError | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "runner_offline" || code === "runner_gone" || code === "runner_timeout"
    ? new ResourceUnavailableError(resource, "设备连接暂不可用，等待原设备恢复") : null;
}
