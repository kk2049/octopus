/**
 * 模块演示's two action handlers.
 *
 * ── The rules this file lives under ─────────────────────────────────────────
 *
 * It is loaded into a SES Compartment by the App Runtime child. There is no
 * `fetch`, no `process`, no `require` and no `node:*` — not filtered, ABSENT —
 * and therefore **no imports at all**, not even from this repository. A handler
 * is a pure function of `(ctx, params)` that returns events; durable state lives
 * outside this process and arrives as `ctx.state`, which is the projection
 * `projection.ts` produced from the log so far.
 *
 * Because there are no imports, the deck edit below is a hand-written subset of
 * `deck-model/v1`'s command vocabulary rather than a call into
 * `@claude-bot/deck-model-contract`. That duplication is real and worth naming:
 * the contract is still the authority the VIEW encodes with and the reader
 * validates against, and `projection.ts` emits documents in the shape its reader
 * accepts. What this file must not do is accept something the reader would
 * refuse — a deck nobody can read is a deck nobody can edit back.
 *
 * ── Why an edit emits the whole deck ────────────────────────────────────────
 *
 * `deck_changed` carries the new document rather than the command. A command log
 * would be the better design in a real App (smaller events, real inverses,
 * interleaved writers stay separable — `commands.ts` argues it at length), and
 * it needs a replay in `projection.ts` to go with it. A showcase's job is to
 * demonstrate the module layer, so the backend takes the simple correct option
 * and says so: one event, one whole deck, bounded at 200 slides and 512
 * characters per field so a bad write cannot grow without limit.
 *
 * ── What a refusal is ───────────────────────────────────────────────────────
 *
 * A throw. The trusted coordinator turns any handler failure into one stable
 * classification (`action_rejected`) and never forwards this text, so these
 * messages are for a developer reading a log, not for a reader.
 */

const MAX_TEXT = 512;
const MAX_SLIDES = 200;
const MAX_ITEMS = 16;

/** A note the person wrote. `state` picks which list it lands in. */
export function add_note(ctx: any, params: any) {
  const title = text(params?.title, 200);
  if (!title.trim()) throw new Error("add_note requires a non-empty title");
  const state = text(params?.state, 32) || "草稿";
  if (state !== "草稿" && state !== "待办" && state !== "已归档") {
    throw new Error("add_note state must be one of 草稿/待办/已归档");
  }
  return {
    events: [event(ctx, "note_added", {
      // Derived from what already exists rather than random, so a retry of a
      // request that already landed proposes the SAME id and folds into one
      // note instead of two.
      id: nextNoteId(ctx?.state?.byId),
      title,
      body: text(params?.body, 4000),
      state,
    })],
    result: { title },
  };
}

/** One `deck-model/v1` edit, applied to the deck this App owns. */
export function deck_command(ctx: any, params: any) {
  const deck = currentDeck(ctx?.state?.deck);
  const op = text(params?.op, 32);
  return { events: [event(ctx, "deck_changed", { deck: applyOp(deck, op, params) })], result: { op } };
}

