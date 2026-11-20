import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  RUNNER_GATEWAY_PROTOCOL,
  runnerBundleProtocolBanner,
} from "@claude-bot/runner/gateway-protocol";

const STATE_SCHEMA = "runner-bundle-state/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ActiveRunnerBundle {
  sha: string;
  size: number;
  gatewayProtocol: typeof RUNNER_GATEWAY_PROTOCOL;
  bytes: Buffer;
  base64: string;
}

export interface RunnerBundleHealth {
  ok: boolean;
  activeSha: string | null;
  previousSha: string | null;
  gatewayProtocol: typeof RUNNER_GATEWAY_PROTOCOL;
  activatedAt: string | null;
  activatedBy: string | null;
  lastFailure?: { sha: string; reason: string; at: string };
  error?: string;
}

/** Runtime face shared by the WebSocket gateway and Dashboard download route. */
export interface RunnerBundleSource {
  /** Resolves the pointer at call time; another process may have activated it. */
  active(): ActiveRunnerBundle | null;
  health(): RunnerBundleHealth;
}

interface BundleState {
  schema: typeof STATE_SCHEMA;
  active: string | null;
  previous: string | null;
  activated_at: string | null;
  activated_by: string | null;
  last_failure?: { sha: string; reason: string; at: string };
}

interface Inspection {
  state: BundleState;
  bundle: ActiveRunnerBundle | null;
  error?: string;
}

/** The checker did not produce a verdict about the artifact's syntax. */
class BundleSyntaxCheckUnavailable extends Error {}

/**
 * Durable content-addressed Runner client artifacts.
 *
 * Only standalone JavaScript bytes live here. Bot modules remain loaded from
 * the deployed checkout; changing this registry can never replace trusted Bot
 * code. Pointer updates are atomic renames, and every read verifies the object
 * still matches its digest and declared gateway protocol.
 */
export class RunnerBundleRegistry implements RunnerBundleSource {
  private readonly objectsDir: string;
  private readonly stateFile: string;
  private cachedStateJson: string | null = null;
  private cachedBundle: ActiveRunnerBundle | null = null;
  private cachedObjectMtimeMs: number | null = null;
  private cachedObjectSize: number | null = null;
  private syntaxCheckedSha: string | null = null;

  constructor(private readonly root: string) {
    this.objectsDir = path.join(root, "objects");
    this.stateFile = path.join(root, "state.json");
  }

