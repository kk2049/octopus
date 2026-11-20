/**
 * Does the stale-build check actually see the module packages?
 *
 * ── The failure this file exists to make impossible ─────────────────────────
 *
 * The View's bytes are its identity, and `loadAgentViewRelease` refuses a build
 * whose declared inputs no longer hash to what the manifest recorded. That
 * refusal is only as good as the input LIST: a package that is compiled into the
 * bundle but not hashed makes a real edit invisible — the process would serve
 * yesterday's View under a hostname derived from yesterday's bytes, which is
 * internally consistent and completely wrong about what is running. Before the
 * module platform there were two source roots; the read-only workspace browser
 * brought the count to nine, the editor to eleven, and the shared text surface
 * added one more explicit package root. This is what proves each participates.
 *
 * ── Why it copies the trees ─────────────────────────────────────────────────
 *
 * The honest check is "change a byte in package X and watch the digest move",
 * and doing that to the real checkout would be a test that edits the repository.
 * So each declared root is copied, the copies are hashed, and the byte is
 * changed in the copy. Roots are keyed BY INDEX inside the digest, so the copied
 * list stands in for the real one exactly.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentViewSourceDigest } from "@claude-bot/agent-view-build/release";
import { SESSION_PLUS_VIEW_SOURCE } from "@claude-bot/session-plus-view";

/**
 * Package src directory → a file inside it whose bytes are compiled in.
 *
 * The ORDER matters: roots are keyed by index inside the digest, and the second
 * test below asserts that the declared root at each index really is the package
 * it is about to edit. A reordering that went unnoticed would make every probe
 * test the wrong tree while still passing.
 */
const BUNDLED_PACKAGES: ReadonlyArray<{ root: string; probe: string }> = [
  { root: "session-plus-view/src", probe: "App.tsx" },
  { root: "agent-sessions-view/src", probe: "controller.ts" },
  { root: "chat-ui-commons/src", probe: "ChatTranscript.tsx" },
  { root: "agent-sessions-contract/src", probe: "port.ts" },
  { root: "agent-workspace-files-view/src", probe: "modules.tsx" },
  { root: "agent-file-preview/src", probe: "index.ts" },
  { root: "agent-editor-view/src", probe: "modules.tsx" },
  { root: "agent-text-view/src", probe: "index.ts" },
  { root: "agent-crdt-view/src", probe: "modules.tsx" },
  { root: "agent-feishu-view/src", probe: "modules.tsx" },
  { root: "workspace-files-contract/src", probe: "remote.ts" },
  { root: "crdt-doc-contract/src", probe: "remote.ts" },
  { root: "typed-port-kit/src", probe: "params.ts" },
  { root: "resource-stream-contract/src", probe: "stream.ts" },
  { root: "agent-module-contract/src", probe: "slots.ts" },
  { root: "agent-view-react/src", probe: "client.ts" },
  // The runtime's embedded debug channel records into this zero-dep package
  // (ticket #138), so its bytes are bundle content too.
  { root: "flight-recorder/src", probe: "recorder.ts" },
  { root: "web-trust/src", probe: "frame-protocol.ts" },
  // Not bundle content: the build recipe (2026-08-11, split out of
  // agent-view-react). A recipe edit must still invalidate the artifact.
  { root: "agent-view-build/src", probe: "build.ts" },
];

describe("Agent View source inputs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "view-source-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("declares every workspace package the bundle is compiled from", () => {
    const declared = SESSION_PLUS_VIEW_SOURCE.roots.map((root) => path.resolve(root));
    for (const { root } of BUNDLED_PACKAGES) {
      expect(
        declared.some((absolute) => absolute.split(path.sep).join("/").endsWith(root)),
        `${root} is bundled but not declared as a source root`,
      ).toBe(true);
    }
    expect(declared).toHaveLength(BUNDLED_PACKAGES.length);
    // And the manifests that pin the toolchain, including the lockfile.
    const files = (SESSION_PLUS_VIEW_SOURCE.files ?? []).map((file) => path.basename(file));
    expect(files).toContain("pnpm-lock.yaml");
    expect(files.filter((name) => name === "package.json")).toHaveLength(BUNDLED_PACKAGES.length);
  });

  it("changes the source digest when ANY of those packages changes", () => {
    // One copy of the declared inputs, hashed once as a baseline.
    const copies = SESSION_PLUS_VIEW_SOURCE.roots.map((root, index) => {
      const target = path.join(dir, `root-${index}`);
      cpSync(path.resolve(root), target, { recursive: true, filter: (source) => !source.includes("node_modules") });
      return target;
    });
    const fileCopies = (SESSION_PLUS_VIEW_SOURCE.files ?? []).map((file, index) => {
      const target = path.join(dir, `file-${index}-${path.basename(file)}`);
      writeFileSync(target, readFileSync(path.resolve(file)));
      return target;
    });
    const input = { roots: copies, files: fileCopies };
    const baseline = agentViewSourceDigest(input);

    for (const [index, { root, probe }] of BUNDLED_PACKAGES.entries()) {
      const declared = path.resolve(SESSION_PLUS_VIEW_SOURCE.roots[index]).split(path.sep).join("/");
      expect(declared.endsWith(root), `root ${index} is ${declared}, expected ${root}`).toBe(true);
      const file = path.join(copies[index], probe);
      const original = readFileSync(file);
      writeFileSync(file, `${original.toString("utf8")}\n// one byte of ${root}\n`);
      expect(agentViewSourceDigest(input), `${root} does not participate in the source digest`).not.toBe(baseline);
      writeFileSync(file, original);
      expect(agentViewSourceDigest(input)).toBe(baseline);
    }
  });

  it("changes the source digest when the lockfile changes", () => {
    const roots = SESSION_PLUS_VIEW_SOURCE.roots.map((root, index) => {
      const target = path.join(dir, `r-${index}`);
      cpSync(path.resolve(root), target, { recursive: true, filter: (source) => !source.includes("node_modules") });
      return target;
    });
    const lock = path.join(dir, "pnpm-lock.yaml");
    writeFileSync(lock, "lockfileVersion: '9.0'\n");
    const input = { roots, files: [lock] };
    const before = agentViewSourceDigest(input);
    writeFileSync(lock, "lockfileVersion: '9.0'\n# a dependency moved\n");
    expect(agentViewSourceDigest(input)).not.toBe(before);
  });
});
