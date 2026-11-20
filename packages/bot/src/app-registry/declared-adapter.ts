import { moduleAssetProblem } from "./release-assets.js";
/**
 * An Agentic App whose whole existence is a row in a table.
 *
 * ── What this is the last piece of ──────────────────────────────────────────
 *
 * Convergence plan, decision 2: "a new App = `pack → install → activate →
 * consent`, with zero trusted-code changes and zero framework restarts". P2
 * generalised the release host into a catalog, which made a second app *one
 * adapter constant plus one line of wiring*. That last constant is what this
 * file removes: the adapter is now CONSTRUCTED FROM PURE DATA
 * (`AppDeclaration` = id, publisher, title), so declaring an app is an insert
 * and a call rather than an edit and a deploy.
 *
 * The acceptance criterion is `declared-app.test.ts`, which stands up a second
 * app called `demo-notes` and drives it through install → activate without a
 * single source file of `packages/bot` mentioning it.
 *
 * ── What a declared App may be, and what it may NOT be ──────────────────────
 *
 * It may be any `publisher-js` release in the two shapes that carry no resource
 * bindings: the seven-asset `legacy` form and the nine-asset `modular-v1` form.
 * Both give it a full App Runtime backend (its own `actions.ts`/`projection.ts`,
 * its own durable App State) and a full Agent View bundle.
 *
 * It may NOT bind user resources. A ten-asset `modular-v2` release — the one
 * that carries `agent-resource-bindings/v1` — is refused, with the reason spelled
 * out at `SHAPE_REFUSAL` below: which typed ports exist, which provider serves
 * one, and which contract a Gate honours are all decisions belonging to platform
 * code that a reviewer merged and a deployer deployed (decision 2's stated
 * boundary: "new typed-port providers are always platform-level trusted code").
 * A declared App that could name a binding would be data naming an
 * implementation, and the whole binding layer's first rule is that a plan names
 * a NEED, never an implementation.
 *
 * Because of that, a declared App's permission contract is EMPTY, and the
 * descriptor has to say so: `compatibility()` recomputes the empty contract's
 * digest for this app and publisher and refuses anything else. That refusal is
 * the same one Session Plus makes about its own two contracts, for the same
 * reason — a release whose ask this build cannot project, grant or audit must
 * fail closed rather than be partially honoured.
 *
 * ── What this adapter is NOT ────────────────────────────────────────────────
 *
 * Not an authorization boundary (the panel's route table put `Administer` in
 * front of every caller), not App trust, and not a grant — it cannot reach
 * `app_trust`, `grant_intents` or the kernel. And not a store: `checkoutBundle()`
 * throws, because a declared App has no checkout to build from. Its bytes only
 * ever arrive through an explicit install.
 */

import type { AppReleaseDescriptor, InstalledRelease } from "@claude-bot/app-registry";
import type { LinkedComposition } from "@claude-bot/agent-module-contract";
import { backendRelease } from "@claude-bot/app-runtime";
import { contractDigestOf } from "@claude-bot/engine";
import { isResearchSessionContract } from '../session-resource/research-contract.js';
import {isDocsContract} from '../research-docs/contract.js';
import { isResearchCanvasContract } from '../research-canvas/contract.js';
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  RESOURCE_BINDINGS_ASSET,
} from "@claude-bot/session-plus-view/plan";
import {
  composeViewDocumentFrom,
  splitViewTemplate,
  type PublishedViewDocument,
} from "../app-core/view-app.js";
import { loadSessionPlusManifest, type SessionPlusManifest } from "../app-core/manifest.js";
import type { SessionPlusOriginPolicy, SessionPlusSettings } from "../app-core/settings.js";
import { viewHostFor, viewOriginFor, viewUrlFor } from "../app-core/settings.js";
import type { AppReleaseAdapter, AppReleaseCoexistence, AppRuntimeTarget } from "./adapter.js";
import type { ReleaseBundle } from "./bundle.js";
import {
  VIEW_ASSETS,
  assetText,
  describeAdapterError,
  materialiseBackendTree,
  readReleaseModulePlan,
  releaseShapeOf,
  shapeBindsResources,
  type ReleaseShape,
  type ResourceBindingShape,
} from "./release-assets.js";

