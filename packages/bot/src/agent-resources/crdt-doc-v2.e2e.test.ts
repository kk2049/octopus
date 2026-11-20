/**
 * `crdt-doc/v2` end to end: the App's remote adapter → a transport that applies
 * the coordinator's per-parameter wire bounds → catalog → v2 provider → Yjs
 * replica → fsynced log, and back.
 *
 * The point of this file is the removed ceilings. Every document here is larger
 * than v1 could open (48 KiB in one answer) and the large ones are larger than
 * the store's old 1 MiB cap; every push past one window travels as parts. Yet
 * no single message — proposal or answer — exceeds one window.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CRDT_DOC_CONTRACT,
  CRDT_DOC_CONTRACT_V2,
  CRDT_DOC_LIMITS,
  CRDT_DOC_V2_LIMITS,
  createRemoteCrdtDocPortV2,
  type RemoteCrdtDoc,
} from "@claude-bot/crdt-doc-contract";
import type { ProposalAnswer } from "@claude-bot/typed-port-kit";
import { AgentResourceCatalog } from "./catalog.js";
import { CRDT_PROPOSAL_ACTIONS_V2, crdtDocProviderV2 } from "./crdt-doc-provider.js";
import { RESOURCE_PARAM_DEFAULT_MAX, resourceParamLimits } from "./wire-limits.js";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import type { CrdtDocScopeAuthority, CrdtScopeGrant } from "../crdt-doc/types.js";

const PLAN = {
  schema: "agent-resource-bindings/v1" as const,
  app: "notes",
  bindings: [{ binding: "documents", contract: CRDT_DOC_CONTRACT_V2, port: CRDT_DOC_CONTRACT_V2 }],
  connections: [],
};

const dirs: string[] = [];
const stores: CrdtDocumentStore[] = [];
afterEach(() => {
  for (const made of stores.splice(0)) made.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeIn(dir: string): CrdtDocumentStore {
  const made = new CrdtDocumentStore({ root: dir });
  stores.push(made);
  return made;
}

function authority(options: { editCard?: boolean } = {}): CrdtDocScopeAuthority {
  return {
    async request(operation) {
      if (operation === "edit_document" && options.editCard) return { status: "approval_required", pendingCallId: "pc_1" };
      return { status: "succeeded", result: { granted: true } };
    },
    result: () => ({ state: "pending", outcome: null }),
    alive: () => true,
  };
}

interface Wire {
  /** Largest single parameter value and largest single answer that crossed. */
  maxParam: number;
  maxAnswer: number;
  actions: string[];
}

/**
 * One catalog serving one store, and a way to open instances on it. Each
 * instance gets the App's real v2 adapter over a transport that enforces the
 * coordinator's per-parameter bounds exactly as `session-plus/app-service.ts`
 * does (`resourceParamLimits`), so a part the wire could not carry fails here.
 */
function world(options: { editCard?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "crdt-v2-e2e-"));
  dirs.push(dir);
  const store = storeIn(dir);
  const refs: string[] = [];
  const catalog = new AgentResourceCatalog();
  catalog.register(crdtDocProviderV2({
    openGrant: (): CrdtScopeGrant => ({
      documents: [{ id: "notes", label: "Notes" }],
      mayEdit: true,
      store,
      authority: authority(options),
      close: () => undefined,
    }),
    onScopeOpened: (_context, minted) => {
      refs.push([...minted.keys()][0]!);
    },
    limit: { updates: 1000, windowMs: 60_000 },
  }));
  catalog.seal();

  const open = (instance: string) => {
    const handle = catalog.openInstance({
      owner: "alice",
      publisher: "octopus:first-party",
      app: "notes",
      packageDigest: "a".repeat(64),
      permissionContractDigest: "b".repeat(32),
      instance,
      plan: PLAN as never,
    });
    const wire: Wire = { maxParam: 0, maxAnswer: 0, actions: [] };
    const propose = async (action: string, params: Record<string, string> = {}): Promise<ProposalAnswer> => {
      const limits = resourceParamLimits(CRDT_DOC_CONTRACT_V2, action);
      for (const [key, value] of Object.entries(params)) {
        wire.maxParam = Math.max(wire.maxParam, value.length);
        const limit = limits?.get(key) ?? RESOURCE_PARAM_DEFAULT_MAX;
        if (value.length > limit) return { ok: false, code: "invalid_request", message: `${key} over ${limit}` };
      }
      wire.actions.push(action);
      const answer = await handle.dispatch({ action, params }) as { ok: boolean; code?: string; result?: unknown; message?: string };
      wire.maxAnswer = Math.max(wire.maxAnswer, JSON.stringify(answer).length);
      return answer.ok
        ? { ok: true, result: answer.result, message: "" }
        : { ok: false, code: answer.code, result: null, message: answer.message ?? "" };
    };
    const remote: RemoteCrdtDoc = createRemoteCrdtDocPortV2({ propose }, "documents");
    // A raw proposal as the adapter would send it: the binding is the kit's.
    const raw = (action: string, params: Record<string, string>) => propose(action, { binding: "documents", ...params });
    return { handle, port: remote.port, wire, raw };
  };
  return { dir, store, open, ref: () => refs[0]!, refOf: (index: number) => refs[index]! };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** Text Yjs cannot shrink: one big paste is one item of this many UTF-8 bytes. */
