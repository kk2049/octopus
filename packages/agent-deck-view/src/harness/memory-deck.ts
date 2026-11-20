/**
 * A whole deck App, in memory, in about a hundred lines.
 *
 * ── What it is evidence FOR ─────────────────────────────────────────────────
 *
 * That an App holding a deck has no deck code in it. This backend does four
 * things, and a real one on `app-runtime` would do the same four:
 *
 *   1. `readDeckCommand(params)`   — is this proposal an edit? (contract)
 *   2. `applyDeckCommand(deck, c)` — what does it produce, and what undoes it? (contract)
 *   3. append the inverse to an undo log                                    (App)
 *   4. project the new deck                                                (App)
 *
 * Steps 1 and 2 are `@claude-bot/deck-model-contract`. Steps 3 and 4 are the
 * only lines that are anybody's App. That is what "the edit vocabulary belongs
 * to the contract, not to the App" buys, and it is why a deck App can be close
 * to pure data.
 *
 * ── Why the undo log lives HERE and not in the View ─────────────────────────
 *
 * Because the inverse of `remove_slide` is a `restore_slide`, which carries a
 * whole slide and does not fit on the proposal channel. The client therefore
 * cannot hold an undo stack that works; the side that holds the deck can, and it
 * already has the slide. `undo()` below is what that looks like, and the fact
 * that it is a method rather than a command is the finding.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * Not a persistence model. A real App writes an event per accepted command to
 * its State process and re-projects; the events are exactly the commands, which
 * is the third reason the vocabulary is semantic rather than snapshot-shaped.
 * This one keeps them in an array because a test does not need a subprocess.
 */

import { createMemoryAppDataPort, type MemoryAppDataPort } from "@claude-bot/agent-data-view/harness";
import type { AppDataReply } from "@claude-bot/agent-data-view/port";
import {
  applyDeckCommand,
  emptyDeck,
  readDeck,
  readDeckCommand,
  type DeckCommand,
  type DeckDocument,
} from "@claude-bot/deck-model-contract";

export interface MemoryDeckAppOptions {
  /** The deck to start from. Anything the reader refuses throws HERE, loudly. */
  deck?: unknown;
  /** The action id this App declares for deck commands. */
  action?: string;
  /** The projection key the deck is published under. */
  key?: string;
  /** Extra projection keys, for an App that has more than a deck in it. */
  extra?: Record<string, unknown>;
  /** Refuse every command, for exercising the read-only shape. */
  readOnly?: boolean;
}

export interface MemoryDeckApp {
  port: MemoryAppDataPort["port"];
  /** Every proposal that reached this App, accepted or not. */
  readonly submissions: MemoryAppDataPort["submissions"];
  /** The deck as it stands. */
  deck(): DeckDocument;
  /** How many inverses are on the undo log. */
  undoDepth(): number;
  /** Undo the last accepted command. Answers false when there is nothing to undo. */
  undo(): boolean;
  /** Replace the deck as an external writer would, for the stale-draft case. */
  setDeck(deck: DeckDocument): void;
}

export const DEFAULT_DECK_ACTION = "deck_command";
export const DEFAULT_DECK_KEY = "deck";

export function createMemoryDeckApp(options: MemoryDeckAppOptions = {}): MemoryDeckApp {
  const action = options.action ?? DEFAULT_DECK_ACTION;
  const key = options.key ?? DEFAULT_DECK_KEY;
  let deck = start(options.deck);
  const undoLog: DeckCommand[] = [];

  const project = (): Record<string, unknown> => ({ ...(options.extra ?? {}), [key]: deck });

  const memory = createMemoryAppDataPort({
    projection: project(),
    actions: {
      [action]: (values): AppDataReply => {
        if (options.readOnly) {
          return { ok: false, code: "read_only", message: "这份 deck 是只读的。" };
        }
        // The trusted side validates with the CONTRACT's reader, not with a
        // shape it trusts the View to have assembled.
        const read = readDeckCommand(values);
        if (!read.ok) {
          const first = read.issues[0];
          return { ok: false, code: "bad_command", message: `${first?.at ?? "command"}: ${first?.message ?? "无法解析"}` };
        }
        const applied = applyDeckCommand(deck, read.value);
        if (!applied.ok) {
          const first = applied.issues[0];
          return { ok: false, code: "refused", message: first?.message ?? "这条命令不能应用" };
        }
        deck = applied.value.deck;
        undoLog.push(applied.value.inverse);
        memory.setProjection(project());
        return { ok: true, result: { op: read.value.op }, message: "" };
      },
    },
  });

  return {
    port: memory.port,
    submissions: memory.submissions,
    deck: () => deck,
    undoDepth: () => undoLog.length,
    undo() {
      const inverse = undoLog.pop();
      if (!inverse) return false;
      const applied = applyDeckCommand(deck, inverse);
      /* c8 ignore next -- an inverse of an applied command applies by construction */
      if (!applied.ok) throw new Error(`undo failed: ${JSON.stringify(applied.issues)}`);
      deck = applied.value.deck;
      memory.setProjection(project());
      return true;
    },
    setDeck(next) {
      deck = next;
      memory.setProjection(project());
    },
  };
}

function start(value: unknown): DeckDocument {
  if (value === undefined) return emptyDeck("");
  const read = readDeck(value);
  // Loud, because this is a fixture an author wrote, not untrusted input: a
  // preview that silently started from an empty deck would teach them their
  // fixture is fine.
  if (!read.ok) throw new Error(`memory deck fixture is not a deck: ${JSON.stringify(read.issues)}`);
  return read.value;
}
