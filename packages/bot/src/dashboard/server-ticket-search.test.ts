import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import type { DevPipeline } from "../devpipe/pipeline.js";
import { normalizeDevTicketInput } from "../devpipe/ticket-models.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";

describe("ticket history search over HTTP", () => {
  const store = new Store(":memory:");
  let dash: DashboardServer;
  let base: string;
  const tokens: Record<string, string> = {};
  let historicalId: number;

  beforeAll(async () => {
    for (const [index, name] of ["member", "contributor"].entries()) {
      store.saveUser({ username: name, uid: index + 1, home_dir: "/unused", created_at: "2026-10-13T00:00:00Z" });
      store.grantCapability(name, name === "member" ? "dev" : "contribute", "test", "2026-10-13T00:00:00Z");
      tokens[name] = mintDashboardToken(store, name);
    }
    const old = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "Historical search", body: "最早的需求", requester: "contributor",
    }));
    historicalId = old.id;
    store.devTickets.updateDevTicket(old.id, { dev_status: "cancelled" });
    store.devTickets.addTicketMessage(old.id, "contributor", "web", "后续关键词");
    for (let i = 0; i < 205; i++) store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: `Recent ${i}`, body: "后续关键词", requester: "member",
    }));
    // Only the pipeline's read-only roster metadata is used by this route.
    const pipe = {
      lockWaiterIds: () => [], mergeLockHolder: () => null,
      ticketExecutionChoices: () => undefined, usesRunnerTickets: () => false,
      specConcurrency: 1, baseBranch: "v4",
    } as unknown as DevPipeline;
    dash = createDashboardTestServer(store, undefined, {
      port: 0, host: "127.0.0.1", authToken: "search-test-admin", devPipeline: pipe,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });
  afterAll(async () => { await dash?.stop(); store.close(); });

  const read = (name: string, params = "") => fetch(`${base}/api/tickets${params}`, {
    headers: { authorization: `Bearer ${tokens[name]}` },
  });

  it("combines keyword/requester/status across history and retains detail access", async () => {
    const response = await read("member", `?q=${encodeURIComponent("后续关键词")}&requester=contributor&status=cancelled&limit=50`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.tickets.map((row: { id: number }) => row.id)).toEqual([historicalId]);
    expect(result.has_more).toBe(false);
    const detail = await fetch(`${base}/api/tickets/${historicalId}`, {
      headers: { authorization: `Bearer ${tokens.member}` },
    });
    expect(detail.status).toBe(200);
  });

  it("scopes contributor results before the limit and refuses requester scope widening", async () => {
    const own = await (await read("contributor")).json();
    expect(own.tickets.map((row: { id: number }) => row.id)).toEqual([historicalId]);
    const other = await (await read("contributor", "?q=Recent&requester=member&limit=1")).json();
    expect(other.tickets).toEqual([]);
    expect(other.has_more).toBe(false);
  });

  it("pages bounded results and validates search fields", async () => {
    const page1 = await (await read("member", "?q=Recent&limit=2")).json();
    const page2 = await (await read("member", "?q=Recent&limit=2&offset=2")).json();
    expect(page1.tickets).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(new Set([...page1.tickets, ...page2.tickets].map((row: { id: number }) => row.id)).size).toBe(4);
    expect((await read("member", "?status=unknown")).status).toBe(400);
    expect((await read("member", `?q=${"a".repeat(201)}`)).status).toBe(400);
    expect((await (await read("member", "?q=not-found")).json()).tickets).toEqual([]);
    expect((await fetch(`${base}/api/tickets?q=Recent`)).status).toBe(401);
  });
});
