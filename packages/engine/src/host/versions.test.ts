/**
 * SEC-02 — a trusted first-party app updates without re-asking for consent,
 * but never runs new code under an old running identity.
 *
 * The defect this pins: `onSourceChange` returned early for `.ts` files, so a
 * code edit re-imported new code on the next call while the instance handle,
 * the App/Agent Context and every undecided approval were the previous
 * version's. The fix moves the version switch to the point of use, so no
 * watcher timing decides anything — and both are exercised here, the lazy path
 * and a real `fs.watch`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Host } from "./server.js";
import { HostCapabilities } from "./capability-plane.js";
import { GrantLedger, contractDigestOf, versionOf } from "./versions.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");

let dir: string;
let appDir: string;
let host: Host | null = null;
let base = "";
let svc: CapabilityService;
let plane: HostCapabilities;
let ledger: GrantLedger;
let hits: Array<{ operation: string; args: Record<string, unknown> }>;
/** Config-shaped declarations, mutable so a test can publish a new contract. */
let declared: { operations: string[]; autoAllow: string[]; publisher: string };

function deviceObject(owner: string): Parameters<CapabilityService["registerObject"]>[0] {
  return {
    id: `device:${owner}`,
    kind: "device",
    binding: owner,
    metadata: { owner },
    operations: {
      read_file: { args: { path: { type: "string", required: true } }, effect: "read" },
      exec: { args: { command: { type: "string", required: true } }, effect: "execute" },
    },
    policy: (i) => {
      const a = i.approval;
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
      if (i.terms.autoAllow.includes(i.operation)) return { kind: "allow" as const };
      return {
        kind: "approval_required" as const,
        summary: { title: i.operation, target: owner, details: [], allowedApprover: owner },
      };
    },
    adapter: async (_b, operation, args) => {
      hits.push({ operation, args: args as Record<string, unknown> });
      return { ok: true };
    },
  };
}

const APP_YAML = `
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
`;

const ACTIONS_V1 = `export async function peek(ctx: any, p: any) {
  const out = await ctx.capabilities.request("resources", "read_file", { path: p.path });
  return { events: [], reply: "v1:" + JSON.stringify(out) };
}
export async function run(ctx: any, p: any) {
  const out = await ctx.capabilities.request("resources", "exec", { command: p.command });
  return { events: [], reply: "v1:" + JSON.stringify(out) };
}`;

const ACTIONS_V2 = ACTIONS_V1.replace(/v1:/g, "v2:");

async function boot(): Promise<void> {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "versions-"));
  appDir = path.join(dir, "apps", "probe");
  fs.mkdirSync(path.join(appDir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.yaml"), APP_YAML);
  fs.writeFileSync(path.join(appDir, "projection.ts"), `export function project() { return { v: 1 }; }`);
  fs.writeFileSync(path.join(appDir, "actions.ts"), ACTIONS_V1);

  hits = [];
  declared = { operations: ["read_file", "exec"], autoAllow: ["read_file"], publisher: "first-party" };
  svc = new CapabilityService();
  svc.registerObject(deviceObject("lht"));
  const accountCtx = svc.createContext("account-authority", { owner: "lht" });
  svc.mintRoot(accountCtx, "resources", "device:lht", ["read_file", "exec"]);

  ledger = new GrantLedger();
  plane = new HostCapabilities({
    service: svc,
    authorityFor: (u) => (u === "lht" ? { contextId: accountCtx, slot: "resources" } : null),
    appRequirements: () => declared.operations,
    appAutoAllow: () => declared.autoAllow,
    publisherOf: () => declared.publisher,
    grants: ledger,
  });
  // The deployment's authorisation act: a human wrote the config.
  ledger.seed(plane.contractOf("probe"));

  host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { lht: { token: "t-lht" } },
    capabilities: plane,
  });
  await host.start();
  base = host.boundUrl!;
}

