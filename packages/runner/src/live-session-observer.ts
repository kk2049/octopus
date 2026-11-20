import fs from "node:fs/promises";
import path from "node:path";
import { LinuxProcessReader, matchesProvider, type ProcSnapshot, type AgentProvider, type AgentRuntimeRegistry } from "./agent-runtime.js";
import { LinuxProcessLister, discoverOmpSessions } from "./omp-terminal.js";
import { discoverLiveCodexTerminals } from "./codex-terminal.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import type { SessionObservationIndex } from "./session-observation.js";

// Root discovery includes native app-server infrastructure. Terminal ownership
// separately uses matchesProvider, which deliberately excludes those processes.
const isCodexProcess = (row: ProcSnapshot): boolean => row.command === "codex"
  || path.basename(row.argv[0] ?? "") === "codex" || matchesProvider(row, "codex");

/** One short-lived process snapshot shared by root and terminal discovery. */
export class AgentProcessObservation {
  private rows: ProcSnapshot[] = [];
  private expires = 0;
  private flight?: Promise<ProcSnapshot[]>;
  private readonly reader = new LinuxProcessReader();
  async snapshot(): Promise<ProcSnapshot[]> {
    if (Date.now() < this.expires) return this.rows;
    return this.flight ??= (async () => {
      const rows: ProcSnapshot[] = [];
      for (const pid of await new LinuxProcessLister().list()) {
        try {
          if ((await fs.stat(`/proc/${pid}`)).uid !== process.getuid?.()) continue;
          const row = await this.reader.read(pid);
          if (row && (isCodexProcess(row) || matchesProvider(row, "claude") || matchesProvider(row, "omp"))) rows.push(row);
        } catch { /* Process exits are ordinary observations. */ }
      }
      this.rows = rows; this.expires = Date.now() + 2_000; return rows;
    })().finally(() => { this.flight = undefined; });
  }
  async codexHomes(home: string): Promise<string[]> {
    const homes = new Set<string>();
    for (const row of await this.snapshot()) {
      if (!isCodexProcess(row)) continue;
      try {
        const env = await fs.readFile(`/proc/${row.pid}/environ`, "utf8");
        homes.add(env.split("\0").find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) || path.join(home, ".codex"));
      } catch { /* Exited between process and environment observations. */ }
    }
    return [...homes];
  }
}

/** Continuous work is proportional to live terminals and managed sessions. */
export class LiveSessionObserver {
  private timer?: NodeJS.Timeout;
  private flight?: Promise<void>;
  private closed = false;
  private readonly changed = new Map<string, { source: AgentProvider; id: string; path?: string }>();
  private detach?: () => void;
  constructor(private readonly options: {
    home: string; processes: AgentProcessObservation; runtime: AgentRuntimeRegistry;
    control: AgentControlPlane; ordinary: SessionObservationIndex; split: SessionObservationIndex;
    onError?: (error: unknown) => void;
  }) {}
  start(): void {
    this.detach = this.options.control.onManagedTranscriptActivity((source, id, path) => {
      const key = `${source}:${id}`;
      this.changed.set(key, { source, id, path: path ?? this.changed.get(key)?.path });
    });
    this.timer = setInterval(() => { void this.tick().catch(this.options.onError ?? (() => {})); }, 2_000);
    this.timer.unref(); void this.tick().catch(this.options.onError ?? (() => {}));
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    return this.flight ??= this.advance().finally(() => { this.flight = undefined; });
  }
  private async advance(): Promise<void> {
    const { control, processes, runtime, ordinary, split, home } = this.options;
    await Promise.all([ordinary.start(), split.start()]);
    const [rows, ttys] = await Promise.all([processes.snapshot(), process.platform === "linux"
      ? control.observedTerminalTtys() : Promise.resolve(new Set<string>())]);
    const codex = await discoverLiveCodexTerminals(rows, ttys, runtime, (file) => ordinary.accepts("codex", file));
    const daemon = await control.codexDaemon?.refresh(home, rows, ttys, (file) => ordinary.accepts("codex", file)) ?? [];
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    // OMP breadcrumbs point at exact transcripts; reuse this same /proc snapshot.
    if (rows.some((row) => matchesProvider(row, "omp"))) await discoverOmpSessions(home, runtime, {
      lister: { list: async () => [...byPid.keys()] }, read: async (pid) => byPid.get(pid) ?? null,
    });
    const terminal: Array<{ source: AgentProvider; id: string; path?: string }> = [
      ...codex.map((row) => ({ source: "codex" as const, id: row.sessionId, path: row.sessionPath })),
      ...daemon.map((row) => ({ source: "codex" as const, id: row.id, path: row.path })),
    ];
    for (const observed of runtime.observedSessions()) {
      if (observed.source === "codex" && observed.event === "CodexRolloutObserved"
        && !codex.some((row) => row.sessionId === observed.id)) {
        await runtime.forgetExternalCli("codex", observed.id, "CodexRolloutObserved"); continue;
      }
      const process = byPid.get(observed.process.pid);
      if (!process || process.startTicks !== observed.process.startTicks || process.bootId !== observed.process.bootId) continue;
      if (!ttys.has(await fs.readlink(`/proc/${process.pid}/fd/0`).catch(() => ""))) continue;
      if (!terminal.some((row) => row.source === observed.source && row.id === observed.id)) terminal.push(observed);
    }
    const managed = control.managedSessions();
    ordinary.setLive([...terminal, ...managed]); split.setLive(managed);
    for (const identity of terminal) await ordinary.refresh(identity, identity.path);
    // Protocol events coalesce by native id. First discovery/recovery is also
    // checked; metadata equality makes idle managed sessions cheap.
    const pending = new Map([...this.changed.values(), ...managed].map((row) => [`${row.source}:${row.id}`, row]));
    this.changed.clear();
    for (const identity of pending.values()) {
      // Native paths bypass history discovery, but never corpus/root checks.
      for (const index of [ordinary, split]) {
        const file = identity.path && await index.accepts(identity.source, identity.path) ? identity.path : undefined;
        await index.refresh(identity, file);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.detach?.(); await this.flight;
  }
}
