/**
 * Restart behaviour, against the real SQLite repository.
 *
 * "Process restart" here is literal: the service is dropped and a new one is
 * constructed over the same file, exactly as a redeploy would. The first pass
 * kept all of this in Maps, so every one of these cases silently lost state —
 * including the one that matters most, "did that exec already run?".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CapabilityService } from "./service.js";
import { SqliteCapabilityStore } from "./sqlite-store.js";
import { IndeterminateOutcome, type ObjectDefinition } from "./types.js";

let dir: string;
let file: string;
let repos: SqliteCapabilityStore[] = [];
let hits: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capdb-"));
  file = path.join(dir, "cap.db");
  hits = [];
  repos = [];
});

afterEach(() => {
  for (const r of repos) {
    try {
      r.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function device(owner: string, onWrite?: () => void): ObjectDefinition<string> {
  return {
    id: `device:${owner}`,
    kind: "device",
    binding: owner,
    metadata: { owner },
    operations: {
      read: { args: { path: { type: "string", required: true } }, effect: "read" },
      // Read-class AND approval-required — production's `read_file`. It is what
      // makes "does a human decide?" and "is running it twice safe?" visibly two
      // different questions.
      read_any: { args: { path: { type: "string", required: true } }, effect: "read" },
      // Read-class but declared un-retryable, to prove recovery reads the
      // DECLARATION and not the effect class.
      read_once: { args: { path: { type: "string", required: true } }, effect: "read", retrySafe: false },
      exec: { args: { command: { type: "string", required: true } }, effect: "modify" },
    },
    policy: (i) => {
      if (i.operation === "read") return { kind: "allow" };
      if (i.approval && i.approval.argsHash === i.argsHash && i.approval.approver === owner) return { kind: "allow" };
      return {
        kind: "approval_required",
        summary: { title: `${i.operation} on ${owner}`, target: owner, details: [], allowedApprover: owner },
      };
    },
    adapter: async (b, operation, args) => {
      onWrite?.();
      hits.push(`${b}:${operation}:${String(args.command ?? args.path ?? "")}`);
      return { ran: true };
    },
  };
}

/** Boot a service over the same file, the way a restart would. */
function boot(
  opts: { now?: () => number; pendingTtlMs?: number } = {},
): { svc: CapabilityService; repo: SqliteCapabilityStore } {
  const repo = new SqliteCapabilityStore(file);
  repos.push(repo);
  const svc = new CapabilityService({ store: repo, ...opts });
  svc.registerObject(device("alice"));
  return { svc, repo };
}

describe("capability state survives a restart", () => {
  it("exposes immutable durable context metadata only on the trusted service", () => {
    const a = boot();
    const root = a.svc.createContext("account-authority", { owner: "alice", authority_scope: "ci" });
    const metadata = a.svc.contextMetadata(root)!;
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => { (metadata as Record<string, string>).authority_scope = "windows"; }).toThrow();
    expect(a.svc.bind(root)).not.toHaveProperty("contextMetadata");
    a.repo.close();
    const b = boot();
    expect(b.svc.contextMetadata(root)).toEqual({ owner: "alice", authority_scope: "ci" });
  });

  it("contexts, capabilities and slots come back with the same rights", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read", "exec"]);
    const app = a.svc.createContext("app-instance", { owner: "alice", app: "reports" }, account);
    a.svc.derive(account, "res", app, "res", ["read"]);
    expect((await a.svc.bind(app).request("res", "read", { path: "/a" })).status).toBe("succeeded");
    a.repo.close();

    const b = boot();
    // Same context id, same slot, same narrowed rights — and still narrowed.
    expect(b.svc.rightsOf(app, "res")).toEqual(["read"]);
    expect((await b.svc.bind(app).request("res", "read", { path: "/b" })).status).toBe("succeeded");
    expect((await b.svc.bind(app).request("res", "exec", { command: "id" })).status).toBe("denied");
    expect(hits).toEqual(["alice:read:/a", "alice:read:/b"]);
  });

  it("a revoked capability stays revoked", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read"]);
    a.svc.revoke(account, "res");
    a.repo.close();

    const b = boot();
    expect((await b.svc.bind(account).request("res", "read", { path: "/a" })).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });

  it("a destroyed context stays destroyed", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read"]);
    const app = a.svc.createContext("app-instance", {}, account);
    a.svc.derive(account, "res", app, "res", ["read"]);
    a.svc.destroyContext(app);
    a.repo.close();

    const b = boot();
    expect((await b.svc.bind(app).request("res", "read", { path: "/a" })).status).toBe("denied");
  });

  it("an object re-registered with a different identity is refused", () => {
    const a = boot();
    a.repo.close();
    const repo = new SqliteCapabilityStore(file);
    repos.push(repo);
    const svc = new CapabilityService({ store: repo });
    const impostor = { ...device("alice"), metadata: { owner: "mallory" } };
    expect(() => svc.registerObject(impostor)).toThrow(/different identity/i);
  });

  it("a capability whose object is not re-registered denies rather than dangles", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read"]);
    a.repo.close();

    const repo = new SqliteCapabilityStore(file);
    repos.push(repo);
    const svc = new CapabilityService({ store: repo }); // no registerObject
    expect((await svc.bind(account).request("res", "read", { path: "/a" })).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });
});

