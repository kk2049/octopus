/**
 * The trusted replica: one `Y.Doc` per document, and its durability.
 *
 * ── Why Yjs, and why on this side ──────────────────────────────────────────
 *
 * The design document's §12 says not to write a CRDT, and that is the right
 * call — the failure modes of a hand-rolled one (a merge that is not
 * commutative, an id allocation that collides after a reload, a delete-set that
 * loses a concurrent insert) are exactly the ones that show up months later as
 * silently corrupted documents. Yjs is the audited implementation of this
 * problem, it is dependency-free, and its update format is the interchange
 * format the ecosystem's editors already speak.
 *
 * It runs HERE, in the trusted process, because that is where the document's
 * authority is. A View also runs a copy — that is what makes editing local and
 * offline-tolerant — but the copy is a replica, not the record. Nothing about
 * that arrangement is a trust claim: an untrusted View can already write
 * whatever it likes into a document it is authorised to edit, and this store's
 * job is that the result is not LOST, not that it is wise (decision 12).
 *
 * ── The one ordering rule ──────────────────────────────────────────────────
 *
 *   validate → durably append → apply in memory → answer
 *
 * Never apply-then-persist. The answer is what makes an editor stop holding on
 * to the user's keystrokes, so anything that can be answered must already be on
 * the disk. `log.ts` owns the fsync; this file owns the order.
 *
 * ── What it does NOT do ────────────────────────────────────────────────────
 *
 * No presence, no awareness, no cursors: design doc §15.4 keeps ephemeral
 * awareness out of the persistent document, and the cheapest way to guarantee
 * that is to have nowhere to put it. No undo manager — undo belongs to the
 * editor that has the user's intent, and a server-side one would undo a
 * colleague's work. No access control: that is the provider's grant, one layer
 * up.
 */

import { mkdirSync } from "node:fs";
import * as Y from "yjs";
import { DocumentLog, isDocumentId } from "./log.js";

/** Everything a caller may learn about one document. Bytes, not base64. */
export interface DocumentState {
  /** The whole document as one update. */
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
}

export interface DocumentDiff {
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
  /** True when the caller was already up to date. */
  readonly empty: boolean;
}

/**
 * Why an operation did not happen.
 *
 * The codes are `crdt-doc/v1`'s, deliberately, so the provider translates
 * nothing: a store that invented its own vocabulary would make the mapping a
 * place where a refusal can quietly become a different refusal.
 */
export type StoreRefusal = "bad_update" | "doc_too_large" | "unavailable";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreRefusal };

export interface CrdtDocumentStoreOptions {
  /** Directory that holds one subdirectory per document. */
  root: string;
  /**
   * One document's ceiling. Past it, writes are refused rather than dropped.
   *
   * Not a transport bound — readers move a document in bounded windows
   * (`crdt-doc/v2` streams) — but a memory one: the trusted replica is a live
   * `Y.Doc` in the shared bot process, and Yjs applies an update only against
   * the whole document in memory. The default keeps one tenant's document from
   * taking the heap every other tenant shares.
   */
  maxDocumentBytes?: number;
  /** Compact once the log holds this many updates. */
  compactAfterRecords?: number;
  /** …or this many bytes, whichever comes first. */
  compactAfterBytes?: number;
  /**
   * Tell the trusted composition root that a document changed.
   *
   * The change seam ADR 0006 step 2 asks for: trusted-side to trusted-side,
   * fired once per SUCCESSFUL `applyUpdate` — after the append and the
   * in-memory apply, so a listener that reads the store sees the new state —
   * and never for a compaction, which changes no content. `origin` is the
   * opaque token the writer passed to `applyUpdate`, so a wake fan-out can
   * skip the scope that already knows (it made the edit). It carries no
   * content, which is what keeps the wake channel a hint rather than a
   * bypass.
   */
  onChanged?: (docId: string, origin?: unknown) => void;
}

interface LiveDocument {
  doc: Y.Doc;
  log: DocumentLog;
  /**
   * A conservative running estimate of the encoded size.
   *
   * Exact at open and after every compaction; between them it is the last exact
   * figure plus the bytes appended since, which over-counts because a merge is
   * usually smaller than the sum of its updates. Over-counting is the right
   * direction for a ceiling, and the alternative — re-encoding the whole
   * document on every keystroke to get an exact number — is the cost this
   * estimate exists to avoid.
   */
  estimatedBytes: number;
}

