/**
 * Reading a board out of an App's projection without trusting its shape.
 *
 * Everything takes `unknown` and answers with a status as well as a value, so a
 * typo in someone's `projection.ts` renders as a sentence and never as a crash.
 * The readers know GEOMETRY only: rows, columns, occupied positions, glyphs.
 * They have no notion of pieces, sides, legality or victory — a malformed cell
 * is skipped, an out-of-range cell is skipped, and what any of it MEANS belongs
 * to the App's rule gate on the trusted/sandbox side.
 */

export type BoardTone = "neutral" | "ok" | "warn" | "error" | "info";

const TONES = new Set<string>(["neutral", "ok", "warn", "error", "info"]);

export const BOARD_LIMITS = Object.freeze({
  /** Grid dimensions beyond this are refused, not clamped: a clamped board lies. */
  maxRows: 32,
  maxCols: 32,
  /** Characters kept of a glyph / an accessible label. */
  maxGlyph: 8,
  maxLabel: 80,
  /** Cell / highlight entries examined before the rest are ignored. */
  maxEntries: 4096,
});

/** The stable spelling of one position — also the wire form inside `from`/`to`. */
export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

export interface BoardCell {
  glyph: string;
  /** Accessible name; falls back to the glyph, then to "r,c". */
  label: string;
  tone: BoardTone;
}

export type BoardStatus = "ok" | "missing" | "malformed" | "too_large";

export interface BoardReadout {
  status: BoardStatus;
  rows: number;
  cols: number;
  /** Occupied positions by `cellKey`. Every in-range position renders either way. */
  cells: ReadonlyMap<string, BoardCell>;
}

const NO_CELLS: ReadonlyMap<string, BoardCell> = new Map();

function refused(status: BoardStatus): BoardReadout {
  return { status, rows: 0, cols: 0, cells: NO_CELLS };
}

function dimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** `{r, c}` as in-range integers, or null. */
function position(entry: Record<string, unknown>, rows: number, cols: number): { r: number; c: number } | null {
  const { r, c } = entry;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= rows) return null;
  if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= cols) return null;
  return { r, c };
}

/**
 * Read `{rows, cols, cells}` leniently. Unknown fields are ignored; a bad cell
 * entry is dropped (a later duplicate wins); a bad frame is a refusal status.
 */
export function readBoard(value: unknown): BoardReadout {
  if (value === undefined) return refused("missing");
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refused("malformed");
  const frame = value as Record<string, unknown>;
  const rows = dimension(frame.rows);
  const cols = dimension(frame.cols);
  if (rows === null || cols === null) return refused("malformed");
  if (rows > BOARD_LIMITS.maxRows || cols > BOARD_LIMITS.maxCols) return refused("too_large");
  if (frame.cells !== undefined && !Array.isArray(frame.cells)) return refused("malformed");
  const cells = new Map<string, BoardCell>();
  const entries = Array.isArray(frame.cells) ? frame.cells.slice(0, BOARD_LIMITS.maxEntries) : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const at = position(record, rows, cols);
    if (!at) continue;
    const glyph = clip(record.glyph, BOARD_LIMITS.maxGlyph);
    const tone = clip(record.tone, 16);
    cells.set(cellKey(at.r, at.c), {
      glyph,
      label: clip(record.label, BOARD_LIMITS.maxLabel) || glyph || cellKey(at.r, at.c),
      tone: TONES.has(tone) ? (tone as BoardTone) : "neutral",
    });
  }
  return { status: "ok", rows, cols, cells };
}

const NO_HIGHLIGHTS: ReadonlySet<string> = new Set();

/**
 * A highlight list, read even more leniently than the board: it is an optional
 * decoration, so anything unreadable is simply no highlight.
 */
export function readHighlightSet(value: unknown, rows: number, cols: number): ReadonlySet<string> {
  if (!Array.isArray(value)) return NO_HIGHLIGHTS;
  const out = new Set<string>();
  for (const entry of value.slice(0, BOARD_LIMITS.maxEntries)) {
    if (typeof entry === "string") {
      const match = /^\s*(\d{1,4})\s*,\s*(\d{1,4})\s*$/.exec(entry);
      if (!match) continue;
      const r = Number(match[1]);
      const c = Number(match[2]);
      if (r < rows && c < cols) out.add(cellKey(r, c));
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const at = position(entry as Record<string, unknown>, rows, cols);
    if (at) out.add(cellKey(at.r, at.c));
  }
  return out;
}
