/**
 * Dashboard transcript-viewer e2e over a REAL WebSocket Runner: the sessions
 * live on a "laptop" served by the actual runner core (@claude-bot/runner),
 * the DashboardServer reaches them through the RunnerGateway, and append
 * travels the Runner's real durable session-operation journal into its managed
 * Agent control plane — proving the whole chain
 *   browser API → dashboard → gateway WS RPC → runner core → durable receipt
 *   → control plane, and back through receipt polling to the operation record
 * including the machine-ops kill switch on a read-only device.
 *
 * Every Runner input goes through the managed control plane (there is no
 * headless `claude -p --resume` channel any more), so the control plane is the
 * one stand-in here: it records each turn it is asked to run, in place of the
 * provider CLI it would drive.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "../runner/gateway.js";
import { RunnerCapabilities } from "../runner/capability.js";
import { DashboardServer, mintDashboardToken } from "../dashboard/server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { narrowOwnSessionAppend } from "../permissions/session-hub-terms.helper.js";
import { handleRpc, type RpcOptions } from "@claude-bot/runner/core";

const NOW = "2026-07-22T10:00:00.000Z";
const SESSION_ID = "e2e00001-1111-2222-3333-444455556666";
const NEW_SESSION_ID = "e2e00002-1111-2222-3333-444455556666";

/**
 * Every rpc frame the laptops actually received. "No approval, no frame" is
 * asserted against this list, not against a policy return value.
 */
const appendCalls: Array<{ device: string; args: Record<string, unknown> }> = [];
/** Every turn a laptop's control plane was asked to run: the prompt reached the agent. */
const turns: Array<{ device: string; sessionId: string; prompt: string }> = [];

/**
 * The Runner-side options of one laptop: the real durable session-operation
 * journal (loaded from the Runner source; it is not a public package export)
 * and a control plane with no live agent process — reads observe no runtime —
 * that completes each turn it is asked to run with a fixed answer.
 */
async function runnerOptions(device: string, home: string, allowMachineOps: boolean): Promise<RpcOptions> {
  const { RunnerSessionOperations } = (await import(
    new URL("../../../runner/src/session-operations.ts", import.meta.url).href
  )) as { RunnerSessionOperations: new (home: string) => NonNullable<RpcOptions["sessionOperations"]> };
  const continueSession = async (input: { sessionId: string; prompt: string }): Promise<Record<string, unknown>> => {
    turns.push({ device, sessionId: input.sessionId, prompt: input.prompt });
    return { ok: true, agent: "claude", session_id: input.sessionId, new_session_id: NEW_SESSION_ID,
      result_text: "已按追加指令继续" };
  };
  return {
    allowMachineOps,
    sessionOperations: new RunnerSessionOperations(home),
    agentControlPlane: {
      discover: async () => {},
      publicRuntime: async () => undefined,
      continueSession,
    } as unknown as NonNullable<RpcOptions["agentControlPlane"]>,
  };
}

function connectRunner(url: string, token: string, home: string, opts: RpcOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", token })));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { type: string; id?: string; method?: string; args?: Record<string, unknown> };
      if (msg.type === "registered") resolve(ws);
      else if (msg.type === "error") reject(new Error("register failed"));
      else if (msg.type === "rpc" && msg.id && msg.method) {
        if (msg.method === "append_session") appendCalls.push({ device: token, args: msg.args ?? {} });
        void handleRpc(home, { id: msg.id, method: msg.method, args: msg.args ?? {} }, opts).then(
          (resp) => ws.send(JSON.stringify(resp)),
        );
      }
    });
    ws.on("error", reject);
  });
}

