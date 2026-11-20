/**
 * P0-7: the v3 Host's own web surface, held to the same rules as the bot's.
 *
 * Four holes this pins shut:
 *
 *  1. `readBody` concatenated the whole request. A POST is reachable before
 *     any per-route check, so anyone who can reach the port can make the Host
 *     buffer as much as they can send.
 *  2. `GET /login?token=` put a long-lived credential in a URL — browser
 *     history, the Referer of the next request, the proxy log, the server log.
 *     The link people are handed still points at /login; the page turns it
 *     into a POST that is never written down.
 *  3. The Secure cookie flag came from `x-forwarded-proto`, a header the
 *     client sends. A plaintext request claiming `https` got a Secure cookie
 *     (which then never comes back); worse, the flag was absent whenever the
 *     proxy did not set it, so the session id rode cleartext.
 *  4. `originOk` accepted `http://<Host header>`, so an attacker who can set
 *     Host sets both sides of the comparison and always agrees with itself.
 *
 * Plus the lifecycle claim the module docstring makes: a restart ends every
 * session and every AppInstance. In-memory is the fail-closed direction, but
 * only if the old handles are actually refused rather than re-minted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "./server.js";
import { allowedOrigins, hostCookies, originOk } from "./security.js";

/**
 * The cookie NAME is part of the deployment contract, not a constant: an https
 * Host issues `__Host-v3s`, a plain one issues `v3s`. Tests ask the same
 * function the server asks, so "the name changed" fails as a contract test
 * (below) rather than as an unexplained 401 in every other test.
 */
const plainNames = hostCookies(undefined).names;

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let host: Host | null = null;
let base = "";

function hostOpts(extra: Record<string, unknown> = {}): ConstructorParameters<typeof Host>[0] {
  return {
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t-lht", admin: true }, bob: { token: "t-bob" } },
    ...extra,
  } as ConstructorParameters<typeof Host>[0];
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "harden-"));
  const appDir = path.join(dir, "apps", "counter");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: counter
title: 计数器
scope: per-user
actions:
  add: { title: 加一, predicate: owner }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`,
  );
  fs.writeFileSync(path.join(appDir, "projection.ts"), `export function project() { return {}; }`);
  fs.writeFileSync(path.join(appDir, "actions.ts"), `export function add() { return { events: [], reply: "ok" }; }`);
  host = new Host(hostOpts());
  await host.start();
  base = host.boundUrl!;
});

afterEach(() => {
  host?.stop();
  host = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function login(token: string, at = base): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${at}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: at },
    body: JSON.stringify({ token }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `${plainNames.session}=${/v3s=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /v3csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

describe("request bodies are bounded", () => {
  it("an oversized body is refused with 413 and is not buffered", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify({ instance: "x", action: "add", params: { note: big } }),
    });
    expect(res.status).toBe(413);
  });

  it("a body that lies about its length is still cut off at the cap", async () => {
    // No content-length to trust: the cap has to fire on bytes actually read.
    const b = await login("t-lht");
    const send = () =>
      fetch(`${base}/api/act`, {
        method: "POST",
        headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
        // eslint-disable-next-line
        body: new ReadableStream({
          start(c) {
            for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("y".repeat(100_000)));
            c.close();
          },
        }),
        duplex: "half",
      });

    // Two outcomes are honest here and BOTH are the cap firing: the server
    // answers 413, or it hangs up while we are still writing and this side's
    // write fails. Which one arrives is a race between our 4 MB of chunks and
    // the server's refusal — on a loaded machine the reset usually wins, which
    // is why asserting only on the status made this test flaky in a full run.
    //
    // What would still fail, and is the whole point: a 2xx, i.e. the server
    // buffered all 4 MB and then acted on it.
    let status: number;
    try {
      status = (await send()).status;
    } catch (err) {
      const detail = String((err as { cause?: unknown })?.cause ?? err);
      expect(detail).toMatch(/EPIPE|ECONNRESET|socket hang up|terminated/i);
      return;
    }
    expect(status).toBe(413);
  });
});

