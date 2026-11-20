import { publicModelChoices, type ModelChoice } from "@claude-bot/agent-sessions-contract/providers";
import { agentCommand } from "./agent-executables.js";
/** Device-local Codex account discovery, quota probing, and reset-first routing. */

import { spawn } from "node:child_process";
import path from "node:path";

const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_MINIMUM_REMAINING_PERCENT = 5;
const OK_TTL_MS = 60_000;
const ERROR_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const STOP_GRACE_MS = 1_000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export interface CodexRateLimitsClientOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  codexHome?: string;
  /** Keep diagnostic probes on the same environment as the selected CLI. */
  env?: NodeJS.ProcessEnv;
}

/** Read one official `account/rateLimits/read` response without exposing account data in errors. */
export async function readCodexAccountRateLimitsFromAppServer(
  opts: CodexRateLimitsClientOptions = {},
): Promise<unknown> {
  return await readCodexAccountFromAppServer("account/rateLimits/read", undefined, opts);
}

/** Read picker-visible models from the selected local CLI/account; never starts a thread. */
export async function readCodexModelsFromAppServer(opts: CodexRateLimitsClientOptions = {}): Promise<ModelChoice[] | undefined> {
  const raw = await readCodexAccountFromAppServer("model/list", { includeHidden: false, limit: 100 }, {
    ...opts, args: opts.args ?? ["app-server"],
  });
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) return;
  return publicModelChoices(data.filter(row => asRecord(row)?.hidden !== true).map(row => ({
    value: asRecord(row)?.model, label: asRecord(row)?.displayName ?? asRecord(row)?.model,
  })));
}

/** Native provider auth semantics, without reading keys or refreshing a login. */
export async function codexAuthenticationAvailable(
  opts: CodexRateLimitsClientOptions = {},
): Promise<boolean> {
  const result = asRecord(await readCodexAccountFromAppServer("account/read", { refreshToken: false }, {
    ...opts, args: opts.args ?? ["app-server"],
  }));
  // A custom provider can use config/env credentials with no OpenAI account.
  if (result?.requiresOpenaiAuth === false) return true;
  const type = asRecord(result?.account)?.type;
  return result?.requiresOpenaiAuth === true && (type === "apiKey" || type === "chatgpt");
}

/**
 * Ask the owner's Codex to refresh one ChatGPT login in place. The rotation
 * happens inside Codex (its own storage and locking) and lands in the
 * canonical `auth.json` every other Codex of that home already reads.
 * Plugins stay off: the probe must not pull the remote plugin catalog.
 */
export async function refreshCodexLogin(codexHome: string): Promise<void> {
  const result = asRecord(await readCodexAccountFromAppServer("account/read", { refreshToken: true }, {
    codexHome,
    args: ["app-server", "--disable", "plugins", "--disable", "remote_plugin"],
    timeoutMs: 60_000,
  }));
  if (asRecord(result?.account)?.type !== "chatgpt") throw new Error("Codex 登录不是 ChatGPT 登录，无法刷新");
}

