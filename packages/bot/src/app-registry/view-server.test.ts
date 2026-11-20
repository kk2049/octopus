/**
 * The App origin's response contract, asserted over real HTTP.
 *
 * These are the parts of the boundary a server can get wrong on its own: the
 * headers the browser will then enforce, the absence of a cookie, the absence of
 * CORS, and the refusal to serve the package under a name that does not match
 * its digest. What only a browser can prove — that the cookie really does not
 * ride along, that the frame really cannot reach the parent — is in
 * `browser.e2e.test.ts`, and neither file substitutes for the other.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { AppViewServer } from "./view-server.js";
import { resolveSessionPlus } from "../app-core/settings.js";
import { sessionPlusIdentity } from "../app-core/identity.js";
import { composeViewDocument, composeViewDocumentFrom } from "../app-core/view-app.js";
import { SANDBOX_ALLOW_SCRIPTS_AND_DOWNLOADS as SESSION_PLUS_SANDBOX } from "@claude-bot/web-trust";

/**
 * Record what the server ACTUALLY logs.
 *
 * `createLogger()` returns a fresh pino child per call, so patching a logger
 * this file created would watch an object the server never writes to — the test
 * would pass without observing anything, which is precisely the failure mode
 * being tested for here. Mocking the module is the only way the assertion is
 * about the real sink.
 */
const { logLines } = vi.hoisted(() => ({ logLines: [] as string[] }));
vi.mock("../logger.js", () => {
  const record = (...args: unknown[]): void => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const logger = {
    info: record, warn: record, error: record, debug: record, trace: record, fatal: record,
    child: () => logger,
  };
  return { createLogger: () => logger, logger };
});

afterEach(() => {
  logLines.length = 0;
});

const LABEL = sessionPlusIdentity().packageHostLabel;
const PANEL = "https://bot.example.org";
const HOSTNAME = `${LABEL}.apps.example.org`;

function settings() {
  const r = resolveSessionPlus({
    config: { enabled: true, view_origin: `https://${HOSTNAME}`, view_port: 0 },
    publicUrl: PANEL,
  });
  if (!r.enabled || !r.settings) throw new Error(`fixture config is invalid: ${r.errors.join("; ")}`);
  return r.settings;
}

let server: AppViewServer;

interface Answer {
  status: number;
  header(name: string): string | null;
  body: string;
}

/**
 * Raw `node:http`, because `fetch` refuses to let a caller set `Host` — and
 * `Host` is precisely what this listener validates. A test that could not set
 * it would be testing something else.
 */
