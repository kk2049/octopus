/**
 * The v3 derivation chain, end to end through a real Host, a real sandboxed
 * app and a real kernel Object.
 *
 * The App here declares more than the account holds and the Controller
 * declares more than the App holds — which is the normal case, since a
 * manifest is an application, not a grant. What each layer can actually do is
 * the intersection, materialised once at each lifecycle boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Host } from "./server.js";
import { HostCapabilities } from "./capability-plane.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let host: Host | null = null;
let base = "";
let svc: CapabilityService;
let hits: Array<{ owner: string; operation: string; args: Record<string, unknown> }>;

function fakeDeviceObject(owner: string): Parameters<CapabilityService["registerObject"]>[0] {
  return {
    id: `device:${owner}`,
    kind: "device",
    binding: owner,
    metadata: { owner },
    operations: {
      read_file: { args: { path: { type: "string", required: true } }, effect: "read" },
      exec: { args: { command: { type: "string", required: true } }, effect: "modify" },
    },
    policy: (i) => {
      if (i.effect !== "modify") return { kind: "allow" as const };
      const a = i.approval;
      // Same shape as the real Runner policy: evidence is accepted only when
      // it names exactly this call, and only from the Object's owner.
      if (
        a
        && a.objectId === i.object.id
        && a.operation === i.operation
        && a.argsHash === i.argsHash
        && a.contextId === i.context.id
        && a.slot === i.slot
        && a.approver === owner
      ) {
        return { kind: "allow" as const };
      }
      return {
        kind: "approval_required" as const,
        summary: { title: "exec", target: owner, details: [], allowedApprover: owner },
      };
    },
    adapter: async (b, operation, args) => {
      hits.push({ owner: b as string, operation, args: args as Record<string, unknown> });
      return { ok: true, from: b };
    },
  };
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "plane-"));
  const appDir = path.join(dir, "apps", "probe");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: probe
title: probe
scope: per-user
actions:
  peek: { title: 读, predicate: owner, params: { path: { type: string, required: true } } }
  run: { title: 跑, predicate: owner, params: { command: { type: string, required: true } } }
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`,
  );
  fs.writeFileSync(path.join(appDir, "projection.ts"), `export function project() { return {}; }`);
  fs.writeFileSync(
    path.join(appDir, "actions.ts"),
    `export async function peek(ctx: any, p: any) {
       const out = await ctx.capabilities.request("resources", "read_file", { path: p.path });
       return { events: [], reply: JSON.stringify(out) };
     }
     export async function run(ctx: any, p: any) {
       const out = await ctx.capabilities.request("resources", "exec", { command: p.command });
       return { events: [], reply: JSON.stringify(out) };
     }`,
  );

  hits = [];
  svc = new CapabilityService();
  svc.registerObject(fakeDeviceObject("lht"));
  svc.registerObject(fakeDeviceObject("bob"));
  // One account authority per user, minted here by the trusted control plane
  // and handed to the plane as (context, slot) — never re-minted by it.
  const accounts = new Map<string, string>();
  for (const u of ["lht", "bob"]) {
    const ctx = svc.createContext("account-authority", { owner: u });
    svc.mintRoot(ctx, "resources", `device:${u}`, ["read_file", "exec"]);
    accounts.set(u, ctx);
  }
  const plane = new HostCapabilities({
    service: svc,
    authorityFor: (username) => {
      const ctx = accounts.get(username);
      return ctx ? { contextId: ctx, slot: "resources" } : null;
    },
    // The app applies for both; the account holds both, so the App Context
    // gets both. The Controller for `peek` applies for read only.
    appRequirements: () => ["read_file", "exec"],
    // Reads unsupervised for THIS app; the plane default is now the opposite.
    appAutoAllow: () => ["read_file"],
    controllerRequirements: (_app, action) => (action === "peek" ? ["read_file"] : ["read_file", "exec"]),
  });

  host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t-lht" }, bob: { token: "t-bob" } },
    capabilities: plane,
  });
  await host.start();
  base = host.boundUrl!;
});

afterEach(() => {
  host?.stop();
  host = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Browser {
  cookie: string;
  csrf: string;
}

async function login(token: string): Promise<Browser> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `v3s=${/v3s=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /v3csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

async function openInstance(b: Browser): Promise<string> {
  const html = await (await fetch(`${base}/a/probe`, { headers: { cookie: b.cookie } })).text();
  return /"instance":"([0-9a-f]+)"/.exec(html)![1];
}

async function act(b: Browser, instance: string, action: string, params: unknown): Promise<{ reply?: string }> {
  const res = await fetch(`${base}/api/act`, {
    method: "POST",
    headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
    body: JSON.stringify({ instance, action, params }),
  });
  return (await res.json()) as { reply?: string };
}

describe("v3 App → Controller → resource", () => {
  it("a handler's capability reaches the owner's Object, never anyone else's", async () => {
    const b = await login("t-lht");
    const out = await act(b, await openInstance(b), "peek", { path: "/home/bob/secrets" });
    expect(out.reply).toContain("succeeded");
    expect(hits).toEqual([{ owner: "lht", operation: "read_file", args: { path: "/home/bob/secrets" } }]);
  });

  it("a Controller that did not declare a right cannot use it, even though the App holds it", async () => {
    const b = await login("t-lht");
    const instance = await openInstance(b);
    // `peek` declared read only. Its handler asking for exec is denied at the
    // ControllerRun's slot, before any policy or approval is considered.
    fs.writeFileSync(
      path.join(dir, "apps", "probe", "actions.ts"),
      `export async function peek(ctx: any) {
         const out = await ctx.capabilities.request("resources", "exec", { command: "id" });
         return { events: [], reply: JSON.stringify(out) };
       }
       export function run() { return { events: [], reply: "" }; }`,
    );
    host!.reload();
    const fresh = await login("t-lht");
    const out = await act(fresh, await openInstance(fresh), "peek", { path: "/x" });
    expect(out.reply).toContain("denied");
    expect(hits).toHaveLength(0);
  });

  it("a mutating call becomes a PendingCall and reaches nothing until approved", async () => {
    const b = await login("t-lht");
    const out = await act(b, await openInstance(b), "run", { command: "ls" });
    expect(out.reply).toContain("approval_required");
    expect(hits).toHaveLength(0);
    const pending = svc.listPending("lht");
    expect(pending).toHaveLength(1);
    // Bob cannot approve lht's call.
    expect((await svc.approve(pending[0].id, "bob")).status).toBe("denied");
    expect(hits).toHaveLength(0);
    expect((await svc.approve(pending[0].id, "lht")).status).toBe("succeeded");
    expect(hits.map((h) => `${h.owner}:${h.operation}`)).toEqual(["lht:exec"]);
  });

  it("bob's app instance reaches bob's device only", async () => {
    const b = await login("t-bob");
    await act(b, await openInstance(b), "peek", { path: "/x" });
    expect(hits.map((h) => h.owner)).toEqual(["bob"]);
  });

  it("a user with no account authority gets an App Context that can do nothing", async () => {
    const noAuth = new Host({
      port: 0,
      appsDir: path.join(dir, "apps"),
      dataDir: path.join(dir, "data2"),
      users: { ghost: { token: "t-ghost" } },
      capabilities: new HostCapabilities({
        service: svc,
        authorityFor: () => null,
        appRequirements: () => ["read_file"],
        appAutoAllow: () => ["read_file"],
      }),
    });
    await noAuth.start();
    const prev = base;
    base = noAuth.boundUrl!;
    try {
      const b = await login("t-ghost");
      const out = await act(b, await openInstance(b), "peek", { path: "/x" });
      expect(out.reply).toContain("denied");
      expect(hits).toHaveLength(0);
    } finally {
      base = prev;
      noAuth.stop();
    }
  });
});

describe("one sandbox process per handler invocation", () => {
  // This assertion intentionally pays for three cold SES child processes. On
  // the 2-core deployment host that takes 6–9s; keep the timeout local so the
  // rest of the suite retains Vitest's strict 5s default.
  it("no dispatch inherits another dispatch's runtime, same user or not", async () => {
    // Module-scope state is the observable. Every dispatch starts at 1: the
    // handler process is created for that one invocation and reaped when it
    // returns, so there is no residency for a leftover timer to write from.
    fs.writeFileSync(
      path.join(dir, "apps", "probe", "actions.ts"),
      `let seen = 0;
       export function peek() { seen++; return { events: [], reply: "count:" + seen }; }
       export function run() { return { events: [], reply: "" }; }`,
    );
    host!.reload();
    const lht = await login("t-lht");
    const bob = await login("t-bob");
    const a1 = await act(lht, await openInstance(lht), "peek", { path: "/a" });
    const a2 = await act(lht, await openInstance(lht), "peek", { path: "/a" });
    const b1 = await act(bob, await openInstance(bob), "peek", { path: "/a" });
    expect([a1.reply, a2.reply, b1.reply]).toEqual(["count:1", "count:1", "count:1"]);
  }, 30_000);
});
