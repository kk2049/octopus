/**
 * The multi-user negative matrix, over real HTTP against a real Store, a real
 * capability kernel and a fake Runner transport that COUNTS FRAMES.
 *
 * Every "Bob cannot" case asserts two things, and the second is the one that
 * matters: the status code, and that nothing reached the transport. A 403 that
 * arrives after the frame went out is not a denial — it is a report.
 *
 * Ownership, enumeration, grant, revoke, append binding, and the UI/API
 * consistency rules from the execution plan's §11 all live here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readBootstrapPayload } from "../dashboard/app-page.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "../dashboard/server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { narrowOwnSessionAppend } from "./session-hub-terms.helper.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { appAgentAdapterAllowed, resetDeploymentProfile, setDeploymentProfile } from "@claude-bot/engine";

const NOW = "2026-07-31T10:00:00.000Z";
const ALICE_SESSION = "aaaa1111-2222-3333-4444-555566667777";
const BOB_SESSION = "bbbb1111-2222-3333-4444-555566667777";
const ADMIN_KEY = "admin-secret";

interface Frame {
  owner: string;
  operation: string;
  args: Record<string, unknown>;
}

function transportFor(frames: Frame[], online: Set<string>): RunnerTransport {
  return {
    dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ owner, operation, args });
      return { ok: true, devices: ["laptop"], sessions: [], results: [], scanned: 0 };
    },
    listDevices: (owner: string) =>
      online.has(owner) ? [{ device: "laptop", online: true, created_at: NOW, last_seen_at: NOW }] : [],
    isOnline: (owner: string) => online.has(owner),
    ping: async () => 3,
    disconnect: () => true,
  } as unknown as RunnerTransport;
}

/** A session transcript on the bot host, so the local source has something. */
function seedHome(root: string, sessionId: string, text: string): string {
  const proj = join(root, ".claude", "projects", "-work-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        sessionId,
        cwd: "/work/proj",
        timestamp: "2026-07-31T09:00:00.000Z",
        message: { role: "user", content: text },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-31T09:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
      }),
    ].join("\n"),
  );
  return root;
}