/** Share the bounded, content-free one-shot transport with quota discovery. */
async function readCodexAccountFromAppServer(
  method: "account/read" | "account/rateLimits/read" | "model/list",
  params: Record<string, unknown> | undefined,
  opts: CodexRateLimitsClientOptions,
): Promise<unknown> {
  const command = opts.command ?? "codex";
  const args = opts.args ?? ["app-server"];
  const inheritedEnv = opts.env ?? process.env;
  const env = opts.codexHome ? { ...inheritedEnv, CODEX_HOME: opts.codexHome } : inheritedEnv;
  const executable = opts.command ? { bin: command, args, env } : agentCommand("codex", args, env);
  const label = method === "account/read" ? "authentication" : method === "model/list" ? "model-list" : "rate-limit";
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1024, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(executable.bin, executable.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: executable.env,
    });
    let settled = false;
    let exited = false;
    let outputBytes = 0;
    let stdoutBuffer = Buffer.alloc(0);
    let expectedResponseId = 1;
    const modelRows: unknown[] = [];
    const cursors = new Set<string>();
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const stopChild = (): void => {
      try { child.stdin.destroy(); } catch { /* result is already fixed */ }
      if (exited) return;
      try { child.kill("SIGTERM"); } catch { return; }
      forceKillTimer = setTimeout(() => {
        if (!exited) {
          try { child.kill("SIGKILL"); } catch { /* process already exited */ }
        }
      }, STOP_GRACE_MS);
      forceKillTimer.unref();
    };

    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (requestTimer) clearTimeout(requestTimer);
      stopChild();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (reason: string): void => finish(new Error(reason));
    const writeMessage = (message: unknown): void => {
      if (settled) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { fail("Codex app-server request write failed"); }
    };
    const inspectMessage = (line: Buffer): void => {
      const text = line.toString("utf8").trim();
      if (!text) return;
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch { fail("Codex app-server returned invalid JSON"); return; }
      const message = asRecord(raw);
      if (!message || message.method !== undefined || message.id !== expectedResponseId) return;
      if (message.error !== undefined && message.error !== null) {
        fail(`Codex app-server RPC ${message.id === 1 ? "initialize" : label} failed`);
        return;
      }
      if (message.id === 1) {
        expectedResponseId = 2;
        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method, ...(params ? { params } : {}) });
        return;
      }
      if (method === "model/list") {
        const page = asRecord(message.result);
        if (!Array.isArray(page?.data) || modelRows.length + page.data.length > 500) {
          fail("Codex app-server model-list response invalid"); return;
        }
        modelRows.push(...page.data);
        const cursor = page.nextCursor;
        if (cursor != null) {
          if (typeof cursor !== "string" || !cursor || cursor.length > 4096 || cursors.has(cursor) || cursors.size >= 4) {
            fail("Codex app-server model-list pagination invalid"); return;
          }
          cursors.add(cursor);
          writeMessage({ id: ++expectedResponseId, method, params: { ...params, cursor } });
          return;
        }
        finish(null, { data: modelRows });
        return;
      }
      finish(null, message.result);
    };
    const countOutput = (chunk: Buffer): boolean => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= maxOutputBytes) return true;
      fail("Codex app-server exceeded its output limit");
      return false;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || !countOutput(chunk)) return;
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      let newline = stdoutBuffer.indexOf(0x0a);
      while (newline >= 0 && !settled) {
        inspectMessage(stdoutBuffer.subarray(0, newline));
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        newline = stdoutBuffer.indexOf(0x0a);
      }
    });
    child.stdout.once("end", () => {
      if (!settled && stdoutBuffer.length) inspectMessage(stdoutBuffer);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (!settled) countOutput(chunk); });
    child.stdin.on("error", () => fail("Codex app-server request write failed"));
    child.once("error", () => fail("Codex app-server could not start"));
    child.once("exit", () => {
      exited = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
    });
    child.once("close", () => {
      exited = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!settled) fail(`Codex app-server exited before returning ${label} data`);
    });
    child.once("spawn", () => writeMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "octopus-codex-router", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    }));
    requestTimer = setTimeout(() => fail(`Codex app-server ${label} request timed out`), timeoutMs);
    requestTimer.unref();
  });
}

export interface CodexAccountRouterOptions {
  accounts: Record<string, string>;
  minimumRemainingPercent?: number;
  now?: () => number;
  readRateLimits?: (slot: string, codexHome: string) => Promise<unknown>;
  okTtlMs?: number;
  errorTtlMs?: number;
  selectionTimeoutMs?: number;
  random?: () => number;
}

export interface CodexAccountSelection {
  slot: string;
  label: string;
  codexHome: string;
  remainingPercent: number;
  resetsAt: number;
  windowDurationMins: number;
}

export interface CodexAccountRoot {
  slot: string;
  label: string;
  codexHome: string;
}

interface AccountSnapshot {
  raw?: unknown;
  selection?: CodexAccountSelection;
  error?: true;
  fetchedAt: number;
}

export function selectCodexRateLimitBucket(raw: unknown): Record<string, unknown> | null {
  const response = asRecord(raw);
  if (!response) return null;
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  return asRecord(byLimitId?.codex) ?? asRecord(response.rateLimits);
}

