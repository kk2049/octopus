/**
 * The vertical slice: typed port → in-process dispatcher → catalog → provider →
 * ref vault → Yjs replica → fsynced log on a real temp directory, and back.
 *
 * ── What "end to end" means here, and what it does not ─────────────────────
 *
 * It means every layer this batch built is exercised by the same call, with real
 * files. It does NOT mean an Agent View can do this: the View wire cannot carry
 * two of the three actions (`packages/crdt-doc-contract/src/wire.test.ts`), and
 * no permission contract this build implements declares the two tokens
 * (`session-resource/crdt-grant.test.ts`). Both are recorded as assertions
 * elsewhere rather than glossed over here.
 *
 * ── The convergence case is the point ──────────────────────────────────────
 *
 * Everything else in this file is a refusal. `two replicas converge…` is the one
 * that says the thing actually works — and it is written with two independent
 * `Y.Doc`s inserting at the SAME position with no coordination, because
 * convergence under sequential edits is not evidence of anything.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CRDT_DOC_CONTRACT, CRDT_DOC_DECLARATION, CRDT_DOC_LIMITS } from "@claude-bot/crdt-doc-contract";
import { assertConformant, runPortConformance } from "@claude-bot/typed-port-kit/testing";
import { AgentResourceCatalog } from "./catalog.js";
import { CRDT_PROPOSAL_ACTIONS, crdtDocProvider } from "./crdt-doc-provider.js";
import type { ResourceProviderContext } from "./types.js";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import { createLocalCrdtPort } from "../crdt-doc/local-port.js";
import type {
  CrdtDocPendingOutcome,
  CrdtDocScopeAuthority,
  CrdtDocumentDescriptor,
  CrdtScopeGrant,
} from "../crdt-doc/types.js";

/**
 * A scriptable Gate, standing in for the `crdt-doc-v1` capability plane.
 *
 * Its default mirrors the production plane's happy path — reads auto-allowed,
 * the FIRST edit-lease request allowed — and a test scripts the rest: an edit
 * that must be approved (`editCard`), a plane that answers denied, a context
 * that has been revoked (`alive` flips false). Every kernel decision the
 * provider consults is observable through `requests`.
 */
function fakeAuthority(options: {
  editCard?: boolean;
  denyRead?: boolean;
  denyEdit?: boolean;
} = {}) {
  const requests: { operation: string; args: Record<string, unknown> }[] = [];
  let live = true;
  let outcome: CrdtDocPendingOutcome = { state: "pending", outcome: null };
  const authority: CrdtDocScopeAuthority = {
    async request(operation, args) {
      requests.push({ operation, args });
      if (operation === "read_document") {
        return options.denyRead
          ? { status: "denied", reason: "scripted" }
          : { status: "succeeded", result: { granted: true } };
      }
      if (options.denyEdit) return { status: "denied", reason: "scripted" };
      if (options.editCard) return { status: "approval_required", pendingCallId: "pc_1" };
      return { status: "succeeded", result: { granted: true } };
    },
    result: () => outcome,
    alive: () => live,
  };
  return {
    authority,
    requests,
    approve: () => {
      outcome = { state: "finished", outcome: "succeeded" };
    },
    reject: () => {
      outcome = { state: "rejected", outcome: null };
    },
    revoke: () => {
      live = false;
    },
  };
}

const PLAN = {
  schema: "agent-resource-bindings/v1" as const,
  app: "notes",
  bindings: [{ binding: "documents", contract: CRDT_DOC_CONTRACT, port: CRDT_DOC_CONTRACT }],
  connections: [],
};

const DOCUMENTS: readonly CrdtDocumentDescriptor[] = Object.freeze([{ id: "notes", label: "Notes" }]);

const dirs: string[] = [];
const stores: CrdtDocumentStore[] = [];

function newDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crdt-e2e-"));
  dirs.push(dir);
  return dir;
}

function storeIn(dir: string): CrdtDocumentStore {
  const made = new CrdtDocumentStore({ root: dir });
  stores.push(made);
  return made;
}

function newStore(): CrdtDocumentStore {
  return storeIn(newDir());
}

