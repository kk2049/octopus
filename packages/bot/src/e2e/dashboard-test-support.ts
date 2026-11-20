/** Explicit dashboard composition for tests; assertions still exercise the real server. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RUNNER_GATEWAY_PROTOCOL } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices, type DashboardComposition } from "../bootstrap-v3.js";
import type { DashboardCompositionOptions } from "../dashboard/ports.js";
import { DashboardServer } from "../dashboard/server.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerBundleSource } from "../runner/bundle-registry.js";
import type { Store } from "../store/store.js";

class TestDashboardServer extends DashboardServer {
  constructor(private composition: DashboardComposition) {
    super(composition.options, composition.services);
    composition.attachTransport(this.transportLifecycle);
  }

  override async start(): Promise<void> {
    try {
      await super.start();
    } catch (error) {
      await this.composition.close();
      throw error;
    }
  }

  override async stop(): Promise<void> {
    await super.stop();
    await this.composition.close();
  }
}

export function createDashboardTestServer(
  store: Store,
  caps: RunnerCapabilities | undefined,
  options: DashboardCompositionOptions,
): DashboardServer {
  return new TestDashboardServer(composeDashboardServices(store, caps, options));
}

/** File-backed test source; production uses RunnerBundleRegistry pointers. */
export function runnerBundleSourceFromFile(file: string): RunnerBundleSource {
  return {
    active: () => {
      const bytes = readFileSync(file);
      const sha = createHash("sha256").update(bytes).digest("hex");
      return {
        sha,
        size: bytes.length,
        gatewayProtocol: RUNNER_GATEWAY_PROTOCOL,
        bytes,
        base64: bytes.toString("base64"),
      };
    },
    health: () => ({
      ok: true,
      activeSha: createHash("sha256").update(readFileSync(file)).digest("hex"),
      previousSha: null,
      gatewayProtocol: RUNNER_GATEWAY_PROTOCOL,
      activatedAt: null,
      activatedBy: "test",
    }),
  };
}
