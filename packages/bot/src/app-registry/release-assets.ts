import { isModuleAuxAsset, MODULE_ENTRY_ASSET, moduleAssetName, readAppModuleEntry } from "@claude-bot/agent-view-build/module-assets";
/**
 * What a release of the `publisher-js` profile is MADE OF, for any app.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * Three things were written once, inside `session-plus-adapter.ts`, and every
 * one of them turned out to be a statement about the PROFILE rather than about
 * Session Plus:
 *
 *  · the closed asset inventories (`legacy` / `modular-v1` / `modular-v2` /
 *    `modular-v3`) and the refusal naming which of them a candidate failed to be;
 *  · the asset-name → relative-path map the App Runtime's directory is built
 *    from, and the atomic, idempotent write that builds it;
 *  · the self-consistency questions a module plan can answer about ITSELF
 *    (canonical bytes, and whose app it claims to be).
 *
 * Leaving them there would have made the second app's adapter import the first
 * app's adapter — the exact coupling the catalog generalisation (convergence
 * plan, decisions 2 and 11) exists to remove. Moving them here is a pure
 * extraction: `session-plus-adapter.ts` re-exports the two names its own tests
 * import, and every message below is byte-for-byte the one it produced before.
 *
 * ── What did NOT move, and why ──────────────────────────────────────────────
 *
 * Which permission contract a shape must declare, which typed ports that
 * contract needs, and how a binding plan is linked are questions about ONE app's
 * ask. They stay with that app's adapter, because an answer here would be a
 * platform-level claim about a decision only an app's own trusted code makes.
 *
 * ── Asset names still never become paths ────────────────────────────────────
 *
 * `BACKEND_LAYOUT` is a closed list of literal pairs spelled out in this file.
 * A descriptor's inventory is only ever COMPARED against it — never joined onto
 * a root — so "a release installs itself into /etc/cron.d" stays a code path
 * that does not exist rather than a check somebody has to remember.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  encodeComposition,
  encodeModuleLock,
  readModuleBundle,
  type LinkedComposition,
} from "@claude-bot/agent-module-contract";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
} from "@claude-bot/session-plus-view/plan";

/**
 * Asset name → relative path inside the materialised app directory.
 *
 * Both halves are literals in this file. Adding an asset to a release does not
 * add a file here; adding a file here is a deliberate edit that a reviewer sees.
 */
export const BACKEND_LAYOUT: ReadonlyArray<{ asset: string; file: string }> = Object.freeze([
  { asset: "app/app.yaml", file: "app.yaml" },
  { asset: "app/actions.ts", file: "actions.ts" },
  { asset: "app/projection.ts", file: "projection.ts" },
  { asset: "app/pages/main.yaml", file: path.join("pages", "main.yaml") },
]);

export const VIEW_ASSETS = Object.freeze({ template: "view.html", css: "view.css", js: "view.js" });

/**
 * The four release shapes this build knows how to run, as CLOSED SETS.
 *
 * ── Why exact sets and not "must contain" ───────────────────────────────────
 *
 * A release is either the original seven assets (`legacy`), those seven plus the
 * module plan (`modular-v1`), those nine plus the resource-binding plan
 * (`modular-v2`), or those ten plus the release's own permission declaration
 * (`modular-v3`). Anything else — half a plan, a binding document with no
 * modules to wire, a permission declaration with no bindings to authorise, an
 * extra asset, a name this build does not serve — is refused, because the
 * alternative is guessing which of the four a candidate meant to be. Half a plan
 * is the worst case: a composition without its lock would be a plan whose module
 * list nobody checked, and a binding document without a composition would name
 * instances nothing declares.
 *
 * All four stay activatable. The older three are the rollback targets, and a
 * rollback that stopped working the day a new format shipped would not be a
 * rollback.
 */
export const LEGACY_ASSETS: readonly string[] = Object.freeze(
  [...BACKEND_LAYOUT.map((row) => row.asset), VIEW_ASSETS.template, VIEW_ASSETS.css, VIEW_ASSETS.js].sort(),
);

export const MODULAR_V1_ASSETS: readonly string[] = Object.freeze(
  [...LEGACY_ASSETS, MODULE_LOCK_ASSET, COMPOSITION_ASSET].sort(),
);

export const MODULAR_V2_ASSETS: readonly string[] = Object.freeze(
  [...MODULAR_V1_ASSETS, RESOURCE_BINDINGS_ASSET].sort(),
);

export const MODULAR_V3_ASSETS: readonly string[] = Object.freeze(
  [...MODULAR_V2_ASSETS, PERMISSIONS_ASSET].sort(),
);

export type ReleaseShape = "legacy" | "modular-v1" | "modular-v2" | "modular-v3";

