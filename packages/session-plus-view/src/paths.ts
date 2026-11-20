/**
 * The Node-side handle on this release's browser half: where the build output
 * lives, and exactly which inputs decide it.
 *
 * `packages/bot` imports this rather than spelling paths of its own, so
 * "the loader hashes what the build hashed" is one definition instead of two.
 * `vite.config.ts` names the same trees.
 *
 * ── Why the list keeps growing ──────────────────────────────────────────────
 *
 * The bundle is compiled from the workspace packages listed below, and each is a
 * source root here: the stale-build check is only as good as its input list. A
 * tree that is bundled but not hashed makes a real edit invisible — the loader
 * would serve yesterday's View under a hostname derived from yesterday's bytes,
 * internally consistent and completely wrong about what is running.
 * `view-source.test.ts` proves each root actually participates.
 *
 * Two joined with the editor batch: `agent-editor-view` (the module) and
 * `typed-port-kit` (which `workspace-files-contract` compiles in to declare and
 * encode its parameters). Two more with the document batch (2026-08-10):
 * `agent-crdt-view` (the document modules) and `crdt-doc-contract` (its port
 * vocabulary and remote adapter). `agent-text-view` now owns the shared
 * CodeMirror document surface used by both the reader and editor. Third-party
 * code — CodeMirror, Dockview, Yjs — is
 * covered by the lockfile and the package manifests below rather than by a
 * source root.
 *
 * One root is NOT bundle content: `agent-view-build/src` (2026-08-11, split out
 * of `agent-view-react`). It holds `agentViewViteConfig()` and the digest/
 * loader — the build RECIPE. Before the split those bytes sat inside
 * `agent-view-react/src` and were hashed incidentally; listing the new package
 * keeps that coverage, because a recipe edit that does not invalidate the
 * artifact is exactly the stale build this list exists to catch.
 */

import { fileURLToPath } from "node:url";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Where `pnpm --filter @claude-bot/session-plus-view build` writes. */
export const SESSION_PLUS_VIEW_DIST = at("../dist");

/** The command to print when the build is missing or stale. */
export const SESSION_PLUS_VIEW_BUILD_COMMAND = "pnpm --filter @claude-bot/session-plus-view build";

/**
 * Everything whose bytes decide the bundle: this App's composition, the neutral
 * chat surface, sessions and workspace-files modules, the resource contracts,
 * the module ABI, the Agent View SDK and its shared wire vocabulary (all
 * compiled in, not linked at runtime), the Vite/TypeScript config, every package
 * manifest, and the workspace lockfile that pins the actual toolchain.
 */
export const SESSION_PLUS_VIEW_SOURCE: AgentViewSourceInput = {
  roots: [
    at("."),
    at("../../agent-sessions-view/src"),
    at("../../chat-ui-commons/src"),
    at("../../agent-sessions-contract/src"),
    at("../../agent-workspace-files-view/src"),
    at("../../agent-file-preview/src"),
    at("../../agent-editor-view/src"),
    at("../../agent-text-view/src"),
    at("../../agent-crdt-view/src"),
    at("../../agent-feishu-view/src"),
    at("../../workspace-files-contract/src"),
    at("../../crdt-doc-contract/src"),
    at("../../typed-port-kit/src"),
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
    at("../../agent-sessions-view/package.json"),
    at("../../chat-ui-commons/package.json"),
    at("../../agent-sessions-contract/package.json"),
    at("../../agent-workspace-files-view/package.json"),
    at("../../agent-file-preview/package.json"),
    at("../../agent-editor-view/package.json"),
    at("../../agent-text-view/package.json"),
    at("../../agent-crdt-view/package.json"),
    at("../../agent-feishu-view/package.json"),
    at("../../workspace-files-contract/package.json"),
    at("../../crdt-doc-contract/package.json"),
    at("../../typed-port-kit/package.json"),
    at("../../resource-stream-contract/package.json"),
    at("../../agent-module-contract/package.json"),
    at("../../agent-view-react/package.json"),
    at("../../flight-recorder/package.json"),
    at("../../web-trust/package.json"),
    at("../../agent-view-build/package.json"),
    at("../../../pnpm-lock.yaml"),
  ],
};
