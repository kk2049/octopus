/** Account-bound, config-isolated Codex hosts for remote execution. */
import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexSessionScanRoot, SessionScanRoots } from "@claude-bot/plugin-sessions/scan";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codex-app-server-host.js";

export interface CodexSplitHostSelection {
  host: CodexAppServerHost;
  /** Persist this native state root for exact resume/recovery. */
  codexHome: string;
}

export class CodexSplitHosts {
  readonly defaultHost: CodexAppServerHost;
  readonly scanRoot: SessionScanRoots;
  private readonly selected = new Map<string, CodexSplitHostSelection>();
  private readonly hosts = new Set<CodexAppServerHost>();

  constructor(options: {
    home: string;
    defaultCodexHome: string;
    splitHome: string;
    endpointFile: string;
    accounts?: readonly CodexSessionScanRoot[];
    spawnProcess?: CodexAppServerHostOptions["spawnProcess"];
  }) {
    const roots: CodexSessionScanRoot[] = [];
    const register = (source: string, destination: string, label: string, endpointFile: string): CodexSplitHostSelection => {
      const sourceHome = path.resolve(source);
      const existing = this.selected.get(sourceHome);
      if (existing) return existing;
      const codexHome = path.resolve(destination);
      const host = new CodexAppServerHost({ cwd: options.home, endpointFile,
        replaceWhenIdle: true, isolateConfig: true, sourceCodexHome: sourceHome, isolatedCodexHome: codexHome,
        ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}) });
      const selection = { host, codexHome };
      this.selected.set(sourceHome, selection);
      this.selected.set(codexHome, selection);
      this.hosts.add(host);
      roots.push({ label, codexHome });
      return selection;
    };
    const defaultSelection = register(options.defaultCodexHome, options.splitHome, "", options.endpointFile);
    this.defaultHost = defaultSelection.host;
    for (const account of options.accounts ?? []) {
      // Bind storage to the registered source root, not a mutable display slot.
      // Descendants remain excluded by ordinary session-root discovery.
      const key = createHash("sha256").update(path.resolve(account.codexHome)).digest("hex");
      register(account.codexHome, path.join(options.splitHome, "accounts", key), account.label,
        path.join(path.dirname(options.endpointFile), `codex-split-${key}.endpoint`));
    }
    // The scanner resolves the first containing home. Account homes are nested
    // under the legacy private corpus, so prefer the most specific root.
    this.scanRoot = { home: options.home, codexHome: defaultSelection.codexHome,
      codexHomes: roots.sort((a, b) => b.codexHome.length - a.codexHome.length) };
  }

  select(codexHome?: string): CodexSplitHostSelection {
    if (!codexHome) return { host: this.defaultHost, codexHome: this.scanRoot.codexHome! };
    const selection = this.selected.get(path.resolve(codexHome));
    if (!selection) throw new Error("Codex 跨机器执行账号未在此 Runner 登记，不能切换到默认账号");
    return selection;
  }

  async close(): Promise<void> {
    await Promise.all([...this.hosts].map(host => host.close()));
  }

  terminate(): void {
    for (const host of this.hosts) host.terminate();
  }
}
