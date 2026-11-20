import { moduleAssetName } from "@claude-bot/agent-view-build/module-assets";
/**
 * Building one DECLARED App's release out of this checkout — the generic half.
 *
 * ── Why this is a factory and not a per-app file ────────────────────────────
 *
 * The first declared App's packer (`showcase-package.ts`) was ~260 lines, and
 * the second app's would have differed from it by a handful of constants.
 * Everything else — load the built View or refuse a stale one, bundle the two
 * executable backend files, assemble the closed inventory, optionally link a
 * module plan, and describe the release — is a statement about the PLATFORM's
 * release format, not about any app. So it lives here once, and an app's packer
 * is an `AppPackConfig`.
 *
 * That split is ADR 0007 §6 made structural: adding a coordination App to this
 * tree adds a config in the app's own package and NOTHING under `packages/bot`.
 * This file must therefore stay free of any app's vocabulary — no app id, no
 * game words, no module names.
 *
 * ── What a packer is, and is not (unchanged from the showcase original) ─────
 *
 * "App = pure data" is a claim about the platform, not about where bytes come
 * from. This code does what an outside publisher's own packer would do: read a
 * built Agent View bundle and four backend files, hand them to
 * `describeRelease`, and produce an artifact. The proof that it is not
 * privileged: every digest it computes is RECOMPUTED by `install()` from the
 * bytes, and every refusal that decides whether the release can run is
 * `DeclaredAppAdapter`'s — this file cannot relax any of them. What it can do
 * is fail EARLY, at pack time, on the checks that would otherwise only show up as
 * an un-activatable artifact:
 *
 *  1. the inventory must be exactly the seven-asset custom-root `legacy` shape
 *     or the nine-asset `modular-v1` shape (a declared App may not bind user
 *     resources);
 *  2. when present, the module plan must link against THIS build's compiled manifests —
 *     pack time is the one moment where "the manifests in this process" and
 *     "the manifests the bundle was built from" are the same thing by
 *     definition (convergence-plan decision 11).
 *
 * It writes no database row, contacts no host by itself and changes nothing
 * about what anything serves. Producing bytes, handing them to a host, and
 * deciding to serve them are three separate acts (`runAppPackCli`'s flags).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describeRelease, packageHostLabel } from "@claude-bot/app-registry";
import {
  linkComposition,
  readModuleBundle,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import { loadAgentViewRelease, type AgentViewSourceInput } from "@claude-bot/agent-view-build/release";
import { loadSessionPlusManifest } from "../app-core/manifest.js";
import { COMPOSITION_ASSET, MODULE_LOCK_ASSET } from "@claude-bot/session-plus-view/plan";
import { APP_ACTIONS_FILE, APP_PROJECTION_FILE } from "@claude-bot/app-runtime";
import { checkoutLockfileHash } from "../app-core/identity.js";
import { VIEW_APP_HTML, type PackageAsset } from "../app-core/view-app.js";
import { bundleAppBackend } from "./backend-bundle.js";
import { emptyContractDigestFor } from "./declared-adapter.js";
import { RESEARCH_SESSION_CONTRACT_DIGEST, RESEARCH_SESSION_PROFILE_ID, isResearchSessionContract } from '../session-resource/research-contract.js';
import {DOCS_DIGEST,DOCS_PROFILE,isDocsContract} from '../research-docs/contract.js';
import { RESEARCH_CANVAS_DIGEST, RESEARCH_CANVAS_PROFILE_ID, isResearchCanvasContract } from '../research-canvas/contract.js';
import { BACKEND_LAYOUT, VIEW_ASSETS, releaseShapeOf } from "./release-assets.js";
import { bundleToWire, type ReleaseBundle } from "./bundle.js";

/**
 * Everything one declared App's release build needs to say about itself.
 *
 * Data only, so it can live in the app's own package (which must not import
 * this trusted tree) and be handed over by the generic pack CLI as a module it
 * loads by path.
 */
