import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexAccountInventory, codexQuotaFromRateLimits, discoverCodexAccountHomes } from "./codex-account-inventory.js";
import { publicCodexEmailLabel, publicCodexQuota } from "./inventory.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true }))); });
async function home() { const value = await fs.mkdtemp(path.join(os.tmpdir(), "codex-roster-")); homes.push(value); return value; }
async function login(root: string, id: string, email?: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({
    tokens: { account_id: id, access_token: "private-token" },
    ...(email ? { email } : {}),
  }));
}
const now = Date.parse("2026-09-15T12:00:00Z");
const limits = { rateLimitsByLimitId: { codex: {
  primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: (now + 3600000) / 1000 },
  secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: (now + 86400000) / 1000 },
}, spark: { primary: { usedPercent: 99 } } },
  rateLimitResetCredits: { availableCount: 2, credits: [
    { id: "private-credit-later", status: "available", expiresAt: (now + 7 * 86400000) / 1000 },
    { id: "private-credit-first", status: "available", expiresAt: (now + 3 * 86400000) / 1000 },
  ] },
};

it("discovers only authenticated conventional roots, preserving configured slots and deduplicating paths", async () => {
  const root = await home();
  const a = path.join(root, ".codex-accounts/account-a");
  const b = path.join(root, ".codex-accounts/account-b");
  await login(a, "a"); await login(b, "b");
  await login(path.join(root, ".codex-accounts/backup"), "backup");
  await fs.mkdir(path.join(root, ".codex-accounts/account-c"));
  expect(await discoverCodexAccountHomes(root, { existing: b })).toEqual({ existing: b, account_a: a });
});

it("reports two AWS logins and three aliyun logins without exposing credentials or double-counting default", async () => {
  const root = await home();
  const defaultHome = path.join(root, ".codex");
  const a = path.join(root, ".codex-accounts/account-a");
  const b = path.join(root, ".codex-accounts/account-b");
  await login(defaultHome, "b", "long-default@example.com"); await login(a, "a", "alice@example.com"); await login(b, "b", "long-default@example.com");
  const input = { defaultHome, accounts: [{ slot: "account_a", label: "a", codexHome: a }, { slot: "account_b", label: "b", codexHome: b }], read: async () => limits, now };
  const aws = await codexAccountInventory(input);
  expect(aws.map(({ id, label }) => ({ id, label }))).toEqual([{ id: "@default", label: "codexb" }, { id: "account_a", label: "codexa" }]);
  expect(aws[0]!.emailLabel).toBe("long-…@example.com");
  expect(aws[0]!.quota?.windows.map((window) => window.remainingPercent)).toEqual([73, 19]);
  expect(aws[0]!.quota?.creditCount).toBe(2);
  expect(aws[0]!.quota?.creditExpiresAt).toBe(new Date(now + 3 * 86400000).toISOString());
  expect(JSON.stringify(aws)).not.toMatch(/private-token|private-credit|account_id|codexHome|\/tmp\//);
  await login(defaultHome, "c", "new-person@example.com");
  expect(await codexAccountInventory(input)).toHaveLength(3);
});

it("preserves every registration on a quota outage", async () => {
  const root = await home(); await login(root, "a");
  const rows = await codexAccountInventory({ defaultHome: root, accounts: [], now, read: async () => { throw new Error("private upstream error"); } });
  expect(rows).toEqual([{ id: "@default", label: "codex", quota: { status: "unavailable", fetchedAt: new Date(now).toISOString(), windows: [] } }]);
});

it("allows a pinned active pool while retaining the old default login for existing sessions", async () => {
  const root = await home();
  const homes = Object.fromEntries(["a", "b", "c"].map((id) => [id, path.join(root, `.codex-accounts/account-${id}`)]));
  for (const [id, directory] of Object.entries(homes)) await login(directory, id);
  const configured = { account_a: homes.a!, account_c: homes.c! };
  expect(await discoverCodexAccountHomes(root, configured, false)).toEqual(configured);
  await expect(discoverCodexAccountHomes(root, undefined, false)).rejects.toThrow("RUNNER_CODEX_ACCOUNTS");
  const read = async (directory: string) => { expect(directory).not.toBe(homes.b); return limits; };
  const rows = await codexAccountInventory({ defaultHome: homes.b!, includeDefault: false, now, read,
    accounts: [{ slot: "account_a", label: "a", codexHome: homes.a! }, { slot: "account_c", label: "c", codexHome: homes.c! }] });
  expect(rows.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: "account_a", label: "codexa" }, { id: "account_c", label: "codexc" },
  ]);
  expect(JSON.parse(await fs.readFile(path.join(homes.b!, "auth.json"), "utf8")).tokens.account_id).toBe("b");
});

it("bounds public windows and drops unknown fields and invalid payloads", () => {
  const quota = codexQuotaFromRateLimits(limits, now);
  expect(publicCodexQuota({ ...quota, token: "secret", windows: quota.windows.map((window) => ({ ...window, accountId: "private" })) })).toEqual(quota);
  expect(publicCodexQuota({ ...quota, windows: [{ ...quota.windows[0], remainingPercent: Infinity }] })).toBeUndefined();
  expect(codexQuotaFromRateLimits({ rateLimits: { primary: { usedPercent: NaN } } }, now).status).toBe("unavailable");
});

