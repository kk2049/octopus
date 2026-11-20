/**
 * Session Plus' permission vocabulary — now FIVE exact contracts, not one.
 *
 * These strings are used unchanged by the declaration, grant_intents,
 * HostCapabilities and the kernel Gate. UI aliases never enter this file.
 *
 * ── Why a closed catalog of contracts rather than one constant ──────────────
 *
 * A release names the permission contract it declares by digest, and a release
 * can now be INSTALLED — bytes that arrived from somewhere, activated later,
 * rolled back afterwards. So at any moment this process may be serving the old
 * six-token ask, the new eight-token one, or (during a rollback) both across
 * two open tabs.
 *
 * Two rules follow, and both are the difference between "an expansion needs
 * consent" and "an expansion happens":
 *
 *  · **A digest is resolved to THAT contract, never to the current constant.**
 *    An unknown digest is refused — a release whose ask this build cannot
 *    project, grant or audit is one it must not run, whether the ask is wider
 *    OR narrower than what is implemented here.
 *  · **An instance keeps the contract it was opened under.** Resolving a grant
 *    against "whatever is active now" would let an activation re-interpret a
 *    tab that a person opened, and consented to, under a narrower ask.
 *
 * The workspace operations are served by a SEPARATE capability Object
 * (`workspace-files-runner-v2`). Adding them to an ask does not widen the
 * sessions plane; it makes a second plane reachable, once somebody agrees.
 *
 * The third contract adds the first operation in this catalog that CHANGES a
 * user's data. It is a separate contract for exactly the reason the second one
 * was: an ask somebody agreed to must not acquire new meaning underneath them.
 *
 * The fourth adds the first operation that LEAVES this machine. Same reason
 * again, and the reasons do not merge: "may overwrite a file I can see" and
 * "may send me a message on a chat platform" are two decisions, and a person who
 * made the first one has not made the second.
 */

import {
  contractDigestOf,
  type PermissionContract as EnginePermissionContract,
} from "@claude-bot/engine";

/** Never derived from a hostname, package digest or deployment. */
export const SESSION_PLUS_APP_ID = "session-plus";
export const SESSION_PLUS_PUBLISHER = "octopus:first-party";

export const SESSION_PLUS_OPERATIONS = [
  "list_recent_sessions",
  "search_sessions",
  "read_session",
  "list_session_workspaces",
  "start_session",
  "append_session",
] as const;

export type SessionPlusOperation = (typeof SESSION_PLUS_OPERATIONS)[number];

export const SESSION_PLUS_AUTO_ALLOW = [
  "list_recent_sessions",
  "search_sessions",
  "read_session",
  "list_session_workspaces",
] as const satisfies readonly SessionPlusOperation[];

/** Current owner's trusted Sessions surface: reads plus explicit start/append. */
export const SESSION_PLUS_OWNER_AUTO_ALLOW = [
  ...SESSION_PLUS_AUTO_ALLOW,
  "start_session",
  "append_session",
] as const satisfies readonly SessionPlusOperation[];

/** Operations served by the session host planes rather than a typed resource. */
export const SESSION_PLUS_RUNNER_OPERATIONS = [
  ...SESSION_PLUS_OPERATIONS,
  "upload_session_file",
  "open_workspace_terminal",
  "workspace_terminal",
] as const;

export const SESSION_PLUS_RUNNER_OWNER_AUTO_ALLOW = [
  ...SESSION_PLUS_OWNER_AUTO_ALLOW,
  "upload_session_file",
  "open_workspace_terminal",
  "workspace_terminal",
] as const;

/**
 * Only the owner's own page opens a terminal without a card (O1). A share
 * guest acting through the owner's planes still asks the owner, because that
 * is a shell on somebody else's machine.
 */
export const SESSION_PLUS_OWNER_ONLY_SILENT: readonly string[] = ["open_workspace_terminal"];

/** Small release-facing shape retained for identity and disclosure views. */
export interface SessionPlusPermissionContract {
  operations: readonly string[];
  autoAllow: readonly string[];
  deliveries: readonly string[];
}

