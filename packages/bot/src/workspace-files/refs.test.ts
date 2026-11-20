import { describe, expect, it } from "vitest";
import { WorkspaceRefLimitError, WorkspaceRefVault, type WorkspaceRefRecord } from "./refs.js";

const binding = {
  device: "laptop",
  deviceLabel: "我的笔记本",
  workspaceId: "ws_0123456789abcdef01234567",
  workspaceLabel: "demo",
};

function record(over: Partial<WorkspaceRefRecord> = {}): WorkspaceRefRecord {
  return {
    scope: "scope-1",
    owner: "alice",
    kind: "file",
    binding,
    relativePath: "src/a.ts",
    label: "a.ts",
    ...over,
  };
}

describe("WorkspaceRefVault", () => {
  it("mints an unguessable ref that carries nothing about the resource", () => {
    const vault = new WorkspaceRefVault();
    const ref = vault.mint(record());

    expect(ref).toMatch(/^wf_[A-Za-z0-9_-]{32}$/);
    expect(ref).not.toContain("laptop");
    expect(ref).not.toContain("ws_");
    expect(ref).not.toContain("src");
    // Nothing decodes to anything: it is 192 bits of randomness with a prefix.
    expect(Buffer.from(ref.slice(3), "base64url").toString("utf8")).not.toContain("a.ts");
  });

  it("is stable for the same resource in the same scope and different across scopes", () => {
    const vault = new WorkspaceRefVault();
    expect(vault.mint(record())).toBe(vault.mint(record()));
    // The label is display, not identity: re-listing with a nicer label must not
    // hand a consumer a second ref for the file it already has open.
    expect(vault.mint(record({ label: "renamed" }))).toBe(vault.mint(record()));
    expect(vault.mint(record({ scope: "scope-2" }))).not.toBe(vault.mint(record()));
    expect(vault.mint(record({ relativePath: "src/b.ts" }))).not.toBe(vault.mint(record()));
    expect(vault.mint(record({ kind: "directory" }))).not.toBe(vault.mint(record()));
  });

  it("does not let delimiter-shaped trusted fields collide in the reverse index", () => {
    const vault = new WorkspaceRefVault();
    const first = vault.mint(record({ scope: "a\u0000b", owner: "c" }));
    const second = vault.mint(record({ scope: "a", owner: "b\u0000c" }));
    expect(first).not.toBe(second);
  });

  it("refuses forged, cross-scope, cross-owner and wrong-kind refs", () => {
    const vault = new WorkspaceRefVault();
    const ref = vault.mint(record());

    expect(vault.resolve("scope-1", "alice", ref, "file").ok).toBe(true);
    expect(vault.resolve("scope-2", "alice", ref, "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-1", "mallory", ref, "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-1", "alice", ref, "directory")).toEqual({ ok: false, code: "wrong_kind" });
    expect(vault.resolve("scope-1", "alice", "wf_forged", "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-1", "alice", "", "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-1", "alice", 7, "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-1", "alice", "x".repeat(500), "file")).toEqual({ ok: false, code: "unknown_ref" });
  });

  it("closeScope forgets one scope's refs and leaves the others standing", () => {
    const vault = new WorkspaceRefVault();
    const mine = vault.mint(record());
    const theirs = vault.mint(record({ scope: "scope-2" }));

    expect(vault.closeScope("scope-1")).toBe(1);
    expect(vault.resolve("scope-1", "alice", mine, "file")).toEqual({ ok: false, code: "unknown_ref" });
    expect(vault.resolve("scope-2", "alice", theirs, "file").ok).toBe(true);
    expect(vault.size()).toBe(1);
    expect(vault.closeScope("scope-1")).toBe(0);

    // A closed scope that re-opens gets NEW refs; the old strings stay dead.
    const reopened = vault.mint(record());
    expect(reopened).not.toBe(mine);
    expect(vault.resolve("scope-1", "alice", mine, "file")).toEqual({ ok: false, code: "unknown_ref" });
  });

  it("bounds refs per scope and globally without charging stable identities twice", () => {
    const perScope = new WorkspaceRefVault({ maxPerScope: 2, maxGlobal: 10 });
    const first = perScope.mint(record());
    expect(perScope.mint(record({ label: "new display label" }))).toBe(first);
    perScope.mint(record({ relativePath: "src/b.ts" }));
    expect(() => perScope.mint(record({ relativePath: "src/c.ts" }))).toThrow(WorkspaceRefLimitError);

    const global = new WorkspaceRefVault({ maxPerScope: 10, maxGlobal: 2 });
    global.mint(record());
    global.mint(record({ scope: "scope-2" }));
    expect(() => global.mint(record({ scope: "scope-3" }))).toThrow(WorkspaceRefLimitError);
    global.closeScope("scope-1");
    expect(() => global.mint(record({ scope: "scope-3" }))).not.toThrow();
  });

  it("gives each owner a fair share of the global pool and returns it on scope close", () => {
    const vault = new WorkspaceRefVault({ maxPerScope: 10, maxPerOwner: 2, maxGlobal: 4 });
    vault.mint(record());
    vault.mint(record({ scope: "scope-2", relativePath: "src/b.ts" }));
    expect(() => vault.mint(record({ scope: "scope-3", relativePath: "src/c.ts" })))
      .toThrow(WorkspaceRefLimitError);

    // Alice reaching her share does not consume Bob's admission.
    expect(() => vault.mint(record({ scope: "bob-1", owner: "bob", relativePath: "src/c.ts" })))
      .not.toThrow();
    vault.closeScope("scope-1");
    expect(() => vault.mint(record({ scope: "scope-3", relativePath: "src/c.ts" })))
      .not.toThrow();
  });

  it("preflights a projection so a refused batch mints no hidden refs", () => {
    const vault = new WorkspaceRefVault({ maxPerScope: 2 });
    vault.mint(record());
    expect(() => vault.mintMany([
      record({ relativePath: "src/b.ts" }),
      record({ relativePath: "src/c.ts" }),
    ])).toThrow(WorkspaceRefLimitError);
    expect(vault.size("scope-1")).toBe(1);
  });
});
