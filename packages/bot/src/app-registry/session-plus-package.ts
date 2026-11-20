/**
 * Building one Session Plus release out of this checkout.
 *
 * This is the BUILDER half of the release contract, and it is deliberately the
 * only place in the bot that turns source files into an installable artifact.
 * `install()` recomputes every digest from the bytes it is handed, so nothing
 * here is trusted — what it buys is that the first boot of a fresh deployment,
 * the packer CLI and the tests all produce the same package for the same tree.
 *
 * It never publishes anything. Producing a bundle and installing one are two
 * calls, because "whoever can run a build" and "whoever may change what this
 * host serves" are two different permissions.
 */

import type { InstallProvenance } from "@claude-bot/app-registry";
import {
  encodeAppPermissions,
  linkComposition,
  linkResourceBindings,
  parseAppPermissions,
  parseResourceBindings,
  readModuleBundle,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
  SESSION_PLUS_MANIFESTS,
} from "@claude-bot/session-plus-view/plan";
import { bundledAppDir } from "../app-core/app-path.js";
import {
  checkoutLockfileHash,
  sessionPlusDescriptor,
  sessionPlusReleasePackage,
} from "../app-core/identity.js";
import { viewPackage, type AppPackage } from "../app-core/view-app.js";
import type { ReleaseBundle } from "./bundle.js";

/**
 * The transport shape moved to `bundle.ts` when the release host became a
 * catalog: a bundle is app-agnostic, and the platform core must be able to name
 * one without importing Session Plus's builder. Re-exported here so every
 * existing caller of this module keeps working unchanged.
 */
export {
  BUNDLE_KIND,
  DEFAULT_BUNDLE_LIMITS,
  bundleToWire,
  parseBundle,
  type BundleLimits,
  type BundleParse,
  type ReleaseBundle,
  type ReleaseBundleWire,
} from "./bundle.js";

/** Every module this build compiles, keyed by id — the pack-time ground truth. */
const BUILD_MANIFESTS: ReadonlyMap<string, AgentModuleManifest> = new Map(
  SESSION_PLUS_MANIFESTS.map((manifest) => [manifest.id, manifest]),
);

/**
 * The BUILD-TIME half of module-plan validation, and deliberately the only half
 * that checks a plan against this build's compiled manifests.
 *
 * The pack path is the one place where "the manifests compiled into this
 * process" and "the manifests the bundle was built from" are the same thing by
 * definition — both come from the checkout being packed. So this is where the
 * exact-identity questions belong: does the lock name precisely this build's
 * inventory, does every instance sit in a slot its module accepts, is every
 * open rule routed at a module that opens that kind, is every declared port
 * wired to every instance whose module asked for it.
 *
 * `prepare()` (the install/activate half) asks NONE of these questions, on
 * purpose. An installed release's View bundle and its lock were produced
 * together and are covered by the same package digest — they are self-
 * consistent whatever this build's manifests say today. Auditing a historical
 * release against TODAY's inventory is checking an unrelated equation, and its
 * concrete failure mode is that bumping one module version makes every
 * previously installed release refuse to activate — a rollback that stops
 * working the day you need it. (Convergence plan, decision 11.)
 *
 * Returns a human-readable problem or null. Exported so tests can hand it
 * tampered assets; `buildCheckoutBundle` throws on it because a checkout that
 * cannot validate its own plan is a programming error, not untrusted input.
 */
