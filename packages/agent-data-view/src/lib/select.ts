/**
 * Reading an App's projection without trusting its shape.
 *
 * Everything here takes `unknown` and returns something a component can render.
 * That is not defensive style for its own sake: a projection is authored by the
 * App's backend, arrives over a channel, and is the ONE input a generic module
 * has. A reader that threw would take down the panel on a typo in someone's
 * `projection.ts`; a reader that guessed would render a plausible lie.
 *
 * So each function answers with a status as well as a value, and the components
 * render the status. "This path is not in the projection" and "this path is
 * there and empty" are different sentences, and a person debugging a
 * composition needs to be told which one happened.
 *
 * ── Why a dotted path is the interface ─────────────────────────────────────
 *
 * A composition instance's `config` is flat, typed, bounded values — by design
 * (decision 7): nested config is a second schema language. So the way an
 * instance says WHICH part of the projection it renders is a path string, and
 * the way it says which fields to show is another path string pointing at a
 * list the backend already emits. Config values are never parsed as structure
 * here; they are compared, split on `.`, and used as keys.
 */

/** The tone vocabulary, shared with the SDK's presentation primitives. */
export type Tone = "neutral" | "ok" | "warn" | "error" | "info";

const TONES = new Set<string>(["neutral", "ok", "warn", "error", "info"]);

/**
 * Segments that would reach the prototype chain.
 *
 * `hasOwnProperty` below already blocks them for plain objects; this is the
 * second lock, and it also covers the array branch where an index is numeric.
 */
const UNSAFE_SEGMENT = new Set(["__proto__", "prototype", "constructor"]);
const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Resolve a dotted path against an unknown value. Never throws, never invents.
 *
 * `undefined` means "not there" and is distinguishable from a `null` the
 * projection really contains, which is why the callers below check for
 * `undefined` specifically.
 */
export function selectPath(root: unknown, path: string): unknown {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  let cursor: unknown = root;
  for (const segment of trimmed.split(".")) {
    if (!segment || UNSAFE_SEGMENT.has(segment)) return undefined;
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** A scalar rendered as text. Objects and arrays of objects are refused, not stringified. */
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      const text = displayValue(entry);
      if (text === null) return null;
      parts.push(text);
    }
    return parts.join("、");
  }
  return null;
}

// ── action menus ───────────────────────────────────────────────────────────

export interface ActionSpec {
  action: string;
  label: string;
  fields: string;
  title: string;
  submitLabel: string;
  hint: string;
  /**
   * The parameter this action wants filled from the opening context — a record
   * panel injects the record's id under this name and locks the field. "" means
   * the action asks for nothing from its context.
   */
  contextParam: string;
}

export type ActionSetStatus = "ok" | "missing" | "not_a_collection";

export interface ActionSet {
  actions: readonly ActionSpec[];
  status: ActionSetStatus;
}

/**
 * Read a projected action menu, but only after intersecting it with the action
 * ids carried by the signed composition. Presentation may change at runtime;
 * authority may not.
 */
export function readActionSpecs(value: unknown, allowed: string, limit: number): ActionSet {
  if (value === undefined) return { actions: [], status: "missing" };
  if (!Array.isArray(value)) return { actions: [], status: "not_a_collection" };
  const allow = new Set(
    allowed.split(",").map((entry) => entry.trim()).filter((entry) => ACTION_ID.test(entry)),
  );
  const cap = Math.max(0, Math.floor(limit) || 0);
  const seen = new Set<string>();
  const actions: ActionSpec[] = [];
  for (const candidate of value) {
    if (actions.length >= cap) break;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const action = typeof row.action === "string" ? row.action : "";
    const fields = typeof row.fields === "string" ? row.fields : "";
    if (!allow.has(action) || seen.has(action) || !fields.trim()) continue;
    seen.add(action);
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : action;
    actions.push({
      action,
      fields,
      label,
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : label,
      submitLabel: typeof row.submit_label === "string" && row.submit_label.trim() ? row.submit_label.trim() : "提交",
      hint: typeof row.hint === "string" ? row.hint : "",
      contextParam: typeof row.context_param === "string" ? row.context_param.trim() : "",
    });
  }
  return { actions, status: "ok" };
}

