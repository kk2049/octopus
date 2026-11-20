/** G0: content-free, per-user usage and routing evidence. */
import { createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONVERGENCE_CANDIDATES = Object.freeze([
  "bot-agent-session",
  "engine-agent-plane",
  "v3-host-factory",
  "native-session-ui",
  "app-agent-effects",
  "runner-device",
] as const);

export type ConvergenceCandidate = (typeof CONVERGENCE_CANDIDATES)[number];
export type ConvergenceEffect = "read" | "write" | "execute" | "lifecycle";
export type ConvergenceOutcome = "ok" | "refused" | "failed" | "unknown" | "fallback" | "observed";

export interface ConvergenceUsageInput {
  candidate: ConvergenceCandidate;
  /** Authenticated principal from the trusted closure. It is HMACed before storage. */
  principal: string;
  /** Stable symbolic entry point, never an HTTP path containing parameters. */
  entry: string;
  /** Stable provider id, for example legacy-agent-session, dsh or runner. */
  provider: string;
  /** Optional device/endpoint identity. It is HMACed before storage. */
  endpoint?: string;
  effect: ConvergenceEffect;
  outcome: ConvergenceOutcome;
  /** Closed/symbolic reason such as offline or approval_required. */
  reason?: string;
  /** Stable release id or digest; never an artifact path. */
  release?: string;
  /** True only when the provider actually changed for this attempt. */
  fallback?: boolean;
}

export interface ConvergenceUsageEvent extends Omit<ConvergenceUsageInput, "principal" | "endpoint"> {
  schema: 1;
  at: string;
  /** Irreversible HMAC prefix; enough to group one window, not recover identity. */
  userKey: string;
  /** Irreversible endpoint grouping key; the raw device id is never stored. */
  endpointKey?: string;
}

export interface ConvergenceUsageSink {
  record(input: ConvergenceUsageInput): void;
  flush(): Promise<void>;
}

const SYMBOL = /^[a-z][a-z0-9_.:-]{0,95}$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function validInput(input: ConvergenceUsageInput): boolean {
  return CONVERGENCE_CANDIDATES.includes(input.candidate)
    && input.principal.length > 0
    && input.principal.length <= 256
    && (!input.endpoint || input.endpoint.length <= 256)
    && SYMBOL.test(input.entry)
    && SYMBOL.test(input.provider)
    && (!input.reason || SYMBOL.test(input.reason))
    && (!input.release || (RELEASE.test(input.release) && !CONTROL.test(input.release)))
    && (!input.fallback || input.outcome === "fallback");
}

export class MemoryConvergenceUsage implements ConvergenceUsageSink {
  readonly events: ConvergenceUsageEvent[] = [];

  constructor(private readonly secret = randomBytes(32), private readonly now = () => new Date()) {}

  record(input: ConvergenceUsageInput): void {
    if (!validInput(input)) return;
    this.events.push(eventOf(input, this.secret, this.now()));
  }

  async flush(): Promise<void> {}
}

/**
 * Append-only evidence store. Directory and files are private; failed writes
 * never affect the product path. There is deliberately no raw arbitrary bag.
 */
export class FileConvergenceUsage implements ConvergenceUsageSink {
  private tail: Promise<void> = Promise.resolve();
  private readonly secret: Buffer;

  constructor(private readonly root: string, private readonly now = () => new Date()) {
    if (!path.isAbsolute(root)) throw new Error("convergence usage root must be absolute");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.secret = loadOrCreateSecret(path.join(root, "user-hmac.key"));
  }

  record(input: ConvergenceUsageInput): void {
    if (!validInput(input)) return;
    const now = this.now();
    const event = eventOf(input, this.secret, now);
    const file = path.join(this.root, `usage-${now.toISOString().slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify(event)}\n`;
    this.tail = this.tail
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      })
      // Metrics must never take down the operation they describe. A later
      // `flush()` still resolves; the missing interval makes G0 unknown.
      .catch(() => {});
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}

function eventOf(input: ConvergenceUsageInput, secret: Buffer, now: Date): ConvergenceUsageEvent {
  const { principal, endpoint, ...safe } = input;
  return Object.freeze({
    schema: 1,
    at: now.toISOString(),
    userKey: createHmac("sha256", secret).update(principal).digest("hex").slice(0, 24),
    ...(endpoint
      ? { endpointKey: createHmac("sha256", secret).update(`endpoint\0${endpoint}`).digest("hex").slice(0, 24) }
      : {}),
    ...safe,
  });
}

function loadOrCreateSecret(file: string): Buffer {
  try {
    const value = readFileSync(file);
    if (value.length !== 32) throw new Error("convergence usage HMAC key must contain exactly 32 bytes");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = randomBytes(32);
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, value);
    } finally {
      closeSync(fd);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(file);
    if (existing.length !== 32) throw new Error("convergence usage HMAC key must contain exactly 32 bytes");
    return existing;
  }
}