export function checkoutPlanProblem(
  assets: ReadonlyArray<{ name: string; source: string }>,
): string | null {
  const byName = new Map(assets.map((asset) => [asset.name, asset.source]));
  const lockText = byName.get(MODULE_LOCK_ASSET);
  const compositionText = byName.get(COMPOSITION_ASSET);
  const bindingsText = byName.get(RESOURCE_BINDINGS_ASSET);
  // First, because it is independent of everything below: a declaration is
  // checkable whether or not the package has a plan, and hoisting it means no
  // early return for "no bindings to validate" can also skip it.
  const declarationProblem = permissionsProblem(byName.get(PERMISSIONS_ASSET));
  if (declarationProblem) return declarationProblem;
  if (lockText === undefined && compositionText === undefined && bindingsText === undefined) {
    return null; // a legacy-shaped package has no plan to validate
  }
  if (lockText === undefined || compositionText === undefined) {
    return `模块计划只有一半：${MODULE_LOCK_ASSET} 与 ${COMPOSITION_ASSET} 必须成对`;
  }
  const bundle = readModuleBundle({ lockText, compositionText });
  if (!bundle.ok) {
    const first = bundle.issues[0];
    return `模块组合不自洽：${first?.at ?? "composition"}: ${first?.message ?? "校验失败"}`;
  }
  const linked = linkComposition(bundle.value.composition, bundle.value.lock, BUILD_MANIFESTS);
  if (!linked.ok) {
    const first = linked.issues[0];
    return `模块组合与本构建的清单不符：${first?.at ?? "composition"}: ${first?.message ?? "校验失败"}`;
  }
  if (bindingsText === undefined) return null;
  const plan = parseResourceBindings(bindingsText);
  if (!plan.ok) {
    const first = plan.issues[0];
    return `资源绑定计划不被接受：${first?.at ?? "bindings"}: ${first?.message ?? "校验失败"}`;
  }
  // `linkResourceBindings` with manifests already enforces the whole wiring
  // story, including "every instance whose module declares one of the plan's
  // contracts is connected" — per instance, not per module. No manual pass
  // needed here; the linker owns that vocabulary.
  const wired = linkResourceBindings(plan.value, bundle.value.composition, BUILD_MANIFESTS);
  if (!wired.ok) {
    const first = wired.issues[0];
    return `资源绑定与组合不匹配：${first?.at ?? "bindings"}: ${first?.message ?? "校验失败"}`;
  }
  return null;
}

/**
 * The permission declaration, checked for exactly the two properties a BUILDER
 * can check: it parses, and its bytes are the canonical ones.
 *
 * Whether it names the contract this shape is ALLOWED to declare is not asked
 * here, deliberately — that is the adapter's question, on the install path,
 * where a release that arrived from somewhere is being decided about. Asking it
 * twice would put the shape→contract table in two places, and the pack path is
 * not where it belongs: `checkoutPlanProblem` exists for the questions only this
 * checkout's compiled manifests can answer, and this build's own package is
 * described from the very constants the table is compared against.
 */
function permissionsProblem(source: string | undefined): string | null {
  if (source === undefined) return null;
  const read = parseAppPermissions(source);
  if (!read.ok) {
    const first = read.issues[0];
    return `权限声明不被接受：${first?.at ?? "permissions"}: ${first?.message ?? "校验失败"}`;
  }
  if (encodeAppPermissions(read.value) !== source) {
    return "权限声明不是 canonical JSON；同一份声明只能有一种受摘要保护的字节表示";
  }
  return null;
}

/**
 * Describe the Session Plus release this checkout would publish.
 *
 * Requires the Agent View to have been built: the loader refuses a missing,
 * truncated or STALE bundle, and a stale one is the dangerous case because it is
 * internally consistent — the digest matches those bytes and the hostname
 * matches that digest; the only thing wrong is that it is not the code in the
 * tree.
 */
export function buildCheckoutBundle(options: {
  builder?: string;
  statement?: string;
  view?: AppPackage;
  appDir?: string;
} = {}): ReleaseBundle {
  const pkg = sessionPlusReleasePackage(
    options.view ?? viewPackage(),
    options.appDir ?? bundledAppDir("session-plus"),
  );
  const problem = checkoutPlanProblem(pkg.assets);
  if (problem) {
    throw new Error(`本 checkout 的模块计划无法通过构建期校验：${problem}`);
  }
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: checkoutLockfileHash() });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: {
      // `platform-built`: this platform produced the artifact from the declared
      // source and build input. Anything that arrives already built is an
      // `external-attestation`, i.e. somebody's claim — the registry refuses to
      // record a signature verification that does not happen.
      kind: "platform-built",
      builder: options.builder ?? "octopus:session-plus-packer",
      statement:
        options.statement
        ?? "由本机 checkout 直接构建：View 产物经加载器校验（缺失/截断/陈旧一律拒绝），后端与声明取自同一棵源码树。",
      signatureVerification: "none",
    },
  };
}