/**
 * The grammar a declared app id must satisfy.
 *
 * The same one `AppBackendRegistry.register` enforces, because the id becomes a
 * directory name for that app's durable state. Checked here as well as there:
 * this is where a person's typing enters the system, and a refusal at the point
 * of entry names the field they got wrong instead of failing later inside a
 * composition step.
 */
export const DECLARED_APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The publisher grammar the registry's descriptor validator already enforces. */
export const DECLARED_PUBLISHER = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * Everything this platform is told about a declared App. All of it is data.
 *
 * There is deliberately nothing here that could name an implementation: no
 * module, no port, no provider, no directory, no command, no URL. What the App
 * DOES arrives inside a release, is covered by that release's package digest,
 * and is refused unless it is one of the shapes above.
 */
export interface AppDeclaration {
  stableAppId: string;
  publisher: string;
  /** Human label for the management page. Never an identity. */
  title: string;
}

/** A declaration that failed the grammar, with the field that failed named. */
export function declarationProblem(input: {
  stableAppId: string;
  publisher: string;
  title: string;
}): string | null {
  if (!DECLARED_APP_ID.test(input.stableAppId)) {
    return "app 必须是 1–64 个字符的小写 [a-z0-9][a-z0-9-]*（它同时是这个 App 状态目录的名字）";
  }
  if (!DECLARED_PUBLISHER.test(input.publisher) || input.publisher.length > 128) {
    return "publisher 必须是小写 [a-z0-9][a-z0-9._:-]*，且不超过 128 个字符";
  }
  const title = input.title.trim();
  if (!title || title.length > 120) return "title 必须是 1–120 个字符";
  if (/[\x00-\x1f\x7f]/.test(title)) return "title 不能包含控制字符";
  return null;
}

/**
 * The empty permission contract's digest, for one app and publisher.
 *
 * ── Why this is a function and not one constant ─────────────────────────────
 *
 * `contractDigestOf` puts the app id and the publisher INSIDE the digest — the
 * engine made that choice deliberately (`host/versions.ts`), because "the same
 * operations, vouched for by somebody else" is a different thing to agree to.
 * A single process-wide `EMPTY_CONTRACT_DIGEST` would therefore have to pick a
 * placeholder identity, and would then be a false statement about which app is
 * asking for nothing. So the empty ask is computed per app, mechanically, from
 * the one implementation of that framing.
 *
 * Empty means empty: no operations, no auto-allow, no deliveries, no per-action
 * or per-agent narrowing. A declared App applies for nothing, which is why it can
 * be declared by an admin rather than reviewed by one.
 */
export function emptyContractDigestFor(stableAppId: string, publisher: string): string {
  return contractDigestOf({
    app: stableAppId,
    publisher,
    operations: [],
    autoAllow: [],
    actions: {},
    agents: {},
    delivery: [],
  });
}

/**
 * Where a declared App's origins come from.
 *
 * Only the `app_domain` shape. `session_plus.view_origin` pins one exact
 * hostname to one exact release, which is a deployment that also wrote one
 * exact reverse-proxy site block — there is no second block for a second app,
 * and inventing one would publish an App at a name nobody routes. Refusing is
 * the honest answer, and `declaredAppHostingFrom` says so in one sentence.
 *
 * The fields are borrowed from the same configuration Session Plus resolved, so
 * a host has one App domain and one on-demand-TLS policy rather than a second
 * set of knobs that could disagree with the first.
 */
export interface DeclaredAppHosting {
  pathPrefix?: SessionPlusOriginPolicy["pathPrefix"];
  /** Host suffix every release is served under, e.g. `apps.example.org`. */
  appDomain: string;
  scheme: "https:" | "http:";
  /** Public port, when it is not the scheme's default. */
  publicPort: number | null;
  /** Local port this app's View listener would bind. */
  viewPort: number;
  /** Local interface for that listener. Loopback by default. */
  viewHost: string;
}