  /** Import the deployed checkout only for a brand-new registry. */
  initialize(seedPath?: string, activatedBy = "bootstrap:checkout"): RunnerBundleHealth {
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.stateFile) && seedPath) {
      try {
        this.activate(readFileSync(seedPath), activatedBy);
      } catch (error) {
        const health = this.health();
        return { ...health, error: `checkout runner bundle seed rejected: ${errorMessage(error)}` };
      }
    }
    return this.health();
  }

  activate(bytes: Buffer, activatedBy: string, now = new Date()): RunnerBundleHealth {
    const candidate = bundleFromBytes(bytes);
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    const objectPath = this.objectPath(candidate.sha);
    if (existsSync(objectPath)) {
      // A digest label is immutable. Re-read rather than trusting an existing
      // name left by a partial or hostile write.
      validateBundleFile(objectPath, candidate.sha);
    } else {
      atomicWrite(objectPath, bytes);
      validateBundleFile(objectPath, candidate.sha);
    }

    const before = this.readStateOrEmpty();
    const next: BundleState = {
      schema: STATE_SCHEMA,
      active: candidate.sha,
      previous: before.active === candidate.sha ? before.previous : before.active,
      activated_at: now.toISOString(),
      activated_by: requireActor(activatedBy),
    };
    this.writeState(next);
    const inspected = this.inspect(false);
    if (!inspected.bundle || inspected.bundle.sha !== candidate.sha) {
      this.writeState(before);
      throw new Error(`runner bundle activation failed health check: ${inspected.error ?? "active digest mismatch"}`);
    }
    return healthOf(inspected);
  }

  rollback(activatedBy: string, now = new Date()): RunnerBundleHealth {
    const before = this.readState();
    if (!before.previous) throw new Error("runner bundle has no previous pointer to roll back to");
    validateBundleFile(this.objectPath(before.previous), before.previous);
    const next: BundleState = {
      schema: STATE_SCHEMA,
      active: before.previous,
      previous: before.active,
      activated_at: now.toISOString(),
      activated_by: requireActor(activatedBy),
    };
    this.writeState(next);
    const inspected = this.inspect(false);
    if (!inspected.bundle || inspected.bundle.sha !== next.active) {
      this.writeState(before);
      throw new Error(`runner bundle rollback failed health check: ${inspected.error ?? "active digest mismatch"}`);
    }
    return healthOf(inspected);
  }

  active(): ActiveRunnerBundle | null {
    return this.inspect(true).bundle;
  }

  health(): RunnerBundleHealth {
    return healthOf(this.inspect(true, true));
  }

  private inspect(recover: boolean, forceObjectRead = false): Inspection {
    let state: BundleState;
    try {
      state = this.readState();
    } catch (error) {
      return { state: emptyState(), bundle: null, error: errorMessage(error) };
    }
    if (!state.active) return { state, bundle: null, error: "runner bundle has no active pointer" };
    try {
      return { state, bundle: this.loadCached(state, forceObjectRead) };
    } catch (error) {
      const reason = errorMessage(error);
      // A timeout, spawn failure or killed checker is not evidence that the
      // published bytes are broken. Report unhealthy for this check, preserve
      // the pointers and let the next health call retry the same artifact.
      if (error instanceof BundleSyntaxCheckUnavailable) {
        return { state, bundle: null, error: reason };
      }
      if (!recover || !state.previous || state.previous === state.active) {
        return { state, bundle: null, error: reason };
      }
      try {
        const previous = validateBundleFile(this.objectPath(state.previous), state.previous);
        const recoveredAt = new Date().toISOString();
        const recovered: BundleState = {
          schema: STATE_SCHEMA,
          active: state.previous,
          previous: state.active,
          activated_at: recoveredAt,
          activated_by: "automatic:health-rollback",
          last_failure: { sha: state.active, reason, at: recoveredAt },
        };
        this.writeState(recovered);
        this.cachedBundle = previous;
        return { state: recovered, bundle: previous };
      } catch (rollbackError) {
        return {
          state,
          bundle: null,
          error: `${reason}; previous bundle is also unhealthy: ${errorMessage(rollbackError)}`,
        };
      }
    }
  }

  private loadCached(state: BundleState, forceObjectRead: boolean): ActiveRunnerBundle {
    const raw = JSON.stringify(state);
    const objectPath = this.objectPath(state.active!);
    const stats = statSync(objectPath);
    if (
      !forceObjectRead
      && this.cachedStateJson === raw
      && this.cachedBundle?.sha === state.active
      && this.cachedObjectMtimeMs === stats.mtimeMs
      && this.cachedObjectSize === stats.size
    ) return this.cachedBundle;
    const bundle = loadBundleFile(objectPath, state.active!);
    // Health still re-reads and hashes the bytes on every call. Successful
    // syntax validation belongs to that exact digest, so dashboard polling
    // need not spawn Node repeatedly for identical content. Never cache an
    // unavailable check; a later call must be able to recover.
    if (forceObjectRead && this.syntaxCheckedSha !== bundle.sha) {
      checkBundleSyntax(objectPath);
      this.syntaxCheckedSha = bundle.sha;
    }
    this.cachedStateJson = raw;
    this.cachedBundle = bundle;
    this.cachedObjectMtimeMs = stats.mtimeMs;
    this.cachedObjectSize = stats.size;
    return bundle;
  }

  private readStateOrEmpty(): BundleState {
    if (!existsSync(this.stateFile)) return emptyState();
    return this.readState();
  }

  private readState(): BundleState {
    const raw = readFileSync(this.stateFile, "utf8");
    return bundleStateFrom(JSON.parse(raw) as unknown);
  }

  private writeState(state: BundleState): void {
    atomicWrite(this.stateFile, Buffer.from(`${JSON.stringify(state)}\n`, "utf8"));
    this.cachedStateJson = null;
    this.cachedBundle = null;
    this.cachedObjectMtimeMs = null;
    this.cachedObjectSize = null;
  }

  private objectPath(sha: string): string {
    if (!SHA256.test(sha)) throw new Error("runner bundle pointer is not a sha256 digest");
    return path.join(this.objectsDir, `${sha}.js`);
  }
}

