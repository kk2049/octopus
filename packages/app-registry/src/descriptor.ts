/**
 * The canonical description of one immutable Agentic App release.
 *
 * This file is the contract the later Runtime Host, permission catalog and
 * Dashboard adapter import. It knows nothing about React, the Dashboard,
 * Session Plus, SQLite or HTTP — it is types, framing and pure validation.
 *
 * ## Four identities, none derived from another
 *
 * ```text
 * stableAppId              what durable state and consent are keyed by
 * publisher                who vouches for the bytes
 * packageDigest            which complete release is running (addresses the origin)
 * permissionContractDigest what it is allowed to ask for
 * ```
 *
 * `packageDigest` is the runtime identity: the first 20 hex characters become
 * the DNS label a View is served from, so "which release is this frame bound
 * to" is answerable from the address bar. `permissionContractDigest` is a
 * separate question with a different answer shape — a code change with an
 * unchanged contract may keep a user's grant, while a widened contract must
 * fail closed until somebody agrees to it. Deriving one from the other would
 * make every typo fix look like a permission change and every permission
 * change look like a deploy.
 *
 * ## What the package digest covers, and why the sub-digests are not identities
 *
 * The digest covers what the release IS: identity, execution profile, the exact
 * named asset inventory with per-asset digests, the declared view/backend
 * composition, the source attestation and the deterministic build input.
 *
 * It deliberately does NOT cover the derived sub-digests in `evidence`. Those
 * are computed from inputs the digest already covers, so folding them in would
 * only let a WRONG claim mint a different identity instead of being rejected.
 * They are recomputed and compared here; a release whose evidence disagrees
 * with its own inventory is refused, not renamed.
 *
 * It also does not cover `permissionContractDigest`, which is the separate axis
 * above. The registry treats that value as opaque: computing it belongs to the
 * permission layer (the engine's `contractDigestOf` is the single
 * implementation), and a registry that computed its own would be a second
 * opinion about what an app asked for.
 *
 * `DESCRIPTOR_FIELD_COVERAGE` states this field by field, and the tests assert
 * the map is exhaustive — adding a field to the descriptor without deciding
 * whether it is part of the identity is a test failure, not a silent choice.
 */

import { createHash, type Hash } from "node:crypto";
import { posix } from "node:path";

// ── shape ──

export const RELEASE_SCHEMA_VERSION = 1 as const;

/**
 * How the release's code runs. A profile change never inherits an old trust
 * decision, which is why it is part of the identity rather than a deployment
 * setting: the same bytes under a different profile are a different release.
 * The values match the `app_trust.profile` check constraint.
 */
export type ExecutionProfile = "declarative" | "publisher-js";
export const EXECUTION_PROFILES: readonly ExecutionProfile[] = ["declarative", "publisher-js"];

/**
 * How the source snapshot behind the artifact is attested.
 *
 * `unattested` exists so a deployment can say so honestly rather than invent a
 * repository. There is no `signed` member: this system performs no publisher
 * signature verification, and a value that claimed otherwise would be a lie
 * with a type annotation.
 */
export type SourceAttestationKind = "platform-hosted" | "vcs" | "unattested";
export const SOURCE_ATTESTATION_KINDS: readonly SourceAttestationKind[] = [
  "platform-hosted",
  "vcs",
  "unattested",
];

/** One named byte string in the package. The name is never a path to follow. */
export interface ReleaseAsset {
  name: string;
  /** sha256 of the exact bytes, lowercase hex. */
  sha256: string;
  bytes: number;
}

/**
 * Which assets the browser gets and which the sandbox executes.
 *
 * The two lists may overlap: a shared JSON schema or type-only module can be
 * consumed by both at build time. What they may not do is disagree with the
 * inventory — every name here must exist in `assets`.
 */
export interface ReleaseComposition {
  view: readonly string[];
  backend: readonly string[];
}

/** The immutable source snapshot the artifact claims to come from. */
export interface SourceAttestation {
  kind: SourceAttestationKind;
  digest: string;
  repository: string;
  commit: string;
  subdir: string;
}

/** The deterministic recipe. Pinned inputs only; nothing that varies per run. */
export interface ReleaseBuildInput {
  entry: string;
  toolchain: {
    builder: string;
    format: string;
    lockfile: string;
  };
  lockfileHash: string;
}