// ── notices ─────────────────────────────────────────────────────────────────

export interface ProjectedNotice {
  tone: Tone;
  text: string;
}

/**
 * A `{tone, text}` banner the projection may or may not have raised.
 *
 * `null` covers "path absent", "projection said null" and "not that shape"
 * alike, because a banner is the one reader whose absence needs no explanation:
 * a list without a warning is simply a list.
 */
export function readNotice(value: unknown): ProjectedNotice | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!text) return null;
  const tone = typeof row.tone === "string" && TONES.has(row.tone) ? (row.tone as Tone) : "info";
  return { tone, text };
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface RowKeys {
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  tone: string;
}

export interface DataRow {
  /** The value a list hands the layout as an opaque `ref`. */
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  tone: Tone;
  /** The row as the projection had it, for a detail panel to read. */
  record: Record<string, unknown> | null;
}

export type CollectionStatus = "ok" | "missing" | "not_a_collection";

export interface RowSet {
  rows: readonly DataRow[];
  /** More entries exist than the rows read so far (the caller pages for them). */
  truncated: boolean;
  /** Entries in the whole collection, read or not. */
  total: number;
  status: CollectionStatus;
}

const EMPTY_ROWS: RowSet = Object.freeze({ rows: Object.freeze([]), truncated: false, total: 0, status: "ok" });

/**
 * Normalise a collection into rows.
 *
 * Three encodings are accepted because all three are ordinary things to find in
 * a hand-written projection: an array of records, an array of scalars, and an
 * object map from id to record. This is not the canonical-encoding rule being
 * relaxed — that rule governs release ASSETS, whose bytes are an identity. A
 * projection is data the App emits at runtime, and refusing two of the three
 * obvious spellings would buy nothing and cost every author a rewrite.
 */
export function readRows(value: unknown, keys: RowKeys, limit: number): RowSet {
  if (value === undefined) return { ...EMPTY_ROWS, status: "missing" };
  if (value === null) return EMPTY_ROWS;
  const cap = Math.max(0, Math.min(Math.floor(limit) || 0, Number.MAX_SAFE_INTEGER));
  const entries: Array<[string | null, unknown]> = [];
  if (Array.isArray(value)) {
    for (const entry of value) entries.push([null, entry]);
  } else if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    }
  } else {
    return { ...EMPTY_ROWS, status: "not_a_collection" };
  }
  const rows: DataRow[] = [];
  for (const [key, entry] of entries.slice(0, cap)) {
    rows.push(rowOf(key, entry, keys, rows.length));
  }
  return { rows, truncated: entries.length > rows.length, total: entries.length, status: "ok" };
}

function rowOf(key: string | null, entry: unknown, keys: RowKeys, index: number): DataRow {
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    const id = fieldText(record, keys.id) || key || String(index);
    const title = fieldText(record, keys.title) || id;
    const tone = fieldText(record, keys.tone);
    return {
      id,
      title,
      subtitle: fieldText(record, keys.subtitle),
      badge: fieldText(record, keys.badge),
      tone: TONES.has(tone) ? (tone as Tone) : "neutral",
      record,
    };
  }
  const text = displayValue(entry) ?? "";
  const id = key ?? text ?? String(index);
  return { id: id || String(index), title: text || id || String(index), subtitle: "", badge: "", tone: "neutral", record: null };
}

function fieldText(record: Record<string, unknown>, key: string): string {
  if (!key || !Object.prototype.hasOwnProperty.call(record, key)) return "";
  return displayValue(record[key]) ?? "";
}

export type RecordStatus = "ok" | "missing" | "not_found" | "not_a_record";

export interface RecordLookup {
  record: Record<string, unknown> | null;
  status: RecordStatus;
}

/** The record `id` names inside a collection, or an honest miss. */
export function findRecord(value: unknown, idKey: string, id: string): RecordLookup {
  if (value === undefined) return { record: null, status: "missing" };
  if (value === null || typeof value !== "object") return { record: null, status: "not_a_record" };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (fieldText(record, idKey) === id) return { record, status: "ok" };
    }
    return { record: null, status: "not_found" };
  }
  const map = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    const entry = map[id];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return { record: entry as Record<string, unknown>, status: "ok" };
    }
  }
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (fieldText(record, idKey) === id) return { record, status: "ok" };
  }
  return { record: null, status: "not_found" };
}