export interface AppPackConfig {
  /** A compiled-in reviewed profile; absence retains the empty contract. */
  resourceProfile?: string;
  /** The stable app id — the `app` every plan document must claim. */
  app: string;
  /** Who vouches for these bytes. Compared, never resolved. */
  publisher: string;
  /** Human title for the declaration (`--declare`). */
  title: string;
  /** Absolute path of the directory holding the four backend files. */
  appDir: string;
  /** Repo-relative package directory, e.g. `packages/showcase-view`. */
  subdir: string;
  /** The built Agent View: where it is, what decided it, how to rebuild it. */
  view: { distDir: string; source: AgentViewSourceInput; buildCommand: string };
  /**
   * Every module this app's bundle compiles, keyed below for pack-time linking.
   * Omit together with `moduleAssets` for a bespoke/custom React root.
   */
  manifests?: readonly AgentModuleManifest[];
  /**
   * The two canonical module-plan JSON assets, in inventory order. Omit together
   * with `manifests` when the View does not claim to be a module composition.
   */
  moduleAssets?: ReadonlyArray<{ name: string; source: string }>;
}

/** A loaded pack-config module's default export, checked field by field. */
export function readAppPackConfig(value: unknown): AppPackConfig {
  const row = value as Partial<AppPackConfig> | null | undefined;
  const failed = (what: string): never => {
    throw new Error(`打包配置不完整：${what}（形状见 app-package.ts 的 AppPackConfig）`);
  };
  if (!row || typeof row !== "object") failed("默认导出不是对象");
  if (row?.resourceProfile !== undefined && !(row.resourceProfile === RESEARCH_SESSION_PROFILE_ID && isResearchSessionContract(row.app ?? '', row.publisher ?? '', RESEARCH_SESSION_CONTRACT_DIGEST))
    && !(row.resourceProfile === RESEARCH_CANVAS_PROFILE_ID && isResearchCanvasContract(row.app ?? '', row.publisher ?? '', RESEARCH_CANVAS_DIGEST))
    && !(row.resourceProfile === DOCS_PROFILE && isDocsContract(row.app ?? '', row.publisher ?? '', DOCS_DIGEST))) failed('未知或不匹配的资源 profile');
  for (const key of ["app", "publisher", "title", "appDir", "subdir"] as const) {
    if (typeof row![key] !== "string" || !row![key]) failed(`${key} 必须是非空字符串`);
  }
  const view = row!.view;
  if (!view || typeof view.distDir !== "string" || typeof view.buildCommand !== "string"
    || !view.source || !Array.isArray(view.source.roots)) {
    failed("view 需要 distDir、buildCommand 与 source");
  }
  const hasManifests = row!.manifests !== undefined;
  const hasModuleAssets = row!.moduleAssets !== undefined;
  if (hasManifests !== hasModuleAssets) failed("manifests 与 moduleAssets 必须同时提供或同时省略");
  if (hasManifests && (!Array.isArray(row!.manifests) || row!.manifests.length === 0)) {
    failed("模块化 View 的 manifests 必须是非空数组");
  }
  if (hasModuleAssets && (!Array.isArray(row!.moduleAssets) || row!.moduleAssets.length !== 2)) {
    failed("模块化 View 的 moduleAssets 必须恰好是两个资产");
  }
  return row as AppPackConfig;
}

/**
 * The seven custom-root assets or nine modular assets, in inventory order.
 *
 * Backend names come from `BACKEND_LAYOUT` rather than being retyped: that
 * constant is the platform's closed asset-name → relative-path map, and a
 * second spelling here is exactly the kind of drift that produces a release the
 * materialiser cannot lay down.
 */
