/** Bundle this entry on the builder; execute on the Runner's own machine. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareIsolatedCodexHome } from "../../../packages/runner/src/codex-app-server-host.js";
import { writeInstalledConfig, writeRunnerToken } from "../../../packages/runner/src/install-config.js";

const [rootInput, role, device, tokenFile, credentialSource] = process.argv.slice(2);
if (!rootInput || !path.isAbsolute(rootInput) || rootInput === "/" || !["model", "execution"].includes(role ?? "")
  || !device?.startsWith("lab_") || !tokenFile) throw new Error("Usage: seed-runner <marked-lab-root> model|execution lab_device <token-file> [credential-source]");
const root = path.resolve(rootInput);
const marker = JSON.parse(readFileSync(path.join(root, ".refactor-lab"), "utf8")) as { origin: string };
const origin = new URL(marker.origin);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Runner lab requires a loopback origin");
const scan = path.join(root, "runners", role!);
if (existsSync(path.join(scan, ".octopus", "runner", "config.json"))) throw new Error("Runner already seeded; preserve its session journal");
if (role === "model" && (!credentialSource || !path.isAbsolute(credentialSource))) throw new Error("Model Runner needs an explicit local credential source");
const codex = path.join(scan, ".codex");
mkdirSync(scan, { recursive: true, mode: 0o700 });
if (role === "model") await prepareIsolatedCodexHome(credentialSource!, codex);
else mkdirSync(codex, { recursive: true, mode: 0o700 });
writeInstalledConfig({ version: 1, dashboard_url: origin.origin,
  runner_url: `ws://${origin.host}/octopus-runner/v1`, device, scan_home: scan, codex_home: codex,
  installed_at: new Date().toISOString(), control_site: "primary", update_site: "none",
  // Codex split execution needs exec-server; execution_only disables that host.
  // The execution Runner has an empty private Codex home and no model credentials.
  execution_only: false });
writeRunnerToken(scan, readFileSync(tokenFile, "utf8").trim());
const runtime = path.join(scan, "runtime");
mkdirSync(runtime, { recursive: true, mode: 0o700 });
writeFileSync(path.join(scan, "environment.json"), JSON.stringify({ RUNNER_SCAN_HOME: scan, XDG_RUNTIME_DIR: runtime,
  RUNNER_AGENT_HOOKS: "off", RUNNER_LOCAL_MCP: "off", OCTOPUS_RUNNER_DSH_TUNNEL: "0", RUNNER_KNOWLEDGE_INDEX: "0" }), { mode: 0o600 });
console.log(JSON.stringify({ seeded: true, role, device, scan, runtime, updateSite: "none" }));
