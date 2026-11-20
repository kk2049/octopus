/**
 * Quota endpoint of the dev panel: who may read it, and what it degrades to.
 * The probe itself is unit-tested in devpipe/quota.test.ts — here we only
 * care that the route is gated like the rest of /tickets and that upstream
 * failures arrive as a 200 the page can quietly hide.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { QuotaProbe } from "../devpipe/quota.js";
import { CodexQuotaProbe } from "../devpipe/codex-quota.js";
import type { DevPipeline } from "../devpipe/pipeline.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { SystemStatusProbe } from "./system-status.js";

const NOW = "2026-07-25T10:00:00.000Z";
const ADMIN = "admin-secret";

const PAYLOAD = {
  limits: [
    { kind: "session", percent: 3, resets_at: NOW },
    { kind: "weekly_all", percent: 37, resets_at: NOW },
    { kind: "weekly_scoped", percent: 64, resets_at: NOW, scope: { model: { display_name: "Fable" } } },
  ],
};

type QuotaBody = {
  error?: string;
  message?: string;
  cards: Array<{ key: string; remainPercent: number; label?: string; accountLabel?: string }>;
};

const fakeProbe = (credentialsPath: string, status: number, body: unknown): QuotaProbe =>
  new QuotaProbe({
    credentialsPath,
    fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
  });

/** Silent multi-account result so Claude-only route assertions stay focused. */
const silentCodexProbe = (): CodexQuotaProbe =>
  new CodexQuotaProbe({ readUsageSnapshot: async () => ({ reports: [] }) });

function fakeSystemStatusProbe(): SystemStatusProbe {
  const samples = [
    { idle: 100, total: 1_000 },
    { idle: 150, total: 1_200 },
  ];
  let index = 0;
  return new SystemStatusProbe({
    now: () => Date.parse(NOW),
    sleep: () => Promise.resolve(),
    readCpu: () => samples[Math.min(index++, samples.length - 1)]!,
    readMemory: () => ({ free: 380, total: 1_000 }),
    readHostname: () => "octopus-main",
  });
}