export const SESSION_PLUS_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_OPERATIONS]),
  autoAllow: Object.freeze([...SESSION_PLUS_AUTO_ALLOW]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * The read-only workspace browser's ask: the same six, plus two reads.
 *
 * `list_session_workspaces` is deliberately REUSED rather than duplicated — the
 * file tree's root enumeration is the same question the new-agent form already
 * asks, and a third permission name for it would be a second thing to grant for
 * one capability.
 *
 * Both additions are `read`, so both may be auto-allowed once granted; neither
 * is a write, a watch, an exec, an arbitrary path or a delivery. Widening this
 * list is a contract change with a new digest, which is the whole mechanism.
 */
export const SESSION_PLUS_WORKSPACE_OPERATIONS = [
  ...SESSION_PLUS_OPERATIONS,
  "list_workspace_entries",
  "read_workspace_text",
] as const;

export const SESSION_PLUS_WORKSPACE_AUTO_ALLOW = [
  ...SESSION_PLUS_AUTO_ALLOW,
  "list_workspace_entries",
  "read_workspace_text",
] as const satisfies readonly (typeof SESSION_PLUS_WORKSPACE_OPERATIONS)[number][];

export const SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_WORKSPACE_OPERATIONS]),
  autoAllow: Object.freeze([...SESSION_PLUS_WORKSPACE_AUTO_ALLOW]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * The read-only browser's ask, plus the one write.
 *
 * ── Why a third contract rather than a wider second one ────────────────────
 *
 * Because widening `sessions-workspace/v1` in place would change its digest, and
 * everything downstream treats a digest as "the thing somebody agreed to". A
 * person who consented to eight read tokens would find their consent silently
 * reinterpreted as covering a file overwrite — which is the exact failure the
 * closed catalog exists to make impossible. So the eight-token ask keeps its
 * digest and its meaning, and wanting to write means asking a new question.
 *
 * This historical contract remains immutable: its write required per-call
 * approval. The self-service contract below is the new release's explicit ask.
 */
export const SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS = [
  ...SESSION_PLUS_WORKSPACE_OPERATIONS,
  "replace_workspace_text",
] as const;

export const SESSION_PLUS_WORKSPACE_WRITE_AUTO_ALLOW =
  SESSION_PLUS_WORKSPACE_AUTO_ALLOW satisfies readonly (typeof SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS)[number][];

/**
 * Safe defaults for the owner's own trusted Session Plus surface. Shared CRDT
 * and outbound notification tokens are intentionally absent.
 */
export const SESSION_PLUS_SELF_SERVICE_OPERATIONS = SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS;
export const SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW = [
  ...SESSION_PLUS_OWNER_AUTO_ALLOW,
  "list_workspace_entries",
  "read_workspace_text",
  "replace_workspace_text",
] as const satisfies readonly (typeof SESSION_PLUS_SELF_SERVICE_OPERATIONS)[number][];

/**
 * Everything on the owner's OWN sessions, workspaces, files and terminals.
 * The owner's trusted page holds these without a consent click and never asks
 * per call (O1): shared documents (CRDT) and outbound notification are the only
 * Session Plus operations that still need a real consent or approval.
 */
export const SESSION_PLUS_OWNER_LOCAL_OPERATIONS: readonly string[] = [
  ...SESSION_PLUS_SELF_SERVICE_OPERATIONS,
  "read_workspace_binary",
  "open_workspace_terminal",
  "workspace_terminal",
  "upload_session_file",
  "download_workspace_file",
  "access_owner_files",
  "replace_owner_text",
];

export const SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS]),
  autoAllow: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_AUTO_ALLOW]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * The write ask, plus the first operation that leaves this machine.
 *
 * ── Why a FOURTH contract rather than a wider third one ────────────────────
 *
 * The same rule, applied once more: a digest is what somebody agreed to, so
 * widening one in place re-interprets an agreement rather than asking for a new
 * one. A person who allowed an App to rewrite a file in a workspace they chose
 * has said nothing at all about whether it may message them on a chat platform;
 * those are not degrees of one permission, they are two.
 *
 * `send_notification` is an `operations` token and NOT a `deliveries` one. The
 * `deliveries` list is the engine's cross-scope delivery vocabulary (SEC-01:
 * one Object per (app, sender), a trusted user directory, a recipient-side
 * policy that defaults to refusing). `notify/v1` is none of that — it is a typed
 * port whose recipients are minted by the trusted side and whose only reachable
 * target today is the scope's own owner. Filing it under `deliveries` would
 * claim an apparatus that was never built, and `IntentGrantResolver` records no
 * delivery grants at all, so the claim would also be unenforceable.
 *
 * Auto-allow is unchanged from the owner-local write ask: an outbound message
 * remains outside the silent set even though local compare-and-swap writes are
 * included.
 *
 * ── The one thing that must happen before a release may declare this ───────
 *
 * `send_notification` is served by a DELIVERY PATH, not by a capability Object,
 * so there is no Gate between the App and the send: once granted, the provider
 * delivers within its rate limit and queues no approval card. The catalog row
 * for it declares `alwaysApprove: true`, which is the policy this operation must
 * carry, and today that policy has nothing enforcing it.
 *
 * That gap is why no release shape declares this contract: `SHAPE_CONTRACT` in
 * `session-plus-adapter.ts` pairs each shape with exactly one contract, none of
 * them this one, so a release naming this digest is `installed / unsupported`
 * and a person is never shown a consent row promising an approval that will not
 * arrive. Whatever mechanism eventually lets a release declare a contract of its
 * choosing has to close that gap first — either a notify capability Object, or a
 * consent row that says plainly that sends are unsupervised.
 */
