/**
 * `@claude-bot/agent-sessions-view/harness` — the reuse proof, as real code.
 *
 * A separate entry point so nothing here reaches a production bundle: an App
 * imports the modules, and only a harness (or a test) imports this. What it
 * contains is a second provider and a second composition — see the two files.
 */

export { createMemorySessionsPort, type MemorySessionsFixture, type MemorySessionsPort } from "./memory-port.js";
export { READ_ONLY_COMPOSITION, ReadOnlySessionsApp, type ReadOnlySessionsProps } from "./ReadOnlySessions.js";
