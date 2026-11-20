// @vitest-environment node
/**
 * The pack e2e: this package's config through the REAL generic packer —
 * `packApp`/`buildAppBundle` from `packages/bot`, which drive the real
 * `bundleAppBackend` (so `chess.js` is genuinely inlined) and the real View
 * loader (so a stale bundle refuses). The refusal matrix itself is covered by
 * `backend-bundle.test.ts`; what this file pins is that the SECOND declared
 * App packs with zero code under `packages/bot` — the trusted tree is imported
 * here by relative path precisely because this package must not depend on it.
 *
 * Skipped, loudly, when `packages/chess-view/dist` has not been built.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentViewRelease } from "@claude-bot/agent-view-build/release";
import { buildAppBundle, packApp, readAppPackConfig } from "../../bot/src/app-registry/app-package.ts";
import { DeclaredAppAdapter, emptyContractDigestFor } from "../../bot/src/app-registry/declared-adapter.ts";
import { releaseShapeOf } from "../../bot/src/app-registry/release-assets.ts";
import { AppRuntimeService } from "../../app-runtime/src/index.ts";
import { AppStateService, InProcessStateClient } from "../../app-state/src/index.ts";
import { AppInstanceService } from "../../bot/src/app-registry/app-instance.ts";
import { DeclaredAppAgentBackend } from "../../bot/src/app-registry/declared-agent-backend.ts";
import { AgentLoop } from "../../bot/src/app-agents/loop.ts";
import { AppAgentPlane } from "../../bot/src/app-agents/plane.ts";
import { Store } from "../../bot/src/store/store.ts";
import CHESS_PACK, { CHESS_TITLE } from "./pack.js";
import { CHESS_APP, CHESS_PUBLISHER } from "./pack.js";
import { CHESS_VIEW_BUILD_COMMAND, CHESS_VIEW_DIST, CHESS_VIEW_SOURCE } from "./paths.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");

function viewBuilt(): boolean {
  try {
    loadAgentViewRelease({
      distDir: CHESS_VIEW_DIST,
      source: CHESS_VIEW_SOURCE,
      buildCommand: CHESS_VIEW_BUILD_COMMAND,
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
    "pack.test.ts: skipping — run `pnpm --filter @claude-bot/chess-view build` first\n",
  );
}

const asText = (bundle: { assets: ReadonlyArray<{ name: string; content: Uint8Array }> }, name: string): string => {
  const asset = bundle.assets.find((entry) => entry.name === name);
  expect(asset, name).toBeDefined();
  return Buffer.from(asset!.content).toString("utf8");
};

describe("packing the chess release through the generic packer", () => {
  when("plays a Luna reply through packaged SES rules, shared admission and the real model loop", { timeout: 60_000 }, async () => {
    const bundle = await buildAppBundle(CHESS_PACK);
    const dir = mkdtempSync(path.join(tmpdir(), "chess-computer-"));
    const appDir = path.join(dir, "app");
    mkdirSync(path.join(appDir, "pages"), { recursive: true });
    for (const file of ["app.yaml", "actions.ts", "projection.ts", "pages/main.yaml"]) {
      writeFileSync(path.join(appDir, file), asText(bundle, `app/${file}`));
    }
    const runtime = new AppRuntimeService(appDir);
    const state = new AppStateService(path.join(dir, "state"));
    const store = new Store(":memory:");
    const release = { ...bundle.descriptor, backendCodeDigest: runtime.release.backendCodeDigest, appDir };
    const requests: Array<Record<string, any>> = [];
    const tool = (name: string, args: unknown) => ({
      content: null,
      tool_calls: [{ id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    });
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      let message: unknown = { content: "" };
      if (requests.length === 1) message = tool("read_app_state", {});
      if (requests.length === 2) {
        const view = JSON.parse(request.messages.at(-1).content);
        expect(view).toMatchObject({ opponent: "computer", turn: "black", position_id: "2" });
        expect(view.computer).toMatchObject({ model: request.model, effort: request.reasoning_effort });
        expect(view.legal_moves).toContainEqual({ from: "1,4", to: ["2,4", "3,4"] });
        message = tool("computer_move", { position: view.position_id, from: "1,4", to: "3,4" });
      }
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let plane!: AppAgentPlane;
    const service = new AppInstanceService({
      state: new InProcessStateClient(state), runtime,
      activeRelease: () => release,
      servableRelease: (digest) => digest === release.packageDigest ? release : null,
      servablePackageDigests: () => new Set([release.packageDigest]),
      shared: {
        instance: (_app, key) => key === "asi_chess" ? { status: "open" } : undefined,
        member: (_app, key, user) => key === "asi_chess" && ["alice", "bob", "carol"].includes(user)
          ? { role: user === "alice" ? "white" : user === "bob" ? "black" : "watcher" } : undefined,
      },
      deliverAgent: (input) => plane.deliver(input),
    });
    const backend = new DeclaredAppAgentBackend("chess", service);
    plane = new AppAgentPlane({
      store, backends: [backend],
      loop: new AgentLoop({ baseUrl: "http://llm.invalid/v1", apiKey: "test-only", fetchImpl }),
    });
    try {
      const alice = { owner: "alice", credential: "web:a", session: true };
      const bob = { owner: "bob", credential: "web:b", session: true };
      const carol = { owner: "carol", credential: "web:c", session: true };
      const white = await service.open(alice, { instanceKey: "asi_chess" });
      const black = await service.open(bob, { instanceKey: "asi_chess" });
      const watcher = await service.open(carol, { instanceKey: "asi_chess" });
      expect(await service.dispatch(white.handle, alice, { action: "set_opponent", params: { opponent: "computer" } })).toMatchObject({ ok: true });
      expect(await service.dispatch(white.handle, alice, { action: "move", params: { from: "6,4", to: "4,4" } })).toMatchObject({ ok: true, result: { computer_position: "2" } });
      expect(await service.dispatch(black.handle, bob, { action: "move", params: { from: "1,4", to: "3,4" } })).toMatchObject({ ok: false, code: "action_rejected" });
      const params = { prompt: "请为 position_id=2 的局面走一步棋。" };
      expect(await service.dispatch(watcher.handle, carol, { action: "request_computer_move", params })).toMatchObject({ ok: false });
      expect(await service.dispatch(white.handle, alice, { action: "computer_move", params: { position: "2", from: "1,4", to: "3,4" } })).toMatchObject({ ok: false });
      expect(await service.dispatch(white.handle, alice, { action: "request_computer_move", params })).toMatchObject({ ok: true, result: { queued: true } });
      await plane.pump();
      expect(requests).toHaveLength(3);
      for (const request of requests) expect(request).toMatchObject({ model: "gpt-5.6-luna", reasoning_effort: "max" });
      const resolved = service.instances.resolve(white.handle, alice);
      expect(resolved.ok && resolved.binding.projection).toMatchObject({ turn: "white", position_id: "3", moves: [{ san: "e4", by: "alice" }, { san: "e5", by: "agent:chess/luna#black" }] });
      const log = await service.readLog("alice", { instanceKey: "asi_chess" });
      expect(log.ok && log.commits.filter((commit) => commit.action === "computer_move")).toHaveLength(1);
      const turn = await backend.openTurn({ scope: { kind: "shared", owner: "alice", instanceKey: "asi_chess" }, agent: "luna", turnId: "late" });
      try {
        expect(await turn.dispatch("computer_move", { position: "2", from: "1,4", to: "3,4" })).toMatchObject({ ok: false, message: expect.stringContaining("stale") });
      } finally {
        await turn.close();
      }
    } finally {
      plane.stop();
      service.stop();
      await runtime.stop();
      await state.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has a config the generic CLI would accept", () => {
    expect(readAppPackConfig(CHESS_PACK)).toBe(CHESS_PACK);
    expect(CHESS_PACK.title).toBe(CHESS_TITLE);
  });

  when("produces the seven-asset custom-root shape", { timeout: 60_000 }, async () => {
    const pkg = await packApp(readAppPackConfig(CHESS_PACK));
    expect(releaseShapeOf(pkg.assets.map((asset) => asset.name))).toEqual({ ok: true, shape: "legacy" });
  });

  when("inlines chess.js into both executable backend assets, leaving zero imports", { timeout: 60_000 }, async () => {
    const bundle = await buildAppBundle(readAppPackConfig(CHESS_PACK));
    for (const name of ["app/actions.ts", "app/projection.ts"]) {
      const source = asText(bundle, name);
      // chess.js's own piece vocabulary is IN the asset...
      expect(source).toContain("pnbrqkPNBRQK");
      // ...and no import survived the bundler (the runtime's own final check).
      expect(source).not.toMatch(/(^|\n)\s*import[ ({]/);
      expect(source.length).toBeGreaterThan(readFileSync(path.join(APP_DIR, name.slice("app/".length)), "utf8").length);
    }
    // Declarative assets pass through byte for byte.
    expect(asText(bundle, "app/app.yaml")).toBe(readFileSync(path.join(APP_DIR, "app.yaml"), "utf8"));
    expect(asText(bundle, "app/pages/main.yaml")).toBe(readFileSync(path.join(APP_DIR, "pages", "main.yaml"), "utf8"));
  });

  when("is exactly what the platform's own adapter is willing to run", { timeout: 60_000 }, async () => {
    const bundle = await buildAppBundle(readAppPackConfig(CHESS_PACK));
    expect(bundle.descriptor.stableAppId).toBe(CHESS_APP);
    expect(bundle.descriptor.publisher).toBe(CHESS_PUBLISHER);
    expect(bundle.descriptor.executionProfile).toBe("publisher-js");
    expect(bundle.descriptor.permissionContractDigest).toBe(emptyContractDigestFor(CHESS_APP, CHESS_PUBLISHER));
    const dir = mkdtempSync(path.join(tmpdir(), "chess-pack-"));
    try {
      const adapter = new DeclaredAppAdapter({
        declaration: { stableAppId: CHESS_APP, publisher: CHESS_PUBLISHER, title: CHESS_TITLE },
        preparedRoot: path.join(dir, "prepared"),
        hosting: { appDomain: "apps.example.com", scheme: "https:", publicPort: null, viewPort: 9821, viewHost: "127.0.0.1" },
      });
      expect(adapter.compatibility(bundle.descriptor)).toEqual({ supported: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  when("is deterministic: the same tree is the same package", { timeout: 60_000 }, async () => {
    expect((await buildAppBundle(CHESS_PACK)).descriptor.packageDigest)
      .toBe((await buildAppBundle(CHESS_PACK)).descriptor.packageDigest);
  });
});