/**
 * Derived digests. Evidence, not identity — see the file header.
 *
 * `viewDigest`/`backendDigest` cover exactly the assets named by
 * `composition`; `recipeDigest` covers `buildInput`. All three are recomputed
 * during validation, so they cannot be claimed.
 */
export interface ReleaseEvidence {
  viewDigest: string;
  backendDigest: string;
  recipeDigest: string;
}

export interface AppReleaseDescriptor {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  stableAppId: string;
  publisher: string;
  executionProfile: ExecutionProfile;
  packageDigest: string;
  permissionContractDigest: string;
  /** Canonical inventory: sorted by name, names unique. */
  assets: readonly ReleaseAsset[];
  composition: ReleaseComposition;
  source: SourceAttestation;
  buildInput: ReleaseBuildInput;
  evidence: ReleaseEvidence;
}

/**
 * Whether each descriptor field is an input to `packageDigest`.
 *
 *  · `covered`       — hashed; changing it produces a different release.
 *  · `derived`       — computed from covered inputs and verified, never hashed.
 *  · `separate-axis` — deliberately independent (see the file header).
 *  · `self`          — the digest itself.
 *  · `domain`        — encoded by the digest's domain-separation constant, so a
 *                      future schema version cannot collide with this one.
 */
export const DESCRIPTOR_FIELD_COVERAGE: Readonly<
  Record<keyof AppReleaseDescriptor, "covered" | "derived" | "separate-axis" | "self" | "domain">
> = Object.freeze({
  schemaVersion: "domain",
  stableAppId: "covered",
  publisher: "covered",
  executionProfile: "covered",
  packageDigest: "self",
  permissionContractDigest: "separate-axis",
  assets: "covered",
  composition: "covered",
  source: "covered",
  buildInput: "covered",
  evidence: "derived",
});

// ── limits ──

/**
 * Every bound a hostile candidate could otherwise choose.
 *
 * Defaults are generous enough for a React bundle with fonts and small images
 * and small enough that one install cannot exhaust the host. A deployment may
 * lower them; nothing may raise them implicitly.
 */
export interface RegistryLimits {
  maxAssets: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxNameLength: number;
  maxNameSegments: number;
  maxFieldLength: number;
  /** Diagnostics are bounded too: a candidate with 10 000 bad names is 32 issues. */
  maxIssues: number;
}

export const DEFAULT_LIMITS: RegistryLimits = Object.freeze({
  maxAssets: 2048,
  maxAssetBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxNameLength: 255,
  maxNameSegments: 12,
  maxFieldLength: 512,
  maxIssues: 32,
});

// ── diagnostics ──

export type RegistryIssueCode =
  | "schema_version"
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "field_type"
  | "field_length"
  | "identity_charset"
  | "execution_profile"
  | "source_kind"
  | "digest_format"
  | "asset_name"
  | "asset_order"
  | "asset_duplicate"
  | "asset_limit"
  | "asset_size"
  | "asset_total_size"
  | "asset_missing"
  | "asset_unexpected"
  | "asset_digest"
  | "composition_unknown_asset"
  | "evidence_mismatch"
  | "package_digest_mismatch"
  | "provenance"
  | "signature_verification"
  | "descriptor_conflict"
  | "provenance_conflict"
  | "unknown_release"
  | "removed_release"
  | "identity_mismatch"
  | "active_release"
  | "not_active"
  | "descriptor_invalid"
  | "content_missing"
  | "content_corrupt"
  | "content_write_failed";

export interface RegistryIssue {
  code: RegistryIssueCode;
  /** Bounded, human-readable. Never echoes asset bytes. */
  message: string;
  /** The field path or asset name the issue is about, if any. */
  at?: string;
}

const MESSAGE_MAX = 200;
const AT_MAX = 120;

export function issue(code: RegistryIssueCode, message: string, at?: string): RegistryIssue {
  const row: RegistryIssue = { code, message: clip(message, MESSAGE_MAX) };
  if (at !== undefined) row.at = clip(at, AT_MAX);
  return row;
}

/**
 * Truncate for a diagnostic, and make the truncation visible.
 *
 * Control characters are replaced rather than passed through: a diagnostic ends
 * up in logs, a terminal and eventually a page, and an asset name is attacker
 * chosen.
 */