describe("dashboard sessions e2e over a real WS runner", () => {
  let dir: string;
  let laptopHome: string;
  let store: Store;
  let gateway: RunnerGateway;
  let caps: RunnerCapabilities;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let dtBob: string;
  let wsMain: WebSocket;
  let wsReadonly: WebSocket;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dash-e2e-"));
    laptopHome = join(dir, "laptop-home");
    const cwd = join(laptopHome, "proj");
    mkdirSync(cwd, { recursive: true });
    const proj = join(laptopHome, ".claude", "projects", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          type: "user", sessionId: SESSION_ID, cwd, timestamp: "2026-07-22T09:00:00.000Z",
          message: { role: "user", content: "在笔记本上重构登录模块" },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-22T09:00:05.000Z",
          message: { role: "assistant", content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
          ] },
        }),
        JSON.stringify({
          type: "user", timestamp: "2026-07-22T09:00:06.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "12 passed" }] },
        }),
        JSON.stringify({
          type: "assistant", timestamp: "2026-07-22T09:00:08.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "重构完成,测试全绿" }] },
        }),
      ].join("\n"),
    );

    store = new Store(join(dir, "bot.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
    store.saveRunnerToken(hashRunnerToken("rt-main"), "alice", "laptop", NOW);
    store.saveRunnerToken(hashRunnerToken("rt-ro"), "alice", "readonly-laptop", NOW);
    dtAlice = mintDashboardToken(store, "alice");
    dtBob = mintDashboardToken(store, "bob");

    gateway = new RunnerGateway(store, { port: 0 });
    await gateway.start();
    caps = new RunnerCapabilities(store, gateway.claimTransport());
    wsMain = await connectRunner(`ws://127.0.0.1:${gateway.port}`, "rt-main", laptopHome,
      await runnerOptions("laptop", laptopHome, true));
    wsReadonly = await connectRunner(`ws://127.0.0.1:${gateway.port}`, "rt-ro", laptopHome,
      await runnerOptions("readonly-laptop", laptopHome, false));

    dash = createDashboardTestServer(store, caps, { port: 0, host: "127.0.0.1", authToken: "admin-secret" });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    wsMain?.close();
    wsReadonly?.close();
    await dash?.stop();
    await gateway?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // Alice's own bearer, presented explicitly — the only way a script
  // authenticates now that a cookie holding a raw bearer is not a credential
  // (see dashboard/mutation-gate.test.ts). An approval needs more than a bearer
  // no matter how it is sent.
  const hdr = () => ({ authorization: `Bearer ${dtAlice}`, "content-type": "application/json" });

  it("lists laptop sessions through the gateway, tagged with the device", async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: hdr() });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      sources: Array<{ device: string; kind: string }>;
      sessions: Array<Record<string, unknown>>;
    };
    expect(data.sources.map((s) => s.device).sort()).toEqual(["laptop", "readonly-laptop"]);
    // Both devices report the same session id, and BOTH survive: the hub
    // dedupes on the trusted tuple (owner, device, kind, id), so a session is
    // identified together with the machine that holds it. That matters because
    // `append` runs on the device named in the entry — collapsing the two would
    // pick a machine arbitrarily, which is the ambiguity already fixed for
    // exports (`copy_file`/`copy_session` stamp the answering device).
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions.map((s) => s.device).sort()).toEqual(["laptop", "readonly-laptop"]);
    expect(data.sessions[0]).toMatchObject({ id: SESSION_ID, source: "claude" });
    // A bot-host copy of the same file is still dropped: that is not a second
    // machine, it is the fallback scan of the same home.
    expect(data.sessions.some((s) => s.device === "bot-host")).toBe(false);
  });

  it("rich-reads a laptop transcript over WS (blocks + paired tool result)", async () => {
    const res = await fetch(`${base}/api/session?id=${SESSION_ID}&device=laptop`, { headers: hdr() });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      rich: boolean;
      messages: Array<{ role: string; blocks: Array<Record<string, unknown>> }>;
    };
    expect(data.rich).toBe(true);
    const tool = data.messages[1].blocks[0];
    expect(tool).toMatchObject({ type: "tool", tool: "Bash", output: "12 passed" });
  });

  it("searches laptop sessions over WS", async () => {
    const res = await fetch(`${base}/api/sessions/search?query=${encodeURIComponent("重构登录")}`, { headers: hdr() });
    const data = (await res.json()) as { returned: number; results: Array<{ session: { id: string; device: string } }> };
    // One hit per device, same reason as the roster above.
    expect(data.returned).toBe(2);
    expect(data.results.map((r) => r.session.device).sort()).toEqual(["laptop", "readonly-laptop"]);
    expect(data.results[0].session.id).toBe(SESSION_ID);
  });

  /**
   * Log in for real and keep the session + CSRF secret: the approval endpoint
   * accepts nothing but a live browser session, its CSRF secret and an exact
   * Origin.
   */
  async function browserLogin(): Promise<{ cookie: string; csrf: string }> {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: dtAlice }),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    const sid = /octopus_sess=([0-9a-f]{64})/.exec(raw)![1];
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(raw)![1];
    return { cookie: `octopus_sess=${sid}`, csrf };
  }

  interface OpRecord {
    id: string;
    status: string;
    live: boolean;
    detail?: string;
    newSessionId?: string;
  }

  /**
   * A session submission's outcome is read from its record: the Runner answers
   * the dispatch with a durable receipt, and the record settles when the
   * receipt it is polled for does.
   */
  async function settleOperation(id: string, timeoutMs = 15_000): Promise<OpRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = (await (
        await fetch(`${base}/api/sessions/operations?limit=100`, { headers: hdr() })
      ).json()) as { operations: OpRecord[] };
      const hit = body.operations.find((o) => o.id === id);
      if (hit && !hit.live) return hit;
      if (Date.now() > deadline) throw new Error(`operation ${id} never settled (${hit?.status ?? "missing"})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function append(device: string, prompt: string, headers: Record<string, string> = hdr()): Promise<Response> {
    return await fetch(`${base}/api/sessions/append`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "alice", device, id: SESSION_ID, prompt }),
    });
  }

  it("the owner's own append runs on the named laptop without an approval card, exactly once", async () => {
    // O1 (2026-10-15): acting on one's own sessions is a default-on grant
    // term, so even the owner's script bearer reaches the laptop directly.
    const before = appendCalls.length;
    const turnsBefore = turns.length;
    const res = await append("laptop", "把剩下的 TODO 清掉");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operation_id: string; approval_required?: boolean; pending_call_id?: string };
    expect(body.approval_required).toBeUndefined();
    expect(body.pending_call_id).toBeUndefined();
    expect(body.operation_id).toMatch(/^op_/);
    expect(caps.listPending("alice")).toHaveLength(0);

    const rec = await settleOperation(body.operation_id);
    expect(rec.status).toBe("succeeded");
    expect(rec.newSessionId).toBe(NEW_SESSION_ID);
    expect(appendCalls.length).toBe(before + 1);
    expect(appendCalls.at(-1)).toMatchObject({ device: "rt-main", args: { id: SESSION_ID, prompt: "把剩下的 TODO 清掉" } });
    expect(turns.slice(turnsBefore)).toEqual([{ device: "laptop", sessionId: SESSION_ID, prompt: "把剩下的 TODO 清掉" }]);
  });

  it("another plain account cannot append to the owner's session at all", async () => {
    const before = appendCalls.length;
    const res = await append("laptop", "以她的名义", { authorization: `Bearer ${dtBob}`, "content-type": "application/json" });
    expect(res.status).toBe(403);
    expect(appendCalls.length).toBe(before);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("a read-only device (machine ops off) refuses the owner's append end to end", async () => {
    const turnsBefore = turns.length;
    const res = await append("readonly-laptop", "x");
    const body = (await res.json()) as { operation_id: string; error?: string };
    expect(res.status).toBe(502);
    // The device's refusal reaches the person with the device's own words,
    // both in the answer and on the record, rather than a generic failure.
    expect(body.error).toContain("未开启机器操作");
    const rec = await settleOperation(body.operation_id);
    expect(rec.status).toBe("failed");
    expect(rec.detail).toContain("未开启机器操作");
    expect(turns.length).toBe(turnsBefore);
  });

  it("append to an unknown device names the online ones", async () => {
    const res = await append("ghost", "x");
    const body = (await res.json()) as { operation_id: string; error?: string };
    expect(res.status).toBe(502);
    expect(body.error).toContain("不在线");
    const rec = await settleOperation(body.operation_id);
    expect(rec.status).toBe("failed");
    expect(rec.detail).toContain("不在线");
  });

  it("with the owner's append term narrowed, append is held for approval, reaches no laptop until approved, then runs exactly once", async () => {
    // The only way a card for one's own append still arises: the owner turned
    // the default-silent term off. The approval lifecycle is unchanged.
    narrowOwnSessionAppend(store, caps, "alice");
    const before = appendCalls.length;
    const turnsBefore = turns.length;
    const res = await append("laptop", "再跑一遍测试");
    expect(res.status).toBe(202);
    const queued = (await res.json()) as {
      approval_required: boolean;
      pending_call_id: string;
      operation_id: string;
    };
    expect(queued.approval_required).toBe(true);
    expect(queued.operation_id).toMatch(/^op_/);
    // The laptop has not been asked to do anything.
    expect(appendCalls.length).toBe(before);

    const { cookie, csrf } = await browserLogin();
    const approveUrl = `${base}/api/capabilities/pending/${queued.pending_call_id}/approve`;

    // A bearer token is not a person: refused before anything runs.
    const viaBearer = await fetch(approveUrl, { method: "POST", headers: hdr(), body: "{}" });
    expect(viaBearer.status).toBe(403);
    expect(appendCalls.length).toBe(before);

    // A session without the CSRF secret is refused too.
    const noCsrf = await fetch(approveUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: "{}",
    });
    expect(noCsrf.status).toBe(403);

    // Wrong Origin: refused.
    const badOrigin = await fetch(approveUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, origin: "http://evil.example" },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
    expect(appendCalls.length).toBe(before);

    const ok = await fetch(approveUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, origin: base },
      body: "{}",
    });
    // 202: the click starts execution and hands back the record. Holding this
    // request open for the whole CLI run is the failure the operation model
    // exists to remove.
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { operation_id: string }).operation_id).toBe(queued.operation_id);
    const rec = await settleOperation(queued.operation_id);
    expect(rec.status).toBe("succeeded");
    expect(rec.newSessionId).toBe(NEW_SESSION_ID);
    expect(appendCalls.length).toBe(before + 1);
    expect(turns.slice(turnsBefore)).toEqual([{ device: "laptop", sessionId: SESSION_ID, prompt: "再跑一遍测试" }]);

    // Replaying the same approval returns the recorded outcome and does NOT
    // run it a second time — the laptop count is the assertion that matters.
    const replay = await fetch(approveUrl, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf, origin: base },
      body: "{}",
    });
    expect(replay.status).toBe(200);
    // The recorded outcome is the Runner's durable dispatch receipt for this
    // very operation; the turn's own result lives on the operation record.
    const data = ((await replay.json()) as { result: Record<string, unknown> }).result;
    expect(data).toMatchObject({ protocol: "runner-session-operation/v1", operation_id: queued.operation_id,
      session_id: SESSION_ID });
    expect(appendCalls.length).toBe(before + 1);
    expect(turns.length).toBe(turnsBefore + 1);
  });
});
