/**
 * The generic data modules' test project.
 *
 * Its own project rather than a shared jsdom default, for the same reason every
 * browser package here has one: a server test that silently acquired a fake
 * `window` would start passing for the wrong reason.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "agent-data-view",
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