describe("dangerous calls are exactly-once across a restart", () => {
  it("a pending approval survives and can still be approved once", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const out = await a.svc.bind(account).request("res", "exec", { command: "deploy" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    expect(hits).toHaveLength(0);
    a.repo.close();

    const b = boot();
    // The card is still there, for the same approver, describing the same call.
    const cards = b.svc.listPending("alice");
    expect(cards.map((c) => c.id)).toContain(id);
    expect((await b.svc.approve(id, "alice")).status).toBe("succeeded");
    expect(hits).toEqual(["alice:exec:deploy"]);
    // And a third boot cannot run it again.
    b.repo.close();
    const c = boot();
    expect((await c.svc.approve(id, "alice")).status).toBe("succeeded");
    expect(hits).toEqual(["alice:exec:deploy"]);
  });

  it("a call interrupted between claim and result becomes unknown, not repeated", async () => {
    let ran = 0;
    const repo = new SqliteCapabilityStore(file);
    repos.push(repo);
    const svc = new CapabilityService({ store: repo });
    svc.registerObject(
      device("alice", () => {
        ran++;
        // Simulate the process dying after the claim but before the result:
        // the row stays `claimed` because nothing records an outcome.
        throw new IndeterminateOutcome("process died mid-call");
      }),
    );
    const account = svc.createContext("account-authority", { owner: "alice" });
    svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const out = await svc.bind(account).request("res", "exec", { command: "deploy" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    // Claim it and leave it claimed, as a crash would.
    expect(repo.claimPending(id, "alice", Date.now())).toBe(true);
    repo.close();

    const b = boot();
    // Recovery declared it unknown, terminally.
    expect(b.svc.pendingState(id)).toBe("finished");
    const res = b.svc.resultOf(account, id);
    expect(res?.outcome).toBe("unknown");
    // Approving again does NOT re-run it.
    expect((await b.svc.approve(id, "alice")).status).toBe("unknown");
    expect(ran).toBe(0); // the second boot never called the adapter
    expect(b.svc.resultOf(account, id)?.retrySafe).toBe(false);
  });
});

/**
 * The other half of "the process died between approval and a result".
 *
 * For `exec` the honest answer is `unknown`, terminally — that is the case above,
 * and it is why no durable-execution framework fits: their central guarantee is
 * to resume by REPLAYING the step. But an interrupted `read_file` is not that
 * call, and writing it off makes the owner approve a harmless read twice for no
 * reason. So the Object declares which it is, once, next to `effect`.
 */
describe("an interrupted call is recovered by what its operation declared", () => {
  /** Approve-and-crash: claim the row, then drop the process. */
  function crashAfterClaim(repo: SqliteCapabilityStore, id: string, at = 1): void {
    expect(repo.claimPending(id, "alice", at)).toBe(true);
    repo.close();
  }

  async function askFor(
    svc: CapabilityService,
    account: string,
    operation: string,
  ): Promise<string> {
    const out = await svc.bind(account).request("res", operation, { path: "/secrets" });
    expect(out.status).toBe("approval_required");
    return (out as { pendingCallId: string }).pendingCallId;
  }

  it("a retry-safe one goes back to its approver instead of being written off", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read_any"], { autoAllow: [] });
    const id = await askFor(a.svc, account, "read_any");
    crashAfterClaim(a.repo, id);

    const b = boot();
    // Not terminal: the card is in front of alice again, same id, same call.
    expect(b.svc.pendingState(id)).toBe("pending");
    expect(b.svc.listPending("alice").map((c) => c.id)).toContain(id);
    expect(b.svc.resultOf(account, id)?.retrySafe).toBe(true);
    // And recovery itself touched nothing: "safe to run twice" is permission to
    // ASK again, not a licence to act at boot with nobody watching.
    expect(hits).toHaveLength(0);

    expect((await b.svc.approve(id, "alice")).status).toBe("succeeded");
    expect(hits).toEqual(["alice:read_any:/secrets"]);
  });

  it("a read-class operation that declares itself un-retryable is still written off", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read_once"], { autoAllow: [] });
    const id = await askFor(a.svc, account, "read_once");
    crashAfterClaim(a.repo, id);

    const b = boot();
    // Same effect class as the test above, opposite outcome: the declaration is
    // what recovery reads, not the effect.
    expect(b.svc.pendingState(id)).toBe("finished");
    expect(b.svc.resultOf(account, id)?.outcome).toBe("unknown");
    expect(hits).toHaveLength(0);
  });

  it("reviving never extends the deadline the card was created with", async () => {
    let clock = 0;
    const now = (): number => clock;
    const ttl = 60_000;

    const a = boot({ now, pendingTtlMs: ttl });
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read_any"], { autoAllow: [] });
    const id = await askFor(a.svc, account, "read_any");
    const deadline = a.svc.listPending("alice").find((c) => c.id === id)!.expiresAt;
    crashAfterClaim(a.repo, id, clock);

    // Half a window in: revived, and still expiring when it always would have.
    clock = 30_000;
    const b = boot({ now, pendingTtlMs: ttl });
    expect(b.svc.pendingState(id)).toBe("pending");
    expect(b.svc.listPending("alice").find((c) => c.id === id)!.expiresAt).toBe(deadline);
    crashAfterClaim(b.repo, id, clock);

    // Past that deadline there is nothing left to hand back, so a restart LOOP
    // cannot keep one card alive: it lands on `unknown` like any other
    // interrupted call whose window ran out.
    clock = 130_000;
    const c = boot({ now, pendingTtlMs: ttl });
    expect(c.svc.pendingState(id)).toBe("finished");
    expect(c.svc.resultOf(account, id)?.outcome).toBe("unknown");
    expect(hits).toHaveLength(0);
  });

  it("a decision that landed before the restart is not undone by recovery", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["read_any"], { autoAllow: [] });
    const id = await askFor(a.svc, account, "read_any");
    expect((await a.svc.approve(id, "alice")).status).toBe("succeeded");
    a.repo.close();

    const b = boot();
    expect(b.svc.pendingState(id)).toBe("finished");
    expect(b.svc.resultOf(account, id)?.outcome).toBe("succeeded");
    expect(hits).toEqual(["alice:read_any:/secrets"]); // exactly once, still
  });

  it("a retry of the same call joins the existing approval instead of queueing another", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const caps = a.svc.bind(account);
    const first = (await caps.request("res", "exec", { command: "deploy" })) as { pendingCallId: string };
    const retry = (await caps.request("res", "exec", { command: "deploy" })) as { pendingCallId: string };
    expect(retry.pendingCallId).toBe(first.pendingCallId);
    expect(a.svc.listPending("alice")).toHaveLength(1);
    await a.svc.approve(first.pendingCallId, "alice");
    expect(hits).toEqual(["alice:exec:deploy"]);
  });

  it("a pending id is not a bearer credential for the result", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const out = (await a.svc.bind(account).request("res", "exec", { command: "deploy" })) as {
      pendingCallId: string;
    };
    await a.svc.approve(out.pendingCallId, "alice");
    // The originating Context sees it...
    expect(a.svc.resultOf(account, out.pendingCallId)?.outcome).toBe("succeeded");
    // ...an unrelated Context holding the very same id does not.
    const stranger = a.svc.createContext("app-instance", { owner: "mallory" });
    expect(a.svc.resultOf(stranger, out.pendingCallId)).toBeNull();
  });

  it("expiry is durable: a card that timed out cannot be approved after a restart", async () => {
    let now = 1_000_000;
    const repo = new SqliteCapabilityStore(file);
    repos.push(repo);
    const svc = new CapabilityService({ store: repo, now: () => now, pendingTtlMs: 60_000 });
    svc.registerObject(device("alice"));
    const account = svc.createContext("account-authority", { owner: "alice" });
    svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const out = (await svc.bind(account).request("res", "exec", { command: "deploy" })) as {
      pendingCallId: string;
    };
    repo.close();

    now += 61_000;
    const repo2 = new SqliteCapabilityStore(file);
    repos.push(repo2);
    const svc2 = new CapabilityService({ store: repo2, now: () => now, pendingTtlMs: 60_000 });
    svc2.registerObject(device("alice"));
    expect((await svc2.approve(out.pendingCallId, "alice")).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });
});