describe("dashboard quota endpoint", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let creds: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dashq-"));
    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/a", created_at: NOW });
    dtAlice = mintDashboardToken(store, "alice");

    creds = join(dir, "creds.json");
    writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));

    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: {} as unknown as DevPipeline,
      quotaProbe: fakeProbe(creds, 200, PAYLOAD),
      codexQuotaProbe: silentCodexProbe(),
      systemStatusProbe: fakeSystemStatusProbe(),
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (token: string) =>
    fetch(`${base}/api/dev/quota`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

  it("rejects anonymous callers", async () => {
    expect((await get("")).status).toBe(401);
  });

  it("serves percentages to any dev-capable user, admin or not", async () => {
    // Ticket #15: the strip belongs to the dev panel, so it follows the same
    // grant — an account that cannot see /tickets cannot read its quota.
    store.grantCapability("alice", "dev", "test", NOW);
    for (const token of [dtAlice, ADMIN]) {
      const res = await get(token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as QuotaBody;
      expect(body.error).toBeUndefined();
      expect(body.cards.map((c: { key: string }) => c.key)).toEqual(["session", "weekly_all", "scoped:fable"]);
      expect(body.cards[2].remainPercent).toBe(36);
    }
  });

  it("serves sampled host pressure under the same dev gate", async () => {
    store.grantCapability("alice", "dev", "test", NOW);
    const anonymous = await fetch(`${base}/api/dev/system-status`);
    expect(anonymous.status).toBe(401);
    for (const token of [dtAlice, ADMIN]) {
      const res = await fetch(`${base}/api/dev/system-status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        hostname: "octopus-main",
        cpuPercent: 75,
        memoryPercent: 62,
        hosts: [{ id: "main", hostname: "octopus-main", kind: "main" }],
      });
    }
  });

  it("returns 200 + error (not 5xx) when the upstream is unhappy", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "dashq2-"));
    const store2 = new Store(join(dir2, "t.db"));
    const d2 = createDashboardTestServer(store2, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: {} as unknown as DevPipeline,
      quotaProbe: fakeProbe(creds, 500, {}),
      codexQuotaProbe: silentCodexProbe(),
    });
    await d2.start();
    const res = await fetch(`http://127.0.0.1:${d2.port}/api/dev/quota`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBody;
    expect(body.error).toBe("unavailable");
    expect(body.message).toContain("500");
    expect(body.cards).toEqual([]);
    await d2.stop();
    store2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("merges codex cards into the same response so the strip picks up both providers", async () => {
    const dir4 = mkdtempSync(join(tmpdir(), "dashq4-"));
    const store4 = new Store(join(dir4, "t.db"));
    store4.saveUser({ username: "alice", uid: 1, home_dir: "/x/a", created_at: NOW });
    store4.grantCapability("alice", "dev", "test", NOW);
    const codexProbe = new CodexQuotaProbe({
      readUsageSnapshot: async () => ({
        reports: [
          {
            provider: "openai-codex",
            metadata: { email: "ol*" },
            limits: [{
              id: "openai-codex:primary",
              window: { durationMs: 604_800_000, resetsAt: 1_786_851_447_000 },
              amount: { remaining: 58, unit: "percent" },
            }],
          },
          {
            provider: "openai-codex",
            metadata: { email: "li*" },
            limits: [{
              id: "openai-codex:primary",
              window: { durationMs: 604_800_000, resetsAt: 1_786_851_447_000 },
              amount: { remaining: 12, unit: "percent" },
            }],
          },
        ],
      }),
    });
    const d4 = createDashboardTestServer(store4, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: {} as unknown as DevPipeline,
      quotaProbe: fakeProbe(creds, 200, PAYLOAD),
      codexQuotaProbe: codexProbe,
    });
    await d4.start();
    const res = await fetch(`http://127.0.0.1:${d4.port}/api/dev/quota`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBody;
    expect(body.error).toBeUndefined();
    expect(body.cards.map((c) => c.key)).toEqual([
      "session",
      "weekly_all",
      "scoped:fable",
      "codex:account:1:10080m",
      "codex:account:2:10080m",
    ]);
    expect(body.cards.filter((card) => card.key.startsWith("codex:"))).toMatchObject([
      { accountLabel: "ol*", remainPercent: 58 },
      { accountLabel: "li*", remainPercent: 12 },
    ]);
    await d4.stop();
    store4.close();
    rmSync(dir4, { recursive: true, force: true });
  });

  it("does not surface an error when only codex is silent (claude still has cards)", async () => {
    const dir5 = mkdtempSync(join(tmpdir(), "dashq5-"));
    const store5 = new Store(join(dir5, "t.db"));
    // Codex probe reports unavailable — but claude cards exist, so strip must
    // still render normally and NOT paint every viewer's screen red.
    const codexProbe = new CodexQuotaProbe({
      readUsageSnapshot: async () => {
        throw new Error("disk gone");
      },
    });
    const d5 = createDashboardTestServer(store5, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: {} as unknown as DevPipeline,
      quotaProbe: fakeProbe(creds, 200, PAYLOAD),
      codexQuotaProbe: codexProbe,
    });
    await d5.start();
    const res = await fetch(`http://127.0.0.1:${d5.port}/api/dev/quota`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as QuotaBody;
    expect(body.error).toBeUndefined();
    expect(body.cards.map((c) => c.key)).toEqual(["session", "weekly_all", "scoped:fable"]);
    await d5.stop();
    store5.close();
    rmSync(dir5, { recursive: true, force: true });
  });

  it("404s when the self-hosting pipeline is off", async () => {
    const dir3 = mkdtempSync(join(tmpdir(), "dashq3-"));
    const store3 = new Store(join(dir3, "t.db"));
    const d3 = createDashboardTestServer(store3, undefined, { port: 0, host: "127.0.0.1", authToken: ADMIN });
    await d3.start();
    const res = await fetch(`http://127.0.0.1:${d3.port}/api/dev/quota`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(404);
    await d3.stop();
    store3.close();
    rmSync(dir3, { recursive: true, force: true });
  });
});

it("uses the viewer's ticket-authorized Runner accounts and never probes the legacy pool in Runner mode", async () => {
  const store = new Store(":memory:");
  store.saveUser({ username: "developer", uid: 1, home_dir: "/unused", created_at: NOW });
  store.grantCapability("developer", "dev", "test", NOW);
  const quota = { status: "available", fetchedAt: NOW, windows: [{ remainingPercent: 42, windowMinutes: 300, resetsAt: NOW }] };
  const hosts = [{ key: "shared-ali", device: "aws-workbench", label: "aliyun", online: true, accounts: [{ id: "account_a", label: "codexa", quota }],
    claudeAccounts: [{ id: "@default", label: "Claude", quota }] },
    { key: "claude-only", device: "claude-only", label: "Claude machine", online: true, accounts: [], claudeAccounts: [{ id: "@default", label: "Claude", quota }] }];
  const ticketQuotaHosts = vi.fn((requester: string) => requester === "developer" ? hosts : []);
  const legacy = silentCodexProbe();
  const snapshot = vi.spyOn(legacy, "snapshot");
  const legacyClaude = fakeProbe("/missing", 401, {});
  const claudeSnapshot = vi.spyOn(legacyClaude, "snapshot");
  const dash = createDashboardTestServer(store, undefined, {
    port: 0, host: "127.0.0.1",
    devPipeline: { usesRunnerTickets: () => true, ticketQuotaHosts } as unknown as DevPipeline,
    quotaProbe: legacyClaude, codexQuotaProbe: legacy,
  });
  try {
    await dash.start();
    const response = await fetch(`http://127.0.0.1:${dash.port}/api/dev/quota`, { headers: { authorization: `Bearer ${mintDashboardToken(store, "developer")}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cards: [], codexHosts: hosts });
    expect(ticketQuotaHosts).toHaveBeenCalledWith("developer");
    expect(snapshot).not.toHaveBeenCalled();
    expect(claudeSnapshot).not.toHaveBeenCalled();
  } finally { await dash.stop(); store.close(); }
});