beforeEach(boot);
afterEach(() => {
  host?.stop();
  host = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Browser {
  cookie: string;
  csrf: string;
}

async function login(): Promise<Browser> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: "t-lht" }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `v3s=${/v3s=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /v3csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

async function openInstance(b: Browser): Promise<string> {
  const html = await (await fetch(`${base}/a/probe`, { headers: { cookie: b.cookie } })).text();
  return /"instance":"([0-9a-f]+)"/.exec(html)?.[1] ?? "";
}

async function act(
  b: Browser,
  instance: string,
  action: string,
  params: unknown,
): Promise<{ ok?: boolean; code?: string; reply?: string; message?: string }> {
  const res = await fetch(`${base}/api/act`, {
    method: "POST",
    headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
    body: JSON.stringify({ instance, action, params }),
  });
  return (await res.json()) as { ok?: boolean; code?: string; reply?: string; message?: string };
}

/** mtime granularity is coarse enough on some filesystems to matter. */
function write(rel: string, content: string): void {
  const file = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
}

describe("SEC-02 · a code change rotates the running identity, and only that", () => {
  it("editing actions.ts kills the handle and the Context, but not the grant", async () => {
    const b = await login();
    const instance = await openInstance(b);
    expect((await act(b, instance, "peek", { path: "/a" })).reply).toContain("v1:");

    const before = ledger.forApp("probe")!;
    write("actions.ts", ACTIONS_V2);

    // The stale handle is refused — no watcher had to fire for this.
    const stale = await act(b, instance, "peek", { path: "/a" });
    expect(stale.code).toBe("stale_code");

    // The user was not asked for anything: same grant, same digest, same status.
    const after = ledger.forApp("probe")!;
    expect(after.contractDigest).toBe(before.contractDigest);
    expect(after.grantedAt).toBe(before.grantedAt);
    expect(plane.contractStatus("probe").needsAuthorization).toBe(false);

    // A fresh launch re-derives silently and runs the new code.
    const fresh = await openInstance(b);
    expect(fresh).not.toBe(instance);
    expect((await act(b, fresh, "peek", { path: "/a" })).reply).toContain("v2:");
  });

  it("a pending approval created by the old version cannot be approved after the change", async () => {
    const b = await login();
    const instance = await openInstance(b);
    expect((await act(b, instance, "run", { command: "ls" })).reply).toContain("approval_required");
    const pending = svc.listPending("lht");
    expect(pending).toHaveLength(1);
    expect(hits).toHaveLength(0);

    write("actions.ts", ACTIONS_V2);
    // Force the switch the way a request would.
    host!.digestFor("probe");

    expect((await svc.approve(pending[0].id, "lht")).status).not.toBe("succeeded");
    expect(hits).toHaveLength(0);

    // And the new version can ask again, and that one is approvable.
    const fresh = await openInstance(b);
    expect((await act(b, fresh, "run", { command: "ls" })).reply).toContain("approval_required");
    const again = svc.listPending("lht");
    expect(again).toHaveLength(1);
    expect((await svc.approve(again[0].id, "lht")).status).toBe("succeeded");
    expect(hits).toEqual([{ operation: "exec", args: { command: "ls" } }]);
  });

  it("a presentation-only edit changes no code identity and keeps handles alive", async () => {
    const b = await login();
    const instance = await openInstance(b);
    const v1 = host!.versionFor("probe")!;

    write("pages/extra.yaml", "layout: [a]\nslots:\n  a: { widget: kv, bind: view }\n");
    const v2 = host!.versionFor("probe")!;
    expect(v2.code).toBe(v1.code);
    expect(v2.presentation).not.toBe(v1.presentation);

    // The handle still works, and nothing was asked of the user.
    expect((await act(b, instance, "peek", { path: "/a" })).reply).toContain("v1:");
    expect(plane.contractStatus("probe").needsAuthorization).toBe(false);
  });

  it("prompts are execution material: changing one rotates the identity", async () => {
    const before = host!.versionFor("probe")!;
    write("prompts/mailer.md", "you are a mailer");
    const after = host!.versionFor("probe")!;
    expect(after.code).not.toBe(before.code);
    expect(after.exec).not.toBe(before.exec);
  });
});

describe("SEC-02 · a widened permission contract fails closed", () => {
  it("a newly declared operation is not derived until it is authorised", async () => {
    // Start narrower than the object holds, and grant exactly that.
    declared = { operations: ["read_file"], autoAllow: ["read_file"], publisher: "first-party" };
    ledger.revoke("probe");
    ledger.seed(plane.contractOf("probe"));

    const b = await login();
    expect((await act(b, await openInstance(b), "run", { command: "ls" })).reply).toContain("denied");
    expect(hits).toHaveLength(0);

    // A new release asks for more. Declaring is not being granted.
    declared = { operations: ["read_file", "exec"], autoAllow: ["read_file"], publisher: "first-party" };
    const status = plane.contractStatus("probe");
    expect(status.ok).toBe(false);
    expect(status.missingOperations).toEqual(["exec"]);
    expect(status.needsAuthorization).toBe(true);

    const still = await act(b, await openInstance(b), "run", { command: "ls" });
    expect(still.reply).toContain("denied");
    expect(hits).toHaveLength(0);

    // Somebody authorises the new contract; only then does it derive.
    ledger.authorize(plane.contractOf("probe"));
    expect(plane.contractStatus("probe").ok).toBe(true);
    expect((await act(b, await openInstance(b), "run", { command: "ls" })).reply).toContain("approval_required");
  });

  it("a widened auto-allow fails closed too: the operation still needs a click", async () => {
    declared = { operations: ["read_file", "exec"], autoAllow: ["read_file", "exec"], publisher: "first-party" };
    const status = plane.contractStatus("probe");
    expect(status.missingAutoAllow).toEqual(["exec"]);

    const b = await login();
    const out = await act(b, await openInstance(b), "run", { command: "ls" });
    expect(out.reply).toContain("approval_required");
    expect(hits).toHaveLength(0);
  });

  it("narrowing takes effect immediately and asks nobody", async () => {
    declared = { operations: ["read_file"], autoAllow: [], publisher: "first-party" };
    expect(plane.contractStatus("probe").ok).toBe(true);
    const b = await login();
    // `exec` was dropped from the declaration, so it is not derived.
    expect((await act(b, await openInstance(b), "run", { command: "ls" })).reply).toContain("denied");
    // And `read_file` lost its auto-allow, so it now asks.
    expect((await act(b, await openInstance(b), "peek", { path: "/a" })).reply).toContain("approval_required");
    expect(hits).toHaveLength(0);
  });

  it("a publisher change inherits nothing, even with the same app name", async () => {
    declared = { operations: ["read_file", "exec"], autoAllow: ["read_file"], publisher: "somebody-else" };
    const status = plane.contractStatus("probe");
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("publisher");

    const b = await login();
    expect((await act(b, await openInstance(b), "peek", { path: "/a" })).reply).toContain("denied");
    expect(hits).toHaveLength(0);
  });

  it("both digests and the publisher ride on the Context, so audit can explain a call", async () => {
    const b = await login();
    await act(b, await openInstance(b), "run", { command: "ls" });
    const pending = svc.listPending("lht");
    expect(pending).toHaveLength(1);
    // `requestedBy` is the Context metadata the kernel recorded. It answers
    // both SEC-02 questions: which code ran, under which permission contract.
    expect(pending[0].requestedBy.digest).toBe(host!.versionFor("probe")!.code);
    expect(pending[0].requestedBy.contract).toBe(plane.contractDigestFor("probe"));
    expect(pending[0].requestedBy.publisher).toBe("first-party");
  });

  it("the contract digest ignores code and moves only with the contract", async () => {
    const before = plane.contractDigestFor("probe");
    write("actions.ts", ACTIONS_V2);
    host!.digestFor("probe");
    expect(plane.contractDigestFor("probe")).toBe(before);

    declared = { ...declared, operations: [...declared.operations, "exec"] };
    expect(contractDigestOf(plane.contractOf("probe"))).not.toBe(before);
  });
});

describe("SEC-02 · a reload that cannot be proven consistent halts the app", () => {
  it("a broken declaration alone keeps serving the last good release", async () => {
    const b = await login();
    const instance = await openInstance(b);
    write("app.yaml", "app: probe\ntitle: [broken");
    expect(host!.isHalted("probe")).toBe(false);
    expect((await act(b, instance, "peek", { path: "/a" })).reply).toContain("v1:");
  });

  it("a broken declaration PLUS moved code halts rather than mixing versions", async () => {
    const b = await login();
    const instance = await openInstance(b);
    write("actions.ts", ACTIONS_V2);
    write("app.yaml", "app: probe\ntitle: [broken");

    expect(host!.isHalted("probe")).toBe(true);
    // No version can be run: the handle is dead and a new one cannot be opened.
    const out = await act(b, instance, "peek", { path: "/a" });
    expect(out.ok).toBe(false);
    expect(hits).toHaveLength(0);

    // Fixing the declaration brings it back, on the new code.
    write("app.yaml", APP_YAML);
    expect(host!.isHalted("probe")).toBe(false);
    expect((await act(b, await openInstance(b), "peek", { path: "/a" })).reply).toContain("v2:");
  });

  it("halting invalidates the approvals the old version had queued", async () => {
    const b = await login();
    const instance = await openInstance(b);
    expect((await act(b, instance, "run", { command: "ls" })).reply).toContain("approval_required");
    const pending = svc.listPending("lht");
    expect(pending).toHaveLength(1);

    // Halt: the declaration breaks AND the executable files move, so no version
    // can be named. Halting leaves `code` where it was, so an invalidation keyed
    // on the recorded digest matched every live instance and dropped none —
    // which left this card approvable into a version nobody can identify.
    write("actions.ts", ACTIONS_V2);
    write("app.yaml", "app: probe\ntitle: [broken");
    expect(host!.isHalted("probe")).toBe(true);

    expect((await svc.approve(pending[0].id, "lht")).status).not.toBe("succeeded");
    expect(hits).toHaveLength(0);
  });

  it("a halt during a handler's await voids that call rather than finishing it", async () => {
    const b = await login();
    const instance = await openInstance(b);
    // The handler asks for an approval-required operation, so it is still
    // awaiting when the files move underneath it.
    const inflight = act(b, instance, "run", { command: "sleep" });
    await new Promise((r) => setTimeout(r, 20));
    write("actions.ts", ACTIONS_V2);
    write("app.yaml", "app: probe\ntitle: [broken");
    host!.isHalted("probe");
    const out = await inflight;
    // Either the dispatch never started or it refused to finish; what must not
    // happen is a reply attributed to a version we cannot name.
    expect(out.ok).toBe(false);
    expect(hits).toHaveLength(0);
  });
});

describe("SEC-02 · with a real watcher", () => {
  it("drops an asynchronously failed watcher instead of crashing the Host", () => {
    const watchers = (host as unknown as { watchers: fs.FSWatcher[] }).watchers;
    const failed = watchers[0];
    expect(failed).toBeDefined();

    expect(() => failed!.emit("error", new Error("watch backend failed"))).not.toThrow();

    expect((host as unknown as { watchers: fs.FSWatcher[] }).watchers).not.toContain(failed);
  });

  it("two quick releases end on the last one, with no leaked watchers", async () => {
    const b = await login();
    await openInstance(b);
    const watchersBefore = (host as unknown as { watchers: unknown[] }).watchers.length;

    write("actions.ts", ACTIONS_V2);
    write("actions.ts", ACTIONS_V2.replace(/v2:/g, "v3:"));
    // Longer than the Host's 250ms reload debounce.
    await new Promise((r) => setTimeout(r, 700));

    expect(host!.versionFor("probe")!.code).toBe(versionOf(appDir).code);
    const fresh = await openInstance(b);
    expect((await act(b, fresh, "peek", { path: "/a" })).reply).toContain("v3:");
    // setupWatchers closes the previous set before rebuilding it.
    expect((host as unknown as { watchers: unknown[] }).watchers.length).toBe(watchersBefore);
  });
});

describe("SEC-02 · the live app directory is not writable from a request", () => {
  it("a non-admin cannot save app files, and the digest does not move", async () => {
    const before = host!.versionFor("probe")!.code;
    const b = await login();
    const res = await fetch(`${base}/api/factory/save`, {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
      body: JSON.stringify({ app: "probe", file: "actions.ts", content: ACTIONS_V2 }),
    });
    expect(res.status).toBe(403);
    expect(host!.versionFor("probe")!.code).toBe(before);
    expect(fs.readFileSync(path.join(appDir, "actions.ts"), "utf8")).toBe(ACTIONS_V1);
  });
});