describe("descendant pending calls keep their ancestors alive", () => {
  it("a soft-released ancestor survives until its descendant's call is decided", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const app = a.svc.createContext("app-instance", { owner: "alice" }, account);
    a.svc.derive(account, "res", app, "res", ["exec"]);
    const run = a.svc.createContext("agent-run", { owner: "alice" }, app);
    a.svc.derive(app, "res", run, "res", ["exec"]);

    const out = (await a.svc.bind(run).request("res", "exec", { command: "deploy" })) as {
      pendingCallId: string;
    };
    // Both the run AND the app release while the human is still deciding.
    a.svc.destroyContext(run, { deferWhilePending: true });
    a.svc.destroyContext(app, { deferWhilePending: true });
    expect(a.svc.contextIsLive(run)).toBe(true);
    expect(a.svc.contextIsLive(app)).toBe(true);

    expect((await a.svc.approve(out.pendingCallId, "alice")).status).toBe("succeeded");
    expect(hits).toEqual(["alice:exec:deploy"]);
    // Once decided, both deferred teardowns land.
    a.svc.listPending("alice");
    expect(a.svc.contextIsLive(run)).toBe(false);
    expect(a.svc.contextIsLive(app)).toBe(false);
  });

  it("a hard destroy of an ancestor expires the descendant's call immediately", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const app = a.svc.createContext("app-instance", {}, account);
    a.svc.derive(account, "res", app, "res", ["exec"]);
    const run = a.svc.createContext("agent-run", {}, app);
    a.svc.derive(app, "res", run, "res", ["exec"]);
    const out = (await a.svc.bind(run).request("res", "exec", { command: "deploy" })) as {
      pendingCallId: string;
    };
    a.svc.destroyContext(app); // the App closed: everything under it is over
    expect(a.svc.pendingState(out.pendingCallId)).toBe("expired");
    expect((await a.svc.approve(out.pendingCallId, "alice")).status).toBe("denied");
    expect(hits).toHaveLength(0);
  });
});