/**
 * The deployment shape one declared release is served under.
 *
 * Structurally the subset of `SessionPlusSettings` that is about SERVING rather
 * than about Session Plus: no identity object, no grants, no frame-ancestors
 * policy. `viewOriginOf` reads `viewOrigin`; nothing else in the platform reads
 * any of it today, because a declared App's View listener is not built yet (see
 * the worklog's "not done" list).
 */
export interface DeclaredAppSettings {
  viewOrigin: string;
  viewUrl?: string;
  viewHostHeader: string;
  origin: SessionPlusOriginPolicy;
  listenHost: string;
  listenPort: number;
}

/**
 * Borrow the App origin policy a deployment already configured.
 *
 * Returns a refusal rather than a fallback when the deployment pinned one exact
 * origin: a declared App under a pinned deployment would be served from a name
 * the proxy does not route, and a hot activation would be impossible anyway.
 */
export function declaredAppHostingFrom(
  base: SessionPlusSettings,
): { ok: true; hosting: DeclaredAppHosting } | { ok: false; error: string } {
  if (base.origin.pinnedLabel) {
    return {
      ok: false,
      error:
        "session_plus.view_origin 把 App 域钉在了一个精确主机名上，这种部署形态只服务一个 release，"
        + "无法再承载被声明的第二个 App。请改配 session_plus.app_domain（每个 release 自动得到自己的主机名），"
        + "并把反代改成受 ask 限制的 on-demand TLS。",
    };
  }
  return {
    ok: true,
    hosting: {
      appDomain: base.origin.domain,
      scheme: base.origin.scheme,
      publicPort: base.origin.publicPort,
      ...(base.origin.pathPrefix ? { pathPrefix: base.origin.pathPrefix } : {}),
      viewPort: base.listenPort,
      viewHost: base.listenHost,
    },
  };
}

/** One declared release, verified and ready to be served. Holding it grants nothing. */
export interface PreparedDeclaredRelease {
  declaration: AppDeclaration;
  descriptor: AppReleaseDescriptor;
  /** Validated App-owned state declaration used by the coexistence gate. */
  manifest: SessionPlusManifest;
  /** Materialised backend tree the App Runtime child is pointed at. */
  appDir: string;
  backendCodeDigest: string;
  /** `app-<first-20-hex>` — the label, not the whole hostname. */
  packageHostLabel: string;
  installedBy: string;
  installedAt: string;
  /** Which of the two supported inventories this release is. */
  shape: Exclude<ReleaseShape, ResourceBindingShape>;
  /** The validated assembly plan, for a `modular-v1` release. */
  modulePlan: LinkedComposition | null;
  /** Compose this release's document and its matching CSP policy. */
  document(nonce: string): PublishedViewDocument;
}

export type DeclaredPrepareRefusalCode =
  | "wrong_app"
  | "unsupported_profile"
  | "unknown_permission_contract"
  | "resource_bindings_not_allowed"
  | "missing_asset"
  | "invalid_declaration"
  | "invalid_module_plan"
  | "materialise_failed";

export type DeclaredPrepareOutcome =
  | { ok: true; prepared: PreparedDeclaredRelease }
  | { ok: false; code: DeclaredPrepareRefusalCode; message: string };

export interface DeclaredAppAdapterOptions {
  declaration: AppDeclaration;
  /** Root under which one directory per package digest is materialised. */
  preparedRoot: string;
  hosting: DeclaredAppHosting;
}

export const DECLARED_COEXISTENCE_REASONS = Object.freeze({
  permissionContract: "permission_contract_changed",
  manifestSchema: "manifest_schema_changed",
  stateScope: "state_scope_changed",
  stateEpochUndeclared: "state_epoch_undeclared",
  stateEpoch: "state_epoch_changed",
  executionProfile: "execution_profile_changed",
} as const);

/**
 * C1–C5 from the H1 multi-version state-safety contract, in consequence order.
 * Each comparison is over prepared immutable release facts; there is no live
 * state or authority lookup in this verdict.
 */