function clip(value: string, max: number): string {
  const safe = value.replace(/[\x00-\x1f\x7f]/g, "\uFFFD");
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

/** Collects issues without letting a hostile input produce an unbounded report. */
export class IssueSink {
  private readonly rows: RegistryIssue[] = [];
  private suppressed = 0;

  constructor(private readonly limits: RegistryLimits = DEFAULT_LIMITS) {}

  add(code: RegistryIssueCode, message: string, at?: string): void {
    if (this.rows.length >= this.limits.maxIssues) {
      this.suppressed += 1;
      return;
    }
    this.rows.push(issue(code, message, at));
  }

  get empty(): boolean {
    return this.rows.length === 0;
  }

  drain(): RegistryIssue[] {
    if (this.suppressed > 0) {
      const tail = issue("field_length", `${this.suppressed} further problems were not reported`);
      return [...this.rows, tail];
    }
    return [...this.rows];
  }
}

// ── framing ──

/**
 * Domain separation. A digest computed under this constant can never equal one
 * computed for another purpose or another schema version, so `schemaVersion` is
 * covered without being a hashed field of its own.
 */
const PACKAGE_DIGEST_DOMAIN = "octopus:app-release:v1";
const RECIPE_DIGEST_DOMAIN = "octopus:app-release-recipe:v1";
const GROUP_DIGEST_DOMAIN = "octopus:app-release-group:v1";

/**
 * Length-prefixed, labelled fields.
 *
 * A bare concatenation lets two different releases agree — move a byte from one
 * asset name to the next and the stream is identical. The label makes the
 * position explicit and the length makes the encoding injective, so no
 * separator can be smuggled in a value.
 */
function field(h: Hash, label: string, value: string): void {
  h.update(`${label}\0${Buffer.byteLength(value, "utf8")}\0`, "utf8");
  h.update(value, "utf8");
}

/** How much of the digest addresses the host. 20 hex = 80 bits. */
export const PACKAGE_LABEL_HEX = 20;

/**
 * The leading DNS label a release is served from.
 *
 * Not stored on the descriptor: it is a pure function of the package digest,
 * and a stored copy is one more thing that can disagree with the identity.
 */
export function packageHostLabel(packageDigest: string): string {
  if (!isSha256Hex(packageDigest)) {
    throw new Error(`not a sha256 hex digest: ${clip(packageDigest, 16)}`);
  }
  return `app-${packageDigest.slice(0, PACKAGE_LABEL_HEX)}`;
}

export function sha256Of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function utf8Bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** The inputs to the package digest, in canonical form. */
export interface PackageDigestInput {
  stableAppId: string;
  publisher: string;
  executionProfile: ExecutionProfile;
  assets: readonly ReleaseAsset[];
  composition: ReleaseComposition;
  source: SourceAttestation;
  buildInput: ReleaseBuildInput;
}

export function computePackageDigest(input: PackageDigestInput): string {
  const h = createHash("sha256");
  field(h, "domain", PACKAGE_DIGEST_DOMAIN);
  field(h, "stableAppId", input.stableAppId);
  field(h, "publisher", input.publisher);
  field(h, "executionProfile", input.executionProfile);
  field(h, "assets.count", String(input.assets.length));
  for (const asset of input.assets) {
    field(h, "asset.name", asset.name);
    field(h, "asset.sha256", asset.sha256);
    field(h, "asset.bytes", String(asset.bytes));
  }
  for (const group of ["view", "backend"] as const) {
    const names = input.composition[group];
    field(h, `composition.${group}.count`, String(names.length));
    for (const name of names) field(h, `composition.${group}.name`, name);
  }
  field(h, "source.kind", input.source.kind);
  field(h, "source.digest", input.source.digest);
  field(h, "source.repository", input.source.repository);
  field(h, "source.commit", input.source.commit);
  field(h, "source.subdir", input.source.subdir);
  field(h, "buildInput.entry", input.buildInput.entry);
  field(h, "buildInput.toolchain.builder", input.buildInput.toolchain.builder);
  field(h, "buildInput.toolchain.format", input.buildInput.toolchain.format);
  field(h, "buildInput.toolchain.lockfile", input.buildInput.toolchain.lockfile);
  field(h, "buildInput.lockfileHash", input.buildInput.lockfileHash);
  return h.digest("hex");
}

export function computeRecipeDigest(buildInput: ReleaseBuildInput): string {
  const h = createHash("sha256");
  field(h, "domain", RECIPE_DIGEST_DOMAIN);
  field(h, "entry", buildInput.entry);
  field(h, "toolchain.builder", buildInput.toolchain.builder);
  field(h, "toolchain.format", buildInput.toolchain.format);
  field(h, "toolchain.lockfile", buildInput.toolchain.lockfile);
  field(h, "lockfileHash", buildInput.lockfileHash);
  return h.digest("hex");
}

/**
 * Digest of one composition group.
 *
 * The group label is inside, so an empty View group and an empty backend group
 * do not share a digest — "this release ships no browser code" and "this
 * release ships no backend code" are different statements.
 */
export function computeGroupDigest(
  group: "view" | "backend",
  names: readonly string[],
  assets: readonly ReleaseAsset[],
): string {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const h = createHash("sha256");
  field(h, "domain", GROUP_DIGEST_DOMAIN);
  field(h, "group", group);
  field(h, "count", String(names.length));
  for (const name of names) {
    const asset = byName.get(name);
    if (!asset) throw new Error(`composition names an asset that is not in the inventory: ${clip(name, 60)}`);
    field(h, "asset.name", asset.name);
    field(h, "asset.sha256", asset.sha256);
    field(h, "asset.bytes", String(asset.bytes));
  }
  return h.digest("hex");
}

// ── name and field rules ──

/**
 * One path segment of an asset name.
 *
 * A whitelist rather than a blacklist, so `..`, `.`, backslashes, drive
 * letters, NUL, newlines and every Unicode confusable are excluded by
 * construction rather than by remembering to exclude them.
 */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Is this a name we would still be safe with if somebody materialised the
 * release onto a filesystem?
 *
 * The content store in this package never uses an asset name as a path — blobs
 * are addressed by their own digest — so traversal is structurally impossible
 * there. This check exists for every downstream consumer that will not have
 * that property, and it is written as containment (not as a `..` blacklist) so
 * that relaxing the charset later cannot quietly reopen it.
 */
export function assetNameProblem(name: string, limits: RegistryLimits = DEFAULT_LIMITS): string | null {
  if (typeof name !== "string" || name.length === 0) return "asset name is empty";
  if (Buffer.byteLength(name, "utf8") > limits.maxNameLength) {
    return `asset name is longer than ${limits.maxNameLength} bytes`;
  }
  if (name !== name.normalize("NFC")) return "asset name is not NFC-normalised";
  const segments = name.split("/");
  if (segments.length > limits.maxNameSegments) {
    return `asset name has more than ${limits.maxNameSegments} path segments`;
  }
  for (const segment of segments) {
    if (!NAME_SEGMENT.test(segment)) return "asset name segment is not [A-Za-z0-9][A-Za-z0-9._-]*";
  }
  const normalized = posix.normalize(name);
  if (normalized !== name) return "asset name is not in normalised form";
  if (posix.isAbsolute(name)) return "asset name is absolute";
  if (normalized === ".." || normalized.startsWith("../")) return "asset name escapes the package";
  return null;
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const PUBLISHER = /^[a-z0-9][a-z0-9._:-]*$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A digest produced by another layer.
 *
 * The permission contract digest is the engine's, and the engine truncates to
 * 32 hex characters. The registry does not recompute it and therefore does not
 * get to insist on its length — only that it is a lowercase hex digest of a
 * plausible size, so a path, a URL or a sentence cannot be stored in its place.
 */
export function isForeignDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32,128}$/.test(value);
}

