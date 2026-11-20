/**
 * "May this App instance touch a collaborative document?" — since 2026-08-10
 * the answer can be yes, and THIS file is where the whole chain is proved with
 * the real kernel: contract digest → recorded grant → intersection → derived
 * Context → Gate decision → provider → fsynced store, approval card included.
 *
 * ── What the refusing half still pins ──────────────────────────────────────
 *
 * "It refuses because nobody consented" and "it refuses because somebody
 * forgot to wire it" are indistinguishable from the outside, and only the
 * first is a design. So the refusals keep their own assertions: an instance
 * opened under any OLDER contract stays refused (its ask never contained the
 * tokens — an activation must not reinterpret an old consent), an unknown
 * digest resolves to nothing, edit-without-read is malformed, and a
 * composition without the plane holds nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { CRDT_EDIT_OPERATION, CRDT_READ_OPERATION } from "@claude-bot/crdt-doc-contract";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { CrdtDocCapabilities } from "../crdt-doc/capability.js";
import { CrdtDocumentStore } from "../crdt-doc/store.js";
import { IntentGrantResolver } from "./intent-resolver.js";
import {
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_AUTO_ALLOW,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  sessionPlusPermissionContractDigest,
} from "./contract.js";
import { sessionPlusCrdtGrant } from "./crdt-grant.js";

const OLD_DIGEST = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
);
const CRDT_DIGEST = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
);

/** A recorded grant, as `IntentGrantResolver` reads one. */
function permissionsWith(operations: readonly string[], autoAllow: readonly string[], digest: string) {
  return {
    get() {
      return {
        operations: [...operations],
        autoAllow: [...autoAllow],
        status: "active" as const,
        expiresAt: null,
        contractDigest: digest,
        publisher: SESSION_PLUS_PUBLISHER,
      };
    },
  } as unknown as ConstructorParameters<typeof IntentGrantResolver>[0];
}

function context(overrides: Partial<ResourceProviderContext> = {}): ResourceProviderContext {
  return {
    owner: "alice",
    publisher: SESSION_PLUS_PUBLISHER,
    app: "session-plus",
    packageDigest: "a".repeat(64),
    permissionContractDigest: CRDT_DIGEST,
    instance: "i1",
    binding: "docs",
    contract: "crdt-doc/v1",
    scope: "scope",
    ...overrides,
  };
}

const dirs: string[] = [];
const stores: CrdtDocumentStore[] = [];
const services: CapabilityService[] = [];