function bundleFromBytes(bytes: Buffer): ActiveRunnerBundle {
  if (bytes.length === 0) throw new Error("runner bundle candidate is empty");
  const firstLineEnd = bytes.indexOf(0x0a);
  const firstLine = bytes.subarray(0, firstLineEnd === -1 ? bytes.length : firstLineEnd).toString("utf8").trimEnd();
  const expected = runnerBundleProtocolBanner();
  if (firstLine !== expected) {
    throw new Error(`runner bundle gateway protocol is incompatible: expected first line ${JSON.stringify(expected)}`);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  return {
    sha,
    size: bytes.length,
    gatewayProtocol: RUNNER_GATEWAY_PROTOCOL,
    bytes,
    base64: bytes.toString("base64"),
  };
}

function validateBundleFile(file: string, expectedSha: string): ActiveRunnerBundle {
  const bundle = loadBundleFile(file, expectedSha);
  checkBundleSyntax(file);
  return bundle;
}

function checkBundleSyntax(file: string): void {
  const checked = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (checked.error || checked.signal || checked.status === null) {
    const detail = checked.error?.message ?? (checked.signal ? `signal ${checked.signal}` : "no exit status");
    throw new BundleSyntaxCheckUnavailable(`runner bundle syntax check unavailable: ${detail}`);
  }
  if (checked.status !== 0) {
    const detail = (checked.stderr || checked.stdout).trim().split("\n").at(-1) || `exit ${checked.status}`;
    throw new Error(`runner bundle syntax check failed: ${detail}`);
  }
}

function loadBundleFile(file: string, expectedSha: string): ActiveRunnerBundle {
  const bundle = bundleFromBytes(readFileSync(file));
  if (bundle.sha !== expectedSha) {
    throw new Error(`runner bundle object ${expectedSha} contains digest ${bundle.sha}`);
  }
  return bundle;
}

function bundleStateFrom(value: unknown): BundleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runner bundle state is not an object");
  const row = value as Record<string, unknown>;
  if (row.schema !== STATE_SCHEMA) throw new Error("runner bundle state schema is unsupported");
  const active = digestOrNull(row.active, "active");
  const previous = digestOrNull(row.previous, "previous");
  if (typeof row.activated_at !== "string" && row.activated_at !== null) throw new Error("runner bundle activated_at is invalid");
  if (typeof row.activated_by !== "string" && row.activated_by !== null) throw new Error("runner bundle activated_by is invalid");
  let lastFailure: BundleState["last_failure"];
  if (row.last_failure !== undefined) {
    if (!row.last_failure || typeof row.last_failure !== "object" || Array.isArray(row.last_failure)) {
      throw new Error("runner bundle last_failure is invalid");
    }
    const failure = row.last_failure as Record<string, unknown>;
    if (!SHA256.test(String(failure.sha)) || typeof failure.reason !== "string" || typeof failure.at !== "string") {
      throw new Error("runner bundle last_failure is invalid");
    }
    lastFailure = { sha: String(failure.sha), reason: failure.reason, at: failure.at };
  }
  return {
    schema: STATE_SCHEMA,
    active,
    previous,
    activated_at: row.activated_at as string | null,
    activated_by: row.activated_by as string | null,
    ...(lastFailure ? { last_failure: lastFailure } : {}),
  };
}

function digestOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`runner bundle ${field} pointer is invalid`);
  return value;
}

function emptyState(): BundleState {
  return { schema: STATE_SCHEMA, active: null, previous: null, activated_at: null, activated_by: null };
}

function healthOf(inspected: Inspection): RunnerBundleHealth {
  return {
    ok: inspected.bundle !== null,
    activeSha: inspected.bundle?.sha ?? inspected.state.active,
    previousSha: inspected.state.previous,
    gatewayProtocol: RUNNER_GATEWAY_PROTOCOL,
    activatedAt: inspected.state.activated_at,
    activatedBy: inspected.state.activated_by,
    ...(inspected.state.last_failure ? { lastFailure: inspected.state.last_failure } : {}),
    ...(inspected.error ? { error: inspected.error } : {}),
  };
}

function requireActor(value: string): string {
  const actor = value.trim();
  if (!actor || actor.length > 200) throw new Error("runner bundle activation actor is required and must be at most 200 characters");
  return actor;
}

function atomicWrite(file: string, bytes: Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