describe("the token never travels in a URL", () => {
  it("the login page's script parses and is nonce-allowed by its own CSP", async () => {
    // Shipped JS with no compiler behind it: a template-literal edit that
    // breaks it fails silently in someone else's browser, and this is the page
    // where that means nobody can log in.
    const res = await fetch(`${base}/login`);
    const html = await res.text();
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
    expect(csp).toContain("connect-src 'self'");
  });

  it("GET /login?token= does not log anyone in", async () => {
    const res = await fetch(`${base}/login?token=t-lht`, { redirect: "manual" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.status).not.toBe(302);
  });

  it("a token in the query string is not a credential at all any more", async () => {
    // It used to authenticate reads (and then be refused for writes). Now it is
    // simply ignored: a long-lived login credential must not travel in a URL,
    // where it lands in history, in the next Referer and in every proxy log.
    const write = await fetch(`${base}/api/act?token=t-lht`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ instance: "x", action: "add", params: {} }),
    });
    expect(write.status).toBe(401);
    const read = await fetch(`${base}/api/view?app=counter&token=t-lht`);
    expect(read.status).toBe(401);
    // The same token in a header still works for a script.
    const viaHeader = await fetch(`${base}/api/view?app=counter`, {
      headers: { authorization: "Bearer t-lht" },
    });
    expect(viaHeader.status).toBe(200);
  });

  it("logout is a POST with CSRF and Origin, never a GET", async () => {
    const b = await login("t-lht");
    // A GET would be triggerable by any <img src> on any page.
    expect((await fetch(`${base}/logout`, { headers: { cookie: b.cookie }, redirect: "manual" })).status).toBe(405);
    // Cookie alone is not enough either.
    const noCsrf = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", origin: base },
      body: "{}",
      redirect: "manual",
    });
    expect(noCsrf.status).toBe(403);
    // Still logged in.
    expect((await fetch(`${base}/a/counter`, { headers: { cookie: b.cookie } })).status).toBe(200);
    // With both halves it works.
    const ok = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: "{}",
      redirect: "manual",
    });
    expect(ok.status).toBe(303);
    expect((await fetch(`${base}/a/counter`, { headers: { cookie: b.cookie } })).status).toBe(401);
  });

  it("a malformed body is a 400, not a 500", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad_json" });
  });

  it("POST /login issues the session and does not echo the token back", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: "t-lht" }),
    });
    expect(res.status).toBe(303);
    const raw = (res.headers.get("set-cookie") ?? "") + (res.headers.get("location") ?? "");
    expect(raw).toContain("v3s=");
    expect(raw).not.toContain("t-lht");
  });
});

