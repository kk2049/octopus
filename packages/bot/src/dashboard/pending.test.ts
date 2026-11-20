/**
 * The trusted approval face, over real HTTP against a real WebSocket Runner.
 *
 * The interesting assertions are the negative ones: what the panel refuses,
 * and — every time — whether the laptop received a frame.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { startFakeRunner, type FakeRunner } from "../runner/fake-runner.helper.js";
import { narrowOwnSessionAppend } from "../permissions/session-hub-terms.helper.js";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let dash: DashboardServer;
let base: string;
let alice: FakeRunner;
let bob: FakeRunner;
let dtAlice: string;
let dtBob: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pend-"));
  store = new Store(join(dir, "t.db"));
  for (const [u, uid] of [["alice", 5001], ["bob", 5002]] as const) {
    store.saveUser({ username: u, uid, home_dir: `/x/${u}`, created_at: NOW });
    store.saveRunnerToken(hashRunnerToken(`rt_${u}`), u, "laptop", NOW);
  }
  dtAlice = mintDashboardToken(store, "alice");
  dtBob = mintDashboardToken(store, "bob");
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  caps = new RunnerCapabilities(store, gateway.claimTransport());
  // The approval face needs cards; since O1 a script's append to one's own
  // session only queues one when the owner narrowed the default-silent term.
  narrowOwnSessionAppend(store, caps, "alice");
  narrowOwnSessionAppend(store, caps, "bob");
  alice = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
    append_session: (a) => ({ ok: true, id: a.id }),
    list_recent_sessions: () => ({ total_found: 1, sessions: [{ id: "alice-secret" }] }),
  });
  bob = await startFakeRunner(gateway.port, "rt_bob", "laptop", {
    append_session: (a) => ({ ok: true, id: a.id }),
    list_recent_sessions: () => ({ total_found: 1, sessions: [{ id: "bob-secret" }] }),
  });
  dash = createDashboardTestServer(store, caps, {
    port: 0,
    host: "127.0.0.1",
    authToken: "admin-secret",
  });
  await dash.start();
  base = `http://127.0.0.1:${dash.port}`;
});

afterAll(async () => {
  alice.close();
  bob.close();
  await dash.stop();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function browser(dt: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: dt }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `octopus_sess=${/octopus_sess=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /octopus_csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

async function queueAppend(dt: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/sessions/append`, {
    method: "POST",
    headers: { authorization: `Bearer ${dt}`, "content-type": "application/json" },
    body: JSON.stringify({ username, device: "laptop", id: "s1", prompt: "继续" }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { pending_call_id: string }).pending_call_id;
}

describe("dashboard approval face", () => {
  it("auto-allows each owner's own interactive browser submit, but not a raw bearer", async () => {
    const a = await browser(dtAlice);
    const before = alice.frames.length;
    const direct = await fetch(`${base}/api/sessions/append`, {
      method: "POST",
      headers: {
        cookie: a.cookie,
        "content-type": "application/json",
        "x-csrf-token": a.csrf,
        origin: base,
      },
      body: JSON.stringify({ username: "alice", device: "laptop", id: "s-direct", prompt: "直接继续" }),
    });
    expect(direct.status).toBe(200);
    expect(alice.frames.length).toBe(before + 1);

    // Resume has a distinct permission/audit identity even though the Runner
    // intentionally executes it through the same append_session method.
    const resumed = await fetch(`${base}/api/sessions/append`, {
      method: "POST",
      headers: {
        cookie: a.cookie,
        "content-type": "application/json",
        "x-csrf-token": a.csrf,
        origin: base,
      },
      body: JSON.stringify({
        username: "alice",
        device: "laptop",
        id: "s-resume",
        prompt: "恢复执行",
        operation: "resume_session",
      }),
    });
    expect(resumed.status).toBe(200);
    expect(alice.frames.length).toBe(before + 2);

    // With the append term narrowed, the same owner via a raw bearer still
    // produces a frozen approval card.
    const pendingId = await queueAppend(dtAlice, "alice");
    expect(alice.frames.length).toBe(before + 2);
    expect(caps.reject(pendingId, "alice")).toBe(true);

    // The current owner-local policy is the default for every account, not a
    // deployment allow-list. Bob's browser may act only on Bob's own device.
    const b = await browser(dtBob);
    const bobBefore = bob.frames.length;
    const bobDirect = await fetch(`${base}/api/sessions/append`, {
      method: "POST",
      headers: {
        cookie: b.cookie,
        "content-type": "application/json",
        "x-csrf-token": b.csrf,
        origin: base,
      },
      body: JSON.stringify({ username: "bob", device: "laptop", id: "s1", prompt: "继续" }),
    });
    expect(bobDirect.status).toBe(200);
    expect(bob.frames.length).toBe(bobBefore + 1);
  });

  it("shows a server-authored card only to the device owner", async () => {
    const id = await queueAppend(dtAlice, "alice");
    const mine = (await (
      await fetch(`${base}/api/capabilities/pending`, { headers: { authorization: `Bearer ${dtAlice}` } })
    ).json()) as { pending: Array<{ id: string; target: string; details: string[] }> };
    expect(mine.pending.map((p) => p.id)).toContain(id);
    expect(mine.pending[0].target).toBe("alice/laptop");
    expect(mine.pending[0].details.join(" ")).toContain("继续");

    const theirs = (await (
      await fetch(`${base}/api/capabilities/pending`, { headers: { authorization: `Bearer ${dtBob}` } })
    ).json()) as { pending: unknown[] };
    expect(theirs.pending).toHaveLength(0);

    // The shared admin key names no person, so it has no queue at all.
    const adminQ = await fetch(`${base}/api/capabilities/pending`, { headers: { authorization: "Bearer admin-secret" } });
    expect(adminQ.status).toBe(403);

    // Clean up so later cases start from a known state.
    expect(caps.reject(id, "alice")).toBe(true);
  });

  it("another user cannot approve, and the laptop stays untouched", async () => {
    const before = alice.frames.length;
    const id = await queueAppend(dtAlice, "alice");
    const b = await browser(dtBob);
    const res = await fetch(`${base}/api/capabilities/pending/${id}/approve`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(alice.frames.length).toBe(before);
    expect(caps.reject(id, "alice")).toBe(true);
  });

  it("the /pending page is server-rendered and needs an account", async () => {
    const page = await fetch(`${base}/pending`, { headers: { authorization: `Bearer ${dtAlice}` } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("待批准");
    // The panel never renders caller-supplied HTML: the only dynamic content
    // arrives via the JSON API and is escaped client-side.
    expect(html).not.toContain("<script>alert");
    const shared = await fetch(`${base}/pending`, { headers: { authorization: "Bearer admin-secret" } });
    expect(shared.status).toBe(403);
    // The refusal says what is wrong and what to do — not "invalid key" — and
    // the form returns to the queue once the person signs in as themselves.
    const refused = readBootstrapPayload(await shared.text());
    expect(refused.pageProps).toMatchObject({ rejected: true, next: "/pending" });
    expect((refused.pageProps as { reason: string }).reason).toMatch(/共享管理密钥不代表任何人.*本人的登录密钥/);
    expect((refused.pageProps as { reason: string }).reason).not.toMatch(/密钥无效|顶替/);

    // The approval affordance is a shell pill/drawer, not a navigation
    // destination, and it exists only for a real browser session — a bearer
    // proves a credential exists somewhere, not that a person is present.
    const a = await browser(dtAlice);
    const shell = readBootstrapPayload(
      await (await fetch(`${base}/pending`, { headers: { cookie: a.cookie } })).text(),
    );
    expect(shell.approvals).toBe(true);
    expect(shell.nav.map((tab) => tab.path)).not.toContain("/pending");
    const bearer = readBootstrapPayload(
      await (await fetch(`${base}/pending`, { headers: { authorization: `Bearer ${dtAlice}` } })).text(),
    );
    expect(bearer.approvals).toBe(false);
  });

  it("admins get presence for another user's device, never their session data", async () => {
    const check = await fetch(`${base}/api/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
      body: JSON.stringify({ username: "bob", device: "laptop" }),
    });
    if (check.status === 200) {
      const body = (await check.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("sessions_visible");
    }
    // And an admin browsing bob's sessions gets no Runner source at all.
    const list = (await (
      await fetch(`${base}/api/sessions?username=bob`, { headers: { authorization: "Bearer admin-secret" } })
    ).json()) as { sources: Array<{ kind: string }>; sessions: Array<{ id: string }> };
    expect(list.sources.filter((s) => s.kind === "runner")).toHaveLength(0);
    expect(JSON.stringify(list.sessions)).not.toContain("bob-secret");
  });

  it("with the capability service unavailable it fails closed, never onto a raw path", async () => {
    const before = alice.frames.length;
    const blind = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "admin-secret" });
    await blind.start();
    const blindBase = `http://127.0.0.1:${blind.port}`;
    try {
      const append = await fetch(`${blindBase}/api/sessions/append`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
        body: JSON.stringify({ username: "alice", device: "laptop", id: "s1", prompt: "x" }),
      });
      expect(append.status).toBe(503);
      const list = (await (
        await fetch(`${blindBase}/api/sessions`, { headers: { authorization: `Bearer ${dtAlice}` } })
      ).json()) as { sources: Array<{ kind: string }> };
      expect(list.sources.filter((s) => s.kind === "runner")).toHaveLength(0);
      // The gateway is still up and the device still connected — the point is
      // that nothing reached it without a capability service to go through.
      expect(alice.frames.length).toBe(before);
    } finally {
      await blind.stop();
    }
  });

  it("a user's own session list does come from their Runner", async () => {
    const list = (await (
      await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${dtAlice}` } })
    ).json()) as { sources: Array<{ kind: string }>; sessions: Array<{ id: string }> };
    expect(list.sources.some((s) => s.kind === "runner")).toBe(true);
    expect(list.sessions.map((s) => s.id)).toContain("alice-secret");
  });
});
