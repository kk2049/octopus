/**
 * `@claude-bot/agent-crdt-view/harness` — the in-process replica port.
 *
 * A separate entry point so a production View cannot pick it up by reaching for
 * the obvious import: the package root exports what an App composes, and this
 * exports what a test, a storybook or a preview composes instead.
 */

export { createMemoryCrdtPort, type MemoryCrdtFixture, type MemoryCrdtPort } from "./memory-port.js";