function paste(length: number, seed: number): string {
  let out = "";
  let state = seed;
  while (out.length < length) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    out += state.toString(36);
  }
  return out.slice(0, length);
}

/** The one window both directions are cut to, as characters on the wire. */
const WINDOW = CRDT_DOC_V2_LIMITS.maxPartEncodedLength;

describe("crdt-doc/v2: a document of any size, in bounded windows", () => {
  it("pushes, opens and follows a document past every old ceiling", async () => {
    const w = world();
    const writer = w.open("writer");
    // Scope opens lazily; the first list mints this instance's ref.
    expect((await writer.port.listDocs()).ok).toBe(true);
    const writerRef = w.refOf(0);

    // A 1.5 MB paste into an empty document: v1 refused anything over 48 KiB
    // per push, and its store refused the document past 1 MiB.
    const local = new Y.Doc();
    const text = local.getText("body");
    const first = paste(1_500_000, 7);
    text.insert(0, first);
    const update = b64(Y.encodeStateAsUpdate(local));
    expect(update.length).toBeGreaterThan(7 * WINDOW);
    const ack = await writer.port.applyUpdate(writerRef, update);
    expect(ack).toMatchObject({ ok: true, value: { doc: writerRef } });
    const parts = writer.wire.actions.filter((action) => action === "resource.apply_update").length;
    expect(parts).toBe(Math.ceil(update.length / WINDOW));
    expect(writer.wire.maxParam).toBeLessThanOrEqual(WINDOW);

    // A second instance opens it from nothing: streamed, chunk by chunk.
    const reader = w.open("reader");
    expect((await reader.port.listDocs()).ok).toBe(true);
    const readerRef = w.refOf(1);
    const opened = await reader.port.openDoc(readerRef);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const replica = new Y.Doc();
    Y.applyUpdate(replica, bytes(opened.value.update));
    expect(replica.getText("body").toString()).toBe(first);
    expect(reader.wire.actions.filter((action) => action === "resource.stream_pull").length).toBeGreaterThan(8);
    // No single answer was larger than one chunk plus its envelope.
    expect(reader.wire.maxAnswer).toBeLessThan(WINDOW + 1024);

    // The writer appends 400 KB more; the reader follows with one streamed diff.
    const second = paste(400_000, 11);
    const before = Y.encodeStateVector(local);
    text.insert(text.length, second);
    expect((await writer.port.applyUpdate(writerRef, b64(Y.encodeStateAsUpdate(local, before)))).ok).toBe(true);
    const delta = await reader.port.readUpdates(readerRef, b64(Y.encodeStateVector(replica)));
    expect(delta).toMatchObject({ ok: true, value: { empty: false } });
    if (!delta.ok) return;
    Y.applyUpdate(replica, bytes(delta.value.update));
    expect(replica.getText("body").toString()).toBe(first + second);

    // …and the store holds it durably: a fresh store over the same files agrees.
    w.store.close();
    const state = storeIn(w.dir).read("notes");
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const check = new Y.Doc();
    Y.applyUpdate(check, state.value.update);
    expect(check.getText("body").toString()).toBe(first + second);
  }, 60_000);

  it("keeps a small document inline, in v1's exact field set", async () => {
    const w = world();
    const one = w.open("one");
    await one.port.listDocs();
    const answer = await one.raw("resource.open_doc", { doc: w.ref() });
    expect(answer.ok).toBe(true);
    expect(Object.keys(answer.result as object).sort()).toEqual(["doc", "schemaMajor", "stateVector", "update"]);
  });

  it("refuses a gap in a parted upload, discards it, and accepts a clean restart", async () => {
    const w = world();
    const one = w.open("one");
    await one.port.listDocs();
    const local = new Y.Doc();
    local.getText("body").insert(0, paste(600_000, 3));
    const update = b64(Y.encodeStateAsUpdate(local));
    const total = String((update.length / 4) * 3 - (update.endsWith("==") ? 2 : update.endsWith("=") ? 1 : 0));
    const first = await one.raw("resource.apply_update", { doc: w.ref(), update: update.slice(0, WINDOW), offset: "0", total });
    expect(first).toMatchObject({ ok: true, result: { staged: (WINDOW / 4) * 3 } });
    // Skipping the second part is a gap: refused, and the upload is gone.
    const skipped = await one.raw("resource.apply_update", {
      doc: w.ref(), update: update.slice(2 * WINDOW, 3 * WINDOW), offset: String(((2 * WINDOW) / 4) * 3), total,
    });
    expect(skipped).toMatchObject({ ok: false, code: "invalid_request" });
    const resumed = await one.raw("resource.apply_update", {
      doc: w.ref(), update: update.slice(WINDOW, 2 * WINDOW), offset: String((WINDOW / 4) * 3), total,
    });
    expect(resumed).toMatchObject({ ok: false, code: "invalid_request" });
    // The adapter restarts at 0 and the whole update lands.
    expect((await one.port.applyUpdate(w.ref(), update)).ok).toBe(true);
    const state = w.store.read("notes");
    expect(state.ok && state.value.update.byteLength).toBeGreaterThan(600_000);
  });

  it("stages nothing until the edit lease stands", async () => {
    const w = world({ editCard: true });
    const one = w.open("one");
    await one.port.listDocs();
    const update = b64(new Uint8Array(400_000).fill(1));
    const first = await one.raw("resource.apply_update", { doc: w.ref(), update: update.slice(0, WINDOW), offset: "0", total: "400000" });
    expect(first).toMatchObject({ ok: false, code: "approval_required" });
    const next = await one.raw("resource.apply_update", {
      doc: w.ref(), update: update.slice(WINDOW, 2 * WINDOW), offset: String((WINDOW / 4) * 3), total: "400000",
    });
    expect(next).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("releases a scope's streams when the instance closes", async () => {
    const w = world();
    const writer = w.open("writer");
    await writer.port.listDocs();
    const local = new Y.Doc();
    local.getText("body").insert(0, paste(500_000, 5));
    expect((await writer.port.applyUpdate(w.ref(), b64(Y.encodeStateAsUpdate(local)))).ok).toBe(true);
    const opened = await writer.raw("resource.open_doc", { doc: w.ref() });
    const handle = (opened.result as { stream: { handle: string } }).stream.handle;
    expect(handle).toMatch(/^rs_/);
    await writer.handle.close();
    const pulled = await writer.raw("resource.stream_pull", { handle, seq: "0" });
    expect(pulled.ok === false || (pulled.result as { kind: string }).kind === "refused").toBe(true);
  });

  it("serves the four verbs plus the two stream verbs", () => {
    expect(CRDT_PROPOSAL_ACTIONS_V2).toEqual([
      "resource.list_docs",
      "resource.open_doc",
      "resource.apply_update",
      "resource.read_updates",
      "resource.stream_pull",
      "resource.stream_close",
    ]);
  });
});

describe("the coordinator's per-parameter bounds for CRDT", () => {
  it("follow the declarations instead of the 512-character default", () => {
    // Before this, neither CRDT declaration was registered, so a View's
    // `update` was cut off at 512 characters — a few hundred bytes of typing.
    expect(resourceParamLimits(CRDT_DOC_CONTRACT, "resource.apply_update")?.get("update"))
      .toBe(CRDT_DOC_LIMITS.maxUpdateEncodedLength);
    expect(resourceParamLimits(CRDT_DOC_CONTRACT, "resource.read_updates")?.get("since"))
      .toBe(CRDT_DOC_LIMITS.maxStateVectorEncodedLength);
    expect(resourceParamLimits(CRDT_DOC_CONTRACT_V2, "resource.apply_update")?.get("update")).toBe(WINDOW);
    expect(resourceParamLimits(CRDT_DOC_CONTRACT_V2, "resource.read_updates")?.get("since"))
      .toBe(CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength);
  });
});
