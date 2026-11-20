import { describe, expect, it } from "vitest";
import {
  checkoutLockfileHash,
  sessionPlusDescriptor,
  sessionPlusIdentity,
  sessionPlusIdentityOf,
  sessionPlusReleasePackage,
} from "./identity.js";
import { checkoutReleaseRecord, sessionPlusReleaseRecord } from "./release.js";
import { PERMISSIONS_ASSET } from "@claude-bot/session-plus-view/plan";

const descriptor = (): ReturnType<typeof sessionPlusDescriptor> =>
  sessionPlusDescriptor({ pkg: sessionPlusReleasePackage(), lockfileHash: checkoutLockfileHash() });

describe("Session Plus ReleaseRecord", () => {
  it("reproduces package and recipe identity from immutable inputs", () => {
    const d = descriptor();
    const identity = sessionPlusIdentity();
    const a = sessionPlusReleaseRecord({
      identity,
      descriptor: d,
      attestation: { builder: "b", builtAt: "2026-08-04T00:00:00.000Z", statement: "s" },
    });
    const b = sessionPlusReleaseRecord({
      identity,
      descriptor: d,
      attestation: { builder: "b", builtAt: "2026-08-05T00:00:00.000Z", statement: "s" },
    });
    expect(a.packageDigest).toBe(d.packageDigest);
    expect(a.sourceSnapshot.digest).toBe(d.source.digest);
    expect(a.packageDigest).toBe(b.packageDigest);
    expect(a.recipeDigest).toBe(b.recipeDigest);
    // When the artifact was obtained is an installation fact, not a property of
    // the bytes — so it moves without moving anything the digest covers.
    expect(a.attestation.builtAt).not.toBe(b.attestation.builtAt);
    expect(JSON.stringify(a.buildInput)).not.toContain("builtAt");
    expect(a.buildInput).not.toHaveProperty("packageDigest");
  });

  it("lists the exact source snapshot by allowlisted asset name", () => {
    const record = checkoutReleaseRecord(descriptor());
    const paths = record.sourceSnapshot.files.map((file) => file.path);
    expect(paths).toContain("app/app.yaml");
    expect(paths).toContain("view.js");
    // Every listed file has its own digest and size, and nothing here is a path
    // on this host: the href is an exact-name lookup against the release.
    for (const file of record.sourceSnapshot.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.href).toBe(`/api/session-plus/release?source=${encodeURIComponent(file.path)}`);
    }
  });

  it("refuses to publish a record whose identity belongs to a different release", () => {
    const other = sessionPlusDescriptor({
      pkg: { assets: [{ name: "view.js", source: "different" }] },
      lockfileHash: "0".repeat(64),
    });
    expect(() => sessionPlusReleaseRecord({ identity: sessionPlusIdentity(), descriptor: other }))
      .toThrow(/does not match/);
  });

  it("discloses every data category this release's ask requests", () => {
    // This checkout ships the current media/terminal release, and the consent
    // record has to NAME what every declared data operation touches before
    // anybody is asked to agree. A release record listing fewer would describe
    // a different ask than the one being installed.
    const record = checkoutReleaseRecord(descriptor());
    expect(record.disclosures.map((entry) => entry.id).sort()).toEqual([
      "crdt-document-content",
      "owner-runner-file-content",
      "session-attachment",
      "session-content",
      "session-metadata",
      "workspace-file-content",
      "workspace-file-listing",
      "workspace-labels",
    ]);
    // Both document operations touch the same category: the read pulls the
    // content, the edit merges into it. What differs is the Gate decision.
    expect(record.disclosures.find((entry) => entry.id === "crdt-document-content")?.operations.sort())
      .toEqual(["edit_document", "read_document"]);
    expect(record.disclosures.find((entry) => entry.id === "session-content")?.operations.sort())
      .toEqual(["read_session", "search_sessions"]);
    // Text read, bounded image/PDF read, full-file download and whole-text
    // replacement share one honest category: all touch workspace file CONTENT.
    // The Gate operations remain distinct; the category says what is touched,
    // not how.
    expect(record.disclosures.find((entry) => entry.id === "workspace-file-content")?.operations.sort())
      .toEqual(["download_workspace_file", "read_workspace_binary", "read_workspace_text", "replace_workspace_text"]);
    expect(record.disclosures.find((entry) => entry.id === "owner-runner-file-content")?.operations)
      .toEqual(["access_owner_files", "replace_owner_text"]);
    expect(record.disclosures.find((entry) => entry.id === "workspace-file-listing")?.operations)
      .toEqual(["list_workspace_entries"]);
  });

  it("describes the ask of a ROLLBACK target, not what this host can do", () => {
    // The counterweight, and the property the previous test used to carry: a
    // record is a description of one release's ask. Re-describing an older
    // release under the newest contract would make a consent screen say a
    // read-only release wanted to write.
    const release = sessionPlusReleasePackage();
    const readOnly = sessionPlusDescriptor({
      pkg: { assets: release.assets.filter((asset) => asset.name !== PERMISSIONS_ASSET) },
      lockfileHash: checkoutLockfileHash(),
    });
    // The backend files are the same bytes — only the View's declaration was
    // dropped — so this checkout's executable digest is the honest one to pair
    // with the older descriptor.
    const record = sessionPlusReleaseRecord({
      identity: sessionPlusIdentityOf(readOnly, {
        backendCodeDigest: sessionPlusIdentity().backendCodeDigest,
      }),
      descriptor: readOnly,
    });
    for (const entry of record.disclosures) {
      expect(entry.operations).not.toContain("replace_workspace_text");
    }
    expect(record.disclosures.find((entry) => entry.id === "workspace-file-content")?.operations)
      .toEqual(["read_workspace_text"]);
  });
});
