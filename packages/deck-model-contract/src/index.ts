/**
 * `@claude-bot/deck-model-contract` — a deck as pure data, and one way out of it.
 *
 * ── The whole surface ───────────────────────────────────────────────────────
 *
 *   model.ts     the closed layout vocabulary, the bounds, the types
 *   read.ts      the strict reader and the one canonical encoding
 *   commands.ts  the semantic edit vocabulary, its inverses, and the wire form
 *   typst.ts     deck → Typst source, one direction, no compiler
 *
 * ── What is absent, and could not be added without changing what this is ────
 *
 * No owner, no App id, no instance handle, no capability, no grant, no context,
 * no path, no URL, no fetch, no file system, no process. This package can be
 * imported by a Node release builder, by a trusted App backend and by an
 * untrusted browser bundle, and none of them learns anything about the others.
 * Its only dependency is the refusal machinery two other contracts already share.
 *
 * There is also no `typstToDeck`, no PDF, no compile, no preview cache and no
 * second editable representation. §15.5 named "both documents are editable" as
 * a forbidden shape; the way to keep a shape out of a codebase is to not build
 * the function that would need it.
 */

export {
  DECK_ID_PATTERN,
  DECK_LAYOUTS,
  DECK_LIMITS,
  DECK_LIST_FIELDS,
  DECK_MODEL_SCHEMA,
  DECK_REF_PATTERN,
  DECK_TEXT_FIELDS,
  DECK_THEMES,
  emptyDeck,
  emptySlide,
  findSlide,
  isDeckId,
  isDeckLayout,
  isDeckListField,
  isDeckRef,
  isDeckTextField,
  isDeckTheme,
  slideIndexOf,
  type DeckBulletsSlide,
  type DeckDocument,
  type DeckImageRef,
  type DeckImageSlide,
  type DeckLayout,
  type DeckSlide,
  type DeckTheme,
  type DeckTitleSlide,
  type DeckTwoColumnSlide,
} from "./model.js";

export { encodeDeck, parseDeck, readDeck, readDeckSlide } from "./read.js";

export {
  DECK_COMMAND_OPS,
  DECK_WIRE_KEYS,
  applyDeckCommand,
  deckRefProblem,
  encodeDeckCommand,
  readDeckCommand,
  type DeckCommand,
  type DeckCommandOp,
  type DeckEdit,
  type InsertItemCommand,
  type InsertSlideCommand,
  type MoveSlideCommand,
  type RemoveItemCommand,
  type RemoveSlideCommand,
  type RestoreSlideCommand,
  type SetDeckTitleCommand,
  type SetTextCommand,
  type SetThemeCommand,
  type WireDeckCommand,
} from "./commands.js";

export {
  DECK_THEME_COLOURS,
  TYPST_STRING_ESCAPES,
  TYPST_SUPPORTED_LAYOUTS,
  deckToTypst,
  escapeTypstString,
  typstString,
  type DeckTypstOptions,
} from "./typst.js";

export type { ContractIssue, ContractIssueCode, ContractResult } from "@claude-bot/resource-stream-contract";
