/**
 * The Agent View SDK's test project.
 *
 * jsdom plus the React transform, because everything here is browser code —
 * since 2026-08-11 without exception: the node-side toolchain moved to
 * `@claude-bot/agent-view-build`, whose tests run in the root `node` project.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "agent-view",
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
