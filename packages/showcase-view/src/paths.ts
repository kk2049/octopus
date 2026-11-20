/**
 * The Node-side handle on this release's browser half: where the build output
 * lives, and exactly which inputs decide it.
 *
 * A packer or a loader imports this rather than spelling paths of its own, so
 * "the loader hashes what the build hashed" is one definition instead of two.
 * `vite.config.ts` names the same trees.
 *
 * ── Why a missing root is dangerous ─────────────────────────────────────────
 *
 * The bundle's BYTES are the release identity: they decide `viewAssetDigest`,
 * they feed `packageDigest`, and the first twenty hex characters of that become
 * the hostname the frame is served from. The stale-build check that keeps that
 * honest is only as good as its input list. A tree that is bundled but NOT
 * hashed makes a real edit invisible — the loader would happily serve
 * yesterday's View under a hostname derived from yesterday's bytes: internally
 * consistent, and completely wrong about what is running. That is strictly
 * worse than a build that refuses to start, which is why every tree below is
 * listed even though most of them change rarely.
 *
 * ── Which trees, and why exactly these ──────────────────────────────────────
 *
 * The list is the import closure of `src/main.tsx`, not a guess:
 *
 *   showcase-view/src          this App's composition, chrome and entry
 *   agent-data-view/src        `data.list/v1` `data.detail/v1` `data.form/v1`
 *   agent-deck-view/src        `deck.outline/v1` `deck.slide/v1` `deck.typst/v1`
 *   deck-model-contract/src    the deck document, its commands and the Typst map
 *   resource-stream-contract/src  the issue/refusal machinery the deck contract
 *                              validates through
 *   agent-module-contract/src  the module ABI (`plan.ts` encodes with it)
 *   agent-view-react/src       the SDK: transport, hooks, layout kernel, shell
 *   web-trust/src              the wire vocabulary the SDK re-exports
 *   agent-view-build/src       NOT bundled — the build recipe (2026-08-11 split
 *                              out of agent-view-react): `agentViewViteConfig`
 *                              and the digest/loader. Hashed so a toolchain
 *                              edit still invalidates the artifact, as it did
 *                              when these bytes lived inside the SDK root
 *
 * Deliberately ABSENT, because this App does not import them: the sessions,
 * workspace-files and editor packages, `typed-port-kit`, and every contract
 * behind a typed port. A showcase App binds no user resources at all — see the
 * header of `plan.ts`. Adding one of those to the App means adding it here in
 * the same edit.
 *
 * Third-party code is covered by the package manifests and the lockfile below
 * rather than by a source root.
 */

import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Where `pnpm --filter @claude-bot/showcase-view build` writes. */
export const SHOWCASE_VIEW_DIST = at("../dist");

/** The command to print when the build is missing or stale. */
export const SHOWCASE_VIEW_BUILD_COMMAND = "pnpm --filter @claude-bot/showcase-view build";

/**
 * Everything whose bytes decide the bundle: this App's composition, the six
 * reusable modules, the two contracts underneath them, the module ABI, the
 * Agent View SDK and its shared wire vocabulary (all compiled in, not linked at
 * runtime), the Vite/TypeScript config, every package manifest, and the
 * workspace lockfile that pins the actual toolchain.
 */
export const SHOWCASE_VIEW_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../agent-data-view/src"),
    at("../../agent-deck-view/src"),
    at("../../deck-model-contract/src"),
    at("../../resource-stream-contract/src"),
    at("../../agent-module-contract/src"),
    at("../../agent-view-react/src"),
    at("../../flight-recorder/src"),
    at("../../web-trust/src"),
    at("../../agent-view-build/src"),
  ],
  files: [
    at("../package.json"),
    at("../vite.config.ts"),
    at("../tsconfig.json"),
    at("../../agent-data-view/package.json"),
    at("../../agent-deck-view/package.json"),
    at("../../deck-model-contract/package.json"),
    at("../../resource-stream-contract/package.json"),
    at("../../agent-module-contract/package.json"),
    at("../../agent-view-react/package.json"),
    at("../../flight-recorder/package.json"),
    at("../../web-trust/package.json"),
    at("../../agent-view-build/package.json"),
    at("../../../pnpm-lock.yaml"),
  ],
};
