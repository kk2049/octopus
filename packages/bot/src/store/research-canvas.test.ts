import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v78 and retains project history in causal insertion order across equal timestamps and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "research-store-")),
    file = join(root, "state.db");
  let store: Store | undefined;
  try {
    const old = new Database(file);
    migrateFixtureTo(old, 78);
    old
      .prepare(
        "INSERT INTO users(username,uid,home_dir,created_at) VALUES(?,?,?,?)",
      )
      .run("alice", 2001, root, "2026-09-17T00:00:00Z");
    old.close();
    store = new Store(file);
    expect(store.getUser("alice")?.uid).toBe(2001);
    for (const [index, id] of ["z", "a", "m"].entries())
      store.researchCanvas.put(
        "project",
        "messages",
        id,
        {
          id,
          run: index === 2 ? "future" : "first",
          conversation: "manual",
          role: "user",
          text: id,
          at: "same",
        },
        0,
        false,
      );
    expect(
      store.researchCanvas
        .messages("project", ["manual"], "", 2)
        .map((row) => row.id),
    ).toEqual(["a", "m"]);
    expect(
      store.researchCanvas
        .messages("project", ["manual"], "a", 2)
        .map((row) => row.id),
    ).toEqual(["z"]);
    expect(
      store.researchCanvas
        .messages("project", ["manual"], "", 1, ["first"])
        .map((row) => row.id),
    ).toEqual(["a"]);
    expect(store.researchCanvas.messages("foreign", ["manual"])).toEqual([]);
    store.close();
    store = new Store(file);
    expect(
      store.researchCanvas.messages("project", ["manual"]).map((row) => row.id),
    ).toEqual(["z", "a", "m"]);
    expect(() =>
      store!.researchCanvas.put("project", "messages", "a", { id: "a" }, 0),
    ).toThrow("版本");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses each project's live goal title without exposing IDs or another project's name", () => {
  const store = new Store(":memory:");
  try {
    store.researchCanvas.put("first", "nodes", "old", { id: "old", type: "goal", title: "旧名", archived: true });
    store.researchCanvas.put("first", "nodes", "goal", { id: "goal", type: "goal", title: "ACC · GOAL", archived: false });
    store.researchCanvas.put("second", "nodes", "goal", { id: "goal", type: "goal", title: "ArchTown · GOAL", archived: false });
    expect(store.researchCanvas.projectTitle("first")).toBe("ACC");
    expect(store.researchCanvas.projectTitle("second")).toBe("ArchTown");
    expect(store.researchCanvas.projectTitle("unknown")).toBe("未命名科研项目");
  } finally { store.close(); }
});
