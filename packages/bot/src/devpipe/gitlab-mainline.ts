/** GitLab owns both the watermark and its integration lease. No Head process is required.
 * Every cooperating writer advances the coordination ref AND mainline in one atomic
 * push. A superseded lease cannot publish, even after a partition or process restart.
 * Branch protection must prohibit force pushes and writers outside this protocol.
 */
import { runChild } from "./child-output.js";
import { randomUUID } from "node:crypto";

export const MAINLINE_CONTROL_BRANCH = "octopus-coordination";
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,159}$/;
const MAX_STATE = 64 * 1024;
export interface IntegrationIdentity { id: string; owner: string; label: string }
export interface IntegrationLease extends IntegrationIdentity {
  epoch: string; base: string; acquiredAt: number; expiresAt: number;
}
export interface MainlineState {
  version: 1; branch: string; activatedAt: number;
  holder: IntegrationLease | null;
  queue: Array<IntegrationIdentity & { queuedAt: number }>;
  reservation: { id: string; expiresAt: number } | null;
  lastLanding: { id: string; owner: string; base: string; sha: string; at: number; emergency?: string } | null;
}
export interface MainlineSnapshot { main: string; revision: string; state: MainlineState }
export type IntegrationClaim = { acquired: true; lease: IntegrationLease }
  | { acquired: false; position: number; holder: IntegrationIdentity | null; reservedFor: string | null };
export class MainlineError extends Error {
  definiteRejection = false;
  constructor(readonly code: "inactive" | "invalid" | "busy" | "lost_lease" | "base_moved" | "unknown" | "git", message: string) {
    super(message); this.name = "MainlineError";
  }
}
export interface GitLabMainlineOptions {
  repoDir: string; remote?: string; branch?: string; controlBranch?: string;
  leaseMs?: number; reservationMs?: number; now?: () => number;
}

async function runGit(cwd: string, args: string[], input?: string): Promise<string> {
  // No maxBuffer: output volume must not turn a mainline step into a failure.
  const run = await runChild("git", args, {
    cwd, timeoutMs: 45_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...(input === undefined ? {} : { input }),
  });
  const stdout = run.stdout.text();
  // Remote diagnostics may contain a credential-bearing URL. Do not relay them.
  if (run.error) {
    const failure = new MainlineError("git", `git ${args[0]} failed; inspect repository access and branch protection`);
    failure.definiteRejection = args[0] === "push" && /^!\t.*\[(?:remote )?rejected\]/m.test(stdout);
    throw failure;
  }
  return stdout.trim();
}
function validIdentity(value: IntegrationIdentity): boolean {
  return Boolean(value && typeof value.id === "string" && ID.test(value.id)
    && typeof value.owner === "string" && ID.test(value.owner)
    && typeof value.label === "string" && value.label.length > 0 && value.label.length <= 200);
}
function parseState(raw: string, branch: string): MainlineState {
  if (Buffer.byteLength(raw) > MAX_STATE) throw new MainlineError("invalid", "coordination state exceeds its limit");
  let s: MainlineState;
  try { s = JSON.parse(raw) as MainlineState; } catch { throw new MainlineError("invalid", "invalid coordination JSON"); }
  const time = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!s || s.version !== 1 || s.branch !== branch || !time(s.activatedAt)
    || !Array.isArray(s.queue) || s.queue.length > 128 || s.queue.some(q => !validIdentity(q) || !time(q.queuedAt))
    || new Set(s.queue.map(q => q.id)).size !== s.queue.length
    || (s.holder !== null && (!validIdentity(s.holder) || typeof s.holder.epoch !== "string" || !ID.test(s.holder.epoch) || typeof s.holder.base !== "string" || !SHA.test(s.holder.base)
      || !time(s.holder.acquiredAt) || !time(s.holder.expiresAt) || s.queue.some(q => q.id === s.holder!.id)))
    || (s.reservation !== null && (!s.reservation || typeof s.reservation.id !== "string" || !ID.test(s.reservation.id) || !time(s.reservation.expiresAt)
      || s.queue[0]?.id !== s.reservation.id || s.holder !== null))
    || (s.lastLanding !== null && (!s.lastLanding || typeof s.lastLanding.id !== "string" || typeof s.lastLanding.owner !== "string" || !ID.test(s.lastLanding.id) || !ID.test(s.lastLanding.owner)
      || !SHA.test(s.lastLanding.base) || !SHA.test(s.lastLanding.sha) || !time(s.lastLanding.at)
      || (s.lastLanding.emergency !== undefined && (typeof s.lastLanding.emergency !== "string" || s.lastLanding.emergency.length > 1000))))) {
    throw new MainlineError("invalid", "coordination state does not match this repository protocol");
  }
  return s;
}