// ── validation ──

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: RegistryIssue[] };

const DESCRIPTOR_FIELDS = Object.keys(DESCRIPTOR_FIELD_COVERAGE) as Array<keyof AppReleaseDescriptor>;

/**
 * Validate an untrusted descriptor and return a canonical copy.
 *
 * Pure: no filesystem, no database, no content. The returned value is rebuilt
 * field by field, so nothing from the input object survives except values that
 * passed a check — an input with extra keys is rejected rather than carried,
 * and the object that comes out cannot smuggle a prototype.
 */
export function validateDescriptor(
  input: unknown,
  limits: RegistryLimits = DEFAULT_LIMITS,
): Validated<AppReleaseDescriptor> {
  const sink = new IssueSink(limits);
  const row = asRecord(input);
  if (!row) {
    sink.add("not_an_object", "descriptor is not a plain object");
    return { ok: false, issues: sink.drain() };
  }
  for (const key of Object.keys(row)) {
    if (!(DESCRIPTOR_FIELDS as string[]).includes(key)) {
      sink.add("unknown_field", "descriptor has a field this build does not understand", key);
    }
  }
  if (row.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    sink.add(
      "schema_version",
      `descriptor schemaVersion must be ${RELEASE_SCHEMA_VERSION}, refusing to partially honour another`,
      "schemaVersion",
    );
    return { ok: false, issues: sink.drain() };
  }

  const stableAppId = text(sink, row.stableAppId, "stableAppId", limits);
  if (stableAppId !== null && !ID.test(stableAppId)) {
    sink.add("identity_charset", "stableAppId must be lowercase [a-z0-9][a-z0-9._-]*", "stableAppId");
  }
  const publisher = text(sink, row.publisher, "publisher", limits);
  if (publisher !== null && !PUBLISHER.test(publisher)) {
    sink.add("identity_charset", "publisher must be lowercase [a-z0-9][a-z0-9._:-]*", "publisher");
  }
  const executionProfile = row.executionProfile as ExecutionProfile;
  if (!EXECUTION_PROFILES.includes(executionProfile)) {
    sink.add("execution_profile", `executionProfile must be one of ${EXECUTION_PROFILES.join(", ")}`, "executionProfile");
  }
  if (!isSha256Hex(row.packageDigest)) {
    sink.add("digest_format", "packageDigest must be 64 lowercase hex characters", "packageDigest");
  }
  if (!isForeignDigest(row.permissionContractDigest)) {
    sink.add("digest_format", "permissionContractDigest must be 32-128 lowercase hex characters", "permissionContractDigest");
  }

  const assets = validateAssets(sink, row.assets, limits);
  const composition = validateComposition(sink, row.composition, assets, limits);
  const source = validateSource(sink, row.source, limits);
  const buildInput = validateBuildInput(sink, row.buildInput, limits);
  const evidence = validateEvidenceShape(sink, row.evidence);

  if (!sink.empty) return { ok: false, issues: sink.drain() };

  const canonical: AppReleaseDescriptor = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    stableAppId: stableAppId!,
    publisher: publisher!,
    executionProfile,
    packageDigest: row.packageDigest as string,
    permissionContractDigest: row.permissionContractDigest as string,
    assets: assets!,
    composition: composition!,
    source: source!,
    buildInput: buildInput!,
    evidence: evidence!,
  };

  // Everything above proved the descriptor is well formed. These two prove it
  // is self-consistent: the evidence is recomputed from the inventory it claims
  // to summarise, and the identity is recomputed from every covered field.
  const expectedEvidence: ReleaseEvidence = {
    viewDigest: computeGroupDigest("view", canonical.composition.view, canonical.assets),
    backendDigest: computeGroupDigest("backend", canonical.composition.backend, canonical.assets),
    recipeDigest: computeRecipeDigest(canonical.buildInput),
  };
  for (const key of ["viewDigest", "backendDigest", "recipeDigest"] as const) {
    if (canonical.evidence[key] !== expectedEvidence[key]) {
      sink.add("evidence_mismatch", `evidence.${key} does not match the release it describes`, `evidence.${key}`);
    }
  }
  const expectedDigest = computePackageDigest(canonical);
  if (canonical.packageDigest !== expectedDigest) {
    sink.add("package_digest_mismatch", "packageDigest does not match the release it names", "packageDigest");
  }
  if (!sink.empty) return { ok: false, issues: sink.drain() };
  return { ok: true, value: freezeDescriptor(canonical) };
}

