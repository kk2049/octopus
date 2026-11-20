/**
 * The one place a real directory becomes a comparable token.
 *
 * ── Why one object, shared by two projections ──────────────────────────────
 *
 * The whole point of a `directoryKey` is that a session row and a file row for
 * the same directory are byte-equal. Two minters — even two with the same
 * algorithm — would be two secrets, and the equality this exists to provide
 * would silently never hold. So this is constructed ONCE by the composition
 * root and handed to both the sessions projection and the workspace-files
 * provider; a second instance is a bug that produces no error, only an absence
 * of joins, which is why it is worth stating here rather than assuming.
 *
 * ── What goes in ───────────────────────────────────────────────────────────
 *
 *   domain · owner · publisher · app · device · workspaceId · relativePath
 *
 * The last three name the directory the way this platform already names
 * directories, on the device that resolved it. The first four scope it: a key
 * is meaningless across accounts, publishers, apps and machines, and making that
 * structural is what stops it from becoming a cross-account identifier for a
 * place on somebody's disk.
 *
 * The instance is deliberately NOT an input. A join happens inside one tab, and
 * two tabs belonging to one person looking at one directory getting different
 * keys would buy no security property while making the sessions plane and the
 * files plane disagree the moment they resolved an instance differently.
 *
 * ── What comes out, and what does not ──────────────────────────────────────
 *
 * A truncated HMAC. Not reversible, not a lookup key: NOTHING on the trusted
 * side maps a key back to a directory, so a consumer submitting one finds no
 * code path that would accept it. That is the same property the ref vault gets
 * from randomness, obtained here without keeping a table — and it is why the key
 * can be projected while a workspace id and a relative path cannot.
 *
 * ── Lifetime ───────────────────────────────────────────────────────────────
 *
 * The secret is process-lifetime and never persisted. Keys are compared inside
 * one browser tab, whose instance handle does not survive a bot restart anyway,
 * so there is no consumer of stability across restarts — and a persisted secret
 * would be an asset whose only use, once leaked, is confirming guesses about
 * somebody's directory layout. Rotation therefore happens exactly at restart,
 * and NOT when a resource generation, a grant or a device credential changes:
 * those change what may be read, not which directory is which.
 */

import { createHmac, randomBytes } from "node:crypto";

/** The trusted-side facts a key is minted from. None of them are projected. */
export interface WorkspaceDirectoryIdentity {
  owner: string;
  publisher: string;
  app: string;
  /** The gateway's routing selector for the machine. Never projected. */
  device: string;
  /** The device's own opaque workspace id. Never projected. */
  workspaceId: string;
  /** `""` is the workspace root. Never projected. */
  relativePath: string;
}

/**
 * Versioned, so a later change to what is hashed cannot be mistaken for the
 * same key. It is part of the HMAC input as well as the prefix: a build that
 * changed the tuple and forgot the prefix would still mint different keys.
 */
const DOMAIN = "workspace-files/directory-key/1";

/** `dk1_` + 128 bits, base64url. Bounded, printable, compared, never parsed. */
const PREFIX = "dk1_";

export class WorkspaceDirectoryKeys {
  private readonly secret: Buffer;

  constructor(secret?: Buffer) {
    // A caller-supplied secret exists for tests that need two minters to agree
    // or to differ on purpose. Production never passes one.
    this.secret = secret ?? randomBytes(32);
  }

  /**
   * Mint the key for one directory, or null when it cannot be named.
   *
   * Null rather than a fallback: the caller omits the field, and the consumer's
   * contract says an absent key means "not promised". Every alternative here —
   * hashing a label, hashing a display path, hashing an empty string — produces
   * a key that COMPARES, which is worse than no key at all.
   */
  mint(identity: WorkspaceDirectoryIdentity): string | null {
    const { owner, publisher, app, device, workspaceId, relativePath } = identity;
    if (!owner || !publisher || !app || !device || !workspaceId) return null;
    if (typeof relativePath !== "string") return null;
    // A length-preserving JSON tuple, so no component can impersonate a
    // boundary — the same reason `refs.ts` builds its identity key this way.
    const tuple = JSON.stringify([DOMAIN, owner, publisher, app, device, workspaceId, relativePath]);
    const digest = createHmac("sha256", this.secret).update(tuple, "utf8").digest();
    return PREFIX + digest.subarray(0, 16).toString("base64url");
  }
}
