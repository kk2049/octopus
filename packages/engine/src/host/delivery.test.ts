/**
 * SEC-01 — controlled cross-scope transfer, through the real wiring.
 *
 * Real Host, real sandboxed app code, real CapabilityService, real Gate, real
 * delivery adapter, real mailbox writer. Every deny case asserts that the
 * MAILBOX ADAPTER was not called and that the target's log on disk is empty —
 * "the HTTP request returned 403" is not the property under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { Host } from "./server.js";
import { HostCapabilities } from "./capability-plane.js";
import { DeliveryBroker, ExplicitDirectory, type MailboxWriter } from "./delivery.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = path.join(pkgRoot, ".test-tmp");
// These are process-level integration cases: every test boots a real Host and
// invokes sandboxed app code. On the two-core deployment host a valid sequence
// can cross Vitest's 5s unit-test default, especially inside the full gate.
// Keep the assertions strict and give each case an honest wall-clock budget.
const DELIVERY_TEST_TIMEOUT_MS = 20_000;

let dir: string;
let host: Host | null = null;
let base = "";
let svc: CapabilityService;
let directory: ExplicitDirectory;
let plane: HostCapabilities;
/** Every call that reached the mailbox writer, i.e. every attempted write. */
let mailboxCalls: Array<{ app: string; recipient: string; envelope: Record<string, unknown> }>;

/** Counts what the writer actually saw, so a deny is provably a non-call. */
class SpyBroker extends DeliveryBroker {
  attachMailbox(writer: MailboxWriter): void {
    super.attachMailbox(async (o) => {
      mailboxCalls.push({ app: o.app, recipient: o.recipient, envelope: { ...o.envelope } });
      return writer(o);
    });
  }
}

/** A trivial account Object: the anchor a delivery root is minted into. */
function accountObject(owner: string): Parameters<CapabilityService["registerObject"]>[0] {
  return {
    id: `account:${owner}`,
    kind: "account",
    binding: owner,
    metadata: { owner },
    operations: { whoami: { args: {}, effect: "observe" } },
    policy: () => ({ kind: "allow" as const }),
    adapter: async (b) => ({ owner: b }),
  };
}

function logFileOf(app: string, scope: string): string {
  return path.join(dir, "data", "apps", app, scope, "log.jsonl");
}

