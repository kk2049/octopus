import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeAccountInventory } from "./claude-account-inventory.js";
import { QuotaProbe } from "./claude-quota.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const now = Date.parse("2026-10-18T08:00:00Z");
const reset = "2026-10-18T11:40:00Z";

it("reads the Runner's Claude login and reports only aggregate usage and reset times", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-inventory-")); directories.push(directory);
  const file = path.join(directory, ".credentials.json");
  const original = JSON.stringify({ claudeAiOauth: { accessToken: "private-access", refreshToken: "private-refresh" } });
  await fs.writeFile(file, original);
  vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
  vi.stubEnv("CLAUDE_CREDENTIALS_PATH", undefined);
  const fetchImpl = vi.fn(async (_url, init) => {
    expect(init.headers.authorization).toBe("Bearer private-access");
    return new Response(JSON.stringify({ limits: [
      { kind: "session", percent: 9, resets_at: reset },
      { kind: "weekly_all", percent: 37, resets_at: reset },
      { kind: "weekly_scoped", percent: 1, resets_at: reset, scope: { model: { display_name: "Fable" } } },
    ], account_id: "private-account" }));
  });
  const probe = new QuotaProbe({ now: () => now, fetchImpl: fetchImpl as typeof fetch, staleMaxAgeMs: 0 });
  const result = await claudeAccountInventory(probe);
  expect(result).toEqual([{ id: "@default", label: "Claude", quota: {
    status: "available", fetchedAt: new Date(now).toISOString(), windows: [
      { remainingPercent: 91, windowMinutes: 300, resetsAt: reset },
      { remainingPercent: 63, windowMinutes: 10080, resetsAt: reset },
    ],
  } }]);
  expect(JSON.stringify(result)).not.toMatch(/private-|accessToken|refreshToken|Fable/);
  await claudeAccountInventory(probe);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(file, "utf8")).toBe(original);
});

it.each(["expired", "unavailable"] as const)("keeps an authenticated account visible on %s", async (error) => {
  expect(await claudeAccountInventory({ snapshot: async () => ({ cards: [], fetchedAt: reset, error }) }))
    .toEqual([{ id: "@default", label: "Claude", quota: { status: "unavailable", fetchedAt: reset, windows: [] } }]);
});

it("does not fabricate an account on devices without Claude credentials", async () => {
  expect(await claudeAccountInventory({ snapshot: async () => ({ cards: [], fetchedAt: reset, error: "no_credentials" }) })).toEqual([]);
});

it("settles on its own deadline when fetch never does, and retries on the next refresh", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-inventory-")); directories.push(directory);
  const file = path.join(directory, ".credentials.json");
  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "private-access" } }));
  let clock = now;
  const signals: AbortSignal[] = [];
  // Ignores its abort signal, as the read that hung on 2026-10-26 did.
  const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Promise<Response>(() => {});
  });
  const probe = new QuotaProbe({ credentialsPath: file, now: () => clock, fetchImpl: fetchImpl as unknown as typeof fetch,
    staleMaxAgeMs: 0, requestTimeoutMs: 20 });
  expect(await claudeAccountInventory(probe))
    .toEqual([{ id: "@default", label: "Claude", quota: { status: "unavailable", fetchedAt: new Date(now).toISOString(), windows: [] } }]);
  expect(signals[0]!.aborted).toBe(true);
  clock += 30_000;
  await claudeAccountInventory(probe);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