let active: ConvergenceUsageSink | null = null;

/** Configure once from a trusted composition root. Repeating with the same root is harmless. */
export function configureConvergenceUsage(root: string): ConvergenceUsageSink {
  if (!active) active = new FileConvergenceUsage(root);
  return active;
}

export function setConvergenceUsageForTest(sink: ConvergenceUsageSink | null): void {
  active = sink;
}

/** No-op until a composition root configures G0 storage. */
export function recordConvergenceUsage(input: ConvergenceUsageInput): void {
  active?.record(input);
}

export interface UsageWindowVerdict {
  status: "pass" | "fail" | "unknown";
  authorizesMigration: false;
  start: string;
  end: string;
  users: number;
  events: number;
  missingCandidates: ConvergenceCandidate[];
  problems: string[];
  /** Content-free counts at the exact dimensions required by G0. */
  counts: UsageWindowCount[];
}

export interface UsageWindowCount {
  userKey: string;
  endpointKey?: string;
  candidate: ConvergenceCandidate;
  entry: string;
  provider: string;
  release?: string;
  effect: ConvergenceEffect;
  outcome: ConvergenceOutcome;
  reason?: string;
  fallback: boolean;
  count: number;
}

/**
 * A window is evidence only when every candidate emitted either activity or an
 * explicit `observed` zero marker. This avoids treating an unwired counter as
 * zero usage. `minimumWindowMs` is set by the migration brief, not hidden here.
 */
export function evaluateUsageWindow(
  events: readonly ConvergenceUsageEvent[],
  start: Date,
  end: Date,
  minimumWindowMs: number,
): UsageWindowVerdict {
  const problems: string[] = [];
  if (!(minimumWindowMs > 0)) problems.push("minimum window must be positive");
  if (end.getTime() <= start.getTime()) problems.push("window end must be after start");
  if (end.getTime() - start.getTime() < minimumWindowMs) problems.push("observation window is too short");

  const inside = events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= start.getTime() && at <= end.getTime();
  });
  const covered = new Set(inside.map((event) => event.candidate));
  const missingCandidates = CONVERGENCE_CANDIDATES.filter((candidate) => !covered.has(candidate));
  if (missingCandidates.length) problems.push(`missing candidate evidence: ${missingCandidates.join(", ")}`);

  const invalid = inside.filter((event) => !validEvent(event));
  if (invalid.length) problems.push(`${invalid.length} malformed event(s)`);

  const grouped = new Map<string, UsageWindowCount>();
  for (const event of inside) {
    if (!validEvent(event)) continue;
    const row: UsageWindowCount = {
      userKey: event.userKey,
      ...(event.endpointKey ? { endpointKey: event.endpointKey } : {}),
      candidate: event.candidate,
      entry: event.entry,
      provider: event.provider,
      ...(event.release ? { release: event.release } : {}),
      effect: event.effect,
      outcome: event.outcome,
      ...(event.reason ? { reason: event.reason } : {}),
      fallback: event.fallback === true,
      count: 0,
    };
    const key = JSON.stringify(row);
    const prior = grouped.get(key);
    if (prior) prior.count += 1;
    else grouped.set(key, { ...row, count: 1 });
  }
  const counts = [...grouped.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    status: problems.length === 0 ? "pass" : inside.length === 0 ? "unknown" : "fail",
    authorizesMigration: false,
    start: start.toISOString(),
    end: end.toISOString(),
    users: new Set(inside.map((event) => event.userKey)).size,
    events: inside.length,
    missingCandidates: [...missingCandidates],
    problems,
    counts,
  };
}

function validEvent(event: ConvergenceUsageEvent): boolean {
  if (!/^[a-f0-9]{24}$/.test(event.userKey)) return false;
  if (event.endpointKey !== undefined && !/^[a-f0-9]{24}$/.test(event.endpointKey)) return false;
  return validInput({
    candidate: event.candidate,
    principal: "hashed",
    ...(event.endpointKey ? { endpoint: "hashed" } : {}),
    entry: event.entry,
    provider: event.provider,
    effect: event.effect,
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(event.fallback ? { fallback: event.fallback } : {}),
  });
}

export async function readUsageFiles(files: readonly string[]): Promise<ConvergenceUsageEvent[]> {
  const events: ConvergenceUsageEvent[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as ConvergenceUsageEvent;
        if (row.schema === 1) events.push(row);
      } catch {
        // A torn last line is absence of evidence. G0 cannot pass from it.
      }
    }
  }
  return events;
}
