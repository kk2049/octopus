import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCodexAccountRateLimitsFromAppServer, selectCodexRateLimitBucket } from "./codex-account-routing.js";
import type { RunnerCodexAccount, RunnerCodexQuota } from "./inventory.js";

/** Only conventional account homes are discovered; arbitrary observed session roots are read-only. */
export async function discoverCodexAccountHomes(home: string, configured?: Record<string, string>, autoDiscover = true): Promise<Record<string, string> | undefined> {
  if (!autoDiscover) {
    if (!configured || !Object.keys(configured).length) throw new Error("Explicit Codex account selection requires RUNNER_CODEX_ACCOUNTS");
    return { ...configured };
  }
  const accounts = { ...configured };
  const seen = new Set(await Promise.all(Object.values(accounts).map((value) => fs.realpath(value).catch(() => path.resolve(value)))));
  const directory = path.join(home, ".codex-accounts");
  for (const entry of (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^account-([a-z])$/.exec(entry.name);
    if (!match || !entry.isDirectory() || Object.keys(accounts).length >= 26) continue;
    const candidate = path.join(directory, entry.name);
    const root = await fs.realpath(candidate).catch(() => null);
    if (!root || seen.has(root) || !(await fs.stat(path.join(root, "auth.json")).catch(() => null))?.isFile()) continue;
    const slot = "account_" + match[1];
    if (slot in accounts) continue;
    accounts[slot] = root;
    seen.add(root);
  }
  return Object.keys(accounts).length ? accounts : undefined;
}

interface LoginDetails {
  identity: string | null;
  emailLabel?: string;
}

function maskedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  if (!match) return undefined;
  const local = match[1]!;
  const domain = match[2]!.slice(0, 120);
  const visible = local.length <= 5 ? local : local.slice(0, 5) + "…";
  return (visible + "@" + domain).slice(0, 160);
}