export function declaredReleaseCoexistence(
  previous: Pick<PreparedDeclaredRelease, "descriptor" | "manifest">,
  candidate: Pick<PreparedDeclaredRelease, "descriptor" | "manifest">,
): AppReleaseCoexistence {
  if (previous.descriptor.permissionContractDigest !== candidate.descriptor.permissionContractDigest) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.permissionContract };
  }
  if (previous.manifest.schema !== candidate.manifest.schema) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.manifestSchema };
  }
  if (previous.manifest.stateScope !== candidate.manifest.stateScope) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.stateScope };
  }
  if (!previous.manifest.stateEpochDeclared || !candidate.manifest.stateEpochDeclared) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.stateEpochUndeclared };
  }
  if (previous.manifest.stateEpoch !== candidate.manifest.stateEpoch) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.stateEpoch };
  }
  if (previous.descriptor.executionProfile !== candidate.descriptor.executionProfile) {
    return { coexist: false, reason: DECLARED_COEXISTENCE_REASONS.executionProfile };
  }
  return { coexist: true };
}

/** How much of a digest to show in a message; enough to compare by eye. */
const PREVIEW = 16;

export class DeclaredAppAdapter
implements AppReleaseAdapter<PreparedDeclaredRelease, DeclaredAppSettings> {
  readonly stableAppId: string;
  readonly publisher: string;
  readonly title: string;
  /** No source tree here: a declared App's bytes only ever arrive. */
  readonly seedsFromCheckout = false;
  private readonly declaration: AppDeclaration;
  private readonly preparedRoot: string;
  private readonly hosting: DeclaredAppHosting;
  /** The one ask a declared App is allowed to make: none. Computed once. */
  private readonly emptyContractDigest: string;

  constructor(options: DeclaredAppAdapterOptions) {
    const problem = declarationProblem(options.declaration);
    // A composition error rather than untrusted input: the route that accepts a
    // declaration checks the same grammar before writing a row, so reaching here
    // with a bad one means trusted code built an adapter it should not have.
    if (problem) throw new Error(`invalid app declaration: ${problem}`);
    this.declaration = {
      stableAppId: options.declaration.stableAppId,
      publisher: options.declaration.publisher,
      title: options.declaration.title.trim(),
    };
    this.stableAppId = this.declaration.stableAppId;
    this.publisher = this.declaration.publisher;
    this.title = this.declaration.title;
    this.preparedRoot = options.preparedRoot;
    this.hosting = options.hosting;
    this.emptyContractDigest = emptyContractDigestFor(this.stableAppId, this.publisher);
  }

  /** Is this release even addressed to the app this adapter serves? */
  supports(descriptor: AppReleaseDescriptor): boolean {
    return descriptor.stableAppId === this.stableAppId && descriptor.publisher === this.publisher;
  }

  /**
   * The refusals decidable from the descriptor alone — no filesystem, no child
   * process, no side effect.
   *
   * The management listing asks this about every installed release, so it has to
   * stay cheap: materialising every release to find out whether it could be
   * activated would make reading the page a write.
   */
  compatibility(
    descriptor: AppReleaseDescriptor,
  ): { supported: true } | { supported: false; code: DeclaredPrepareRefusalCode; message: string } {
    if (!this.supports(descriptor)) {
      return { supported: false, code: "wrong_app", message: "这个 release 属于另一个 App 或发布者" };
    }
    if (descriptor.executionProfile !== "publisher-js") {
      return {
        supported: false,
        code: "unsupported_profile",
        message: `本平台没有 ${descriptor.executionProfile} 执行 profile 的 App Runtime`,
      };
    }
    const shape = releaseShapeOf(descriptor.assets.map((asset) => asset.name));
    if (!shape.ok) return { supported: false, code: "missing_asset", message: shape.message };
    // Every shape that carries a binding plan, not one of them by name: a
    // declared App may not bind user resources, and `modular-v3` — which also
    // declares the contract it wants those bindings authorised under — is more
    // of that, not less.
    if (shapeBindsResources(shape.shape)) {
      return {
        supported: false,
        code: "resource_bindings_not_allowed",
        message:
          "被声明的 App 不能绑定用户资源：资源型 App 的权限契约、typed port 与 provider 按平台收敛计划决定 2 "
          + "属于平台代码，要经过评审与部署，不能由一条声明记录带进来。"
          // Named by ASSET, not by schema: the refusal is decided by the shape
          // (which assets are present), so a v2 plan is refused by this same
          // line and the message must not claim to have read a v1 document.
          + `本 release 带了 ${RESOURCE_BINDINGS_ASSET}，请改用不含它的 legacy(7) 或 modular-v1(9) 形状。`,
      };
    }
    // A declared App applies for nothing, and its descriptor has to SAY it
    // applies for nothing. Refusing anything else is the same refusal any app's
    // adapter makes about a contract this build cannot project, grant or audit:
    // partially honouring an unknown ask is how a widened permission set gets
    // inherited by silence.
    if (descriptor.permissionContractDigest !== this.emptyContractDigest && !isResearchSessionContract(this.stableAppId, this.publisher, descriptor.permissionContractDigest)
      && !isResearchCanvasContract(this.stableAppId, this.publisher, descriptor.permissionContractDigest)
      && !isDocsContract(this.stableAppId, this.publisher, descriptor.permissionContractDigest)) {
      return {
        supported: false,
        code: "unknown_permission_contract",
        message:
          `被声明的 App 只能携带空权限契约的 digest；期望 ${this.emptyContractDigest.slice(0, PREVIEW)}…，`
          + `收到 ${descriptor.permissionContractDigest.slice(0, PREVIEW)}…。`
          + "要申请任何用户资源 operation，需要平台侧为它写一份契约与 provider，那是一次评审与部署",
      };
    }
    return { supported: true };
  }

  coexistence(
    previous: PreparedDeclaredRelease,
    candidate: PreparedDeclaredRelease,
  ): AppReleaseCoexistence {
    return declaredReleaseCoexistence(previous, candidate);
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
  ): Promise<DeclaredPrepareOutcome> {
    const descriptor = release.descriptor;
    const compatible = this.compatibility(descriptor);
    if (!compatible.supported) return { ok: false, code: compatible.code, message: compatible.message };

    const shape = releaseShapeOf(descriptor.assets.map((asset) => asset.name));
    if (!shape.ok) return { ok: false, code: "missing_asset", message: shape.message };
    if (shapeBindsResources(shape.shape)) {
      // Unreachable: `compatibility()` refused it above. Restated so the type
      // narrows and so a future edit that reorders these two cannot widen what
      // a declared App may carry by accident.
      return { ok: false, code: "resource_bindings_not_allowed", message: "被声明的 App 不能绑定用户资源" };
    }

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

    // Only the questions the release answers about ITSELF: canonical bytes and
    // whose app the plan claims to be. This build compiles no manifests for a
    // declared App — its modules shipped inside its own bundle — so linking
    // against an inventory here would be checking an equation nobody wrote.
    // That is not a gap this file introduced: since 2026-08-07 the exact-identity
    // questions belong to pack time for every app (convergence plan, decision 11),
    // which is precisely what makes a foreign App's plan validatable at all.
    let modulePlan: LinkedComposition | null = null;
    if (shape.shape !== "legacy") {
      const read = readReleaseModulePlan({
        lockText: assetText(bytes.get(MODULE_LOCK_ASSET)!),
        compositionText: assetText(bytes.get(COMPOSITION_ASSET)!),
        appId: descriptor.stableAppId,
      });
      if (!read.ok) return { ok: false, code: "invalid_module_plan", message: read.message };
      modulePlan = read.plan;
    }

    let appDir: string;
    try {
      appDir = await materialiseBackendTree(this.preparedRoot, descriptor.packageDigest, bytes);
    } catch (error) {
      return { ok: false, code: "materialise_failed", message: `无法落地 release 产物：${describeAdapterError(error)}` };
    }

    let manifest: SessionPlusManifest;
    let backendCodeDigest: string;
    try {
      manifest = loadSessionPlusManifest(appDir, { appId: this.stableAppId });
      backendCodeDigest = backendRelease(appDir).backendCodeDigest;
    } catch (error) {
      return {
        ok: false,
        code: "invalid_declaration",
        message: `release 的应用后端不被本构建接受：${describeAdapterError(error)}`,
      };
    }

    const template = assetText(bytes.get(VIEW_ASSETS.template)!);
    const css = assetText(bytes.get(VIEW_ASSETS.css)!);
    const js = assetText(bytes.get(VIEW_ASSETS.js)!);
    try {
      // Validated here so a template with the wrong placeholders is a refusal at
      // prepare time rather than a document that renders with no styles and no
      // error. `composeViewDocumentFrom` re-splits per response; the template is
      // a few hundred bytes and having one implementation of that grammar is
      // worth more than the scan.
      splitViewTemplate(template);
    } catch (error) {
      return {
        ok: false,
        code: "invalid_declaration",
        message: `release 的 View 文档模板不可用：${describeAdapterError(error)}`,
      };
    }

    return {
      ok: true,
      prepared: {
        declaration: this.declaration,
        descriptor,
        manifest,
        appDir,
        backendCodeDigest,
        packageHostLabel: `app-${descriptor.packageDigest.slice(0, 20)}`,
        installedBy: release.installedBy,
        installedAt: release.installedAt,
        shape: shape.shape,
        modulePlan,
        document: (nonce: string) => composeViewDocumentFrom(template, nonce, css, js),
      },
    };
  }

  /** The deployment settings this release must be served under. */
  settingsFor(
    prepared: PreparedDeclaredRelease,
  ): { ok: true; settings: DeclaredAppSettings } | { ok: false; code: string; message: string } {
    const policy: SessionPlusOriginPolicy = {
      scheme: this.hosting.scheme,
      domain: this.hosting.appDomain,
      publicPort: this.hosting.publicPort,
      ...(this.hosting.pathPrefix ? { pathPrefix: this.hosting.pathPrefix } : {}),
      // Always null: a declared App exists only under the per-release hostname
      // shape, and `declaredAppHostingFrom` already refused the pinned one.
      pinnedLabel: null,
    };
    return {
      ok: true,
      settings: {
        viewOrigin: viewOriginFor(policy, prepared.packageHostLabel),
        ...(policy.pathPrefix ? { viewUrl: viewUrlFor(policy, prepared.packageHostLabel) } : {}),
        viewHostHeader: viewHostFor(policy, prepared.packageHostLabel),
        origin: policy,
        listenHost: this.hosting.viewHost,
        listenPort: this.hosting.viewPort,
      },
    };
  }

  /** Where the sandbox child loads this release's backend from. */
  runtimeTargetOf(prepared: PreparedDeclaredRelease): AppRuntimeTarget {
    return { appDir: prepared.appDir, backendCodeDigest: prepared.backendCodeDigest };
  }

  /** This release's document under one response nonce. */
  documentOf(prepared: PreparedDeclaredRelease, nonce: string): PublishedViewDocument {
    return prepared.document(nonce);
  }

  /** Where a browser reaches the active release. Display only. */
  viewOriginOf(settings: DeclaredAppSettings): string | null {
    return settings.viewOrigin;
  }

  /**
   * A declared App has no checkout.
   *
   * Throwing is the correct answer, not a gap: this platform did not build these
   * bytes and has no source tree to build them from, so there is nothing to seed
   * an empty registry with and nothing to compare an installed release against.
   * `HostedApp` treats the throw as "no servable release yet" and `describe()`
   * reports `checkout: null` rather than inventing a digest — which is exactly
   * the state a freshly declared App is in until somebody installs one.
   */
  checkoutBundle(): ReleaseBundle {
    throw new Error(
      `被声明的 App ${this.stableAppId} 没有 checkout：它的 release 只能从外部安装（在 /apps 上安装并激活一个 bundle）`,
    );
  }
}
