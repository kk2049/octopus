/**
 * Saving a text file larger than one call (2026-10-20).
 *
 * `replace_text` carries the whole new content as ONE argument, and every
 * layer below bounds one call: the View wire raises one parameter to 384 KiB,
 * the capability Gate refuses more than 512 KiB of encoded arguments. The 256
 * KiB `maxWriteTextBytes` was therefore the largest file anybody could save —
 * a window that had become the total.
 *
 * A staged upload keeps the window and lifts the total. The same action, the
 * same permission token, the same CAS:
 *
 *   begin  (expected_digest)          → {upload, sizeBytes: 0}
 *   append (upload, offset, text) × N → {upload, sizeBytes}
 *   commit (upload, expected_digest, size) → the ordinary mutation receipt
 *
 * The device stages the bytes in a sibling temp file and `commit` performs the
 * existing compare-and-swap — a fresh scan of the target against
 * `expected_digest` — then fsync, chmod and rename. So the two properties of a
 * one-call replace hold unchanged: a stale editor cannot clobber a newer file,
 * and the target is either the whole old file or the whole new one. Nothing a
 * staged upload does before `commit` touches the target, and an abandoned
 * upload is swept from the device when idle.
 *
 * Each step is idempotent where a retry could reach it twice: `begin` names a
 * token the trusted side minted, `append` is addressed by byte offset (a replay
 * of the last window is recognised and changes nothing), and `commit` consumes
 * the upload — a second commit finds nothing to commit.
 *
 * ── Why old bundles and old Hosts are safe ─────────────────────────────────
 *
 * Installed bundles never send `stage`, so they get exactly the replies they
 * always got. An older Host that ignores `stage` reads a `begin`/`commit` (no
 * `text`) and an `append` (no `expected_digest`) as malformed one-call replaces
 * and refuses them: no staged step can be mistaken for "replace the file with
 * this window".
 */

import {
  IssueBag,
  boundedIntAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import { WORKSPACE_FILES_LIMITS } from "./limits.js";
import { workspaceFilesRefusal, type WorkspaceFilesReply } from "./port.js";
import { utf8ByteLength } from "./projection.js";
import type { WorkspaceMutationReceipt } from "./write.js";

export const WORKSPACE_TEXT_UPLOAD_STAGES = Object.freeze(["begin", "append", "commit"] as const);
export type WorkspaceTextUploadStage = (typeof WORKSPACE_TEXT_UPLOAD_STAGES)[number];

/** An upload token: 128 random bits the trusted side minted. Compared, never parsed. */
const UPLOAD_TOKEN = /^[0-9a-f]{32}$/;

export function isWorkspaceTextUploadToken(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_TOKEN.test(value);
}

/**
 * The encoded size one window may reach, in UTF-8 bytes of its JSON string.
 *
 * A window is bounded twice because the two bounds below it measure different
 * things: the device and the wire count the text's UTF-8 bytes, while the Gate
 * counts the JSON of the whole call — where one control character becomes six
 * bytes. 384 KiB leaves the call's other arguments (a 4 KiB path among them)
 * well inside the Gate's 512 KiB.
 */
export const WORKSPACE_TEXT_WINDOW_ENCODED_BYTES = 384 * 1024;

/** What `begin` and `append` answer: which upload, and how many bytes it holds. */
export interface WorkspaceTextUpload {
  readonly upload: string;
  readonly sizeBytes: number;
}

const UPLOAD_FIELDS = ["upload", "sizeBytes"] as const;

export function readWorkspaceTextUpload(value: unknown, at = "upload"): ContractResult<WorkspaceTextUpload> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, UPLOAD_FIELDS, at);
  if (!isWorkspaceTextUploadToken(row.upload)) {
    bag.add("identifier", "upload must be a 32-hex upload token", `${at}.upload`);
  }
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, WORKSPACE_FILES_LIMITS.maxTextBytes, { min: 0 });
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { upload: row.upload as string, sizeBytes: sizeBytes! } };
}

function utf8Width(point: number): number {
  if (point <= 0x7f) return 1;
  if (point <= 0x7ff) return 2;
  if (point <= 0xffff) return 3;
  return 4;
}

