/**
 * `@claude-bot/agent-editor-view/harness` — a writable port and a fixture.
 *
 * A separate entry from the package root for the same reason the workspace-files
 * harness is: a production bundle must not pick up a fake implementation by
 * reaching for the obvious import. Tests, a storybook and `app:preview` all want
 * it; a release does not.
 */

export {
  createWritableMemoryWorkspaceFilesPort,
  digestOf,
  type WritableMemoryFixture,
  type WritableMemoryWorkspaceFilesPort,
  type WriteOutcome,
} from "./writable-memory-port.js";
