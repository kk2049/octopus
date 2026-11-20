/**
 * schema 3 (ADR 0007 P1/P3): the `state.scope`/`roles` declarations, and the
 * property the design leans on — a shared declaration is UNREADABLE by any
 * build that would have served it privately, because `roles` is a top-level
 * key schema 2's closed set refuses.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSessionPlusManifest } from "./manifest.js";

const dirs: string[] = [];

function appDirWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "manifest3-"));
  dirs.push(dir);
  writeFileSync(join(dir, "app.yaml"), yaml);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SHARED = `
id: demo_board
schema: 3
state_epoch: 9
state:
  scope: shared
roles:
  white: { max: 1 }
  black: { max: 1 }
  watcher: { max: 8, observer: true }
actions:
  move:
    binding: runtime
    handler: move
    roles: [white, black]
    params:
      from: { type: string, max: 8, required: true }
      to: { type: string, max: 8, required: true }
  comment:
    binding: runtime
    handler: comment
    roles: [white, black, watcher]
    params:
      text: { type: string, max: 80, required: true }
view:
  page: pages/main.yaml
`;

describe("app.yaml schema 3", () => {
  it("parses a shared declaration: scope, role vocabulary, action allowlists", () => {
    const manifest = loadSessionPlusManifest(appDirWith(SHARED), { appId: "demo_board" });
    expect(manifest.schema).toBe(3);
    expect(manifest.stateScope).toBe("shared");
    expect(manifest.stateEpoch).toBe(9);
    expect(manifest.stateEpochDeclared).toBe(true);
    expect(manifest.roles).toEqual({
      white: { max: 1, observer: false },
      black: { max: 1, observer: false },
      watcher: { max: 8, observer: true },
    });
    expect(manifest.actions.move!.roles).toEqual(["white", "black"]);
    expect(manifest.actions.comment!.roles).toEqual(["white", "black", "watcher"]);
  });

  it("defaults to account scope, where roles and action roles are refused", () => {
    const plain = loadSessionPlusManifest(
      appDirWith(
        "id: demo_board\nschema: 3\nactions:\n  reset: { binding: runtime, handler: reset }\nview:\n  page: p.yaml\n",
      ),
      { appId: "demo_board" },
    );
    expect(plain.stateScope).toBe("account");
    expect(plain.stateEpoch).toBe(0);
    expect(plain.stateEpochDeclared).toBe(false);
    expect(plain.roles).toEqual({});

    expect(() =>
      loadSessionPlusManifest(
        appDirWith(
          "id: demo_board\nschema: 3\nroles:\n  a: { max: 1 }\nactions:\n  reset: { binding: runtime, handler: reset }\nview:\n  page: p.yaml\n",
        ),
        { appId: "demo_board" },
      ),
    ).toThrow(/state\.scope is account/);

    expect(() =>
      loadSessionPlusManifest(
        appDirWith(
          "id: demo_board\nschema: 3\nactions:\n  reset: { binding: runtime, handler: reset, roles: [a] }\nview:\n  page: p.yaml\n",
        ),
        { appId: "demo_board" },
      ),
    ).toThrow(/not shared/);
  });

  it("refuses shared without roles, undeclared/repeated action roles, bad shapes", () => {
    expect(() =>
      loadSessionPlusManifest(
        appDirWith(
          "id: demo_board\nschema: 3\nstate: { scope: shared }\nactions:\n  reset: { binding: runtime, handler: reset }\nview:\n  page: p.yaml\n",
        ),
        { appId: "demo_board" },
      ),
    ).toThrow(/requires a top-level roles/);

    expect(() =>
      loadSessionPlusManifest(appDirWith(SHARED.replace("roles: [white, black]", "roles: [queen]")), {
        appId: "demo_board",
      }),
    ).toThrow(/undeclared role/);

    expect(() =>
      loadSessionPlusManifest(appDirWith(SHARED.replace("roles: [white, black]", "roles: [white, white]")), {
        appId: "demo_board",
      }),
    ).toThrow(/repeats role/);

    expect(() =>
      loadSessionPlusManifest(appDirWith(SHARED.replace("{ max: 8, observer: true }", "{ max: 0 }")), {
        appId: "demo_board",
      }),
    ).toThrow(/max in 1\.\.64/);

    expect(() =>
      loadSessionPlusManifest(appDirWith(SHARED.replace("scope: shared", "scope: global")), {
        appId: "demo_board",
      }),
    ).toThrow(/account or shared/);
  });

  it("keeps the fail-closed property: schema 2 refuses the same file by its top-level key", () => {
    // The IDENTICAL declaration, claiming schema 2: the closed set refuses
    // `roles` before anything could quietly serve the App per-account.
    expect(() =>
      loadSessionPlusManifest(appDirWith(SHARED.replace("schema: 3", "schema: 2")), { appId: "demo_board" }),
    ).toThrow(/unknown key\(s\): roles/);
  });

  it("allows one declared large payload but refuses two or a value above the wire ceiling", () => {
    const oneLarge = SHARED.replace(
      "text: { type: string, max: 80, required: true }",
      "text: { type: string, max: 262144, required: true }",
    );
    expect(loadSessionPlusManifest(appDirWith(oneLarge), { appId: "demo_board" }).actions.comment!.params.text!.max)
      .toBe(262144);

    const twoLarge = oneLarge.replace(
      "text: { type: string, max: 262144, required: true }",
      "text: { type: string, max: 262144, required: true }\n      file: { type: string, max: 262144 }",
    );
    expect(() => loadSessionPlusManifest(appDirWith(twoLarge), { appId: "demo_board" })).toThrow(/more than 1 parameter/);
    expect(() => loadSessionPlusManifest(
      appDirWith(oneLarge.replace("max: 262144", "max: 393217")),
      { appId: "demo_board" },
    )).toThrow(/invalid maximum/);
  });

  it("still reads schema 2 exactly as before", () => {
    const manifest = loadSessionPlusManifest(
      appDirWith(
        "id: demo_board\nschema: 2\nactions:\n  reset: { binding: runtime, handler: reset, title: 重置 }\nview:\n  page: p.yaml\n",
      ),
      { appId: "demo_board" },
    );
    expect(manifest.schema).toBe(2);
    expect(manifest.stateScope).toBe("account");
    expect(manifest.actions.reset!.title).toBe("重置");
  });
});
