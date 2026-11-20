/**
 * A second real implementation of `crdt-doc/v1`, backed by an in-process replica.
 *
 * It exists for the reason the workspace-files, sessions and notify harnesses
 * do: a claim that a consumer depends on a PORT and not on a transport is only
 * checkable if there is a second thing that satisfies the port. This one has no
 * network, no message channel and no trusted side at all — it holds a `Y.Doc`
 * and answers out of it.
 *
 * ── Why it holds a real `Y.Doc` and not a canned reply ─────────────────────
 *
 * Because the property under test is convergence, and a fixture that returned a
 * fixed update would prove that the client can decode base64. Two `NoteSession`s
 * pointed at one of these are two collaborators sharing a server, which is the
 * whole arrangement in miniature — and it is exactly the arrangement
 * `session.test.ts` uses to show that concurrent edits at the same position both
 * survive.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not validate against the declaration. That is the remote adapter's
 * job, and a memory port that duplicated it would be a second implementation of
 * the bound. It also does not persist: durability is the trusted store's
 * problem, and it has its own tests against real files.
 */

import * as Y from "yjs";
import {
  CRDT_DOC_CONTRACT,
  CRDT_SCHEMA_MAJOR,
  crdtRefusal,
  type CrdtDocAck,
  type CrdtDocDelta,
  type CrdtDocList,
  type CrdtDocPort,
  type CrdtDocRefusalCode,
  type CrdtDocReply,
  type CrdtDocSnapshot,
} from "@claude-bot/crdt-doc-contract";
import { NOTE_FIELD, decode, encode } from "../lib/session.js";

export interface MemoryCrdtFixture {
  /** Document refs this port serves. Anything else is `unknown_doc`. */
  readonly documents: readonly string[];
  /** Display titles for `listDocs`, keyed by ref. Missing = the ref itself. */
  readonly titles?: Readonly<Record<string, string>>;
  /** Starting text, for every document. */
  readonly initialText?: string;
  /** False makes every `apply_update` refuse, for a read-only consumer. */
  readonly mayEdit?: boolean;
  /** The major this port claims. Set it above `CRDT_SCHEMA_MAJOR` to test the check. */
  readonly schemaMajor?: number;
  /** Refuse a specific action, once, with this code. Checked before anything else. */
  readonly refusals?: Readonly<Record<string, { code: CrdtDocRefusalCode; message: string }>>;
}

export interface MemoryCrdtPort {
  readonly port: CrdtDocPort;
  /** What the server holds. A test asserts on this, not on a call log. */
  text(doc: string): string;
  /** Every action it was asked to serve, in order. */
  readonly calls: readonly { readonly action: string; readonly doc: string }[];
  /**
   * Edit the server-side document directly, as another collaborator would.
   *
   * The escape hatch a test needs to produce "somebody else changed it while you
   * were not looking", which is the case the Sync button exists for.
   */
  editFromElsewhere(doc: string, write: (text: Y.Text) => void): void;
  /**
   * Refuse the NEXT call of one action, mid-run.
   *
   * The constructor's `refusals` covers "the first call fails"; this covers
   * "the port was fine and then the authority changed underneath it", which is
   * what the wake cooldown tests need to produce.
   */
  refuseNext(action: string, code: CrdtDocRefusalCode, message: string): void;
}

export function createMemoryCrdtPort(fixture: MemoryCrdtFixture): MemoryCrdtPort {
  const docs = new Map<string, Y.Doc>();
  const calls: { action: string; doc: string }[] = [];
  const pending = new Map<string, { code: CrdtDocRefusalCode; message: string }>(
    Object.entries(fixture.refusals ?? {}),
  );
  const schemaMajor = fixture.schemaMajor ?? CRDT_SCHEMA_MAJOR;

  for (const ref of fixture.documents) {
    const doc = new Y.Doc();
    if (fixture.initialText) doc.getText(NOTE_FIELD).insert(0, fixture.initialText);
    docs.set(ref, doc);
  }

  function refused(action: string): { code: CrdtDocRefusalCode; message: string } | null {
    const row = pending.get(action);
    if (!row) return null;
    // Once, so a test can assert the retry succeeds — which is what "later, not
    // never" has to mean for `rate_limited` to be a useful answer.
    pending.delete(action);
    return row;
  }

  function resolve<T>(action: string, ref: string): { doc: Y.Doc } | CrdtDocReply<T> {
    calls.push({ action, doc: ref });
    const refusal = refused(action);
    if (refusal) return crdtRefusal(refusal.code, refusal.message);
    const doc = docs.get(ref);
    if (!doc) return crdtRefusal("unknown_doc", "这个文档引用不属于当前视图。");
    return { doc };
  }

  const port: CrdtDocPort = {
    contract: CRDT_DOC_CONTRACT,

    async listDocs(): Promise<CrdtDocReply<CrdtDocList>> {
      calls.push({ action: "list_docs", doc: "" });
      const refusal = refused("list_docs");
      if (refusal) return crdtRefusal(refusal.code, refusal.message);
      return {
        ok: true,
        value: {
          docs: fixture.documents.map((ref) => ({ doc: ref, title: fixture.titles?.[ref] ?? ref })),
        },
      };
    },

    async openDoc(ref: string): Promise<CrdtDocReply<CrdtDocSnapshot>> {
      const found = resolve<CrdtDocSnapshot>("open_doc", ref);
      if (!("doc" in found)) return found;
      return {
        ok: true,
        value: {
          doc: ref,
          schemaMajor,
          stateVector: encode(Y.encodeStateVector(found.doc)),
          update: encode(Y.encodeStateAsUpdate(found.doc)),
        },
      };
    },

    async applyUpdate(ref: string, update: string): Promise<CrdtDocReply<CrdtDocAck>> {
      const found = resolve<CrdtDocAck>("apply_update", ref);
      if (!("doc" in found)) return found;
      if (fixture.mayEdit === false) {
        return crdtRefusal("no_authority", "这个视图只被授予了读取协作文档，没有被授予写入。");
      }
      try {
        Y.applyUpdate(found.doc, decode(update));
      } catch {
        return crdtRefusal("bad_update", "这条 update 不是当前文档能合并的内容。");
      }
      return { ok: true, value: { doc: ref, stateVector: encode(Y.encodeStateVector(found.doc)) } };
    },

    async readUpdates(ref: string, since: string): Promise<CrdtDocReply<CrdtDocDelta>> {
      const found = resolve<CrdtDocDelta>("read_updates", ref);
      if (!("doc" in found)) return found;
      let diff: Uint8Array;
      try {
        diff = Y.encodeStateAsUpdate(found.doc, decode(since));
      } catch {
        return crdtRefusal("bad_update", "状态向量不是当前文档能理解的内容。");
      }
      const decoded = Y.decodeUpdate(diff);
      return {
        ok: true,
        value: {
          doc: ref,
          stateVector: encode(Y.encodeStateVector(found.doc)),
          update: encode(diff),
          empty: decoded.structs.length === 0 && decoded.ds.clients.size === 0,
        },
      };
    },
  };

  return {
    port,
    calls,
    text: (ref: string) => docs.get(ref)?.getText(NOTE_FIELD).toString() ?? "",
    editFromElsewhere: (ref: string, write: (text: Y.Text) => void) => {
      const doc = docs.get(ref);
      if (doc) write(doc.getText(NOTE_FIELD));
    },
    refuseNext: (action, code, message) => {
      pending.set(action, { code, message });
    },
  };
}
