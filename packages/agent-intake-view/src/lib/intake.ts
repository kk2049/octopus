export type IntakeTone = "neutral" | "ok" | "warn" | "error" | "info";
export type IntakeMode = "manager" | "submitter";
export interface IntakeHistory { at: string; title: string; detail: string; tone: IntakeTone }
export interface IntakeAttachment { name: string; type: string; size: number; data: string }
export interface IntakeRecord {
  id: string; title: string; subtitle: string; badge: string; tone: IntakeTone;
  status: string; author: string; merchant: string; amount: string; date: string; description: string;
  extracted: Record<string, string>; attachment: IntakeAttachment | null; history: readonly IntakeHistory[];
}
export interface IntakeReadout {
  status: "ok" | "missing" | "malformed" | "too_large";
  mode: IntakeMode; canSubmit: boolean; completed: readonly IntakeRecord[]; processing: readonly IntakeRecord[];
  mine: readonly IntakeRecord[]; stats: Record<string, string>;
}

const EMPTY: IntakeReadout = { status: "malformed", mode: "submitter", canSubmit: false, completed: [], processing: [], mine: [], stats: {} };
const TONES = new Set<IntakeTone>(["neutral", "ok", "warn", "error", "info"]);
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
export const INTAKE_LIMITS = Object.freeze({ records: 200, history: 100, attachmentChars: 262_144, pdfBytes: 184_320 });

export function readIntake(value: unknown): IntakeReadout {
  if (value === undefined) return { ...EMPTY, status: "missing" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const row = value as Record<string, unknown>;
  const collections = [row.completed, row.processing, row.mine];
  if (!collections.every(Array.isArray)) return EMPTY;
  if (collections.some((items) => (items as unknown[]).length > INTAKE_LIMITS.records)) return { ...EMPTY, status: "too_large" };
  return {
    status: "ok",
    mode: row.mode === "manager" ? "manager" : "submitter",
    canSubmit: row.can_submit === true,
    completed: records(row.completed as unknown[]),
    processing: records(row.processing as unknown[]),
    mine: records(row.mine as unknown[]),
    stats: stringMap(row.stats, 12),
  };
}

function records(input: unknown[]): IntakeRecord[] { return input.map(record).filter((item): item is IntakeRecord => item !== null); }
function record(value: unknown): IntakeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 80);
  if (!ID.test(id)) return null;
  const tone = text(row.tone, 16) as IntakeTone;
  const history = Array.isArray(row.history) ? row.history.slice(-INTAKE_LIMITS.history).map(historyOf).filter((item): item is IntakeHistory => item !== null) : [];
  return {
    id, title: text(row.title, 120), subtitle: text(row.subtitle, 200), badge: text(row.badge, 40),
    tone: TONES.has(tone) ? tone : "neutral", status: text(row.status, 40), author: text(row.author, 80),
    merchant: text(row.merchant, 120), amount: text(row.amount, 40), date: text(row.date, 20), description: text(row.description, 1000),
    extracted: stringMap(row.extracted, 24), attachment: attachmentOf(row.attachment), history,
  };
}
function attachmentOf(value: unknown): IntakeAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.data !== "string" || !row.data || row.data.length > INTAKE_LIMITS.attachmentChars) return null;
  const data = row.data;
  return { name: text(row.name, 160), type: text(row.type, 80), size: number(row.size), data };
}
function historyOf(value: unknown): IntakeHistory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tone = text(row.tone, 16) as IntakeTone;
  return { at: text(row.at, 80), title: text(row.title, 120), detail: text(row.detail, 500), tone: TONES.has(tone) ? tone : "neutral" };
}
function stringMap(value: unknown, limit: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, limit).map(([key, val]) => [key.slice(0, 80), text(val, 500)]));
}
function text(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
