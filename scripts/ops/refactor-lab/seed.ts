/** Fresh, synthetic accounts only. This command must run before the lab Head. */
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../../../packages/bot/src/store/store.js";
import { UserManagerImpl } from "../../../packages/bot/src/user/manager.js";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/" || !existsSync(path.join(root, ".refactor-lab"))) {
  throw new Error("Explicit isolated root with .refactor-lab marker is required");
}
const marker = JSON.parse(readFileSync(path.join(root, ".refactor-lab"), "utf8")) as { origin: string; dashboardPort: number; runnerPort: number };
const origin = new URL(marker.origin);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Lab origin must use a private loopback tunnel");
for (const port of [marker.dashboardPort, marker.runnerPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid isolated listener port");
}
const privateDir = path.join(root, "private");
const dataDir = path.join(root, "state");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configFile = path.join(privateDir, "config.json");
const credentialsFile = path.join(privateDir, "credentials.json");
if (existsSync(configFile) || existsSync(credentialsFile) || existsSync(path.join(dataDir, "bot.db"))) {
  throw new Error("Seed refuses existing config, credentials or database; reuse the existing lab");
}
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const credentials = {
  admin: token("lab_"),
  users: Object.fromEntries(["lab_alice", "lab_bob"].map((name) => [name, {
    dashboard: token("dt_"), model: token("rt_"), execution: token("rt_"),
  }])),
};
// Credentials never appear on stdout or in an acceptance report.
writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const store = new Store(path.join(dataDir, "bot.db"));
try {
  const manager = new UserManagerImpl(store, dataDir, false);
  await manager.restore();
  for (const [username, keys] of Object.entries(credentials.users)) {
    await manager.register(username, { provider: "cli", externalId: `refactor-lab:${username}` });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const at = new Date().toISOString();
    store.saveDashboardToken(hash(keys.dashboard), username, at);
    store.saveRunnerToken(hash(keys.model), username, `${username}_model`, at);
    store.saveRunnerToken(hash(keys.execution), username, `${username}_execution`, at);
    for (const role of ["model", "execution"] as const) {
      writeFileSync(path.join(privateDir, `${username}_${role}.token`), `${keys[role]}\n`, { mode: 0o600, flag: "wx" });
    }
  }
} finally { store.close(); }
writeFileSync(configFile, `${JSON.stringify({
  instance: { name: "managed-agent-refactor-lab", data_dir: dataDir },
  channels: {},
  agent: { provider: "openai", model: "gpt-5.6-sol", uid_isolation: false },
  runner: { enabled: true, host: "127.0.0.1", port: marker.runnerPort },
  dashboard: { enabled: true, host: "127.0.0.1", port: marker.dashboardPort,
    public_url: origin.origin, runner_public_url: `ws://${origin.host}/octopus-runner/v1`,
    auth_token: credentials.admin, admins: ["lab_alice"] },
  session_plus: { enabled: true, shared_origin: true, view_host: "127.0.0.1", view_port: marker.dashboardPort + 1 },
  app_agents: { enabled: true, deployment_profile: "local-owner", default_model: "gpt-5.6-sol" },
  fleet: { enabled: false }, selfhosting: { enabled: false },
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ seeded: true, users: Object.keys(credentials.users), dataDir }));