function send(o: { path?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: o.path ?? "/",
        method: o.method ?? "GET",
        headers: { host: HOSTNAME, ...(o.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            header: (name) => {
              const v = res.headers[name.toLowerCase()];
              return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
            },
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  server = new AppViewServer(settings());
  await server.start();
});
afterAll(async () => {
  await server.stop();
});

const get = (path = "/", headers: Record<string, string> = {}) => send({ path, headers });

describe("the document response", () => {
  it("treats template-like text inside CSS and JS as asset bytes, never as sentinels", () => {
    const css = `.x::before{content:"%JS% %NONCE%"}`;
    const js = `console.log("%CSS%", "%NONCE%");`;
    const document = composeViewDocument(css, js);
    expect(document.body).toContain(`<style>${css}</style>`);
    expect(document.body).toContain(`<script>${js}</script>`);
    expect(document.policy.kind).toBe("hash");
  });

  it("serves the view with the exact CSP the boundary depends on", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const csp = res.header("content-security-policy") ?? "";
    const scriptHash = /script-src 'sha256-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    const styleHash = /style-src 'sha256-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(scriptHash, "the exact inline script hash").toBeTruthy();
    expect(styleHash, "the exact inline style hash").toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("img-src data:");
    // The one that blocks the active connection APIs, which is what makes the
    // MessagePort the only SUPPORTED channel. It does not stop self-navigation;
    // that residual is confined by the target rules further down this file.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Exact, and only the panel: a wildcard here would let any page frame the
    // view and drive it.
    expect(csp).toContain(`frame-ancestors ${PANEL}`);
    expect(csp).not.toContain("*");
    expect(res.header("referrer-policy")).toBe("no-referrer");
    expect(res.header("x-content-type-options")).toBe("nosniff");
    expect(res.header("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  /**
   * `external-app-host/v1` reuses THIS document rather than reimplementing the
   * App's UI, so an allow-listed external shell has to appear in
   * `frame-ancestors` — and nothing else may move. The default deployment is
   * the assertion above: these two say what changes and, more importantly,
   * what does not.
   */
  it("adds allow-listed external shells to frame-ancestors and nothing else", async () => {
    const baseline = await get();
    const baselineCsp = baseline.header("content-security-policy") ?? "";
    const external = new AppViewServer(settings(), undefined, [
      "http://127.0.0.1:9931",
      "http://[::1]:9931",
    ]);
    await external.start();
    try {
      const res = await send({ headers: { host: HOSTNAME }, path: "/" });
      const direct = await new Promise<Answer>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: external.port, path: "/", method: "GET", headers: { host: HOSTNAME } },
          (r) => {
            let body = "";
            r.setEncoding("utf8");
            r.on("data", (c) => (body += c));
            r.on("end", () => resolve({
              status: r.statusCode ?? 0,
              header: (name) => {
                const v = r.headers[name.toLowerCase()];
                return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
              },
              body,
            }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(direct.status).toBe(200);
      const csp = direct.header("content-security-policy") ?? "";
      // The panel FIRST, then the two exact external origins. Exact: a wildcard
      // or a bare hostname would be refused by `viewFrameCsp` itself.
      expect(csp).toContain(`frame-ancestors ${PANEL} http://127.0.0.1:9931 http://[::1]:9931`);
      expect(csp).not.toContain("*");
      // Every other directive is byte-identical to the deployment with no
      // external host configured — in particular `connect-src 'none'`.
      const strip = (value: string): string => value.replace(/frame-ancestors [^;]+/, "frame-ancestors <x>");
      expect(strip(csp)).toBe(strip(baselineCsp));
      // The existing dashboard host does not regress: same document, same
      // sandbox contract, still no CORS and no cookie.
      expect(res.header("content-security-policy")).toContain(`frame-ancestors ${PANEL}`);
      expect(res.header("content-security-policy")).not.toContain("127.0.0.1");
      expect(direct.header("access-control-allow-origin")).toBeNull();
      expect(direct.header("set-cookie")).toBeNull();
      expect(direct.body).toBe(res.body);
    } finally {
      await external.stop();
    }
  });

  it("sets no cookie and opens no cross-origin API", async () => {
    const res = await get();
    expect(res.header("set-cookie")).toBeNull();
    expect(res.header("access-control-allow-origin")).toBeNull();
    expect(res.header("access-control-allow-credentials")).toBeNull();
  });

  it("contains exactly the two hash-pinned inline blocks and no external resource", async () => {
    const res = await get();
    const html = res.body;
    // Count tags in the DOCUMENT, which means removing the two inline bodies
    // first. Since the View became a compiled React bundle, its bytes contain
    // ordinary occurrences of the characters `<script` (react-dom builds
    // resource tags as strings), and those are not elements: inside a script
    // element only `</script` ends it, and the packaging step refuses a bundle
    // containing that or `<!--`. Scanning the raw response would count them and
    // say the document has three executable blocks, which is the opposite of
    // what this test is for.
    const chrome = html
      .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/g, "$1</style>")
      .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, "$1</script>");
    const tags = chrome.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBe(2);
    for (const tag of tags) expect(tag).not.toContain("nonce=");
    // Neither inline body may end its own element early — that would let the
    // remainder of the bundle be parsed as markup, and the frame would come up
    // blank with nothing to connect it to.
    expect(html.match(/<\/script>/g) ?? []).toHaveLength(1);
    expect(html.match(/<\/style>/g) ?? []).toHaveLength(1);
    // No external subresources: `default-src 'none'` would block them anyway,
    // but a page that tries is a page whose author expected them to load.
    expect(chrome).not.toMatch(/<script[^>]+src=/);
    expect(chrome).not.toMatch(/<link[^>]+href=/);
  });

  it("gives repeated requests byte-identical cacheable documents and policies", async () => {
    const one = await get();
    const two = await get();
    expect(one.body).toBe(two.body);
    expect(one.header("content-security-policy")).toBe(two.header("content-security-policy"));
  });
});

describe("what this origin refuses", () => {
  it("a Host header that is not the configured digest hostname", async () => {
    const res = await send({ headers: { host: "bot.example.org" } });
    expect(res.status).toBe(421);
    expect(res.body).toContain(HOSTNAME);
    expect(server.stats.wrongHost).toBeGreaterThan(0);
  });

  it("a stale digest hostname — the browser would isolate it perfectly and it would still be wrong", async () => {
    const res = await send({ headers: { host: "app-0123456789abcdef0123.apps.example.org" } });
    expect(res.status).toBe(421);
  });

  it("any path other than the document", async () => {
    expect((await get("/probe.json")).status).toBe(404);
    expect((await get("/../server.ts")).status).toBe(404);
  });

  it("anything that is not a read", async () => {
    const res = await send({ method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("the self-navigation residual is confined here", () => {
  it("refuses ANY query and does not re-serve the package", async () => {
    // Measured in Chromium, not assumed: `connect-src 'none'` blocks fetch,
    // XHR, WebSocket and EventSource, but it does not stop a sandboxed frame
    // navigating its OWN browsing context, and no directive available in
    // Chrome 1.62 does (`navigate-to` is unrecognised). External destinations
    // are refused by the embedder's exact `frame-src`, so what is left is a
    // navigation to THIS origin — which must not become a way to reload the
    // app's own code with attacker-chosen data in the URL.
    const before = server.stats.refusedTargets;
    const res = await get("/?leak=projection-secret");
    expect(res.status).toBe(404);
    expect(res.header("content-type")).toBe("text/plain; charset=utf-8");
    // Not the package: no script, no nonce, nothing executable.
    expect(res.body).not.toContain("<script");
    expect(res.body).not.toContain("session-plus");
    expect(res.header("content-security-policy")).toBeNull();
    expect(server.stats.refusedTargets).toBe(before + 1);
  });

  it("refuses a secret encoded in the PATH, which is just as attacker-chosen", async () => {
    // The first fix closed the query and left the path open. `/projection-secret`
    // carries a value exactly as well as `/?leak=projection-secret`, and any
    // "path-only" log — ours or a proxy's — would have recorded it.
    const before = server.stats.refusedTargets;
    const res = await get("/projection-secret");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<script");
    expect(res.body).not.toContain("projection-secret");
    expect(server.stats.refusedTargets).toBe(before + 1);
  });

  it("refuses path AND query together", async () => {
    const before = server.stats.refusedTargets;
    const res = await get("/projection-secret?more=secret");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("projection-secret");
    expect(server.stats.refusedTargets).toBe(before + 1);
  });

  it("refuses every shape of a non-document target", async () => {
    for (const p of ["/?x=1", "/index.html?x=1", "/?", "/x?y", "/secret", "/a/b/c", "//", "/index.html/"]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });

  it("writes NOTHING about the target it refused — the counter is the whole signal", async () => {
    // The tripwire has to be a NUMBER rather than a message, because a message
    // is a place to put the value. Asserted against the mocked module above, so
    // this watches the sink the server writes to.
    const noisy = "secret-value-that-must-not-be-logged";
    const before = server.stats.refusedTargets;
    await get(`/?exfil=${noisy}`);
    await get(`/${noisy}`);
    await get(`/${noisy}?and=${noisy}`);
    await send({ method: "POST", path: `/${noisy}` });
    expect(server.stats.refusedTargets).toBe(before + 4);

    const emitted = logLines.join("\n");
    expect(emitted).not.toContain(noisy);
    expect(emitted).not.toContain("exfil");
    // Not even a length, which is a channel of its own for a View that can
    // choose how long its URL is.
    expect(emitted).not.toMatch(/queryBytes|pathBytes|"path"/);
    // The response body does not echo it either.
    expect((await get(`/?exfil=${noisy}`)).body).not.toContain(noisy);
  });

  it("still logs a wrong Host, because a View cannot choose one", async () => {
    // The asymmetry is deliberate and worth pinning: the browser sets `Host`
    // from the URL's authority, so it is not a channel the View controls — and
    // without this line a proxy that rewrites Host is undiagnosable.
    await send({ headers: { host: "bot.example.org" } });
    expect(logLines.join("\n")).toContain("bot.example.org");
  });

  it("still serves the bare document, so the frame works", async () => {
    expect((await get("/")).status).toBe(200);
    expect((await get("/index.html")).status).toBe(200);
  });
});

describe("start/stop state is honest", () => {
  it("does not retain a listener that failed to bind, and reports not-listening", async () => {
    // A failed listen used to leave a live Server object in the field, so
    // `port` and `stop()` described a listener that never came up — and the
    // caller, having seen a throw, would never call stop() anyway.
    const busy = new AppViewServer(settings());
    await busy.start();
    const clash = new AppViewServer({ ...settings(), listenPort: busy.port });
    await expect(clash.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(clash.listening).toBe(false);
    expect(clash.port).toBe(0);
    // Idempotent and harmless on an instance that never started.
    await clash.stop();
    await busy.stop();
    expect(busy.listening).toBe(false);
  });
});

describe("the cookie tripwire", () => {
  it("counts a document request that arrived carrying cookies", async () => {
    // Should be impossible in a browser: the panel's cookies are host-only and
    // this is a different host. Counted anyway, because if a future deployment
    // ever adds a `Domain`, this number is the thing that would say so.
    const before = server.stats.withCookies;
    await get("/", { cookie: "octopus_sess=whatever" });
    expect(server.stats.withCookies).toBe(before + 1);
  });

  it("still refuses to reflect or act on one", async () => {
    const cookieMarker = "cookie-secret-must-not-cross-the-frame-4f9e2d73";
    const res = await get("/", { cookie: `__Host-octopus_sess=${cookieMarker}` });
    expect(res.status).toBe(200);
    expect(res.header("set-cookie")).toBeNull();
    expect(res.body).not.toContain(cookieMarker);
  });
});

describe("the sandbox token set", () => {
  it("keeps the Session Plus frame opaque while permitting file downloads", () => {
    expect(SESSION_PLUS_SANDBOX).toBe("allow-scripts allow-downloads");
    expect(SESSION_PLUS_SANDBOX).not.toContain("allow-same-origin");
    expect(SESSION_PLUS_SANDBOX).not.toContain("allow-forms");
    expect(SESSION_PLUS_SANDBOX).not.toContain("allow-popups");
  });
});

/**
 * Serving more than one release from one listener.
 *
 * The property under test is that the DIGEST LABEL is the whole lookup key: a
 * request's `Host` selects a package, and it can select nothing else. There is
 * no "current release" fallback here on purpose — a listener that answered
 * "whatever is active" for an unrecognised name would serve one package's bytes
 * under another package's hostname, and the address bar would stop naming the
 * code inside the frame.
 */
describe("digest-addressed publication", () => {
  const DOMAIN = "apps.example.org";
  const A = "app-aaaaaaaaaaaaaaaaaaaa";
  const B = "app-bbbbbbbbbbbbbbbbbbbb";
  const LEGACY_TEMPLATE = '<style nonce="%NONCE%">%CSS%</style><script nonce="%NONCE%">%JS%</script>';

  function multiSettings() {
    const r = resolveSessionPlus({
      config: { enabled: true, app_domain: DOMAIN, view_port: 0 },
      publicUrl: PANEL,
      // The active release decides the origin the listener reports; the
      // publication decides which labels it will answer for.
      identity: { ...sessionPlusIdentity(), packageHostLabel: A },
    });
    if (!r.enabled || !r.settings) throw new Error(`fixture config is invalid: ${r.errors.join("; ")}`);
    return r.settings;
  }

  let multi: AppViewServer;
  const served: string[] = [];

  beforeAll(async () => {
    multi = new AppViewServer(multiSettings(), {
      publishedLabels: () => new Set([A, B]),
      documentFor: async (label, nonce) => {
        served.push(label);
        if (label === A) return composeViewDocument(`/*${label}-css*/`, `/*${label}-js*/`);
        if (label === B) {
          return composeViewDocumentFrom(LEGACY_TEMPLATE, nonce, `/*${label}-css*/`, `/*${label}-js*/`);
        }
        return null;
      },
    });
    await multi.start();
  });
  afterAll(async () => {
    await multi.stop();
  });

  const ask = (host: string, path = "/"): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: multi.port, path, method: "GET", headers: { host } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              header: (name) => {
                const v = res.headers[name.toLowerCase()];
                return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
              },
              body,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("keeps installed legacy nonce releases dynamic and uncacheable", async () => {
    const one = await ask(`${B}.${DOMAIN}`);
    const two = await ask(`${B}.${DOMAIN}`);
    expect(one.status).toBe(200);
    expect(one.header("cache-control")).toBe("no-store");
    expect(one.header("content-security-policy")).toContain("script-src 'nonce-");
    expect(one.body).not.toBe(two.body);
  });

  it("gives each label its own bytes", async () => {
    const a = await ask(`${A}.${DOMAIN}`);
    const b = await ask(`${B}.${DOMAIN}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toContain(`/*${A}-js*/`);
    expect(a.body).not.toContain(`/*${B}-js*/`);
    expect(b.body).toContain(`/*${B}-js*/`);
  });

  it("404s a well-formed name for a release it does not publish, and serves nothing", async () => {
    const before = multi.stats.served;
    const res = await ask(`app-cccccccccccccccccccc.${DOMAIN}`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<!doctype html>");
    expect(multi.stats.served).toBe(before);
    expect(multi.stats.unknownRelease).toBeGreaterThan(0);
  });

  it("421s anything that is not a digest label under the configured domain", async () => {
    for (const host of [
      `${A}.evil.com`,
      `${A}.${DOMAIN}.attacker.tld`,
      `www.${DOMAIN}`,
      `sub.${A}.${DOMAIN}`,
      DOMAIN,
      `${A}.${DOMAIN}:9821`,
    ]) {
      const res = await ask(host);
      expect({ host, status: res.status }).toEqual({ host, status: 421 });
    }
  });

  it("still serves exactly one request target per release", async () => {
    expect((await ask(`${A}.${DOMAIN}`, "/?leak=secret")).status).toBe(404);
    expect((await ask(`${A}.${DOMAIN}`, "/anything")).status).toBe(404);
    // Nothing about the refused target reaches the publication.
    expect(served.every((label) => label === A || label === B)).toBe(true);
  });
});
