/**
 * Projection runner — pure fold(events) → view, memoized on (log revision,
 * module version). Deleting nothing, caching everything: a projection bug is
 * a rendering bug, never data loss (HQ's rule, promoted to engine law).
 */

import { HotModule } from "./hot.js";
import { EventLog } from "./store.js";
import type { EngineEvent } from "./types.js";

export interface ProjectionModule {
  project(events: readonly EngineEvent[]): unknown;
}

export class Projector {
  private hot: HotModule<ProjectionModule>;
  private cached: unknown;
  private rev = -1;
  private ver = -1;

  constructor(file: string) {
    this.hot = new HotModule<ProjectionModule>(file);
  }

  async project(log: EventLog): Promise<unknown> {
    const { mod, version } = await this.hot.get();
    const rev = log.revision;
    if (rev === this.rev && version === this.ver) return this.cached;
    if (typeof mod.project !== "function") {
      throw new Error(`${this.hot.file} must export project(events)`);
    }
    this.cached = mod.project(log.read());
    this.rev = rev;
    this.ver = version;
    return this.cached;
  }
}