describe("cookie flags come from configuration, not from the caller", () => {
  it("a forged x-forwarded-proto does not decide Secure", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: "t-lht" }),
    });
    // No publicUrl configured, so this Host is plain http and the LIVE cookies
    // must not be marked Secure — a Secure cookie on http is never sent back.
    liveCookiesAreNotSecure(res.headers.getSetCookie());
  });

  it("a configured https public_url makes the cookie Secure with no header at all", async () => {
    host!.stop();
    host = new Host(hostOpts({ publicUrl: "https://v3.example.com" }));
    await host.start();
    const at = host.boundUrl!;
    const res = await fetch(`${at}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: "https://v3.example.com" },
      body: JSON.stringify({ token: "t-lht" }),
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("deployment shape: HTTPS public URL behind an untrusted request", () => {
  /**
   * The production shape: a TLS proxy terminates at `https://v3.example.com`
   * and dials this Host over plain HTTP on loopback. Everything the Host
   * decides about the deployment has to come from `public_url`, because every
   * header on the inbound request is something the caller wrote.
   */
  let tls: Host | null = null;
  let at = "";
  const CANON = "https://v3.example.com";

  beforeEach(async () => {
    tls = new Host(hostOpts({ publicUrl: CANON }));
    await tls.start();
    at = tls.boundUrl!;
  });
  afterEach(() => {
    tls?.stop();
    tls = null;
  });

  const tlsNames = hostCookies(CANON).names;

  const login2 = async (): Promise<{ cookie: string; csrf: string }> => {
    const res = await fetch(`${at}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: CANON },
      body: JSON.stringify({ token: "t-lht" }),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    return {
      cookie: `${tlsNames.session}=${/v3s=([0-9a-f]{64})/.exec(raw)![1]}`,
      csrf: /v3csrf=([0-9a-f]{64})/.exec(raw)![1],
    };
  };

  it("issues __Host- cookies, with no Domain and rooted at /", async () => {
    // The prefix is the only thing that stops a sibling host under the same
    // registrable site from planting a same-named `Domain` cookie here — a
    // browser refuses one outright for a `__Host-` name. It is available only
    // because this deployment is https; the plain Host below keeps the
    // unprefixed pair, which is a different deployment rather than a weaker
    // version of this one.
    const res = await fetch(`${at}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: CANON },
      body: JSON.stringify({ token: "t-lht" }),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    expect(tlsNames.session).toBe("__Host-v3s");
    expect(raw).toContain("__Host-v3s=");
    expect(raw).toContain("__Host-v3csrf=");
    expect(raw).not.toContain("Domain=");
    // And the pre-session cookie is retired in the same response.
    expect(raw).toContain("v3t=;");
    expect(plainNames.session).toBe("v3s");
  });

  it("the cookie is Secure even though the inbound request is plain HTTP", async () => {
    const res = await fetch(`${at}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: CANON },
      body: JSON.stringify({ token: "t-lht" }),
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("a forged Host header cannot make its own origin acceptable", async () => {
    const b = await login2();
    const forged = await fetch(`${at}/api/act`, {
      method: "POST",
      headers: {
        cookie: b.cookie,
        "content-type": "application/json",
        "x-csrf-token": b.csrf,
        host: "evil.example",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ instance: "x", action: "add", params: {} }),
    });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ code: "origin" });
  });

  it("x-forwarded-proto is ignored in both directions", async () => {
    // Claiming http on an https deployment must not drop Secure...
    const claimsHttp = await fetch(`${at}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: CANON, "x-forwarded-proto": "http" },
      body: JSON.stringify({ token: "t-lht" }),
    });
    expect(claimsHttp.headers.get("set-cookie")).toContain("Secure");
    // ...and claiming https on a plain deployment must not add it.
    const plain = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: "t-lht" }),
    });
    liveCookiesAreNotSecure(plain.headers.getSetCookie());
  });

  it("the canonical origin is the only one accepted, loopback included", async () => {
    const b = await login2();
    // Even the address the request literally arrived on is refused: it is not
    // the origin a browser would send for this deployment.
    const viaLoopback = await fetch(`${at}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: at },
      body: JSON.stringify({ instance: "x", action: "add", params: {} }),
    });
    expect(viaLoopback.status).toBe(403);
  });
});

describe("Origin is compared against something the caller does not control", () => {
  const CONFIGURED = allowedOrigins({ publicUrl: "https://v3.example.com" });
  const LOOPBACK = allowedOrigins({ loopbackPort: 18930 });

  it("a Host header cannot mint its own allowed origin", () => {
    // The attack was Host: evil.example plus Origin: http://evil.example, so
    // that the two sides of the comparison agreed with each other. There is no
    // longer a side for the request to supply: the list is built at startup.
    expect(originOk("http://evil.example", LOOPBACK)).toBe(false);
    expect(originOk("https://evil.example", LOOPBACK)).toBe(false);
    expect(originOk("https://evil.example", CONFIGURED)).toBe(false);
  });

  it("with a canonical URL configured, only that origin passes", () => {
    expect(originOk("https://v3.example.com", CONFIGURED)).toBe(true);
    expect(originOk("http://v3.example.com", CONFIGURED)).toBe(false);
  });

  it("without configuration only the bound loopback port passes", () => {
    expect(originOk("http://127.0.0.1:18930", LOOPBACK)).toBe(true);
    expect(originOk("http://localhost:18930", LOOPBACK)).toBe(true);
    expect(originOk("http://127.0.0.1:18931", LOOPBACK)).toBe(false);
    expect(originOk(undefined, LOOPBACK)).toBe(false);
  });
});

describe("a restart ends every session and every app instance", () => {
  it("an old cookie and an old instance handle are both refused", async () => {
    const b = await login("t-lht");
    const page = await (await fetch(`${base}/a/counter`, { headers: { cookie: b.cookie } })).text();
    const instance = /"instance":"([0-9a-f]+)"/.exec(page)![1];

    // Same port would be ideal but is not needed: what is under test is that
    // the new process does not honour the old process's handles.
    host!.stop();
    host = new Host(hostOpts());
    await host.start();
    base = host.boundUrl!;

    const stale = await fetch(`${base}/a/counter`, { headers: { cookie: b.cookie } });
    expect(stale.status).toBe(401);

    const fresh = await login("t-lht");
    const act = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: fresh.cookie, "content-type": "application/json", "x-csrf-token": fresh.csrf, origin: base },
      body: JSON.stringify({ instance, action: "add", params: {} }),
    });
    // The handle came from the dead process: it resolves to nothing, and the
    // request must not fall back to reading `app`/`scope` from the body.
    expect(act.status).toBe(409);
    expect(await act.json()).toMatchObject({ ok: false, code: "stale_instance" });
  });

  it("logging out invalidates the instance handles opened in that session", async () => {
    const b = await login("t-lht");
    const page = await (await fetch(`${base}/a/counter`, { headers: { cookie: b.cookie } })).text();
    const instance = /"instance":"([0-9a-f]+)"/.exec(page)![1];
    await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: "{}",
      redirect: "manual",
    });

    // A NEW session may not use the old handle either: an instance belongs to
    // the session that opened it, so this is a 403 about ownership rather than
    // a 409 about staleness. Both refuse; the reason is the sharper one.
    const fresh = await login("t-lht");
    const act = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: fresh.cookie, "content-type": "application/json", "x-csrf-token": fresh.csrf, origin: base },
      body: JSON.stringify({ instance, action: "add", params: {} }),
    });
    expect([403, 409]).toContain(act.status);
    // And the handle is dead for its own (now logged-out) session too.
    const old = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify({ instance, action: "add", params: {} }),
    });
    expect(old.status).toBe(401);
  });
});

describe("the HTTP layer's guarantees come from the framework now", () => {
  // Each of these used to hold only because a hand-written helper remembered
  // to make it hold, and only on the responses that went through that helper.

  it("hardening headers are on a JSON reply, not just on HTML ones", async () => {
    // The old `send()` set them, so any route answering through `json()` got
    // none of them. `@fastify/helmet` is a hook: it does not know which routes
    // exist, which is exactly why it cannot miss one.
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/view?app=counter`, { headers: { cookie: b.cookie } });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("an oversized body is refused before any handler runs", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: {
        cookie: b.cookie,
        "content-type": "application/json",
        origin: base,
        "x-csrf-token": b.csrf,
      },
      body: JSON.stringify({ instance: "x", action: "y", params: { blob: "a".repeat(2 * 1024 * 1024) } }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too_large");
  });

  it("malformed JSON is a 400 that says so, never an empty object", async () => {
    // The panel's version of this bug answered 413 and then ran the handler
    // with `{}`. Here the body never becomes a value a handler could act on.
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: {
        cookie: b.cookie,
        "content-type": "application/json",
        origin: base,
        "x-csrf-token": b.csrf,
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_json");
  });
});

describe("the route table is the Host's whole surface", () => {
  // Before this, routing was an if-chain ending in a 404, so "is this path
  // behind the gate?" was answered by reading to the end of it. Now the two
  // Fastify scopes answer it structurally.

  it("an unregistered path is a 404 from the framework, not from a fall-through", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/something-nobody-registered`, { headers: { cookie: b.cookie } });
    expect(res.status).toBe(404);
  });

  it("a route registered for POST does not answer a GET", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, { headers: { cookie: b.cookie } });
    expect([404, 405]).toContain(res.status);
  });

  it("every guarded route refuses an unidentified caller, without naming itself", async () => {
    // The property the scope provides: none of these can be reached without
    // passing the hook, so adding one to the scope cannot forget the gate.
    for (const path of ["/api/view", "/api/card", "/api/agent/transcript", "/factory", "/view-frame"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("the public routes are exactly the four that answer before identification", async () => {
    // /login (the door), /logout GET (which only says "use POST"), and the CLI
    // shim's per-turn token. Each has a credential rule that is not "who is
    // this viewer"; anything else reaching an unauthenticated 200 would be a bug.
    expect((await fetch(`${base}/login`)).status).toBe(200);
    expect((await fetch(`${base}/logout`)).status).toBe(405);
    expect((await fetch(`${base}/api/shim/call`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("validation types and caps, but never decides who you are", () => {
  it("a wrongly-typed field is refused with its own code", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", origin: base, "x-csrf-token": b.csrf },
      body: JSON.stringify({ instance: 12345, action: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_request");
  });

  it("identity is still answered before shape — a missing instance is 409, not 400", async () => {
    // The property the schemas must not take away: these routes refuse to
    // resolve identity from the body, and "you forgot a field" is a weaker and
    // different statement than "that instance is not yours".
    const b = await login("t-lht");
    for (const url of ["/api/agent/send", "/api/agent/config", "/api/act"]) {
      const res = await fetch(`${base}${url}`, {
        method: "POST",
        headers: { cookie: b.cookie, "content-type": "application/json", origin: base, "x-csrf-token": b.csrf },
        body: JSON.stringify({ app: "counter", scope: "lht", agent: "page", text: "hi", action: "add" }),
      });
      expect(res.status, url).toBe(409);
    }
  });

  it("an expired shim token is 401 before its body is looked at", async () => {
    // preValidation, not validation: a caller that cannot reach a route must
    // not learn what that route's body should contain.
    const res = await fetch(`${base}/api/shim/call`, {
      method: "POST",
      headers: { authorization: "Bearer definitely-not-a-live-turn", "content-type": "application/json" },
      body: JSON.stringify({ nothing: "valid" }),
    });
    expect(res.status).toBe(401);
  });

  it("an oversized string field is capped by the schema, not by the handler", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", origin: base, "x-csrf-token": b.csrf },
      body: JSON.stringify({ instance: "a".repeat(500), action: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The property the route split bought: a path is named in exactly one place.
 *
 * It used to be named twice — once in `registerRoutes` and again in a 300-line
 * if-chain that re-matched it — and the two lists had to agree. That is the
 * shape of the panel's P1-4 (a route table plus per-route checks, with one
 * route no check covered), and it fails silently in BOTH directions: a URL
 * registered but not matched fell through to the chain's terminal 404, and a
 * branch nobody registered was dead code that read as live.
 *
 * Now the table is the only list. This walks the router's own copy of it and
 * proves a handler ran for every entry, so the claim stays checked rather than
 * merely argued.
 */
describe("the route table and the handlers cannot drift apart", () => {
  /** Fastify's own 404, i.e. no handler ran. Ours never look like this. */
  function isRouterMiss(status: number, text: string): boolean {
    if (status !== 404) return false;
    try {
      const b = JSON.parse(text) as { error?: string; message?: string };
      return b.error === "Not Found" && /not found/i.test(b.message ?? "");
    } catch {
      return false;
    }
  }

  /**
   * The Host's public surface, written down on purpose.
   *
   * Yes, this is a second list — but it is a SPEC, not a duplicate mechanism:
   * nothing dispatches from it, and its whole job is to make adding, removing
   * or renaming an endpoint a visible edit rather than a silent one. HEAD is
   * Fastify's (it derives one per GET).
   */
  const EXPECTED = [
    "GET /",
    "GET /a/:app",
    "GET /a/:app/:page",
    "GET /api/agent/transcript",
    "GET /api/card",
    "GET /api/factory/apps",
    "GET /api/sse",
    "GET /api/view",
    "GET /factory",
    "GET /index.html",
    "GET /login",
    "GET /logout",
    "GET /view-frame",
    "POST /api/act",
    "POST /api/agent/config",
    "POST /api/agent/send",
    "POST /api/factory/save",
    "POST /api/feishu/callback",
    "POST /api/instance/close",
    "POST /api/pending/result",
    "POST /api/shim/call",
    "POST /login",
    "POST /logout",
  ];

  it("serves exactly the documented surface", () => {
    const actual = host!.routes
      .filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS")
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect([...new Set(actual)]).toEqual(EXPECTED);
  });

  it("every registered path reaches a handler that runs", async () => {
    const table = host!.routes.filter((r) => r.method === "GET" || r.method === "POST");
    expect(table.length).toBeGreaterThan(10); // never pass vacuously

    for (const r of table) {
      // The one open-ended stream. It hijacks the reply and never ends, so
      // "did a handler run" cannot be asked of it with a plain fetch.
      if (r.url === "/api/sse") continue;
      // Fresh session per request: POST /logout is in this table and ends one.
      const b = await login("t-lht");
      const url = base + r.url.replace(/:(\w+)/g, "x");
      const res =
        r.method === "GET"
          ? await fetch(url, { headers: { cookie: b.cookie }, redirect: "manual" })
          : await fetch(url, {
              method: "POST",
              redirect: "manual",
              headers: { cookie: b.cookie, "content-type": "application/json", origin: base, "x-csrf-token": b.csrf },
              body: "{}",
            });
      const text = await res.text();
      const where = `${r.method} ${r.url} -> ${res.status} ${text.slice(0, 160)}`;
      // A handler's OWN 404 ("未知应用", "no_such_pending") is a pass: the route
      // was served. Only the router's miss means nothing ran.
      expect(isRouterMiss(res.status, text), where).toBe(false);
      // And a 500 means it ran and blew up. The concrete way this refactor
      // could produce one: registering `withViewer(this.apiAct)` without
      // re-binding `this`, so every method-reference handler dies on the first
      // `this.` it touches. Fastify turns that into a 500, not a miss.
      expect(res.status, where).toBeLessThan(500);
    }
  }, 30_000);
});

/**
 * Assert the LIVE cookies of a plain-http deployment carry no `Secure`.
 *
 * Not "the response contains no Secure anywhere": since deletion obeys the
 * prefix too, the same response also RETIRES `__Host-…` names, and those
 * deletions must carry `Secure` or the browser ignores them. Asserting on the
 * whole blob would therefore be asserting that the retirement is broken.
 */
function liveCookiesAreNotSecure(setCookie: string[]): void {
  const live = setCookie.filter((c) => !c.includes("Max-Age=0"));
  expect(live.length, "a login should set the live pair").toBeGreaterThan(0);
  for (const c of live) expect(c, c).not.toContain("Secure");
  // …and the retired prefixed deletions are valid, i.e. they do carry it.
  for (const c of setCookie.filter((c) => c.startsWith("__Host-"))) {
    expect(c, c).toContain("Secure");
    expect(c, c).toContain("Max-Age=0");
  }
}
