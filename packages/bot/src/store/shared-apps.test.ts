/** v37 shared-instance tables: creation is atomic, seats are capacity-checked. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./store.js";

const NOW = "2026-08-11T00:00:00.000Z";

describe("shared app instance tables", () => {
  let dir: string;
  let store: Store;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shared-apps-"));
    store = new Store(join(dir, "t.db"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an instance WITH its creator's membership — no memberless rooms", () => {
    store.createSharedAppInstance(
      { app_id: "chess", instance_key: "asi_1", creator: "alice", created_at: NOW, status: "open" },
      "white",
    );
    expect(store.getSharedAppInstance("chess", "asi_1")).toMatchObject({ creator: "alice", status: "open" });
    expect(store.getSharedAppMember("chess", "asi_1", "alice")).toMatchObject({ role: "white" });
    expect(store.listSharedAppInstancesFor("chess", "alice")).toHaveLength(1);
    expect(store.listSharedAppInstancesFor("chess", "bob")).toHaveLength(0);
  });

  it("capacity-checks a role seat inside the transaction", () => {
    // black has max 1: the first join wins the seat, the second is refused.
    expect(store.addSharedAppMember("chess", "asi_1", "bob", "black", 1, NOW)).toBe(true);
    expect(store.addSharedAppMember("chess", "asi_1", "carol", "black", 1, NOW)).toBe(false);
    // A different role with room still admits.
    expect(store.addSharedAppMember("chess", "asi_1", "carol", "watcher", 8, NOW)).toBe(true);
    // Double-join is refused, an unknown instance is refused.
    expect(store.addSharedAppMember("chess", "asi_1", "bob", "watcher", 8, NOW)).toBe(false);
    expect(store.addSharedAppMember("chess", "asi_nope", "dave", "watcher", 8, NOW)).toBe(false);
  });

  it("supports generic creator-managed seats and a one-way close", () => {
    store.createSharedAppInstance(
      { app_id: "reports", instance_key: "asi_managed", creator: "alice", created_at: NOW, status: "open" },
      "member",
    );
    expect(store.setSharedAppMember("reports", "asi_managed", "bob", "member", 2, NOW)).toBe(true);
    expect(store.setSharedAppMember("reports", "asi_managed", "carol", "member", 2, NOW)).toBe(false);
    expect(store.setSharedAppMember("reports", "asi_managed", "bob", "observer", 8, NOW)).toBe(true);
    expect(store.getSharedAppMember("reports", "asi_managed", "bob")?.role).toBe("observer");
    expect(store.removeSharedAppMember("reports", "asi_managed", "bob")).toBe(true);
    expect(store.closeSharedAppInstance("reports", "asi_managed")).toBe(true);
    expect(store.closeSharedAppInstance("reports", "asi_managed")).toBe(false);
    expect(store.setSharedAppMember("reports", "asi_managed", "bob", "observer", 8, NOW)).toBe(false);
  });
});
