import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "./server.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let host: Host | null = null;
let base = "";

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "host-"));
  const appDir = path.join(dir, "apps", "counter");
  fs.mkdirSync(path.join(appDir, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: counter
title: 计数器
scope: per-user
actions:
  add: { title: 加一, predicate: owner, feishu: true }
pages:
  main:
    layout: [a, b]
    slots:
      a: { widget: kv, bind: view }
      b: { widget: actions, props: { items: [{ action: add }] } }
feishu:
  cards: [main]
`,
  );
  fs.writeFileSync(
    path.join(appDir, "projection.ts"),
    `export function project(events: Array<{type: string}>) { return { count: events.filter(e => e.type === "add").length }; }`,
  );
  fs.writeFileSync(path.join(appDir, "actions.ts"), `export function add() { return { events: [{ type: "add", data: null }], reply: "加了" }; }`);

  host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t-lht", admin: true }, bob: { token: "t-bob" } },
  });
  await host.start();
  base = host.boundUrl!;
});

afterEach(() => {
  host?.stop();
  host = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const asLht = { authorization: "Bearer t-lht" };
const asBob = { authorization: "Bearer t-bob" };

interface Browser {
  cookie: string;
  csrf: string;
  origin: string;
}

/** Log in the way a browser does and keep the session + CSRF pair. */
async function login(token: string): Promise<Browser> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const sid = /v3s=([0-9a-f]{64})/.exec(raw)![1];
  const csrf = /v3csrf=([0-9a-f]{64})/.exec(raw)![1];
  return { cookie: `v3s=${sid}; v3csrf=${csrf}`, csrf, origin: base };
}

/** Open a page and read the server-minted instance handle out of __BOOT. */
async function openInstance(b: Browser, app: string, scope?: string): Promise<string> {
  const url = `${base}/a/${app}${scope ? `?scope=${scope}` : ""}`;
  const html = await (await fetch(url, { headers: { cookie: b.cookie } })).text();
  return /"instance":"([0-9a-f]+)"/.exec(html)![1];
}

async function pageHtml(b: Browser, app = "counter"): Promise<Response> {
  return await fetch(`${base}/a/${app}`, { headers: { cookie: b.cookie } });
}

function post(b: Browser, p: string, body: unknown, over: Record<string, string> = {}): Promise<Response> {
  return fetch(base + p, {
    method: "POST",
    headers: {
      cookie: b.cookie,
      "content-type": "application/json",
      "x-csrf-token": b.csrf,
      origin: b.origin,
      ...over,
    },
    body: JSON.stringify(body),
  });
}

describe("Host over real HTTP", () => {
  it("exchanges the configured token for an opaque session, and never stores it in the cookie", async () => {
    expect((await fetch(`${base}/api/view?app=counter`)).status).toBe(401);
    const post = (token: string) =>
      fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ token }),
      });
    const login = await post("t-lht");
    expect(login.status).toBe(303);
    const raw = login.headers.get("set-cookie") ?? "";
    expect(raw).not.toContain("t-lht");
    expect(raw).toMatch(/v3s=[0-9a-f]{64}; HttpOnly/);
    expect(raw).toMatch(/v3csrf=[0-9a-f]{64}/);
    expect((await post("wrong")).status).toBe(401);
    // The credential never travels in a URL, so the GET form cannot log in.
    const viaUrl = await fetch(`${base}/login?token=t-lht`, { redirect: "manual" });
    expect(viaUrl.headers.get("set-cookie")).toBeNull();
  });

  it("act → view → SSE first frame all agree on the same truth", async () => {
    const b = await login("t-lht");
    const instance = await openInstance(b, "counter");
    const act = await post(b, "/api/act", { instance, action: "add", params: {} });
    const out = (await act.json()) as { ok: boolean; events: Array<{ by: string }> };
    expect(out.ok).toBe(true);
    expect(out.events[0].by).toBe("user:lht");

    const view = (await (await fetch(`${base}/api/view?app=counter`, { headers: asLht })).json()) as {
      view: { count: number };
    };
    expect(view.view.count).toBe(1);

    const sse = await fetch(`${base}/api/sse?app=counter`, { headers: asLht });
    const reader = sse.body!.getReader();
    let text = "";
    for (let i = 0; i < 4 && !text.includes('"rev"'); i++) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain('"count":1');
  });

  it("cross-user walls hold over HTTP exactly as in-process", async () => {
    const bob = await login("t-bob");
    // Bob can only ever open an instance bound to Bob. There is no request
    // shape that opens one for lht: the owner comes from the session.
    const bobInstance = await openInstance(bob, "counter");
    const write = await post(bob, "/api/act", { instance: bobInstance, action: "add", params: {} });
    const out = (await write.json()) as { ok: boolean; events?: Array<{ by: string }> };
    expect(out.ok).toBe(true);
    expect(out.events![0].by).toBe("user:bob");
    // ...and it landed in bob's scope, not lht's.
    const lhtView = (await (await fetch(`${base}/api/view?app=counter&scope=lht`, { headers: asLht })).json()) as {
      view: { count: number };
    };
    expect(lhtView.view.count).toBe(0);
    expect((await fetch(`${base}/api/view?app=counter&scope=lht`, { headers: asBob })).status).toBe(403);
    // admin read-only lens still works
    expect((await fetch(`${base}/api/view?app=counter&scope=bob`, { headers: asLht })).status).toBe(200);
  });

  it("app identity comes from the handle, not the body", async () => {
    const bob = await login("t-bob");
    const lht = await login("t-lht");
    const bobInstance = await openInstance(bob, "counter");
    // Bob names lht's scope and an app he is not bound to. Both are ignored.
    const res = await post(bob, "/api/act", {
      instance: bobInstance,
      app: "counter",
      scope: "lht",
      action: "add",
      params: {},
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const lhtInstance = await openInstance(lht, "counter");
    expect(lhtInstance).not.toBe(bobInstance);
    // Presenting someone else's handle on your own session is refused.
    const stolen = await post(bob, "/api/act", { instance: lhtInstance, action: "add", params: {} });
    expect(stolen.status).toBe(403);
    const lhtView = (await (await fetch(`${base}/api/view?app=counter`, { headers: asLht })).json()) as {
      view: { count: number };
    };
    expect(lhtView.view.count).toBe(0);
  });

  it("a bearer token cannot write, and a session without CSRF or Origin cannot either", async () => {
    const b = await login("t-lht");
    const instance = await openInstance(b, "counter");

    const viaBearer = await fetch(`${base}/api/act`, {
      method: "POST",
      headers: { ...asLht, "content-type": "application/json" },
      body: JSON.stringify({ instance, action: "add", params: {} }),
    });
    expect(viaBearer.status).toBe(403);

    const noCsrf = await post(b, "/api/act", { instance, action: "add", params: {} }, { "x-csrf-token": "" });
    expect(noCsrf.status).toBe(403);

    const badOrigin = await post(b, "/api/act", { instance, action: "add", params: {} }, { origin: "http://evil.test" });
    expect(badOrigin.status).toBe(403);

    const view = (await (await fetch(`${base}/api/view?app=counter`, { headers: asLht })).json()) as {
      view: { count: number };
    };
    expect(view.view.count).toBe(0);
  });

  it("changing app code invalidates old handles instead of inheriting them", async () => {
    const b = await login("t-lht");
    const instance = await openInstance(b, "counter");
    fs.writeFileSync(
      path.join(dir, "apps", "counter", "actions.ts"),
      `export function add() { return { events: [{ type: "add", data: null }], reply: "v2" }; }`,
    );
    host!.reload();
    const res = await post(b, "/api/act", { instance, action: "add", params: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("stale_instance");
    // A fresh page load gets a fresh handle bound to the new code.
    const fresh = await openInstance(b, "counter");
    expect(fresh).not.toBe(instance);
    const v2 = (await (await post(b, "/api/act", { instance: fresh, action: "add", params: {} })).json()) as { reply: string };
    expect(v2.reply).toBe("v2");
  });

  it("feishu callback closes the button→dispatch loop with a toast", async () => {
    const b = await login("t-lht");
    const card = (await (await fetch(`${base}/api/card?app=counter&page=main`, { headers: asLht })).json()) as {
      elements: Array<{ tag: string; actions?: Array<{ value: Record<string, unknown> }> }>;
    };
    const button = card.elements.find((e) => e.tag === "action")!.actions![0];
    const instance = await openInstance(b, "counter");
    const cb = await post(b, "/api/feishu/callback", { instance, action: { value: button.value } });
    const toast = (await cb.json()) as { toast: { type: string; content: string } };
    expect(toast.toast.type).toBe("success");
    expect(toast.toast.content).toBe("加了");
    const view = (await (await fetch(`${base}/api/view?app=counter`, { headers: asLht })).json()) as {
      view: { count: number };
    };
    expect(view.view.count).toBe(1);
  });

  it("shim endpoint refuses stale/unknown turn tokens", async () => {
    const res = await fetch(`${base}/api/shim/call`, {
      method: "POST",
      headers: { authorization: "Bearer shim_deadbeef", "content-type": "application/json" },
      body: JSON.stringify({ name: "x", args: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Trusted Host vs Agent View trust domains", () => {
  it("the page ships a sandboxed frame and never puts app data in the trusted document", async () => {
    const b = await login("t-lht");
    const res = await pageHtml(b);
    const html = await res.text();
    // The frame is sandboxed with scripts ONLY — no same-origin, no popups,
    // no top navigation, no forms.
    expect(html).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
    expect(html).not.toMatch(/allow-same-origin/);
    expect(html).not.toMatch(/allow-top-navigation/);
    expect(html).not.toMatch(/allow-popups/);
    expect(html).not.toMatch(/allow-forms/);
    // The trusted document renders no projection data at all.
    expect(html).not.toContain('data-slot=');
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("the view frame is data-free and cannot open a connection", async () => {
    const b = await login("t-lht");
    const res = await fetch(`${base}/view-frame`, { headers: { cookie: b.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Identical for everyone: it holds no app, no scope, no user, no handle.
    expect(html).not.toContain("counter");
    expect(html).not.toContain("lht");
    expect(html).not.toContain("instance");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("the CSRF secret and the instance handle never reach the frame", async () => {
    const b = await login("t-lht");
    const host = await (await pageHtml(b)).text();
    const boot = JSON.parse(/window.__BOOT = (\{.*?\});<\/script>/s.exec(host)![1].replace(/\\u003c/g, "<"));
    expect(typeof boot.instance).toBe("string");
    expect(typeof boot.csrf).toBe("string");
    // The Host script's boot message to the frame carries neither.
    const bootMsg = /port\.postMessage\(\{\s*\n?\s*t: 'boot',([\s\S]*?)\}\);/.exec(host)![1];
    expect(bootMsg).not.toContain("csrf");
    expect(bootMsg).not.toContain("instance");
  });

  it("app A cannot act as app B even with a forged payload", async () => {
    // Two apps, one session. The handle decides, so naming the other app in
    // the body changes nothing.
    const other = path.join(dir, "apps", "other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, "app.yaml"),
      `\napp: other\ntitle: 别的\nscope: per-user\nactions:\n  add: { title: 加, predicate: owner }\npages:\n  main:\n    layout: [a]\n    slots:\n      a: { widget: kv, bind: view }\n`,
    );
    fs.writeFileSync(path.join(other, "projection.ts"), `export function project(e: unknown[]) { return { n: e.length }; }`);
    fs.writeFileSync(path.join(other, "actions.ts"), `export function add() { return { events: [{ type: "add", data: null }], reply: "other" }; }`);
    host!.reload();

    const b = await login("t-lht");
    const counterInstance = await openInstance(b, "counter");
    const out = (await (
      await post(b, "/api/act", { instance: counterInstance, app: "other", scope: "lht", action: "add", params: {} })
    ).json()) as { ok: boolean; reply?: string };
    expect(out.ok).toBe(true);
    expect(out.reply).toBe("加了"); // counter's handler, not other's
    const otherView = (await (await fetch(`${base}/api/view?app=other`, { headers: asLht })).json()) as {
      view: { n: number };
    };
    expect(otherView.view.n).toBe(0);
  });

  it("agent routes bind from the handle, not from body app/scope", async () => {
    const b = await login("t-lht");
    // No instance at all: refused rather than resolved from the body.
    const noInstance = await post(b, "/api/agent/send", { app: "counter", scope: "lht", agent: "page", text: "hi" });
    expect(noInstance.status).toBe(409);
    const noCfg = await post(b, "/api/agent/config", { app: "counter", scope: "lht", agent: "page", adapter: "codex" });
    expect(noCfg.status).toBe(409);
  });

  it("a feishu callback whose card names another app is refused", async () => {
    const b = await login("t-lht");
    const instance = await openInstance(b, "counter");
    const res = await post(b, "/api/feishu/callback", {
      instance,
      action: { value: { app: "other", action: "add" } },
    });
    expect(res.status).toBe(403);
  });
});
