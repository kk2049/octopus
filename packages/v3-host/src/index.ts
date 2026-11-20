/**
 * v3-host — the thin process. Reads config, seeds demo logs, starts the
 * engine Host. Everything interesting lives in packages/engine (kernel) and
 * apps/* (data + pure functions). If this file grows past ~100 lines,
 * something is in the wrong layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  AgentPlane,
  CliLoop,
  DeadlineEngine,
  Host,
  OpenAiLoop,
  type AdapterKind,
  type HostUser,
  HostCapabilities,
  setSecureMode,
  setDeploymentProfile,
  appAgentAdapterAllowed,
  executionInventory,
  profileDisclosure,
  type LoopAdapter,
  type McpCatalogEntry,
  type OpenAiLoopOptions,
} from "@claude-bot/engine";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { configureConvergenceUsage, recordConvergenceUsage } from "@claude-bot/convergence-gates";

interface SeedEvent {
  type: string;
  data: unknown;
  by?: string;
  at?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const cfgFile = process.env.V3_CONFIG ?? path.join(pkgRoot, "config.yaml");
const cfg = (yaml.load(fs.readFileSync(cfgFile, "utf8")) ?? {}) as Record<string, unknown>;

const appsDir = path.resolve(pkgRoot, String(cfg.apps_dir ?? "apps"));
const dataDir = path.resolve(pkgRoot, String(cfg.data_dir ?? "data"));
const convergenceUsage = configureConvergenceUsage(path.join(dataDir, "convergence-usage"));
recordConvergenceUsage({
  candidate: "v3-host-factory",
  principal: "system",
  entry: "v3-host.process",
  provider: "standalone-v3-host",
  effect: "lifecycle",
  outcome: "observed",
});

/** Replay seed.yaml into an instance log — only when that log doesn't exist. */
function seedApps(): void {
  if (!fs.existsSync(appsDir)) return;
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const seedFile = path.join(appsDir, entry.name, "seed.yaml");
    if (!fs.existsSync(seedFile)) continue;
    const seed = (yaml.load(fs.readFileSync(seedFile, "utf8")) ?? {}) as {
      scopes?: Record<string, SeedEvent[]>;
    };
    for (const [scope, events] of Object.entries(seed.scopes ?? {})) {
      const logFile = path.join(dataDir, "apps", entry.name, scope, "log.jsonl");
      if (fs.existsSync(logFile)) continue;
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const lines = events.map((e, i) =>
        JSON.stringify({
          seq: i + 1,
          at: e.at ?? new Date().toISOString(),
          by: e.by ?? "system:seed",
          type: e.type,
          data: e.data,
        }),
      );
      fs.writeFileSync(logFile, lines.join("\n") + "\n");
      console.log(`[v3] seeded ${entry.name}/${scope}: ${events.length} events`);
    }
  }
}

seedApps();

/**
 * The probe host owns no physical resource of its own — the Runner lives in
 * the bot process — so no Object is registered here and every
 * `ctx.capabilities.request(...)` denies. The plane still runs, because what
 * it provides is the DERIVATION chain (account → app → controller/agent run);
 * plugging a real Object in later changes `authorityFor`, nothing else.
 */
const capabilityService = new CapabilityService();
const capabilities = new HostCapabilities({
  service: capabilityService,
  // No resource of its own: a deployment wires this to the control plane that
  // owns the account authority (e.g. the bot's RunnerCapabilities), and every
  // `ctx.capabilities.request(...)` denies until it does.
  authorityFor: () => null,
});

const host = new Host({
  port: Number(cfg.port ?? 18930),
  host: String(cfg.host ?? "127.0.0.1"),
  appsDir,
  dataDir,
  users: (cfg.users ?? {}) as Record<string, HostUser>,
  publicUrl: typeof cfg.public_url === "string" && cfg.public_url ? cfg.public_url : undefined,
  mcpCatalogNames: Object.keys((cfg.mcp_catalog ?? {}) as Record<string, unknown>),
  capabilities,
});

