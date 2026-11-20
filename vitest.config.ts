/**
 * Separate test environments, because the repository has more than one runtime.
 *
 * Everything that was here before runs in Node exactly as it did. Browser code
 * needs a DOM and the React transform, so each browser package gets its own
 * project rather than a global `environment: "jsdom"` — a server test that
 * silently acquired a fake `window` would start passing for the wrong reason,
 * and several of the server tests are about what happens WITHOUT a browser.
 *
 * Browser projects remain separate package suites. Current Apps share the
 * Dashboard runtime in production; these test projects are not trust domains:
 *
 *   dashboard-web              the trusted panel (cookies, same-origin API)
 *   agent-view-react           the shared App SDK and its layout kernel
 *   agent-sessions-view        the reusable sessions modules
 *   agent-workspace-files-view the reusable read-only file modules
 *   agent-text-view            the shared CodeMirror document surface
 *   agent-editor-view          the reusable text editor module
 *   agent-data-view            the reusable projection-backed data modules
 *   agent-board-view           the reusable generic grid-board module
 *   agent-schedule-view        the reusable resource calendar module
 *   agent-intake-view          the reusable upload/workflow module
 *   agent-feishu-view          the reusable Feishu document-link module
 *   agent-crdt-view            the reusable collaborative-note module
 *   agent-deck-view            the reusable deck outline/slide/export modules
 *   session-plus-view          the App that composes them
 *   showcase-view              a DECLARED App that composes the same modules
 *   ppt-studio-view            a DECLARED deck App with lazy atomic skills
 *   chess-view                 a DECLARED shared-scope App on the board module
 *   meeting-room-view          a DECLARED shared resource-booking App
 *   expense-intake-view        a DECLARED viewer-scoped intake App
 *   daily-brief-view           a DECLARED account-scope summary App
 *   report-space-view          a DECLARED shared-scope reporting App
 *   research-program-view      a DECLARED shared autonomous-research App
 *
 * Each is referenced by path so its React plugin resolves from the package that
 * depends on it; the root stays free of frontend build deps.
 *
 * `npx vitest run` still runs all of them.
 */

import { defineConfig } from "vitest/config";
import { parseCLI } from "vitest/node";

// Vitest 4 does not forward CLI exclusions into named projects. The Node
// project owns the real-browser specs that the landing gate explicitly omits.
// Preserve that caller choice without excluding them from ordinary CI runs.
const cliExcludes = parseCLI(["vitest", ...process.argv.slice(2)], { allowUnknownOptions: true }).options.exclude ?? [];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // This project contains both unit tests and process-level Host,
          // sandbox, runner, watcher, and E2E tests. On the two-core release
          // host a healthy integration case can exceed Vitest's 5s unit-test
          // default under full-suite contention. Assertions still fail
          // immediately; 20s is only the per-case ceiling for genuine hangs.
          testTimeout: 20_000,
          // Fixtures under os.tmpdir() must be executable (fails loudly otherwise):
          // a fake CLI on a noexec /tmp would fall through to the real one.
          setupFiles: ["./tools/test-support/vitest-node-setup.mjs"],
          include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: [
            ...cliExcludes,
            "**/node_modules/**",
            "**/dist/**",
            "packages/dashboard-web/**",
            "packages/feishu-docs-addon/**",
            "packages/agent-view-react/**",
            "packages/agent-sessions-view/**",
            "packages/agent-workspace-files-view/**",
            "packages/agent-text-view/**",
            "packages/agent-editor-view/**",
            "packages/agent-data-view/**",
            "packages/agent-board-view/**",
            "packages/agent-schedule-view/**",
            "packages/agent-intake-view/**",
            "packages/agent-feishu-view/**",
            "packages/agent-crdt-view/**",
            "packages/agent-deck-view/**",
            "packages/session-plus-view/**",
            "packages/showcase-view/**",
            "packages/ppt-studio-view/**",
            "packages/chess-view/**",
            "packages/meeting-room-view/**",
            "packages/expense-intake-view/**",
            "packages/daily-brief-view/**",
            "packages/report-space-view/**",
            "packages/research-program-view/**",
            "packages/research-canvas-view/**",
            "packages/research-docs-view/**",
          ],
        },
      },
      "packages/dashboard-web/vitest.config.ts",
      "packages/feishu-docs-addon/vitest.config.ts",
      "packages/agent-view-react/vitest.config.ts",
      "packages/agent-sessions-view/vitest.config.ts",
      "packages/agent-workspace-files-view/vitest.config.ts",
      "packages/agent-text-view/vitest.config.ts",
      "packages/agent-editor-view/vitest.config.ts",
      "packages/agent-data-view/vitest.config.ts",
      "packages/agent-board-view/vitest.config.ts",
      "packages/agent-schedule-view/vitest.config.ts",
      "packages/agent-intake-view/vitest.config.ts",
      "packages/agent-feishu-view/vitest.config.ts",
      "packages/agent-crdt-view/vitest.config.ts",
      "packages/agent-deck-view/vitest.config.ts",
      "packages/session-plus-view/vitest.config.ts",
      "packages/showcase-view/vitest.config.ts",
      "packages/ppt-studio-view/vitest.config.ts",
      "packages/chess-view/vitest.config.ts",
      "packages/meeting-room-view/vitest.config.ts",
      "packages/expense-intake-view/vitest.config.ts",
      "packages/daily-brief-view/vitest.config.ts",
      "packages/report-space-view/vitest.config.ts",
      "packages/research-program-view/vitest.config.ts",
      "packages/research-canvas-view/vitest.config.ts",
      "packages/research-docs-view/vitest.config.ts",
    ],
  },
});
