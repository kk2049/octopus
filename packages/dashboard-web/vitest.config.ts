/**
 * The browser bundle's test project.
 *
 * Separate from `vite.config.ts` so the production build config stays about the
 * build and nothing else: this file adds jsdom, the setup that installs a
 * bootstrap payload, and the rule that an un-stubbed network call is a failure.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    // jsdom + four concurrent React files is slow enough on a loaded box that
    // the 1s default for `findBy*` produces failures that say nothing about the
    // code. The assertions still fail fast when something is actually wrong.
    testTimeout: 15_000,
  },
});
