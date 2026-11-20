/**
 * The minter's four properties, each of which the join depends on.
 *
 *  1. same directory, same identity  -> same key   (there is a join at all)
 *  2. any component differs          -> different  (the join is not a guess)
 *  3. the input never appears in it  -> opaque     (it can be projected)
 *  4. it cannot be turned back       -> one way    (it is not an address)
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isWorkspaceDirectoryKey } from "@claude-bot/workspace-files-contract";
import { WorkspaceDirectoryKeys, type WorkspaceDirectoryIdentity } from "./directory-key.js";

const BASE: WorkspaceDirectoryIdentity = {
  owner: "alice",
  publisher: "octopus:first-party",
  app: "session-plus",
  device: "laptop-routing-id",
  workspaceId: "ws_0123456789abcdef01234567",
  relativePath: "packages/bot",
};

describe("the directory key minter", () => {
  const keys = new WorkspaceDirectoryKeys();

  it("mints a key of the shape the contract reads", () => {
    const key = keys.mint(BASE)!;
    expect(isWorkspaceDirectoryKey(key)).toBe(true);
  });

  it("gives one directory one key, every time", () => {
    expect(keys.mint(BASE)).toBe(keys.mint({ ...BASE }));
  });

  it("gives a different key when ANY component differs", () => {
    const key = keys.mint(BASE);
    const variants: Array<Partial<WorkspaceDirectoryIdentity>> = [
      { owner: "bob" },
      { publisher: "someone-else" },
      { app: "notes" },
      { device: "desktop-routing-id" },
      { workspaceId: "ws_76543210fedcba9876543210" },
      { relativePath: "" },
      { relativePath: "packages/bots" },
      // Sibling directories with the same basename in one workspace, and the
      // same basename in two workspaces: both are the case the old label match
      // got wrong.
      { relativePath: "packages/bot/src" },
      { relativePath: "packages/runner" },
    ];
    for (const over of variants) {
      expect(keys.mint({ ...BASE, ...over }), JSON.stringify(over)).not.toBe(key);
    }
  });

  it("separates two processes: two minters never agree", () => {
    // The security consequence of the process-lifetime secret, stated as a test:
    // a key means nothing outside the process that made it, so a bot restart
    // cannot make an old tab's key match a new one's.
    expect(new WorkspaceDirectoryKeys().mint(BASE)).not.toBe(new WorkspaceDirectoryKeys().mint(BASE));
  });

  it("agrees with itself across two call sites given one secret", () => {
    // The property the composition root owes: ONE minter, shared. Constructed
    // with the same secret, two objects behave as one — which is what makes
    // "the sessions plane and the files plane produce the same key" checkable
    // without reaching into either of them.
    const secret = randomBytes(32);
    expect(new WorkspaceDirectoryKeys(secret).mint(BASE)).toBe(new WorkspaceDirectoryKeys(secret).mint(BASE));
  });

  it("contains none of what it was made from", () => {
    // A fixed secret, so this is a statement about the construction rather than
    // a 1-in-a-few-million assertion about random base64url.
    const key = new WorkspaceDirectoryKeys(Buffer.alloc(32, 7)).mint(BASE)!;
    for (const part of Object.values(BASE)) {
      if (!part) continue;
      expect(key).not.toContain(part);
    }
    expect(key.slice(4)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("refuses to mint rather than mint something weaker", () => {
    // Null is the whole fallback story. Every alternative — hashing a label,
    // hashing an empty string — produces a key that COMPARES, which is worse
    // than no key at all.
    for (const over of [
      { owner: "" },
      { publisher: "" },
      { app: "" },
      { device: "" },
      { workspaceId: "" },
    ]) {
      expect(keys.mint({ ...BASE, ...over }), JSON.stringify(over)).toBeNull();
    }
    // A root, on the other hand, is a real directory: `""` is its relative path.
    expect(keys.mint({ ...BASE, relativePath: "" })).not.toBeNull();
  });

  it("cannot be confused by a component that swallows a boundary", () => {
    // The reason the tuple is JSON rather than a joined string: `a|b` and
    // `a` + `|b` must not collide.
    const left = keys.mint({ ...BASE, workspaceId: "ws_a", relativePath: "b/c" });
    const right = keys.mint({ ...BASE, workspaceId: "ws_a\",\"b", relativePath: "c" });
    expect(left).not.toBe(right);
  });
});