export function parseCodexRoutingWindow(
  raw: unknown,
  nowMs = Date.now(),
): Omit<CodexAccountSelection, "slot" | "label" | "codexHome"> | null {
  const bucket = selectCodexRateLimitBucket(raw);
  if (!bucket) return null;
  const windows = [bucket.primary, bucket.secondary]
    .map(asRecord)
    .filter((window): window is Record<string, unknown> => window !== null)
    .map((window) => ({
      usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : Number.NaN,
      windowDurationMins: typeof window.windowDurationMins === "number" ? window.windowDurationMins : Number.NaN,
      resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : Number.NaN,
    }))
    .filter((window) =>
      Number.isFinite(window.usedPercent)
      && Number.isFinite(window.windowDurationMins)
      && window.windowDurationMins > 0
      && Number.isFinite(window.resetsAt)
      && window.resetsAt * 1000 > nowMs
    )
    .sort((left, right) => right.windowDurationMins - left.windowDurationMins);
  const window = windows[0];
  if (!window) return null;
  return {
    remainingPercent: Math.min(100, Math.max(0, 100 - window.usedPercent)),
    resetsAt: Math.floor(window.resetsAt * 1000),
    windowDurationMins: window.windowDurationMins,
  };
}

function publicAccountLabel(slot: string, codexHome: string, index: number, used: ReadonlySet<string>): string {
  const named = /^(?:account[-_])([a-z])$/i.exec(path.basename(codexHome))?.[1]
    ?? /^(?:account[-_])([a-z])$/i.exec(slot)?.[1];
  if (named) {
    const label = named.toLowerCase();
    if (!used.has(label)) return label;
  }
  if (index >= 26) throw new Error("Codex 账号池最多支持 26 个单字符展示槽");
  let fallback = index;
  while (fallback < 26) {
    const label = String.fromCharCode("a".charCodeAt(0) + fallback);
    if (!used.has(label)) return label;
    fallback++;
  }
  throw new Error("Codex 账号池展示槽已耗尽");
}

export class CodexAccountRouter {
  private readonly accounts: ReadonlyMap<string, CodexAccountRoot>;
  private readonly minimumRemainingPercent: number;
  private readonly cache = new Map<string, AccountSnapshot>();
  private readonly inflight = new Map<string, Promise<AccountSnapshot>>();