describe("permissions + session hub, multi-user", () => {
  let dir: string;
  let store: Store;
  let caps: RunnerCapabilities;
  let dash: DashboardServer;
  let base: string;
  let frames: Frame[];
  let online: Set<string>;
  let dtAlice: string;
  let dtBob: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "perm-e2e-"));
    const aliceHome = seedHome(join(dir, "alice"), ALICE_SESSION, "排查登录 bug");
    const bobHome = seedHome(join(dir, "bob"), BOB_SESSION, "bob 的私事");
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 7001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 7002, home_dir: "/x/b", created_at: NOW });
    store.saveUser({ username: "root", uid: 7003, home_dir: "/x/r", created_at: NOW });
    dtAlice = mintDashboardToken(store, "alice");
    dtBob = mintDashboardToken(store, "bob");
    frames = [];
    online = new Set(["alice", "bob"]);
    caps = new RunnerCapabilities(store, transportFor(frames, online));
    caps.mintDeviceToken("alice", "laptop");
    caps.mintDeviceToken("bob", "laptop");

    dash = createDashboardTestServer(store, caps, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN_KEY,
      adminUsers: ["root"],
      runnerWsPort: 9910,
      scanHomeFor: (u) => (u === "alice" ? aliceHome : u === "bob" ? bobHome : undefined),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterEach(async () => {
    resetDeploymentProfile();
    await dash.stop();
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

  /** Log in for real: writes only work from a browser session + CSRF + Origin. */
  async function browser(token: string): Promise<{ cookie: string; csrf: string }> {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token }),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    return {
      cookie: `octopus_sess=${/octopus_sess=([0-9a-f]{64})/.exec(raw)![1]}`,
      csrf: /octopus_csrf=([0-9a-f]{64})/.exec(raw)![1],
    };
  }

  async function post(b: { cookie: string; csrf: string }, path: string, body: unknown): Promise<Response> {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify(body),
    });
  }

  /**
   * The owner's own appends are a default-on grant term (O1). The cases below
   * are about the approval lifecycle, so the owner narrows that one term —
   * which is exactly how a card for a script's append still arises.
   */
  function narrowOwnAppend(owner: string): void {
    narrowOwnSessionAppend(store, caps, owner);
  }

  /** A script may submit work, but cannot claim the browser-only self-service exception. */
  async function postBearer(token: string, path: string, body: unknown): Promise<Response> {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(body),
    });
  }

  /**
   * Wait for one submission to reach a terminal state.
   *
   * Execution is deliberately not tied to the request that started it any more,
   * so a test that wants to assert on frames has to wait for the RECORD — which
   * is also the only thing a browser has to go on.
   */
  async function settleOperation(
    b: { cookie: string; csrf: string },
    id: string,
    timeoutMs = 5000,
  ): Promise<{ status: string; detail?: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await fetch(`${base}/api/sessions/operations?limit=100`, { headers: { cookie: b.cookie } });
      const body = (await res.json()) as { operations: Array<{ id: string; status: string; live: boolean; detail?: string }> };
      const hit = body.operations.find((o) => o.id === id);
      if (hit && !hit.live) return hit;
      if (Date.now() > deadline) throw new Error(`operation ${id} never settled (last: ${hit?.status ?? "missing"})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const framesFor = (owner: string) => frames.filter((f) => f.owner === owner);

  /** The Session Hub's projected rows for whoever this token belongs to. */
  async function hubEntries(
    token: string,
  ): Promise<Array<{ operation: string; granted: boolean; effective: boolean; reasons: string[] }>> {
    const view = (await (await fetch(`${base}/api/permissions`, { headers: bearer(token) })).json()) as {
      subjects: Array<{
        id: string;
        permissions: { entries: Array<{ operation: string; granted: boolean; effective: boolean; reasons: string[] }> };
      }>;
    };
    return view.subjects.find((s) => s.id === "session-hub")!.permissions.entries;
  }

  // ── ownership and enumeration ──

  it("Alice lists and reads her own laptop; Bob's guesses reach zero frames", async () => {
    const mine = await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) });
    expect(mine.status).toBe(200);
    expect(framesFor("alice").some((f) => f.operation === "list_recent_sessions")).toBe(true);

    frames.length = 0;
    // Bob names Alice in the query string. The gate refuses before anything runs.
    const stolen = await fetch(`${base}/api/sessions?username=alice`, { headers: bearer(dtBob) });
    expect(stolen.status).toBe(403);
    // Guessing her session id does not help either.
    const read = await fetch(`${base}/api/session?username=alice&id=${ALICE_SESSION}&device=laptop`, {
      headers: bearer(dtBob),
    });
    expect(read.status).toBe(403);
    const live = await fetch(`${base}/api/sessions/live?username=alice&id=${ALICE_SESSION}`, {
      headers: bearer(dtBob),
    });
    expect(live.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  it("a resource handle for another owner is refused, not decoded into authority", async () => {
    const roster = (await (await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) })).json()) as {
      sessions: Array<{ resourceId: string; owner: string }>;
    };
    const handle = roster.sessions[0].resourceId;
    expect(roster.sessions[0].owner).toBe("alice");
    frames.length = 0;
    // Bob has the opaque handle (say, from a screenshot). It is a convenience,
    // never a credential: the server re-checks the owner inside it.
    const res = await fetch(`${base}/api/session?resource=${encodeURIComponent(handle)}`, { headers: bearer(dtBob) });
    expect(res.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  /**
   * The bot host is a RESOURCE, not a lobby.
   *
   * "Read across accounts" is a predicate about account material in general; it
   * was never a decision that an admin may read somebody's transcripts. Before
   * this, the local branch had no owner check at all — because the Runner branch
   * had one — so an admin naming Alice got her roster, her search hits and her
   * whole transcript off the bot host's disk.
   *
   * The assertion that matters is not the status code: it is that the roster is
   * EXPLICITLY restricted rather than incidentally empty, and that the
   * transcript endpoints refuse. An `expect(sessions.every(...))` over an empty
   * array passes for both, which is how the old version of this test kept
   * passing while proving nothing.
   */
  it("a named admin reads another account's sessions; the shared key and other users still get nothing", async () => {
    // Owner decision 2026-10-15: an administrator may read and act on any
    // account. The shared deployment key names nobody and keeps the old
    // explicit restriction; a plain user is refused at the route.
    const root = bearer(mintDashboardToken(store, "root"));
    const res = await fetch(`${base}/api/sessions?username=alice`, { headers: root });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: Array<{ sessionId: string }>; restricted?: unknown };
    expect(data.restricted).toBeUndefined();
    expect(data.sessions.map((row) => row.sessionId)).toContain(ALICE_SESSION);
    const transcript = await fetch(`${base}/api/session?username=alice&id=${ALICE_SESSION}&device=bot-host`, { headers: root });
    expect(transcript.status).toBe(200);
    expect(await transcript.text()).toContain("排查登录 bug");
    // The account's own activity record names who looked.
    const audit = store.listPermissionAudit("alice", { decision: "admin_access" });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.parse(audit[0]!.detail ?? "{}")).toEqual({ by: "root" });

    frames.length = 0;
    const shared = { authorization: `Bearer ${ADMIN_KEY}` };
    const restricted = (await (await fetch(`${base}/api/sessions?username=alice`, { headers: shared })).json()) as {
      sessions: unknown[];
      restricted?: { reason: string };
    };
    expect(restricted.sessions).toEqual([]);
    expect(restricted.restricted?.reason).toBe("owner_only");
    for (const who of [shared, bearer(dtBob)]) {
      for (const path of [
        `/api/session?username=alice&id=${ALICE_SESSION}&device=bot-host`,
        `/api/sessions/search?username=alice&query=登录`,
        `/api/sessions/live?username=alice&id=${ALICE_SESSION}&device=bot-host`,
      ]) {
        const r = await fetch(`${base}${path}`, { headers: who });
        expect(r.status).toBe(403);
        expect(await r.text()).not.toContain("排查登录 bug");
      }
    }
    expect(frames).toHaveLength(0);
  });

  it("bot-host sessions still carry an owner and a device — they are not globally visible", async () => {
    const data = (await (await fetch(`${base}/api/sessions`, { headers: bearer(dtBob) })).json()) as {
      sessions: Array<{ owner: string; deviceId: string; sessionId: string }>;
    };
    for (const s of data.sessions) expect(s.owner).toBe("bob");
    expect(data.sessions.map((s) => s.sessionId)).not.toContain(ALICE_SESSION);
  });

  it("an absolute path on the bot host is not part of the answer", async () => {
    const raw = await (await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) })).text();
    // The source list used to carry `home`, the scan root's absolute path — a
    // field the page never rendered and every caller received.
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain("/.claude/");
  });

  it("a named admin may append to another account's session; a plain user may not", async () => {
    const b = await browser(mintDashboardToken(store, "root"));
    frames.length = 0;
    const res = await post(b, "/api/sessions/append", {
      username: "alice",
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "管理员代为继续",
    });
    expect(res.status).toBe(200);
    const sent = frames.filter((f) => f.operation === "append_session");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.owner).toBe("alice");
    expect(caps.listPending("alice")).toHaveLength(0);
    const audit = store.listPermissionAudit("alice", { decision: "admin_access" });
    expect(audit.some((row) => JSON.parse(row.detail ?? "{}").by === "root")).toBe(true);

    const bob = await browser(dtBob);
    frames.length = 0;
    const refused = await post(bob, "/api/sessions/append", {
      username: "alice",
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "以她的名义",
    });
    expect(refused.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  // ── grant and revoke ──

  it("serves one server-authored map and applies only the frozen owner proposal", async () => {
    const first = await fetch(`${base}/api/permissions/studio`, { headers: bearer(dtAlice) });
    expect(first.status).toBe(200);
    const studio = (await first.json()) as {
      version: number;
      username: string;
      permits: Array<{ id: string; mode: string; editable: boolean; verdict: string }>;
    };
    expect(studio).toMatchObject({ version: 2, username: "alice" });
    expect(studio.permits.find((permit) => permit.id === "cross-user:alice:bob:history")).toMatchObject({
      mode: "ask",
      editable: false,
      verdict: expect.stringContaining("没有 ACL 行"),
    });

    const adminView = (await (await fetch(`${base}/api/permissions/studio?username=alice`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    })).json()) as { permits: Array<{ id: string; editable: boolean }> };
    expect(adminView.permits.find((permit) => permit.id === "generic:service:session-hub:search_sessions")?.editable)
      .toBe(false);

    const alice = await browser(dtAlice);
    frames.length = 0;
    const explained = await post(alice, "/api/permissions/studio/explain", {
      username: "alice",
      resource_id: "studio:runner-account:alice",
      holder_id: "service:session-hub",
      operation: "search_sessions",
      proposed_mode: "deny",
    });
    expect(explained.status).toBe(200);
    const proposal = (await explained.json()) as { proposal_id: string; steps: unknown[] };
    expect(proposal.proposal_id).toBeTruthy();
    expect(proposal.steps).toHaveLength(4);
    expect(frames).toHaveLength(0); // EXPLAIN is side-effect free at the execution boundary.

    const forged = await post(alice, "/api/permissions/studio/apply", {
      username: "alice",
      proposal_id: "not-a-real-proposal",
      // Policy coordinates are ignored even if a malicious client adds them.
      resource_id: "studio:runner-account:bob",
      operation: "append_session",
    });
    expect(await forged.json()).toMatchObject({ status: "refused" });

    const applied = await post(alice, "/api/permissions/studio/apply", {
      username: "alice",
      proposal_id: proposal.proposal_id,
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ status: "applied" });
    const legacy = (await (await fetch(`${base}/api/permissions`, { headers: bearer(dtAlice) })).json()) as {
      subjects: Array<{ id: string; permissions: { entries: Array<{ operation: string; granted: boolean }> } }>;
    };
    expect(legacy.subjects.find((subject) => subject.id === "session-hub")!.permissions.entries
      .find((entry) => entry.operation === "search_sessions")?.granted).toBe(false);

    frames.length = 0;
    const bob = await browser(dtBob);
    const crossOwner = await post(bob, "/api/permissions/studio/explain", {
      username: "alice",
      resource_id: "studio:runner-account:alice",
      holder_id: "service:session-hub",
      operation: "read_session",
      proposed_mode: "allow",
    });
    expect(crossOwner.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  it("requested is not granted: revoking the hub grant stops reads reaching the laptop", async () => {
    const b = await browser(dtAlice);
    // Bootstrap happened on first use; confirm it is visible AND marked as such.
    const before = (await (await fetch(`${base}/api/permissions`, { headers: bearer(dtAlice) })).json()) as {
      subjects: Array<{ id: string; grant: { source: string } | null; permissions: { effectiveCount: number } }>;
    };
    const hub = before.subjects.find((s) => s.id === "session-hub")!;
    expect(hub.grant!.source).toBe("bootstrap");
    expect(hub.permissions.effectiveCount).toBeGreaterThan(0);

    const revoked = await post(b, "/api/permissions/revoke", { subject_type: "service", subject_id: "session-hub" });
    expect(revoked.status).toBe(200);

    frames.length = 0;
    const after = await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) });
    expect(after.status).toBe(200);
    expect(framesFor("alice")).toHaveLength(0); // the laptop hears nothing

    const view = (await after.json()) as {
      sessions: unknown[];
      restricted?: { reason: string };
      permissions: { effective: string[]; reasons: Record<string, string[]> };
    };
    expect(view.permissions.effective).toEqual([]);
    expect(view.permissions.reasons.read_session).toContain("revoked");
    // AND the bot host stops answering. This is the half that used to survive a
    // revocation: the local branch was a direct filesystem read with no grant
    // behind it, so "撤销" closed the laptop and left the server's own copy of
    // the same transcripts readable.
    expect(view.sessions).toEqual([]);
    expect(view.restricted?.reason).toBe("not_granted");
  });

  it("a revoked grant closes the bot host too — list, read, search and live", async () => {
    const b = await browser(dtAlice);
    // Everything works first, from the bot host specifically (device=bot-host).
    expect((await fetch(`${base}/api/session?id=${ALICE_SESSION}&device=bot-host`, { headers: bearer(dtAlice) })).status)
      .toBe(200);

    await post(b, "/api/permissions/revoke", { subject_type: "service", subject_id: "session-hub" });

    frames.length = 0;
    for (const path of [
      `/api/session?id=${ALICE_SESSION}&device=bot-host`,
      `/api/sessions/search?query=登录`,
      `/api/sessions/live?id=${ALICE_SESSION}&device=bot-host`,
    ]) {
      const r = await fetch(`${base}${path}`, { headers: bearer(dtAlice) });
      expect(r.status).toBe(403);
      const body = await r.text();
      expect(body).not.toContain("排查登录 bug");
      expect(body).toMatch(/撤销/); // the reason, from the projection, not invented here
    }
    expect(frames).toHaveLength(0);
  });

  it("narrowing to list_sessions stops bot-host reads as well as laptop reads", async () => {
    const b = await browser(dtAlice);
    await post(b, "/api/permissions/grant", {
      subject_type: "service",
      subject_id: "session-hub",
      operations: ["list_sessions"],
    });
    // Listing still works and still includes the bot host…
    const roster = (await (await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) })).json()) as {
      sessions: Array<{ deviceId: string }>;
    };
    expect(roster.sessions.some((s) => s.deviceId === "bot-host")).toBe(true);
    // …and reading one of them does not.
    const read = await fetch(`${base}/api/session?id=${ALICE_SESSION}&device=bot-host`, { headers: bearer(dtAlice) });
    expect(read.status).toBe(403);
  });

  it("narrowing takes effect immediately and needs no re-consent", async () => {
    const b = await browser(dtAlice);
    const res = await post(b, "/api/permissions/grant", {
      subject_type: "service",
      subject_id: "session-hub",
      operations: ["list_sessions"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diff: { removed: string[]; added: string[] } };
    expect(body.diff.removed).toContain("read_session");
    expect(body.diff.added).toEqual([]);

    frames.length = 0;
    await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) });
    expect(framesFor("alice").map((f) => f.operation)).toEqual(["list_recent_sessions"]);

    frames.length = 0;
    await fetch(`${base}/api/sessions/search?query=登录`, { headers: bearer(dtAlice) });
    expect(framesFor("alice")).toHaveLength(0);
  });

  /**
   * Removing the last laptop removes what only a laptop can back — and the two
   * resources are separate roots, so it says so per operation rather than
   * collapsing the account to zero.
   *
   * `append_session` is the interesting row: the bot host declares no such
   * operation (there is no CLI there to drive), so it reports
   * `account_lacks_operation` rather than the blanket `device_revoked`. Those
   * are different sentences and they mean different things to do about it.
   */
  it("removing the last device removes exactly what only the device could back", async () => {
    await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) }); // bootstrap
    caps.revokeDeviceToken("alice", "laptop");
    online.delete("alice");
    const entries = await hubEntries(dtAlice);
    for (const e of entries) {
      expect(e.granted).toBe(true); // the intent is untouched throughout
      if (e.operation === "append_session" || e.operation === "resume_session") {
        expect(e.effective).toBe(false);
        expect(e.reasons).toContain("account_lacks_operation");
      } else {
        // The bot host is a second resource with its own root; it did not lose
        // anything when a laptop was unregistered.
        expect(e.effective).toBe(true);
      }
    }
    // And appending really is refused, with nothing on the wire.
    const b = await browser(dtAlice);
    frames.length = 0;
    const res = await post(b, "/api/sessions/append", { device: "laptop", id: ALICE_SESSION, prompt: "x" });
    expect(res.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  it("no device and no scan home = device_revoked on every row", async () => {
    // `root` has no `scanHomeFor` entry in this harness, so once its device is
    // gone the account backs nothing at all — which is the sentence the blanket
    // reason exists for.
    const dtRoot = mintDashboardToken(store, "root");
    caps.mintDeviceToken("root", "box");
    online.add("root");
    await fetch(`${base}/api/sessions`, { headers: bearer(dtRoot) }); // bootstrap
    caps.revokeDeviceToken("root", "box");
    online.delete("root");
    for (const e of await hubEntries(dtRoot)) {
      expect(e.granted).toBe(true);
      expect(e.effective).toBe(false);
      expect(e.reasons).toContain("device_revoked");
    }
  });

  it("a bot-host-only account works with no device ever registered", async () => {
    // `bob` has a scan home; take his laptop away entirely. Listing and reading
    // his own sessions must keep working — a deployment that scans a local home
    // and registers no endpoint is an ordinary install, not a degraded one.
    caps.revokeDeviceToken("bob", "laptop");
    online.delete("bob");
    const roster = (await (await fetch(`${base}/api/sessions`, { headers: bearer(dtBob) })).json()) as {
      sessions: Array<{ sessionId: string; deviceId: string; resumable: boolean }>;
      restricted?: unknown;
    };
    expect(roster.restricted).toBeUndefined();
    expect(roster.sessions.map((s) => s.sessionId)).toContain(BOB_SESSION);
    expect(roster.sessions.every((s) => s.deviceId === "bot-host" && !s.resumable)).toBe(true);
    const read = await fetch(`${base}/api/session?id=${BOB_SESSION}&device=bot-host`, { headers: bearer(dtBob) });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("bob 的私事");
    expect((await fetch(`${base}/api/sessions/search?query=私事`, { headers: bearer(dtBob) })).status).toBe(200);
  });

  it("Bob cannot grant or revoke on Alice's account", async () => {
    const b = await browser(dtBob);
    for (const path of ["/api/permissions/grant", "/api/permissions/revoke"]) {
      const res = await post(b, path, {
        username: "alice",
        subject_type: "service",
        subject_id: "session-hub",
        operations: ["read_session", "append_session"],
      });
      expect(res.status).toBe(403);
    }
    // And Alice's grant is exactly as it was.
    const view = (await (await fetch(`${base}/api/permissions`, { headers: bearer(dtAlice) })).json()) as {
      subjects: Array<{ id: string; grant: { source: string } | null }>;
    };
    expect(view.subjects.find((s) => s.id === "session-hub")!.grant!.source).toBe("bootstrap");
  });

  it("a bearer token cannot grant, revoke or approve — those need a real browser", async () => {
    for (const path of ["/api/permissions/grant", "/api/permissions/revoke"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: bearer(dtAlice),
        body: JSON.stringify({ subject_type: "service", subject_id: "session-hub", operations: [] }),
      });
      // The mutation gate lets an explicit Authorization header through (it is
      // not a credential the environment attaches), so this is a real write —
      // what a bearer must NOT do is approve, which is checked below.
      expect([200, 403]).toContain(res.status);
    }
    const approve = await fetch(`${base}/api/capabilities/pending/whatever/approve`, {
      method: "POST",
      headers: bearer(dtAlice),
      body: "{}",
    });
    expect(approve.status).toBe(403);
  });

  it("the permission centre never leaks a token, a capability id or a transcript path", async () => {
    const raw = await (await fetch(`${base}/api/permissions`, { headers: bearer(dtAlice) })).text();
    expect(raw).not.toMatch(/dt_[0-9a-f]{8}/);
    expect(raw).not.toMatch(/contextId|capabilityId|token_hash/);
    const sessions = await (await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) })).text();
    expect(sessions).not.toContain(".jsonl");
    const one = await (
      await fetch(`${base}/api/session?id=${ALICE_SESSION}&device=bot-host`, { headers: bearer(dtAlice) })
    ).text();
    expect(one).not.toContain(".jsonl");
  });

  // ── append / resume ──

  it("the owner's own append runs directly from the browser and from a script (O1)", async () => {
    const b = await browser(dtAlice);
    frames.length = 0;
    const direct = await post(b, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "本人直接继续",
    });
    expect(direct.status).toBe(200);
    const scripted = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "本人脚本继续",
    });
    expect(scripted.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(2);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("with the term narrowed, the owner's bearer gets a bound approval nobody else can press", async () => {
    narrowOwnAppend("alice");
    const b = await browser(dtAlice);
    frames.length = 0;
    const direct = await post(b, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "本人直接继续",
    });
    expect(direct.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);

    // A raw bearer names the same owner, but proves neither a live browser nor
    // a person at the keyboard. It must retain the ordinary approval boundary.
    frames.length = 0;
    const res = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "脚本继续跑测试",
    });
    expect(res.status).toBe(202);
    const { pending_call_id: id } = (await res.json()) as { pending_call_id: string };
    expect(frames).toHaveLength(0); // nothing ran yet, and that is the point

    const card = caps.getPending(id, "alice")!;
    expect(card.target).toBe("alice/laptop");
    expect(card.details.join(" ")).toContain("脚本继续跑测试");
    // Bob cannot approve it, and the laptop still hears nothing.
    const bobB = await browser(dtBob);
    const stolen = await post(bobB, `/api/capabilities/pending/${id}/approve`, {});
    expect(stolen.status).toBe(403);
    expect(frames).toHaveLength(0);
  });

  it("a second, different instruction on the same session is refused while one waits", async () => {
    narrowOwnAppend("alice");
    const first = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "第一条",
    });
    expect(first.status).toBe(202);
    const second = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "第二条",
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/待批准/);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);
  });

  it("the identical instruction re-submitted joins the card that already exists", async () => {
    narrowOwnAppend("alice");
    const a1 = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "同一条",
    });
    const a2 = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "同一条",
    });
    expect(a1.status).toBe(202);
    expect(a2.status).toBe(202);
    const [p1, p2] = (await Promise.all([a1.json(), a2.json()])) as Array<{ pending_call_id: string }>;
    expect(p1.pending_call_id).toBe(p2.pending_call_id);
    expect(caps.listPending("alice")).toHaveLength(1);
  });

  it("approving runs it exactly once, on the device that was named", async () => {
    narrowOwnAppend("alice");
    const b = await browser(dtAlice);
    const res = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "跑吧",
    });
    const { pending_call_id: id, operation_id: opId } = (await res.json()) as {
      pending_call_id: string;
      operation_id: string;
    };
    frames.length = 0;
    // A session submission's approval starts execution in the BACKGROUND and
    // answers with the record to follow: holding this request open for the whole
    // CLI run is the failure the operation model exists to remove.
    const ok = await post(b, `/api/capabilities/pending/${id}/approve`, {});
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { operation_id: string }).operation_id).toBe(opId);
    const done = await settleOperation(b, opId);
    expect(done.status).toBe("succeeded");
    const sent = frames.filter((f) => f.operation === "append_session");
    expect(sent).toHaveLength(1);
    expect(sent[0].owner).toBe("alice");
    expect(sent[0].args).toMatchObject({ device: "laptop", id: ALICE_SESSION, prompt: "跑吧" });
    // Approving again returns the SAME recorded outcome and does not run it a
    // second time. That is exactly-once, and the frame count is the only place
    // it can be observed — the card is no longer live, so this falls through to
    // the ordinary replay path and answers with what was recorded.
    const replay = await post(b, `/api/capabilities/pending/${id}/approve`, {});
    expect(replay.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
  });

  it("revoking the grant kills an approval that was already queued", async () => {
    narrowOwnAppend("alice");
    const b = await browser(dtAlice);
    const res = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "别跑",
    });
    const { pending_call_id: id } = (await res.json()) as { pending_call_id: string };
    await post(b, "/api/permissions/revoke", { subject_type: "service", subject_id: "session-hub" });
    frames.length = 0;
    const approve = await post(b, `/api/capabilities/pending/${id}/approve`, {});
    expect(approve.status).not.toBe(200);
    expect(frames).toHaveLength(0);
  });

  it("appending to the bot host is refused: there is no runner to drive", async () => {
    const b = await browser(dtAlice);
    frames.length = 0;
    const res = await post(b, "/api/sessions/append", { device: "bot-host", id: ALICE_SESSION, prompt: "x" });
    expect(res.status).toBe(400);
    expect(frames).toHaveLength(0);
  });

  it("an empty prompt or a missing session is a 400, not a card", async () => {
    const b = await browser(dtAlice);
    for (const body of [
      { device: "laptop", id: ALICE_SESSION, prompt: "  " },
      { device: "laptop", id: "", prompt: "x" },
    ]) {
      const res = await post(b, "/api/sessions/append", body);
      expect(res.status).toBe(400);
    }
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  // ── web sessions ──

  it("logout-others ends other logins and leaves the current one working", async () => {
    const first = await browser(dtAlice);
    const second = await browser(dtAlice);
    const res = await post(second, "/api/permissions/web-sessions/revoke-others", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: number }).revoked).toBe(1);
    // The one that asked still works...
    const still = await fetch(`${base}/api/permissions`, { headers: { cookie: second.cookie } });
    expect(still.status).toBe(200);
    // ...and the other is out. (Falls back to the login page, not the API.)
    const gone = await fetch(`${base}/api/permissions`, { headers: { cookie: first.cookie } });
    expect(gone.status).not.toBe(200);
  });

  it("one specific login can be ended, by a handle that authenticates nothing", async () => {
    const first = await browser(dtAlice);
    const second = await browser(dtAlice);
    const list = (await (
      await fetch(`${base}/api/permissions/web-sessions`, { headers: { cookie: second.cookie } })
    ).json()) as { sessions: Array<{ sid: string; current: boolean; active: boolean }> };
    // The handle is a one-way derivation, never the row's token hash.
    for (const s of list.sessions) expect(s.sid).toMatch(/^[0-9a-f]{16}$/);
    const other = list.sessions.find((s) => !s.current && s.active)!;
    expect(await (await post(second, "/api/permissions/web-sessions/revoke", { sid: other.sid })).status).toBe(200);
    expect((await fetch(`${base}/api/permissions`, { headers: { cookie: first.cookie } })).status).not.toBe(200);
    expect((await fetch(`${base}/api/permissions`, { headers: { cookie: second.cookie } })).status).toBe(200);
  });

  /**
   * Owner-browser append no longer creates a card: the live browser session is
   * the presence proof. Ending that login therefore has to remove that proof,
   * while leaving another login's proof intact. Frame counts distinguish a
   * refusal from a request that ran and merely reported an error afterwards.
   */
  it("ending one login removes only its direct-submit authority", async () => {
    const doomed = await browser(dtAlice);
    const keeper = await browser(dtAlice);

    const initial = await post(doomed, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "撤销前直接提交",
    });
    expect(initial.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);

    const list = (await (
      await fetch(`${base}/api/permissions/web-sessions`, { headers: { cookie: keeper.cookie } })
    ).json()) as { sessions: Array<{ sid: string; current: boolean; active: boolean }> };
    const other = list.sessions.find((s) => !s.current && s.active)!;
    expect((await post(keeper, "/api/permissions/web-sessions/revoke", { sid: other.sid })).status).toBe(200);

    frames.length = 0;
    const refused = await post(doomed, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "已结束登录不得再提交",
    });
    expect(refused.status).not.toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);

    const accepted = await post(keeper, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "存活登录继续提交",
    });
    expect(accepted.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("logging out removes this login's direct-submit authority and leaves the other login alone", async () => {
    const leaving = await browser(dtAlice);
    const staying = await browser(dtAlice);

    const out = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie: leaving.cookie, "x-csrf-token": leaving.csrf, origin: base },
    });
    expect(out.status).toBe(200);

    frames.length = 0;
    const refused = await post(leaving, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "退出后不得提交",
    });
    expect(refused.status).not.toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);

    const accepted = await post(staying, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "另一登录仍可提交",
    });
    expect(accepted.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("ending a login closes the live stream it had open", async () => {
    const doomed = await browser(dtAlice);
    const keeper = await browser(dtAlice);
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/sessions/live?id=${ALICE_SESSION}&device=bot-host&from=0&frontier=0`, {
      headers: { cookie: doomed.cookie },
      signal: ac.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: delta")) buf += dec.decode((await reader.read()).value);

    const list = (await (
      await fetch(`${base}/api/permissions/web-sessions`, { headers: { cookie: keeper.cookie } })
    ).json()) as { sessions: Array<{ sid: string; current: boolean; active: boolean }> };
    const other = list.sessions.find((s) => !s.current && s.active)!;
    await post(keeper, "/api/permissions/web-sessions/revoke", { sid: other.sid });

    // The server ENDS it. "The next poll will deny" is true but leaves a page
    // that still looks connected, which is a page that looks authorised.
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      const chunk = await reader.read();
      if (chunk.done) closed = true;
      else buf += dec.decode(chunk.value);
      if (buf.includes("event: err")) closed = true;
    }
    expect(closed).toBe(true);
    expect(buf).toContain("实时流已断开");
    ac.abort();
  }, 15_000);

  it("revoking a device closes this account's streams and leases, and kills its cards", async () => {
    narrowOwnAppend("alice");
    const b = await browser(dtAlice);
    // The account bearer has no browser-presence exception, so it supplies a
    // real device-bound pending card for the teardown assertion below.
    const queued = await postBearer(dtAlice, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "先排队",
    });
    expect(queued.status).toBe(202);
    const { pending_call_id: id } = (await queued.json()) as { pending_call_id: string };

    expect((await post(b, "/api/runner-delete", { username: "alice", device: "laptop" })).status).toBe(200);
    online.delete("alice");

    frames.length = 0;
    expect((await post(b, `/api/capabilities/pending/${id}/approve`, {})).status).not.toBe(200);
    expect(frames).toHaveLength(0);
  });

  it("Bob cannot end Alice's logins, by name or by handle", async () => {
    const aliceB = await browser(dtAlice);
    const list = (await (
      await fetch(`${base}/api/permissions/web-sessions`, { headers: { cookie: aliceB.cookie } })
    ).json()) as { sessions: Array<{ sid: string }> };
    const b = await browser(dtBob);
    expect((await post(b, "/api/permissions/web-sessions/revoke-others", { username: "alice" })).status).toBe(403);
    // Naming Alice is refused; presenting HER handle as himself resolves to
    // nothing, because the lookup is scoped to the caller's own rows first.
    expect((await post(b, "/api/permissions/web-sessions/revoke", { sid: list.sessions[0].sid })).status).toBe(404);
    expect((await fetch(`${base}/api/permissions`, { headers: { cookie: aliceB.cookie } })).status).toBe(200);
  });

  // ── activity record ──

  it("the activity record shows the decision, and is scoped to its owner", async () => {
    const b = await browser(dtAlice);
    await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) });
    await post(b, "/api/permissions/grant", {
      subject_type: "service",
      subject_id: "session-hub",
      operations: ["list_sessions"],
    });
    const mine = (await (await fetch(`${base}/api/permissions/audit`, { headers: bearer(dtAlice) })).json()) as {
      records: Array<{ decision: string; owner: string; operation: string }>;
    };
    expect(mine.records.length).toBeGreaterThan(0);
    for (const r of mine.records) expect(r.owner).toBe("alice");
    expect(mine.records.map((r) => r.decision)).toContain("grant");

    const stolen = await fetch(`${base}/api/permissions/audit?username=alice`, { headers: bearer(dtBob) });
    expect(stolen.status).toBe(403);
  });

  it("the activity record pages to its oldest entry past the 500-row window", async () => {
    // A user with 620 events: the old route stopped at 500 with nothing past it.
    for (let index = 1; index <= 620; index += 1) {
      store.recordPermissionAudit({ at: NOW, owner: "root", subject_type: "service", subject_id: "session-hub",
        operation: `paged-${index}`, resource: "", decision: "allow", reason: null, detail: null });
    }
    const dtRoot = mintDashboardToken(store, "root");
    const seen: string[] = [];
    const cursors: Array<number | undefined> = [];
    let before: number | undefined;
    for (;;) {
      const page = (await (await fetch(`${base}/api/permissions/audit?limit=500${before ? `&before=${before}` : ""}`,
        { headers: bearer(dtRoot) })).json()) as { records: Array<{ id: number; operation: string }>; has_more: boolean; next_before?: number };
      seen.push(...page.records.map((row) => row.operation));
      cursors.push(page.next_before);
      if (!page.has_more) { expect(page.next_before).toBeUndefined(); break; }
      before = page.next_before;
    }
    const paged = seen.filter((operation) => operation.startsWith("paged-"));
    expect(paged).toHaveLength(620);
    expect(new Set(paged).size).toBe(620);
    expect(paged[0]).toBe("paged-620");
    expect(paged.at(-1)).toBe("paged-1");
    expect(cursors).toHaveLength(2);
    const bad = await fetch(`${base}/api/permissions/audit?before=abc`, { headers: bearer(dtRoot) });
    expect(bad.status).toBe(400);
  });

  // ── Dev Factory is described, not granted ──

  it("Dev Factory cannot be authorised through the permission centre", async () => {
    const b = await browser(dtAlice);
    const res = await post(b, "/api/permissions/grant", {
      subject_type: "service",
      subject_id: "dev-factory",
      operations: ["append_session"],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/没有消费 grant 行的执行路径/);
  });

  // ── only explicitly composed App/Agent subjects may have grant rows ──

  /**
   * The write path used to accept any `subject_type: "app" | "agent"` with any
   * id, store the row, and render it with checkboxes, counts and a revoke
   * button. Nothing read those rows, so the whole card was a security control
   * that controlled nothing, and unticking a box on it would have looked like
   * taking a permission away.
   *
   * Session Plus now wires one explicitly composed App to the Gate. That must
   * not turn the permission API into an open registry: an arbitrary id still
   * cannot create a row that no execution path consumes.
   */
  it("an App or Agent grant is refused rather than stored as an unenforced row", async () => {
    const b = await browser(dtAlice);
    for (const subject of [
      { subject_type: "app", subject_id: "reports" },
      { subject_type: "app", subject_id: "totally-made-up" },
      { subject_type: "agent", subject_id: "reports/writer" },
    ]) {
      const res = await post(b, "/api/permissions/grant", { ...subject, operations: ["read_session"] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/没有消费 grant 行的执行路径/);
      // Revoking is refused for the same reason: reporting a change that did
      // not happen is the same lie in the other direction.
      expect((await post(b, "/api/permissions/revoke", subject)).status).toBe(400);
    }
    // And no such subject appears on the screen afterwards.
    const view = (await (await fetch(`${base}/api/permissions`, { headers: bearer(dtAlice) })).json()) as {
      subjects: Array<{ id: string; type: string; enforced: boolean }>;
    };
    expect(view.subjects.map((s) => s.id)).toEqual(["session-hub"]);
    expect(view.subjects.find((s) => s.id === "session-hub")!.enforced).toBe(true);
  });

  it("the page is served for the account itself, and offers no disabled App", async () => {
    // Which subjects carry controls is decided by `enforced` / `editable` in the
    // API answer above, and rendered by a component test
    // (`packages/dashboard-web/src/pages/PermissionsPage.test.tsx`). What the
    // page still owes is: it is the permission page, it is scoped to this
    // account, and it does not invent a disabled App's tab.
    const page = await fetch(`${base}/permissions`, { headers: bearer(dtAlice) });
    const boot = readBootstrapPayload(await page.text());
    expect(boot.page).toBe("page.permissions");
    expect(boot.pageProps).toMatchObject({ owner: "alice", canEdit: true });
    // This fixture has Session Plus disabled, so it must not appear anywhere —
    // not as a navigation tab and not as a served page.
    expect(boot.nav.map((tab) => tab.path)).not.toContain("/sessions-plus");
    expect(boot.pages).not.toContain("page.sessionsPlus");
  });

  // ── SEC-06 regression: the ban is on the App adapter, not on the hub ──

  /**
   * The backlog asks for this explicitly (§4.4.6). SEC-06 forbids an ordinary
   * v3 App from choosing a coding CLI as its Agent backend; it says nothing
   * about a person operating the sessions already running on their own laptop.
   * A ban implemented by deleting `CliLoop`, or by refusing anything whose
   * name contains "claude", would break this whole block — so the block is the
   * evidence that it was implemented at the right layer.
   */
  it("the whole v2 sidebar surface still works under the strictest profile", async () => {
    setDeploymentProfile("cloud-multi-user");
    expect(appAgentAdapterAllowed("claude-code")).toBe(false); // the ban IS on

    // sidebar / list
    const roster = (await (await fetch(`${base}/api/sessions`, { headers: bearer(dtAlice) })).json()) as {
      sessions: Array<{ sessionId: string; resumable: boolean; cliKind: string }>;
    };
    expect(roster.sessions.length).toBeGreaterThan(0);
    // search
    expect((await fetch(`${base}/api/sessions/search?query=登录`, { headers: bearer(dtAlice) })).status).toBe(200);
    // read
    const read = await fetch(`${base}/api/session?id=${ALICE_SESSION}&device=bot-host`, { headers: bearer(dtAlice) });
    expect(read.status).toBe(200);
    // live (SSE opens; we only need the headers)
    const ac = new AbortController();
    const live = await fetch(`${base}/api/sessions/live?id=${ALICE_SESSION}&device=bot-host`, {
      headers: bearer(dtAlice),
      signal: ac.signal,
    });
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();
    // The strict App/Agent profile does not disable the owner's separate,
    // browser-bound Session Hub self-service path.
    const b = await browser(dtAlice);
    frames.length = 0;
    const appended = await post(b, "/api/sessions/append", { device: "laptop", id: ALICE_SESSION, prompt: "禁令不该碰我" });
    expect(appended.status).toBe(200);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  // ── the page itself ──

  it("the permissions page is server-rendered and needs an account", async () => {
    const page = await fetch(`${base}/permissions`, { headers: bearer(dtAlice) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("权限中心");
    // The three columns are rendered by the browser bundle and are pinned by a
    // component test; what the SERVER must get right is who this page is about
    // and that nothing about the credential leaks into the document.
    const boot = readBootstrapPayload(html);
    expect(boot.page).toBe("page.permissions");
    expect(boot.pageProps).toMatchObject({ owner: "alice" });
    expect(html).not.toContain(dtAlice);

    const shared = await fetch(`${base}/permissions`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(shared.status).toBe(403);
  });
});
