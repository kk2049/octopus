/**
 * One open collaborative document, from the View's side.
 *
 * ── Why this is a plain object and not a hook ──────────────────────────────
 *
 * Because the interesting behaviour — coalescing local edits, one cycle in
 * flight at a time, applying a remote update without echoing it back — is
 * testable without a DOM, and a hook would make every one of those assertions go
 * through a render. `modules.tsx` wraps it with `useSyncExternalStore`.
 *
 * ── The synchronisation cycle, and why it is shaped like this ──────────────
 *
 *   local edit → (debounce) → push merged pending → on success → pull → apply
 *
 * **Push is debounced, not per keystroke.** One proposal per keystroke is not a
 * viable client on this platform, and the numbers say so out loud: the trusted
 * frame host fuses a channel at 100 messages per rolling 10 seconds and does not
 * refuse but CLOSES it (`PORT_WINDOW_MESSAGES` in
 * `packages/web-trust/src/frame-protocol.ts`). A person types faster than that
 * in bursts.
 *
 * **What is pushed is a diff against the server's own state vector, not a buffer
 * of local updates.** Both produce a correct merge; the sizes are not close.
 * Measured on this build, 270 typed characters are 2581 bytes as
 * `Y.mergeUpdates(oneUpdatePerKeystroke)` and 288 bytes as
 * `Y.encodeStateAsUpdate(doc, serverStateVector)` — nine times smaller, because
 * the live document has already collapsed the adjacent items that a merge of
 * separate updates has to keep apart. Keeping the server's last reported state
 * vector instead of a queue is also what makes "a refused push is not a lost
 * edit" structural: the edit lives in the replica, and nothing has to be put
 * back into a buffer on failure.
 *
 * **Pull runs on a human gesture, after every accepted push, and on a WAKE.**
 * There is no polling and no retry, deliberately: a read on this platform can
 * cost a person an approval card, so replaying a refused one turns a single
 * revocation into a stream of prompts. Since ADR 0006 the trusted parent may
 * forward a content-free wake hint over the same MessagePort; `wake()` treats
 * it as "worth asking once" while the session is clean, and as a rendered
 * "有新改动" marker — nothing more — from the first refusal until a person
 * acts. The manual Sync affordance stays, because "never receiving a wake"
 * (old Host, broken SSE, fused channel) must remain a fully working state.
 *
 * ── Origins are load-bearing ───────────────────────────────────────────────
 *
 * Every update this session applies from the trusted side is tagged `REMOTE`,
 * and the `update` listener ignores those. Without that, a pulled update would
 * be re-queued as a local change and pushed straight back — a loop that
 * terminates only because merges are idempotent, after having spent every
 * message in the window.
 */

import * as Y from "yjs";
import {
  CRDT_SCHEMA_MAJOR,
  type CrdtDocPort,
  type CrdtDocRefusalCode,
} from "@claude-bot/crdt-doc-contract";
import { diffText } from "./textdiff.js";

/** The one `Y.Text` a note lives in. Fixed, so two builds agree without asking. */
export const NOTE_FIELD = "body";

const LOCAL_ORIGIN = Symbol("crdt-note/local");
const REMOTE_ORIGIN = Symbol("crdt-note/remote");

export type NoteStatus = "idle" | "opening" | "ready" | "refused";

export interface NoteState {
  readonly status: NoteStatus;
  /** The document text, as the local replica currently has it. */
  readonly text: string;
  /** Local edits that have not been accepted by the trusted side yet. */
  readonly unsent: boolean;
  /** A push or pull is in flight. */
  readonly syncing: boolean;
  /**
   * The document is a shape this build does not fully understand.
   *
   * §15.4 requires a compatibility check before opening. A HIGHER major is shown
   * read-only rather than refused — a person who cannot safely edit a document
   * can still be shown it — and editing is disabled so this build cannot write
   * a shape it does not understand into a document somebody else's editor can.
   */
  readonly incompatible: boolean;
  /** Bounded text the trusted side wrote, when something was refused. */
  readonly message: string;
  readonly code: CrdtDocRefusalCode | "";
  /** When the last successful pull happened, for a person to read. */
  readonly syncedAt: number | null;
  /**
   * The trusted side hinted that this document changed, and this session is
   * NOT going to fetch on its own — because its last exchange was refused,
   * and ADR 0006's cooldown rule says a refusal turns automation off until a
   * person acts. The UI renders it as "有新改动", next to the manual Sync
   * affordance that is the way out.
   */
  readonly remoteHint: boolean;
}