function applyOp(deck: any, op: string, params: any): any {
  if (op === "set_deck_title") return { ...deck, title: text(params?.value, MAX_TEXT) };
  if (op === "set_theme") {
    const theme = text(params?.value, 8);
    if (theme !== "light" && theme !== "dark") throw new Error("deck theme must be light or dark");
    return { ...deck, theme };
  }
  const id = text(params?.slide, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error("slide id is not well formed");
  const slides = deck.slides.slice();
  const at = slides.findIndex((slide: any) => slide.id === id);
  if (op === "insert_slide") {
    if (at >= 0) throw new Error("slide " + id + " already exists");
    if (slides.length >= MAX_SLIDES) throw new Error("a deck holds at most " + MAX_SLIDES + " slides");
    const where = bounded(params?.index, slides.length);
    slides.splice(where, 0, emptySlide(id, text(params?.layout, 32)));
    return { ...deck, slides };
  }
  if (at < 0) throw new Error("no slide " + id);
  if (op === "remove_slide") {
    slides.splice(at, 1);
    return { ...deck, slides };
  }
  if (op === "move_slide") {
    const to = bounded(params?.index, slides.length - 1);
    slides.splice(to, 0, slides.splice(at, 1)[0]);
    return { ...deck, slides };
  }
  slides[at] = editSlide(slides[at], op, params);
  return { ...deck, slides };
}

/** `set_text`, `insert_item` and `remove_item` — the three that address a field. */
function editSlide(slide: any, op: string, params: any): any {
  const field = text(params?.field, 40);
  const items = listField(slide, field);
  if (items === null) {
    if (op !== "set_text") throw new Error(field + " is not a list on a " + slide.layout + " slide");
    return withScalar(slide, field, text(params?.value, MAX_TEXT));
  }
  const next = items.slice();
  if (op === "remove_item") next.splice(bounded(params?.index, next.length - 1), 1);
  else if (op === "insert_item") {
    if (next.length >= MAX_ITEMS) throw new Error(field + " already holds " + MAX_ITEMS + " items");
    next.splice(bounded(params?.index, next.length), 0, text(params?.value, MAX_TEXT));
  } else if (op === "set_text") next[bounded(params?.index, next.length - 1)] = text(params?.value, MAX_TEXT);
  else throw new Error("unknown deck op " + op);
  if (field === "bullets") return { ...slide, bullets: next };
  return field === "left" ? { ...slide, left: next } : { ...slide, right: next };
}

function listField(slide: any, field: string): string[] | null {
  if (slide.layout === "bullets" && field === "bullets") return slide.bullets;
  if (slide.layout === "two-column" && (field === "left" || field === "right")) return slide[field];
  return null;
}

function withScalar(slide: any, field: string, value: string): any {
  if (field === "title") return { ...slide, title: value };
  if (slide.layout === "title" && field === "subtitle") return { ...slide, subtitle: value };
  if (slide.layout === "image-ref" && field === "caption") return { ...slide, caption: value };
  if (slide.layout === "image-ref" && field === "image.ref") {
    return { ...slide, image: { ref: value, alt: slide.image.alt } };
  }
  if (slide.layout === "image-ref" && field === "image.alt") {
    return { ...slide, image: { ref: slide.image.ref, alt: value } };
  }
  throw new Error("a " + slide.layout + " slide has no field " + field);
}

/** Empty rather than sample text: a new slide with words in it reaches a projector. */
function emptySlide(id: string, layout: string): any {
  if (layout === "title") return { id, layout, title: "", subtitle: "" };
  if (layout === "bullets") return { id, layout, title: "", bullets: [] };
  if (layout === "two-column") return { id, layout, title: "", left: [], right: [] };
  if (layout === "image-ref") return { id, layout, title: "", image: { ref: "", alt: "" }, caption: "" };
  throw new Error("unknown slide layout " + layout);
}

function currentDeck(deck: any): any {
  if (!deck || typeof deck !== "object" || !Array.isArray(deck.slides)) {
    throw new Error("this App's projection carries no deck to edit");
  }
  return deck;
}

function text(value: any, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("this action takes strings");
  if (value.length > max) throw new Error("a value is longer than " + max + " characters");
  return value;
}

/** A decimal wire index inside `0..max`. Anything else is a refusal, not a clamp. */
function bounded(value: any, max: number): number {
  const at = typeof value === "number" ? value : Number.parseInt(text(value, 4), 10);
  if (!Number.isInteger(at) || at < 0 || at > max) throw new Error("index " + String(value) + " is out of range");
  return at;
}

function nextNoteId(byId: any): string {
  const taken = byId && typeof byId === "object" ? byId : {};
  for (let n = 1; n <= MAX_SLIDES; n += 1) if (!(("n" + n) in taken)) return "n" + n;
  throw new Error("this demo holds at most " + MAX_SLIDES + " notes");
}

/** `at` and `by` are proposals; the trusted coordinator overwrites both. */
function event(ctx: any, type: string, data: any) {
  return { type, data, at: String(ctx?.now ?? ""), by: "showcase" };
}
