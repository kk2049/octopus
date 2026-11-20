/**
 * The operation transport over real HTTP: the 202 contract, the owner-scoped
 * operation API and stream, and the negative matrix.
 *
 * Every "cannot" case asserts the frame count as well as the status, because a
 * 403 that arrives after the frame went out is a report, not a denial.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { AgentInteractionCapabilities } from "../agent-interactions/capability.js";
import { narrowOwnSessionAppend } from "../permissions/session-hub-terms.helper.js";

const NOW = "2026-08-03T09:00:00.000Z";
const ALICE_SESSION = "aaaa1111-2222-3333-4444-555566667777";
const ADMIN_KEY = "admin-secret";

interface Frame {
  owner: string;
  operation: string;
  args: Record<string, unknown>;
}

let dir: string;
let store: Store;
let caps: RunnerCapabilities;
let interactionCaps: AgentInteractionCapabilities;
let unified: DashboardServer;
let legacy: DashboardServer;
let base: string;
let legacyBase: string;
let frames: Frame[];
let dtAlice: string;
let dtBob: string;

/** Flipped by the "laptop went away" case; the device is otherwise present. */
let deviceReachable = true;

function transportFor(frames: Frame[]): RunnerTransport {
  return {
    dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ owner, operation, args });
      if (!deviceReachable) throw new Error("device offline");
      return {
        ok: true,
        agent: args.source === "codex" ? "codex" : "claude",
        duration_ms: 1200,
        result_text: "OK",
        sessions: [],
        results: [],
      };
    },
    listDevices: () => [{ device: "laptop", online: true, created_at: NOW, last_seen_at: NOW }],
    isOnline: () => true,
    ping: async () => 2,
    disconnect: () => true,
  } as unknown as RunnerTransport;
}

function seedHome(root: string, sessionId: string): string {
  const proj = join(root, ".claude", "projects", "-work-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      sessionId,
      cwd: "/work/proj",
      timestamp: "2026-08-03T08:00:00.000Z",
      message: { role: "user", content: "开工" },
    }),
  );
  return root;
}

async function browser(host: string, token: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${host}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: host },
    body: JSON.stringify({ token }),
  });
  const raw = res.headers.get("set-cookie") ?? "";
  return {
    cookie: `octopus_sess=${/octopus_sess=([0-9a-f]{64})/.exec(raw)![1]}`,
    csrf: /octopus_csrf=([0-9a-f]{64})/.exec(raw)![1],
  };
}

const post = (host: string, b: { cookie: string; csrf: string }, path: string, body: unknown) =>
  fetch(`${host}${path}`, {
    method: "POST",
    headers: { cookie: b.cookie, "content-type": "application/json", "x-csrf-token": b.csrf, origin: host },
    body: JSON.stringify(body),
  });

