import { moduleAssetProblem } from "./release-assets.js";
/**
 * Turning one installed release into something this platform can actually run.
 *
 * ── Why an adapter, and what it is allowed to decide ────────────────────────
 *
 * The registry answers "which immutable release is active". It deliberately
 * knows nothing about Session Plus, React, permission contracts or the App
 * Runtime — so something has to answer the next question: *can this platform
 * run these bytes at all?* That question has answers this build can only give
 * about itself, and every one of them is a reason to REFUSE an activation
 * rather than to adapt to it:
 *
 *  · an execution profile this composition does not implement;
 *  · a permission contract this build has no catalog for — including a WIDER
 *    one, which must fail closed rather than being partially honoured;
 *  · an app declaration whose action surface is not the one the trusted
 *    coordinator binds.
 *
 * A release that fails any of these is `installed / unsupported`: visible in the
 * admin page, never activatable, and never able to replace a working release.
 *
 * ── Asset names still never become paths ────────────────────────────────────
 *
 * The App Runtime loads real files from a directory, so a release has to be
 * materialised. The mapping used is from a CLOSED LIST of asset names to
 * relative paths, spelled out in `release-assets.ts`. The descriptor's
 * inventory is only ever compared against that list — it is never joined onto a
 * root — so "a release installs itself into /etc/cron.d" stays a code path that
 * does not exist rather than a check somebody has to remember.
 *
 * ── What moved out, and what stayed ─────────────────────────────────────────
 *
 * The shape inventories, the backend layout, the atomic materialisation and the
 * self-consistency questions a module plan answers about itself are statements
 * about the `publisher-js` PROFILE, not about Session Plus; they live in
 * `release-assets.ts` so a second app's adapter does not have to import this
 * one. What stayed here is everything that is about THIS app's ask: which
 * permission contract each shape must declare, which typed ports that contract
 * needs, how the binding plan links, and this app's identity/manifest.
 */

import { CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2 } from "@claude-bot/crdt-doc-contract";
import { NOTIFY_CONTRACT } from "@claude-bot/notify-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
} from "@claude-bot/workspace-files-contract";
import * as path from "node:path";
import type { AppReleaseDescriptor, InstalledRelease } from "@claude-bot/app-registry";
import {
  encodeAppPermissions,
  encodeResourceBindings,
  linkResourceBindings,
  parseAppPermissions,
  parseResourceBindings,
  type ResourceBindingPlan,
  type LinkedComposition,
} from "@claude-bot/agent-module-contract";
import { backendRelease } from "@claude-bot/app-runtime";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
} from "@claude-bot/session-plus-view/plan";
import {
  VIEW_ASSETS,
  assetText as text,
  describeAdapterError as describe,
  materialiseBackendTree,
  readReleaseModulePlan,
  releaseShapeOf,
  shapeBindsResources,
  type ReleaseShape,
} from "./release-assets.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_PUBLISHER,
  permissionContractDigest,
  sessionPlusIdentityOf,
  type SessionPlusIdentity,
} from "../app-core/identity.js";
import {
  sessionPlusContractById,
  type SessionPlusContractId,
} from "../session-resource/contract.js";
import { loadSessionPlusManifest, type SessionPlusManifest } from "../app-core/manifest.js";
import { sessionPlusReleaseRecord, type SessionPlusReleaseRecord } from "../app-core/release.js";
import {
  sessionPlusSettingsFor,
  type SessionPlusSettings,
} from "../app-core/settings.js";
import {
  composeViewDocumentFrom,
  splitViewTemplate,
  type PublishedViewDocument,
} from "../app-core/view-app.js";
import type { AppReleaseAdapter, AppRuntimeTarget } from "./adapter.js";
import { buildCheckoutBundle, type ReleaseBundle } from "./session-plus-package.js";