  constructor(private readonly opts: CodexAccountRouterOptions) {
    const entries = Object.entries(opts.accounts);
    if (entries.length === 0) throw new Error("Codex 账号池至少需要一个账号槽");
    const homes = new Set<string>();
    const labels = new Set<string>();
    const accounts = new Map<string, CodexAccountRoot>();
    entries.forEach(([slot, home], index) => {
      if (!SLOT_RE.test(slot)) throw new Error(`无效的 Codex 账号槽名: ${slot}`);
      if (!path.isAbsolute(home)) throw new Error(`Codex 账号槽 ${slot} 的 CODEX_HOME 必须是绝对路径`);
      const normalized = path.resolve(home);
      if (homes.has(normalized)) throw new Error("Codex 账号池的 CODEX_HOME 必须互不相同");
      homes.add(normalized);
      const label = publicAccountLabel(slot, normalized, index, labels);
      labels.add(label);
      accounts.set(slot, { slot, label, codexHome: normalized });
    });
    const threshold = opts.minimumRemainingPercent ?? DEFAULT_MINIMUM_REMAINING_PERCENT;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error("Codex 最低剩余额度必须在 0 到 100 之间");
    }
    this.accounts = accounts;
    this.minimumRemainingPercent = threshold;
  }

  homeForSlot(slot: string): string | undefined { return this.accounts.get(slot)?.codexHome; }
  labelForSlot(slot: string): string | undefined { return this.accounts.get(slot)?.label; }
  roots(): CodexAccountRoot[] { return [...this.accounts.values()]; }
  private now(): number { return (this.opts.now ?? Date.now)(); }

  private async read(account: CodexAccountRoot): Promise<AccountSnapshot> {
    const cached = this.cache.get(account.slot);
    const ttl = cached?.error ? (this.opts.errorTtlMs ?? ERROR_TTL_MS) : (this.opts.okTtlMs ?? OK_TTL_MS);
    if (cached && this.now() - cached.fetchedAt < ttl) return cached;
    const active = this.inflight.get(account.slot);
    if (active) return active;
    const operation = (async (): Promise<AccountSnapshot> => {
      try {
        const raw = await (this.opts.readRateLimits
          ? this.opts.readRateLimits(account.slot, account.codexHome)
          : readCodexAccountRateLimitsFromAppServer({ codexHome: account.codexHome }));
        const window = parseCodexRoutingWindow(raw, this.now());
        return window
          ? { raw, selection: { ...account, ...window }, fetchedAt: this.now() }
          : { raw, error: true, fetchedAt: this.now() };
      } catch {
        return { error: true, fetchedAt: this.now() };
      }
    })().then((snapshot) => {
      // A diagnostic outage does not erase a known window before its reset.
      if (!snapshot.selection && cached?.selection && cached.selection.resetsAt > this.now()) {
        snapshot.selection = cached.selection;
      }
      this.cache.set(account.slot, snapshot);
      this.inflight.delete(account.slot);
      return snapshot;
    });
    this.inflight.set(account.slot, operation);
    return operation;
  }

  /** Inventory and launch routing share the same per-account probe and cache. */
  async rateLimitsForHome(codexHome: string): Promise<unknown> {
    const account = [...this.accounts.values()].find(row => row.codexHome === path.resolve(codexHome));
    return account ? (await this.read(account)).raw : readCodexAccountRateLimitsFromAppServer({ codexHome });
  }

  private async candidates(excludedCodexHome?: string, boundedWait = false): Promise<{ eligible: CodexAccountSelection[]; unknown: CodexAccountRoot[] }> {
    const accounts = [...this.accounts.values()].filter(row => row.codexHome !== excludedCodexHome);
    // Slow diagnostics must not hold the first user message for their full RPC timeout.
    // Probes continue once in the background and populate the shared cache.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probes = Promise.all(accounts.map(account => this.read(account)));
      if (boundedWait) await Promise.race([
        probes,
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.opts.selectionTimeoutMs ?? 1_500); }),
      ]);
      else await probes;
    } finally { if (timer) clearTimeout(timer); }
    const eligible: CodexAccountSelection[] = [];
    const unknown: CodexAccountRoot[] = [];
    for (const account of accounts) {
      const selection = this.cache.get(account.slot)?.selection;
      if (!selection || selection.resetsAt <= this.now()) unknown.push(account);
      else if (selection.remainingPercent >= this.minimumRemainingPercent) eligible.push(selection);
    }
    eligible.sort((left, right) => left.resetsAt - right.resetsAt
      || right.remainingPercent - left.remainingPercent || left.slot.localeCompare(right.slot));
    return { eligible, unknown };
  }

  async selectForNewSession(): Promise<CodexAccountSelection>;
  async selectForNewSession(options: { allowUnknown: true }): Promise<CodexAccountRoot>;
  async selectForNewSession(options?: { allowUnknown: true }): Promise<CodexAccountRoot> {
    const { eligible, unknown } = await this.candidates(undefined, options?.allowUnknown);
    if (eligible[0]) return eligible[0];
    if (options?.allowUnknown && unknown.length) return unknown[Math.floor((this.opts.random ?? Math.random)() * unknown.length)]!;
    throw new Error(`没有可用于新 Codex 会话的账号（要求剩余额度至少 ${this.minimumRemainingPercent}%）`);
  }

  async selectForFallback(currentCodexHome: string): Promise<CodexAccountSelection> {
    const current = path.resolve(currentCodexHome);
    if (![...this.accounts.values()].some((account) => account.codexHome === current)) {
      throw new Error("当前 Codex 会话不属于 Runner 配置的账号池，不能安全切换账号");
    }
    const selected = (await this.candidates(current)).eligible[0];
    if (selected) return selected;
    throw new Error(
      `没有可用于 Codex 账号切换的备用账号（要求剩余额度至少 ${this.minimumRemainingPercent}% 且 reset 时间可读）`,
    );
  }
}

/** Parse the Runner's trusted local JSON account map. Paths never cross RPC. */
export function parseRunnerCodexAccounts(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("RUNNER_CODEX_ACCOUNTS 必须是 JSON 对象"); }
  const record = asRecord(value);
  if (!record) throw new Error("RUNNER_CODEX_ACCOUNTS 必须是 JSON 对象");
  const accounts: Record<string, string> = {};
  for (const [slot, home] of Object.entries(record)) {
    if (typeof home !== "string" || !home.trim()) {
      throw new Error(`RUNNER_CODEX_ACCOUNTS.${slot} 必须是绝对路径字符串`);
    }
    accounts[slot] = home.trim();
  }
  if (!Object.keys(accounts).length) throw new Error("RUNNER_CODEX_ACCOUNTS 至少需要一个账号槽");
  return accounts;
}
