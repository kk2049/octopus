import { skillByName } from "./skills.js";

const MAX_TEXT = 512;
const MAX_SLIDES = 40;
const MAX_ITEMS = 16;

export function load_skill(ctx: any, params: any) {
  const name = text(params?.name, 32);
  const instructions = skillByName(name);
  if (!instructions) throw new Error("unknown presentation skill");
  return {
    events: [event(ctx, "skill_loaded", { name })],
    result: { name, instructions },
  };
}

/** Replace the whole fact-source deck after strict, bounded validation. */
export function replace_deck(ctx: any, params: any) {
  const source = text(params?.deck_json, 4096);
  let value: any;
  try { value = JSON.parse(source); } catch { throw new Error("deck_json is not JSON"); }
  const deck = readDeck(value);
  return { events: [event(ctx, "deck_changed", { deck })], result: { slides: deck.slides.length } };
}

/** One semantic deck-model/v1 edit, shared by the human canvas and the agent. */
export function deck_command(ctx: any, params: any) {
  const deck = readDeck(ctx?.state?.deck);
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
  const id = slideId(params?.slide);
  const slides = deck.slides.slice();
  const at = slides.findIndex((slide: any) => slide.id === id);
  if (op === "insert_slide") {
    if (at >= 0) throw new Error("slide already exists");
    if (slides.length >= MAX_SLIDES) throw new Error("too many slides");
    slides.splice(index(params?.index, slides.length), 0, emptySlide(id, text(params?.layout, 32)));
    return { ...deck, slides };
  }
  if (at < 0) throw new Error("slide does not exist");
  if (op === "remove_slide") { slides.splice(at, 1); return { ...deck, slides }; }
  if (op === "move_slide") {
    slides.splice(index(params?.index, slides.length - 1), 0, slides.splice(at, 1)[0]);
    return { ...deck, slides };
  }
  slides[at] = editSlide(slides[at], op, params);
  return { ...deck, slides };
}

function editSlide(slide: any, op: string, params: any): any {
  const field = text(params?.field, 40);
  const items = listField(slide, field);
  if (items === null) {
    if (op !== "set_text") throw new Error("field is not a list");
    return withScalar(slide, field, text(params?.value, MAX_TEXT));
  }
  const next = items.slice();
  if (op === "remove_item") next.splice(index(params?.index, next.length - 1), 1);
  else if (op === "insert_item") {
    if (next.length >= MAX_ITEMS) throw new Error("too many list items");
    next.splice(index(params?.index, next.length), 0, text(params?.value, MAX_TEXT));
  } else if (op === "set_text") next[index(params?.index, next.length - 1)] = text(params?.value, MAX_TEXT);
  else throw new Error("unknown deck op");
  if (field === "bullets") return { ...slide, bullets: next };
  return field === "left" ? { ...slide, left: next } : { ...slide, right: next };
}

function readDeck(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deck must be an object");
  if (value.schema !== "deck-model/v1") throw new Error("deck has the wrong schema");
  const theme = text(value.theme, 8);
  if (theme !== "light" && theme !== "dark") throw new Error("deck theme must be light or dark");
  if (!Array.isArray(value.slides) || value.slides.length > MAX_SLIDES) throw new Error("deck has too many slides");
  const seen = new Set<string>();
  const slides = value.slides.map((slide: any) => {
    const parsed = readSlide(slide);
    if (seen.has(parsed.id)) throw new Error("duplicate slide id");
    seen.add(parsed.id);
    return parsed;
  });
  return { schema: "deck-model/v1", title: text(value.title, MAX_TEXT), theme, slides };
}

function readSlide(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("slide must be an object");
  const id = slideId(value.id);
  const layout = text(value.layout, 32);
  const title = text(value.title, MAX_TEXT);
  if (layout === "title") return { id, layout, title, subtitle: text(value.subtitle, MAX_TEXT) };
  if (layout === "bullets") return { id, layout, title, bullets: textList(value.bullets) };
  if (layout === "two-column") return { id, layout, title, left: textList(value.left), right: textList(value.right) };
  if (layout === "image-ref") {
    return {
      id, layout, title,
      image: { ref: text(value.image?.ref, MAX_TEXT), alt: text(value.image?.alt, MAX_TEXT) },
      caption: text(value.caption, MAX_TEXT),
    };
  }
  throw new Error("unknown slide layout");
}

function textList(value: any): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error("invalid slide list");
  return value.map((item) => text(item, MAX_TEXT));
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
  if (slide.layout === "image-ref" && field === "image.ref") return { ...slide, image: { ...slide.image, ref: value } };
  if (slide.layout === "image-ref" && field === "image.alt") return { ...slide, image: { ...slide.image, alt: value } };
  throw new Error("slide has no such field");
}

function emptySlide(id: string, layout: string): any {
  if (layout === "title") return { id, layout, title: "", subtitle: "" };
  if (layout === "bullets") return { id, layout, title: "", bullets: [] };
  if (layout === "two-column") return { id, layout, title: "", left: [], right: [] };
  if (layout === "image-ref") return { id, layout, title: "", image: { ref: "", alt: "" }, caption: "" };
  throw new Error("unknown slide layout");
}

function slideId(value: any): string {
  const id = text(value, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error("invalid slide id");
  return id;
}

function text(value: any, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new Error("invalid text");
  return value;
}

function index(value: any, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(text(value, 4), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error("index is out of range");
  return parsed;
}

function event(ctx: any, type: string, data: any) {
  return { type, data, at: String(ctx?.now ?? ""), by: "ppt-studio" };
}
