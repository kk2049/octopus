/**
 * Warm hot-plug for pure-function modules.
 *
 * NOTE (security): the Host no longer loads app code this way — projections
 * and action handlers run in the sandboxed child process (runtime/sandbox.ts),
 * because an in-process `import()` of agent-authored code shares the Host's
 * heap, environment and module graph. This class survives for the standalone
 * `Projection` helper and for TRUSTED first-party modules only; do not route
 * app code back through it.
 *
 * Pure functions are the one kind of code that can be reloaded safely at
 * runtime: no closures over connections, no timers, no listeners. We re-import
 * on mtime change with a cache-busting query. Two honest costs, accepted:
 * Node never unloads modules, so each reload leaks the previous version
 * (negligible at edit frequency); and a runtime that cannot resolve
 * query-suffixed module ids degrades to "stale until restart" with one warning
 * rather than failing.
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

export class HotModule<T extends object = Record<string, unknown>> {
  private mod: T | null = null;
  private version = -1;
  private warnedStale = false;

  constructor(readonly file: string) {}

  async get(): Promise<{ mod: T; version: number }> {
    const st = fs.statSync(this.file);
    if (this.mod && st.mtimeMs === this.version) return { mod: this.mod, version: this.version };
    const base = pathToFileURL(this.file).href;
    let mod: T;
    try {
      mod = (await import(`${base}?v=${st.mtimeMs}`)) as T;
    } catch {
      mod = (await import(base)) as T;
      if (this.mod && !this.warnedStale) {
        console.warn(`[engine] runtime cannot bust module cache; ${this.file} stays stale until restart`);
        this.warnedStale = true;
      }
    }
    this.mod = mod;
    this.version = st.mtimeMs;
    return { mod, version: this.version };
  }
}
