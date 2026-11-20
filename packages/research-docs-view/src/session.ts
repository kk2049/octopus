import * as Y from "yjs";
import type { Call, DocumentState } from "@claude-bot/research-docs-contract";
export const encode = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const decode = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const REMOTE = Symbol("trusted-document");
/** One window of page bytes, the same in both directions as the `update` parameter allows. */
export const WINDOW_BYTES = 196_608;
/** Follows a windowed answer to its end; every window comes from one server snapshot. */
async function drain(call: Call, doc: string, first: DocumentState, current: () => boolean) {
  const parts = [decode(first.update)];
  let answer = first;
  while (answer.next !== null && answer.next !== undefined) {
    if (!answer.snapshot || answer.next <= (answer.offset ?? 0)) throw new Error("文档分段读取回执异常");
    answer = await call<DocumentState>("read", { doc, snapshot: answer.snapshot, offset: answer.next });
    if (!current()) return null;
    if (answer.snapshot !== first.snapshot) throw new Error("文档分段读取回执异常");
    parts.push(decode(answer.update));
  }
  const update = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { update.set(part, at); at += part.length; }
  if (first.total !== undefined && update.length !== first.total) throw new Error("文档尚未完整读取，请重试");
  return { update, vector: decode(first.vector) };
}
export interface SyncState {
  ready: boolean;
  pending: boolean;
  busy: boolean;
  error: string;
  localDurable: boolean;
}
export class DocumentSession {
  readonly doc = new Y.Doc();
  private state: SyncState = {
    ready: false,
    pending: false,
    busy: false,
    error: "",
    localDurable: true,
  };
  private readonly listeners = new Set<() => void>();
  private serverVector = new Uint8Array([0]);
  private generation = 0;
  private revision = 0;
  private confirmed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  private needsPull = false;
  private dead = false;
  constructor(
    readonly id: string,
    private readonly call: Call,
    private readonly key: string,
    private readonly storage:
      | Pick<Storage, "getItem" | "setItem" | "removeItem">
      | undefined = typeof localStorage === "undefined"
      ? undefined
      : localStorage,
  ) {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? "null");
      if (value?.update && value?.vector) {
        Y.applyUpdate(this.doc, decode(value.update), REMOTE);
        this.serverVector = decode(value.vector);
        this.revision = value.pending ? 1 : 0;
      }
    } catch {
      /* A corrupt private cache never replaces the trusted document. */
    }
    this.doc.on("update", this.changed);
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(p: Partial<SyncState>) {
    if (this.dead) return;
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
  private changed = (_update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || this.dead) return;
    this.revision++;
    this.set({ pending: true });
    clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => this.checkpoint(), 60);
    if (!this.state.error) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.sync(), 400);
    }
  };
  checkpoint = () => {
    if (!this.storage) return;
    try {
      if (this.revision !== this.confirmed)
        this.storage.setItem(
          this.key,
          JSON.stringify({
            update: encode(Y.encodeStateAsUpdate(this.doc)),
            vector: encode(this.serverVector),
            pending: true,
          }),
        );
      else this.storage.removeItem(this.key);
      this.set({ localDurable: true });
    } catch {
      this.set({ localDurable: false });
    }
  };
  async open() {
    if (this.state.ready || this.state.busy || this.dead) return;
    await this.sync(true);
  }
  wake() {
    if (!this.state.ready || this.state.error || this.dead) return;
    if (this.state.busy) {
      this.needsPull = true;
      return;
    }
    void this.sync();
  }
  async retry() {
    this.set({ error: "" });
    await this.sync(!this.state.ready);
  }
  async sync(open = false) {
    if (this.dead || this.state.busy || this.state.error) return;
    const generation = this.generation,
      revision = this.revision;
    this.set({ busy: true });
    this.needsPull = false;
    try {
      const live = () => !this.dead && generation === this.generation;
      // Read first on open, so an unauthorized client never mounts its private draft.
      // Every read and push is windowed, so a page of any size opens and saves.
      if (open) {
        const first = await this.call<DocumentState>("read", { doc: this.id, offset: 0 });
        if (!live()) return;
        const remote = await drain(this.call, this.id, first, live);
        if (!remote) return;
        Y.applyUpdate(this.doc, remote.update, REMOTE);
        this.serverVector = remote.vector;
        this.set({ ready: true });
      }
      if (this.revision !== this.confirmed) {
        const sent = this.revision,
          vector = encode(Y.encodeStateVector(this.doc)),
          update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
        let answer: DocumentState | undefined;
        for (let offset = 0; offset < update.length; offset += WINDOW_BYTES) {
          answer = await this.call<DocumentState>("update", {
            doc: this.id,
            update: encode(update.subarray(offset, offset + WINDOW_BYTES)),
            vector,
            offset,
            total: update.length,
          });
          if (!live()) return;
        }
        const result = answer && (await drain(this.call, this.id, answer, live));
        if (!result) return;
        Y.applyUpdate(this.doc, result.update, REMOTE);
        this.serverVector = result.vector;
        this.confirmed = sent;
      } else if (!open) {
        const first = await this.call<DocumentState>("read", {
          doc: this.id,
          vector: encode(Y.encodeStateVector(this.doc)),
          offset: 0,
        });
        if (!live()) return;
        const result = await drain(this.call, this.id, first, live);
        if (!result) return;
        Y.applyUpdate(this.doc, result.update, REMOTE);
        this.serverVector = result.vector;
      }
      this.set({ pending: this.revision !== this.confirmed });
      this.checkpoint();
    } catch (e) {
      if (!this.dead && generation === this.generation) {
        this.set({
          error: e instanceof Error ? e.message : String(e),
          pending: this.revision !== this.confirmed,
        });
        this.checkpoint();
      }
    } finally {
      if (!this.dead && generation === this.generation) {
        this.set({ busy: false });
        if (
          !this.state.error &&
          (this.needsPull ||
            (this.revision !== this.confirmed && this.revision !== revision))
        ) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.sync(), 120);
        }
      }
    }
  }
  destroy() {
    if (this.dead) return;
    this.checkpoint();
    this.dead = true;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.dirtyTimer);
    this.doc.off("update", this.changed);
    this.doc.destroy();
    this.listeners.clear();
  }
}
