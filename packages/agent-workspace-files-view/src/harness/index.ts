/**
 * `@claude-bot/agent-workspace-files-view/harness` — the fixture-backed port.
 *
 * A separate entry point so a production View cannot pick it up by reaching for
 * the obvious import: the package root exports what an App composes, and this
 * exports what a test, a storybook or a demo composes instead.
 */

export {
  createMemoryWorkspaceFilesPort,
  type MemoryWorkspaceFilesPort,
  type MemoryWorkspaceFixture,
} from "./memory-port.js";
