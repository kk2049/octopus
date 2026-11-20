/**
 * The immutable Session Plus permission contracts, and the rules that keep them apart.
 *
 * The interesting failures here are not "does the digest match a constant" —
 * they are the ones where an ask silently becomes a different ask: an unknown
 * digest resolving to the newest contract, a six-operation grant being stamped
 * with the eight-operation digest, or a publisher change being inherited.
 */

import { describe, expect, it } from "vitest";
import {
  SESSION_PLUS_CHAT_UPLOAD_OPERATIONS,
  SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
  SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS,
  SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_FILES_OPERATIONS,
  SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
  SESSION_PLUS_CONTRACTS,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
  SESSION_PLUS_TERMINAL_OPERATIONS,
  SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  sessionPlusContractById,
  sessionPlusContractCovering,
  sessionPlusContractFor,
  sessionPlusPermissionContractDigest,
} from "./contract.js";

const BASE = sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_PERMISSION_CONTRACT);
const WORKSPACE = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
);
const WRITE = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
);
const NOTIFY = sessionPlusPermissionContractDigest(
  SESSION_PLUS_PUBLISHER,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
);

describe("the two Session Plus permission contracts", () => {
  it("keeps the original six unchanged, name for name and digest included", () => {
    expect([...SESSION_PLUS_OPERATIONS]).toEqual([
      "list_recent_sessions",
      "search_sessions",
      "read_session",
      "list_session_workspaces",
      "start_session",
      "append_session",
    ]);
    // The rollback targets declare this digest. If it moves, every existing
    // grant and every installed legacy release stops being activatable.
    expect(BASE).toBe("55f86907f326880b8b687705b0595939");
  });

  it("adds exactly two reads, and they are a different contract", () => {
    expect([...SESSION_PLUS_WORKSPACE_OPERATIONS]).toEqual([
      ...SESSION_PLUS_OPERATIONS,
      "list_workspace_entries",
      "read_workspace_text",
    ]);
    expect(WORKSPACE).not.toBe(BASE);
    expect(SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT.deliveries).toEqual([]);
  });

  it("does not smuggle a write, a watch or an exec into the wider ask", () => {
    const added = SESSION_PLUS_WORKSPACE_OPERATIONS.filter(
      (operation) => !(SESSION_PLUS_OPERATIONS as readonly string[]).includes(operation),
    );
    expect(added).toEqual(["list_workspace_entries", "read_workspace_text"]);
    for (const name of added) {
      expect(name).not.toMatch(/write|replace|delete|watch|exec|patch/);
    }
  });

  it("resolves a digest to THAT contract, and refuses an unknown one", () => {
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, BASE)?.id).toBe("sessions/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WORKSPACE)?.id).toBe("sessions-workspace/v1");
    // No fallback onto the newest constant: an ask nobody here can project,
    // grant or audit has no contract.
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, "f".repeat(64))).toBeNull();
  });

  it("does not inherit a contract across publishers", () => {
    // The publisher is inside the digest: the same operations vouched for by
    // somebody else is a different thing to agree to.
    expect(sessionPlusContractFor("someone:else", BASE)).toBeNull();
    expect(sessionPlusContractFor("someone:else", WORKSPACE)).toBeNull();
    expect(sessionPlusPermissionContractDigest("someone:else", SESSION_PLUS_PERMISSION_CONTRACT)).not.toBe(BASE);
  });

  it("stamps a grant with the NARROWEST contract that contains it", () => {
    // A six-operation consent is an answer to the six-operation ask. Stamping
    // it with the wider digest would record an agreement nobody made — and the
    // "contract changed, please re-consent" notice would vanish exactly when it
    // is needed.
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, [...SESSION_PLUS_OPERATIONS])?.digest).toBe(BASE);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["read_session"])?.digest).toBe(BASE);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["read_workspace_text"])?.digest).toBe(WORKSPACE);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["not_an_operation"])).toBeNull();
  });

  it("exposes the closed list oldest first, so `covering` prefers the narrow one", () => {
    expect(SESSION_PLUS_CONTRACTS.map((row) => row.id)).toEqual([
      "sessions/v1",
      "sessions-workspace/v1",
      "sessions-workspace-write/v1",
      "sessions-workspace-write-notify/v1",
      "sessions-workspace-write-crdt/v1",
      "sessions-workspace-write-crdt-self-service/v1",
      "sessions-workspace-write-crdt-self-service/v2",
      "sessions-workspace-write-crdt-self-service/v3",
      "sessions-workspace-write-crdt-self-service/v4",
      "sessions-workspace-write-crdt-self-service/v5",
      "sessions-workspace-write-crdt-self-service/v6",
      "sessions-workspace-write-crdt-self-service/v7",
    ]);
    expect(sessionPlusContractById("sessions/v1")).toBe(SESSION_PLUS_PERMISSION_CONTRACT);
    expect(sessionPlusContractById("sessions-workspace/v1")).toBe(SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT);
    expect(sessionPlusContractById("sessions-workspace-write/v1"))
      .toBe(SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT);
    expect(sessionPlusContractById("sessions-workspace-write-notify/v1"))
      .toBe(SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT);
  });
});