afterEach(() => {
  for (const made of stores.splice(0)) made.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identity(instance = "i1", owner = "alice") {
  return {
    owner,
    publisher: "octopus:first-party",
    app: "notes",
    packageDigest: "a".repeat(64),
    permissionContractDigest: "b".repeat(32),
    instance,
    plan: PLAN as never,
  };
}

interface Bound {
  store: CrdtDocumentStore;
  handle: { dispatch: (p: { action: string; params: Record<string, string> }) => Promise<{ ok: boolean; code?: string; result?: unknown; message: string }>; close: () => Promise<void> };
  port: ReturnType<typeof createLocalCrdtPort>["port"];
  destroy: () => void;
  /** The ref this scope minted, learned through the provider's trusted seam. */
  ref: () => string;
  grants: () => number;
  closes: () => number;
}

/**
 * Build one instance: a catalog with the provider installed, an opened handle
 * and a typed port over it.
 *
 * The ref is learned through `onScopeOpened`, which is exactly how a trusted App
 * shell would learn it in order to build an `open-resource/v1` link. Nothing is
 * predicted, derived or read out of private state.
 */
function bind(
  options: {
    store?: CrdtDocumentStore;
    mayEdit?: boolean;
    documents?: readonly CrdtDocumentDescriptor[];
    instance?: string;
    owner?: string;
    limit?: { updates: number; windowMs: number };
    now?: () => number;
    catalog?: AgentResourceCatalog;
    noGrant?: boolean;
    gate?: ReturnType<typeof fakeAuthority>;
  } = {},
): Bound {
  const store = options.store ?? newStore();
  const documents = options.documents ?? DOCUMENTS;
  const gate = options.gate ?? fakeAuthority();
  let grants = 0;
  let closes = 0;
  let ref = "";

  const openGrant = (): CrdtScopeGrant | null => {
    if (options.noGrant) return null;
    grants += 1;
    return {
      documents,
      mayEdit: options.mayEdit ?? true,
      store,
      authority: gate.authority,
      close: () => {
        closes += 1;
      },
    };
  };

  const catalog = options.catalog ?? new AgentResourceCatalog();
  if (!options.catalog) {
    catalog.register(
      crdtDocProvider({
        openGrant,
        onScopeOpened: (_context: ResourceProviderContext, refs) => {
          ref = [...refs.keys()][0] ?? "";
        },
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
    );
    catalog.seal();
  }

  const handle = catalog.openInstance(identity(options.instance ?? "i1", options.owner ?? "alice"));
  const local = createLocalCrdtPort((proposal) => handle.dispatch(proposal), "documents");
  return {
    store,
    handle: handle as Bound["handle"],
    port: local.port,
    destroy: local.destroy,
    ref: () => ref,
    grants: () => grants,
    closes: () => closes,
  };
}

/**
 * Force the scope open so the ref is minted.
 *
 * A scope is opened lazily, on the first proposal — which is the catalog's
 * design, not an accident — so a test that needs the ref has to make one call
 * first. `open_doc` with a ref this scope cannot know is refused, and that
 * refusal is itself worth having: it proves a guessed ref does not work.
 */
async function warmUp(bound: Bound): Promise<void> {
  const answer = await bound.port.openDoc(`cd_${"0".repeat(24)}`);
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.code).toBe("unknown_doc");
  expect(bound.ref()).toMatch(/^cd_[0-9a-f]{24}$/);
}

function replica() {
  const doc = new Y.Doc();
  return { doc, type: doc.getText("body") };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

describe("the whole path, with real files", () => {
  it("opens, writes and reads back through every layer", async () => {
    const bound = bind();
    await warmUp(bound);

    const opened = await bound.port.openDoc(bound.ref());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.doc).toBe(bound.ref());
    expect(opened.value.schemaMajor).toBe(1);

    const client = replica();
    Y.applyUpdate(client.doc, decode(opened.value.update));
    const before = Y.encodeStateVector(client.doc);
    client.type.insert(0, "hello world");

    const ack = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc, before)));
    expect(ack.ok).toBe(true);

    // A second reader, starting from nothing, sees it.
    const reader = replica();
    const snapshot = await bound.port.openDoc(bound.ref());
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) Y.applyUpdate(reader.doc, decode(snapshot.value.update));
    expect(reader.type.toString()).toBe("hello world");

    // …and it is on the disk, not just in the replica.
    expect(bound.store.stats("notes")!.records).toBe(1);
    await bound.handle.close();
  });

  it("two replicas converge after concurrent edits at the same position", async () => {
    const bound = bind();
    await warmUp(bound);
    const ref = bound.ref();

    const seed = await bound.port.openDoc(ref);
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    const left = replica();
    const right = replica();
    Y.applyUpdate(left.doc, decode(seed.value.update));
    Y.applyUpdate(right.doc, decode(seed.value.update));

    // Neither has seen the other. Both insert at index 0 — the case a
    // last-write-wins store resolves by losing one of them.
    const leftBefore = Y.encodeStateVector(left.doc);
    left.type.insert(0, "LEFT");
    const rightBefore = Y.encodeStateVector(right.doc);
    right.type.insert(0, "RIGHT");

    expect((await bound.port.applyUpdate(ref, b64(Y.encodeStateAsUpdate(left.doc, leftBefore)))).ok).toBe(true);
    expect((await bound.port.applyUpdate(ref, b64(Y.encodeStateAsUpdate(right.doc, rightBefore)))).ok).toBe(true);

    // Each pulls what it is missing — the "sync" button, made explicit.
    const toLeft = await bound.port.readUpdates(ref, b64(Y.encodeStateVector(left.doc)));
    const toRight = await bound.port.readUpdates(ref, b64(Y.encodeStateVector(right.doc)));
    expect(toLeft.ok && !toLeft.value.empty).toBe(true);
    expect(toRight.ok && !toRight.value.empty).toBe(true);
    if (toLeft.ok) Y.applyUpdate(left.doc, decode(toLeft.value.update));
    if (toRight.ok) Y.applyUpdate(right.doc, decode(toRight.value.update));

    expect(left.type.toString()).toBe(right.type.toString());
    // Both inserts survived; neither overwrote the other.
    expect(left.type.toString()).toHaveLength("LEFTRIGHT".length);
    expect(left.type.toString()).toContain("LEFT");
    expect(left.type.toString()).toContain("RIGHT");

    const server = await bound.port.openDoc(ref);
    expect(server.ok).toBe(true);
    if (server.ok) {
      const check = new Y.Doc();
      Y.applyUpdate(check, decode(server.value.update));
      expect(check.getText("body").toString()).toBe(left.type.toString());
    }
    await bound.handle.close();
  });

  it("survives a restart of the trusted process", async () => {
    const dir = newDir();
    const store = storeIn(dir);
    const first = bind({ store });
    await warmUp(first);
    const client = replica();
    client.type.insert(0, "persisted");
    expect((await first.port.applyUpdate(first.ref(), b64(Y.encodeStateAsUpdate(client.doc)))).ok).toBe(true);
    await first.handle.close();
    store.close();

    // A different store object on the same directory: the process died and came
    // back. Nothing was handed over in memory.
    const second = bind({ store: storeIn(dir), instance: "i2" });
    await warmUp(second);
    const opened = await second.port.openDoc(second.ref());
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const check = new Y.Doc();
      Y.applyUpdate(check, decode(opened.value.update));
      expect(check.getText("body").toString()).toBe("persisted");
    }
    await second.handle.close();
  });

  it("says nothing changed when the caller is already current", async () => {
    const bound = bind();
    await warmUp(bound);
    const opened = await bound.port.openDoc(bound.ref());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const delta = await bound.port.readUpdates(bound.ref(), opened.value.stateVector);
    expect(delta.ok && delta.value.empty).toBe(true);
    await bound.handle.close();
  });
});