export interface NoteSessionOptions {
  readonly port: CrdtDocPort;
  /** The opaque document ref this session was handed. */
  readonly doc: string;
  /** How long local edits coalesce before being pushed. Default 600 ms. */
  readonly debounceMs?: number;
  /** Injected so a test does not have to run a real clock. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

/** The state vector of a document nobody has written. Yjs's own empty encoding. */
const EMPTY_VECTOR: Uint8Array = Y.encodeStateVector(new Y.Doc());

const EMPTY: NoteState = Object.freeze({
  status: "idle",
  text: "",
  unsent: false,
  syncing: false,
  incompatible: false,
  message: "",
  code: "",
  syncedAt: null,
  remoteHint: false,
});

export class NoteSession {
  private readonly port: CrdtDocPort;
  private readonly ref: string;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  private readonly doc = new Y.Doc();
  private readonly text: Y.Text;
  private readonly listeners = new Set<() => void>();

  private state: NoteState = EMPTY;
  /**
   * The last state vector the trusted side reported, as bytes.
   *
   * Everything this replica has that the server does not is
   * `Y.encodeStateAsUpdate(doc, serverVector)` — the standard Yjs sync step 2.
   * It is only ever assigned from an answer, so it always names a state the
   * server really reached; a diff against it is at worst redundant and never
   * wrong.
   */
  private serverVector: Uint8Array = EMPTY_VECTOR;
  /** A local edit has happened that the server has not acknowledged. */
  private dirty = false;
  private timer: unknown = null;
  /** A cycle is running. */
  private running = false;
  /** Another cycle was asked for while one was running. */
  private again = false;
  /**
   * The promise that covers everything asked for so far — INCLUDING the
   * follow-up cycle a request made during a running one produces.
   *
   * A `sync()` that resolved when only the current cycle finished would resolve
   * with the caller's own edit still unsent, which is the shape of "I clicked
   * Sync and the spinner stopped but my paragraph is not there".
   */
  private tail: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(options: NoteSessionOptions) {
    this.port = options.port;
    this.ref = options.doc;
    this.debounceMs = options.debounceMs ?? 600;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
    this.text = this.doc.getText(NOTE_FIELD);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Only what this replica produced. A pulled update tagged REMOTE must not
      // come back around as something to send.
      if (origin !== LOCAL_ORIGIN) return;
      void update;
      this.dirty = true;
      this.patch({ unsent: true, text: this.text.toString() });
      this.schedule();
    });
  }

  getState(): NoteState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch the document. Called once when a panel mounts; never automatic. */
  async open(): Promise<void> {
    if (this.destroyed || this.state.status !== "idle") return;
    this.patch({ status: "opening", message: "", code: "" });
    const answer = await this.port.openDoc(this.ref);
    if (this.destroyed) return;
    if (!answer.ok) {
      this.patch({ status: "refused", message: answer.message, code: answer.code });
      return;
    }
    // A LOWER major would be a document produced by something this build has
    // never been, so it is refused rather than opened optimistically.
    if (answer.value.schemaMajor < CRDT_SCHEMA_MAJOR) {
      this.patch({
        status: "refused",
        code: "refused",
        message: "这份文档的结构版本比本视图更旧，无法安全打开。",
      });
      return;
    }
    this.applyRemote(answer.value.update);
    this.serverVector = decode(answer.value.stateVector);
    this.patch({
      status: "ready",
      text: this.text.toString(),
      incompatible: answer.value.schemaMajor > CRDT_SCHEMA_MAJOR,
      syncedAt: this.now(),
      message: "",
      code: "",
    });
  }

  /**
   * The whole textarea value after an edit.
   *
   * Turned back into one CRDT operation rather than a whole-document replace —
   * see `textdiff.ts` for why that distinction is the difference between merging
   * and silently winning.
   */
  setText(next: string): void {
    if (this.destroyed || this.state.status !== "ready" || this.state.incompatible) return;
    const edit = diffText(this.text.toString(), next);
    if (!edit) return;
    this.doc.transact(() => {
      if (edit.remove > 0) this.text.delete(edit.index, edit.remove);
      if (edit.insert.length > 0) this.text.insert(edit.index, edit.insert);
    }, LOCAL_ORIGIN);
  }

  /**
   * The trusted side hinted this document changed (ADR 0006).
   *
   * One rule decides everything here: a wake may trigger a fetch ONLY while
   * the session's last exchange was clean. After any refusal —
   * `approval_required` most importantly, because the fetch it would repeat
   * can mint a person an approval card — the hint is recorded and rendered,
   * and the way forward is a human gesture (the Sync button, or an edit).
   * Ten wakes after one refusal are ten renders and zero dispatches.
   */
  wake(): void {
    if (this.destroyed || this.state.status !== "ready") return;
    if (this.state.code !== "") {
      this.patch({ remoteHint: true });
      return;
    }
    void this.sync();
  }

  /** Push whatever is pending, then pull. The Sync button, and the debounce. */
  async sync(): Promise<void> {
    if (this.destroyed || this.state.status !== "ready") return;
    this.cancelTimer();
    if (this.running) {
      // One cycle at a time. A second request is remembered rather than run, so
      // two clicks cost one round trip and edits made during a cycle are not
      // stranded until the next keystroke — `drain` will loop for them, and the
      // tail promise this returns covers that loop.
      this.again = true;
      return this.tail;
    }
    this.running = true;
    this.tail = this.drain();
    return this.tail;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelTimer();
    this.listeners.clear();
    this.dirty = false;
    this.doc.destroy();
  }

  /** Run cycles until nobody has asked for another one. */
  private async drain(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again && !this.destroyed);
    } finally {
      this.running = false;
      this.again = false;
    }
  }

  private async cycle(): Promise<void> {
    this.patch({ syncing: true, message: "", code: "" });

    if (this.dirty) {
      // Everything this replica has that the server's last reported state
      // vector does not. Re-encoding from the document rather than replaying a
      // buffer of per-keystroke updates is a measured nine-fold saving on typed
      // text — see this file's header.
      const update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
      // Cleared BEFORE the await. An edit made during the round trip sets it
      // again, and the next diff — taken against the state vector the ack
      // reports — picks that edit up. There is no buffer to put back, which is
      // the class of bug this shape removes rather than fixes.
      this.dirty = false;
      const answer = await this.port.applyUpdate(this.ref, encode(update));
      if (this.destroyed) return;
      if (!answer.ok) {
        // The edit is in the replica, not in a queue, so nothing was lost.
        // Nothing here retries on its own either — `rate_limited` and
        // `approval_required` both mean "a person decides what happens next".
        this.dirty = true;
        this.patch({ syncing: false, unsent: true, message: answer.message, code: answer.code });
        return;
      }
      this.serverVector = decode(answer.value.stateVector);
      this.patch({ unsent: this.dirty });
    }

    const delta = await this.port.readUpdates(this.ref, encode(Y.encodeStateVector(this.doc)));
    if (this.destroyed) return;
    if (!delta.ok) {
      this.patch({ syncing: false, message: delta.message, code: delta.code });
      return;
    }
    if (!delta.value.empty) this.applyRemote(decode(delta.value.update));
    this.serverVector = decode(delta.value.stateVector);
    this.patch({
      syncing: false,
      text: this.text.toString(),
      syncedAt: this.now(),
      message: "",
      code: "",
      remoteHint: false,
    });
  }

  private applyRemote(update: string | Uint8Array): void {
    const bytes = typeof update === "string" ? decode(update) : update;
    try {
      Y.applyUpdate(this.doc, bytes, REMOTE_ORIGIN);
    } catch {
      // A document the trusted side accepted but this build cannot merge. Shown
      // as a refusal rather than thrown: a component must not have to catch.
      this.patch({ status: "refused", code: "bad_update", message: "这份文档的内容无法被本视图合并。" });
    }
  }

  private schedule(): void {
    if (this.destroyed || this.debounceMs <= 0) {
      if (!this.destroyed) void this.sync();
      return;
    }
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.sync();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private patch(next: Partial<NoteState>): void {
    this.state = Object.freeze({ ...this.state, ...next });
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * base64, in a bundle that has no `Buffer`.
 *
 * `btoa`/`atob` are the platform's, and they work on binary strings — so the
 * bytes are widened one at a time rather than through `String.fromCharCode(...)`
 * with a spread, which blows the argument limit on a document of any size.
 */
export function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 1) binary += String.fromCharCode(bytes[at]!);
  return btoa(binary);
}

export function decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