describe("the write contract", () => {
  it("adds exactly one operation to the read-only ask, and it is the write", () => {
    expect([...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS]).toEqual([
      ...SESSION_PLUS_WORKSPACE_OPERATIONS,
      "replace_workspace_text",
    ]);
    expect(WRITE).not.toBe(WORKSPACE);
    expect(WRITE).not.toBe(BASE);
  });

  it("never auto-allows the write, in the ask a person is shown", () => {
    // The capability chain enforces this too (a `modify` is outside the account
    // root's auto-allow and derive can only attenuate). Both halves say it
    // because this list is what a consent screen renders, and a screen offering
    // an unsupervised overwrite would be describing something that cannot happen.
    expect(SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT.autoAllow)
      .not.toContain("replace_workspace_text");
    expect(SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT.autoAllow)
      .toEqual([...SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT.autoAllow]);
  });

  it("leaves the two read-only asks byte for byte where they were", () => {
    // The whole reason the write is a THIRD contract: a person who agreed to the
    // eight-token read-only ask must not find that agreement now covering an
    // overwrite. Both older digests are unmoved, so both older releases stay
    // activatable and every existing grant keeps meaning what it meant.
    expect(BASE).toBe("55f86907f326880b8b687705b0595939");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, BASE)?.id).toBe("sessions/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WORKSPACE)?.id).toBe("sessions-workspace/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WRITE)?.id).toBe("sessions-workspace-write/v1");
  });

  it("stamps a read-only grant with a read-only digest even on a host that can write", () => {
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["read_workspace_text"])?.digest).toBe(WORKSPACE);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["replace_workspace_text"])?.digest).toBe(WRITE);
  });
});

describe("the owner-local self-service contract", () => {
  it("is a new contract and leaves every historical contract unchanged", () => {
    const current = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
    );
    expect(current).not.toBe(BASE);
    expect(current).not.toBe(WORKSPACE);
    expect(current).not.toBe(WRITE);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, current)?.id)
      .toBe("sessions-workspace-write-crdt-self-service/v1");
    expect(SESSION_PLUS_PERMISSION_CONTRACT.autoAllow).not.toContain("start_session");
    expect(SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT.autoAllow)
      .not.toContain("replace_workspace_text");
  });

  it("silences only owner-local actions, not shared edits or outbound sends", () => {
    expect(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.autoAllow)
      .toEqual([...SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW, "read_document"]);
    expect(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.autoAllow).toEqual(expect.arrayContaining([
      "start_session",
      "append_session",
      "replace_workspace_text",
    ]));
    expect(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.autoAllow).not.toContain("edit_document");
    expect(SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT.operations).not.toContain("send_notification");
  });
});

describe("the chat upload contract", () => {
  it("adds exactly the device-temporary write to the terminal ask", () => {
    expect([...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS]).toEqual([
      ...SESSION_PLUS_TERMINAL_OPERATIONS,
      "upload_session_file",
    ]);
    expect(SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow).toEqual([
      ...SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT.autoAllow,
      "upload_session_file",
    ]);
  });

  it("is a new immutable ask and resolves to v4", () => {
    const upload = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
    );
    const terminal = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT,
    );
    expect(upload).not.toBe(terminal);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, upload)?.id)
      .toBe("sessions-workspace-write-crdt-self-service/v4");
  });
});

describe("the file download contract", () => {
  it("adds exactly the separately disclosed regular-file read and resolves to v5", () => {
    expect([...SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS]).toEqual([
      ...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS,
      "download_workspace_file",
    ]);
    expect(SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT.autoAllow).toEqual([
      ...SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow,
      "download_workspace_file",
    ]);
    const digest = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT,
    );
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, digest)?.id)
      .toBe("sessions-workspace-write-crdt-self-service/v5");
  });
});

describe("the owner Runner files contract", () => {
  it("adds one separate owner-local read and leaves workspace tokens unchanged", () => {
    expect([...SESSION_PLUS_OWNER_FILES_OPERATIONS]).toEqual([
      ...SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS,
      "access_owner_files",
    ]);
    expect(SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT.autoAllow).toEqual([
      ...SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT.autoAllow,
      "access_owner_files",
    ]);
    const digest = sessionPlusPermissionContractDigest(
      SESSION_PLUS_PUBLISHER,
      SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
    );
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, digest)?.id)
      .toBe("sessions-workspace-write-crdt-self-service/v6");
    expect(SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT.operations).not.toContain("access_owner_files");
  });
});

