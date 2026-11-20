/**
 * The research-canvas App's own test project: jsdom + the React transform for the plan
 * and module tests, plus the `app/` backend tests (pure functions, happy in
 * any environment). `src/pack.test.ts` opts into node with a
 * `@vitest-environment` pragma because it drives the real pack pipeline.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "research-docs-view",
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)", "app/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