function eventsOf(app: string, scope: string): Array<Record<string, unknown>> {
  const file = logFileOf(app, scope);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface Setup {
  /**
   * Which delivery operations this deployment treats as authorised by a logged
   * in person pressing the button. Default (absent) = none, so every send
   * waits for a decision.
   */
  rootAutoAllow?: string[];
  /** Which delivery operations the app may apply for at all. */
  appRights?: string[];
  agentAutoAllow?: string[];
}

async function boot(setup: Setup = {}): Promise<void> {
  fs.mkdirSync(tmpRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(tmpRoot, "delivery-"));
  const appDir = path.join(dir, "apps", "post");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `
app: post
title: post
scope: per-user
actions:
  send:
    title: 发
    predicate: owner
    params:
      to: { type: string, required: true }
      title: { type: string, required: true }
      body: { type: string, required: true }
      delivery_id: { type: string, required: true }
  forge:
    title: 伪造
    predicate: owner
    params:
      to: { type: string, required: true }
  poke:
    title: 本地
    predicate: owner
pages:
  main:
    layout: [a]
    slots:
      a: { widget: kv, bind: view }
`,
  );
  fs.writeFileSync(
    path.join(appDir, "projection.ts"),
    `export function project(events: any[]) { return { n: events.length }; }`,
  );
  fs.writeFileSync(
    path.join(appDir, "actions.ts"),
    `export async function send(ctx: any, p: any) {
       const out = await ctx.capabilities.request("delivery", "send_report", {
         to: p.to, title: p.title, body: p.body, delivery_id: p.delivery_id,
       });
       return { events: [{ type: "sent", data: { to: p.to } }], reply: JSON.stringify(out) };
     }
     export async function forge(ctx: any, p: any) {
       // Every shape an app might try: a system-ish operation, a slot it was
       // never given, and the old return value.
       const a = await ctx.capabilities.request("delivery", "append_event", { to: p.to });
       const b = await ctx.capabilities.request("resources", "send_report", { to: p.to });
       return {
         events: [],
         reply: JSON.stringify({ a, b }),
         deliveries: [{ toScope: p.to, events: [{ type: "report_received", data: { from: "root" } }] }],
       };
     }
     export function poke() { return { events: [{ type: "poke", data: null }] }; }`,
  );

  mailboxCalls = [];
  svc = new CapabilityService();
  directory = new ExplicitDirectory(["alice", "bob", "carol"]);
  const accounts = new Map<string, string>();
  for (const u of ["alice", "bob", "carol"]) {
    svc.registerObject(accountObject(u));
    const ctx = svc.createContext("account-authority", { owner: u });
    svc.mintRoot(ctx, "resources", `account:${u}`, ["whoami"]);
    accounts.set(u, ctx);
  }
  const broker = new SpyBroker({
    service: svc,
    directory,
    rootAutoAllow: () => (setup.rootAutoAllow ?? []) as never,
  });
  plane = new HostCapabilities({
    service: svc,
    authorityFor: (username) => {
      const ctx = accounts.get(username);
      return ctx ? { contextId: ctx, slot: "resources" } : null;
    },
    appRequirements: () => ["whoami"],
    delivery: {
      authorityFor: (username, app, accountContextId) => broker.authorityFor(username, app, accountContextId),
      appRequirements: () => setup.appRights ?? ["send_report", "reply_report"],
      agentAutoAllow: () => setup.agentAutoAllow ?? [],
    },
  });

  host = new Host({
    port: 0,
    appsDir: path.join(dir, "apps"),
    dataDir: path.join(dir, "data"),
    users: { alice: { token: "t-alice" }, bob: { token: "t-bob" } },
    capabilities: plane,
    delivery: broker,
  });
  await host.start();
  base = host.boundUrl!;
}

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
  const html = await (await fetch(`${base}/a/post`, { headers: { cookie: b.cookie } })).text();
  return /"instance":"([0-9a-f]+)"/.exec(html)![1];
}

async function act(
  b: Browser,
  instance: string,
  action: string,
  params: unknown,
): Promise<{ ok?: boolean; reply?: string; message?: string; warnings?: string[] }> {
  const res = await fetch(`${base}/api/act`, {
    method: "POST",
    headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: base },
    body: JSON.stringify({ instance, action, params }),
  });
  return (await res.json()) as { ok?: boolean; reply?: string; message?: string; warnings?: string[] };
}

/**
 * Alice sends, with whatever the current setup allows. Returns the whole
 * response as text: a hostile recipient can be refused by the action's own
 * param schema OR by the Gate, and both are the same property here — nothing
 * was delivered.
 */
async function send(p: { to: string; title?: string; body?: string; delivery_id?: string }): Promise<string> {
  const b = await login("t-alice");
  const out = await act(b, await openInstance(b), "send", {
    to: p.to,
    title: p.title ?? "周报",
    body: p.body ?? "本周做了三件事",
    delivery_id: p.delivery_id ?? "d-1",
  });
  return JSON.stringify(out);
}