describe("refusals reach no store", () => {
  it("refuses a forged ref before touching anything", async () => {
    const bound = bind();
    await warmUp(bound);
    const spy = vi.spyOn(bound.store, "read");
    const answer = await bound.port.openDoc(`cd_${"f".repeat(24)}`);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("unknown_doc");
    expect(spy).not.toHaveBeenCalled();
    await bound.handle.close();
  });

  it("refuses another instance's ref", async () => {
    const store = newStore();
    const first = bind({ store, instance: "i1" });
    const second = bind({ store, instance: "i2" });
    await warmUp(first);
    await warmUp(second);
    expect(first.ref()).not.toBe(second.ref());
    // A ref is meaningless outside the scope that minted it, even for the same
    // owner, the same App and the same document.
    const answer = await second.port.openDoc(first.ref());
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("unknown_doc");
    await first.handle.close();
    await second.handle.close();
  });

  it("refuses everything once the instance is closed", async () => {
    const bound = bind();
    await warmUp(bound);
    expect((await bound.port.openDoc(bound.ref())).ok).toBe(true);
    await bound.handle.close();
    expect(bound.closes()).toBe(1);
    const answer = await bound.port.openDoc(bound.ref());
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("scope_closed");
  });

  it("gives a read-only scope the same documents and no write", async () => {
    const bound = bind({ mayEdit: false });
    await warmUp(bound);

    const opened = await bound.port.openDoc(bound.ref());
    expect(opened.ok).toBe(true);

    const client = replica();
    if (opened.ok) Y.applyUpdate(client.doc, decode(opened.value.update));
    const before = Y.encodeStateVector(client.doc);
    client.type.insert(0, "nope");

    const denied = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc, before)));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("no_authority");
    expect(bound.store.stats("notes")!.records).toBe(0);
    await bound.handle.close();
  });

  it("refuses every action when the deployment grants nothing", async () => {
    const bound = bind({ noGrant: true });
    const answer = await bound.port.openDoc(`cd_${"0".repeat(24)}`);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("no_authority");
    await bound.handle.close();
  });

  it("holds nothing when the grant names no document", async () => {
    // "No authority" and "no documents" are the same observable state, on
    // purpose: a scope that may reach nothing holds nothing.
    const bound = bind({ documents: [] });
    const answer = await bound.port.openDoc(`cd_${"0".repeat(24)}`);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("no_authority");
    expect(bound.closes()).toBe(1);
    await bound.handle.close();
  });

  it("refuses an update that is not base64 without decoding it", async () => {
    const bound = bind();
    await warmUp(bound);
    const spy = vi.spyOn(bound.store, "applyUpdate");
    // Three characters is a truncated quantum. `Buffer.from(x, "base64")` would
    // happily round it into bytes nobody sent, which would then be diagnosed as
    // `bad_update` rather than as a malformed request.
    const answer = await bound.port.applyUpdate(bound.ref(), "AQI");
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
    await bound.handle.close();
  });

  it("refuses bytes that are not an update", async () => {
    const bound = bind();
    await warmUp(bound);
    const answer = await bound.port.applyUpdate(bound.ref(), b64(new Uint8Array([200, 201, 202, 203])));
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("bad_update");
    await bound.handle.close();
  });

  it("refuses a flood, and says later rather than never", async () => {
    let clock = 0;
    const bound = bind({ limit: { updates: 2, windowMs: 1000 }, now: () => clock });
    await warmUp(bound);
    const client = replica();

    const push = async (): Promise<{ ok: boolean; code?: string }> => {
      const before = Y.encodeStateVector(client.doc);
      client.type.insert(client.type.length, "x");
      const answer = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc, before)));
      return answer.ok ? { ok: true } : { ok: false, code: answer.code };
    };

    expect((await push()).ok).toBe(true);
    expect((await push()).ok).toBe(true);
    expect(await push()).toEqual({ ok: false, code: "rate_limited" });

    // "Later", not "never" — the window rolls.
    clock += 1001;
    expect((await push()).ok).toBe(true);
    await bound.handle.close();
  });

  it("refuses a document that has outgrown one read", async () => {
    const bound = bind();
    await warmUp(bound);

    const client = replica();
    // Grown in increments each of which fits one call, until the WHOLE document
    // no longer does. That is the shape of the problem: writing is incremental
    // and bounded per call, reading is all-or-nothing — so a document reaches a
    // size at which it can still be edited by everyone who already has it and
    // can no longer be opened by anyone who does not.
    const step = 20_000;
    while (client.type.length < CRDT_DOC_LIMITS.maxUpdateBytes + step) {
      const before = Y.encodeStateVector(client.doc);
      client.type.insert(client.type.length, "x".repeat(step));
      const push = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc, before)));
      expect(push.ok).toBe(true);
    }

    const opened = await bound.port.openDoc(bound.ref());
    expect(opened.ok).toBe(false);
    // Never a truncation — half a CRDT update is not a smaller document. The fix
    // is a streamed open (`resource-stream/v1`), which v1 does not have.
    if (!opened.ok) expect(opened.code).toBe("doc_too_large");
    await bound.handle.close();
  });

  it("refuses after the port is destroyed, without dispatching", async () => {
    const bound = bind();
    await warmUp(bound);
    const spy = vi.spyOn(bound.store, "read");
    bound.destroy();
    const answer = await bound.port.openDoc(bound.ref());
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("scope_closed");
    expect(spy).not.toHaveBeenCalled();
    await bound.handle.close();
  });
});