describe("audit is durable and linked", () => {
  it("one dangerous call leaves a linked trail across a restart", async () => {
    const a = boot();
    const account = a.svc.createContext("account-authority", { owner: "alice" });
    a.svc.mintRoot(account, "res", "device:alice", ["exec"]);
    const out = (await a.svc.bind(account).request("res", "exec", { command: "deploy" })) as {
      pendingCallId: string;
    };
    a.repo.close();

    const b = boot();
    await b.svc.approve(out.pendingCallId, "alice");
    const trail = b.repo.auditFor(out.pendingCallId).map((r) => r.event);
    expect(trail).toContain("pending_created");
    expect(trail).toContain("claimed");
    expect(trail).toContain("approved");
    expect(trail).toContain("executed");
    expect(b.repo.auditFor(out.pendingCallId).some((r) => r.outcome === "succeeded")).toBe(true);
  });
});

describe("audit retention: no routine reads, bounded age, small steps", () => {
  const DAY = 24 * 3600_000;

  /** Read/observe/modify on one Object; "boom" fails, "forbidden" is denied by policy. */
  function sensor(): ObjectDefinition<string> {
    return {
      id: "sensor:alice",
      kind: "sensor",
      binding: "alice",
      metadata: { owner: "alice" },
      operations: {
        look: { args: { path: { type: "string", required: true } }, effect: "observe" },
        read: { args: { path: { type: "string", required: true } }, effect: "read" },
        write: { args: { path: { type: "string", required: true } }, effect: "modify" },
      },
      policy: (i) => (i.args.path === "forbidden" ? { kind: "deny", reason: "no" } : { kind: "allow" }),
      adapter: async (_b, _operation, args) => {
        if (args.path === "boom") throw new Error("device said no");
        return { ok: true };
      },
    };
  }

  function legacy(seq: number, at: number, o: Partial<{ event: "invoked" | "executed" | "denied"; operation: string;
    objectId: string; outcome: "succeeded" | "failed"; pendingCallId: string }> = {}) {
    return {
      event: o.event ?? "executed",
      at: new Date(at).toISOString(),
      contextId: `ctx-${seq}`,
      contextKind: "request",
      contextMetadata: { owner: "alice" },
      ancestry: [],
      slot: "s",
      capabilityId: "cap",
      objectId: o.objectId ?? "sensor:alice",
      operation: o.operation ?? "read",
      argsHash: "h",
      decision: o.event === "denied" ? ("deny" as const) : ("allow" as const),
      ...(o.event === "invoked" || o.event === "denied" ? {} : { outcome: o.outcome ?? "succeeded" }),
      ...(o.pendingCallId ? { pendingCallId: o.pendingCallId } : {}),
    };
  }

  it("keeps denials, failures and changes durable, but not successful unattended reads", async () => {
    const repo = new SqliteCapabilityStore(file);
    repos.push(repo);
    const seen: string[] = [];
    const svc = new CapabilityService({ store: repo, audit: (r) => seen.push(`${r.event}:${r.operation}`) });
    svc.registerObject(sensor());
    const ctx = svc.createContext("account-authority", { owner: "alice" });
    svc.mintRoot(ctx, "s", "sensor:alice", ["look", "read", "write"], { autoAllow: ["look", "read", "write"] });
    const facade = svc.bind(ctx);

    expect((await facade.request("s", "read", { path: "/a" })).status).toBe("succeeded");
    expect((await facade.request("s", "look", { path: "/a" })).status).toBe("succeeded");
    expect((await facade.request("s", "read", { path: "boom" })).status).toBe("failed");
    expect((await facade.request("s", "read", { path: "forbidden" })).status).toBe("denied");
    expect((await facade.request("s", "write", { path: "/a" })).status).toBe("succeeded");

    const durable = repo.auditPage(0, 100).map((r) => `${r.event}:${r.operation}:${r.outcome ?? r.decision}`);
    expect(durable).toEqual([
      "executed:read:failed",
      "denied:read:deny",
      "invoked:write:allow",
      "executed:write:succeeded",
    ]);
    // The sink is told everything, including the reads the file no longer keeps.
    expect(seen.filter((e) => e.endsWith(":read") || e.endsWith(":look"))).toHaveLength(7);
  });

  it("walks the whole trail once in bounded pages, then only trims the oldest end", () => {
    let now = Date.parse("2026-10-15T00:00:00.000Z");
    const repo = new SqliteCapabilityStore(file, { now: () => now });
    repos.push(repo);
    const svc = new CapabilityService({ store: repo, now: () => now });
    svc.registerObject(sensor());
    const rows = [
      legacy(1, now - 40 * DAY, { operation: "write" }), // expired change
      legacy(2, now - 2 * DAY, { event: "invoked" }), // routine read an older version recorded
      legacy(3, now - 2 * DAY), // ...and its outcome
      legacy(4, now - 2 * DAY, { operation: "write" }), // a change: kept
      legacy(5, now - 2 * DAY, { outcome: "failed" }), // a failure: kept
      legacy(6, now - 2 * DAY, { event: "denied" }), // a denial: kept
      legacy(7, now - 2 * DAY, { pendingCallId: "pc_1" }), // approved read: kept
      legacy(8, now - 1 * DAY, { objectId: "gone:bob" }), // unknown Object: kept until it ages out
      legacy(9, now - 1 * DAY, { operation: "look" }), // routine observe
    ];
    for (const r of rows) repo.appendAudit(r);

    const steps: number[] = [];
    while (svc.pruneAudit(now - 30 * DAY, 2)) steps.push(repo.auditPage(0, 100).length);
    // Five pages of two rows: every row was looked at, at most two per step.
    expect(steps).toHaveLength(4);
    expect(repo.auditPage(0, 100).map((r) => r.seq)).toEqual([4, 5, 6, 7, 8]);

    // Later, the oldest kept rows expire: only the head is trimmed, a page at
    // a time, and a page that is not entirely expired ends the step sequence.
    now += 29 * DAY;
    expect(svc.pruneAudit(now - 30 * DAY, 2)).toBe(true);
    expect(svc.pruneAudit(now - 30 * DAY, 2)).toBe(true);
    expect(svc.pruneAudit(now - 30 * DAY, 2)).toBe(false);
    expect(repo.auditPage(0, 100).map((r) => r.seq)).toEqual([8]);
  });
});
