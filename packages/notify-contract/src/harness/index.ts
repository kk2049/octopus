/**
 * `@claude-bot/notify-contract/harness` — a second implementation of the port.
 *
 * Separate from the package root so a production bundle cannot pick it up by
 * reaching for the obvious import. See `memory-port.ts` for why it is a harness
 * entry rather than a test fixture.
 */

export {
  createMemoryNotifyPort,
  type MemoryNotifyFixture,
  type MemoryNotifyPort,
  type MemoryNotifySend,
} from "./memory-port.js";