describe("SEC-01 · the happy path is an operation, not a return value", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
  beforeEach(async () => {
    await boot({ rootAutoAllow: ["send_report", "reply_report"] });
    directory.allowReceive("alice", "bob");
  });

  it("lands ONE canonical envelope in bob's mailbox, authored by the broker", async () => {
    const reply = await send({ to: "bob" });
    expect(reply).toContain("succeeded");
    const events = eventsOf("post", "bob");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "report_received",
      // Not `user:alice`: alice did not write in bob's log, the broker did on
      // her behalf after a decision. The provenance is in the author string.
      by: "system:delivery/alice",
      data: { delivery_id: "d-1", from: "alice", to: "bob", title: "周报", body: "本周做了三件事" },
    });
    // Alice's own log records the attempt, separately.
    expect(eventsOf("post", "alice").map((e) => e.type)).toEqual(["sent"]);
  });

  it("re-sending the same delivery_id leaves exactly one receipt", async () => {
    await send({ to: "bob", delivery_id: "d-42" });
    await send({ to: "bob", delivery_id: "d-42", body: "重发" });
    // The writer was reached twice — the second call is a legitimate retry —
    // but the mailbox holds one receipt, and it is the FIRST one.
    expect(mailboxCalls).toHaveLength(2);
    const events = eventsOf("post", "bob");
    expect(events).toHaveLength(1);
    expect((events[0].data as { body: string }).body).toBe("本周做了三件事");
  });

  it("concurrent sends of one delivery_id do not both land", async () => {
    const b = await login("t-alice");
    const inst = await openInstance(b);
    await Promise.all([
      act(b, inst, "send", { to: "bob", title: "t", body: "1", delivery_id: "race" }),
      act(b, inst, "send", { to: "bob", title: "t", body: "2", delivery_id: "race" }),
    ]);
    expect(eventsOf("post", "bob")).toHaveLength(1);
  });

  it("an app cannot forge an event type, a system author, or a second slot", async () => {
    const b = await login("t-alice");
    const out = await act(b, await openInstance(b), "forge", { to: "bob" });
    // `append_event` is not in the delivery Object's closed operation table,
    // and the app holds no `resources` right for send_report.
    expect(out.reply).toContain("denied");
    expect(mailboxCalls).toHaveLength(0);
    expect(eventsOf("post", "bob")).toEqual([]);
    // And the old `deliveries` return value is inert, loudly.
    expect(out.warnings?.[0]).toMatch(/no longer exists/);
  });
});

describe("SEC-01 · the recipient is a name resolved by a directory, never a path", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
  beforeEach(async () => {
    await boot({ rootAutoAllow: ["send_report", "reply_report"] });
    directory.allowReceive("alice", "bob");
  });

  const hostile = [
    "../tickets/shared",
    "../../outside",
    "/tmp/x",
    "..\\outside",
    "",
    "   ",
    "nobody",
    "bob/../carol",
    "b".repeat(200),
    "bob\0",
  ];

  for (const to of hostile) {
    it(`refuses "${to.slice(0, 24)}" without touching disk`, async () => {
      const reply = await send({ to });
      expect(reply).not.toContain("succeeded");
      expect(mailboxCalls).toHaveLength(0);
      // No scope directory anywhere under the data root but alice's own. (Her
      // log may or may not exist: an empty `to` is refused by the action's
      // param schema, before the handler runs at all.)
      const appRoot = path.join(dir, "data", "apps", "post");
      const scopes = fs.existsSync(appRoot) ? fs.readdirSync(appRoot).sort() : [];
      expect(scopes.filter((s) => s !== "alice")).toEqual([]);
      // And nothing outside it either.
      expect(fs.existsSync(path.join(dir, "data", "apps", "tickets"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "data", "outside"))).toBe(false);
    });
  }

  it("refuses a recipient whose mailbox never granted receipt (fail closed default)", async () => {
    const reply = await send({ to: "carol" });
    expect(reply).toContain("denied");
    expect(reply).toContain("没有授权接收");
    expect(mailboxCalls).toHaveLength(0);
    expect(eventsOf("post", "carol")).toEqual([]);
  });

  it("a revoked receive grant stops the next send", async () => {
    expect(await send({ to: "bob", delivery_id: "a" })).toContain("succeeded");
    directory.revokeReceive("alice", "bob");
    expect(await send({ to: "bob", delivery_id: "b" })).toContain("denied");
    expect(eventsOf("post", "bob")).toHaveLength(1);
  });

  it("refuses to send to oneself", async () => {
    const reply = await send({ to: "alice" });
    expect(reply).toContain("不能投递给自己");
    expect(mailboxCalls).toHaveLength(0);
  });
});

