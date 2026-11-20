/**
 * `@claude-bot/agent-deck-view/harness` — a deck App with no Host.
 *
 * A separate entry so a production bundle cannot pick it up by reaching for the
 * obvious import, exactly as the sessions, workspace-files and data harnesses
 * are. Its consumers are the tests in this package and `app:preview`, which
 * renders a draft composition against it for a second-long feedback loop.
 */

export {
  DEFAULT_DECK_ACTION,
  DEFAULT_DECK_KEY,
  createMemoryDeckApp,
  type MemoryDeckApp,
  type MemoryDeckAppOptions,
} from "./memory-deck.js";