/** A value read as a record in its own right, for a detail panel with no ref. */
export function readRecord(value: unknown): RecordLookup {
  if (value === undefined) return { record: null, status: "missing" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { record: null, status: "not_a_record" };
  }
  return { record: value as Record<string, unknown>, status: "ok" };
}

// ── facts ───────────────────────────────────────────────────────────────────

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The kv rows for one record.
 *
 * `names` is what the instance asked for, read from a projection path: either a
 * list of field names or a map from field name to label. When it is absent every
 * own scalar field is shown except the ones already spoken for by the panel's
 * heading and body, because a facts table that repeats the title is noise.
 */
export function readFacts(
  record: Record<string, unknown> | null,
  names: unknown,
  exclude: readonly string[],
  limit: number,
): Fact[] {
  if (!record) return [];
  const cap = Math.max(0, Math.floor(limit) || 0);
  const skip = new Set(exclude.filter(Boolean));
  const wanted = readLabelledNames(names);
  const out: Fact[] = [];
  const push = (key: string, label: string): void => {
    if (out.length >= cap) return;
    if (!Object.prototype.hasOwnProperty.call(record, key)) return;
    const text = displayValue(record[key]);
    if (text === null) return;
    out.push({ key, label: label || key, value: text });
  };
  if (wanted) {
    for (const [key, label] of wanted) push(key, label);
    return out;
  }
  for (const key of Object.keys(record)) {
    if (skip.has(key)) continue;
    push(key, key);
  }
  return out;
}

/** `["a","b"]` or `{a: "标签"}`; anything else means "not specified". */
function readLabelledNames(names: unknown): Array<[string, string]> | null {
  if (Array.isArray(names)) {
    const out: Array<[string, string]> = [];
    for (const entry of names) {
      if (typeof entry === "string" && entry) out.push([entry, entry]);
    }
    return out;
  }
  if (names !== null && typeof names === "object") {
    const out: Array<[string, string]> = [];
    for (const key of Object.keys(names as Record<string, unknown>)) {
      const label = (names as Record<string, unknown>)[key];
      out.push([key, typeof label === "string" ? label : key]);
    }
    return out;
  }
  return null;
}

// ── field declarations ──────────────────────────────────────────────────────

export type FieldType = "string" | "text" | "number" | "boolean";

const FIELD_TYPES = new Set<string>(["string", "text", "number", "boolean"]);

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description: string;
  /** A static candidate list. Empty means a free input. */
  options: readonly string[];
}

export type DeclarationStatus = "ok" | "missing" | "not_a_declaration" | "too_wide";

export interface FieldSet {
  fields: readonly FieldSpec[];
  status: DeclarationStatus;
}

/**
 * Read an action's parameter declaration into form fields.
 *
 * The shape is the engine probe's `params` map — `{name: {type, required, enum,
 * description}}` — because that vocabulary is already validated by a working
 * implementation and by a reviewer's habit. An array of `{name, …}` is accepted
 * too, for a backend that wants to fix the order explicitly.
 *
 * A declaration wider than the transport can carry is `too_wide` rather than
 * truncated: a form that silently dropped its last two fields would submit an
 * incomplete action and report success.
 */
export function readFieldSpecs(value: unknown, limit: number): FieldSet {
  if (value === undefined) return { fields: [], status: "missing" };
  if (value === null || typeof value !== "object") return { fields: [], status: "not_a_declaration" };
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((entry) => [nameOf(entry), entry] as [string, unknown])
    : Object.keys(value as Record<string, unknown>).map(
        (key) => [key, (value as Record<string, unknown>)[key]] as [string, unknown],
      );
  const fields: FieldSpec[] = [];
  for (const [name, spec] of entries) {
    if (!name) return { fields: [], status: "not_a_declaration" };
    const read = fieldSpecOf(name, spec);
    if (!read) return { fields: [], status: "not_a_declaration" };
    fields.push(read);
  }
  if (!fields.length) return { fields: [], status: "not_a_declaration" };
  if (fields.length > limit) return { fields: [], status: "too_wide" };
  return { fields, status: "ok" };
}