export async function packApp(config: AppPackConfig): Promise<{ assets: readonly PackageAsset[] }> {
  // The manifest is validated AT PACK TIME with the same loader the trusted
  // coordinator uses lazily at first open. Without this, a malformed app.yaml
  // (the first real case: an unquoted CJK description whose comma split a YAML
  // flow mapping into an unknown key) packs, declares, installs and activates
  // cleanly, then explodes on the first user's open as "后端暂时不可用" —
  // four green ceremonies and one red user. Same loader, zero second grammar.
  try {
    loadSessionPlusManifest(config.appDir, { appId: config.app });
  } catch (error) {
    throw new Error(
      `${config.app} 的 app.yaml 无法通过 manifest 校验，拒绝打包：${(error as Error).message}`,
    );
  }
  // `packApp` is also imported directly by tests and package-specific CLIs, so
  // validate the same cross-field profile invariant as the dynamic config
  // loader. Keep this AFTER the app manifest gate: a malformed manifest should
  // still be diagnosed at the product declaration, not obscured by later build
  // metadata (the regression test below this module pins that ordering).
  readAppPackConfig(config);
  // Missing, truncated or STALE is refused, and stale is the dangerous one: it
  // is internally consistent — the digest matches those bytes and the hostname
  // matches that digest — and the only thing wrong with it is that it is not
  // the code in the tree.
  const view = loadAgentViewRelease({
    distDir: config.view.distDir,
    source: config.view.source,
    buildCommand: config.view.buildCommand,
    expectedOutputs: ["agent-view.js", "agent-view.css"],
    allowModuleAssets: true,
  });
  const built = (name: string): string => {
    const found = view.assets.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(`${config.app} Agent View 产物缺少 ${name}；请重新构建：${config.view.buildCommand}`);
    }
    return found.source;
  };
  // The two EXECUTABLE backend files go through the pack-time bundler (ADR 0007
  // P6): an import-free file passes through byte-identically, one with imports
  // is inlined into a single self-contained module or refused. Declarative
  // assets (`app.yaml`, pages) are read raw as before.
  const backendAssets: PackageAsset[] = [];
  for (const row of BACKEND_LAYOUT) {
    const file = path.join(config.appDir, row.file);
    if (row.file === APP_ACTIONS_FILE || row.file === APP_PROJECTION_FILE) {
      const packed = await bundleAppBackend(file, config.appDir);
      backendAssets.push({ name: row.asset, source: packed.source });
    } else {
      backendAssets.push({ name: row.asset, source: readFileSync(file, "utf8") });
    }
  }
  const assets: PackageAsset[] = [
    // The document template is the platform's, and it is a release ASSET so an
    // installed release carries its own copy. Sharing the constant here is not
    // sharing a runtime — it is this packer choosing the same grammar the
    // adapter validates (`splitViewTemplate`).
    { name: VIEW_ASSETS.template, source: VIEW_APP_HTML },
    { name: VIEW_ASSETS.css, source: built("agent-view.css") },
    { name: VIEW_ASSETS.js, source: built("agent-view.js") },
    ...view.assets.filter((row) => !["agent-view.js", "agent-view.css"].includes(row.name)).map((row) => ({ name: moduleAssetName(row.name), source: row.source })),
    ...(config.moduleAssets ?? []).map((asset) => ({ name: asset.name, source: asset.source })),
    ...backendAssets,
  ];

  // The shape check, before anything is digested. A tenth asset here would be a
  // release that installs and then refuses to activate; saying so at pack time
  // is the difference between a build error and a deployment mystery.
  const shape = releaseShapeOf(assets.map((asset) => asset.name));
  if (!shape.ok) throw new Error(`${config.app} 的资产清单不被接受：${shape.message}`);
  const expectedShape = config.moduleAssets ? "modular-v1" : "legacy";
  if (shape.shape !== expectedShape) {
    throw new Error(
      `${config.app} 的 pack 配置声明 ${expectedShape}，实际资产却是 ${shape.shape}。`
        + "被声明的 App 只能发布 custom-root legacy 或无资源绑定的 modular-v1 release",
    );
  }

  const problem = planProblem(config, assets);
  if (problem) throw new Error(`${config.app} 的模块计划无法通过构建期校验：${problem}`);
  return { assets };
}

/**
 * The BUILD-TIME half of module-plan validation.
 *
 * Deliberately the only half that checks a plan against compiled manifests, and
 * deliberately against THIS app's manifests rather than any other's: a plan
 * names a module id, and the only inventory in which that means anything is the
 * one this bundle was built from.
 */
export function planProblem(config: AppPackConfig, assets: readonly PackageAsset[]): string | null {
  const byName = new Map(assets.map((asset) => [asset.name, asset.source]));
  const lockText = byName.get(MODULE_LOCK_ASSET);
  const compositionText = byName.get(COMPOSITION_ASSET);
  if (config.manifests === undefined && config.moduleAssets === undefined) {
    return lockText === undefined && compositionText === undefined
      ? null
      : "custom-root View 不应携带模块计划";
  }
  if (lockText === undefined || compositionText === undefined) {
    return `模块计划只有一半：${MODULE_LOCK_ASSET} 与 ${COMPOSITION_ASSET} 必须成对`;
  }
  const bundle = readModuleBundle({ lockText, compositionText });
  if (!bundle.ok) {
    const first = bundle.issues[0];
    return `模块组合不自洽：${first?.at ?? "composition"}: ${first?.message ?? "校验失败"}`;
  }
  if (bundle.value.composition.app !== config.app) {
    return `模块组合属于 ${bundle.value.composition.app}，不是 ${config.app}`;
  }
  const buildManifests = new Map(config.manifests!.map((manifest) => [manifest.id, manifest]));
  const linked = linkComposition(bundle.value.composition, bundle.value.lock, buildManifests);
  if (!linked.ok) {
    const first = linked.issues[0];
    return `模块组合与本构建的清单不符：${first?.at ?? "composition"}: ${first?.message ?? "校验失败"}`;
  }
  return null;
}

