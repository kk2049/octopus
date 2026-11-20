import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addWorkspace, removeWorkspace } from "./workspaces.js";
import { WorkspaceJobManager, processAlive, type WorkspaceJobStatus } from "./workspace-jobs.js";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (process.env.OCTOPUS_KEEP_WORKSPACE_JOB_FIXTURES === "1") {
      console.error("workspace job fixture retained:", root);
    } else await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const home = await fs.mkdtemp(path.join(tmpdir(), "workspace-job-")); roots.push(home);
  const root = path.join(home, "registered"); await fs.mkdir(root);
  const ws = await addWorkspace(home, root, "CI");
  const cwd = path.join(root, ".octopus-ci", "workspaces", "ticket-1"); await fs.mkdir(cwd, { recursive: true });
  await exec("git", ["init", "-q", cwd]); await exec("git", ["-C", cwd, "config", "user.name", "Test"]);
  await exec("git", ["-C", cwd, "config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(cwd, "source"), "exact input"); await exec("git", ["-C", cwd, "add", "source"]);
  await exec("git", ["-C", cwd, "commit", "-qm", "source"]);
  const sha = (await exec("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
  await exec("git", ["-C", cwd, "checkout", "--quiet", "--detach", sha]);
  const manager = new WorkspaceJobManager(home);
  const request = { job_id: "one", workspace_id: ws.id, workspace_key: "ticket-1", repo_sha: sha, command: "echo original", timeout_ms: 5000 };
  return { home, root, cwd, ws, sha, manager, request };
}
async function terminal(manager: WorkspaceJobManager, request: Record<string, unknown>): Promise<WorkspaceJobStatus> {
  for (let i = 0; i < 100; i++) { const state = await manager.status("ali", request);
    if (!["accepted", "running"].includes(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("job did not settle");
}

/**
 * Start a job once the previous one has released its checkout's slot.
 * A worker writes its result before it drops the slot lock, so on a slow host
 * an immediate next start can still see `workspace_busy` (no record, so its
 * status would read as `missing`).
 */
async function startWhenFree(manager: WorkspaceJobManager, request: Record<string, unknown>): Promise<WorkspaceJobStatus> {
  for (let i = 0; i < 100; i++) {
    const started = await manager.start("ali", request);
    if (started.state !== "not_started" || started.error !== "workspace_busy") return started;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("workspace slot stayed busy");
}

async function succeeded(manager: WorkspaceJobManager, request: Record<string, unknown>): Promise<WorkspaceJobStatus> {
  const result = await terminal(manager, request);
  let diagnostic: string | undefined;
  if (result.state !== "succeeded") {
    const tail = await manager.readLog("ali", {
      ...request, offset: Math.max(0, (result.log_bytes ?? 0) - 8192), length: 8192,
    }).then((log) => Buffer.from(String(log.data), "base64").toString("utf8"))
      .catch((error: unknown) => "cannot read job log: " + String(error));
    // Only the public receipt and bounded output are reported, never input URLs.
    diagnostic = JSON.stringify({ result, logTail: tail }, null, 2);
  }
  expect(result.state, diagnostic).toBe("succeeded");
  return result;
}

describe("workspace jobs: registered source and durable execution", () => {
  it("runs a long script once and preserves command identity through recovery", async () => {
    const f = await fixture();
    const text = "章鱼".repeat(6_000);
    const request = { ...f.request, command: `# ${text}\nprintf once >> count\nprintf done` };
    await f.manager.start("ali", request);
    await succeeded(f.manager, request);
    const restored = new WorkspaceJobManager(f.home);
    expect((await restored.start("ali", request)).state).toBe("succeeded");
    expect(await fs.readFile(path.join(f.cwd, "count"), "utf8")).toBe("once");
    await expect(restored.start("ali", { ...request, command: `${request.command}\nprintf changed` }))
      .rejects.toThrow("different inputs");
  });

  it("seeds a new managed workspace from registered local Git objects without transferring a full bundle", async () => {
    const f = await fixture();
    await exec("git", ["clone", "--quiet", "--bare", f.cwd, path.join(f.root, ".git")]);
    const request = { ...f.request, workspace_key: "seeded", command: "cat source" };
    await f.manager.start("ali", request);
    expect(await succeeded(f.manager, request)).toMatchObject({ state: "succeeded", repo_sha: f.sha });
    expect(await fs.readFile(path.join(f.root, ".octopus-ci/workspaces/seeded/source"), "utf8")).toBe("exact input");
  });
  it("streams completed artifacts by original job and refuses other jobs, paths and links", async () => {
    const f = await fixture();
    const request = { ...f.request, command: 'mkdir -p "$OCTOPUS_JOB_ARTIFACT_DIR"; printf abcdef > "$OCTOPUS_JOB_ARTIFACT_DIR/release.json"; ln -s /etc/passwd "$OCTOPUS_JOB_ARTIFACT_DIR/link"' };
    await expect(f.manager.readArtifact("ali", { ...request, name: "release.json" })).rejects.toThrow("successful original job");
    await f.manager.start("ali", request);
    expect((await terminal(f.manager, request)).state).toBe("succeeded");
    const restored = new WorkspaceJobManager(f.home);
    const part = await restored.readArtifact("ali", { ...request, name: "release.json", offset: 2, length: 3 });
    expect(part).toMatchObject({ bytes: 3, total: 6, eof: false, repo_sha: f.sha });
    expect(Buffer.from(String(part.data), "base64").toString()).toBe("cde");
    await expect(restored.readArtifact("other", { ...request, name: "release.json" })).rejects.toThrow();
    await expect(restored.readArtifact("ali", { ...request, name: "../request.json" })).rejects.toThrow();
    await expect(restored.readArtifact("ali", { ...request, name: "link" })).rejects.toThrow();
    await expect(restored.readArtifact("ali", { ...request, name: "release.json", length: 1048577 })).rejects.toThrow();
    await removeWorkspace(f.home, f.ws.id);
    await expect(restored.readArtifact("ali", { ...request, name: "release.json" })).rejects.toThrow();
  });
  it("joins the same job across manager reconstruction and returns one result/log", async () => {
    const f = await fixture(); const marker = path.join(f.home, "count");
    const request = { ...f.request, command: `echo once >> '${marker}'; sleep 0.3; echo result` };
    await f.manager.start("ali", request);
    const restored = new WorkspaceJobManager(f.home);
    expect((await restored.start("ali", request)).state).not.toBe("missing");
    expect(await terminal(restored, request)).toMatchObject({ state: "succeeded", exit_code: 0, repo_sha: f.sha });
    expect((await restored.start("ali", request)).state).toBe("succeeded");
    expect(await fs.readFile(marker, "utf8")).toBe("once\n");
    const log = await restored.readLog("ali", { ...request, offset: 0, length: 64 });
    expect(Buffer.from(String(log.data), "base64").toString()).toContain("result");
    await expect(restored.start("ali", { ...request, command: "echo changed" })).rejects.toThrow("different inputs");
    expect((await restored.status("other-site", request)).state).toBe("missing");
  });
  it("keeps a running workspace exclusive and cancellation terminates the command", async () => {
    const f = await fixture(); const marker = path.join(f.home, "must-not-exist");
    const request = { ...f.request, command: `echo started; sleep 30; touch '${marker}'` };
    await f.manager.start("ali", request);
    expect(await f.manager.start("ali", { ...request, job_id: "competing" })).toMatchObject({ state: "not_started", error: "workspace_busy" });
    await f.manager.cancel("ali", request);
    expect(await terminal(f.manager, request)).toMatchObject({ state: "cancelled" });
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    const next = { ...f.request, job_id: "after-cancel" };
    // The cancelled worker records its verdict before it drops the slot (CI 50140).
    await startWhenFree(f.manager, next); expect((await terminal(f.manager, next)).state).toBe("succeeded");
  });
  it("runs jobs in different checkouts concurrently while each checkout stays exclusive", async () => {
    const f = await fixture();
    await exec("git", ["clone", "--quiet", "--bare", f.cwd, path.join(f.root, ".git")]);
    const gate = path.join(f.home, "release");
    const long = { ...f.request, command: `while [ ! -e '${gate}' ]; do sleep 0.05; done` };
    await f.manager.start("ali", long);
    const other = { ...f.request, job_id: "other-ticket", workspace_key: "ticket-2", command: "printf parallel" };
    await f.manager.start("ali", other);
    expect(await succeeded(f.manager, other)).toMatchObject({ workspace_key: "ticket-2" });
    expect(await f.manager.start("ali", { ...f.request, job_id: "same-ticket" })).toMatchObject({ state: "not_started", error: "workspace_busy" });
    await fs.writeFile(gate, "");
    await succeeded(f.manager, long);
  });
  it("honours a worker that still holds the legacy Runner-wide slot", async () => {
    const f = await fixture();
    const legacy = path.join(f.home, ".octopus", "workspace-jobs-active");
    await fs.mkdir(legacy, { recursive: true }); await fs.writeFile(path.join(legacy, "job-id"), JSON.stringify({ job_id: "old" }));
    expect(await f.manager.start("ali", { ...f.request, workspace_key: "ticket-2" })).toMatchObject({ state: "not_started", error: "workspace_busy" });
    await fs.rm(legacy, { recursive: true });
    await f.manager.start("ali", f.request); await succeeded(f.manager, f.request);
  });
  it("a deadline is a task verdict, not an offline result", async () => {
    const f = await fixture(); const request = { ...f.request, command: "sleep 30", timeout_ms: 1000 };
    await f.manager.start("ali", request); expect((await terminal(f.manager, request)).state).toBe("timed_out");
  });
  it("refuses uncommitted source and wrong SHA before running a command", async () => {
    const f = await fixture(); const marker = path.join(f.home, "bad");
    await fs.writeFile(path.join(f.cwd, "source"), "dirty");
    await f.manager.start("ali", { ...f.request, command: `touch '${marker}'` });
    expect((await terminal(f.manager, f.request)).state).toBe("failed");
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    await fs.writeFile(path.join(f.cwd, "source"), "exact input");
    const wrong = { ...f.request, job_id: "wrong-sha", repo_sha: "a".repeat(40), command: `touch '${marker}'` };
    await startWhenFree(f.manager, wrong); expect((await terminal(f.manager, wrong)).state).toBe("failed");
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  });
  it("revoked workspace registration denies task reads and launch", async () => {
    const f = await fixture(); await removeWorkspace(f.home, f.ws.id);
    await expect(f.manager.start("ali", f.request)).rejects.toThrow();
    await expect(f.manager.status("ali", f.request)).rejects.toThrow();
  });
  it("rejects traversal and untrusted bundle inputs", async () => {
    const f = await fixture();
    await expect(f.manager.start("ali", { ...f.request, workspace_key: "../escape" })).rejects.toThrow("identity");
    await expect(f.manager.start("ali", { ...f.request, input: { url: "https://attacker.invalid/token", sha256: "a".repeat(64), bytes: 1 } })).rejects.toThrow("origin");
  });
});

it("accepts ESRCH when a real proc stat descriptor is read after its child exits", async () => {
  const f = await fixture();
  const bin = path.join(f.home, "bin");
  await fs.mkdir(bin);
  const timeout = (await exec("sh", ["-c", "command -v timeout"])).stdout.trim();
  const quotedTimeout = "'" + timeout.replaceAll("'", "'\\''") + "'";
  // Keep each child alive long enough to open its proc descriptor. Its actual
  // Git/command execution and the production deadline remain unchanged.
  await fs.writeFile(path.join(bin, "timeout"), "#!/bin/sh\nsleep 0.03\nexec " + quotedTimeout + ' "$@"\n', { mode: 0o700 });
  const evidence = path.join(f.home, "proc-read.json");
  const preload = path.join(f.home, "proc-read-window.mjs");
  await fs.writeFile(preload, [
    "import fs from 'node:fs/promises';",
    "const read = fs.readFile.bind(fs);",
    "fs.readFile = async (file, options) => {",
    "  const match = /^\\/proc\\/(\\d+)\\/stat$/.exec(String(file));",
    "  if (!match || Number(match[1]) === process.pid) return read(file, options);",
    "  const handle = await fs.open(file, 'r');",
    "  try {",
    "    for (let count = 0; count < 200; count++) {",
    "      try { process.kill(Number(match[1]), 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }",
    "      await new Promise(resolve => setTimeout(resolve, 5));",
    "    }",
    "    try { return await handle.readFile(options); } catch (error) {",
    "      await fs.writeFile(" + JSON.stringify(evidence) + ", JSON.stringify({ code: error.code, syscall: error.syscall }));",
    "      throw error;",
    "    }",
    "  } finally { await handle.close(); }",
    "};",
  ].join("\n"));
  const priorOptions = process.env.NODE_OPTIONS, priorPath = process.env.PATH;
  process.env.NODE_OPTIONS = (priorOptions ?? "") + " --import=" + JSON.stringify(preload);
  process.env.PATH = bin + path.delimiter + (priorPath ?? "");
  try { await f.manager.start("ali", f.request); }
  finally {
    if (priorOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorOptions;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  }
  const result = await terminal(f.manager, f.request);
  expect(JSON.parse(await fs.readFile(evidence, "utf8"))).toEqual({ code: "ESRCH", syscall: "read" });
  expect(await succeeded(f.manager, f.request)).toEqual(result);
});

it("lost worker state is unknown and cannot restart the same command", async () => {
  const f = await fixture(); const marker = path.join(f.home, "once");
  const request = { ...f.request, timeout_ms: 1000, command: `echo once >> '${marker}'; sleep 10; echo replay >> '${marker}'` };
  await f.manager.start("ali", request);
  const scopes = await fs.readdir(path.join(f.home, ".octopus", "workspace-jobs"));
  const dir = path.join(f.home, ".octopus", "workspace-jobs", scopes[0], request.job_id);
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    const row = await fs.readFile(path.join(dir, "pid.json"), "utf8").then(JSON.parse).catch(() => null);
    if (row && await fs.stat(marker).catch(() => null)) { pid = row.pid; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pid).toBeGreaterThan(0); process.kill(pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const restored = new WorkspaceJobManager(f.home);
  expect((await restored.status("ali", request)).state).toBe("unknown");
  expect((await restored.start("ali", request)).state).toBe("unknown");
  expect(await fs.readFile(marker, "utf8")).toBe("once\n");
  const child = JSON.parse(await fs.readFile(path.join(dir, "child.json"), "utf8"));
  expect(await processAlive(child.pid, child.start_ticks)).toBe(false);
  expect(await restored.start("ali", { ...request, job_id: "new-attempt" })).toMatchObject({ state: "not_started", error: "workspace_busy" });
  // The unknown job pins only its own checkout.
  expect((await restored.start("ali", { ...request, job_id: "elsewhere", workspace_key: "ticket-2", command: "true" })).state).not.toBe("not_started");
});

it("the real RPC dispatcher permits opted-in execution-only jobs and denies other surfaces", async () => {
  const { handleRpc } = await import("./core.js");
  const f = await fixture();
  const options = { executionOnly: true, allowMachineOps: true, workspaceJobs: f.manager, gatewaySite: "ali" };
  const started = await handleRpc(f.home, { id: "start", method: "workspace_job_start", args: f.request }, options);
  expect(started.ok).toBe(true);
  await succeeded(f.manager, f.request);
  const reply = await handleRpc(f.home, { id: "query", method: "workspace_job_status", args: f.request }, options);
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { state: "succeeded" } });
  expect((await handleRpc(f.home, { id: "disabled", method: "workspace_job_status", args: f.request }, { ...options, allowMachineOps: false })).ok).toBe(false);
  expect((await handleRpc(f.home, { id: "session", method: "start_session", args: {} }, options)).ok).toBe(false);
});

it("prepares an exact commit from a verified HTTPS bundle and rejects changed bytes", async () => {
  const { createServer } = await import("node:https");
  const { createHash } = await import("node:crypto");
  const f = await fixture(); const key = path.join(f.home, "key.pem"), cert = path.join(f.home, "cert.pem");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  const bundle = path.join(f.home, "input.bundle"); await exec("git", ["-C", f.cwd, "bundle", "create", bundle, "HEAD"]);
  const bytes = await fs.readFile(bundle);
  const side = Buffer.from('{"minimal":"runtime"}');
  const server = createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => { res.end(req.url?.startsWith("/side") ? side : bytes); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }; const origin = `https://127.0.0.1:${address.port}`;
  const previous = process.env.NODE_EXTRA_CA_CERTS; process.env.NODE_EXTRA_CA_CERTS = cert;
  try {
    const manager = new WorkspaceJobManager(f.home, { inputOrigins: [origin] });
    const request = { ...f.request, workspace_key: "prepared", command: "cat source",
      input: { url: `${origin}/one-use-input`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
    await manager.start("ali", request);
    expect(await succeeded(manager, request)).toMatchObject({ state: "succeeded", repo_sha: f.sha });
    expect(await fs.readFile(path.join(f.root, ".octopus-ci", "workspaces", "prepared", "source"), "utf8")).toBe("exact input");
    const withSide = { ...request, job_id: "side-input", command: 'cat "$OCTOPUS_JOB_INPUT_DIR/runtime.json"',
      files: [{ name: "runtime.json", url: `${origin}/side-private-token`, bytes: side.length, sha256: createHash("sha256").update(side).digest("hex") }] };
    await startWhenFree(manager, withSide);
    expect(await succeeded(manager, withSide)).toMatchObject({ state: "succeeded" });
    const scopes = await fs.readdir(path.join(f.home, ".octopus/workspace-jobs"));
    const receipt = await fs.readFile(path.join(f.home, ".octopus/workspace-jobs", scopes[0], "side-input/request.json"), "utf8");
    expect(receipt).not.toContain("private-token");
    expect((await manager.start("ali", { ...withSide, files: [{ ...withSide.files[0], url: `${origin}/side-reissued` }] })).state).toBe("succeeded");
    await expect(manager.start("ali", { ...withSide, files: [{ ...withSide.files[0], sha256: "a".repeat(64) }] })).rejects.toThrow("different inputs");
    const badSide = { ...withSide, job_id: "bad-side", files: [{ ...withSide.files[0], sha256: "a".repeat(64) }] };
    await startWhenFree(manager, badSide);
    expect(await terminal(manager, badSide)).toMatchObject({ state: "failed", error: "input_digest_mismatch" });
    const bad = { ...request, job_id: "bad-digest", input: { ...request.input, sha256: "0".repeat(64) } };
    await startWhenFree(manager, bad); expect(await terminal(manager, bad)).toMatchObject({ state: "failed", error: "input_digest_mismatch" });
    expect(await fs.readFile(path.join(f.root, ".octopus-ci", "workspaces", "prepared", "source"), "utf8")).toBe("exact input");
  } finally {
    if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("validates symlinks before claiming and keeps registered workspaces independent", async () => {
  const f = await fixture();
  const link = path.join(f.root, ".octopus-ci", "workspaces", "symlink");
  await fs.symlink(f.cwd, link);
  await expect(f.manager.start("ali", { ...f.request, workspace_key: "symlink" })).rejects.toThrow("symlink");
  const request = { ...f.request, command: "sleep 10" };
  expect((await f.manager.start("ali", request)).state).not.toBe("not_started");
  const otherRoot = path.join(f.home, "other-root"); await fs.mkdir(otherRoot);
  const other = await addWorkspace(f.home, otherRoot);
  expect((await f.manager.start("ali", { ...f.request, job_id: "other", workspace_id: other.id })).state).not.toBe("not_started");
  await f.manager.cancel("ali", request); expect((await terminal(f.manager, request)).state).toBe("cancelled");
});