const postBearer = (path: string, token: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface OpView {
  id: string;
  status: string;
  live: boolean;
  operation: string;
  sessionId: string;
  message: string;
  detail?: string;
  pendingCallId?: string;
}

async function listOps(b: { cookie: string }, query = ""): Promise<OpView[]> {
  const res = await fetch(`${base}/api/sessions/operations${query}`, { headers: { cookie: b.cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { operations: OpView[] }).operations;
}

async function until(
  b: { cookie: string },
  id: string,
  pred: (o: OpView) => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<OpView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await listOps(b)).find((o) => o.id === id);
    if (hit && pred(hit)) return hit;
    if (Date.now() > deadline) throw new Error(`operation ${id} never ${what} (${hit?.status ?? "missing"})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Execution is no longer tied to the request that started it — wait for the record. */
const settle = (b: { cookie: string }, id: string) => until(b, id, (o) => !o.live, "settled");
const waitForPending = (b: { cookie: string }, id: string) =>
  until(b, id, (o) => Boolean(o.pendingCallId), "queued for approval");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sessops-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  dtAlice = mintDashboardToken(store, "alice");
  dtBob = mintDashboardToken(store, "bob");
  frames = [];
  const transport = transportFor(frames);
  caps = new RunnerCapabilities(store, transport);
  caps.ensureAccount("alice");
  caps.ensureAccount("bob");
  // These cases follow approval cards; since O1 a card for one's own session
  // needs the owner to have narrowed the default-silent append term.
  narrowOwnSessionAppend(store, caps, "alice");
  narrowOwnSessionAppend(store, caps, "bob");
  interactionCaps = new AgentInteractionCapabilities({
    service: caps.service,
    transport,
    userExists: (username) => Boolean(store.getUser(username)),
    hasDevice: (username) => store.listRunnerTokens(username).length > 0,
  });
  const homes: Record<string, string> = { alice: seedHome(join(dir, "alice"), ALICE_SESSION) };

  unified = createDashboardTestServer(store, caps, {
    port: 0,
    host: "127.0.0.1",
    authToken: ADMIN_KEY,
    sessionHubUi: "unified-v3",
    agentInteractions: interactionCaps,
    scanHomeFor: (u) => homes[u],
  });
  await unified.start();
  base = `http://127.0.0.1:${unified.port}`;

  // The transport mode still changes API response semantics, but neither
  // composition owns a legacy browser page any more.
  legacy = createDashboardTestServer(store, caps, {
    port: 0,
    host: "127.0.0.1",
    authToken: ADMIN_KEY,
    agentInteractions: interactionCaps,
    scanHomeFor: (u) => homes[u],
  });
  await legacy.start();
  legacyBase = `http://127.0.0.1:${legacy.port}`;
});

afterAll(async () => {
  await unified.stop();
  await legacy.stop();
  caps.service.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("provider interaction response transport", () => {
  it("dispatches one response only from the owner's live browser session", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const body = {
      username: "alice",
      device: "laptop",
      provider: "codex",
      session_id: ALICE_SESSION,
      interaction_id: "ai_test",
      response_json: JSON.stringify({ decision: "allow", answers: { q1: ["灰度"] } }),
    };
    const ok = await post(base, a, "/api/sessions/interaction", body);
    expect(ok.status).toBe(200);
    expect(frames).toEqual([{
      owner: "alice",
      operation: "respond_agent_interaction",
      args: expect.objectContaining({
        device: "laptop",
        provider: "codex",
        session_id: ALICE_SESSION,
        interaction_id: "ai_test",
      }),
    }]);

    frames.length = 0;
    const bearerOnly = await fetch(`${base}/api/sessions/interaction`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(bearerOnly.status).toBe(403);
    expect(frames).toHaveLength(0);
  });
});

describe("submit returns a record, not a socket", () => {
  it("answers 202 with an operation id, then runs owner self-service directly", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "跑一下",
      source: "claude",
      operation: "append_session",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operation_id: string; operation: OpView };
    expect(body.operation_id).toMatch(/^op_/);
    expect(body.operation.sessionId).toBe(ALICE_SESSION);
    // A reload reads the terminal record, not anything the page remembered.
    const done = await settle(a, body.operation_id);
    expect(done.status).toBe("succeeded");
    expect(done.pendingCallId).toBeFalsy();
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
  });

  it("accepts a prompt past the old 100,000-character schema cap up to the byte budget, and states the budget past it", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const prompt = `${"x".repeat(300 * 1024 - 4)}末尾`;
    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop", id: ALICE_SESSION, prompt, source: "claude", operation: "append_session",
    });
    expect(res.status).toBe(202);
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    expect((await settle(a, id)).status).toBe("succeeded");
    const sent = frames.find((f) => f.operation === "append_session");
    expect(String((sent?.args as { prompt?: unknown } | undefined)?.prompt)).toBe(prompt);

    const over = await post(base, a, "/api/sessions/append", {
      device: "laptop", id: ALICE_SESSION, prompt: "y".repeat(384 * 1024 + 1), source: "claude", operation: "append_session",
    });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error)
      .toBe("消息为 393217 字节（UTF-8），超过会话 prompt 预算 393216 字节（384 KiB）；请拆成多条或改为附件");
  });

  it("pages the operation list with next_before instead of stopping at the window", async () => {
    const a = await browser(base, dtAlice);
    const first = await (await fetch(`${base}/api/sessions/operations?limit=1`, { headers: { cookie: a.cookie } }))
      .json() as { operations: Array<{ id: string }>; next_before?: string };
    expect(first.operations).toHaveLength(1);
    expect(first.next_before).toBe(first.operations[0]!.id);
    const all = await (await fetch(`${base}/api/sessions/operations?limit=200`, { headers: { cookie: a.cookie } }))
      .json() as { operations: Array<{ id: string }>; next_before?: string };
    const walked: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await (await fetch(`${base}/api/sessions/operations?limit=1${before ? `&before=${before}` : ""}`, {
        headers: { cookie: a.cookie },
      })).json() as { operations: Array<{ id: string }>; next_before?: string };
      walked.push(...page.operations.map((op) => op.id));
      if (!page.next_before) break;
      before = page.next_before;
    }
    expect(all.next_before).toBeUndefined();
    expect(walked).toEqual(all.operations.map((op) => op.id));
  });

  it("records resume as resume — an unknown operation is refused, not folded into append", async () => {
    const a = await browser(base, dtAlice);
    const bad = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "x",
      operation: "resume",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("resume_session");

    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "恢复这条",
      source: "claude",
      operation: "resume_session",
    });
    expect(res.status).toBe(202);
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const rec = (await listOps(a)).find((o) => o.id === id)!;
    expect(rec.operation).toBe("resume_session");

    // …and the audit identity is separate, which is the whole reason the two
    // exist over one execution path.
    const audit = (await (
      await fetch(`${base}/api/permissions/audit?limit=50`, { headers: { cookie: a.cookie } })
    ).json()) as { records: Array<{ operation: string }> };
    expect(audit.records.some((r) => r.operation === "resume_session")).toBe(true);

    const card = caps.listPending("alice").find((p) => p.details.join(" ").includes("恢复这条"));
    if (card) caps.reject(card.id, "alice");
  });

  it("records takeover explicitly and freezes the cancel flag into direct dispatch", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "浏览器接手",
      source: "claude",
      operation: "takeover_session",
    });
    expect(res.status).toBe(202);
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const done = await settle(a, id);
    expect(done.operation).toBe("takeover_session");
    expect(done.status).toBe("succeeded");
    expect(done.pendingCallId).toBeFalsy();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      operation: "append_session",
      args: { id: ALICE_SESSION, source: "claude", takeover: true },
    });
  });

  it("routes an explicit Codex fallback as one bounded append with the fallback flag", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "额度耗尽，换备用账号",
      source: "codex",
      operation: "fallback_session",
    });
    expect(res.status).toBe(202);
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const done = await settle(a, id);
    expect(done.operation).toBe("fallback_session");
    expect(done.status).toBe("succeeded");
    expect(frames).toEqual([{
      owner: "alice",
      operation: "append_session",
      args: {
        device: "laptop",
        id: ALICE_SESSION,
        prompt: "额度耗尽，换备用账号",
        source: "codex",
        account_fallback: true,
        operation_id: id,
        input_receipt: true,
      },
    }]);
  });

  it("a codex session is recorded as codex and executed with source=codex", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "codex 续跑",
      source: "codex",
      operation: "append_session",
    });
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const done = await settle(a, id);
    expect(done.status).toBe("succeeded");
    expect(done.detail).toContain("codex");
    const sent = frames.filter((f) => f.operation === "append_session");
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({ source: "codex", device: "laptop" });
  });

  it("a laptop that goes away is a failure with a reason, never an 'unknown' to retry", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    deviceReachable = false;
    try {
      const res = await post(base, a, "/api/sessions/append", {
        device: "laptop",
        id: ALICE_SESSION,
        prompt: "笔记本关机了",
        source: "claude",
        operation: "append_session",
      });
      const { operation_id: id } = (await res.json()) as { operation_id: string };
      const done = await settle(a, id);
      expect(done.status).toBe("failed");
      expect(done.detail).toContain("offline");
    } finally {
      deviceReachable = true;
    }
  });
});