/**
 * The four release shapes, and which permission contract each may declare.
 *
 * The inventories themselves are in `release-assets.ts` (they describe the
 * profile). What is Session Plus's own is the PAIRING below: each shape declares
 * exactly one permission contract, and a descriptor whose digest names another
 * one is refused. Both directions matter — a `legacy` release claiming the
 * eight-token ask would be an old View that somehow acquired file permissions,
 * and a `modular-v2` release claiming the six would ship a file tree whose reads
 * can never be granted, a half-working release, which is the outcome the whole
 * fail-closed posture exists to avoid.
 *
 * ── And since `modular-v3`, the release also SAYS it ───────────────────────
 *
 * A `modular-v3` release carries `view/permissions.json`, in which it names the
 * contract it asks for. `prepare()` refuses the release unless that document
 * names exactly what the table below says its shape declares. Two statements of
 * one fact, on purpose: the table is what this build ENFORCES, the document is
 * what the artifact CLAIMS, and a release whose bytes a reviewer is holding
 * should be legible about the one thing a person is asked to agree to. The
 * duplication is a typo detector, not a second source of truth — nothing about
 * grants, projection or the Gate reads the document.
 */
export { releaseShapeOf, type ReleaseShape } from "./release-assets.js";

/**
 * Which permission contracts each shape is allowed to declare.
 *
 * A SET per shape since 2026-08-10, because `modular-v3` is the first shape
 * whose eleven assets can carry more than one honest ask: the release's own
 * `view/permissions.json` names which member it declares, and the descriptor's
 * digest must agree with that same member. One release still declares exactly
 * ONE contract — the set is the shapes' vocabulary, not a union ask — and a
 * digest matching none of the members is refused exactly as before. The
 * withdrawn 2026-08-09 batch wrote this generalisation once already; the cost
 * was known and is paid here on purpose.
 */
const SHAPE_CONTRACT: Readonly<Record<ReleaseShape, readonly SessionPlusContractId[]>> = Object.freeze({
  legacy: Object.freeze(["sessions/v1" as const]),
  "modular-v1": Object.freeze(["sessions/v1" as const]),
  "modular-v2": Object.freeze(["sessions-workspace/v1" as const]),
  "modular-v3": Object.freeze([
    "sessions-workspace-write/v1" as const,
    "sessions-workspace-write-crdt/v1" as const,
    "sessions-workspace-write-crdt-self-service/v1" as const,
    "sessions-workspace-write-crdt-self-service/v2" as const,
    "sessions-workspace-write-crdt-self-service/v3" as const,
    "sessions-workspace-write-crdt-self-service/v4" as const,
    "sessions-workspace-write-crdt-self-service/v5" as const,
    "sessions-workspace-write-crdt-self-service/v6" as const,
    "sessions-workspace-write-crdt-self-service/v7" as const,
  ]),
});

/**
 * Which of a shape's allowed contracts this descriptor declares, by digest.
 *
 * Exact and closed: the digest is compared against each member's computed
 * digest for THIS publisher, and matching none is a refusal — never a
 * fallback onto the shape's first member, which would be the platform
 * answering the one question only the release may answer.
 */
function shapeContractOf(
  shape: ReleaseShape,
  descriptor: AppReleaseDescriptor,
): { id: SessionPlusContractId; digest: string } | null {
  for (const id of SHAPE_CONTRACT[shape]) {
    const digest = permissionContractDigest(descriptor.publisher, sessionPlusContractById(id));
    if (descriptor.permissionContractDigest === digest) return { id, digest };
  }
  return null;
}

/**
 * The workspace-files versions, as ONE requirement with two ways to satisfy it.
 *
 * `workspace-files/v2` is v1 plus an optional opaque directory key on two of its
 * answers: the same verbs, the same permission tokens, the same Runner
 * operations, the same capability Object. So it is not a wider ask, and a
 * release binding either version asks its user for exactly the same thing —
 * which is why both live inside one requirement rather than in two rows that
 * would have needed two permission contracts to tell apart.
 *
 * A release must bind EXACTLY ONE of them. Binding neither ships a file panel
 * that can never work; binding both is a plan with two ports for one job, and
 * whichever the dispatcher picked would be an answer nobody wrote down.
 */
const WORKSPACE_FILES_VERSIONS: readonly string[] = Object.freeze([
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
]);

const WORKSPACE_FILES_MEDIA_VERSION: readonly string[] = Object.freeze([
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
]);

const WORKSPACE_FILES_DOWNLOAD_VERSION: readonly string[] = Object.freeze([
  WORKSPACE_FILES_CONTRACT_V4,
]);

/**
 * Interchangeable for every ask that includes documents: v2 spends the same two
 * tokens through the same Gate and differs only in carrying a document of any
 * size, so binding it is not a wider ask than binding v1 and needs no new
 * permission contract (and therefore no new consent).
 */
const CRDT_DOC_VERSIONS: readonly string[] = Object.freeze([CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2]);