describe("SEC-01 · without a grant or an approval, the adapter is never reached", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
  it("an app with no delivery right is denied and writes nothing", async () => {
    await boot({ appRights: [] });
    directory.allowReceive("alice", "bob");
    const reply = await send({ to: "bob" });
    expect(reply).toContain("denied");
    expect(mailboxCalls).toHaveLength(0);
    expect(eventsOf("post", "bob")).toEqual([]);
  });

  it("without auto-allow a send is a PendingCall, and only approval delivers it", async () => {
    await boot({});
    directory.allowReceive("alice", "bob");
    const reply = await send({ to: "bob", delivery_id: "p-1" });
    expect(reply).toContain("approval_required");
    expect(mailboxCalls).toHaveLength(0);
    expect(eventsOf("post", "bob")).toEqual([]);

    const pending = svc.listPending("alice");
    expect(pending).toHaveLength(1);
    // The card is server-authored and names the resolved recipient.
    expect(pending[0].target).toBe("bob");
    expect(pending[0].details.join("\n")).toContain("收件人：bob");
    // Bob cannot approve alice's disclosure of alice's content.
    expect((await svc.approve(pending[0].id, "bob")).status).toBe("denied");
    expect(mailboxCalls).toHaveLength(0);

    expect((await svc.approve(pending[0].id, "alice")).status).toBe("succeeded");
    expect(eventsOf("post", "bob")).toHaveLength(1);
  });

  it("an approval is bound to the exact call: changed body or recipient does not ride it", async () => {
    await boot({});
    directory.allowReceive("alice", "bob");
    directory.allowReceive("alice", "carol");
    await send({ to: "bob", body: "原文", delivery_id: "p-2" });
    const first = svc.listPending("alice")[0];

    // Same intent, different content → a SECOND card, not a reuse of the first.
    await send({ to: "bob", body: "改过的正文", delivery_id: "p-2" });
    await send({ to: "carol", body: "原文", delivery_id: "p-2" });
    expect(svc.listPending("alice")).toHaveLength(3);
    expect(mailboxCalls).toHaveLength(0);

    // Approving the first delivers the first, unchanged.
    expect((await svc.approve(first.id, "alice")).status).toBe("succeeded");
    expect(mailboxCalls).toHaveLength(1);
    expect(mailboxCalls[0].envelope).toMatchObject({ to: "bob", body: "原文" });
    expect(eventsOf("post", "carol")).toEqual([]);
  });

  it("approving twice replays the recorded result instead of delivering again", async () => {
    await boot({});
    directory.allowReceive("alice", "bob");
    await send({ to: "bob", delivery_id: "p-3" });
    const id = svc.listPending("alice")[0].id;
    expect((await svc.approve(id, "alice")).status).toBe("succeeded");
    expect((await svc.approve(id, "alice")).status).toBe("succeeded");
    expect(mailboxCalls).toHaveLength(1);
    expect(eventsOf("post", "bob")).toHaveLength(1);
  });

  it("a rejected send never reaches the mailbox", async () => {
    await boot({});
    directory.allowReceive("alice", "bob");
    await send({ to: "bob", delivery_id: "p-4" });
    const id = svc.listPending("alice")[0].id;
    expect(svc.reject(id, "alice")).toBe(true);
    expect(mailboxCalls).toHaveLength(0);
    expect(eventsOf("post", "bob")).toEqual([]);
  });
});

