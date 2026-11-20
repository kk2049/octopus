/**
 * `@claude-bot/agent-data-view/harness` — the fixture-backed port.
 *
 * A separate entry point so a production View cannot pick it up by reaching for
 * the obvious import: the package root exports what an App composes, and this
 * exports what a test, a preview or a demo composes instead.
 */

export {
  createMemoryAppDataPort,
  type MemoryAppDataFixture,
  type MemoryAppDataPort,
} from "./memory-port.js";