const DEFAULTS = {
  maxDocumentBytes: 64 * 1024 * 1024,
  compactAfterRecords: 64,
  compactAfterBytes: 256 * 1024,
};

export class CrdtDocumentStore {
  private readonly root: string;
  /** The ceiling a writer is refused past; a provider checks a staged upload's declared size against it up front. */
  readonly maxDocumentBytes: number;
  private readonly compactAfterRecords: number;
  private readonly compactAfterBytes: number;
  private readonly live = new Map<string, LiveDocument>();
  private readonly onChanged?: (docId: string, origin?: unknown) => void;
  private closed = false;

  constructor(options: CrdtDocumentStoreOptions) {
    this.root = options.root;
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULTS.maxDocumentBytes;
    this.compactAfterRecords = options.compactAfterRecords ?? DEFAULTS.compactAfterRecords;
    this.compactAfterBytes = options.compactAfterBytes ?? DEFAULTS.compactAfterBytes;
    this.onChanged = options.onChanged;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** The document's whole state. Opens and replays it if it is not live yet. */
  read(docId: string): StoreResult<DocumentState> {
    const entry = this.entry(docId);
    if (!entry.ok) return entry;
    const update = Y.encodeStateAsUpdate(entry.value.doc);
    return { ok: true, value: { update, stateVector: Y.encodeStateVector(entry.value.doc) } };
  }

  /**
   * Read the live replica in place: no encode, no copy.
   *
   * For a trusted caller that answers from the document's structure — one
   * directory entry, one page of a list — and must not pay O(document) per call
   * the way `read` does. `read` here must not write: a write would skip
   * validate → append → apply and vanish at the next open. So any transaction
   * on the document during `read` drops the replica (the next access replays the
   * log, which never saw that write) and the call is refused.
   */
  inspect<T>(docId: string, read: (doc: Y.Doc) => T): StoreResult<T> {
    const entry = this.entry(docId);
    if (!entry.ok) return entry;
    const live = entry.value;
    let wrote = false;
    const flag = () => {
      wrote = true;
    };
    live.doc.on("beforeTransaction", flag);
    let value: T;
    try {
      value = read(live.doc);
    } finally {
      live.doc.off("beforeTransaction", flag);
      if (wrote) {
        this.live.delete(docId);
        live.log.close();
        live.doc.destroy();
      }
    }
    return wrote ? { ok: false, code: "unavailable" } : { ok: true, value };
  }

  /** Just the state vector: what a partial upload acknowledges, without encoding the document. */
  stateVector(docId: string): StoreResult<Uint8Array> {
    const entry = this.entry(docId);
    if (!entry.ok) return entry;
    return { ok: true, value: Y.encodeStateVector(entry.value.doc) };
  }

  /**
   * Merge one update, durably.
   *
   * Structural validation happens FIRST, on the bytes, before anything is
   * written: an update that cannot be decoded must not enter the log, because
   * the log is replayed on every open and one poisoned record would make the
   * document permanently unopenable. `Y.decodeUpdate` parses without applying,
   * which is exactly the check needed — a Yjs update that decodes merges into
   * any document.
   */
  applyUpdate(docId: string, update: Uint8Array, origin?: unknown): StoreResult<DocumentState> {
    const entry = this.entry(docId);
    if (!entry.ok) return entry;
    const live = entry.value;

    if (update.byteLength === 0) return { ok: false, code: "bad_update" };
    try {
      Y.decodeUpdate(update);
    } catch {
      return { ok: false, code: "bad_update" };
    }

    if (live.estimatedBytes + update.byteLength > this.maxDocumentBytes) {
      // Refused, not truncated and not dropped. A writer that is told "no" can
      // keep its work; a writer that is told "yes" and then loses it cannot.
      return { ok: false, code: "doc_too_large" };
    }

    try {
      live.log.append(update);
    } catch {
      // The disk said no. Nothing has been applied, so the in-memory replica and
      // the log still agree — which is the invariant that makes a retry safe.
      return { ok: false, code: "unavailable" };
    }
    live.estimatedBytes += update.byteLength;

    // Only now. A crash before this line replays the update at the next open; a
    // crash after it has already recorded it.
    Y.applyUpdate(live.doc, update, REMOTE_ORIGIN);

    this.maybeCompact(live);
    // After append AND apply: a listener that turns around and reads sees the
    // state it was told about. A throwing listener must not turn a merge that
    // already happened into a refusal, so it is contained here.
    try {
      this.onChanged?.(docId, origin);
    } catch {
      /* the change is durable; a broken listener loses only its notification */
    }
    return { ok: true, value: { update, stateVector: Y.encodeStateVector(live.doc) } };
  }

  /** Everything since a state vector the caller already holds. */
  diff(docId: string, since: Uint8Array): StoreResult<DocumentDiff> {
    const entry = this.entry(docId);
    if (!entry.ok) return entry;
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(entry.value.doc, since);
    } catch {
      // A state vector that does not decode is not a smaller request, it is a
      // different message. Answering the full document instead would silently
      // send everything to a caller that asked for a delta.
      return { ok: false, code: "bad_update" };
    }
    let empty = false;
    try {
      const decoded = Y.decodeUpdate(update);
      empty = decoded.structs.length === 0 && decoded.ds.clients.size === 0;
    } catch {
      return { ok: false, code: "unavailable" };
    }
    return { ok: true, value: { update, stateVector: Y.encodeStateVector(entry.value.doc), empty } };
  }

