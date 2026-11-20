/**
 * Two digests, because "what runs" and "what it may do" are two questions
 * (SEC-02).
 *
 *     codeDigest
 *       app.yaml + actions.ts + projection.ts + prompts/**
 *       — everything that decides what executes and under which predicate.
 *       A change rotates every running Context and invalidates every instance
 *       handle and every undecided approval. It is an INTERNAL lifecycle event,
 *       not a revocation: the persistent grant is untouched and the next launch
 *       re-derives from it, so a first-party bugfix does not interrupt anybody.
 *
 *     permissionContractDigest
 *       requested operations, auto-allow, the delivery operations, and the
 *       publisher identity. A change here is what a user or an operator agreed
 *       to. Widening it is fail-closed: the extra operations are simply not
 *       derived until somebody authorises the new contract. (Per-action and
 *       per-agent narrowing has a place in the shape but is empty from today's
 *       config surface; `HostCapabilities.contractOf` says why that cannot
 *       widen anything.)
 *
 * Deliberately NOT in the contract digest: an operation's argument schema,
 * effect and retry-safety. Those belong to the Object's own semantic version
 * (SEC-05), which is a separate piece of work with its own migration story;
 * folding them in here would make this digest change for reasons the user never
 * agreed to and could not be shown.
 *
 * ── Where a grant comes from TODAY, stated plainly ────────────────────────
 *
 * There is no install-and-consent flow yet, and this file does not pretend
 * otherwise. Today the deployment's operator config IS the authorisation act: a
 * human edits `v3_host.apps.*` and restarts, and `GrantLedger.seed()` records
 * that as a grant with `source: "config"`. What the ledger adds is the part
 * that was missing: a recorded contract to compare the DECLARED one against, so
 * that a widening is visible and closed rather than silently in effect, and one
 * place for a real persistent backend to land later. `authorize()` is the seam
 * a permission UI will call; nothing calls it from a request path today.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Files that decide what actually executes, relative to the app directory. */
const EXEC_FILES = ["actions.ts", "projection.ts"] as const;
/** Directories whose every file is execution material (agent prompts). */
const EXEC_DIRS = ["prompts"] as const;
/** Presentation only: a page tweak must not cost anybody an approval. */
const PRESENTATION_DIRS = ["pages"] as const;

export interface AppVersion {
  /** Identity of everything that executes, including the declaration. */
  code: string;
  /** Identity of the executable files alone — used to decide a halt. */
  exec: string;
  /** Identity of the page material. Changes here rotate nothing. */
  presentation: string;
  /** Cheap (mtime, size) fingerprint used to skip the expensive read. */
  stamp: string;
  /**
   * True when the declaration failed to load AND the executable files have
   * moved since the last good release, i.e. we cannot say which version would
   * run. Serving the last good release is only honest while the last good
   * release is still what is on disk.
   */
  halted: boolean;
}

function listFiles(dir: string, subdirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const sub of subdirs) {
    const d = path.join(dir, sub);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile()) out.push(`${sub}/${e.name}`);
    }
  }
  return out;
}

function read(dir: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    // An absent file is part of the identity too, as an empty entry: deleting
    // actions.ts must change the digest, not leave it where it was.
    return "";
  }
}

function digestOfFiles(dir: string, rels: readonly string[]): string {
  const h = createHash("sha256");
  for (const rel of [...rels].sort()) h.update(rel).update("\0").update(read(dir, rel)).update("\0");
  return h.digest("hex").slice(0, 32);
}

/** Every file whose content is part of some digest. */
function materialOf(dir: string): { exec: string[]; presentation: string[]; all: string[] } {
  const exec = [...EXEC_FILES, ...listFiles(dir, EXEC_DIRS)];
  const presentation = listFiles(dir, PRESENTATION_DIRS);
  return { exec, presentation, all: ["app.yaml", ...exec, ...presentation] };
}