/**
 * Build a canonical descriptor from real bytes.
 *
 * The builder half of the contract: publishers and the future release builder
 * call this, and `install()` recomputes everything from the artifact rather
 * than believing the result. Two implementations of the framing would be two
 * chances to disagree, so this one calls the same functions validation does.
 */
export interface ReleaseSpec {
  stableAppId: string;
  publisher: string;
  executionProfile: ExecutionProfile;
  permissionContractDigest: string;
  assets: ReadonlyArray<{ name: string; content: Uint8Array }>;
  composition: ReleaseComposition;
  source: SourceAttestation;
  buildInput: ReleaseBuildInput;
}

export function describeRelease(spec: ReleaseSpec, limits: RegistryLimits = DEFAULT_LIMITS): AppReleaseDescriptor {
  const assets = [...spec.assets]
    .map((asset) => ({ name: asset.name, sha256: sha256Of(asset.content), bytes: asset.content.byteLength }))
    .sort(byName);
  const composition: ReleaseComposition = {
    view: [...spec.composition.view].sort(compareText),
    backend: [...spec.composition.backend].sort(compareText),
  };
  const draft: PackageDigestInput = {
    stableAppId: spec.stableAppId,
    publisher: spec.publisher,
    executionProfile: spec.executionProfile,
    assets,
    composition,
    source: spec.source,
    buildInput: spec.buildInput,
  };
  const descriptor: AppReleaseDescriptor = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    stableAppId: spec.stableAppId,
    publisher: spec.publisher,
    executionProfile: spec.executionProfile,
    packageDigest: computePackageDigest(draft),
    permissionContractDigest: spec.permissionContractDigest,
    assets,
    composition,
    source: spec.source,
    buildInput: spec.buildInput,
    evidence: {
      viewDigest: computeGroupDigest("view", composition.view, assets),
      backendDigest: computeGroupDigest("backend", composition.backend, assets),
      recipeDigest: computeRecipeDigest(spec.buildInput),
    },
  };
  const verdict = validateDescriptor(descriptor, limits);
  if (!verdict.ok) {
    throw new Error(`describeRelease produced an invalid descriptor: ${verdict.issues.map((row) => row.code).join(", ")}`);
  }
  return verdict.value;
}