describe("the operation surface belongs to one account", () => {
  it("the shared admin key names no account, so it has no operation queue of its own", async () => {
    const res = await fetch(`${base}/api/sessions/operations`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.status).toBe(400);
    const stream = await fetch(`${base}/api/sessions/operations/stream`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(stream.status).toBe(400);
    await stream.text();
  });

  it("a plain user naming somebody else is refused, not widened", async () => {
    const b = await browser(base, dtBob);
    const res = await fetch(`${base}/api/sessions/operations?username=alice`, { headers: { cookie: b.cookie } });
    expect(res.status).toBe(403);
    const mine = await fetch(`${base}/api/sessions/operations`, { headers: { cookie: b.cookie } });
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { username: string; operations: OpView[] };
    expect(body.username).toBe("bob");
    expect(body.operations).toEqual([]);
  });

  it("a bearer may read its own record but may not approve anything, and no frame leaves", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await postBearer("/api/sessions/append", dtAlice, {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "bearer 不能批准",
      source: "claude",
      operation: "append_session",
    });
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const waiting = await waitForPending(a, id);

    // Reading with the bearer is fine — an operation record carries no session
    // material.
    const mine = await fetch(`${base}/api/sessions/operations`, {
      headers: { authorization: `Bearer ${dtAlice}` },
    });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { operations: OpView[] }).operations.some((o) => o.id === id)).toBe(true);

    // Approving is not: a bearer proves a credential exists somewhere, which is
    // not a person at a keyboard.
    const tryApprove = await fetch(`${base}/api/capabilities/pending/${waiting.pendingCallId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(tryApprove.status).toBe(403);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);

    // Neither may another account, however it asks.
    const b = await browser(base, dtBob);
    const stolen = await post(base, b, `/api/capabilities/pending/${waiting.pendingCallId}/approve`, {});
    expect(stolen.status).toBe(403);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);

    // And Bob cannot submit as Alice either.
    const cross = await post(base, b, "/api/sessions/append", {
      username: "alice",
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "替她跑",
      operation: "append_session",
    });
    expect(cross.status).toBe(403);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);

    caps.reject(waiting.pendingCallId!, "alice");
  });

  it("rejecting reports the decision back to the submission, and runs nothing", async () => {
    const a = await browser(base, dtAlice);
    frames.length = 0;
    const res = await postBearer("/api/sessions/append", dtAlice, {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "会被拒绝",
      source: "claude",
      operation: "append_session",
    });
    const { operation_id: id } = (await res.json()) as { operation_id: string };
    const waiting = await waitForPending(a, id);
    const out = await post(base, a, `/api/capabilities/pending/${waiting.pendingCallId}/reject`, {});
    expect(out.status).toBe(200);
    expect(((await out.json()) as { operation_id?: string }).operation_id).toBe(id);
    const rec = (await listOps(a)).find((o) => o.id === id)!;
    expect(rec.status).toBe("rejected");
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(0);
  });
});

describe("the owner-scoped operation stream", () => {
  it("replays a snapshot, then reports the next transition", async () => {
    const a = await browser(base, dtAlice);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/sessions/operations/stream`, {
      headers: { cookie: a.cookie },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (pred: (s: string) => boolean): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!pred(buf)) {
        if (Date.now() > deadline) throw new Error(`stream never produced it: ${buf.slice(-300)}`);
        buf += dec.decode((await reader.read()).value);
      }
    };
    // The snapshot is what makes a reload restore state from the record.
    await readUntil((s) => s.includes("event: ready"));
    expect(buf).toContain("event: operation");

    const post1 = await post(base, a, "/api/sessions/append", {
      device: "laptop",
      id: ALICE_SESSION,
      prompt: "流里看得见",
      source: "claude",
      operation: "append_session",
    });
    const { operation_id: id } = (await post1.json()) as { operation_id: string };
    await readUntil((s) => s.includes(`"${id}"`) && s.includes("succeeded"));
    ac.abort();
  }, 20_000);
});

describe("the retired browser composition seam", () => {
  it("redirects both transport compositions manually to the sole Sessions Plus UI", async () => {
    for (const host of [base, legacyBase]) {
      const response = await fetch(`${host}/sessions`, {
        headers: { authorization: `Bearer ${dtAlice}` },
        redirect: "manual",
      });
      expect(response.status, host).toBe(303);
      expect(response.headers.get("location"), host).toBe("/sessions-plus");
    }
  });
});