export const SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS = [
  ...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
  "send_notification",
] as const;

export const SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_AUTO_ALLOW =
  SESSION_PLUS_WORKSPACE_WRITE_AUTO_ALLOW satisfies
    readonly (typeof SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS)[number][];

export const SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_OPERATIONS]),
  autoAllow: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_AUTO_ALLOW]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * The write ask, plus the two collaborative-document tokens.
 *
 * ── Why a FIFTH contract, and why it exists only now ───────────────────────
 *
 * The same digest rule, applied once more: a person who allowed an App to
 * rewrite files they can see has said nothing about letting it into a durable
 * document other people are also editing. Those are two decisions, so the
 * nine-token digest keeps its meaning and this is a new question.
 *
 * A version of this contract was written on 2026-08-09 and WITHDRAWN, because
 * the platform refused it: `edit_document` is `modify`-class, the catalog
 * forbids auto-allowing a `modify`, and the provider then served merges with
 * no Gate in between — so `alwaysApprove` would have been a promise with
 * nothing delivering it. What unblocked it is the `crdt-doc-v1` capability
 * Object (`crdt-doc/capability.ts`): every read now passes the kernel, and an
 * edit is a per-(instance, document) LEASE the kernel turns into exactly the
 * approval card the consent row promises.
 *
 * `read_document` joins the auto-allow list beside the other reads; the lease
 * never does, and could not be honoured if written — the account root's terms
 * only ever cover observe/read, and `derive` attenuates.
 */
export const SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS = [
  ...SESSION_PLUS_WORKSPACE_WRITE_OPERATIONS,
  "read_document",
  "edit_document",
] as const;

export const SESSION_PLUS_WORKSPACE_WRITE_CRDT_AUTO_ALLOW = [
  ...SESSION_PLUS_WORKSPACE_WRITE_AUTO_ALLOW,
  "read_document",
] as const satisfies readonly (typeof SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS)[number][];

export const SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS]),
  autoAllow: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_CRDT_AUTO_ALLOW]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * The new owner-local release contract.
 *
 * It asks for the same eleven operations as the CRDT release, but explicitly
 * makes the owner's local session/workspace actions silent. Collaborative
 * editing still requires its per-instance lease; reading a separately granted
 * shared document may remain silent after that real consent.
 */
export const SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW,
    "read_document",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * Current owner-local release: the self-service contract plus bounded media
 * reads. This is a new digest; every historical ask above remains immutable.
 */
export const SESSION_PLUS_EXPERIENCE_OPERATIONS = [
  ...SESSION_PLUS_WORKSPACE_WRITE_CRDT_OPERATIONS,
  "read_workspace_binary",
] as const;

export const SESSION_PLUS_EXPERIENCE_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_EXPERIENCE_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_SELF_SERVICE_AUTO_ALLOW,
    "read_document",
    "read_workspace_binary",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * Current fast workspace release. Opening a terminal always crosses one
 * trusted approval gate. The resulting opaque lease is bound to this App
 * instance; only read/input/close inside that lease use the auto-allowed
 * operation, so command entry never degrades into per-command approval cards.
 */
