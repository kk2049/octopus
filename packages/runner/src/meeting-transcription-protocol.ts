/** Fixed first-party job protocol; no executable, environment, path or model selector. */
export const MEETING_TRANSCRIPTION_PROTOCOL = "meeting-transcription-jobs/v1" as const;
/**
 * `inputBytes` is a numeric representation bound, not a policy (2026-10-20): a
 * recording travels in `chunkBytes` windows and is hashed by streaming reads,
 * so neither side holds more than one window. The advertisement keeps the old
 * `max_input_bytes` value, because Heads before that date accept only exactly
 * 64 MiB there, and states the real ceiling in `max_recording_bytes`; a new
 * Head reads the latter when present and names an older Runner's 64 MiB.
 * What MOSS can transcribe is bounded by time (`deadlineMs`, the model's
 * token budget and three recovery windows), and an uncovered tail is reported
 * as needs_review, never as complete. Artifacts stay bounded: the Head parses
 * each whole, and an 8-hour job's transcript is a few MiB.
 */
export const MEETING_TRANSCRIPTION_LIMITS = { inputBytes: Number.MAX_SAFE_INTEGER, chunkBytes: 256 * 1024,
  artifactBytes: 8 * 1024 * 1024, artifactTotalBytes: 64 * 1024 * 1024, jobs: 256, deadlineMs: 8 * 3600_000 } as const;
/** What `max_input_bytes` must say for Heads before 2026-10-20 to accept the advertisement. */
export const MEETING_TRANSCRIPTION_LEGACY_INPUT_BYTES = 64 * 1024 * 1024;
export const MEETING_TRANSCRIPTION_ARTIFACTS = ["manifest.json", "complete.json", "quality.json", "inference.json", "model-raw.txt", "segments.json", "dialogue.md", "recovery.json"] as const;
const key = { type: "string" as const, description: "Stable SHA-256 job identity allocated by the trusted owner.", maxLength: 64, pattern: /^[0-9a-f]{64}$/ };
const digest = { ...key, description: "SHA-256 of the immutable recording bytes." };
const common = { job_key: key, input_sha256: digest };
/** One declaration feeds the trusted typed-port declaration, permission table and MCP descriptors. */
export const MEETING_TRANSCRIPTION_ACTIONS = {
  begin: { summary: "Create or recover an immutable recording upload.", operation: "meeting_transcription_begin", params: { ...common,
    input_bytes: { type: "integer" as const, description: "Exact recording length.", minimum: 1, maximum: MEETING_TRANSCRIPTION_LIMITS.inputBytes },
    title: { type: "string" as const, description: "Display title; never an executable or path.", maxLength: 240 } } },
  upload: { summary: "Write or verify one consecutive recording chunk.", operation: "meeting_transcription_upload", params: { ...common,
    offset: { type: "integer" as const, description: "Exact byte offset.", minimum: 0, maximum: MEETING_TRANSCRIPTION_LIMITS.inputBytes },
    data: { type: "string" as const, description: "Canonical base64 chunk.", maxLength: Math.ceil(MEETING_TRANSCRIPTION_LIMITS.chunkBytes / 3) * 4 },
    chunk_sha256: { ...key, description: "SHA-256 of this chunk." } } },
  start: { summary: "Start the fixed MOSS pipeline once, after verifying the complete upload.", operation: "meeting_transcription_start", params: common },
  status: { summary: "Reconcile the original durable transcription job without restarting it.", operation: "meeting_transcription_status", params: common },
  read: { summary: "Read a bounded chunk of a published, immutable artifact.", operation: "meeting_transcription_read", params: { ...common,
    file: { type: "string" as const, description: "Exact artifact name from job status.", maxLength: 100 },
    offset: { type: "integer" as const, description: "Exact artifact byte offset.", minimum: 0, maximum: MEETING_TRANSCRIPTION_LIMITS.artifactBytes },
    length: { type: "integer" as const, description: "Maximum bytes returned.", minimum: 1, maximum: MEETING_TRANSCRIPTION_LIMITS.chunkBytes } } },
  cancel: { summary: "Cancel this original job; never replay its input.", operation: "meeting_transcription_cancel", params: common },
} as const;
export type MeetingTranscriptionAction = keyof typeof MEETING_TRANSCRIPTION_ACTIONS;
export const MEETING_TRANSCRIPTION_METHODS = Object.values(MEETING_TRANSCRIPTION_ACTIONS).map(row => row.operation);
export type MeetingTranscriptionState = "uploading" | "queued" | "launching" | "running" | "succeeded" | "needs_review" | "failed" | "orphaned" | "cancelled" | "timed_out";
export interface MeetingTranscriptionAdvertisement { protocol: typeof MEETING_TRANSCRIPTION_PROTOCOL; available: boolean;
  reason?: "not_configured" | "machine_ops_disabled" | "unsupported_platform" | "configuration_invalid" | "environment_unavailable";
  backend: "MOSS-Transcribe-Diarize"; concurrency: 1; max_input_bytes: number; max_chunk_bytes: number; max_recording_bytes?: number }