/**
 * The shapes that carry an `agent-resource-bindings/v1` plan.
 *
 * Written once because two adapters ask the question and they must not drift:
 * this one's `prepare()` links the plan, and the DECLARED-app adapter refuses
 * these shapes outright (a declared App may not bind user resources). A fourth
 * shape therefore forces a decision in one place instead of silently inheriting
 * whichever branch a `===` comparison happened to be written against.
 */
export const RESOURCE_BINDING_SHAPES = ["modular-v2", "modular-v3"] as const;

export type ResourceBindingShape = (typeof RESOURCE_BINDING_SHAPES)[number];

export function shapeBindsResources(shape: ReleaseShape): shape is ResourceBindingShape {
  return (RESOURCE_BINDING_SHAPES as readonly ReleaseShape[]).includes(shape);
}

/**
 * Which shape a descriptor's inventory is, or a refusal naming what is wrong.
 *
 * Decided from the inventory alone — no filesystem, no bytes — so the admin
 * listing can ask about every installed release without materialising any of
 * them.
 */
export function releaseShapeOf(
  names: readonly string[],
): { ok: true; shape: ReleaseShape } | { ok: false; message: string } {
  // ESM is an explicit additive browser format; old inventories stay exact.
  const module = names.includes(MODULE_ENTRY_ASSET);
  if (new Set(names).size !== names.length) return { ok: false, message: "duplicate release asset" };
  const sorted = names.filter((name) => !(module && isModuleAuxAsset(name))).sort();
  const same = (expected: readonly string[]): boolean =>
    sorted.length === expected.length && sorted.every((name, index) => name === expected[index]);
  if (same(LEGACY_ASSETS)) return { ok: true, shape: "legacy" };
  if (same(MODULAR_V1_ASSETS)) return { ok: true, shape: "modular-v1" };
  if (same(MODULAR_V2_ASSETS)) return { ok: true, shape: "modular-v2" };
  if (same(MODULAR_V3_ASSETS)) return { ok: true, shape: "modular-v3" };
  const present = new Set(sorted);
  const hasLock = present.has(MODULE_LOCK_ASSET);
  const hasComposition = present.has(COMPOSITION_ASSET);
  if (hasLock !== hasComposition) {
    return {
      ok: false,
      message:
        `release 只带了模块元数据的一半（${hasLock ? MODULE_LOCK_ASSET : COMPOSITION_ASSET} 有，`
        + `${hasLock ? COMPOSITION_ASSET : MODULE_LOCK_ASSET} 没有）；`
        + "组合与它的 lock 必须成对出现，否则模块清单没有被任何东西校验过",
    };
  }
  if (present.has(RESOURCE_BINDINGS_ASSET) && !hasLock) {
    return {
      ok: false,
      message:
        `release 带了 ${RESOURCE_BINDINGS_ASSET}，却没有模块组合；`
        + "资源绑定连接的是 composition 里的实例，没有 composition 就没有东西可以连",
    };
  }
  // An orphaned permission declaration is its own refusal, because the honest
  // sentence differs from "the inventory is not one of the four". A release that
  // states an ask but carries nothing that could exercise it is either a
  // declaration somebody added to the wrong package or a binding plan somebody
  // deleted from the right one — and BOTH would otherwise be described by the
  // generic message as merely "missing 一个资产", which reads like an incomplete
  // upload rather than like a contradiction.
  if (present.has(PERMISSIONS_ASSET) && !present.has(RESOURCE_BINDINGS_ASSET)) {
    return {
      ok: false,
      message:
        `release 带了 ${PERMISSIONS_ASSET}，却没有 ${RESOURCE_BINDINGS_ASSET}；`
        + "权限声明说的是这个 App 要读写哪些用户资源，而没有资源绑定就没有任何东西会用到它——"
        + "本构建不接受一份没有对应执行路径的权限声明",
    };
  }
  const missing = MODULAR_V3_ASSETS.filter((name) => !present.has(name) && LEGACY_ASSETS.includes(name));
  const unexpected = sorted.filter((name) => !MODULAR_V3_ASSETS.includes(name));
  return {
    ok: false,
    message:
      "release 的资产清单不是本构建认识的四种形状之一"
      + (missing.length ? `；缺少 ${missing.join("、")}` : "")
      + (unexpected.length ? `；多出 ${unexpected.slice(0, 4).join("、")}` : ""),
  };
}

