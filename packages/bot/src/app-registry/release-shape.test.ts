/**
 * The four release shapes, and every way a fifth one could sneak in.
 *
 * ── What is actually being protected ────────────────────────────────────────
 *
 * A Session Plus release is either the original seven assets (`legacy`), those
 * seven plus the module plan (`modular-v1`), those nine plus the
 * resource-binding plan (`modular-v2`), or those ten plus the release's own
 * permission declaration (`modular-v3`). All four must stay installable and
 * activatable — the older three are the rollback targets, and a rollback that
 * stopped working the day a new format shipped would not be a rollback.
 *
 * Everything else must fail CLOSED, and two cases are worth naming. Half a plan:
 * a composition without its lock is a module list nobody validated, and
 * accepting it would let a release assemble something it never declared. And an
 * orphaned permission declaration: an ask stated by a package that carries
 * nothing which could exercise it is either a declaration added to the wrong
 * package or a binding plan deleted from the right one, and both deserve a
 * sentence that says so rather than "one asset is missing".
 *
 * So the check is an exact set membership rather than a "contains" test, which
 * also catches the other direction — an extra asset this build would materialise
 * without knowing what it is.
 */

import { describe, expect, it } from "vitest";
import {
  COMPOSITION_ASSET,
  MODULE_LOCK_ASSET,
  PERMISSIONS_ASSET,
  RESOURCE_BINDINGS_ASSET,
  SESSION_PLUS_COMPOSITION_JSON,
  SESSION_PLUS_MODULE_LOCK_JSON,
  SESSION_PLUS_PERMISSIONS_JSON,
  SESSION_PLUS_RESOURCE_BINDINGS_JSON,
} from "@claude-bot/session-plus-view/plan";
import {
  encodeAppPermissions,
  encodeComposition,
  encodeResourceBindings,
  linkResourceBindings,
  parseAppPermissions,
  parseComposition,
  parseModuleLock,
  parseResourceBindings,
} from "@claude-bot/agent-module-contract";
import { releaseShapeOf } from "./session-plus-adapter.js";

const BACKEND = ["app/app.yaml", "app/actions.ts", "app/projection.ts", "app/pages/main.yaml"];
const LEGACY = [...BACKEND, "view.html", "view.css", "view.js"];
const MODULAR = [...LEGACY, MODULE_LOCK_ASSET, COMPOSITION_ASSET];
const MODULAR_V2 = [...MODULAR, RESOURCE_BINDINGS_ASSET];
const MODULAR_V3 = [...MODULAR_V2, PERMISSIONS_ASSET];

