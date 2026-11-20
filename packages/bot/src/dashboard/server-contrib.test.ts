/**
 * The contributor tier end to end on a real DashboardServer (2026-08-20):
 * an admin creates a local account and hands over its key, the key logs in,
 * `contribute` opens the ticket workspace to the holder's OWN rows only, and
 * the review queue stays a member/maintainer surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DevPipeline } from "../devpipe/pipeline.js";
import { ContribReviewService, NO_FORGE_PUBLISHER } from "../devpipe/contrib-review.js";
import { BuildWarmer } from "../devpipe/build-warm.js";
import { gitOrThrow } from "../devpipe/worktree.js";
import { resolveCapabilityBits } from "../permissions/capability-bits.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";

const ADMIN = "admin-secret";

describe("contributor tier over HTTP", () => {
  let dir: string;
  let store: Store;
  let pipe: DevPipeline;
  let review: ContribReviewService;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let dtDora: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-contrib-"));
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    await gitOrThrow(repo, ["config", "user.email", "t@t"]);
    await gitOrThrow(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "# Repository source\n");
    await gitOrThrow(repo, ["add", "README.md"]);
    await gitOrThrow(repo, ["commit", "-m", "init"]);
    await gitOrThrow(repo, ["checkout", "-b", "live"]);
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
    store.saveUser({ username: "dora", uid: 2, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
    store.grantCapability("alice", "dev", "test", "2026-08-20T00:00:00.000Z");
    store.grantCapability("dora", "deploy", "test", "2026-08-20T00:00:00.000Z");
    dtAlice = mintDashboardToken(store, "alice");
    dtDora = mintDashboardToken(store, "dora");
    const resolveLane = (requester: string): "direct" | "review" =>
      resolveCapabilityBits({ username: requester, granted: store.listUserGrants(requester).map((g) => g.capability) }).dev
        ? "direct"
        : "review";
    pipe = new DevPipeline({
      pushRemote: null,
      store,
      repoDir: repo,
      worktreesDir: join(dir, "worktrees"),
      baseBranch: "main",
      // Turns never run in this suite: the pump is started but every ticket's
      // turn is a no-op reply, so rows stay `open` and nothing touches git.
      runTurn: async (_cwd, spec) => ({ ok: true, exit_code: 0, timed_out: false, duration_ms: 1, session_id: spec.sessionId ?? "s", result_text: "ok" }),
      gate: async () => ({ ok: true, log: "" }),
      knowledgeCaptureEnabled: false,
      landGateCheck: async () => ({ ok: true, log: "" }),
      buildWarmer: new BuildWarmer({ repoDir: repo, worktreesDir: join(dir, "worktrees"), park: async (d) => d, exec: async () => ({ ok: true, timedOut: false, log: "" }) }),
      mcpServerPath: "/nonexistent/mcp-server.js",
      sessionExists: () => false,
      resolveLane,
    });
    review = new ContribReviewService({ store, pipeline: pipe, publisher: NO_FORGE_PUBLISHER });
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: pipe,
      devScanHome: dir,
      contribReview: review,
      registerUser: async (username, identity) => {
        store.saveUser({ username, uid: 100 + store.loadUsers().length, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
        store.saveIdentity(username, { provider: identity.provider, externalId: identity.externalId, label: identity.label });
        return { username };
      },
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  }, 20_000);

  afterAll(async () => {
    await dash.stop();
    await pipe.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (path: string, token: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...as(token), "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  let dtZzh = "";

  it("an admin creates a local account and receives its login key once", async () => {
    const res = await post("/api/admin/local-user", ADMIN, { username: "lilei", display_name: "张三" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; username: string; token: string; display_name: string };
    expect(body.username).toBe("lilei");
    expect(body.display_name).toBe("张三");
    expect(body.token).toMatch(/^dt_[0-9a-f]{32}$/);
    dtZzh = body.token;
    expect(store.getIdentitiesByUser("lilei")).toEqual([expect.objectContaining({ provider: "local", external_id: "lilei" })]);
    expect((await fetch(`${base}/api/tickets/999/files`, { headers: as(dtZzh) })).status).toBe(403);
    // Twice is a conflict, not a second account.
    expect((await post("/api/admin/local-user", ADMIN, { username: "lilei" })).status).toBe(409);
    // Nobody but an admin may do this.
    expect((await post("/api/admin/local-user", dtDora, { username: "eve" })).status).toBe(403);
  });

  it("the new key logs in with zero capabilities and no dev pages", async () => {
    const overview = await fetch(`${base}/api/overview`, { headers: as(dtZzh) });
    expect(overview.status).toBe(200);
    expect((await fetch(`${base}/api/tickets`, { headers: as(dtZzh) })).status).toBe(403);
    // Rotating the key invalidates the old one immediately.
    const rotate = await post("/api/admin/dashboard-token", ADMIN, { username: "lilei" });
    expect(rotate.status).toBe(200);
    const fresh = ((await rotate.json()) as { token: string }).token;
    expect((await fetch(`${base}/api/overview`, { headers: as(dtZzh) })).status).toBe(401);
    dtZzh = fresh;
    expect((await fetch(`${base}/api/overview`, { headers: as(dtZzh) })).status).toBe(200);
  });

  it("granting contribute opens the workspace to the holder's own tickets only", async () => {
    const grant = await post("/api/admin/grant", ADMIN, { username: "lilei", capability: "contribute", value: true });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { effective: { contribute: boolean; dev: boolean } }).effective).toMatchObject({ contribute: true, dev: false });
    const users = (await (await fetch(`${base}/api/admin/users`, { headers: as(ADMIN) })).json()) as { users: Array<{ username: string; contribute: boolean }>; capabilities: string[] };
    expect(users.capabilities).toEqual(["contribute", "dev", "deploy"]);
    expect(users.users.find((u) => u.username === "lilei")?.contribute).toBe(true);

    // alice (dev) files a ticket; lilei files their own.
    const aliceTicket = ((await (await post("/api/tickets", dtAlice, { body: "alice work" })).json()) as { ticket: { id: number; lane: string } }).ticket;
    expect(aliceTicket.lane).toBe("direct");
    const res = await post("/api/tickets", dtZzh, { body: "lilei work" });
    expect(res.status).toBe(200);
    const lileiTicket = ((await res.json()) as { ticket: { id: number; lane: string; requester: string } }).ticket;
    expect(lileiTicket.requester).toBe("lilei");
    expect(lileiTicket.lane).toBe("review");
    // A contributor cannot file on somebody else's behalf.
    expect((await post("/api/tickets", dtZzh, { body: "x", requester: "alice" })).status).toBe(400);

    const mine = (await (await fetch(`${base}/api/tickets`, { headers: as(dtZzh) })).json()) as {
      tickets: Array<{ id: number }>; viewer_lane: string; may_review: boolean;
    };
    expect(mine.tickets.map((t) => t.id)).toEqual([lileiTicket.id]);
    expect(mine.viewer_lane).toBe("review");
    expect(mine.may_review).toBe(false);
    // alice (a member) sees the whole workspace.
    const all = (await (await fetch(`${base}/api/tickets`, { headers: as(dtAlice) })).json()) as { tickets: Array<{ id: number }>; viewer_lane: string };
    expect(all.tickets.map((t) => t.id).sort()).toEqual([aliceTicket.id, lileiTicket.id].sort());
    expect(all.viewer_lane).toBe("direct");

    // Object-level: alice's ticket is not lilei's to read or to talk to.
    expect((await fetch(`${base}/api/tickets/${aliceTicket.id}`, { headers: as(dtZzh) })).status).toBe(403);
    expect((await post(`/api/tickets/${aliceTicket.id}/message`, dtZzh, { body: "hi" })).status).toBe(403);
    expect((await fetch(`${base}/api/tickets/${lileiTicket.id}`, { headers: as(dtZzh) })).status).toBe(200);
    expect((await post(`/api/tickets/${lileiTicket.id}/message`, dtZzh, { body: "hi" })).status).toBe(200);
    // Reading one's ticket includes its committed source, without dev/admin
    // promotion or a general host-file grant. The object gate runs first.
    const sourceUrl = `${base}/api/tickets/${lileiTicket.id}/files?path=README.md`;
    const source = await fetch(sourceUrl, { headers: as(dtZzh) });
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ kind: "file", path: "README.md", text: "# Repository source\n" });
    expect((await fetch(sourceUrl)).status).toBe(401);
    expect((await fetch(sourceUrl, { headers: as(dtDora) })).status).toBe(200);
    expect((await fetch(sourceUrl, { headers: as(dtAlice) })).status).toBe(200);
    expect((await fetch(sourceUrl, { headers: as(ADMIN) })).status).toBe(200);
    expect((await fetch(`${base}/api/tickets/${aliceTicket.id}/files?path=/etc/passwd`, { headers: as(dtZzh) })).status).toBe(403);
    expect((await fetch(`${base}/api/tickets/${lileiTicket.id}/files?path=/etc/passwd`, { headers: as(dtZzh) })).status).toBe(403);
    expect((await post(`/api/tickets/${lileiTicket.id}/files`, dtZzh, { path: "README.md", text: "overwrite" })).status).toBe(404);

  });

  it("a contributor reads the deploy axis without the workspace's verify checklist", async () => {
    const res = await fetch(`${base}/api/deploy`, { headers: as(dtZzh) });
    // No deploy service in this composition → 404 is the honest answer; the
    // point here is that the route itself admits a contributor (not 403).
    expect(res.status).toBe(404);
  });

  it("the review queue is a member read and a maintainer write", async () => {
    expect((await fetch(`${base}/api/merge-queue`, { headers: as(dtZzh) })).status).toBe(403);
    const asAlice = await fetch(`${base}/api/merge-queue`, { headers: as(dtAlice) });
    expect(asAlice.status).toBe(200);
    expect(((await asAlice.json()) as { may_review: boolean }).may_review).toBe(false);
    const asDora = await fetch(`${base}/api/merge-queue`, { headers: as(dtDora) });
    expect(((await asDora.json()) as { may_review: boolean }).may_review).toBe(true);
    expect((await post("/api/merge-queue/decide", dtAlice, { proposal_id: 1, decision: "approve" })).status).toBe(403);
    expect((await post("/api/merge-queue/decide", dtDora, { proposal_id: 999, decision: "approve" })).status).toBe(404);
    expect((await post("/api/merge-queue/run", dtDora, {})).status).toBe(409); // nothing approved
    // The shared key may decide but cannot file a batch: no account to own it.
    expect((await post("/api/merge-queue/run", ADMIN, {})).status).toBe(400);
  });

  it("promoting a contributor to dev opens the shared workspace and direct lane without deploy", async () => {
    const grant = await post("/api/admin/grant", ADMIN, { username: "lilei", capability: "dev", value: true });
    expect(grant.status).toBe(200);
    expect(((await grant.json()) as { effective: { contribute: boolean; dev: boolean; deploy: boolean } }).effective)
      .toMatchObject({ contribute: true, dev: true, deploy: false });

    const shared = await fetch(`${base}/api/tickets`, { headers: as(dtZzh) });
    expect(shared.status).toBe(200);
    const roster = (await shared.json()) as {
      tickets: Array<{ requester: string }>;
      viewer_lane: string;
      may_review: boolean;
    };
    expect(roster.tickets.some((ticket) => ticket.requester === "alice")).toBe(true);
    expect(roster.viewer_lane).toBe("direct");
    expect(roster.may_review).toBe(false);

    const created = await post("/api/tickets", dtZzh, { body: "trusted member work" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { ticket: { requester: string; lane: string } }).ticket)
      .toMatchObject({ requester: "lilei", lane: "direct" });

    expect((await fetch(`${base}/api/merge-queue`, { headers: as(dtZzh) })).status).toBe(200);
    expect((await post("/api/deploy", dtZzh, {})).status).toBe(403);
  });
});