  /** Diagnostics for a test or an operator. Never crosses the port. */
  stats(docId: string): { records: number; logBytes: number; baseBytes: number; recoveredBytes: number } | null {
    const live = this.live.get(docId);
    return live ? live.log.stats() : null;
  }

  /** Force a compaction. Exists so a test can assert the crash-safety property. */
  compact(docId: string): void {
    const live = this.live.get(docId);
    if (live) this.compactNow(live);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const live of this.live.values()) {
      live.log.close();
      live.doc.destroy();
    }
    this.live.clear();
  }

  private entry(docId: string): StoreResult<LiveDocument> {
    if (this.closed) return { ok: false, code: "unavailable" };
    const existing = this.live.get(docId);
    if (existing) return { ok: true, value: existing };
    if (!isDocumentId(docId)) return { ok: false, code: "unavailable" };

    let opened;
    try {
      opened = DocumentLog.open(this.root, docId);
    } catch {
      return { ok: false, code: "unavailable" };
    }
    const doc = new Y.Doc();
    for (const update of opened.updates) {
      try {
        Y.applyUpdate(doc, update, REMOTE_ORIGIN);
      } catch {
        // A record that passed its checksum but will not apply is a Yjs version
        // problem, not a torn write. Stopping here keeps every update BEFORE it,
        // which is strictly better than refusing to open the document at all —
        // and the refusal that follows tells somebody rather than pretending the
        // document is shorter than it is.
        opened.log.close();
        doc.destroy();
        return { ok: false, code: "unavailable" };
      }
    }
    const live: LiveDocument = {
      doc,
      log: opened.log,
      // Only a ceiling reads the estimate; without one, skip encoding the
      // whole document just to measure it.
      estimatedBytes: Y.encodeStateAsUpdate(doc).byteLength,
    };
    this.live.set(docId, live);
    return { ok: true, value: live };
  }

  private maybeCompact(live: LiveDocument): void {
    const stats = live.log.stats();
    if (stats.records < this.compactAfterRecords && stats.logBytes < this.compactAfterBytes) return;
    this.compactNow(live);
  }

  private compactNow(live: LiveDocument): void {
    const state = Y.encodeStateAsUpdate(live.doc);
    try {
      live.log.compact(state);
      // Exact again, which is the other half of why the estimate is allowed to
      // drift upwards between compactions.
      live.estimatedBytes = state.byteLength;
    } catch {
      // Compaction is an optimisation. Failing it leaves the log intact and the
      // document correct; the only cost is a longer replay next time.
    }
  }
}

/**
 * The origin every server-side apply is tagged with.
 *
 * It exists so that a future observer on this document can tell an update that
 * arrived from a client apart from one this process generated — §15.4 asks for
 * transactions with an actor/origin, and having exactly one origin today is the
 * honest version of that: there is only one kind of writer.
 */
export const REMOTE_ORIGIN = Symbol.for("crdt-doc/remote");
