/**
 * One document's durability: an append-only update log plus a compacted base.
 *
 * ── The property this file owes ────────────────────────────────────────────
 *
 * Convergence-plan decision 12 lowered the threat model but raised one floor:
 * *App code occasionally breaking must not cause large-scale data loss.* For a
 * collaborative document that means exactly one thing — **an update this process
 * said it accepted is on disk before it says so.** So `append()` writes a framed
 * record and `fsyncSync`s it BEFORE returning, and the store applies the update
 * to its in-memory replica only after that returns. A crash between the two
 * loses nothing: the update is in the log and is replayed on the next open.
 *
 * The opposite order is the tempting one (apply, answer, persist in the
 * background) and it is what loses a person's paragraph, because the answer is
 * what makes their editor stop holding on to it.
 *
 * ── Framing, and what a torn tail means ────────────────────────────────────
 *
 *   header:  "CRDTLOG" + version byte
 *   record:  u32 length · u32 crc32 · payload
 *
 * A crash mid-`write` can leave a partial record. On open, records are replayed
 * until one is short or fails its checksum, and the file is then TRUNCATED to
 * the last good offset. That is the standard write-ahead-log recovery and it is
 * the correct answer here: a partial record was, by construction, never
 * acknowledged, and keeping a suffix after a hole would mean replaying updates
 * around a gap.
 *
 * The checksum is not a security control — nothing here defends against someone
 * who can write to the data directory. It catches the torn write and the bad
 * disk, which is what it is for.
 *
 * ── Why compaction needs no two-phase protocol ─────────────────────────────
 *
 * This is where a CRDT is genuinely easier than the event log next door.
 * `packages/app-state` has to reconcile a crash window between its file rename
 * and its database commit, because its commits are a hash chain and replaying
 * one twice is not the same as replaying it once. A CRDT merge is idempotent and
 * commutative, so replaying the whole log on top of a NEWER base is a no-op:
 *
 *   base.new fsynced → renamed → (crash) → open replays base.new + old log
 *                                        → identical state
 *
 * So compaction is: write the new base durably, then truncate the log. A crash
 * anywhere in between costs replay time and not correctness. This is one of the
 * two places in this slice where the CRDT made the platform's job smaller rather
 * than larger, and it is worth naming because the other places are all the other
 * way round.
 */

import { crc32 } from "node:zlib";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";

const MAGIC = Buffer.from("CRDTLOG", "ascii");
const VERSION = 1;
const HEADER_BYTES = MAGIC.byteLength + 1;
const FRAME_BYTES = 8;

/** A document id is a directory name, so it is a closed grammar, not a path. */
const DOC_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isDocumentId(value: string): boolean {
  return DOC_ID.test(value);
}

export interface DocumentLogStats {
  /** Records currently in the log, i.e. updates since the last compaction. */
  readonly records: number;
  /** Bytes the log occupies, header included. */
  readonly logBytes: number;
  /** Bytes the compacted base occupies, or 0 when there is none. */
  readonly baseBytes: number;
  /** Bytes discarded from a torn tail when this log was opened. */
  readonly recoveredBytes: number;
}

/**
 * One document's on-disk state.
 *
 * Deliberately NOT a general key-value store and deliberately not shared with
 * `packages/app-state`: see this package's CLAUDE.md for why a CRDT's binary
 * updates must not be routed through that JSON event stream (design doc §15.1).
 */
export class DocumentLog {
  private readonly dir: string;
  private readonly logPath: string;
  private readonly basePath: string;
  private fd: number;
  private logBytes: number;
  private records: number;
  private readonly recoveredBytes: number;
  private closed = false;

  private constructor(dir: string, opened: OpenedLog) {
    this.dir = dir;
    this.logPath = path.join(dir, "log.bin");
    this.basePath = path.join(dir, "base.bin");
    this.fd = opened.fd;
    this.logBytes = opened.bytes;
    this.records = opened.updates.length;
    this.recoveredBytes = opened.recoveredBytes;
  }

  /**
   * Open one document's directory and read everything durably recorded in it.
   *
   * Returns the log AND the updates, because a caller that had to ask for them
   * separately could forget to, and a document opened without its history is an
   * empty document that will then be written to.
   */
  static open(root: string, docId: string): { log: DocumentLog; updates: readonly Uint8Array[] } {
    if (!isDocumentId(docId)) throw new Error(`crdt-doc: ${JSON.stringify(docId)} is not a document id`);
    const dir = path.join(root, docId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const basePath = path.join(dir, "base.bin");
    const base = existsSync(basePath) ? readBase(basePath) : null;
    const opened = openLog(path.join(dir, "log.bin"));

    const log = new DocumentLog(dir, opened);
    const updates = base ? [base, ...opened.updates] : opened.updates;
    return { log, updates };
  }

  /**
   * Record one update durably. Returns only once it is on the disk.
   *
   * The `fsyncSync` is the whole point of this method and is why the store
   * applies afterwards rather than before.
   */
  append(update: Uint8Array): void {
    this.assertOpen();
    const frame = frameOf(update);
    writeSync(this.fd, frame, 0, frame.byteLength, this.logBytes);
    fsyncSync(this.fd);
    this.logBytes += frame.byteLength;
    this.records += 1;
  }

  /**
   * Replace the log with a compacted base.
   *
   * Order is load-bearing, and the reason it is SAFE is stated in this file's
   * header: the base is made durable first, and the log is only emptied
   * afterwards, so every crash point replays to the same state.
   */
  compact(state: Uint8Array): void {
    this.assertOpen();
    const temp = `${this.basePath}.tmp`;
    const frame = frameOf(state);
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, frame);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.basePath);
    syncDir(this.dir);

