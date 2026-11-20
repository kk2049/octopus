/**
 * `directoryKey` — an opaque equality token for "the same real directory".
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * Two projections describe the same machine from different angles: a session
 * roster says where an agent is running, a file listing says what is in a
 * directory. Nothing on either side could say those are the SAME directory
 * without comparing display text — a label, a basename, a `~/…` string — and a
 * comparison of display text is a guess that becomes wrong exactly when two
 * projects are called `src`.
 *
 * A `directoryKey` replaces the guess. Equal keys mean one real directory;
 * different keys mean the consumer must not join. There is no third answer, and
 * an ABSENT key is not a weaker one: it means this side declined to promise, and
 * a consumer that fell back to matching labels would be reintroducing exactly
 * the defect the key exists to remove.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * It is not authority, not a `ref`, and not an address. Nothing on this contract
 * accepts one as input: `listDirectory`, `openText` and `replaceText` take refs,
 * and a ref is minted by the trusted provider from its own vault. The trusted
 * side keeps NO reverse index from a key to anything, so submitting one is not a
 * claim about anything — the same property `refs.ts` gets from randomness, this
 * one gets from being a one-way function nobody looks up.
 *
 * It is also not stable across processes, owners, publishers, apps or devices.
 * Two people looking at one directory get two different keys. That is deliberate:
 * a key that survived those boundaries would be a cross-account identifier for a
 * place on somebody's disk.
 *
 * ── Grammar ────────────────────────────────────────────────────────────────
 *
 * `dk1_` plus base64url. The version prefix is there so a later change of what
 * is hashed cannot be mistaken for the same key; the length bound is here rather
 * than in `WORKSPACE_FILES_LIMITS` because that object is v1's and v1 does not
 * have this field.
 */

/** Everything a key may be, before it is anything else: bounded and printable. */
export const WORKSPACE_DIRECTORY_KEY_MAX_LENGTH = 64;

/** The one version this build mints and the only one it reads. */
export const WORKSPACE_DIRECTORY_KEY_PREFIX = "dk1_";

const DIRECTORY_KEY = /^dk1_[A-Za-z0-9_-]{16,59}$/;

/**
 * Is this a key this build could have minted?
 *
 * Checked on arrival like every other field: the producer is trusted code today
 * and a different release tomorrow, and a value that is not a key of ours is a
 * producer that is wrong rather than a directory we cannot identify.
 */
export function isWorkspaceDirectoryKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= WORKSPACE_DIRECTORY_KEY_MAX_LENGTH
    && DIRECTORY_KEY.test(value);
}
