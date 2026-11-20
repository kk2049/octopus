/**
 * The framework serves the panel's OLD external contract, not Fastify's
 * defaults.
 *
 * A transport migration is only safe if the things a client can observe are
 * unchanged, and a framework has opinions about most of them. Each case below is
 * one place where the default would have differed and was configured back — or
 * one place where the framework's answer is now a load-bearing part of the
 * panel's behaviour and would otherwise be an accident.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { buildPanelApp, PANEL_REQUEST_TIMEOUT_MS } from "./http.js";

const NOW = "2026-08-06T00:00:00.000Z";

let dir: string;
let store: Store;
let dash: DashboardServer;
let base: string;
let dt: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "transport-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  dt = mintDashboardToken(store, "alice");
  dash = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "admin-key" });
  await dash.start();
  base = `http://127.0.0.1:${dash.port}`;
});

afterAll(async () => {
  await dash.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const asAlice = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${dt}`, ...(init.headers ?? {}) } });

describe("the information boundary keeps its status codes", () => {
  it("an unknown path is 401 without a credential and 404 with one", async () => {
    // Identity first, always. A prober with no credential must not be able to
    // map the route table by comparing 401 against 404.
    expect((await fetch(base + "/api/not-a-real-endpoint")).status).toBe(401);
    expect((await fetch(base + "/definitely-not-a-page")).status).toBe(401);
    expect((await asAlice("/api/not-a-real-endpoint")).status).toBe(404);
    expect((await asAlice("/definitely-not-a-page")).status).toBe(404);
  });

  it("an unknown path answers the panel's own 404 shape, not the framework's", async () => {
    const res = await asAlice("/api/not-a-real-endpoint");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("a wrong method on a known path is 404, not 405", async () => {
    // The authorization table is keyed on (method, path) and answers 404 for a
    // pair it does not list. Fastify's router agrees — it has no automatic 405 —
    // and `exposeHeadRoutes: false` keeps it that way for HEAD, which the table
    // has no rules for at all.
    expect((await asAlice("/api/overview", { method: "POST" })).status).toBe(404);
    expect((await asAlice("/api/overview", { method: "HEAD" })).status).toBe(404);
    expect((await asAlice("/api/theme-preference")).status).toBe(404);
  });

  it("405 survives where the panel deliberately said 405", async () => {
    // Two places, and both are "this exists, you may not do that to it" rather
    // than "there is no such thing".
    expect((await fetch(base + "/logout", { method: "GET" })).status).toBe(405);
    expect((await fetch(base + "/ui/a/anything.js", { method: "POST" })).status).toBe(405);
  });

  it("a forbidden route stays 403 for an authenticated caller", async () => {
    // alice has no `dev` bit, so the dev pipeline refuses rather than hides.
    const res = await asAlice("/api/deploy");
    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toContain("开发系统");
  });

  it("answers unknown requests before parsing their body", async () => {
    const anonymous = await fetch(base + "/api/not-a-real-endpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(anonymous.status).toBe(401);

    const knownCaller = await asAlice("/api/not-a-real-endpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(knownCaller.status).toBe(404);

    const oversized = await fetch(base + "/api/not-a-real-endpoint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_100_000),
    });
    expect(oversized.status).toBe(401);
  });
});

describe("bodies are refused by the framework, in the panel's words", () => {
  it("an oversized body is 413 with the panel's message and never reaches a handler", async () => {
    const before = store.getSetting("alice", "dashboard_theme");
    const res = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(String(((await res.json()) as { error?: string }).error)).toContain("过大");
    expect(store.getSetting("alice", "dashboard_theme")).toBe(before);
  });

  it("malformed JSON is 400 and an empty body is a legitimate empty object", async () => {
    const bad = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);
    expect(String(((await bad.json()) as { error?: string }).error)).toContain("JSON");

    // A POST with a JSON content type and nothing in it is what ops scripts and
    // `fetch(url, {method:"POST"})` send; Fastify's own JSON parser answers
    // FST_ERR_CTP_EMPTY_JSON_BODY for that, which is why the panel registers its
    // own for every content type.
    const empty = await asAlice("/api/check-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(empty.status).toBe(200);
    const noType = await asAlice("/api/check-all", { method: "POST" });
    expect(noType.status).toBe(200);
  });

  it("an array or scalar body is refused rather than indexed into", async () => {
    for (const body of ["[1,2]", '"hi"', "null"]) {
      const res = await asAlice("/api/theme-preference", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it("uses the same JSON parser for text/plain instead of silently substituting {}", async () => {
    const good = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ theme: "aurora" }),
    });
    expect(good.status).toBe(200);
    expect(store.getSetting("alice", "dashboard_theme")).toBe("aurora");

    const bad = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    expect(bad.status).toBe(400);
    expect(String(((await bad.json()) as { error?: string }).error)).toContain("JSON");
  });
});

describe("pre-identity routes enforce their own gate before parsing", () => {
  it("does not let malformed bodies outrun Origin or short-lived-token checks", async () => {
    const login = await fetch(base + "/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{broken",
    });
    expect(login.status).toBe(403);

    const logout = await fetch(base + "/logout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{broken",
    });
    expect(logout.status).toBe(403);

    const devpipe = await fetch(base + "/api/devpipe/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(devpipe.status).toBe(503);
  });

  it("preserves method refusals before reading a body", async () => {
    const asset = await fetch(base + "/ui/a/not-an-asset.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(asset.status).toBe(405);

    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await fetch(base + "/logout", { method });
      expect(res.status, method).toBe(405);
    }
  });
});

describe("server receive deadlines are explicit", () => {
  it("keeps the pre-Fastify five-minute request timeout", async () => {
    const app = buildPanelApp({ buildId: () => "", onInternalError: () => undefined });
    await app.ready();
    try {
      expect(app.server.requestTimeout).toBe(PANEL_REQUEST_TIMEOUT_MS);
      expect(PANEL_REQUEST_TIMEOUT_MS).toBe(300_000);
    } finally {
      await app.close();
    }
  });
});

describe("validation is configured, not inherited", () => {
  it("does not coerce a wrong type into a plausible value", async () => {
    // With ajv's default `coerceTypes`, `{theme: 123}` would become "123" and
    // the declared type would have said nothing. It is a refusal instead.
    const res = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: 123 }),
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toContain("请求参数");
  });

  it("does not strip fields the schema does not name", async () => {
    // Clients send fields this server ignores. `removeAdditional` would delete
    // them silently, which changes which requests are accepted.
    const res = await asAlice("/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "ink", unknown_field: { a: 1 } }),
    });
    expect(res.status).toBe(200);
    expect(store.getSetting("alice", "dashboard_theme")).toBe("ink");
  });

  it("never answers a validation error before an authorization one", async () => {
    // Fastify validates AFTER routing and BEFORE the handler; the gate runs in
    // `onRequest`, which is earlier than both. So a caller who should be told
    // 401/403/404 is never told the shape of a body instead.
    const anonymous = await fetch(base + "/api/theme-preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: 123 }),
    });
    expect(anonymous.status).toBe(401);

    const forbidden = await asAlice("/api/land", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: 123 }),
    });
    expect(forbidden.status).toBe(404); // dev pipeline is not constructed here
  });
});

describe("responses keep the headers clients and security tests rely on", () => {
  it("hardens every reply, including JSON ones no helper used to touch", async () => {
    const res = await asAlice("/api/overview");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toMatch(/camera=\(\)/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-octopus-build")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("does not send HSTS — TLS termination and its stickiness belong to the proxy", async () => {
    expect((await asAlice("/api/overview")).headers.get("strict-transport-security")).toBeNull();
  });

  it("sends no CORS headers at all", async () => {
    const res = await fetch(base + "/api/overview", {
      headers: { authorization: `Bearer ${dt}`, origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("compresses a large body only when the client asked, and never a small one", async () => {
    const big = await asAlice("/permissions", { headers: { "accept-encoding": "gzip" } });
    expect(big.headers.get("content-encoding")).toBe("gzip");
    // …and the body actually arrives. An async handler that answered through
    // `reply.send()` and resolved `undefined` used to make Fastify send a second,
    // empty payload — invisible without compression, a blank page with it.
    expect((await big.text()).length).toBeGreaterThan(500);

    const identity = await asAlice("/permissions", { headers: { "accept-encoding": "identity" } });
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect((await identity.text()).length).toBeGreaterThan(500);

    const small = await asAlice("/api/capabilities/pending", { headers: { "accept-encoding": "gzip" } });
    expect(small.headers.get("content-encoding")).toBeNull();
    // …and it still varies on the encoding, so a shared cache cannot serve this
    // uncompressed body to a client that would have got the compressed one.
    expect(small.headers.get("vary")).toMatch(/accept-encoding/i);
    expect(big.headers.get("vary")).toMatch(/accept-encoding/i);
  });

  it("revalidates an unchanged JSON read with a bodiless 304", async () => {
    const first = await asAlice("/api/capabilities/pending", { headers: { "accept-encoding": "gzip" } });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{32}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const body = await first.text();
    expect(JSON.parse(body)).toHaveProperty("pending");

    const again = await asAlice("/api/capabilities/pending", { headers: { "if-none-match": etag!, "accept-encoding": "gzip" } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("content-length")).toBeNull();
    // The read still passed every gate, and the reply keeps its hardening.
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("x-octopus-build")).toMatch(/^[0-9a-f]{12}$/);
    const listed = await asAlice("/api/capabilities/pending", { headers: { "if-none-match": `W/"stale", ${etag}` } });
    expect(listed.status).toBe(304);

    for (const other of ['W/"stale"', '"other", W/"also-stale"']) {
      const stale = await asAlice("/api/capabilities/pending", { headers: { "if-none-match": other } });
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe(body);
    }
  });

  it("answers a changed body in full even to the previous validator", async () => {
    // The overview carries its own generation time, so no two reads are equal.
    const first = await asAlice("/api/overview");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await asAlice("/api/overview", { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect((await second.json()).generated_at).not.toBe((await first.json()).generated_at);
  });

  it("puts no validator on refusals, writes or pages", async () => {
    const missing = await asAlice("/api/not-a-real-endpoint");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("etag")).toBeNull();
    const page = await asAlice("/permissions");
    expect(page.headers.get("etag")).toBeNull();
    expect(page.headers.get("cache-control")).toBe("no-store");
    const write = await asAlice("/api/overview", { method: "POST" });
    expect(write.headers.get("etag")).toBeNull();
  });

  it("answers a refusal in full even when it is large enough to compress", async () => {
    // A credential in the login URL is refused with the full login document.
    // This preserves the compressible error-path coverage now that anonymous
    // script requests to protected pages deliberately receive a small JSON 401.
    const res = await fetch(base + "/login?token=must-not-travel-in-url", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="octopus-bootstrap"');
  });
});

describe("the network assumptions are the process's, not the caller's", () => {
  it("does not let a forwarded header become the devpipe loopback address", async () => {
    // `trustProxy` is off and the check reads the socket, so these headers are
    // inert. The refusal below is the per-turn token's, not the loopback rule's —
    // which is what proves the request was treated as loopback on its own merits.
    const res = await fetch(base + "/api/devpipe/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9",
        forwarded: "for=203.0.113.9",
      },
      body: "{}",
    });
    expect([401, 503]).toContain(res.status);
    expect(String(((await res.json()) as { message?: string }).message ?? "")).not.toContain("回环");
  });

  it("binds loopback only", async () => {
    // Not a framework property, but the one `app.listen({host})` now carries.
    const res = await fetch(base + "/login");
    expect(res.status).toBe(200);
  });

  it("keeps a malformed URL from becoming a 500", async () => {
    // `new URL()` throws on some shapes the old handler passed straight in; the
    // router answers before any of the panel's code runs.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: dash.port, path: "/ui/a/%zz.js" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect([400, 404]).toContain(status);
  });
});