/**
 * Describe the release this checkout would publish for one config.
 *
 * Pure with respect to the platform: it takes bytes and returns a description
 * of them, and `install()` recomputes every digest from the artifact rather
 * than believing any of it.
 */
export async function buildAppBundle(
  config: AppPackConfig,
  options: { builder?: string; statement?: string } = {},
): Promise<ReleaseBundle> {
  const pkg = await packApp(config);
  const bytes = (source: string): Uint8Array => new Uint8Array(Buffer.from(source, "utf8"));
  const viewNames = [
    VIEW_ASSETS.template,
    VIEW_ASSETS.css,
    VIEW_ASSETS.js,
    ...(config.moduleAssets ?? []).map((asset) => asset.name),
    ...pkg.assets.filter((asset) => asset.name.startsWith("view/assets/") || asset.name === "view/entry.json").map((asset) => asset.name),
  ];
  const snapshot = assetSnapshotDigest(pkg.assets);
  const descriptor = describeRelease({
    stableAppId: config.app,
    publisher: config.publisher,
    executionProfile: "publisher-js",
    // Generic Apps request no host resources. The reviewed first-party profile
    // uses the same closed contract definition checked by trusted composition.
    permissionContractDigest: config.resourceProfile === RESEARCH_SESSION_PROFILE_ID ? RESEARCH_SESSION_CONTRACT_DIGEST
      : config.resourceProfile === DOCS_PROFILE ? DOCS_DIGEST : config.resourceProfile === RESEARCH_CANVAS_PROFILE_ID ? RESEARCH_CANVAS_DIGEST : emptyContractDigestFor(config.app, config.publisher),
    assets: pkg.assets.map((asset) => ({ name: asset.name, content: bytes(asset.source) })),
    composition: {
      view: viewNames,
      backend: BACKEND_LAYOUT.map((row) => row.asset),
    },
    source: {
      // `platform-hosted`: this platform built these bytes out of its own tree,
      // which is the true sentence here. An artifact that arrived already built
      // would be `vcs`/`external-attestation` — somebody's claim rather than
      // this host's own act.
      kind: "platform-hosted",
      digest: snapshot,
      repository: "platform://octopus/source",
      commit: `sha256:${snapshot}`,
      subdir: config.subdir,
    },
    buildInput: {
      entry: `${config.subdir}/app/app.yaml`,
      toolchain: {
        builder: `octopus:${config.app}-release-v1`,
        format: "named-utf8-assets",
        lockfile: "pnpm-lock.yaml",
      },
      lockfileHash: checkoutLockfileHash(),
    },
  });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({ name: asset.name, content: bytes(asset.source) })),
    provenance: {
      kind: "platform-built",
      builder: options.builder ?? `octopus:${config.app}-packer`,
      statement:
        options.statement
        ?? "由本机 checkout 直接构建：View 产物经加载器校验（缺失/截断/陈旧一律拒绝），"
          + (config.moduleAssets
            ? "模块计划在打包期对本构建的清单逐条 link，"
            : "custom-root View 明确不声明模块计划，")
          + "后端四个文件取自同一棵源码树；"
          + "可执行后端经打包期纯依赖内联校验（零 import 文件逐字节原样通过）。",
      signatureVerification: "none",
    },
  };
}

/**
 * A snapshot digest over the named assets.
 *
 * The same framing `assetDigest` uses for Session Plus. It is EVIDENCE inside
 * the descriptor, not an identity: `packageDigest` is recomputed by the
 * registry from the bytes, and a wrong value here would only produce a
 * different — and still self-consistent — identity rather than let anything
 * past a check.
 */