/**
 * Check the actual bytes against an already-validated descriptor.
 *
 * Separate from `validateDescriptor` on purpose: the descriptor check is pure
 * and cheap and runs first, so a malformed candidate never causes a single byte
 * to be hashed.
 */
export function verifyPayload(
  descriptor: AppReleaseDescriptor,
  payload: ReadonlyArray<{ name: string; content: Uint8Array }>,
  limits: RegistryLimits = DEFAULT_LIMITS,
): Validated<ReadonlyArray<{ name: string; sha256: string; bytes: number; content: Uint8Array }>> {
  const sink = new IssueSink(limits);
  const provided = new Map<string, Uint8Array>();
  for (const entry of payload) {
    if (typeof entry?.name !== "string" || !(entry.content instanceof Uint8Array)) {
      sink.add("field_type", "payload entry must be { name: string, content: Uint8Array }");
      continue;
    }
    if (provided.has(entry.name)) {
      sink.add("asset_duplicate", "payload names the same asset twice", entry.name);
      continue;
    }
    provided.set(entry.name, entry.content);
  }
  const declared = new Set(descriptor.assets.map((asset) => asset.name));
  for (const name of provided.keys()) {
    if (!declared.has(name)) sink.add("asset_unexpected", "payload carries an asset the descriptor does not declare", name);
  }
  const stored: Array<{ name: string; sha256: string; bytes: number; content: Uint8Array }> = [];
  for (const asset of descriptor.assets) {
    const content = provided.get(asset.name);
    if (!content) {
      sink.add("asset_missing", "descriptor declares an asset the payload does not carry", asset.name);
      continue;
    }
    if (content.byteLength !== asset.bytes) {
      sink.add("asset_digest", `asset is ${content.byteLength} bytes, descriptor declares ${asset.bytes}`, asset.name);
      continue;
    }
    if (sha256Of(content) !== asset.sha256) {
      sink.add("asset_digest", "asset bytes do not match the declared sha256", asset.name);
      continue;
    }
    stored.push({ name: asset.name, sha256: asset.sha256, bytes: asset.bytes, content });
  }
  if (!sink.empty) return { ok: false, issues: sink.drain() };
  return { ok: true, value: stored };
}

// ── field helpers ──

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.prototype.hasOwnProperty.call(value, "__proto__")) return null;
  return value as Record<string, unknown>;
}

function text(sink: IssueSink, value: unknown, at: string, limits: RegistryLimits): string | null {
  if (typeof value !== "string") {
    sink.add("field_type", `${at} must be a string`, at);
    return null;
  }
  if (value.length === 0) {
    sink.add("missing_field", `${at} is empty`, at);
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > limits.maxFieldLength) {
    sink.add("field_length", `${at} is longer than ${limits.maxFieldLength} bytes`, at);
    return null;
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    sink.add("field_type", `${at} contains a control character`, at);
    return null;
  }
  return value;
}