export class GitLabMainline {
  readonly remote: string;
  readonly branch: string;
  readonly controlBranch: string;
  readonly leaseMs: number;
  private readonly reservationMs: number;
  private readonly now: () => number;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly options: GitLabMainlineOptions) {
    this.remote = options.remote ?? "origin"; this.branch = options.branch ?? "v4";
    this.controlBranch = options.controlBranch ?? MAINLINE_CONTROL_BRANCH;
    this.leaseMs = options.leaseMs ?? 120_000; this.reservationMs = options.reservationMs ?? 120_000;
    this.now = options.now ?? Date.now;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(this.remote)
      || [this.branch, this.controlBranch].some(r => !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(r) || r.includes("..") || r.endsWith(".lock"))
      || this.branch === this.controlBranch || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 || this.leaseMs > 900_000
      || !Number.isSafeInteger(this.reservationMs) || this.reservationMs < 1000 || this.reservationMs > 900_000) {
      throw new MainlineError("invalid", "invalid mainline configuration");
    }
  }
  private git(args: string[], input?: string): Promise<string> { return runGit(this.options.repoDir, args, input); }
  private ref(branch: string): string { return `refs/heads/${branch}`; }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn); this.serial = result.catch(() => undefined); return result;
  }
  private async refs(): Promise<{ main: string; revision: string }> {
    const rows = (await this.git(["ls-remote", "--refs", this.remote, this.ref(this.branch), this.ref(this.controlBranch)]))
      .split("\n").filter(Boolean).map(row => row.split(/\s+/));
    const main = rows.find(row => row[1] === this.ref(this.branch))?.[0];
    const revision = rows.find(row => row[1] === this.ref(this.controlBranch))?.[0] ?? "";
    if (!main || !SHA.test(main) || (revision && !SHA.test(revision))) throw new MainlineError("invalid", "remote mainline is missing");
    return { main, revision };
  }
  async snapshot(): Promise<MainlineSnapshot> {
    const refs = await this.refs();
    if (!refs.revision) throw new MainlineError("inactive", "GitLab authority has not been activated; use the current landing service");
    await this.git(["fetch", "--no-tags", "--no-write-fetch-head", this.remote, refs.main, refs.revision]);
    return { ...refs, state: parseState(await this.git(["show", `${refs.revision}:state.json`]), this.branch) };
  }
  /** Explicit cutover only: the caller has drained the old writer and compared both tips. */
  async activate(expectedMain: string): Promise<MainlineSnapshot> {
    return this.exclusive(async () => {
      const refs = await this.refs();
      if (refs.revision || refs.main !== expectedMain) throw new MainlineError("invalid", "activation requires an absent control ref and the exact agreed mainline");
      const state: MainlineState = { version: 1, branch: this.branch, activatedAt: this.now(), holder: null, queue: [], reservation: null, lastLanding: null };
      await this.commitState(refs, state);
      return this.snapshot();
    });
  }
  private advanceQueue(state: MainlineState): void {
    const now = this.now();
    if (state.holder && state.holder.expiresAt <= now) state.holder = null;
    if (state.reservation && state.reservation.expiresAt <= now) {
      state.queue = state.queue.filter(q => q.id !== state.reservation!.id); state.reservation = null;
    }
    if (!state.holder && !state.reservation && state.queue[0]) {
      state.reservation = { id: state.queue[0].id, expiresAt: now + this.reservationMs };
    }
  }
  async maintainQueue(): Promise<MainlineSnapshot> {
    return this.exclusive(async () => {
      const s = await this.snapshot(), before = JSON.stringify(s.state);
      this.advanceQueue(s.state);
      if (before !== JSON.stringify(s.state)) { await this.commitState(s, s.state); return this.snapshot(); }
      return s;
    });
  }
  async acquire(identity: IntegrationIdentity): Promise<IntegrationClaim> {
    if (!validIdentity(identity)) throw new MainlineError("invalid", "invalid integration identity");
    return this.exclusive(async () => {
      const snapshot = await this.snapshot(), state = snapshot.state;
      this.advanceQueue(state);
      if (state.holder?.id === identity.id) {
        if (state.holder.owner !== identity.owner) throw new MainlineError("invalid", "integration identity belongs to another owner");
        // An attempt id is idempotent; it is not a bearer credential or a new grant.
        return { acquired: true, lease: state.holder };
      }
      const prior = state.queue.find(q => q.id === identity.id);
      if (prior && prior.owner !== identity.owner) throw new MainlineError("invalid", "queued integration belongs to another owner");
      if (!prior) {
        if (state.queue.length >= 128) throw new MainlineError("busy", "integration queue is full");
        state.queue.push({ ...identity, queuedAt: this.now() });
      }
      if (!state.holder && state.queue[0]?.id === identity.id) {
        state.queue.shift(); state.reservation = null;
        state.holder = { ...identity, epoch: randomUUID(), base: snapshot.main, acquiredAt: this.now(), expiresAt: this.now() + this.leaseMs };
        await this.commitState(snapshot, state);
        return { acquired: true, lease: state.holder };
      }
      this.advanceQueue(state);
      await this.commitState(snapshot, state);
      return { acquired: false, position: state.queue.findIndex(q => q.id === identity.id) + 1,
        holder: state.holder, reservedFor: state.reservation?.id ?? null };
    });
  }
  private holder(snapshot: MainlineSnapshot, lease: IntegrationLease): IntegrationLease {
    const h = snapshot.state.holder;
    if (!h || h.id !== lease.id || h.owner !== lease.owner || h.epoch !== lease.epoch || h.expiresAt <= this.now()) {
      throw new MainlineError("lost_lease", "integration lease expired or was taken over; acquire again before publishing");
    }
    return h;
  }
  async renew(lease: IntegrationLease): Promise<IntegrationLease> {
    return this.exclusive(async () => {
      const s = await this.snapshot(), h = this.holder(s, lease);
      h.expiresAt = this.now() + this.leaseMs;
      await this.commitState(s, s.state); return h;
    });
  }
  async release(lease: IntegrationLease): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.snapshot(), h = s.state.holder;
      if (!h || h.id !== lease.id || h.epoch !== lease.epoch || h.owner !== lease.owner) return;
      s.state.holder = null; this.advanceQueue(s.state); await this.commitState(s, s.state);
    });
  }
  async cancel(identity: Pick<IntegrationIdentity, "id" | "owner">): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.snapshot();
      s.state.queue = s.state.queue.filter(q => q.id !== identity.id || q.owner !== identity.owner);
      if (s.state.reservation && s.state.queue[0]?.id !== s.state.reservation.id) s.state.reservation = null;
      this.advanceQueue(s.state); await this.commitState(s, s.state);
    });
  }
  async publish(lease: IntegrationLease, candidate: string): Promise<string> {
    return this.exclusive(async () => {
      const s = await this.snapshot(), h = this.holder(s, lease);
      if (s.main !== h.base) throw new MainlineError("base_moved", "mainline changed outside this integration; review and acquire a fresh lease");
      await this.validateCandidate(s.main, candidate);
      s.state.lastLanding = { id: h.id, owner: h.owner, base: s.main, sha: candidate, at: this.now() };
      s.state.holder = null; this.advanceQueue(s.state);
      await this.commitState(s, s.state, candidate); return candidate;
    });
  }
  /** An explicit, audited takeover. It fences the old lease even if its clock has not expired. */
  async takeover(identity: IntegrationIdentity, reason: string): Promise<IntegrationLease> {
    if (!validIdentity(identity) || !reason.trim() || reason.length > 1000) throw new MainlineError("invalid", "takeover requires an identity and bounded reason");
    return this.exclusive(async () => {
      const s = await this.snapshot();
      s.state.queue = s.state.queue.filter(q => q.id !== identity.id); s.state.reservation = null;
      s.state.holder = { ...identity, epoch: randomUUID(), base: s.main, acquiredAt: this.now(), expiresAt: this.now() + this.leaseMs };
      await this.commitState(s, s.state, undefined, `takeover: ${reason}`); return s.state.holder;
    });
  }
  /** Optimistic emergency path when the coordination ref itself cannot be used.
   * Never automatic; mainline CAS + ancestry still apply. The immutable receipt
   * is committed on a separate ref in the SAME transaction as the advancement.
   */
  async emergencyPublish(identity: IntegrationIdentity, expected: string, candidate: string, reason: string): Promise<string> {
    if (!validIdentity(identity) || !reason.trim() || reason.length > 1000 || !SHA.test(expected)) throw new MainlineError("invalid", "emergency publish requires exact base and reason");
    return this.exclusive(async () => {
      await this.validateCandidate(expected, candidate);
      const receipt = await this.makeCommit({ version: 1, identity, base: expected, sha: candidate, reason, at: this.now() }, "", "emergency mainline advancement");
      const ref = this.ref(`octopus-emergency/${randomUUID()}`);
      try {
        await this.git(["push", "--atomic", "--porcelain", `--force-with-lease=${this.ref(this.branch)}:${expected}`,
          `--force-with-lease=${ref}:`, this.remote, `${candidate}:${this.ref(this.branch)}`, `${receipt}:${ref}`]);
      } catch {
        const rows = await this.git(["ls-remote", "--refs", this.remote, ref]).catch(() => "");
        if (!rows.startsWith(`${receipt}\t`)) throw new MainlineError("unknown", `emergency outcome unknown; reconcile ${ref} before retrying`);
      }
      return candidate;
    });
  }
  private async validateCandidate(base: string, candidate: string): Promise<void> {
    if (!SHA.test(candidate) || base === candidate) throw new MainlineError("invalid", "candidate must be a different exact commit SHA");
    await this.git(["merge-base", "--is-ancestor", base, candidate]).catch(() => { throw new MainlineError("base_moved", "candidate must fast-forward the current mainline; rebase and revalidate first"); });
    if (await this.git(["rev-list", "--merges", `${base}..${candidate}`])) throw new MainlineError("invalid", "new mainline commits must be linear (rebase or squash merge commits)");
  }
  private async makeCommit(state: unknown, parent: string, message: string): Promise<string> {
    const raw = JSON.stringify(state);
    if (Buffer.byteLength(raw) > MAX_STATE) throw new MainlineError("invalid", "coordination state is too large");
    const blob = await this.git(["hash-object", "-w", "--stdin"], raw);
    const tree = await this.git(["mktree"], `100644 blob ${blob}\tstate.json\n`);
    return this.git(["-c", "user.name=Octopus coordination", "-c", "user.email=octopus@localhost", "commit-tree", tree,
      ...(parent ? ["-p", parent] : []), "-m", message]);
  }
  private async commitState(before: { main: string; revision: string }, state: MainlineState, candidate?: string, note = "integration lease"): Promise<void> {
    const next = await this.makeCommit(state, before.revision, note);
    const ref = this.ref(this.controlBranch);
    try {
      await this.git(["push", "--atomic", "--porcelain", `--force-with-lease=${ref}:${before.revision}`,
        ...(candidate ? [`--force-with-lease=${this.ref(this.branch)}:${before.main}`] : []),
        this.remote, `${next}:${ref}`, ...(candidate ? [`${candidate}:${this.ref(this.branch)}`] : [])]);
    } catch (error) {
      // A lost ACK is not permission to repeat a write. Prove the exact proposed
      // commit survived in the remote's append-only control history instead.
      let current: MainlineSnapshot;
      try { current = await this.snapshot(); }
      catch { throw new MainlineError("unknown", `coordination outcome unknown; reconcile revision ${next} before retrying`); }
      const recorded = await this.git(["merge-base", "--is-ancestor", next, current.revision]).then(() => true, () => false);
      if (!recorded) {
        if (error instanceof MainlineError && error.definiteRejection) throw new MainlineError("busy", "coordination changed concurrently or was rejected; refresh before retrying");
        throw new MainlineError("unknown", `coordination outcome unknown; reconcile revision ${next} before retrying`);
      }
      if (candidate) await this.git(["merge-base", "--is-ancestor", candidate, current.main]).catch(() => {
        throw new MainlineError("invalid", "recorded landing is missing from mainline; stop and repair authority");
      });
    }
  }
}