export const SESSION_PLUS_TERMINAL_OPERATIONS = [
  ...SESSION_PLUS_EXPERIENCE_OPERATIONS,
  "open_workspace_terminal",
  "workspace_terminal",
] as const;

export const SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_TERMINAL_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_EXPERIENCE_PERMISSION_CONTRACT.autoAllow,
    "workspace_terminal",
  ]),
  deliveries: Object.freeze([] as string[]),
});
/**
 * Current Session Plus release. Uploading writes only a device-created file
 * under `/tmp`, but that is still a new machine-side write and therefore a new
 * immutable ask. Historical v3 grants retain their terminal-only meaning.
 */
export const SESSION_PLUS_CHAT_UPLOAD_OPERATIONS = [
  ...SESSION_PLUS_TERMINAL_OPERATIONS,
  "upload_session_file",
] as const;

export const SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT.autoAllow,
    "upload_session_file",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * Current Session Plus release. Generic downloads can read regular-file bytes
 * beyond the media formats covered by v4, so they receive a distinct operation
 * and immutable consent digest.
 */
export const SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS = [
  ...SESSION_PLUS_CHAT_UPLOAD_OPERATIONS,
  "download_workspace_file",
] as const;

export const SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT.autoAllow,
    "download_workspace_file",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/**
 * Current owner-local release. `access_owner_files` is intentionally distinct
 * from every workspace-scoped token: it addresses only the authenticated
 * owner's Runner and lets that Runner's OS account decide accessibility, with
 * no workspace registry lookup or containment comparison. Historical contracts
 * keep their workspace-only meaning for future shared/file-scope grants.
 */
export const SESSION_PLUS_OWNER_FILES_OPERATIONS = [
  ...SESSION_PLUS_FILE_DOWNLOAD_OPERATIONS,
  "access_owner_files",
] as const;

export const SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_OWNER_FILES_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT.autoAllow,
    "access_owner_files",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/** New consent for owner-local writes; v6's read-only token stays immutable. */
export const SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS = [
  ...SESSION_PLUS_OWNER_FILES_OPERATIONS,
  "replace_owner_text",
] as const;

export const SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT: SessionPlusPermissionContract = Object.freeze({
  operations: Object.freeze([...SESSION_PLUS_OWNER_FILES_WRITE_OPERATIONS]),
  autoAllow: Object.freeze([
    ...SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT.autoAllow,
    "replace_owner_text",
  ]),
  deliveries: Object.freeze([] as string[]),
});

/** Stable names for the implemented asks. Never derived. */
export type SessionPlusContractId =
  | "sessions/v1"
  | "sessions-workspace/v1"
  | "sessions-workspace-write/v1"
  | "sessions-workspace-write-notify/v1"
  | "sessions-workspace-write-crdt/v1"
  | "sessions-workspace-write-crdt-self-service/v1"
  | "sessions-workspace-write-crdt-self-service/v2"
  | "sessions-workspace-write-crdt-self-service/v3"
  | "sessions-workspace-write-crdt-self-service/v4"
  | "sessions-workspace-write-crdt-self-service/v5"
  | "sessions-workspace-write-crdt-self-service/v6"
  | "sessions-workspace-write-crdt-self-service/v7";

export interface SessionPlusContractDefinition {
  readonly id: SessionPlusContractId;
  readonly contract: SessionPlusPermissionContract;
}

/**
 * Every permission contract this build can honour, as a CLOSED list.
 *
 * Order is oldest first, and it matters in exactly one place:
 * `sessionPlusContractCovering` prefers the narrowest contract that contains a
 * set of operations, so a six-token grant is stamped with the six-token digest
 * even on a host that also implements the eight.
 */