function validateAssets(sink: IssueSink, value: unknown, limits: RegistryLimits): ReleaseAsset[] | null {
  if (!Array.isArray(value)) {
    sink.add("field_type", "assets must be an array", "assets");
    return null;
  }
  if (value.length === 0) {
    sink.add("missing_field", "a release must declare at least one asset", "assets");
    return null;
  }
  if (value.length > limits.maxAssets) {
    sink.add("asset_limit", `a release may declare at most ${limits.maxAssets} assets`, "assets");
    return null;
  }
  const out: ReleaseAsset[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of value) {
    const row = asRecord(entry);
    if (!row) {
      sink.add("field_type", "asset entry is not a plain object", "assets");
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!["name", "sha256", "bytes"].includes(key)) {
        sink.add("unknown_field", "asset entry has an unexpected field", `assets.${key}`);
      }
    }
    const name = typeof row.name === "string" ? row.name : "";
    const problem = assetNameProblem(name, limits);
    if (problem) {
      sink.add("asset_name", problem, name || "assets");
      continue;
    }
    if (seen.has(name)) {
      sink.add("asset_duplicate", "the inventory names the same asset twice", name);
      continue;
    }
    seen.add(name);
    if (!isSha256Hex(row.sha256)) {
      sink.add("digest_format", "asset sha256 must be 64 lowercase hex characters", name);
      continue;
    }
    if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      sink.add("field_type", "asset bytes must be a non-negative safe integer", name);
      continue;
    }
    if (row.bytes > limits.maxAssetBytes) {
      sink.add("asset_size", `asset is larger than ${limits.maxAssetBytes} bytes`, name);
      continue;
    }
    total += row.bytes;
    out.push({ name, sha256: row.sha256, bytes: row.bytes });
  }
  if (total > limits.maxTotalBytes) {
    sink.add("asset_total_size", `release is larger than ${limits.maxTotalBytes} bytes in total`, "assets");
  }
  for (let i = 1; i < out.length; i += 1) {
    if (compareText(out[i - 1]!.name, out[i]!.name) >= 0) {
      sink.add("asset_order", "the inventory must be sorted by name", "assets");
      break;
    }
  }
  return sink.empty ? out : null;
}

function validateComposition(
  sink: IssueSink,
  value: unknown,
  assets: ReleaseAsset[] | null,
  limits: RegistryLimits,
): ReleaseComposition | null {
  const row = asRecord(value);
  if (!row) {
    sink.add("field_type", "composition must be a plain object", "composition");
    return null;
  }
  for (const key of Object.keys(row)) {
    if (!["view", "backend"].includes(key)) {
      sink.add("unknown_field", "composition has an unexpected field", `composition.${key}`);
    }
  }
  const known = new Set((assets ?? []).map((asset) => asset.name));
  const groups: Partial<ReleaseComposition> = {};
  for (const group of ["view", "backend"] as const) {
    const list = row[group];
    if (!Array.isArray(list)) {
      sink.add("field_type", `composition.${group} must be an array`, `composition.${group}`);
      continue;
    }
    if (list.length > limits.maxAssets) {
      sink.add("asset_limit", `composition.${group} names more assets than a release may have`, `composition.${group}`);
      continue;
    }
    const names: string[] = [];
    for (const name of list) {
      if (typeof name !== "string" || !known.has(name)) {
        sink.add(
          "composition_unknown_asset",
          `composition.${group} names an asset that is not in the inventory`,
          typeof name === "string" ? name : `composition.${group}`,
        );
        continue;
      }
      if (names.includes(name)) {
        sink.add("asset_duplicate", `composition.${group} names the same asset twice`, name);
        continue;
      }
      names.push(name);
    }
    for (let i = 1; i < names.length; i += 1) {
      if (compareText(names[i - 1]!, names[i]!) >= 0) {
        sink.add("asset_order", `composition.${group} must be sorted`, `composition.${group}`);
        break;
      }
    }
    groups[group] = names;
  }
  if (!groups.view || !groups.backend) return null;
  return { view: groups.view, backend: groups.backend };
}