describe("release shape", () => {
  it("recognises the seven-asset legacy release, in any order", () => {
    expect(releaseShapeOf(LEGACY)).toEqual({ ok: true, shape: "legacy" });
    expect(releaseShapeOf([...LEGACY].reverse())).toEqual({ ok: true, shape: "legacy" });
  });

  it("recognises the nine-asset modular release", () => {
    expect(releaseShapeOf(MODULAR)).toEqual({ ok: true, shape: "modular-v1" });
  });

  it("refuses half a module plan, and says which half is missing", () => {
    const onlyLock = releaseShapeOf([...LEGACY, MODULE_LOCK_ASSET]);
    expect(onlyLock.ok).toBe(false);
    expect(onlyLock.ok === false && onlyLock.message).toContain(COMPOSITION_ASSET);

    const onlyComposition = releaseShapeOf([...LEGACY, COMPOSITION_ASSET]);
    expect(onlyComposition.ok).toBe(false);
    expect(onlyComposition.ok === false && onlyComposition.message).toContain(MODULE_LOCK_ASSET);
  });

  it("recognises the ten-asset resource-binding release", () => {
    expect(releaseShapeOf(MODULAR_V2)).toEqual({ ok: true, shape: "modular-v2" });
    expect(releaseShapeOf([...MODULAR_V2].reverse())).toEqual({ ok: true, shape: "modular-v2" });
  });

  it("refuses a binding plan with no composition to wire", () => {
    // Connections name composition instances. A binding document arriving on
    // its own would declare a dependency for panels nothing declares — and the
    // dispatcher would then be resolving bindings for an App whose module list
    // nobody validated.
    const orphan = releaseShapeOf([...LEGACY, RESOURCE_BINDINGS_ASSET]);
    expect(orphan.ok).toBe(false);
    expect(orphan.ok === false && orphan.message).toContain(RESOURCE_BINDINGS_ASSET);
  });

  it("recognises the eleven-asset write release", () => {
    expect(releaseShapeOf(MODULAR_V3)).toEqual({ ok: true, shape: "modular-v3" });
    expect(releaseShapeOf([...MODULAR_V3].reverse())).toEqual({ ok: true, shape: "modular-v3" });
  });

  it("refuses a permission declaration with nothing it could authorise", () => {
    // An ask stated by a package that binds no resource. Whichever way round the
    // mistake happened — the declaration added to the wrong package, or the
    // binding plan deleted from the right one — the release states a permission
    // contract that no code path in it can exercise, and this build declines to
    // collect consent for that.
    for (const orphan of [[...LEGACY, PERMISSIONS_ASSET], [...MODULAR, PERMISSIONS_ASSET]]) {
      const refused = releaseShapeOf(orphan);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.message).toContain(PERMISSIONS_ASSET);
      expect(refused.message).toContain(RESOURCE_BINDINGS_ASSET);
    }
  });

  it("refuses a write release missing its binding plan or its module plan", () => {
    // The other direction of the same pairing: `modular-v3` is `modular-v2` PLUS
    // one asset, so dropping any of the ten is not a smaller shape.
    for (const name of [RESOURCE_BINDINGS_ASSET, COMPOSITION_ASSET, MODULE_LOCK_ASSET, "view.css"]) {
      const refused = releaseShapeOf(MODULAR_V3.filter((asset) => asset !== name));
      expect(refused.ok, name).toBe(false);
    }
  });

  it("refuses an asset this build does not serve", () => {
    for (const inventory of [MODULAR_V2, MODULAR_V3]) {
      const extra = releaseShapeOf([...inventory, "view/extra.js"]);
      expect(extra.ok).toBe(false);
      expect(extra.ok === false && extra.message).toContain("view/extra.js");
    }
  });

  it("refuses a release missing one of the seven", () => {
    const missing = releaseShapeOf(LEGACY.filter((name) => name !== "view.css"));
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.message).toContain("view.css");
  });
});

describe("the module plan this checkout ships", () => {
  it("is canonical, and round-trips through the contract's own reader", () => {
    const lock = parseModuleLock(SESSION_PLUS_MODULE_LOCK_JSON);
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(lock.ok).toBe(true);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(encodeComposition(composition.value)).toBe(SESSION_PLUS_COMPOSITION_JSON);
  });

  it("ships a canonical, linkable resource-binding plan", () => {
    const parsed = parseResourceBindings(SESSION_PLUS_RESOURCE_BINDINGS_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(encodeResourceBindings(parsed.value)).toBe(SESSION_PLUS_RESOURCE_BINDINGS_JSON);
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    // Every connection names an instance this composition declares. The
    // `port` half is pinned in the App's own plan test, where the module
    // manifests — and therefore their `ports` declarations — exist.
    expect(linkResourceBindings(parsed.value, composition.value).ok).toBe(true);
  });

  it("ships a canonical permission declaration naming exactly one known ask", () => {
    const parsed = parseAppPermissions(SESSION_PLUS_PERMISSIONS_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(encodeAppPermissions(parsed.value)).toBe(SESSION_PLUS_PERMISSIONS_JSON);
    // The value the shape table must agree with. Written as a literal on
    // purpose: recomputing it from the same constant would only prove the
    // encoder is deterministic, while this fails the moment the checkout starts
    // asking for something else — which is precisely the change that must never
    // ride along with a refactor. Moved to the chat-upload ask on
    // 2026-08-21; the release adds a bounded write under the selected Runner's
    // Generic regular-file downloads are a wider read than media preview, so
    // Owner-local absolute-path reads are a wider scope than registered
    // workspaces, so existing users must consent to the v6 contract.
    expect(parsed.value.contract).toBe("sessions-workspace-write-crdt-self-service/v7");
  });

  it("references only modules the lock contains", () => {
    const lock = parseModuleLock(SESSION_PLUS_MODULE_LOCK_JSON);
    const composition = parseComposition(SESSION_PLUS_COMPOSITION_JSON);
    if (!lock.ok || !composition.ok) throw new Error("the shipped plan does not parse");
    const locked = new Set(lock.value.modules.map((row) => row.id));
    for (const row of composition.value.instances) expect(locked.has(row.module)).toBe(true);
    for (const row of composition.value.open) expect(locked.has(row.module)).toBe(true);
  });
});