describe("the owner Runner write contract", () => {
  it("adds a distinct CAS write without reinterpreting any historical consent", () => {
    expect(SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS).toEqual([
      ...SESSION_PLUS_OWNER_FILES_OPERATIONS, "replace_owner_text",
    ]);
    expect(SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT.autoAllow).toEqual([
      ...SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT.autoAllow, "replace_owner_text",
    ]);
    const current = sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, current)?.id)
      .toBe("sessions-workspace-write-crdt-self-service/v7");
    const previous = sessionPlusPermissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT);
    expect(current).not.toBe(previous);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, previous)?.contract.operations)
      .not.toContain("replace_owner_text");
  });
});

describe("the notify contract", () => {
  it("adds exactly one operation to the write ask, and it is the outbound message", () => {
    expect([...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS]).toEqual([
      ...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
      "send_notification",
    ]);
  });

  it("is a fourth digest, distinct from all three older asks", () => {
    // The whole mechanism, once more. Four asks, four digests, and none of them
    // resolves to another: a person who agreed to any of the first three has
    // said nothing about being messaged on a chat platform.
    expect(new Set([BASE, WORKSPACE, WRITE, NOTIFY]).size).toBe(4);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, NOTIFY)?.id)
      .toBe("sessions-workspace-write-notify/v1");
  });

  it("leaves all three older asks byte for byte where they were", () => {
    expect(BASE).toBe("55f86907f326880b8b687705b0595939");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, BASE)?.id).toBe("sessions/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WORKSPACE)?.id).toBe("sessions-workspace/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WRITE)?.id).toBe("sessions-workspace-write/v1");
  });

  it("never auto-allows the send, in the ask a person is shown", () => {
    // An outbound message is `modify`-class, so the account root would refuse to
    // auto-allow it whatever a grant said. Stated here too because this list is
    // what a consent screen renders, and a screen offering unsupervised
    // messaging would describe something that cannot happen.
    expect(SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT.autoAllow)
      .not.toContain("send_notification");
    expect(SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT.autoAllow)
      .toEqual([...SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT.autoAllow]);
  });

  it("files the send under operations, not under deliveries", () => {
    // `deliveries` is the engine's cross-scope delivery vocabulary — a trusted
    // user directory, a recipient-side policy, a fixed envelope. None of that
    // was built, and `IntentGrantResolver` records no delivery grants at all, so
    // filing the token there would be both a claim about an apparatus that does
    // not exist and an unenforceable one.
    expect(SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT.deliveries).toEqual([]);
    expect(SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT.operations)
      .toContain("send_notification");
  });

  it("stamps a grant that stops short of the send with a digest that stops short too", () => {
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, [...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS])?.digest)
      .toBe(WRITE);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["send_notification"])?.digest).toBe(NOTIFY);
  });
});

describe("the crdt contract", () => {
  const CRDT = sessionPlusPermissionContractDigest(
    SESSION_PLUS_PUBLISHER,
    SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  );

  it("adds exactly the two document tokens to the write ask", () => {
    expect([...SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS]).toEqual([
      ...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
      "read_document",
      "edit_document",
    ]);
  });

  it("is a fifth digest, distinct from all four older asks", () => {
    // A person who agreed to rewrite files they can see has said nothing about
    // a durable document other people are also editing.
    expect(new Set([BASE, WORKSPACE, WRITE, NOTIFY, CRDT]).size).toBe(5);
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, CRDT)?.id).toBe("sessions-workspace-write-crdt/v1");
  });

  it("leaves all four older asks byte for byte where they were", () => {
    expect(BASE).toBe("55f86907f326880b8b687705b0595939");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, BASE)?.id).toBe("sessions/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WORKSPACE)?.id).toBe("sessions-workspace/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, WRITE)?.id).toBe("sessions-workspace-write/v1");
    expect(sessionPlusContractFor(SESSION_PLUS_PUBLISHER, NOTIFY)?.id).toBe("sessions-workspace-write-notify/v1");
  });

  it("auto-allows the read beside the other reads, and the edit lease never", () => {
    // `read_document` is read-effect and joins the auto-allow list; the lease
    // is `modify`-class — the account root would refuse it whatever a grant
    // said, and this list is what a consent screen renders.
    expect(SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT.autoAllow).toContain("read_document");
    expect(SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT.autoAllow).not.toContain("edit_document");
  });

  it("stamps a grant holding the document tokens with the fifth digest", () => {
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["read_document"])?.digest).toBe(CRDT);
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["edit_document"])?.digest).toBe(CRDT);
    // Older grants keep resolving to older digests on a host that also
    // implements the fifth — narrowest-first is the mechanism.
    expect(sessionPlusContractCovering(SESSION_PLUS_PUBLISHER, ["read_workspace_text"])?.digest).toBe(WORKSPACE);
  });
});