export const SESSION_PLUS_CONTRACTS: readonly SessionPlusContractDefinition[] = Object.freeze([
  Object.freeze({ id: "sessions/v1" as const, contract: SESSION_PLUS_PERMISSION_CONTRACT }),
  Object.freeze({ id: "sessions-workspace/v1" as const, contract: SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT }),
  Object.freeze({
    id: "sessions-workspace-write/v1" as const,
    contract: SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-notify/v1" as const,
    contract: SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt/v1" as const,
    contract: SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v1" as const,
    contract: SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v2" as const,
    contract: SESSION_PLUS_EXPERIENCE_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v3" as const,
    contract: SESSION_PLUS_TERMINAL_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v4" as const,
    contract: SESSION_PLUS_CHAT_UPLOAD_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v5" as const,
    contract: SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v6" as const,
    contract: SESSION_PLUS_OWNER_FILES_PERMISSION_CONTRACT,
  }),
  Object.freeze({
    id: "sessions-workspace-write-crdt-self-service/v7" as const,
    contract: SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  }),
]);

/**
 * The union of every operation any implemented contract may declare.
 *
 * Order matters exactly once: the human-disclosure catalog lists its rows in
 * this order and the two are asserted equal at composition.
 */
export const SESSION_PLUS_ALL_OPERATIONS: readonly string[] = Object.freeze([
  ...SESSION_PLUS_OPERATIONS,
  "list_workspace_entries",
  "read_workspace_text",
  "read_workspace_binary",
  "download_workspace_file",
  "access_owner_files",
  "replace_owner_text",
  "replace_workspace_text",
  "upload_session_file",
  "send_notification",
  "read_document",
  "edit_document",
  "open_workspace_terminal",
  "workspace_terminal",
]);

/** Build exactly the contract HostCapabilities builds for this app. */
export function sessionPlusEngineContract(
  publisher = SESSION_PLUS_PUBLISHER,
  contract: SessionPlusPermissionContract = SESSION_PLUS_PERMISSION_CONTRACT,
): EnginePermissionContract {
  return {
    app: SESSION_PLUS_APP_ID,
    publisher,
    operations: contract.operations,
    autoAllow: contract.autoAllow,
    actions: {},
    agents: {},
    delivery: contract.deliveries,
  };
}

/** One digest implementation for release identity, grants and engine Contexts. */
export function sessionPlusPermissionContractDigest(
  publisher = SESSION_PLUS_PUBLISHER,
  contract: SessionPlusPermissionContract = SESSION_PLUS_PERMISSION_CONTRACT,
): string {
  return contractDigestOf(sessionPlusEngineContract(publisher, contract));
}

/**
 * Which known contract a digest names, for one publisher — or null.
 *
 * The lookup is exact and closed. There is no "closest match" and no fallback
 * onto the current constant: a digest this build does not recognise belongs to
 * an ask it cannot project on a consent screen, cannot map onto Gate tokens and
 * cannot audit, so the only honest answer is that it has none.
 *
 * The publisher is an input because it is INSIDE the digest — the same
 * operations vouched for by somebody else is a different thing to agree to.
 */
export function sessionPlusContractFor(
  publisher: string,
  digest: string,
): SessionPlusContractDefinition | null {
  for (const row of SESSION_PLUS_CONTRACTS) {
    if (sessionPlusPermissionContractDigest(publisher, row.contract) === digest) return row;
  }
  return null;
}

/** The contract this build ships under one stable id. */
export function sessionPlusContractById(id: SessionPlusContractId): SessionPlusPermissionContract {
  const row = SESSION_PLUS_CONTRACTS.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`unknown session plus contract id: ${id}`);
  return row.contract;
}

/**
 * The narrowest implemented contract that CONTAINS these operations, or null.
 *
 * Used when a grant is recorded: a row's `contract_digest` is a statement about
 * which ask the person was answering, so stamping a six-operation consent with
 * the eight-operation digest would record an agreement nobody made — and would
 * make the "the contract changed, please re-consent" banner disappear at the
 * exact moment it is needed.
 */
export function sessionPlusContractCovering(
  publisher: string,
  operations: readonly string[],
): { definition: SessionPlusContractDefinition; digest: string } | null {
  const wanted = new Set(operations.map(String));
  for (const definition of SESSION_PLUS_CONTRACTS) {
    if ([...wanted].every((operation) => definition.contract.operations.includes(operation))) {
      return { definition, digest: sessionPlusPermissionContractDigest(publisher, definition.contract) };
    }
  }
  return null;
}
