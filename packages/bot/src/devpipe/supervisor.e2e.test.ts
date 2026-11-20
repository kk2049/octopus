/**
 * Sandbox e2e of the ring-0 supervisor (scripts/supervisord.sh): a real git
 * repo, a real SQLite db (shared with the Store), and a FAKE bot whose
 * behavior is version-controlled — deploying a broken commit is how we
 * exercise the health gate and retained-release rollback. SUP_ONESHOT makes each
 * run process exactly one intent and exit, so scenarios stay deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { createHash } from "node:crypto";
import { gitOrThrow } from "./worktree.js";

const SCRIPT = join(process.cwd(), "scripts", "supervisord.sh");
const DEV_RESTART = join(process.cwd(), "scripts", "dev-restart.sh");

it("keeps the Node 22 JS-to-Wasm deopt mitigation on both supported start paths", () => {
  expect(readFileSync(SCRIPT, "utf8")).toContain(
    "/usr/bin/node --max-old-space-size=$SUP_NODE_HEAP_MB --no-turbo-inline-js-wasm-calls --import tsx packages/bot/src/bootstrap-v3.ts",
  );
  expect(readFileSync(DEV_RESTART, "utf8")).toContain(
    '"$NODE_BIN" --max-old-space-size="${SUP_NODE_HEAP_MB:-768}" --no-turbo-inline-js-wasm-calls --import tsx "$ENTRY"',
  );
});

/**
 * The production supervisor intentionally depends on the sqlite3 CLI. Validation
 * workers do not all install that OS package, so give the sandbox the smallest
 * equivalent adapter backed by the bot's existing better-sqlite3 dependency.
 * Production still exercises the real CLI; this only removes a host-image
 * dependency from the test harness.
 */
function sqlitePathForSandbox(root: string): string {
  const inherited = process.env.PATH ?? "";
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status === 0) return inherited;

  const bin = join(root, "test-bin");
  const shim = join(bin, "sqlite3");
  mkdirSync(bin);
  const requireFrom = join(process.cwd(), "packages", "bot", "package.json");
  writeFileSync(shim, `#!${process.execPath}
const { createRequire } = require("node:module");
const requireFromBot = createRequire(${JSON.stringify(requireFrom)});
const Database = requireFromBot("better-sqlite3");

async function main() {
  const args = process.argv.slice(2);
  let timeout = 5000;
  if (args[0] === "-cmd") {
    args.shift();
    const command = args.shift() ?? "";
    const matched = /^\\.timeout\\s+(\\d+)$/.exec(command);
    if (matched) timeout = Number(matched[1]);
  }
  const [filename, sql] = args;
  if (!filename || !sql) throw new Error("usage: sqlite3 [-cmd '.timeout MS'] DB SQL");
  const db = new Database(filename);
  try {
    db.pragma(\`busy_timeout = \${timeout}\`);
    const backup = /^\\.backup\\s+'((?:''|[^'])+)'$/.exec(sql);
    if (backup) {
      await db.backup(backup[1].replaceAll("''", "'"));
    } else if (/^\\s*(?:SELECT|WITH|PRAGMA)\\b/i.test(sql)) {
      for (const row of db.prepare(sql).all()) {
        console.log(Object.values(row).map((value) => value == null ? "" : String(value)).join("|"));
      }
    } else {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`);
  chmodSync(shim, 0o755);
  return `${bin}:${inherited}`;
}

