/** Trusted, content-free bridge from authenticated Runner changes to one owner. */

import type { RunnerCapabilities } from "../runner/capability.js";

export class SessionPlusSessionChangeBinding {
  constructor(private readonly capabilities: RunnerCapabilities) {}

  subscribe(owner: string, listener: () => void): () => void {
    return this.capabilities.onSessionChanged(owner, () => listener());
  }
}