describe("SEC-01 · an agent sending on Alice's behalf never sends unsupervised", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
  /**
   * The deployment has opened the human path: Alice pressing 发送 is itself the
   * authorisation. That must not carry over to her agent — terms attenuate down
   * the derive chain, so an AgentRun (and every ControllerRun it spawns) is
   * capped at nothing regardless of what the root allows.
   */
  async function agentRun(): Promise<{ request: (op: string, args: Record<string, unknown>) => Promise<{ status: string }> }> {
    const app = plane.openApp({ username: "alice", app: "post", scope: "alice", digest: "d1" })!;
    const agent = (await plane.openAgentRun({
      username: "alice",
      app: "post",
      agent: "assistant",
      parentContextId: app,
    }))!;
    const run = (await plane.openControllerRun({
      username: "alice",
      app: "post",
      action: "send",
      parentContextId: agent.contextId,
    }))!;
    return { request: (op, args) => run.caps.request("delivery", op, args) as Promise<{ status: string }> };
  }

  it("queues an approval even where a human click would have sent outright", async () => {
    await boot({ rootAutoAllow: ["send_report", "reply_report"] });
    directory.allowReceive("alice", "bob");
    // The human path is open: this exact call sends with no card.
    expect(await send({ to: "bob", delivery_id: "human-1" })).toContain('"ok":true');
    expect(mailboxCalls).toHaveLength(1);

    const run = await agentRun();
    const out = await run.request("send_report", {
      to: "bob",
      title: "周报",
      body: "本周做了三件事",
      delivery_id: "agent-1",
    });
    expect(out.status).toBe("approval_required");
    expect(mailboxCalls).toHaveLength(1);
    expect(eventsOf("post", "bob")).toHaveLength(1);

    // …and only Alice's decision delivers it.
    const pending = svc.listPending("alice");
    expect(pending).toHaveLength(1);
    expect((await svc.approve(pending[0].id, "alice")).status).toBe("succeeded");
    expect(mailboxCalls).toHaveLength(2);
  });

  it("with no receive grant the agent's send is denied outright, card or not", async () => {
    await boot({ rootAutoAllow: ["send_report", "reply_report"] });
    const run = await agentRun();
    const out = await run.request("send_report", {
      to: "bob",
      title: "周报",
      body: "x",
      delivery_id: "agent-2",
    });
    expect(out.status).toBe("denied");
    expect(svc.listPending("alice")).toHaveLength(0);
    expect(mailboxCalls).toHaveLength(0);
  });
});

describe("SEC-01 · a Host with no broker cannot transfer at all", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
  it("denies, because there is no delivery slot to hold anything", async () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    dir = fs.mkdtempSync(path.join(tmpRoot, "delivery-off-"));
    const appDir = path.join(dir, "apps", "post");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "app.yaml"),
      `app: post\ntitle: post\nscope: per-user\nactions:\n  send: { title: 发, predicate: owner, params: { to: { type: string, required: true }, title: { type: string, required: true }, body: { type: string, required: true }, delivery_id: { type: string, required: true } } }\npages:\n  main: { layout: [a], slots: { a: { widget: kv, bind: view } } }\n`,
    );
    fs.writeFileSync(path.join(appDir, "projection.ts"), `export function project() { return {}; }`);
    fs.writeFileSync(
      path.join(appDir, "actions.ts"),
      `export async function send(ctx: any, p: any) {
         const out = await ctx.capabilities.request("delivery", "send_report", {
           to: p.to, title: p.title, body: p.body, delivery_id: p.delivery_id,
         });
         return { events: [], reply: JSON.stringify(out) };
       }`,
    );
    mailboxCalls = [];
    svc = new CapabilityService();
    const ctx = svc.createContext("account-authority", { owner: "alice" });
    svc.registerObject(accountObject("alice"));
    svc.mintRoot(ctx, "resources", "account:alice", ["whoami"]);
    host = new Host({
      port: 0,
      appsDir: path.join(dir, "apps"),
      dataDir: path.join(dir, "data"),
      users: { alice: { token: "t-alice" } },
      capabilities: new HostCapabilities({
        service: svc,
        authorityFor: () => ({ contextId: ctx, slot: "resources" }),
        appRequirements: () => ["whoami"],
      }),
    });
    await host.start();
    base = host.boundUrl!;
    const reply = await send({ to: "bob" });
    expect(reply).toContain("denied");
    expect(eventsOf("post", "bob")).toEqual([]);
  });
});
