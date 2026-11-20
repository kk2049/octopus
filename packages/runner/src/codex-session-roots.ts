import fs from "node:fs/promises";
import path from "node:path";
import type { CodexSessionScanRoot, SessionScanRoots } from "@claude-bot/plugin-sessions/scan";
import { LinuxProcessLister } from "./omp-terminal.js";

const REFRESH_MS = 3_000;
// History roots no longer participate in every live scan. Keep their durable
// locators beyond the old watcher-sized cap so new workers survive a restart.
const MAX_OBSERVED_ROOTS = 100_000;

/** Read one provider setting, never retain or report the rest of a process environment. */
export async function runningCodexHomes(home: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  const roots = new Set<string>();
  for (const pid of await new LinuxProcessLister().list()) {
    try {
      const proc = `/proc/${pid}`;
      const [stat, executable] = await Promise.all([fs.stat(proc), fs.readlink(`${proc}/exe`)]);
      if (stat.uid !== process.getuid?.() || path.basename(executable) !== "codex") continue;
      const environment = await fs.readFile(`${proc}/environ`, "utf8");
      const value = environment.split("\0").find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11);
      roots.add(value || path.join(home, ".codex"));
    } catch { /* A process may exit between any two observations. */ }
  }
  return [...roots];
}

/**
 * Discovery is device-local and read-only authority. Account routing remains an
 * explicit separate configuration. In particular the isolated relay root never
 * enters this catalog: it still requires Host-selected session provenance.
 */
export class CodexSessionRoots {
  private readonly observed = new Set<string>();
  private loaded = false;
  private expires = 0;
  private snapshot: SessionScanRoots;
  private refreshing?: Promise<SessionScanRoots>;
  private accountSignature = "";

  constructor(private readonly options: {
    home: string;
    codexHome: string;
    accounts?: readonly CodexSessionScanRoot[];
    stateFile?: string;
    discover?: () => Promise<readonly string[]>;
    now?: () => number;
    onWarning?: (code: "discovery_failed" | "catalog_full" | "catalog_persist_failed") => void;
  }) {
    this.snapshot = { home: options.home, codexHome: options.codexHome };
  }

  async refresh(): Promise<SessionScanRoots> {
    if ((this.options.now?.() ?? Date.now()) < this.expires) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.rebuild().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async rebuild(): Promise<SessionScanRoots> {
    const home = await fs.realpath(this.options.home);
    const stateFile = this.options.stateFile ?? path.join(home, ".octopus", "session-scan-roots.json");
    const excluded = await fs.realpath(path.join(home, ".octopus", "codex-split-home"))
      .catch(() => path.join(home, ".octopus", "codex-split-home"));
    const inside = (parent: string, candidate: string): boolean => candidate === parent || candidate.startsWith(parent + path.sep);
    const acceptedObserved = async (value: unknown): Promise<string | null> => {
      if (typeof value !== "string" || !path.isAbsolute(value)) return null;
      const resolved = await fs.realpath(value).catch(() => null);
      if (!resolved || !inside(home, resolved) || inside(excluded, resolved)) return null;
      // A symlinked sessions directory cannot turn discovery into arbitrary disclosure.
      const sessions = await fs.realpath(path.join(resolved, "sessions")).catch(() => null);
      return sessions && inside(resolved, sessions) && !inside(excluded, sessions)
        && (await fs.stat(sessions).catch(() => null))?.isDirectory() ? resolved : null;
    };
    if (!this.loaded) {
      const stored = await fs.readFile(stateFile, "utf8").catch(() => "");
      try {
        const rows: unknown = JSON.parse(stored);
        if (Array.isArray(rows) && rows.length <= MAX_OBSERVED_ROOTS) {
          for (const row of rows) {
            const root = await acceptedObserved(row);
            if (root) this.observed.add(root);
          }
        }
      } catch { /* An absent or malformed local discovery cache is reconstructible. */ }
      this.loaded = true;
    }
    let changed = false;
    const running = await (this.options.discover?.() ?? runningCodexHomes(home)).catch(() => {
      this.options.onWarning?.("discovery_failed");
      return [];
    });
    for (const value of running) {
      const root = await acceptedObserved(value);
      if (!root) continue;
      if (this.observed.has(root)) continue;
      if (this.observed.size >= MAX_OBSERVED_ROOTS) { this.options.onWarning?.("catalog_full"); continue; }
      this.observed.add(root);
      changed = true;
    }
    const roots: CodexSessionScanRoot[] = [];
    const seen = new Set<string>();
    const add = async (root: CodexSessionScanRoot): Promise<void> => {
      const resolved = await fs.realpath(root.codexHome).catch(() => path.resolve(root.codexHome));
      const sessions = await fs.realpath(path.join(resolved, "sessions")).catch(() => null);
      if (seen.has(resolved) || inside(excluded, resolved) || (sessions && inside(excluded, sessions))) return;
      seen.add(resolved);
      roots.push({ ...root, codexHome: resolved });
    };
    // Configured labels win, but never replace the ordinary default home.
    for (const root of this.options.accounts ?? []) await add(root);
    const accountDir = path.join(home, ".codex-accounts");
    const accounts = await fs.readdir(accountDir, { withFileTypes: true }).catch(() => []);
    for (const entry of accounts.sort((a, b) => a.name.localeCompare(b.name))) {
      const match = /^account-([a-z])$/.exec(entry.name);
      if (!match || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const candidate = path.join(accountDir, entry.name);
      // A conventional account alias is an explicit local read registration,
      // like accounts above. It may point at a migrated home; it does not grant
      // credential routing, cross-UID process access or terminal control.
      const root = await fs.realpath(candidate).catch(() => null);
      const sessions = root && await fs.realpath(path.join(root, "sessions")).catch(() => null);
      if (root && sessions && inside(root, sessions)
        && !sessions.split(path.sep).some((part, i, parts) => part === "codex-split-home" && parts[i - 1] === ".octopus")
        && (await fs.stat(sessions).catch(() => null))?.isDirectory()) {
        await add({ label: match[1], codexHome: root });
      }
    }
    await add({ label: "", codexHome: this.options.codexHome });
    await add({ label: "", codexHome: path.join(home, ".codex") });
    const accountSignature = JSON.stringify(roots);
    if (!changed && this.snapshot.codexHomes && accountSignature === this.accountSignature) {
      this.expires = (this.options.now?.() ?? Date.now()) + REFRESH_MS;
      return this.snapshot;
    }
    this.accountSignature = accountSignature;
    // Observed roots were canonicalized on admission/startup. Session reads
    // revalidate authority; neither process exits nor new roots restat history.
    for (const codexHome of this.observed) if (!seen.has(codexHome)) {
      seen.add(codexHome); roots.push({ label: "", codexHome });
    }
    if (changed) {
      try {
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        const temporary = `${stateFile}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify([...this.observed]) + "\n", { mode: 0o600 });
        await fs.rename(temporary, stateFile);
      } catch { this.options.onWarning?.("catalog_persist_failed"); }
    }
    this.snapshot = { home: this.options.home, codexHome: this.options.codexHome, codexHomes: roots };
    this.expires = (this.options.now?.() ?? Date.now()) + REFRESH_MS;
    return this.snapshot;
  }
}