function assetSnapshotDigest(assets: readonly PackageAsset[]): string {
  const h = createHash("sha256");
  for (const asset of assets) {
    // `\0` written as an escape, not as a literal NUL: the framing is identical
    // at runtime, and a source file containing a real NUL is one git classifies
    // as binary — no diff, no review, no blame.
    h.update(`${asset.name}\0${Buffer.byteLength(asset.source, "utf8")}\0`);
    h.update(asset.source, "utf8");
  }
  return h.digest("hex");
}

/**
 * The four separate acts a pack CLI can perform, and why the flags are separate:
 *
 * ```text
 *   pack       produce bytes                       (always)
 *   declare    tell a host this App exists         (--declare)
 *   install    give the host the bytes             (--publish)
 *   activate   decide to serve them                (--activate)
 * ```
 *
 * Every one of them is a different permission or a different decision, and a
 * single command that did all four would merge them. `--declare` comes FIRST
 * when it is asked for, because `AppReleaseHost.install` refuses a bundle for
 * an app it does not compose — declaring is what makes the host compose it.
 * `--token` is an admin account's personal `dt_` key: every route it calls is
 * `Administer`, and a bearer credential is accepted for writes because it is
 * not ambient and therefore needs no CSRF.
 */
export async function runAppPackCli(config: AppPackConfig, argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const bundle = await buildAppBundle(config);
  const wire = bundleToWire(bundle);
  const digest = bundle.descriptor.packageDigest;
  const total = bundle.assets.reduce((sum, asset) => sum + asset.content.byteLength, 0);

  process.stdout.write(
    `app            : ${config.publisher}/${config.app}\n`
      + `package digest : ${digest}\n`
      + `host label     : ${packageHostLabel(digest)}\n`
      + `contract       : ${bundle.descriptor.permissionContractDigest} (${config.resourceProfile ?? '空契约'})\n`
      + `assets         : ${bundle.assets.length} 个 / ${total} 字节\n`,
  );

  if (args.out) {
    const target = path.resolve(args.out);
    writeFileSync(target, `${JSON.stringify(wire)}\n`, { mode: 0o600 });
    process.stdout.write(`written        : ${target}\n`);
  }

  if (args.publish) {
    if (!args.token) throw new Error("--publish 需要 --token（管理员账号的 dt_ 密钥）");
    if (args.declare) {
      // Before the install, deliberately: a host that has not been told this
      // App exists refuses its bytes with `unknown_app`, and a 409 `app_exists`
      // here is the normal answer on every run after the first.
      await post(args.publish, "/api/apps/declare", args.token, {
        app: config.app,
        publisher: config.publisher,
        title: config.title,
      });
    }
    const installed = await post(args.publish, "/api/apps/install", args.token, { bundle: wire });
    if (!installed.ok) throw new Error("install 未被接受，未继续激活");
    if (args.activate) {
      // Opt-in. Installing is safe; activating changes what every user's next
      // page load runs, and that is not a decision a build script should make
      // by default.
      await post(args.publish, "/api/apps/activate", args.token, {
        app: config.app,
        package_digest: digest,
      });
    } else {
      process.stdout.write("已安装但未激活 — 在 /apps 上决定是否切换，或加 --activate\n");
    }
  }

  if (!args.out && !args.publish) {
    process.stdout.write(
      "\n没有 --out 也没有 --publish，所以只打印了这次构建的身份。\n"
        + `用法: pnpm run app:pack:${config.app} -- --out <file> `
        + "[--publish <url> --token <dt_...> [--declare] [--activate]]\n",
    );
  }
}

interface Args {
  out: string | null;
  publish: string | null;
  token: string | null;
  declare: boolean;
  activate: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { out: null, publish: null, token: null, declare: false, activate: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out") { args.out = value ?? null; i++; }
    else if (flag === "--publish") { args.publish = value ?? null; i++; }
    else if (flag === "--token") { args.token = value ?? null; i++; }
    else if (flag === "--declare") args.declare = true;
    else if (flag === "--activate") args.activate = true;
    else if (flag === "--help" || flag === "-h") { args.out = null; args.publish = null; }
  }
  return args;
}

async function post(base: string, route: string, token: string, body: unknown): Promise<Response> {
  const url = new URL(route, base);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  process.stdout.write(`${route} → HTTP ${res.status} ${text.slice(0, 400)}\n`);
  return res;
}