    ftruncateSync(this.fd, HEADER_BYTES);
    fsyncSync(this.fd);
    this.logBytes = HEADER_BYTES;
    this.records = 0;
  }

  stats(): DocumentLogStats {
    return {
      records: this.records,
      logBytes: this.logBytes,
      baseBytes: existsSync(this.basePath) ? statSync(this.basePath).size : 0,
      recoveredBytes: this.recoveredBytes,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    this.fd = -1;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("crdt-doc: this document log is closed");
  }
}

interface OpenedLog {
  fd: number;
  bytes: number;
  updates: Uint8Array[];
  recoveredBytes: number;
}

function frameOf(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.writeUInt32BE(crc32(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)) >>> 0, 4);
  frame.set(payload, FRAME_BYTES);
  return frame;
}

/**
 * Read every intact record, and truncate whatever follows the first bad one.
 *
 * "Bad" covers a short record, a length that runs past the end of the file and a
 * checksum mismatch. All three are the same event — a write that did not
 * complete — and all three are handled the same way, because a log with a hole
 * in it is not a log.
 */
function openLog(file: string): OpenedLog {
  const existed = existsSync(file);
  const fd = openSync(file, existed ? "r+" : "w+", 0o600);
  try {
    if (!existed) {
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      MAGIC.copy(header, 0);
      header.writeUInt8(VERSION, MAGIC.byteLength);
      writeSync(fd, header, 0, header.byteLength, 0);
      fsyncSync(fd);
      return { fd, bytes: HEADER_BYTES, updates: [], recoveredBytes: 0 };
    }

    const size = statSync(file).size;
    if (size < HEADER_BYTES) {
      // A file that never got its header is a file nothing was ever
      // acknowledged into. Start it over rather than refusing to open the
      // document for ever.
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      MAGIC.copy(header, 0);
      header.writeUInt8(VERSION, MAGIC.byteLength);
      writeSync(fd, header, 0, header.byteLength, 0);
      ftruncateSync(fd, HEADER_BYTES);
      fsyncSync(fd);
      return { fd, bytes: HEADER_BYTES, updates: [], recoveredBytes: size };
    }

    const header = Buffer.allocUnsafe(HEADER_BYTES);
    readSync(fd, header, 0, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC) || header.readUInt8(MAGIC.byteLength) !== VERSION) {
      // Not ours, or a version this build does not know how to replay. Refusing
      // is the only safe answer: the alternative is overwriting somebody's data
      // because we could not read it.
      throw new Error(`crdt-doc: ${path.basename(file)} is not a v${VERSION} update log`);
    }

    const updates: Uint8Array[] = [];
    let at = HEADER_BYTES;
    for (;;) {
      if (at + FRAME_BYTES > size) break;
      const meta = Buffer.allocUnsafe(FRAME_BYTES);
      readSync(fd, meta, 0, FRAME_BYTES, at);
      const length = meta.readUInt32BE(0);
      const checksum = meta.readUInt32BE(4);
      if (length === 0 || at + FRAME_BYTES + length > size) break;
      const payload = Buffer.allocUnsafe(length);
      readSync(fd, payload, 0, length, at + FRAME_BYTES);
      if ((crc32(payload) >>> 0) !== checksum) break;
      updates.push(new Uint8Array(payload));
      at += FRAME_BYTES + length;
    }

    let recovered = 0;
    if (at !== size) {
      recovered = size - at;
      ftruncateSync(fd, at);
      fsyncSync(fd);
    }
    return { fd, bytes: at, updates, recoveredBytes: recovered };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Read the compacted base, or nothing when it is unreadable. */
function readBase(file: string): Uint8Array | null {
  const raw = readFileSync(file);
  if (raw.byteLength < FRAME_BYTES) return discard(file);
  const length = raw.readUInt32BE(0);
  const checksum = raw.readUInt32BE(4);
  if (length === 0 || FRAME_BYTES + length > raw.byteLength) return discard(file);
  const payload = raw.subarray(FRAME_BYTES, FRAME_BYTES + length);
  if ((crc32(payload) >>> 0) !== checksum) return discard(file);
  return new Uint8Array(payload);
}

/**
 * A base that does not check out is dropped, not fatal.
 *
 * It is derived data: a compaction that did not complete leaves the log intact
 * behind it, so replaying from the log alone gives the same document. This is
 * the same call `app-state` makes about a corrupt snapshot, for the same reason.
 */
function discard(file: string): null {
  rmSync(file, { force: true });
  return null;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
