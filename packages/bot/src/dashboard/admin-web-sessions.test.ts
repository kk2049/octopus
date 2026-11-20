/**
 * B12: a login-key rotation is an incident response, so it has to end the
 * browser sessions that key bought — a web session row names only the account,
 * and before this a rotated (leaked) key's logins stayed valid for up to the
 * 14-day absolute lifetime. And an administrator can end every browser login of
 * an account directly, while nobody else can end somebody else's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";

const ADMIN_KEY = "admin-key";
const NOW = "2026-10-15T00:00:00.000Z";

describe("login-key rotation and administrator session revocation", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let dtBob: string;
  let dtRoot: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "admin-web-sessions-"));
    store = new Store(join(dir, "t.db"));
    for (const [i, name] of ["alice", "bob", "root"].entries()) {
      store.saveUser({ username: name, uid: 8100 + i, home_dir: `/x/${name}`, created_at: NOW });
    }
    dtAlice = mintDashboardToken(store, "alice");
    dtBob = mintDashboardToken(store, "bob");
    dtRoot = mintDashboardToken(store, "root");
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN_KEY,
      adminUsers: ["root"],
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterEach(async () => {
    await dash.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

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

  const post = (b: { cookie: string; csrf: string }, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify(body),
    });

  const alive = async (b: { cookie: string }) =>
    (await fetch(`${base}/api/overview`, { headers: { cookie: b.cookie } })).status === 200;

  it("rotating a user's key ends every browser session that user had, and records who did it", async () => {
    const aliceTab = await browser(dtAlice);
    const aliceLaptop = await browser(dtAlice);
    expect(await alive(aliceTab)).toBe(true);
    const root = await browser(dtRoot);

    const res = await post(root, "/api/admin/dashboard-token", { username: "alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; ended_sessions: number };
    expect(body.ended_sessions).toBe(2);

    expect(await alive(aliceTab)).toBe(false);
    expect(await alive(aliceLaptop)).toBe(false);
    // The old key is dead too; the new one buys a fresh, working session.
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${dtAlice}` } })).status).toBe(401);
    expect(await alive(await browser(body.token))).toBe(true);
    // The administrator's own login is untouched by rotating someone else.
    expect(await alive(root)).toBe(true);

    const audit = store.listPermissionAudit("alice", { operation: "rotate_login_key" });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail ?? "{}")).toEqual({ by: "root" });
  });

  it("an administrator rotating their own key keeps the session they read the new key in", async () => {
    const here = await browser(dtRoot);
    const elsewhere = await browser(dtRoot);
    const res = await post(here, "/api/admin/dashboard-token", { username: "root" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ended_sessions: number }).ended_sessions).toBe(1);
    expect(await alive(here)).toBe(true);
    expect(await alive(elsewhere)).toBe(false);
  });

  it("an administrator ends every browser login of another account; a non-admin cannot", async () => {
    const bobTab = await browser(dtBob);
    const bobPhone = await browser(dtBob);
    const alice = await browser(dtAlice);

    // A non-admin is refused before the handler runs, and nothing ended.
    expect((await post(alice, "/api/admin/web-sessions/revoke", { username: "bob" })).status).toBe(403);
    expect(await alive(bobTab)).toBe(true);
    expect(await alive(bobPhone)).toBe(true);

    const root = await browser(dtRoot);
    const res = await post(root, "/api/admin/web-sessions/revoke", { username: "bob" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, username: "bob", revoked: 2 });
    expect(await alive(bobTab)).toBe(false);
    expect(await alive(bobPhone)).toBe(false);
    // Bob's key still works: ending logins is not rotating the key.
    expect(await alive(await browser(dtBob))).toBe(true);
    expect(await alive(alice)).toBe(true);
    expect((await post(root, "/api/admin/web-sessions/revoke", { username: "ghost" })).status).toBe(404);
    const audit = store.listPermissionAudit("bob", { operation: "admin_logout_all" });
    expect(JSON.parse(audit[0]!.detail ?? "{}")).toEqual({ by: "root" });
  });
});
