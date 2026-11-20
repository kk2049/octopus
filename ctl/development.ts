/** Native CLI development: uses GitLab directly and never launches an agent. */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { promises as fs, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { LocalBridgeClient, defaultLocalAgentBridgeSocket } from "../packages/runner/src/local-agent-bridge.js";
import { setTimeout as delay } from "node:timers/promises";
import { GitLabMainline, MainlineError, type IntegrationIdentity, type IntegrationLease } from "../packages/bot/src/devpipe/gitlab-mainline.js";
import { IntegrationLeaseKeeper } from "../packages/bot/src/devpipe/integration-lease.js";
import { gitOrThrow } from "../packages/bot/src/devpipe/worktree.js";
import { LandGate } from "../packages/bot/src/devpipe/land-gate.js";
import { localDelivery } from "../packages/bot/src/devpipe/local-delivery.js";
import { holdDeadline, keepRenewing, leaseOwner, type LeaseOwner } from "./development-lease.js";

interface DevelopmentState {
  version: 1; identity: IntegrationIdentity; lease?: IntegrationLease; deadline?: number;
  /** Renewal stops once this acquiring process is gone; absent = hold cap only. */
  owner?: LeaseOwner;
  heartbeat?: { pid: number; epoch: string }; lastLanding?: { base: string; sha: string; at: string };
  native?: { ticket_id: number; owner: string; session_id: string };
  coordination?: { remote: string; branch: string; controlBranch: string };
}
const entry = fileURLToPath(import.meta.url);
const parsed = parseArgs({ allowPositionals: true, options: {
  owner: { type: "string" }, remote: { type: "string" }, branch: { type: "string" }, "control-branch": { type: "string" },
  "expected-sha": { type: "string" }, "old-writer-drained": { type: "boolean" }, reason: { type: "string" },
  test: { type: "string", multiple: true }, epoch: { type: "string" }, "hold-minutes": { type: "string" },
  "no-lock": { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean" },
  session: { type: "string" }, source: { type: "string" }, title: { type: "string" }, ticket: { type: "string" },
} });
const [command = "status"] = parsed.positionals;
const output = (value: unknown) => { if (!parsed.values.quiet) console.log(JSON.stringify(value, null, 2)); };
async function main(): Promise<void> {
  if (parsed.positionals.length > 1) throw new Error("development commands operate on the current worktree; unexpected positional argument");
  if (parsed.values.help || command === "help") {
    output({ commands: ["status", "register --owner <user> [--source codex|claude] [--session <native UUID>] [--title <title>] [--ticket <existing CLI report>]", "acquire --owner <user>", "renew", "release", "takeover --reason <reason>",
      "land [--test <path-or-project>]", "land --no-lock --expected-sha <sha> --reason <reason>",
      "activate --expected-sha <sha> --old-writer-drained"],
      behavior: "acquire holds a renewable integration lease (60 minutes per acquire unless --hold-minutes 1–480, and only while the acquiring agent or shell is alive) while the native agent rebases and repairs; land validates and publishes; release abandons integration without changing your worktree" }); return;
  }
  const repo = await gitOrThrow(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const gitDir = await gitOrThrow(repo, ["rev-parse", "--absolute-git-dir"]);
  const stateDir = path.join(gitDir, "octopus-development");
  const statePath = path.join(stateDir, "state.json");
  const lockPath = path.join(stateDir, "command.lock");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const readState = async (): Promise<DevelopmentState | null> => {
    try {
      const stat = await fs.lstat(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || (stat.mode & 0o077)) throw new Error("development state must be a bounded private file");
      const data = JSON.parse(await fs.readFile(statePath, "utf8")) as DevelopmentState;
      if (data.version !== 1 || !data.identity?.id || !data.identity.owner) throw new Error("invalid development state");
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const writeState = async (state: DevelopmentState) => {
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, statePath);
    const directory = await fs.open(stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  let state = await readState();
  const client = new GitLabMainline({ repoDir: repo, remote: parsed.values.remote ?? state?.coordination?.remote,
    branch: parsed.values.branch ?? state?.coordination?.branch, controlBranch: parsed.values["control-branch"] ?? state?.coordination?.controlBranch });
  if (command === "status") { output(await client.snapshot()); return; }
  if (command === "activate") {
    if (!parsed.values["old-writer-drained"] || !parsed.values["expected-sha"]) throw new Error("activation requires the exact compared SHA and --old-writer-drained");
    output(await client.activate(parsed.values["expected-sha"])); return;
  }
  if (!state) {
    const owner = parsed.values.owner ?? process.env.OCTOPUS_OWNER;
    if (!owner) throw new Error("first use requires --owner <Octopus username> or OCTOPUS_OWNER");
    state = { version: 1, identity: { id: `cli:${randomUUID()}`, owner,
      label: `CLI ${await gitOrThrow(repo, ["branch", "--show-current"])}` } };
    await writeState(state);
  }
  if (parsed.values.owner && parsed.values.owner !== state.identity.owner) throw new Error("worktree is registered to another owner");
  if (command === "register") {
    const ticketId = parsed.values.ticket === undefined ? undefined : Number(parsed.values.ticket);
    if (ticketId !== undefined && (!Number.isSafeInteger(ticketId) || ticketId < 1)) throw new Error("--ticket must identify an existing CLI report");
    // Each CLI exports its own session id to the commands it runs. A nested CLI
    // inherits its parent's id too, so two ids require an explicit --source.
    const exported = { claude: process.env.CLAUDE_CODE_SESSION_ID, codex: process.env.CODEX_THREAD_ID };
    const source = parsed.values.source ?? (exported.claude && exported.codex ? undefined : exported.claude ? "claude" : exported.codex ? "codex" : undefined);
    if (source !== "codex" && source !== "claude") throw new Error("register requires --source codex|claude unless exactly one native session id is exported");
    const sessionId = parsed.values.session ?? exported[source];
    if (!sessionId) throw new Error("register requires the current native session UUID (--session, CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID)");
    if (state.native && state.native.session_id !== sessionId) throw new Error("worktree is already registered to another native session");
    const bridge = new LocalBridgeClient(process.env.RUNNER_LOCAL_MCP_SOCKET?.trim() || defaultLocalAgentBridgeSocket(os.homedir()));
    try {
      const result = await bridge.request("development_register", { source, session_id: sessionId, worktree: repo,
        ...(ticketId !== undefined ? { ticket_id: ticketId } : {}),
        title: parsed.values.title ?? state.identity.label }) as { ticket_id: number; owner: string };
      if (!Number.isSafeInteger(result.ticket_id) || result.owner !== state.identity.owner) throw new Error("Runner owner does not match the local development owner");
      if (ticketId !== undefined && result.ticket_id !== ticketId) throw new Error("Runner did not bind the requested report; upgrade it and inspect the returned registration before retrying");
      state.native = { ...result, session_id: sessionId }; await writeState(state);
      output({ ...result, execution_owner: "native_cli", report_field: { native_ticket_id: result.ticket_id } }); return;
    } finally { bridge.close(); }
  }
  const coordination = { remote: client.remote, branch: client.branch, controlBranch: client.controlBranch };
  if (state.coordination && JSON.stringify(state.coordination) !== JSON.stringify(coordination)) throw new Error("coordination target changed; use the original remote and branches for this worktree");
  state.coordination = coordination;
  if (parsed.values.epoch && parsed.values.epoch !== state.lease?.epoch) { process.exitCode = 3; return; }
  if (command === "heartbeat") {
    const epoch = parsed.values.epoch;
    if (!epoch) throw new Error("heartbeat requires its original lease epoch");
    for (;;) {
      await delay(30_000);
      // A dead acquirer or an exhausted hold must not keep the shared lock:
      // stop renewing and let the remote lease expire.
      if (!(await keepRenewing(await readState(), epoch))) return;
      const status = await new Promise<number>((resolve, reject) => {
        const child = spawn("flock", ["-n", lockPath, process.execPath, "--import", "tsx", entry, "renew", "--quiet", "--epoch", epoch,
          ...(parsed.values.remote ? ["--remote", parsed.values.remote] : []),
          ...(parsed.values.branch ? ["--branch", parsed.values.branch] : []),
          ...(parsed.values["control-branch"] ? ["--control-branch", parsed.values["control-branch"]] : [])], { cwd: repo, stdio: "ignore" });
        child.once("error", reject); child.once("exit", code => resolve(code ?? 2));
      });
      if (status !== 0 && status !== 1) return; // 1 = another command currently owns flock
    }
  }
  const startHeartbeat = async () => {
    const epoch = state!.lease!.epoch;
    if (state!.heartbeat?.epoch === epoch) {
      const args = await fs.readFile(`/proc/${state!.heartbeat.pid}/cmdline`, "utf8").catch(() => "");
      if (args.split("\0").includes(entry) && args.split("\0").includes("heartbeat")) return;
    }
    const fd = openSync(path.join(stateDir, "heartbeat.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, ["--import", "tsx", entry, "heartbeat", "--epoch", epoch,
        ...(parsed.values.remote ? ["--remote", parsed.values.remote] : []),
        ...(parsed.values.branch ? ["--branch", parsed.values.branch] : []),
        ...(parsed.values["control-branch"] ? ["--control-branch", parsed.values["control-branch"]] : [])],
      { cwd: repo, detached: true, stdio: ["ignore", fd, fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      state!.heartbeat = { pid: child.pid!, epoch }; child.unref(); await writeState(state!);
    } finally { closeSync(fd); }
  };
  if (command === "release") {
    if (state.lease) await client.release(state.lease); else await client.cancel(state.identity);
    delete state.lease; delete state.heartbeat; delete state.deadline; delete state.owner; await writeState(state); output({ released: true }); return;
  }
  if (command === "renew") {
    if (!state.lease || !state.deadline || Date.now() >= state.deadline) { process.exitCode = 3; return; }
    state.lease = await client.renew(state.lease); await writeState(state); output({ lease: state.lease, deadline: state.deadline }); return;
  }
  if (!["acquire", "takeover", "land"].includes(command)) throw new Error(`unknown command: ${command}`);
  const emergency = command === "land" && parsed.values["no-lock"] === true;
  if (emergency && (!parsed.values.reason || !/^[0-9a-f]{40}$/.test(parsed.values["expected-sha"] ?? ""))) {
    throw new Error("emergency landing requires --reason and --expected-sha; it still runs the admission checks");
  }
  // Only an explicit acquire or takeover starts a new hold; land and the
  // heartbeat never extend it.
  const deadline = holdDeadline(parsed.values["hold-minutes"]);
  if (!emergency) {
    if (command === "land" && state.lease && state.deadline && Date.now() >= state.deadline) {
      throw new Error("integration hold reached its deadline; run acquire to start a new hold, rebase onto its base if it moved, then land");
    }
    const explicit = command !== "land" || !state.lease;
    if (command === "takeover") state.lease = await client.takeover(state.identity, parsed.values.reason ?? "");
    else if (state.lease) {
      try { state.lease = await client.renew(state.lease); }
      catch (error) {
        // An expired hold is reacquired by `acquire`; `land` must not silently
        // replace the lease its validation was prepared under.
        if (command === "land" || !(error instanceof MainlineError) || error.code !== "lost_lease") throw error;
        delete state.lease;
      }
    }
    if (!state.lease) {
      const claim = await client.acquire(state.identity);
      if (!claim.acquired) { delete state.deadline; delete state.owner; await writeState(state); output(claim); process.exitCode = 4; return; }
      state.lease = claim.lease;
    }
    if (explicit || !state.deadline) {
      state.deadline = deadline;
      const owner = await leaseOwner().catch(() => null);
      if (owner) state.owner = owner; else delete state.owner;
    }
    await writeState(state); await startHeartbeat();
    if (command !== "land") { output({ acquired: true, lease: state.lease, deadline: state.deadline, owner: state.owner?.command ?? null }); return; }
  }
  const keeper = emergency ? null : new IntegrationLeaseKeeper(client, state.lease!, state.deadline);
  try {
    const branch = await gitOrThrow(repo, ["branch", "--show-current"]);
    if (!branch || branch === client.branch || branch === `${client.branch}-stable`) throw new Error("land from a dedicated feature branch");
    if (await gitOrThrow(repo, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("commit all work before landing");
    const base = emergency ? parsed.values["expected-sha"]! : state.lease!.base;
    const head = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    await gitOrThrow(repo, ["merge-base", "--is-ancestor", base, head]).catch(() => {
      throw new Error(`integration lease retained; rebase this worktree onto ${base}, repair, validate and run land again`);
    });
    const delivery = await localDelivery(repo, base, head);
    if (delivery.report.requester !== state.identity.owner) throw new Error("delivery requester must match the registered owner");
    if (delivery.report.native_ticket_id !== state.native?.ticket_id) throw new Error("delivery native_ticket_id must match this worktree's registration (omit it for an unregistered CLI)");
    const common = await gitOrThrow(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const parent = await gitOrThrow(repo, ["config", "--get", "octopus.worktreesDir"]).catch(() => path.resolve(common, "..", "..", "octopus-worktrees"));
    const gateDir = path.join(parent, `_cli-gate-${state.identity.id.slice(4)}`);
    const gate = new LandGate({ repoDir: repo, worktreesDir: gateDir });
    const verdict = await gate.withLandWorktree(head, dir => gate.check(dir, {
      changedFiles: delivery.changed, requiredTests: delivery.requiredTests, namedTests: parsed.values.test ?? [],
    }));
    if (!verdict.ok) throw new Error(`landing refused: ${verdict.refusal}\n${verdict.log}`);
    if (await gitOrThrow(repo, ["rev-parse", "HEAD"]) !== head
      || await gitOrThrow(repo, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("worktree changed during validation; review before publishing");
    if (emergency) await client.emergencyPublish(state.identity, base, head, parsed.values.reason!);
    else await keeper!.publish(head);
    state.lastLanding = { base, sha: head, at: new Date().toISOString() };
    delete state.lease; delete state.heartbeat; delete state.deadline; delete state.owner; await writeState(state);
    output({ landed: true, ...state.lastLanding, report: delivery.path, deployed: false });
    // This gate directory belongs to this worktree alone and is kept warm only
    // to repair a refused landing; after success its installed dependencies
    // (~350 MB) would never be used again.
    await gate.discard().then(() => fs.rmdir(gateDir)).catch(() => undefined);
  } finally {
    // A failed gate leaves the bounded lease available for repair. The native
    // CLI and heartbeat remain the same; this command does not resume an agent.
    keeper?.detach();
  }
}
main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error instanceof MainlineError ? error.code : "refused", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
});