/**
 * Which typed ports a contract's operations are actually served by.
 *
 * A statement about THIS build: the two workspace reads are backed by a
 * workspace-files provider, so a deployment that composed none cannot honour
 * that ask. Checking it in `compatibility()` is what makes such a release read
 * `installed / unsupported` on the management page instead of failing at the
 * moment somebody presses activate.
 *
 * Each entry is a REQUIREMENT; each requirement lists the interchangeable
 * contract ids that satisfy it. A build meets a requirement by installing any
 * one of them; a release meets it by binding exactly one.
 */
const CONTRACT_RESOURCES: Readonly<Record<SessionPlusContractId, readonly (readonly string[])[]>> = Object.freeze({
  "sessions/v1": Object.freeze([]),
  "sessions-workspace/v1": Object.freeze([WORKSPACE_FILES_VERSIONS]),
  /**
   * The write ask is served by the same typed port, so it needs the same
   * provider — a deployment serving no version of workspace-files cannot honour
   * either.
   *
   * `modular-v3` is the shape that declares it. Note what this row does NOT say:
   * that a deployment able to serve the port has agreed to the write. Being able
   * to carry an ask and having granted it are the two questions this whole file
   * keeps apart — the Gate is still the only thing that authorises, and a user's
   * existing eight-token consent does not cover the ninth token.
   */
  "sessions-workspace-write/v1": Object.freeze([WORKSPACE_FILES_VERSIONS]),
  /**
   * The notify ask needs BOTH ports: it contains the nine workspace tokens as
   * well as `send_notification`, and a deployment that can serve only one of
   * them would activate a release with a permanently dead surface — the exact
   * outcome this table exists to refuse.
   *
   * `notify/v1` is registered unconditionally by the composition root (a host
   * with no outbound channel still installs a provider that satisfies the
   * contract and refuses every scope), so this entry is not a way to detect a
   * host without Feishu. It is the statement that a release asking to notify
   * must be served by a build that HAS a notify provider at all.
   *
   * No release shape declares this contract either, and for a stronger reason
   * than the write's — see the closing note in `session-resource/contract.ts`:
   * `send_notification` is served by a delivery path rather than by a capability
   * Object, so the per-call approval its consent row promises has nothing
   * enforcing it yet.
   */
  "sessions-workspace-write-notify/v1": Object.freeze([WORKSPACE_FILES_VERSIONS, Object.freeze([NOTIFY_CONTRACT])]),
  /**
   * The CRDT ask needs the workspace ports its nine base tokens are served by,
   * plus the document port for its two new ones. `crdt-doc/v1` is registered
   * by the composition root whenever the deployment composed a document store;
   * this row is the statement that a release asking for documents must run on
   * a build that HAS a document provider at all.
   */
  "sessions-workspace-write-crdt/v1": Object.freeze([WORKSPACE_FILES_VERSIONS, CRDT_DOC_VERSIONS]),
  "sessions-workspace-write-crdt-self-service/v1": Object.freeze([
    WORKSPACE_FILES_VERSIONS,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v2": Object.freeze([
    WORKSPACE_FILES_MEDIA_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v3": Object.freeze([
    WORKSPACE_FILES_MEDIA_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v4": Object.freeze([
    WORKSPACE_FILES_MEDIA_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v5": Object.freeze([
    WORKSPACE_FILES_DOWNLOAD_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v6": Object.freeze([
    WORKSPACE_FILES_DOWNLOAD_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
  "sessions-workspace-write-crdt-self-service/v7": Object.freeze([
    WORKSPACE_FILES_DOWNLOAD_VERSION,
    CRDT_DOC_VERSIONS,
  ]),
});

/**
 * What this adapter deliberately does NOT validate: any plan question that
 * needs this build's compiled manifests.
 *
 * An installed release's lock, composition, bindings and View bundle were
 * produced together and are covered by one package digest — they are self-
 * consistent whatever this checkout's `SESSION_PLUS_MANIFESTS` say today.
 * Auditing a historical release against TODAY's inventory (exact version/
 * implementation identity, slot acceptance, opened kinds, declared ports) is
 * checking an unrelated equation, and its concrete failure mode is that one
 * module version bump makes every previously installed release refuse to
 * activate — a rollback that stops working the day it is needed. This adapter
 * therefore only asks questions the release can answer about ITSELF (canonical
 * bytes, app identity, lock ↔ composition ↔ bindings cross-references) plus
 * questions about THIS deployment (shape ↔ contract digest, installed
 * providers).
 *
 * The manifest-backed questions still get asked — once, at the one moment when
 * "the manifests in this process" and "the manifests the bundle was built
 * from" are the same thing by definition: `checkoutPlanProblem()` in
 * `session-plus-package.ts`, on the pack path. (Convergence plan, decision 11.)
 */

/** One release, verified and ready to be served. Holding it grants nothing. */
export interface PreparedSessionPlusRelease {
  descriptor: AppReleaseDescriptor;
  identity: SessionPlusIdentity;
  manifest: SessionPlusManifest;
  /** Materialised backend tree the App Runtime child is pointed at. */
  appDir: string;
  releaseRecord: SessionPlusReleaseRecord;
  installedBy: string;
  installedAt: string;
  /** Which of the four supported inventories this release is. */
  shape: ReleaseShape;
  /** The validated assembly plan, for any modular release. */
  modulePlan: LinkedComposition | null;
  /**
   * The validated `agent-resource-bindings` plan (either schema), for a binding
   * shape.
   *
   * `null` for every other shape, and that null is what makes the rollback
   * targets behave exactly as they did: with no plan there is no resource
   * handle, so a `resource.*` proposal is a bounded refusal and the sessions
   * surfaces are untouched.
   *
   * The schema is NOT a release inventory question: v1 and v2 arrive under the
   * same asset name, in the same ten- or eleven-asset shape, asking for the same
   * permission contract. A template changes what the layout may show, never what
   * the App may reach — so a plan gaining one must not read like a new ask.
   */
  resourceBindings: ResourceBindingPlan | null;
  /** Compose this release's document under one response nonce. */
  document(nonce: string): PublishedViewDocument;
  /** Exact-name source lookup for the consent page's evidence links. */
  source(name: string): string | null;
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedSessionPlusRelease }
  | { ok: false; code: PrepareRefusalCode; message: string };

export type PrepareRefusalCode =
  | "wrong_app"
  | "unsupported_profile"
  | "unknown_permission_contract"
  | "missing_asset"
  | "invalid_declaration"
  | "invalid_module_plan"
  | "unsupported_resource_contract"
  | "materialise_failed";

export interface SessionPlusAdapterOptions {
  /** Root under which one directory per package digest is materialised. */
  preparedRoot: string;
  /**
   * Configuration-derived settings every release of this app is served under.
   *
   * Here rather than on the host because it is an answer ABOUT THIS APP that
   * only this adapter can complete: the origin policy is per-app configuration,
   * and the release's own hostname label is what decides whether a pinned
   * deployment can serve it at all.
   */
  baseSettings: SessionPlusSettings;
  publisher?: string;
  /**
   * Which typed-port contracts this deployment installed a provider for.
   *
   * A QUESTION, not a grant: being able to serve a contract is not the same as
   * any account being allowed to. It is here so a release whose plan names a
   * contract nobody composed is `installed / unsupported` rather than an
   * activation that half-works — the file panel would be permanently
   * `no_authority` while the release looked healthy.
   *
   * Omitted means "this composition installed none", which is the honest
   * default for a test and for a deployment with no resource catalog.
   */
  resourceContracts?: () => ReadonlySet<string>;
  /**
   * Which models this deployment is willing to spend on, or an empty list for
   * "not adjudicating".
   *
   * ── Why this one refuses and the agent PLANE's absence does not ────────────
   *
   * A release declaring `agents:` on a host that built no pump is refused
   * NOWHERE, deliberately. The `modular-v2` precedent does not transfer: a
   * release needing `workspace-files/v1` with no provider ships a file tree
   * that is permanently `no_authority` — a visibly broken surface — whereas an
   * App whose agent never runs is an App that behaves exactly as it did before
   * agents existed. Refusing it would mean an operator who declines to spend on
   * inference also cannot run the App at all, which is a worse answer than the
   * one they asked for. The boot inventory reports the mismatch instead.
   *
   * The model list is different in kind, so it stays a refusal: it is about
   * money, the release chooses the value, and the first overspend cannot be
   * taken back. Refusing at prepare puts it before the pointer moves.
   */
  agentModels?: () => readonly string[];
  /** Injected for tests; production reads through the registry's content store. */
  now?: () => string;
}

export class SessionPlusReleaseAdapter
implements AppReleaseAdapter<PreparedSessionPlusRelease, SessionPlusSettings> {
  readonly stableAppId = SESSION_PLUS_APP_ID;
  readonly publisher: string;
  private readonly preparedRoot: string;
  private readonly base: SessionPlusSettings;
  private readonly resourceContracts: () => ReadonlySet<string>;
  private readonly agentModels: () => readonly string[];

  constructor(options: SessionPlusAdapterOptions) {
    this.preparedRoot = path.resolve(options.preparedRoot);
    this.base = options.baseSettings;
    this.publisher = options.publisher ?? SESSION_PLUS_PUBLISHER;
    this.resourceContracts = options.resourceContracts ?? (() => new Set<string>());
    this.agentModels = options.agentModels ?? (() => []);
  }

  /**
   * The deployment settings this release must be served under.
   *
   * The one refusal that is about the DEPLOYMENT rather than the bytes: a host
   * pinned to a single hostname by `session_plus.view_origin` cannot serve a
   * release addressed to a different digest, however valid that release is. The
   * code stays `origin_pinned` because it names an operator action (switch to
   * `app_domain` + on-demand TLS), not a defect in the candidate.
   */
  settingsFor(
    prepared: PreparedSessionPlusRelease,
  ): { ok: true; settings: SessionPlusSettings } | { ok: false; code: string; message: string } {
    const settings = sessionPlusSettingsFor(this.base, prepared.identity);
    if (!settings.ok) return { ok: false, code: "origin_pinned", message: settings.error };
    return { ok: true, settings: settings.settings };
  }

  /** Where this release's App Runtime child loads its backend from. */
  runtimeTargetOf(prepared: PreparedSessionPlusRelease): AppRuntimeTarget {
    return { appDir: prepared.appDir, backendCodeDigest: prepared.identity.backendCodeDigest };
  }

  /** This release's document under one response nonce. */
  documentOf(prepared: PreparedSessionPlusRelease, nonce: string): PublishedViewDocument {
    return prepared.document(nonce);
  }

  /** Where a browser reaches the active release. Display only. */
  viewOriginOf(settings: SessionPlusSettings): string | null {
    return settings.viewOrigin;
  }

  /** The package this checkout would build. Throws when the View is not built. */
  checkoutBundle(): ReleaseBundle {
    return buildCheckoutBundle();
  }

  /** Is this release even addressed to the app this adapter serves? */
  supports(descriptor: AppReleaseDescriptor): boolean {
    return descriptor.stableAppId === this.stableAppId && descriptor.publisher === this.publisher;
  }

  /**
   * The refusals that can be decided from the descriptor alone — no filesystem,
   * no child process, no side effect.
   *
   * The admin listing asks this about every installed release, which is why it
   * has to be cheap: materialising every release to find out whether it could be
   * activated would make reading the page a write.
   */
  compatibility(
    descriptor: AppReleaseDescriptor,
  ): { supported: true } | { supported: false; code: PrepareRefusalCode; message: string } {
    if (!this.supports(descriptor)) {
      return { supported: false, code: "wrong_app", message: "这个 release 属于另一个 App 或发布者" };
    }
    if (descriptor.executionProfile !== "publisher-js") {
      return {
        supported: false,
        code: "unsupported_profile",
        message: `本平台没有 ${descriptor.executionProfile} 执行 profile 的 Session Plus 运行时`,
      };
    }
    // Which of the four supported inventories this is. Cheap, and decided here
    // so an unrecognisable shape is visible on the admin page rather than at the
    // moment somebody presses activate.
    const shape = releaseShapeOf(descriptor.assets.map((asset) => asset.name));
    if (!shape.ok) return { supported: false, code: "missing_asset", message: shape.message };

    // The one axis the registry treats as opaque. Each SHAPE has a closed set
    // of contracts it may declare — one release declares exactly one member,
    // resolved from its own digest. A release declaring anything else —
    // narrower OR wider, or another shape's — is a release whose ask nobody
    // here can project, grant or audit. Refusing is the only honest answer:
    // partially honouring an unknown contract is how a widened permission set
    // gets silently inherited.
    //
    // Note that this build IMPLEMENTS more contracts than any shape may declare,
    // and the difference is deliberate rather than an oversight. Implementing one
    // means it can be resolved from a digest, projected on a screen and honoured
    // by a grant seam; declaring it means a release ships with it. The nine-token
    // write contract became declarable with `modular-v3` (2026-08-08) and the
    // eleven-token CRDT contract on 2026-08-10 (its enforcer now exists), and
    // the owner-local self-service variant on 2026-08-13; the
    // ten-token notify contract stays implemented and UNDECLARABLE until its
    // `alwaysApprove` has something enforcing it — code that will one day serve
    // it exists and is under test while nobody can be asked to consent to an ask
    // this platform cannot yet enforce.
    const resolved = shapeContractOf(shape.shape, descriptor);
    if (!resolved) {
      const allowed = SHAPE_CONTRACT[shape.shape].join(" 或 ");
      return {
        supported: false,
        code: "unknown_permission_contract",
        message:
          `这个 release 的资产形状是 ${shape.shape}，它必须声明 ${allowed} 权限契约之一；`
          + `收到 ${descriptor.permissionContractDigest.slice(0, 16)}…，不是其中任何一份的 digest。`
          + "权限契约变化必须重新同意，不能由平台替用户接受",
      };
    }
    const contractId = resolved.id;
    // And whether this deployment can actually serve what that contract needs.
    const installed = this.resourceContracts();
    // A requirement is met by ANY of its interchangeable ids: a build serving
    // either workspace-files version can honour this ask, and a release binds
    // exactly one of them (checked in `prepare()`, where the plan exists).
    const missing = CONTRACT_RESOURCES[contractId]
      .filter((versions) => !versions.some((contract) => installed.has(contract)))
      .map((versions) => versions.join(" 或 "));
    if (missing.length) {
      return {
        supported: false,
        code: "unsupported_resource_contract",
        message:
          `本部署没有为 ${missing.join("、")} 安装 provider，无法服务这个 release 声明的权限契约；`
          + "激活它会得到一个文件面板永远不可用的半可用版本",
      };
    }
    return { supported: true };
  }

  /**
   * Everything that has to be true before an activation may be attempted.
   *
   * Deliberately does not touch the active pointer, the runtime or any live
   * instance: this is the step whose failure must leave a working deployment
   * exactly as it was.
   */
  async prepare(
    release: InstalledRelease,
    readAsset: (name: string) => Uint8Array | null,
  ): Promise<PrepareOutcome> {
    const descriptor = release.descriptor;
    const compatible = this.compatibility(descriptor);
    if (!compatible.supported) return { ok: false, code: compatible.code, message: compatible.message };

    const shape = releaseShapeOf(descriptor.assets.map((asset) => asset.name));
    if (!shape.ok) return { ok: false, code: "missing_asset", message: shape.message };

    const bytes = new Map<string, Uint8Array>();
    for (const asset of descriptor.assets) {
      const content = readAsset(asset.name);
      if (!content) {
        return { ok: false, code: "missing_asset", message: `release 的产物里读不到 ${asset.name}（内容缺失或已损坏）` };
      }
      bytes.set(asset.name, content);
    }
    const moduleProblem = moduleAssetProblem(bytes, descriptor.stableAppId);
    if (moduleProblem) return { ok: false, code: "missing_asset", message: moduleProblem };

    // The assembly plan, read with the contract package's own validator: schema,
    // identifier grammar, duplicate instances, unknown slots and — the reason
    // both documents travel together — every module reference resolving inside
    // the lock. A plan that does not link is not a degraded release; it is one
    // this build cannot honestly run.
    let modulePlan: LinkedComposition | null = null;
    let resourceBindings: ResourceBindingPlan | null = null;
    if (shape.shape !== "legacy") {
      // Deliberately NOT linked against this build's manifests — see the note
      // above. Slot acceptance and open-kind routing for the modules actually
      // shipped in this bundle are enforced twice elsewhere: at pack time by
      // `checkoutPlanProblem()` (against the same checkout the bundle came
      // from), and at mount time by the bundle's own compiled registry
      // (`createWorkspacePlan` links the composition against the manifests that
      // will really render). Re-asking here with TODAY's manifests would make
      // historical releases unactivatable.
      const read = readReleaseModulePlan({
        lockText: text(bytes.get(MODULE_LOCK_ASSET)!),
        compositionText: text(bytes.get(COMPOSITION_ASSET)!),
        appId: descriptor.stableAppId,
      });
      if (!read.ok) return { ok: false, code: "invalid_module_plan", message: read.message };
      modulePlan = read.plan;
    }

    // ── The release's own words about what it asks for ─────────────────────
    //
    // Read BEFORE the binding plan, because it is the cheaper and more
    // consequential of the two: a document that names a different contract than
    // this shape declares is a release whose bytes say one thing and whose
    // descriptor digest says another, and no amount of valid wiring underneath
    // makes that safe to activate. It is checked against `SHAPE_CONTRACT` rather
    // than against the descriptor's digest directly because the digest was
    // already matched to the table in `compatibility()` — so agreeing with the
    // table is agreeing with the digest, stated once.
    if (shape.shape === "modular-v3") {
      const permissionsText = text(bytes.get(PERMISSIONS_ASSET)!);
      const read = parseAppPermissions(permissionsText);
      if (!read.ok) {
        const first = read.issues[0];
        return {
          ok: false,
          code: "invalid_declaration",
          message: `release 的权限声明不被接受：${first?.at ?? "permissions"}: ${first?.message ?? "校验失败"}`,
        };
      }
      if (encodeAppPermissions(read.value) !== permissionsText) {
        return {
          ok: false,
          code: "invalid_declaration",
          message: "release 的权限声明不是 canonical JSON；同一份声明只能有一种受摘要保护的字节表示",
        };
      }
      // The member the DIGEST resolved to, which `compatibility()` above has
      // already required to exist. The document must name the same one: with a
      // multi-member shape, the digest and the document are two statements of
      // which ask this release makes, and disagreement means neither can be
      // taken as the one somebody consented to.
      const declaredByDigest = shapeContractOf(shape.shape, descriptor)!;
      if (read.value.contract !== declaredByDigest.id) {
        return {
          ok: false,
          code: "unknown_permission_contract",
          message:
            `release 自己声明的权限契约是 ${read.value.contract}，而它的 digest 对应 `
            + `${declaredByDigest.id}；两者必须一致——一个 release 说的话与本构建据以授权的那份`
            + "契约不同，就没有任何一方可以被当作用户同意过的那一个",
        };
      }
    }

    // The dependency half of the plan, read with the contract package's own
    // validator and then LINKED against the composition: every connection must
    // name an instance that exists, and — because the lock travels with it —
    // a module that declared that port. A plan that does not link is not a
    // degraded release; it is one whose file panels would be wired to nothing.
    if (shapeBindsResources(shape.shape)) {
      const bindingsText = text(bytes.get(RESOURCE_BINDINGS_ASSET)!);
      const read = parseResourceBindings(bindingsText);
      if (!read.ok) {
        const first = read.issues[0];
        return {
          ok: false,
          code: "invalid_module_plan",
          message: `release 的资源绑定计划不被接受：${first?.at ?? "bindings"}: ${first?.message ?? "校验失败"}`,
        };
      }
      if (encodeResourceBindings(read.value) !== bindingsText) {
        return {
          ok: false,
          code: "invalid_module_plan",
          message: "release 的资源绑定计划不是 canonical JSON；同一份计划只能有一种受摘要保护的字节表示",
        };
      }
      if (read.value.app !== descriptor.stableAppId) {
        return {
          ok: false,
          code: "invalid_module_plan",
          message: `release 的资源绑定计划属于 ${read.value.app}，不是 ${descriptor.stableAppId}`,
        };
      }
      // Linked against the composition WITHOUT this build's manifests: every
      // connection must name an instance that exists, every binding must be
      // referenced, the app ids must agree. "Did that instance's module declare
      // this port" is a manifest question, so it is asked at pack time by
      // `checkoutPlanProblem()` — the bundle's own manifests are the ones that
      // can answer it honestly for a historical release.
      const linked = linkResourceBindings(read.value, modulePlan!.composition);
      if (!linked.ok) {
        const first = linked.issues[0];
        return {
          ok: false,
          code: "invalid_module_plan",
          message: `release 的资源绑定与它的组合不匹配：${first?.at ?? "bindings"}: ${first?.message ?? "校验失败"}`,
        };
      }
      const declared = new Set(read.value.bindings.map((row) => row.contract));
      // The digest decides the ask, and `compatibility()` has already refused
      // any release whose digest matches no member of the shape's set — so
      // this lookup is a restatement of a fact, not a second opinion about one.
      const contractId = shapeContractOf(shape.shape, descriptor)!.id;

      // ── The plan's contract set must be EXACTLY what the ask implies ───────
      //
      // Three directions are refusals. A missing requirement is a release whose
      // file panel can never work; an extra contract is a release reaching for a
      // typed port nobody agreed to when they agreed to this permission contract
      // — and "the deployment happens to have installed a provider for it" is
      // not consent. The third is new with the second workspace-files version:
      // binding TWO interchangeable ids for one requirement leaves the choice to
      // whichever the dispatcher resolved first, which is an answer nobody wrote
      // down.
      const requirements = CONTRACT_RESOURCES[contractId];
      const absent: string[] = [];
      const ambiguous: string[] = [];
      for (const versions of requirements) {
        const bound = versions.filter((contract) => declared.has(contract));
        if (bound.length === 0) absent.push(versions.join(" 或 "));
        else if (bound.length > 1) ambiguous.push(bound.join(" 与 "));
      }
      const allowed = new Set(requirements.flat());
      const extra = [...declared].filter((contract) => !allowed.has(contract));
      if (absent.length || ambiguous.length || extra.length) {
        return {
          ok: false,
          code: "invalid_module_plan",
          message:
            `release 的资源绑定与它声明的权限契约 ${contractId} 不一致`
            + (absent.length ? `；缺少 ${absent.join("、")}` : "")
            + (ambiguous.length ? `；同时绑定了 ${ambiguous.join("、")} — 只能选一个` : "")
            + (extra.length ? `；多出 ${extra.join("、")} — 没有人同意过这个 typed port` : ""),
        };
      }

      // "Every instance whose module needs one of these contracts is wired" is
      // a manifest question too; it moved to `checkoutPlanProblem()` with the
      // rest of them (2026-08-07).

      // And whether this deployment can serve every contract the plan names.
      // The shape/contract cross-check above already covers the ask; this
      // covers the PLAN, which may name a contract the ask does not imply.
      const installed = this.resourceContracts();
      const missing = [...declared].filter((contract) => !installed.has(contract));
      if (missing.length) {
        return {
          ok: false,
          code: "unsupported_resource_contract",
          message: `本部署没有为 ${missing.join("、")} 安装 provider，无法激活这个 release`,
        };
      }
      resourceBindings = read.value;
    }

    let appDir: string;
    try {
      appDir = await materialiseBackendTree(this.preparedRoot, descriptor.packageDigest, bytes);
    } catch (error) {
      return { ok: false, code: "materialise_failed", message: `无法落地 release 产物：${describe(error)}` };
    }

    let manifest: SessionPlusManifest;
    let backendCodeDigest: string;
    try {
      const models = this.agentModels();
      // The SEC-06 adapter verdict, the model closed set and every schema rule
      // are all inside this one call — so "which declarations may run here" has
      // exactly one implementation, and it is the one the App coordinator loads
      // its manifest with.
      manifest = loadSessionPlusManifest(appDir, models.length ? { allowedModels: models } : {});
      backendCodeDigest = backendRelease(appDir).backendCodeDigest;
    } catch (error) {
      return { ok: false, code: "invalid_declaration", message: `release 的应用声明不被本构建接受：${describe(error)}` };
    }

    const template = text(bytes.get(VIEW_ASSETS.template)!);
    const css = text(bytes.get(VIEW_ASSETS.css)!);
    const js = text(bytes.get(VIEW_ASSETS.js)!);
    try {
      splitViewTemplate(template);
    } catch (error) {
      return { ok: false, code: "invalid_declaration", message: `release 的 View 文档模板不可用：${describe(error)}` };
    }

    const identity = sessionPlusIdentityOf(descriptor, { backendCodeDigest });
    const sources = new Map<string, string>();
    for (const [name, content] of bytes) sources.set(name, text(content));

    return {
      ok: true,
      prepared: {
        descriptor,
        identity,
        manifest,
        appDir,
        releaseRecord: sessionPlusReleaseRecord({
          identity,
          descriptor,
          attestation: {
            builder: release.provenance.builder,
            builtAt: release.installedAt,
            statement: release.provenance.statement,
          },
        }),
        installedBy: release.installedBy,
        installedAt: release.installedAt,
        shape: shape.shape,
        modulePlan,
        resourceBindings,
        document: (nonce: string) => composeViewDocumentFrom(template, nonce, css, js),
        source: (name: string) => sources.get(name) ?? null,
      },
    };
  }

}