describe("the Gate stands between the App and the store (2026-08-10)", () => {
  it("lists the scope's documents as the FIRST call, refs plus titles only", async () => {
    const bound = bind();
    // No warm-up: `list_docs` needs no ref, which is the whole reason it exists.
    const listed = await bound.port.listDocs();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.docs).toHaveLength(1);
    expect(listed.value.docs[0]!.title).toBe("Notes");
    expect(listed.value.docs[0]!.doc).toMatch(/^cd_[0-9a-f]{24}$/);
    // And the ref it handed out is the one every later call resolves.
    const opened = await bound.port.openDoc(listed.value.docs[0]!.doc);
    expect(opened.ok).toBe(true);
    await bound.handle.close();
  });

  it("spends one read_document decision per read", async () => {
    const gate = fakeAuthority();
    const bound = bind({ gate });
    await warmUp(bound);
    await bound.port.openDoc(bound.ref());
    await bound.port.readUpdates(bound.ref(), b64(Y.encodeStateVector(new Y.Doc())));
    const reads = gate.requests.filter((row) => row.operation === "read_document");
    expect(reads).toHaveLength(2);
    // The Gate is asked about the STORE id, never about the minted ref: the
    // ref is scope-local and would make every audit row scope-local too.
    expect(reads[0]!.args.doc).toBe("notes");
    await bound.handle.close();
  });

  it("refuses a read the Gate denied, with zero store calls", async () => {
    const gate = fakeAuthority({ denyRead: true });
    const bound = bind({ gate });
    await warmUp(bound);
    const spy = vi.spyOn(bound.store, "read");
    const answer = await bound.port.openDoc(bound.ref());
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("no_authority");
    expect(spy).not.toHaveBeenCalled();
    await bound.handle.close();
  });

  it("holds an edit behind the lease card, and merges only after approval", async () => {
    const gate = fakeAuthority({ editCard: true });
    const bound = bind({ gate });
    await warmUp(bound);
    const client = replica();
    client.type.insert(0, "held edit");
    const update = b64(Y.encodeStateAsUpdate(client.doc));

    // First push: a card, no merge, nothing in the log.
    const first = await bound.port.applyUpdate(bound.ref(), update);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe("approval_required");
    expect(bound.store.stats("notes")).toBeNull();

    // Second push while the card is undecided: the provider reads the RECORD
    // rather than asking again — one card total, however often the editor
    // retries.
    const second = await bound.port.applyUpdate(bound.ref(), update);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("approval_required");
    expect(gate.requests.filter((row) => row.operation === "edit_document")).toHaveLength(1);
    // The card names the document by store id AND display title — what a
    // person can recognise on an approval screen.
    const lease = gate.requests.find((row) => row.operation === "edit_document")!;
    expect(lease.args).toEqual({ doc: "notes", title: "Notes" });

    // Approval lands; the next push merges, and later pushes ride the lease
    // without a second kernel ask.
    gate.approve();
    const third = await bound.port.applyUpdate(bound.ref(), update);
    expect(third.ok).toBe(true);
    const fourth = await bound.port.applyUpdate(bound.ref(), update);
    expect(fourth.ok).toBe(true);
    expect(gate.requests.filter((row) => row.operation === "edit_document")).toHaveLength(1);
    expect(bound.store.stats("notes")!.records).toBeGreaterThan(0);
    await bound.handle.close();
  });

  it("turns a rejected lease into no_authority, and asks afresh on the next push", async () => {
    const gate = fakeAuthority({ editCard: true });
    const bound = bind({ gate });
    await warmUp(bound);
    const client = replica();
    client.type.insert(0, "rejected");
    const update = b64(Y.encodeStateAsUpdate(client.doc));

    await bound.port.applyUpdate(bound.ref(), update);
    gate.reject();
    const refused = await bound.port.applyUpdate(bound.ref(), update);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("no_authority");
    expect(bound.store.stats("notes")).toBeNull();
    // A LATER push may ask again — the owner can change their mind — and that
    // next ask is a fresh card, not a merge.
    const again = await bound.port.applyUpdate(bound.ref(), update);
    expect(again.ok).toBe(false);
    expect(gate.requests.filter((row) => row.operation === "edit_document")).toHaveLength(2);
    await bound.handle.close();
  });

  it("stops merging mid-sitting when the authority is revoked", async () => {
    const gate = fakeAuthority();
    const bound = bind({ gate });
    await warmUp(bound);
    const client = replica();
    client.type.insert(0, "before revocation");
    const before = Y.encodeStateVector(client.doc);
    const first = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc)));
    expect(first.ok).toBe(true);

    // The lease is a boolean; the liveness check is what notices this.
    gate.revoke();
    client.type.insert(0, "after ");
    const spy = vi.spyOn(bound.store, "applyUpdate");
    const held = await bound.port.applyUpdate(bound.ref(), b64(Y.encodeStateAsUpdate(client.doc, before)));
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.code).toBe("no_authority");
    expect(spy).not.toHaveBeenCalled();
    await bound.handle.close();
  });

  it("stops listing once the authority is gone", async () => {
    const gate = fakeAuthority();
    const bound = bind({ gate });
    await warmUp(bound);
    gate.revoke();
    const listed = await bound.port.listDocs();
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe("no_authority");
    await bound.handle.close();
  });
});