it("does not merge different users of the same provider workspace", async () => {
  const root = await home(), second = await home();
  for (const [directory, sub] of [[root, "person-a"], [second, "person-b"]]) {
    const token = "header." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + ".signature";
    await fs.writeFile(path.join(directory!, "auth.json"), JSON.stringify({ tokens: { account_id: "shared-workspace", id_token: token } }));
  }
  const rows = await codexAccountInventory({ defaultHome: root, accounts: [{ slot: "b", label: "b", codexHome: second }], read: async () => limits, now });
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toMatch(/person-|shared-workspace|signature/);
});


it("keeps five email characters, preserves short names, and distinguishes masked collisions", async () => {
  const root = await home(), other = await home(), short = await home();
  await login(root, "one", "abcde-first@example.com");
  await login(other, "two", "abcde-second@example.com");
  await login(short, "three", "alice@example.com");
  const rows = await codexAccountInventory({ defaultHome: root, accounts: [
    { slot: "b", label: "b", codexHome: other }, { slot: "c", label: "c", codexHome: short },
  ], read: async () => limits, now });
  expect(rows.map((row) => row.emailLabel)).toEqual(["abcde…@example.com", "abcde…#2@example.com", "alice@example.com"]);
  for (const row of rows) expect(publicCodexEmailLabel(row.emailLabel)).toBe(row.emailLabel);
  expect(publicCodexEmailLabel("abcdef@example.com")).toBeUndefined();
});


it("selects the earliest future expiry of available cards without inferring from grant order", () => {
  const earliest = (now + 120_000) / 1000;
  const quota = codexQuotaFromRateLimits({ ...limits, rateLimitResetCredits: { availableCount: 8, credits: [
    { status: "available", grantedAt: 1, expiresAt: earliest + 86400 },
    { status: "redeemed", expiresAt: earliest - 10 },
    { status: "redeeming", expiresAt: earliest - 10 },
    { status: "unknown", expiresAt: earliest - 10 },
    { status: "available", expiresAt: now / 1000 },
    { status: "available", expiresAt: now / 1000 - 1 },
    { status: "available", expiresAt: null },
    { status: "available", expiresAt: "2026-09-16" },
    { status: "available", expiresAt: Infinity },
    { status: "available", expiresAt: 1e20 },
    null,
    { status: "available", grantedAt: 2, expiresAt: earliest },
  ] } }, now);
  expect(quota.creditCount).toBe(8);
  expect(quota.creditExpiresAt).toBe(new Date(earliest * 1000).toISOString());
  expect(publicCodexQuota(quota)).toEqual(quota);
});

it.each([null, [], [{ status: "available", expiresAt: null }], [{ status: "redeemed", expiresAt: now / 1000 + 120 }]])(
  "omits expiry when no usable dated credit details are provided: %j", (credits) => {
    const quota = codexQuotaFromRateLimits({ ...limits, rateLimitResetCredits: { availableCount: 2, credits } }, now);
    expect(quota.creditCount).toBe(2);
    expect(quota).not.toHaveProperty("creditExpiresAt");
  },
);

it("preserves legacy counts and suppresses expiry without a positive valid count", () => {
  expect(codexQuotaFromRateLimits({ ...limits, rateLimitResetCredits: { availableCount: 2 } }, now)).toMatchObject({ creditCount: 2 });
  for (const availableCount of [undefined, 0, -1, 1.5, "2", 100001]) {
    const quota = codexQuotaFromRateLimits({ ...limits, rateLimitResetCredits: { ...limits.rateLimitResetCredits, availableCount } }, now);
    expect(quota).not.toHaveProperty("creditExpiresAt");
  }
});

it("drops malformed optional expiry without losing usable quota and strips raw credit details", () => {
  const quota = codexQuotaFromRateLimits(limits, now);
  const { creditExpiresAt: _, ...withoutExpiry } = quota;
  for (const creditExpiresAt of [null, 123, "invalid", " ".repeat(41), { token: "private" }]) {
    expect(publicCodexQuota({ ...quota, creditExpiresAt })).toEqual(withoutExpiry);
  }
  expect(publicCodexQuota({ ...quota, creditCount: 0 })).toEqual({ ...withoutExpiry, creditCount: 0 });
  expect(publicCodexQuota({ ...quota, credits: limits.rateLimitResetCredits.credits })).toEqual(quota);
});


it("discovers models per account and leaves failed discovery absent for the View fallback", async () => {
  const a = await home(), b = await home();
  const rows = await codexAccountInventory({defaultHome:a, accounts:[{slot:"b",label:"b",codexHome:b}],
    read:async () => limits, readModels:async (root, timeout) => {
      expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(4000);
      if (root === b) throw new Error("unavailable");
      return [{value:"local-model",label:"Local"}];
    }});
  expect(rows[0]!.models).toEqual([{value:"local-model",label:"Local"}]);
  expect(rows[1]).not.toHaveProperty("models");
  expect(rows[1]!.quota?.status).toBe("available");
});


it("starts later account probes while an earlier account is slow, with at most four in flight", async () => {
  const root = await home();
  const accounts = Array.from({ length: 5 }, (_, i) => ({ slot: `a${i}`, label: String(i), codexHome: path.join(root, String(i)) }));
  const pending = new Map<string, (raw: unknown) => void>();
  const read = (directory: string) => new Promise(resolve => { pending.set(directory, resolve); });
  const result = codexAccountInventory({ defaultHome: root, includeDefault: false, accounts, read, now });
  await vi.waitFor(() => expect(pending.size).toBe(4));
  pending.get(accounts[1]!.codexHome)!(limits);
  await vi.waitFor(() => expect(pending.size).toBe(5));
  for (const resolve of pending.values()) resolve(limits);
  expect((await result).map(row => row.id)).toEqual(accounts.map(row => row.slot));
});