function nameOf(entry: unknown): string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "";
  const name = (entry as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

function fieldSpecOf(name: string, spec: unknown): FieldSpec | null {
  if (typeof spec === "string") {
    return FIELD_TYPES.has(spec)
      ? { name, label: name, type: spec as FieldType, required: false, description: "", options: [] }
      : null;
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return null;
  const row = spec as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : "string";
  if (!FIELD_TYPES.has(type)) return null;
  const label = typeof row.label === "string" && row.label ? row.label : name;
  const description = typeof row.description === "string" ? row.description : "";
  const options: string[] = [];
  if (Array.isArray(row.enum)) {
    for (const option of row.enum) {
      const text = typeof option === "string" ? option : typeof option === "number" ? String(option) : null;
      if (text === null) return null;
      options.push(text);
    }
  } else if (row.enum !== undefined) {
    return null;
  }
  return {
    name,
    label,
    type: type as FieldType,
    required: row.required === true,
    description,
    options,
  };
}

/** The initial value of one field, as the string the wire carries. */
export function initialFieldValue(field: FieldSpec): string {
  if (field.type === "boolean") return "false";
  if (field.options.length) return field.required ? field.options[0]! : "";
  return "";
}

// ── threads ─────────────────────────────────────────────────────────────────

export interface ThreadEntry {
  /** Stable render key: the row's own id, or `at` disambiguated by position. */
  id: string;
  by: string;
  at: string;
  text: string;
  badge: string;
  tone: Tone;
}

export interface ThreadSet {
  entries: readonly ThreadEntry[];
  /** More record entries exist than were read (the caller pages for them). */
  truncated: boolean;
  /** Record entries in the whole thread, read or not. */
  total: number;
  status: CollectionStatus;
}

/**
 * A record's activity thread: `[{by, at, text, badge?, tone?}]`, chronological.
 *
 * The shape is what a fold naturally produces when it keeps a record's history
 * next to the record — submissions, comments, status stamps. Rows that are not
 * records are skipped rather than fatal: one malformed entry must not take the
 * whole history off the screen.
 */
export function readThread(value: unknown, limit: number): ThreadSet {
  if (value === undefined) return { entries: [], truncated: false, total: 0, status: "missing" };
  if (value === null) return { entries: [], truncated: false, total: 0, status: "ok" };
  if (!Array.isArray(value)) return { entries: [], truncated: false, total: 0, status: "not_a_collection" };
  const cap = Math.max(0, Math.floor(limit) || 0);
  const entries: ThreadEntry[] = [];
  let total = 0;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    total += 1;
    if (entries.length >= cap) continue;
    const row = candidate as Record<string, unknown>;
    const at = fieldText(row, "at");
    const tone = fieldText(row, "tone");
    entries.push({
      id: fieldText(row, "id") || `${at}#${entries.length}`,
      by: fieldText(row, "by"),
      at,
      text: fieldText(row, "text"),
      badge: fieldText(row, "badge"),
      tone: TONES.has(tone) ? (tone as Tone) : "neutral",
    });
  }
  return { entries, truncated: total > entries.length, total, status: "ok" };
}

// ── sections ────────────────────────────────────────────────────────────────

export interface Section {
  key: string;
  title: string;
  body: string;
}

/**
 * Named record fields rendered as titled Markdown sections.
 *
 * `names` has the `fields` shape — `["evidence"]` or `{evidence: "证据快照"}` —
 * so a composition points one path at the projection and the record's own text
 * becomes the panel's structure. A field that is absent or not a string yields
 * no section: an empty heading over nothing is noise pretending to be layout.
 */
export function readSections(
  record: Record<string, unknown> | null,
  names: unknown,
  limit: number,
): Section[] {
  if (!record) return [];
  const wanted = readLabelledNames(names);
  if (!wanted) return [];
  const cap = Math.max(0, Math.floor(limit) || 0);
  const out: Section[] = [];
  for (const [key, title] of wanted) {
    if (out.length >= cap) break;
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const body = record[key];
    if (typeof body !== "string" || !body.trim()) continue;
    out.push({ key, title: title || key, body });
  }
  return out;
}