describe("the provider's action set", () => {
  it("serves exactly the declared verbs, prefixed", () => {
    expect([...CRDT_PROPOSAL_ACTIONS]).toEqual([
      "resource.list_docs",
      "resource.open_doc",
      "resource.apply_update",
      "resource.read_updates",
    ]);
  });

  it("refuses an action outside the closed set before opening a scope", async () => {
    const bound = bind();
    const answer = await bound.handle.dispatch({
      action: "resource.delete_doc",
      params: { doc: "cd_x", binding: "documents" },
    });
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("invalid_request");
    expect(bound.grants()).toBe(0);
    await bound.handle.close();
  });

  it("refuses a binding the plan does not declare", async () => {
    const bound = bind();
    const answer = await bound.handle.dispatch({
      action: "resource.open_doc",
      params: { doc: `cd_${"0".repeat(24)}`, binding: "somewhere-else" },
    });
    expect(answer.ok).toBe(false);
    expect(bound.grants()).toBe(0);
    await bound.handle.close();
  });
});

describe("contract conformance", () => {
  it("satisfies the kit's harness on real samples", async () => {
    const bound = bind();
    await warmUp(bound);
    const client = replica();
    client.type.insert(0, "hi");
    // NOTE these samples are deliberately TINY. `runPortConformance` puts every
    // sample through `encodeWireParams`, which applies the View wire's
    // 512-character clamp — so a realistic update cannot be conformance-tested
    // at all today. That limitation is the subject of
    // `packages/crdt-doc-contract/src/wire.test.ts` and of the worklog.
    const update = b64(Y.encodeStateAsUpdate(client.doc));
    const since = b64(Y.encodeStateVector(new Y.Doc()));
    expect(update.length).toBeLessThan(512);

    const findings = await runPortConformance({
      declaration: CRDT_DOC_DECLARATION,
      port: bound.port,
      invoke: async (action, params) => {
        switch (action) {
          case "list_docs":
            return bound.port.listDocs();
          case "open_doc":
            return bound.port.openDoc(String(params.doc ?? ""));
          case "apply_update":
            return bound.port.applyUpdate(String(params.doc ?? ""), String(params.update ?? ""));
          default:
            return bound.port.readUpdates(String(params.doc ?? ""), String(params.since ?? ""));
        }
      },
      samples: {
        list_docs: {},
        open_doc: { doc: bound.ref() },
        apply_update: { doc: bound.ref(), update },
        read_updates: { doc: bound.ref(), since },
      },
    });
    assertConformant(findings);
    await bound.handle.close();
  });
});