/**
 * The questions a module plan can answer about ITSELF, and only those.
 *
 * Schema, identifier grammar, duplicate instances, unknown slots and — the
 * reason both documents travel together — every module reference resolving
 * inside the lock. Then two facts about the release: the bytes are canonical
 * (one plan, one digest-protected representation) and the plan claims the app
 * whose release it arrived in.
 *
 * Deliberately NOT linked against any build's compiled manifests. An installed
 * release's lock and View bundle were produced together and are covered by one
 * package digest — they are self-consistent whatever this checkout's manifests
 * say today. Auditing a historical release against TODAY's inventory is
 * checking an unrelated equation, and its concrete failure mode is that one
 * module version bump makes every previously installed release refuse to
 * activate: a rollback that stops working the day it is needed. (Convergence
 * plan, decision 11.) The manifest-backed questions are asked once, at pack
 * time, where "the manifests in this process" and "the manifests the bundle was
 * built from" are the same thing by definition.
 */
export function readReleaseModulePlan(input: {
  lockText: string;
  compositionText: string;
  appId: string;
}): { ok: true; plan: LinkedComposition } | { ok: false; message: string } {
  const read = readModuleBundle({ lockText: input.lockText, compositionText: input.compositionText });
  if (!read.ok) {
    const first = read.issues[0];
    return {
      ok: false,
      message: `release 的模块组合不被接受：${first?.at ?? "composition"}: ${first?.message ?? "校验失败"}`,
    };
  }
  if (
    encodeModuleLock(read.value.lock) !== input.lockText
    || encodeComposition(read.value.composition) !== input.compositionText
  ) {
    return {
      ok: false,
      message: "release 的模块组合不是 canonical JSON；同一份计划只能有一种受摘要保护的字节表示",
    };
  }
  if (read.value.composition.app !== input.appId) {
    return {
      ok: false,
      message: `release 的模块组合属于 ${read.value.composition.app}，不是 ${input.appId}`,
    };
  }
  return { ok: true, plan: read.value };
}

/**
 * Write one release's backend tree, atomically and idempotently.
 *
 * A directory that already exists and matches byte for byte is reused: a
 * release is immutable, so re-preparing it must not rewrite files a running
 * Runtime child has open. Anything else is built in a private temporary
 * directory and renamed into place, so a crash mid-write cannot leave a
 * half-materialised tree under the digest's name.
 *
 * The directory is named by the PACKAGE DIGEST, which covers the app id and the
 * publisher — so two apps cannot collide here even when a deployment points
 * every adapter at one prepared root.
 */
export async function materialiseBackendTree(
  preparedRoot: string,
  packageDigest: string,
  bytes: ReadonlyMap<string, Uint8Array>,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(packageDigest)) throw new Error("package digest is not a sha256 hex string");
  const root = path.resolve(preparedRoot);
  const target = path.join(root, packageDigest);
  if (await treeMatches(target, bytes)) return target;

  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.tmp-${packageDigest.slice(0, 16)}-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const row of BACKEND_LAYOUT) {
      const file = path.join(staging, row.file);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, bytes.get(row.asset)!, { mode: 0o600 });
    }
    try {
      await fs.rename(staging, target);
    } catch (error) {
      // Another writer won the race and produced the same immutable content.
      // Its directory is the one that exists; ours is the one to remove.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      await fs.rm(staging, { recursive: true, force: true });
      if (!(await treeMatches(target, bytes))) throw error;
    }
    return target;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function treeMatches(dir: string, bytes: ReadonlyMap<string, Uint8Array>): Promise<boolean> {
  for (const row of BACKEND_LAYOUT) {
    let onDisk: Buffer;
    try {
      onDisk = await fs.readFile(path.join(dir, row.file));
    } catch {
      return false;
    }
    const want = bytes.get(row.asset)!;
    if (sha256(onDisk) !== sha256(want)) return false;
  }
  return true;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** One release asset, as text. Assets are UTF-8 by the release format. */
export function assetText(content: Uint8Array): string {
  return Buffer.from(content).toString("utf8");
}

/** An error turned into one bounded, control-character-free line. */
export function describeAdapterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

/** A module release must be usable before activation, including every lazy asset. */
export function moduleAssetProblem(bytes: ReadonlyMap<string, Uint8Array>, appId: string): string | null {
  const manifest = bytes.get(MODULE_ENTRY_ASSET);
  if (!manifest) return null;
  const entry = readAppModuleEntry(assetText(manifest));
  if (!entry || entry.appId !== appId) return "App module manifest or runtime is incompatible";
  const declared = new Set(entry.assets.map(moduleAssetName));
  declared.add(MODULE_ENTRY_ASSET);
  for (const name of declared) if (!bytes.has(name)) return `App module asset missing: ${name}`;
  for (const name of bytes.keys()) {
    if (isModuleAuxAsset(name) && !declared.has(name)) return `App module asset not declared: ${name}`;
  }
  return null;
}