describe("supervisord.sh sandbox", () => {
  let dir: string;
  let repo: string;
  let runTree: string;
  let store: Store;
  let health: string;
  let botLog: string;
  let sqlitePath: string;
  let shas: { v1: string; v2: string; broken: string; v4: string; leaseOnce: string };

  const fakeBot = (version: string) => `#!/usr/bin/env bash
trap 'exit 0' TERM
touch "${"${HEALTH}"}"
echo "FAKEBOT ready ${version}"
while true; do touch "${"${HEALTH}"}"; sleep 1; done
`;

  async function commitBot(content: string, msg: string): Promise<string> {
    writeFileSync(join(repo, "fake-bot.sh"), content.replaceAll("${HEALTH}", health));
    chmodSync(join(repo, "fake-bot.sh"), 0o755);
    await gitOrThrow(repo, ["add", "."]);
    await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg]);
    return await gitOrThrow(repo, ["rev-parse", "HEAD"]);
  }

  function runSupervisor(extraEnv: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("bash", [SCRIPT], {
        env: {
          ...process.env,
          SUP_DB: join(dir, "bot.db"),
          SUP_RUN_TREE: runTree,
          SUP_BOT_LOG: botLog,
          SUP_PIDFILE: join(dir, "bot.pid"),
          SUP_CONFIG: "/dev/null",
          SUP_DATA_DIR: dir,
          SUP_BACKUPS: join(dir, "backups"),
          SUP_RELEASES: join(dir, "releases"),
          SUP_RELEASE_KEEP: "3",
          SUP_HEALTH_FILE: health,
          SUP_MARKER: "FAKEBOT ready",
          SUP_PID_PATTERN: join(runTree, "fake-bot.sh"),
          SUP_START_CMD: `bash ${join(runTree, "fake-bot.sh")}`,
          SUP_INSTALL_CMD: "true",
          SUP_BUILD_CMD: "true",
          SUP_READY_S: "15",
          SUP_LEASE_RETRY_S: "1",
          SUP_DRAIN_S: "6",
          SUP_HEALTH_FRESH_S: "30",
          SUP_POLL_S: "1",
          SUP_ONESHOT: "1",
          PATH: sqlitePath,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += String(c)));
      child.stderr.on("data", (c) => (out += String(c)));
      child.on("exit", (code) => {
        writeFileSync(join(dir, "last-supervisor.log"), out);
        resolve(code ?? -1);
      });
    });
  }

  function killFakeBots(): void {
    try {
      execFileSync("pkill", ["-f", join(runTree, "fake-bot.sh")]);
    } catch {
      /* none running */
    }
  }

  async function until(cond: () => boolean, ms = 30_000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "supe2e-"));
    repo = join(dir, "repo");
    runTree = join(dir, "run");
    health = join(dir, "health");
    botLog = join(dir, "bot.log");
    mkdirSync(join(dir, "backups"));
    writeFileSync(botLog, "");
    sqlitePath = sqlitePathForSandbox(dir);

    await gitOrThrow(dir, ["init", "-b", "trunk", repo]);
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lock\n");
    shas = {
      v1: await commitBot(fakeBot("v1"), "v1"),
      v2: await commitBot(fakeBot("v2"), "v2"),
      broken: await commitBot("#!/usr/bin/env bash\nexit 1\n", "broken"),
      v4: await commitBot(fakeBot("v4"), "v4"),
      leaseOnce: await commitBot(`#!/usr/bin/env bash
if [[ ! -f "${join(dir, "lease-once-seen")}" ]]; then
  touch "${join(dir, "lease-once-seen")}"
  echo "Fatal error: StoreOwnershipError: capability store is owned by an exited process"
  exit 1
fi
${fakeBot("lease-retry")}`, "lease retry"),
    };
    await gitOrThrow(repo, ["branch", "stable", shas.v1]);
    await gitOrThrow(repo, ["worktree", "add", "--detach", runTree, shas.v1]);

    store = new Store(join(dir, "bot.db"));
  }, 30_000);

  afterAll(() => {
    killFakeBots();
    store.close();
    // Only this suite's immutable cache directories need reopening for fixture
    // disposal. Never chmod the linked regular files or follow workspace links.
    const writableDirectories = (root: string) => {
      if (!existsSync(root)) return;
      chmodSync(root, 0o700);
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) writableDirectories(join(root, entry.name));
      }
    };
    writableDirectories(join(dir, "releases", "dependencies"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("revives the checked-out runtime when it disappears without a deploy intent", async () => {
    killFakeBots();
    rmSync(health, { force: true });
    expect(await runSupervisor()).toBe(0);
    expect(readFileSync(botLog, "utf8")).toContain("FAKEBOT ready v1");
    expect(existsSync(health)).toBe(true);
  }, 30_000);

  it("rotates an oversized bot.log before starting a process and still sees its ready line", async () => {
    killFakeBots();
    rmSync(health, { force: true });
    writeFileSync(botLog, "FAKEBOT ready stale\n".repeat(100));
    expect(await runSupervisor({ SUP_BOT_LOG_MAX_BYTES: "1000" })).toBe(0);
    expect(readFileSync(`${botLog}.1`, "utf8")).toContain("FAKEBOT ready stale");
    const fresh = readFileSync(botLog, "utf8");
    expect(fresh).toContain("FAKEBOT ready v1");
    expect(fresh).not.toContain("stale");
  }, 30_000);

  it("happy path: claim → deploy → health gate → succeeded without human confirmation", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v2, triggered_by: "tester" });
    expect(await runSupervisor()).toBe(0);
    const row = store.devTickets.getDeployIntent(intent.id)!;
    expect(row.status).toBe("succeeded");
    expect(row.base_sha).toBe(shas.v1);
    expect(row.confirm_deadline).toBeNull();
    expect(row.detail).toContain("无需人工确认");
    expect(readFileSync(botLog, "utf8")).toContain("FAKEBOT ready v2");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v2);
    expect(readdirSync(join(dir, "backups")).some((f) => f.startsWith("bot-"))).toBe(true);
    expect(existsSync(join(dir, "releases", `${shas.v1}.tar.gz`))).toBe(true);
    expect(existsSync(join(dir, "releases", `${shas.v2}.tar.gz`))).toBe(true);
  }, 60_000);

  it("broken deploy fails the startup gate and restores the previous verified package", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.broken, triggered_by: "tester" });
    expect(await runSupervisor()).toBe(0);
    const row = store.devTickets.getDeployIntent(intent.id)!;
    expect(row.status).toBe("rolled_back");
    expect(row.detail).toContain("health_gate_failed");
    expect(row.detail).toContain(shas.v2); // rolled back to base = previous deploy
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v2);
    // The restored bot is alive again.
    expect(existsSync(health)).toBe(true);
  }, 60_000);

  it("another healthy deploy also completes without a confirmation window", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v4, triggered_by: "tester" });
    expect(await runSupervisor()).toBe(0);
    const row = store.devTickets.getDeployIntent(intent.id)!;
    expect(row.status).toBe("succeeded");
    expect(row.confirm_deadline).toBeNull();
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v4);
  }, 60_000);

  it("retries the same checkout once when only the previous writer lease blocks startup", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.leaseOnce, triggered_by: "tester" });
    expect(await runSupervisor()).toBe(0);
    expect(readFileSync(botLog, "utf8")).toContain("FAKEBOT ready lease-retry");
    expect(readFileSync(join(dir, "last-supervisor.log"), "utf8")).toContain("previous capability writer lease");
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("succeeded");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.leaseOnce);
  }, 60_000);

  const artifactEnv = () => ({ SUP_RELEASE_MODE: "artifact", SUP_REFERENCE_REPO: repo,
    SUP_ARTIFACTS: join(dir, "artifacts"), SUP_BUILD_CMD: "false", SUP_INSTALL_CMD: "false", SUP_ARTIFACT_WAIT_S: "2" });
  function preparedArtifact(id: number, sha: string): void {
    const base = join(dir, "artifacts"), fixture = join(dir, `payload-${id}`);
    const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(base, "objects"), { recursive: true }); mkdirSync(join(base, "manifests"), { recursive: true });
    mkdirSync(join(base, "intents"), { recursive: true });
    if (existsSync(join(base, "manifests", `${sha}.json`))) {
      writeFileSync(join(base, "intents", `${id}.json`), JSON.stringify({ id, sha, state: "ready" }));
      return;
    }
    mkdirSync(join(fixture, "node_modules"), { recursive: true });
    writeFileSync(join(fixture, "node_modules", "runtime"), "prepared dependencies");
    const outputs = ["packages/runner/dist", "packages/dashboard-web/dist", "plugins/sessions/dist"];
    for (const output of outputs) { mkdirSync(join(fixture, output), { recursive: true }); writeFileSync(join(fixture, output, "output"), sha); }
    const parts = ["dependencies", "outputs"].map(name => {
      const file = join(dir, `${id}-${name}.tar.gz`);
      execFileSync("tar", ["-czf", file, "-C", fixture, ...(name === "dependencies" ? ["node_modules"] : outputs)]);
      const bytes = readFileSync(file), hash = digest(bytes);
      writeFileSync(join(base, "objects", `${hash}.tar.gz`), bytes);
      return { name, file: `${name}.tar.gz`, bytes: bytes.length, sha256: hash };
    });
    writeFileSync(join(base, "manifests", `${sha}.json`), JSON.stringify({ version: 1, repoSha: sha,
      node: process.version, nodeAbi: process.versions.modules, arch: process.arch, platform: process.platform,
      lockSha256: digest("lock\n"), parts, outputs }));
    writeFileSync(join(base, "intents", `${id}.json`), JSON.stringify({ id, sha, state: "ready" }));
  }

  it("artifact mode keeps the running checkout when the remote release is missing", async () => {
    const before = await gitOrThrow(runTree, ["rev-parse", "HEAD"]);
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v4, triggered_by: "tester" });
    expect(await runSupervisor(artifactEnv())).toBe(0);
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("failed");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(before);
  }, 30_000);

  it("recovers an interrupted legacy build using complete target and previous releases with local builds disabled", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v4, triggered_by: "tester" });
    // Simulate the old builder dying after changing source but before all outputs were ready.
    preparedArtifact(-1, shas.leaseOnce);
    const previous = join(dir, "releases", "trees", shas.leaseOnce);
    execFileSync("python3", [join(process.cwd(), "scripts/ops/release-install.py"),
      join(dir, "artifacts/manifests", `${shas.leaseOnce}.json`), repo, previous]);
    writeFileSync(join(previous, ".octopus-verified"), shas.leaseOnce);
    await gitOrThrow(runTree, ["checkout", "--detach", shas.v4]);
    store.devTickets.updateDeployIntent(intent.id, { status: "building", base_sha: shas.leaseOnce });
    writeFileSync(join(dir, "artifacts/intents", `${intent.id}.previous`), previous + "\n");
    preparedArtifact(intent.id, shas.v4);
    expect(await runSupervisor(artifactEnv())).toBe(0);
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("succeeded");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v4);
    expect(readFileSync(join(runTree, "packages/runner/dist/output"), "utf8")).toBe(shas.v4);
    expect(existsSync(join(runTree, ".octopus-verified"))).toBe(true);
  }, 60_000);

  it("resumes an already switched release after a supervisor restart", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v4, triggered_by: "tester" });
    preparedArtifact(intent.id, shas.v4);
    store.devTickets.updateDeployIntent(intent.id, { status: "health_gate", base_sha: shas.v4 });
    writeFileSync(join(dir, "artifacts/intents", `${intent.id}.previous`), join(dir, "releases/trees", shas.v4) + "\n");
    expect(await runSupervisor(artifactEnv())).toBe(0);
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("succeeded");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v4);
  }, 60_000);

  it.each([0, 1])("keeps the healthy bot when backup exits %i without publishing a snapshot", async (exitCode) => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.v4, triggered_by: "tester" });
    preparedArtifact(intent.id, shas.v4);
    const failingBackup = join(dir, "fail-backup.sh");
    writeFileSync(failingBackup, `#!/bin/bash\n[[ "$1" != backup ]] || exit ${exitCode}\nexec bash "${join(process.cwd(), "scripts/ops/release-job.sh")}" "$@"\n`);
    const before = readFileSync(join(dir, "bot.pid"), "utf8");
    expect(await runSupervisor({ ...artifactEnv(), SUP_RELEASE_JOB: failingBackup })).toBe(0);
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("failed");
    expect(readFileSync(join(dir, "bot.pid"), "utf8")).toBe(before);
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v4);
  }, 30_000);

  it("restores the previous complete release when a remote-built target fails startup", async () => {
    const intent = store.devTickets.createDeployIntent({ target_sha: shas.broken, triggered_by: "tester" });
    preparedArtifact(intent.id, shas.broken);
    expect(await runSupervisor(artifactEnv())).toBe(0);
    expect(store.devTickets.getDeployIntent(intent.id)!.status).toBe("rolled_back");
    expect(await gitOrThrow(runTree, ["rev-parse", "HEAD"])).toBe(shas.v4);
  }, 60_000);
});
