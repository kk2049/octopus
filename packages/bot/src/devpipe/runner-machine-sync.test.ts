/**
 * `syncTicketWorkspaceViaRunner` against a real local "device": the exec
 * callback runs the commands in bash on this host, the bundle is served by a
 * tiny HTTP server fronting a real `BundleHandoff`, and the pnpm steps are
 * intercepted (they are the CI recipe, not the subject here).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BundleHandoff, looksLikeBundleToken } from "./bundle-handoff.js";
import { syncTicketWorkspaceViaRunner, syncWorkspaceViaRunner, ticketWorkspacePath, type MachineExec } from "./runner-machine-sync.js";
import { gitOrThrow } from "./worktree.js";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function serveBundles(bundles: BundleHandoff): Promise<string> {
  const server: Server = createServer(async (req, res) => {
    const m = /^\/api\/contrib\/bundle\/([^/?]+)$/.exec(req.url ?? "");
    const token = m?.[1] ?? "";
    const take = looksLikeBundleToken(token) ? bundles.take(token) : null;
    if (!take) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/x-git-bundle" }).end(readFileSync(take.path));
    await take.done();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

function localExec(log: string[]): MachineExec {
  return async ({ command, timeout_ms }) => {
    log.push(command);
    // The CI recipe (install + build) is not what this test is about.
    if (/pnpm (install|--filter)/.test(command)) return { ok: true, stdout: "skipped", stderr: "", exit_code: 0 };
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], { timeout: timeout_ms ?? 60_000, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, stdout: String(stdout), stderr: String(stderr), exit_code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), exit_code: typeof e.code === "number" ? e.code : null };
    }
  };
}

describe("syncTicketWorkspaceViaRunner", () => {
  it("seeds an empty object store from a full bundle, then ships only the delta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-sync-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // The bot-host side: a ticket worktree with history.
    const source = join(dir, "source");
    await gitOrThrow(dir, ["init", "-b", "main", source]);
    await gitOrThrow(source, ["config", "user.email", "t@t"]);
    await gitOrThrow(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "README.md"), "one\n");
    await gitOrThrow(source, ["add", "."]);
    await gitOrThrow(source, ["commit", "-m", "one"]);
    // The device side: what the container's entrypoint leaves behind.
    const work = join(dir, "work");
    const objectRepo = join(work, "octopus");
    await gitOrThrow(dir, ["init", "--quiet", objectRepo]);
    await execFileAsync("git", ["config", "--global", "--add", "safe.directory", "*"]).catch(() => {});

    const bundles = new BundleHandoff();
    const publicUrl = await serveBundles(bundles);
    const log: string[] = [];
    const first = await syncTicketWorkspaceViaRunner({
      sourceDir: source, ref: "HEAD", ticketId: 7, checkoutDir: objectRepo, publicUrl, exec: localExec(log), bundles,
    });
    expect(first.ok, first.detail).toBe(true);
    const sha1 = await gitOrThrow(source, ["rev-parse", "HEAD"]);
    expect(first.sha).toBe(sha1);
    expect(first.checkoutDir).toBe(join(work, "tickets", "ticket-7"));
    expect(readFileSync(join(work, "tickets", "ticket-7", "README.md"), "utf8")).toBe("one\n");
    expect(await gitOrThrow(join(work, "tickets", "ticket-7"), ["rev-parse", "HEAD"])).toBe(sha1);
    // The one-shot URL was consumed and nothing is left to redeem.
    expect(bundles.size).toBe(0);
    expect(log.some((c) => c.includes("curl"))).toBe(true);

    // Second commit → incremental bundle; the previous worktree moves.
    writeFileSync(join(source, "README.md"), "two\n");
    await gitOrThrow(source, ["commit", "-am", "two"]);
    const sha2 = await gitOrThrow(source, ["rev-parse", "HEAD"]);
    const log2: string[] = [];
    const second = await syncTicketWorkspaceViaRunner({
      sourceDir: source, ref: "HEAD", ticketId: 7, checkoutDir: objectRepo, publicUrl, exec: localExec(log2), bundles,
    });
    expect(second.ok, second.detail).toBe(true);
    expect(second.sha).toBe(sha2);
    expect(readFileSync(join(work, "tickets", "ticket-7", "README.md"), "utf8")).toBe("two\n");

    // Already present → no download at all.
    const log3: string[] = [];
    const third = await syncTicketWorkspaceViaRunner({
      sourceDir: source, ref: "HEAD", ticketId: 7, checkoutDir: objectRepo, publicUrl, exec: localExec(log3), bundles,
    });
    expect(third.ok).toBe(true);
    expect(log3.some((c) => c.includes("curl"))).toBe(false);
    expect(existsSync(join(work, "sync-ticket-7.bundle"))).toBe(true);
  }, 60_000);

  it("reports a failed download honestly and leaves no offer behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-sync-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, "source");
    await gitOrThrow(dir, ["init", "-b", "main", source]);
    await gitOrThrow(source, ["config", "user.email", "t@t"]);
    await gitOrThrow(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "README.md"), "one\n");
    await gitOrThrow(source, ["add", "."]);
    await gitOrThrow(source, ["commit", "-m", "one"]);
    const objectRepo = join(dir, "work", "octopus");
    await gitOrThrow(dir, ["init", "--quiet", objectRepo]);
    const bundles = new BundleHandoff();
    const log: string[] = [];
    const out = await syncTicketWorkspaceViaRunner({
      // A dashboard nobody answers on.
      sourceDir: source, ref: "HEAD", ticketId: 8, checkoutDir: objectRepo, publicUrl: "http://127.0.0.1:9", exec: localExec(log), bundles,
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("拉取 bundle 失败");
    expect(bundles.size).toBe(0);
  }, 60_000);
});

describe("syncWorkspaceViaRunner (keyed workspaces)", () => {
  it("prepares a pipeline-owned `land` workspace as a bare checkout: no install, no build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-sync-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, "source");
    await gitOrThrow(dir, ["init", "-b", "main", source]);
    await gitOrThrow(source, ["config", "user.email", "t@t"]);
    await gitOrThrow(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "README.md"), "one\n");
    await gitOrThrow(source, ["add", "."]);
    await gitOrThrow(source, ["commit", "-m", "one"]);
    const work = join(dir, "work");
    const objectRepo = join(work, "octopus");
    await gitOrThrow(dir, ["init", "--quiet", objectRepo]);
    await execFileAsync("git", ["config", "--global", "--add", "safe.directory", "*"]).catch(() => {});

    const bundles = new BundleHandoff();
    const publicUrl = await serveBundles(bundles);
    const log: string[] = [];
    const out = await syncWorkspaceViaRunner({
      sourceDir: source, ref: "HEAD", key: "land", workspace: join(work, "land"), checkoutDir: objectRepo, publicUrl,
      exec: localExec(log), bundles, install: false, buildFilters: [], cleanIgnored: true,
    });
    expect(out.ok, out.detail).toBe(true);
    expect(out.checkoutDir).toBe(join(work, "land"));
    expect(readFileSync(join(work, "land", "README.md"), "utf8")).toBe("one\n");
    expect(log.some((c) => /pnpm/.test(c))).toBe(false);
    expect(log.some((c) => c.includes(`git -C '${join(work, "land")}' clean -fdqx`))).toBe(true);
    // Its own transfer ref and bundle, so a ticket sync never clobbers it.
    expect(existsSync(join(work, "sync-land.bundle"))).toBe(true);
    expect(log.some((c) => c.includes("refs/remotes/ticket-sync/land"))).toBe(true);
  }, 60_000);

  it.each(["raw-sha", "moving-head"])("pins a %s input through an incremental bundle", async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "runner-sync-pinned-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = join(dir, "source");
    await gitOrThrow(dir, ["init", "-b", "main", source]);
    await gitOrThrow(source, ["config", "user.email", "t@t"]);
    await gitOrThrow(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "README.md"), "one\n");
    await gitOrThrow(source, ["add", "."]);
    await gitOrThrow(source, ["commit", "-m", "one"]);
    const objectRepo = join(dir, "work", "octopus");
    await gitOrThrow(dir, ["init", "--quiet", objectRepo]);
    const bundles = new BundleHandoff();
    const publicUrl = await serveBundles(bundles);
    const workspace = join(dir, "work", "knowledge");
    const input = { sourceDir: source, key: "knowledge", workspace, checkoutDir: objectRepo,
      publicUrl, bundles, install: false };
    const first = await syncWorkspaceViaRunner({ ...input, ref: "HEAD", exec: localExec([]) });
    expect(first.ok, first.detail).toBe(true);
    writeFileSync(join(source, "README.md"), "two\n");
    await gitOrThrow(source, ["commit", "-am", "two"]);
    const wanted = await gitOrThrow(source, ["rev-parse", "HEAD"]);
    const commands: string[] = [];
    const execute = localExec(commands);
    let advanced = false;
    const result = await syncWorkspaceViaRunner({ ...input, ref: mode === "raw-sha" ? wanted : "HEAD",
      exec: async (args) => {
        if (mode === "moving-head" && !advanced) {
          advanced = true;
          writeFileSync(join(source, "README.md"), "three\n");
          await gitOrThrow(source, ["commit", "-am", "three"]);
        }
        return await execute(args);
      },
    });
    expect(result.ok, result.detail).toBe(true);
    expect(result.sha).toBe(wanted);
    expect(await gitOrThrow(workspace, ["rev-parse", "HEAD"])).toBe(wanted);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("two\n");
    expect(commands.some((command) => command.includes("curl"))).toBe(true);
    expect(await gitOrThrow(source, ["for-each-ref", "--format=%(refname)", "refs/octopus/workspace-sync/"])).toBe("");
    expect(bundles.size).toBe(0);
  }, 60_000);

  it("refuses a key that could escape the workspace root", async () => {
    const out = await syncWorkspaceViaRunner({
      sourceDir: "/nonexistent", ref: "HEAD", key: "../etc", workspace: "/work/x", checkoutDir: "/work/octopus", publicUrl: "http://127.0.0.1:1",
      exec: async () => ({ ok: true, stdout: "", stderr: "" }), bundles: new BundleHandoff(),
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("非法");
  });

  it("derives the ticket workspace beside the object store", () => {
    expect(ticketWorkspacePath("/work/octopus", 285)).toBe("/work/tickets/ticket-285");
  });
});