export interface MeetingTranscriptionArtifact { file: string; bytes: number; sha256: string }
export interface MeetingTranscriptionStatus { protocol: typeof MEETING_TRANSCRIPTION_PROTOCOL; job_key: string; input_sha256: string;
  input_bytes: number; received: number; state: MeetingTranscriptionState; created_at: string; deadline_at?: string;
  error?: string; progress?: { status: string; generated_tokens?: number; attempt?: number }; files: MeetingTranscriptionArtifact[] }
export interface MeetingTranscriptionChunk { protocol: typeof MEETING_TRANSCRIPTION_PROTOCOL; job_key: string; input_sha256: string;
  file: string; offset: number; bytes: number; total: number; data: string; eof: boolean; sha256: string }
export function meetingTranscriptionTerminal(state: MeetingTranscriptionState): boolean {
  return ["succeeded", "needs_review", "failed", "orphaned", "cancelled", "timed_out"].includes(state);
}
/** Closed parser reused on the Runner, including direct RPC calls that did not pass a Head Gate. */
export function parseMeetingTranscriptionRequest(action: MeetingTranscriptionAction, raw: unknown): Record<string, string | number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid transcription request");
  const fields = MEETING_TRANSCRIPTION_ACTIONS[action].params as Record<string, { type: string; maxLength?: number; minimum?: number; maximum?: number; pattern?: RegExp }>;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some(name => !Object.hasOwn(fields, name))) throw new Error("unknown transcription argument");
  for (const [name, field] of Object.entries(fields)) {
    const value = row[name];
    if (field.type === "string" ? typeof value !== "string" || value.length > field.maxLength! || value.includes("\0") || (field.pattern && !field.pattern.test(value))
      : typeof value !== "number" || !Number.isSafeInteger(value) || value < field.minimum! || value > field.maximum!) throw new Error(`invalid transcription ${name}`);
  }
  return row as Record<string, string | number>;
}

const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
export function readMeetingTranscriptionAdvertisement(raw: unknown): MeetingTranscriptionAdvertisement | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const reasons = ["not_configured", "machine_ops_disabled", "unsupported_platform", "configuration_invalid", "environment_unavailable"];
  if (row.protocol !== MEETING_TRANSCRIPTION_PROTOCOL || row.backend !== "MOSS-Transcribe-Diarize" || typeof row.available !== "boolean" ||
    row.concurrency !== 1 || !positive(row.max_input_bytes) || (row.max_recording_bytes !== undefined && !positive(row.max_recording_bytes)) ||
    row.max_chunk_bytes !== MEETING_TRANSCRIPTION_LIMITS.chunkBytes ||
    (row.reason !== undefined && !reasons.includes(String(row.reason))) || (!row.available && row.reason === undefined) || (row.available && row.reason !== undefined)) return undefined;
  // The device's real ceiling: `max_recording_bytes` from a current Runner, else an older Runner's 64 MiB.
  return { protocol: MEETING_TRANSCRIPTION_PROTOCOL, backend: "MOSS-Transcribe-Diarize", available: row.available, concurrency: 1,
    max_input_bytes: (row.max_recording_bytes ?? row.max_input_bytes) as number, max_chunk_bytes: MEETING_TRANSCRIPTION_LIMITS.chunkBytes,
    ...(row.reason ? { reason: row.reason as MeetingTranscriptionAdvertisement["reason"] } : {}) };
}