/** Bytes `JSON.stringify` spends on one code point, in UTF-8. */
function jsonWidth(point: number): number {
  if (point === 0x22 || point === 0x5c) return 2;
  if (point === 0x08 || point === 0x09 || point === 0x0a || point === 0x0c || point === 0x0d) return 2;
  if (point < 0x20) return 6;
  // A lone surrogate is escaped; such text is refused as not UTF-8 anyway.
  if (point >= 0xd800 && point <= 0xdfff) return 6;
  return utf8Width(point);
}

/**
 * Cut `text` into windows that each fit one call, never splitting a character.
 *
 * Each window is at most `maxWriteTextBytes` UTF-8 bytes and at most
 * `WORKSPACE_TEXT_WINDOW_ENCODED_BYTES` once JSON-encoded. Concatenating the
 * windows gives back `text` exactly. An empty text is one empty window.
 */
export function workspaceTextWindows(
  text: string,
  maxBytes: number = WORKSPACE_FILES_LIMITS.maxWriteTextBytes,
  maxEncodedBytes: number = WORKSPACE_TEXT_WINDOW_ENCODED_BYTES,
): string[] {
  const windows: string[] = [];
  let start = 0;
  let bytes = 0;
  let encoded = 0;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const width = point > 0xffff ? 2 : 1;
    const raw = point >= 0xd800 && point <= 0xdfff ? 3 : utf8Width(point);
    const json = jsonWidth(point);
    if (index > start && (bytes + raw > maxBytes || encoded + json > maxEncodedBytes)) {
      windows.push(text.slice(start, index));
      start = index;
      bytes = 0;
      encoded = 0;
    }
    bytes += raw;
    encoded += json;
    index += width;
  }
  windows.push(text.slice(start));
  return windows;
}

/** The four calls a windowed save is made of, over whichever transport. */
export interface WorkspaceTextUploadSteps {
  /** The ordinary one-call replace, for a text that fits one window. */
  whole(text: string): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
  begin(): Promise<WorkspaceFilesReply<WorkspaceTextUpload>>;
  append(upload: string, offset: number, text: string): Promise<WorkspaceFilesReply<WorkspaceTextUpload>>;
  commit(upload: string, sizeBytes: number): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>>;
}

function mismatch<T>(): WorkspaceFilesReply<T> {
  return workspaceFilesRefusal(
    "unavailable",
    "分段保存的回执与提交的内容不一致，目标文件没有被改动；请重新保存。",
  );
}

/**
 * Append `windows` to an upload in order, checking that each answer accounts
 * for exactly the bytes sent. Answers the upload's size afterwards.
 */
export async function appendWorkspaceTextWindows(
  steps: Pick<WorkspaceTextUploadSteps, "append">,
  upload: string,
  offset: number,
  windows: readonly string[],
): Promise<WorkspaceFilesReply<number>> {
  let at = offset;
  for (const window of windows) {
    const answer = await steps.append(upload, at, window);
    if (!answer.ok) return answer;
    const next = at + utf8ByteLength(window);
    if (answer.value.upload !== upload || answer.value.sizeBytes !== next) return mismatch();
    at = next;
  }
  return { ok: true, value: at };
}

/**
 * Replace a whole text file through whichever calls it needs.
 *
 * One window is the ordinary one-call replace, byte-identical to what every
 * earlier build sent. More windows are one staged upload. There is no retry
 * anywhere: a refusal ends the save, the target is untouched, and the device
 * discards (or, if nobody is left to say so, sweeps) what was staged.
 */
export async function replaceWorkspaceTextInWindows(
  text: string,
  steps: WorkspaceTextUploadSteps,
): Promise<WorkspaceFilesReply<WorkspaceMutationReceipt>> {
  const windows = workspaceTextWindows(text);
  if (windows.length === 1) return steps.whole(text);
  const begun = await steps.begin();
  if (!begun.ok) return begun;
  if (begun.value.sizeBytes !== 0) return mismatch();
  const appended = await appendWorkspaceTextWindows(steps, begun.value.upload, 0, windows);
  if (!appended.ok) return appended;
  const committed = await steps.commit(begun.value.upload, appended.value);
  if (!committed.ok) return committed;
  if (committed.value.sizeBytes !== appended.value) return mismatch();
  return committed;
}