function validateSource(sink: IssueSink, value: unknown, limits: RegistryLimits): SourceAttestation | null {
  const row = asRecord(value);
  if (!row) {
    sink.add("field_type", "source must be a plain object", "source");
    return null;
  }
  for (const key of Object.keys(row)) {
    if (!["kind", "digest", "repository", "commit", "subdir"].includes(key)) {
      sink.add("unknown_field", "source has an unexpected field", `source.${key}`);
    }
  }
  const kind = row.kind as SourceAttestationKind;
  if (!SOURCE_ATTESTATION_KINDS.includes(kind)) {
    sink.add("source_kind", `source.kind must be one of ${SOURCE_ATTESTATION_KINDS.join(", ")}`, "source.kind");
  }
  const digest = text(sink, row.digest, "source.digest", limits);
  const repository = text(sink, row.repository, "source.repository", limits);
  const commit = text(sink, row.commit, "source.commit", limits);
  // A snapshot of a whole tree has no subdirectory; the empty string is the
  // honest answer and must not be spelled "." or "/".
  const subdir = row.subdir === "" ? "" : text(sink, row.subdir, "source.subdir", limits);
  if (digest === null || repository === null || commit === null || subdir === null) return null;
  if (subdir !== "" && assetNameProblem(subdir, limits) !== null) {
    sink.add("field_type", "source.subdir must be a relative, normalised path", "source.subdir");
    return null;
  }
  return { kind, digest, repository, commit, subdir };
}

function validateBuildInput(sink: IssueSink, value: unknown, limits: RegistryLimits): ReleaseBuildInput | null {
  const row = asRecord(value);
  if (!row) {
    sink.add("field_type", "buildInput must be a plain object", "buildInput");
    return null;
  }
  for (const key of Object.keys(row)) {
    if (!["entry", "toolchain", "lockfileHash"].includes(key)) {
      sink.add("unknown_field", "buildInput has an unexpected field", `buildInput.${key}`);
    }
  }
  const toolchain = asRecord(row.toolchain);
  if (!toolchain) {
    sink.add("field_type", "buildInput.toolchain must be a plain object", "buildInput.toolchain");
    return null;
  }
  for (const key of Object.keys(toolchain)) {
    if (!["builder", "format", "lockfile"].includes(key)) {
      sink.add("unknown_field", "buildInput.toolchain has an unexpected field", `buildInput.toolchain.${key}`);
    }
  }
  const entry = text(sink, row.entry, "buildInput.entry", limits);
  const builder = text(sink, toolchain.builder, "buildInput.toolchain.builder", limits);
  const format = text(sink, toolchain.format, "buildInput.toolchain.format", limits);
  const lockfile = text(sink, toolchain.lockfile, "buildInput.toolchain.lockfile", limits);
  const lockfileHash = text(sink, row.lockfileHash, "buildInput.lockfileHash", limits);
  if (entry === null || builder === null || format === null || lockfile === null || lockfileHash === null) return null;
  if (!isForeignDigest(lockfileHash)) {
    sink.add("digest_format", "buildInput.lockfileHash must be 32-128 lowercase hex characters", "buildInput.lockfileHash");
    return null;
  }
  return { entry, toolchain: { builder, format, lockfile }, lockfileHash };
}

function validateEvidenceShape(sink: IssueSink, value: unknown): ReleaseEvidence | null {
  const row = asRecord(value);
  if (!row) {
    sink.add("field_type", "evidence must be a plain object", "evidence");
    return null;
  }
  for (const key of Object.keys(row)) {
    if (!["viewDigest", "backendDigest", "recipeDigest"].includes(key)) {
      sink.add("unknown_field", "evidence has an unexpected field", `evidence.${key}`);
    }
  }
  for (const key of ["viewDigest", "backendDigest", "recipeDigest"] as const) {
    if (!isSha256Hex(row[key])) {
      sink.add("digest_format", `evidence.${key} must be 64 lowercase hex characters`, `evidence.${key}`);
      return null;
    }
  }
  return {
    viewDigest: row.viewDigest as string,
    backendDigest: row.backendDigest as string,
    recipeDigest: row.recipeDigest as string,
  };
}

/**
 * Byte order, not locale order.
 *
 * `localeCompare` would make the canonical inventory depend on where the
 * process runs, which is exactly the kind of thing a reproducible digest must
 * not do.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareText(a.name, b.name);
}

function freezeDescriptor(descriptor: AppReleaseDescriptor): AppReleaseDescriptor {
  descriptor.assets.forEach((asset) => Object.freeze(asset));
  Object.freeze(descriptor.assets);
  Object.freeze(descriptor.composition.view);
  Object.freeze(descriptor.composition.backend);
  Object.freeze(descriptor.composition);
  Object.freeze(descriptor.source);
  Object.freeze(descriptor.buildInput.toolchain);
  Object.freeze(descriptor.buildInput);
  Object.freeze(descriptor.evidence);
  return Object.freeze(descriptor);
}
