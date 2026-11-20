import { fileURLToPath } from "node:url";
import { runnerBundleProtocolBanner } from "./src/gateway-protocol.js";

import { defineConfig } from "tsup";

export default defineConfig([
  // Library build: bot imports the focused subpaths below; deps stay external
  // for workspace runtime.
  // `directories` and `workspace-files` are shared rather than restated on the
  // bot side because two spellings of "which paths are acceptable" would let an
  // approval card be signed for a request the device then refuses.
  {
    entry: [
      "src/index.ts",
      "src/core.ts",
      "src/capability-protocol.ts",
      "src/managed-execution.ts",
      "src/limits.ts",
      "src/session-attachments.ts",
      "src/directories.ts",
      "src/workspaces.ts",
      "src/workspace-jobs.ts",
      "src/meeting-transcription-protocol.ts",
      "src/meeting-transcription-integrity.ts",
      "src/meeting-transcription-worker.ts",
      "src/meeting-transcription.ts",
      "src/workspace-development-protocol.ts",
      "src/workspace-development.ts",
      "src/workspace-files.ts",
      "src/file-transfer.ts",
      "src/codex-app-server.ts",
      "src/codex-exec-relay.ts",
      "src/codex-agent-relay.ts",
      "src/codex-account-routing.ts",
      "src/omp-rpc.ts",
      "src/inventory.ts",
      "src/claude-quota.ts",
      "src/session-projection.ts",
      "src/gateway-protocol.ts",
      "src/system-status.ts",
      "src/guest-sessions.ts",
      "src/guest-console.ts",
      "src/guest-terminal.ts",
    ],
    format: ["esm"],
    dts: true,
    clean: true,
    // The sessions contract ships TypeScript source; inline the small part the
    // Runner uses so library consumers never load a .ts file at runtime.
    noExternal: [/^@claude-bot\/agent-sessions-contract(?:\/|$)/],
  },
  // Self-contained single file served by the dashboard at /download/runner.js —
  // a laptop needs nothing but Node to run it. ws's optional native addons
  // (bufferutil/utf-8-validate) stay external; ws try/requires them at runtime.
  {
    entry: { standalone: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    noExternal: [/.*/],
    external: ["bufferutil", "utf-8-validate"],
    // Single-package builds may still have an older dependency dist. The
    // standalone artifact must consume the same workspace source its cache
    // fingerprint names, irrespective of the library build order.
    esbuildOptions(options) {
      options.alias = { ...options.alias,
        "@claude-bot/plugin-sessions/scan": fileURLToPath(new URL("../../plugins/sessions/src/scan.ts", import.meta.url)),
        "@claude-bot/plugin-sessions/parse": fileURLToPath(new URL("../../plugins/sessions/src/parse.ts", import.meta.url)),
      };
    },
    banner: {
      js: `${runnerBundleProtocolBanner()}\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
    },
  },
]);
