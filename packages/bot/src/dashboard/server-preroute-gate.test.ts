/**
 * Pre-route paths cannot bypass the surface gate.
 *
 * Login/logout, OAuth and registration, the runner download, the devpipe
 * loopback, and the browser bundle under `/ui/` are answered before the
 * identity gate, so they never reach `authorizeRoute` — which is precisely why
 * enforcing the surface only there would leave paths outside every composition
 * decision.
 *
 * All are on the bootstrap allowlist, so on the real surfaces there is no
 * observable difference to assert. The gate is therefore tested by taking one
 * of them off the surface: `surfaceAllows` is replaced so that `pre.logout` is
 * excluded, and the panel must then answer 404 for `/logout` — and only for it.
 * If the server ever stopped asking, this test would go green in the wrong
 * direction, which is what makes it worth having as its own file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./authz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./authz.js")>();
  return {
    ...actual,
    surfaceAllows: (surface: string, id: string) => {
      if (surface === "bootstrap-v3" && id === "pre.logout") return false;
      return actual.surfaceAllows(surface as "full" | "bootstrap-v3", id);
    },
  };
});

const { Store } = await import("../store/store.js");
const { DashboardServer, mintDashboardToken } = await import("./server.js");
const { createDashboardTestServer, runnerBundleSourceFromFile } = await import("../e2e/dashboard-test-support.js");

const NOW = "2026-08-03T10:00:00.000Z";

describe("the pre-route surface gate", () => {
  let dir: string;
  let store: InstanceType<typeof Store>;
  let dash: InstanceType<typeof DashboardServer>;
  let base: string;
  let key: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-pre-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
    key = mintDashboardToken(store, "alice");
    const bundle = join(dir, "standalone.js");
    writeFileSync(bundle, "// fake runner bundle");
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "sekrit",
      surface: "bootstrap-v3",
      runnerBundle: runnerBundleSourceFromFile(bundle),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("404s a pre-route path that the surface excludes", async () => {
    // A POST with a correct Origin — i.e. a request that would otherwise have
    // been served — so the 404 can only be the surface decision.
    const res = await fetch(base + "/logout", {
      method: "POST",
      headers: { origin: base },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("leaves representative allowed pre-routes alone", async () => {
    expect((await fetch(base + "/login", { redirect: "manual" })).status).toBe(200);
    expect(
      (await fetch(base + "/download/runner.js", { headers: { authorization: `Bearer ${key}` } })).status,
    ).toBe(200);
    // Reaches the devpipe handler's own boundary rather than the surface's.
    const dev = await fetch(base + "/api/devpipe/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    expect(dev.status).not.toBe(404);
    // The bundle namespace is a classified pre-route too, not an unnamed hole:
    // it answers for itself (404 for a file that does not exist) rather than
    // being refused by the surface.
    const asset = await fetch(base + "/ui/a/does-not-exist.js");
    expect(asset.status).toBe(404);
    expect(await asset.text()).toContain("not found");
  });
});