/** Login equality stays local. Neither this digest nor provider identity leaves the Runner. */
async function loginDetails(codexHome: string): Promise<LoginDetails> {
  try {
    const file = path.join(codexHome, "auth.json");
    if ((await fs.stat(file)).size > 64 * 1024) return { identity: null };
    const auth = JSON.parse(await fs.readFile(file, "utf8"));
    const account = auth?.tokens?.account_id;
    if (typeof account !== "string" || !account) return { identity: null };
    let subject = "";
    let email: unknown;
    try {
      const claims = JSON.parse(Buffer.from(String(auth.tokens.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof claims.sub === "string") subject = claims.sub;
      email = claims.email;
    } catch { /* Older auth files contain only account_id. */ }
    email ??= auth?.email ?? auth?.tokens?.email;
    const emailLabel = maskedEmail(email);
    return {
      identity: createHash("sha256").update(JSON.stringify([account, subject])).digest("hex"),
      ...(emailLabel ? { emailLabel } : {}),
    };
  } catch { return { identity: null }; }
}

export function codexQuotaFromRateLimits(raw: unknown, now: number): RunnerCodexQuota {
  const bucket = selectCodexRateLimitBucket(raw);
  const windows: RunnerCodexQuota["windows"] = [];
  for (const key of ["primary", "secondary"] as const) {
    const value = bucket?.[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const { usedPercent, windowDurationMins, resetsAt } = row;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
      || typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0
      || typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0
      || !Number.isFinite(new Date(resetsAt * 1000).getTime())) continue;
    windows.push({ remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      windowMinutes: windowDurationMins, resetsAt: new Date(resetsAt * 1000).toISOString() });
  }
  const rawCredits = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).rateLimitResetCredits : undefined;
  const summary = rawCredits && typeof rawCredits === "object" && !Array.isArray(rawCredits)
    ? rawCredits as Record<string, unknown> : undefined;
  const credits = summary?.availableCount;
  const creditCount = typeof credits === "number" && Number.isInteger(credits) && credits >= 0 && credits <= 100_000
    ? credits : undefined;
  let earliestExpiry = Infinity;
  if (creditCount && Array.isArray(summary?.credits)) {
    for (const credit of summary.credits) {
      if (!credit || typeof credit !== "object" || Array.isArray(credit)) continue;
      const { status, expiresAt } = credit;
      if (status !== "available" || typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) continue;
      const timestamp = expiresAt * 1000;
      if (timestamp > now && Number.isFinite(new Date(timestamp).getTime())) {
        earliestExpiry = Math.min(earliestExpiry, timestamp);
      }
    }
  }
  return { status: windows.length ? "available" : "unavailable", fetchedAt: new Date(now).toISOString(), windows,
    ...(creditCount === undefined ? {} : { creditCount }),
    ...(Number.isFinite(earliestExpiry) ? { creditExpiresAt: new Date(earliestExpiry).toISOString() } : {}) };
}

/** One bounded refresh per inventory cycle; failed probes keep the registration visible. */
export async function codexAccountInventory(input: {
  defaultHome: string;
  accounts: readonly { slot: string; label: string; codexHome: string }[];
  read?: (home: string) => Promise<unknown>;
  now?: number;
  readModels?: (home: string, timeoutMs: number) => Promise<RunnerCodexAccount["models"]>;
  /** Explicit pools do not advertise the legacy default home as a new-task account. */
  includeDefault?: boolean;
}): Promise<RunnerCodexAccount[]> {
  const roots = [...(input.includeDefault === false ? [] : [{ id: "@default", label: "codex", codexHome: input.defaultHome }]),
    ...input.accounts.map((account) => ({ id: account.slot, label: "codex" + account.label, codexHome: account.codexHome }))];
  const details = await Promise.all(roots.map((root) => loginDetails(root.codexHome)));
  const seen = new Set<string>();
  const usedEmailLabels = new Set<string>();
  const rows: RunnerCodexAccount[] = [];
  const deadline = Date.now() + 16_000;
  const pending: Array<() => Promise<void>> = [];
  for (const [index, root] of roots.entries()) {
    const detail = details[index]!;
    if (detail.identity && seen.has(detail.identity)) continue;
    if (detail.identity) seen.add(detail.identity);
    const aliasIndex = root.id === "@default" && detail.identity
      ? roots.findIndex((candidate, i) => i > 0 && details[i]!.identity === detail.identity) : -1;
    const email = details[aliasIndex >= 0 ? aliasIndex : index]?.emailLabel;
    let uniqueEmail = email;
    if (email && usedEmailLabels.has(email)) {
      const count = [...usedEmailLabels].filter((value) => value === email || value.startsWith(email.replace("@", "#"))).length + 1;
      uniqueEmail = email.replace("@", "#" + count + "@");
    }
    if (uniqueEmail) usedEmailLabels.add(uniqueEmail);
    const row: RunnerCodexAccount = { id: root.id, label: aliasIndex >= 0 ? roots[aliasIndex]!.label : root.label,
      ...(uniqueEmail ? { emailLabel: uniqueEmail } : {}) };
    rows.push(row);
    pending.push(async () => {
      const remaining = Math.max(1, deadline - Date.now());
      const [raw, models] = Date.now() >= deadline ? [null, undefined] : await Promise.all([
        (input.read?.(root.codexHome)
          ?? readCodexAccountRateLimitsFromAppServer({ codexHome: root.codexHome, timeoutMs: Math.min(8_000, remaining) })).catch(() => null),
        input.readModels?.(root.codexHome, Math.min(4_000, remaining)).catch(() => undefined),
      ]);
      if (models?.length) row.models = models;
      row.quota = codexQuotaFromRateLimits(raw, input.now ?? Date.now());
    });
  }
  // Bounded fan-out: one slow account no longer starves every later account.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) await pending[next++]!();
  }));
  return rows;
}
