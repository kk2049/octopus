/**
 * The showcase packer, and the property that actually matters about it.
 *
 * A packer that produced an artifact the platform then refuses would be worse
 * than no packer: the refusal would arrive at ACTIVATION, on a host, after
 * somebody had already installed it. So the case that carries this file is not
 * "the digest is stable" — it is that `DeclaredAppAdapter.compatibility()`, the
 * platform's own answer about whether a declared release can run, says yes to
 * exactly what `buildShowcaseBundle()` produces.
 *
 * Skipped, loudly, when `packages/showcase-view/dist` has not been built: these
 * assertions are about real bytes, and a version of them that ran without the
 * bundle would be asserting something weaker while looking the same.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentViewRelease } from "@claude-bot/agent-view-build/release";
import { SHOWCASE_APP, SHOWCASE_PUBLISHER } from "@claude-bot/showcase-view/plan";
import {
  SHOWCASE_VIEW_BUILD_COMMAND,
  SHOWCASE_VIEW_DIST,
  SHOWCASE_VIEW_SOURCE,
} from "@claude-bot/showcase-view";
import { DeclaredAppAdapter } from "./declared-adapter.js";
import { emptyContractDigestFor } from "./declared-adapter.js";
import { BACKEND_LAYOUT, releaseShapeOf } from "./release-assets.js";
import { SHOWCASE_APP_DIR, SHOWCASE_TITLE, buildShowcaseBundle } from "./showcase-package.js";

/**
 * Is the Agent View bundle built? If not, every case here is about nothing.
 * Probed with the same sync loader the packer calls first, because the packer
 * itself is now async (the backend bundling step) and skip-vs-run must be
 * decided at collect time.
 */
function viewBuilt(): boolean {
  try {
    loadAgentViewRelease({
      distDir: SHOWCASE_VIEW_DIST,
      source: SHOWCASE_VIEW_SOURCE,
      buildCommand: SHOWCASE_VIEW_BUILD_COMMAND,
      expectedOutputs: ["agent-view.js", "agent-view.css"],
    });
    return true;
  } catch {
    return false;
  }
}

const built = viewBuilt();
const when = built ? it : it.skip;
if (!built) {
  process.stdout.write(
    "showcase-package.test.ts: skipping — run `pnpm --filter @claude-bot/showcase-view build` first\n",
  );
}

describe("the showcase release packer", () => {
  when("produces the nine-asset modular-v1 shape, and nothing else", async () => {
    const bundle = await buildShowcaseBundle();
    const names = bundle.descriptor.assets.map((asset) => asset.name);
    // The tenth asset (`view/resource-bindings.json`) is what would make this a
    // `modular-v2` release, and `DeclaredAppAdapter.compatibility()` refuses
    // that shape outright with `resource_bindings_not_allowed`: which typed
    // ports exist and which provider serves one are platform decisions a
    // reviewer merged, not something a declaration can bring in.
    expect(releaseShapeOf(names)).toEqual({ ok: true, shape: "modular-v1" });
    expect(names).not.toContain("view/resource-bindings.json");
    expect(names).toHaveLength(9);
  });

  when("declares the empty permission contract, computed by the platform's own function", async () => {
    const bundle = await buildShowcaseBundle();
    expect(bundle.descriptor.stableAppId).toBe(SHOWCASE_APP);
    expect(bundle.descriptor.publisher).toBe(SHOWCASE_PUBLISHER);
    expect(bundle.descriptor.executionProfile).toBe("publisher-js");
    expect(bundle.descriptor.permissionContractDigest)
      .toBe(emptyContractDigestFor(SHOWCASE_APP, SHOWCASE_PUBLISHER));
  });

  when("produces exactly what this build is willing to run", async () => {
    // The load-bearing case. Everything above is the packer agreeing with
    // itself; this is the packer agreeing with the platform's refusals.
    const dir = mkdtempSync(path.join(tmpdir(), "showcase-pack-"));
    try {
      const adapter = new DeclaredAppAdapter({
        declaration: { stableAppId: SHOWCASE_APP, publisher: SHOWCASE_PUBLISHER, title: SHOWCASE_TITLE },
        preparedRoot: path.join(dir, "prepared"),
        hosting: { appDomain: "apps.example.com", scheme: "https:", publicPort: null, viewPort: 9821, viewHost: "127.0.0.1" },
      });
      expect(adapter.compatibility((await buildShowcaseBundle()).descriptor)).toEqual({ supported: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  when("carries the four backend files byte for byte", async () => {
    const bundle = await buildShowcaseBundle();
    for (const row of BACKEND_LAYOUT) {
      const asset = bundle.assets.find((entry) => entry.name === row.asset);
      expect(asset, row.asset).toBeDefined();
      expect(Buffer.from(asset!.content).toString("utf8"))
        .toBe(readFileSync(path.join(SHOWCASE_APP_DIR, row.file), "utf8"));
    }
  });

  when("is deterministic: the same tree is the same package", async () => {
    // Not a nicety — the package digest is the hostname the frame is served
    // from, so a packer whose output moved on its own would change an App's
    // address without anybody changing the App.
    expect((await buildShowcaseBundle()).descriptor.packageDigest)
      .toBe((await buildShowcaseBundle()).descriptor.packageDigest);
  });
});