afterEach(() => {
  for (const made of stores.splice(0)) made.close();
  for (const svc of services.splice(0)) svc.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function realStore(): CrdtDocumentStore {
  const dir = mkdtempSync(path.join(tmpdir(), "crdt-grant-"));
  dirs.push(dir);
  const made = new CrdtDocumentStore({ root: dir });
  stores.push(made);
  return made;
}

function realPlane(store: CrdtDocumentStore): CrdtDocCapabilities {
  const service = new CapabilityService();
  services.push(service);
  return new CrdtDocCapabilities({
    service,
    store,
    userExists: (name) => name === "alice",
  });
}

/** The full recorded consent for the fifth contract, auto-allow as declared. */
function crdtGrants() {
  return new IntentGrantResolver(
    permissionsWith(
      SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS,
      SESSION_PLUS_WORKSPACE_WRITE_CRDT_AUTO_ALLOW,
      CRDT_DIGEST,
    ),
  );
}

const DOCUMENTS = [{ id: "notes", label: "Notes" }];

describe("instances opened under an older ask stay refused", () => {
  it("refuses the eight-token contract, and the tokens are demonstrably why", () => {
    const store = realStore();
    const open = sessionPlusCrdtGrant({
      capabilities: realPlane(store),
      store,
      grants: new IntentGrantResolver(
        permissionsWith(SESSION_PLUS_WORKSPACE_OPERATIONS, SESSION_PLUS_WORKSPACE_OPERATIONS, OLD_DIGEST),
      ),
      documentsFor: () => DOCUMENTS,
    });
    expect(open(context({ permissionContractDigest: OLD_DIGEST }))).toBeNull();
    expect(SESSION_PLUS_WORKSPACE_OPERATIONS).not.toContain(CRDT_READ_OPERATION);
    expect(SESSION_PLUS_WORKSPACE_OPERATIONS).not.toContain(CRDT_EDIT_OPERATION);
  });

  it("refuses a permission contract digest this build does not implement", () => {
    const store = realStore();
    const open = sessionPlusCrdtGrant({
      capabilities: realPlane(store),
      store,
      grants: crdtGrants(),
      documentsFor: () => DOCUMENTS,
    });
    expect(open(context({ permissionContractDigest: "0".repeat(64) }))).toBeNull();
  });

  it("refuses before anything else when the deployment composed no store or no plane", () => {
    const store = realStore();
    expect(
      sessionPlusCrdtGrant({
        capabilities: undefined,
        store,
        grants: crdtGrants(),
        documentsFor: () => DOCUMENTS,
      })(context()),
    ).toBeNull();
    expect(
      sessionPlusCrdtGrant({
        capabilities: realPlane(store),
        grants: crdtGrants(),
        documentsFor: () => DOCUMENTS,
      })(context()),
    ).toBeNull();
  });

  it("holds nothing when the owner has no documents", () => {
    const store = realStore();
    const open = sessionPlusCrdtGrant({
      capabilities: realPlane(store),
      store,
      grants: crdtGrants(),
      documentsFor: () => [],
    });
    expect(open(context())).toBeNull();
  });

  it("refuses edit-without-read rather than inferring the weaker token", () => {
    const store = realStore();
    const open = sessionPlusCrdtGrant({
      capabilities: realPlane(store),
      store,
      grants: new IntentGrantResolver(permissionsWith([CRDT_EDIT_OPERATION], [], CRDT_DIGEST)),
      documentsFor: () => DOCUMENTS,
    });
    expect(open(context())).toBeNull();
  });
});

describe("the fifth contract, through the real kernel", () => {
  it("derives a scope whose reads are unsupervised and whose edit is a card", async () => {
    const store = realStore();
    const plane = realPlane(store);
    const open = sessionPlusCrdtGrant({
      capabilities: plane,
      store,
      grants: crdtGrants(),
      documentsFor: () => DOCUMENTS,
    });
    const scope = open(context());
    expect(scope).not.toBeNull();
    if (!scope) return;
    expect(scope.mayEdit).toBe(true);
    expect(scope.documents).toEqual(DOCUMENTS);

    // `read_document` rides the declared auto-allow: a real kernel decision,
    // no card, adapter reached.
    const read = await scope.authority.request(CRDT_READ_OPERATION, { doc: "notes" });
    expect(read.status).toBe("succeeded");

    // `edit_document` cannot be auto-allowed — the account root's terms only
    // cover read-effect operations and `derive` attenuates — so the SAME
    // authority answers with a real approval card.
    const edit = await scope.authority.request(CRDT_EDIT_OPERATION, { doc: "notes", title: "Notes" });
    expect(edit.status).toBe("approval_required");
    if (edit.status !== "approval_required") return;

    // Undecided → the provider's lease poll sees `pending`.
    expect(scope.authority.result(edit.pendingCallId)).toMatchObject({ state: "pending" });

    // The OWNER approves; the recorded outcome is what mints the lease.
    const approved = await plane.service.approve(edit.pendingCallId, "alice");
    expect(approved.status).toBe("succeeded");
    expect(scope.authority.result(edit.pendingCallId)).toMatchObject({
      state: "finished",
      outcome: "succeeded",
    });

    // And the card is addressed to the document's owner alone.
    expect(plane.service.listPending("mallory")).toHaveLength(0);
    scope.close();
  });

  it("gives read without edit when the recorded grant holds only the read token", () => {
    const store = realStore();
    const open = sessionPlusCrdtGrant({
      capabilities: realPlane(store),
      store,
      grants: new IntentGrantResolver(
        permissionsWith(
          // The ask minus the edit token: what a person who consented and then
          // had edit revoked holds.
          SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS.filter((op) => op !== CRDT_EDIT_OPERATION),
          [CRDT_READ_OPERATION],
          CRDT_DIGEST,
        ),
      ),
      documentsFor: () => DOCUMENTS,
    });
    const scope = open(context());
    // The same documents, and no write. "Read-only" must not silently mean
    // "fewer documents": a person who may look at a note must see all of it.
    expect(scope?.mayEdit).toBe(false);
    expect(scope?.documents).toEqual(DOCUMENTS);
    scope?.close();
  });

  it("stops answering after the account's plane is revoked", async () => {
    const store = realStore();
    const plane = realPlane(store);
    const open = sessionPlusCrdtGrant({
      capabilities: plane,
      store,
      grants: crdtGrants(),
      documentsFor: () => DOCUMENTS,
    });
    const scope = open(context());
    expect(scope).not.toBeNull();
    if (!scope) return;
    expect(scope.authority.alive()).toBe(true);
    plane.revokeAccount("alice");
    expect(scope.authority.alive()).toBe(false);
    const read = await scope.authority.request(CRDT_READ_OPERATION, { doc: "notes" });
    expect(read.status).not.toBe("succeeded");
    scope.close();
  });

  it("survives being asked twice: the pool hands one instance one Context", () => {
    const store = realStore();
    const plane = realPlane(store);
    const grants = crdtGrants();
    const open = sessionPlusCrdtGrant({ capabilities: plane, store, grants, documentsFor: () => DOCUMENTS });
    const first = open(context());
    const second = open(context());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // One pooled Context per (instance, binding, release): the second open
    // borrows rather than minting a parallel authority.
    expect(plane.pooledContexts).toBe(1);
    first?.close();
    second?.close();
  });
});

describe("the seed content is real", () => {
  it("seeds an empty store once, and never a document somebody typed into", async () => {
    const { SEED_DOCUMENTS, seedCrdtDocuments } = await import("../crdt-doc/seed.js");
    const store = realStore();
    expect(seedCrdtDocuments(store).sort()).toEqual(SEED_DOCUMENTS.map((d) => d.id).sort());
    // Idempotent: a second boot seeds nothing.
    expect(seedCrdtDocuments(store)).toEqual([]);
    // And the content is the guide, not a placeholder.
    const read = store.read("welcome");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const probe = new Y.Doc();
    Y.applyUpdate(probe, read.value.update);
    expect(probe.getText("body").toString()).toContain("协作文档使用说明");

    // A person's edit wins over the seed for ever.
    const draft = new Y.Doc();
    Y.applyUpdate(draft, read.value.update);
    draft.getText("body").insert(0, "我的笔记：");
    store.applyUpdate("welcome", Y.encodeStateAsUpdate(draft, read.value.stateVector));
    expect(seedCrdtDocuments(store)).toEqual([]);
    probe.destroy();
    draft.destroy();
  });
});
