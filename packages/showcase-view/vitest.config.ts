/**
 * The showcase App's own test project.
 *
 * Separate from `vite.config.ts` so the production build config keeps saying
 * only what the release is: this file adds jsdom, the React transform and the
 * rule that an un-stubbed network call is a failure.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "showcase-view",
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)", "app/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