function resolveLlm(): OpenAiLoopOptions | null {
  const llmCfg = (cfg.llm ?? {}) as Record<string, unknown>;
  const model = process.env.V3_LLM_MODEL ?? String(llmCfg.model ?? "gpt-6-astra");
  const effort = process.env.V3_LLM_EFFORT ?? (llmCfg.reasoning_effort ? String(llmCfg.reasoning_effort) : undefined);
  if (process.env.V3_LLM_BASE_URL && process.env.V3_LLM_API_KEY) {
    return { baseUrl: process.env.V3_LLM_BASE_URL, apiKey: process.env.V3_LLM_API_KEY, model, reasoningEffort: effort };
  }
  const fallback = llmCfg.fallback_config ? String(llmCfg.fallback_config) : null;
  if (fallback && fs.existsSync(fallback)) {
    try {
      const bot = (yaml.load(fs.readFileSync(fallback, "utf8")) ?? {}) as {
        openai?: { base_url?: string; api_key?: string; reasoning_effort?: string };
      };
      if (bot.openai?.base_url && bot.openai.api_key) {
        return {
          baseUrl: bot.openai.base_url,
          apiKey: bot.openai.api_key,
          model,
          reasoningEffort: effort ?? bot.openai.reasoning_effort,
        };
      }
    } catch (err) {
      console.warn(`[v3] llm fallback config unreadable: ${String((err as Error).message)}`);
    }
  }
  return null;
}

/**
 * Catalog entries handed DIRECTLY to a CLI agent bypass the engine entirely,
 * so `trust: sandboxed` is a claim the operator makes in config and the
 * default is "protected" (= not grantable). See McpCatalogEntry.trust.
 */
function resolveMcpCatalog(): Record<string, McpCatalogEntry> {
  const raw = (cfg.mcp_catalog ?? {}) as Record<
    string,
    { command?: unknown; args?: unknown; env?: unknown; trust?: unknown }
  >;
  const engineSrc = path.resolve(pkgRoot, "..", "engine", "src");
  const out: Record<string, McpCatalogEntry> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!v || typeof v.command !== "string") continue;
    out[name] = {
      command: v.command,
      args: (Array.isArray(v.args) ? v.args : []).map((a) => String(a).replaceAll("{engine}", engineSrc)),
      env: v.env && typeof v.env === "object" ? (v.env as Record<string, string>) : undefined,
      trust: v.trust === "sandboxed" ? "sandboxed" : "protected",
    };
  }
  return out;
}

// Two switches, in this order, and they are not the same switch (SEC-06):
//   · the deployment profile decides whether an ORDINARY App agent may pick a
//     coding CLI at all. Default `cloud-multi-user` = never, and `secure_mode`
//     cannot buy it back.
//   · secure mode decides whether the unisolated adapters may exist in this
//     process. It is the local-probe escape hatch, announced at boot.
// The profile must be set before `host.start()`, because that is where the
// manifests load and where a banned adapter must fail.
setDeploymentProfile(cfg.deployment_profile as string | undefined);
setSecureMode(cfg.secure_mode !== false);
const disclosure = profileDisclosure();
if (disclosure) console.warn(`[v3] ${disclosure}`);
const llm = resolveLlm();
const mcpCatalog = resolveMcpCatalog();
const adapters: Partial<Record<AdapterKind, LoopAdapter>> = {};
for (const kind of ["claude-code", "codex"] as const) {
  if (appAgentAdapterAllowed(kind)) adapters[kind] = new CliLoop(kind);
}
if (cfg.secure_mode === false) {
  console.error(
    "[v3] secure_mode=false: claude-code/codex adapters run with --dangerously-skip-permissions, "
      + "the full host environment and the same OS user. This process is NOT in protected mode.",
  );
}
if (llm) adapters["openai-loop"] = new OpenAiLoop(llm);
const plane = new AgentPlane(host, { adapters, dataDir, shimBase: () => host.boundUrl, mcpCatalog });
host.attachAgentPlane(plane);

await host.start();
plane.attach();
new DeadlineEngine(host).attach();
const apps = host.listManifests().map((m) => m.app).join(", ") || "(none)";
// The SEC-06 §4.4.5 inventory: every loop adapter, CLI executor and trusted
// service this process wired, with the count an auditor actually checks.
const inventory = executionInventory({ appAdapters: Object.keys(adapters) });
console.log(`[v3] execution inventory: ${JSON.stringify(inventory)}`);
console.log(
  `[v3] host ready on http://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 18930} — apps: ${apps} — adapters: ${Object.keys(adapters).join(",")}${llm ? ` (openai=${llm.model})` : " (openai 未配置)"}`,
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  host.stop();
  await convergenceUsage.flush();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