/**
 * A cheap fingerprint over (path, mtime, size) of the same material.
 *
 * This is what makes the version switch happen at the POINT OF USE rather than
 * whenever a filesystem watcher happens to fire. The watcher was the only
 * mechanism before, and it returned early for `.ts` files — so a code edit
 * produced exactly the state SEC-02 is about: the sandbox re-imported the new
 * module on the next call while the Context, the handle and the pending
 * approvals were still the old version's.
 */
export function stampOf(dir: string): string {
  const parts: string[] = [];
  for (const rel of materialOf(dir).all) {
    try {
      const st = fs.statSync(path.join(dir, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${rel}:-`);
    }
  }
  return parts.join("|");
}

/** Compute both digests plus the stamp, reading every file once. */
export function versionOf(dir: string): Omit<AppVersion, "halted"> {
  const m = materialOf(dir);
  return {
    code: digestOfFiles(dir, ["app.yaml", ...m.exec]),
    exec: digestOfFiles(dir, m.exec),
    presentation: digestOfFiles(dir, m.presentation),
    stamp: stampOf(dir),
  };
}

// ── permission contract ──

/**
 * What an app has asked to be allowed to do. Assembled by the plane from
 * trusted config — never from `app.yaml`, which is hot-pluggable material an
 * agent can write, and a manifest that declared its own rights would be an
 * application granting itself an application.
 */
export interface PermissionContract {
  app: string;
  /** Who published this app. A change here never inherits an old grant. */
  publisher: string;
  /** Resource operations the app applies for. */
  operations: readonly string[];
  /** Of those, the ones it may exercise with no decision per call. */
  autoAllow: readonly string[];
  /**
   * Per-action narrowing, as declared. Empty from today's config surface,
   * which exposes a lookup rather than an enumeration — see
   * `HostCapabilities.contractOf` for why that is safe (narrowing can only
   * subtract from `operations`, which IS digested) and what would change it.
   */
  actions: Readonly<Record<string, readonly string[]>>;
  /** Per-agent narrowing, as declared. Empty today, for the same reason. */
  agents: Readonly<Record<string, readonly string[]>>;
  /** Cross-scope transfer operations the app applies for. */
  delivery: readonly string[];
}

const sorted = (xs: readonly string[]): string[] => [...xs].map(String).sort();

export function contractDigestOf(c: PermissionContract): string {
  const canonical = {
    app: c.app,
    publisher: c.publisher,
    operations: sorted(c.operations),
    autoAllow: sorted(c.autoAllow),
    actions: Object.fromEntries(Object.entries(c.actions).sort().map(([k, v]) => [k, sorted(v)])),
    agents: Object.fromEntries(Object.entries(c.agents).sort().map(([k, v]) => [k, sorted(v)])),
    delivery: sorted(c.delivery),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export interface AppGrant {
  app: string;
  publisher: string;
  contractDigest: string;
  operations: readonly string[];
  autoAllow: readonly string[];
  delivery: readonly string[];
  grantedAt: number;
  /** How this grant came to exist. Today only "config" ever appears. */
  source: "config" | "user" | "admin";
}

export interface ContractVerdict {
  /** The grant covers everything the app currently declares. */
  ok: boolean;
  /** Declared-but-not-granted resource operations. Never derived. */
  missingOperations: string[];
  /** Declared-but-not-granted auto-allow entries. Never derived. */
  missingAutoAllow: string[];
  /** Declared-but-not-granted delivery operations. Never derived. */
  missingDelivery: string[];
  /** True when a person has to agree to something before this app can do it. */
  needsAuthorization: boolean;
  /** Absent grant, or a grant issued to a different publisher. */
  reason?: string;
}

/**
 * Resolve a declared contract against the durable grant for one account.
 *
 * `owner` is optional for compatibility with deployment-wide ledgers. A
 * per-account resolver treats its absence as no authority; the capability
 * plane always supplies it when deriving an App Context.
 */
export interface GrantResolver {
  check(c: PermissionContract, owner?: string): ContractVerdict;
  effective(
    c: PermissionContract,
    owner?: string,
  ): Pick<PermissionContract, "operations" | "autoAllow" | "delivery">;
}

/**
 * The record of what has been authorised, per app.
 *
 * Process-lifetime and in memory — which is the honest shape for a system whose
 * grants come from a config file read at boot. Making it durable is the same
 * change as giving it a real source, and both wait for the permission UI.
 */
export class GrantLedger implements GrantResolver {
  private grants = new Map<string, AppGrant>();

  constructor(private now: () => number = Date.now) {}

  /** Record the deployment config as the authorisation act. */
  seed(c: PermissionContract): AppGrant {
    return this.record(c, "config");
  }

  /**
   * A person (or an operator) agreeing to the contract as it now stands. The
   * seam a permissions UI calls; nothing reaches it from a request today.
   */
  authorize(c: PermissionContract, source: "user" | "admin" = "user"): AppGrant {
    return this.record(c, source);
  }

  private record(c: PermissionContract, source: AppGrant["source"]): AppGrant {
    const grant: AppGrant = {
      app: c.app,
      publisher: c.publisher,
      contractDigest: contractDigestOf(c),
      operations: sorted(c.operations),
      autoAllow: sorted(c.autoAllow),
      delivery: sorted(c.delivery),
      grantedAt: this.now(),
      source,
    };
    this.grants.set(c.app, grant);
    return grant;
  }

  forApp(app: string): AppGrant | null {
    return this.grants.get(app) ?? null;
  }

  revoke(app: string): void {
    this.grants.delete(app);
  }

  list(): AppGrant[] {
    return [...this.grants.values()].sort((a, b) => a.app.localeCompare(b.app));
  }

  /**
   * Compare what an app declares now against what was agreed.
   *
   * Narrowing is silently fine — removing a permission needs nobody's consent,
   * and the intersection below already produces the smaller set. Widening is
   * the case this exists for: the extra operations are reported as missing and
   * the caller derives without them. A publisher change grants nothing at all.
   */
  check(c: PermissionContract, _owner?: string): ContractVerdict {
    const grant = this.grants.get(c.app);
    if (!grant) {
      return {
        ok: false,
        missingOperations: sorted(c.operations),
        missingAutoAllow: sorted(c.autoAllow),
        missingDelivery: sorted(c.delivery),
        needsAuthorization: c.operations.length > 0 || c.delivery.length > 0,
        reason: "no grant recorded for this app",
      };
    }
    if (grant.publisher !== c.publisher) {
      return {
        ok: false,
        missingOperations: sorted(c.operations),
        missingAutoAllow: sorted(c.autoAllow),
        missingDelivery: sorted(c.delivery),
        needsAuthorization: true,
        reason: `grant belongs to publisher "${grant.publisher}", this release claims "${c.publisher}"`,
      };
    }
    const missingOperations = sorted(c.operations).filter((op) => !grant.operations.includes(op));
    const missingAutoAllow = sorted(c.autoAllow).filter((op) => !grant.autoAllow.includes(op));
    const missingDelivery = sorted(c.delivery).filter((op) => !grant.delivery.includes(op));
    const ok = !missingOperations.length && !missingAutoAllow.length && !missingDelivery.length;
    return {
      ok,
      missingOperations,
      missingAutoAllow,
      missingDelivery,
      needsAuthorization: !ok,
      reason: ok ? undefined : "the declared contract asks for more than was granted",
    };
  }

  /** What this app may actually use: declared ∩ granted. Never a superset. */
  effective(
    c: PermissionContract,
    _owner?: string,
  ): Pick<PermissionContract, "operations" | "autoAllow" | "delivery"> {
    const grant = this.grants.get(c.app);
    if (!grant || grant.publisher !== c.publisher) {
      return { operations: [], autoAllow: [], delivery: [] };
    }
    return {
      operations: c.operations.filter((op) => grant.operations.includes(op)),
      autoAllow: c.autoAllow.filter((op) => grant.autoAllow.includes(op)),
      delivery: c.delivery.filter((op) => grant.delivery.includes(op)),
    };
  }
}
