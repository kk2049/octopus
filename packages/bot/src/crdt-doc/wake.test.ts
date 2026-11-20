/**
 * The trusted half of ADR 0006, as behaviour: a merge becomes at most one
 * content-free wake per (scope, document) per debounce window, the author is
 * not woken about their own edit, and everything past the per-instance budget
 * is dropped rather than queued.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import { CrdtDocumentStore } from "./store.js";
import { CrdtWakeHub } from "./wake.js";
import type { CrdtDocumentDescriptor } from "./types.js";

function context(overrides: Partial<ResourceProviderContext> = {}): ResourceProviderContext {
  return {
    owner: "alice",
    publisher: "octopus:first-party",
    app: "session-plus",
    packageDigest: "a".repeat(64),
    permissionContractDigest: "b".repeat(32),
    instance: "spi_1:resource:1",
    binding: "docs",
    contract: "crdt-doc/v1",
    scope: "scope-a",
    ...overrides,
  };
}

const REFS: ReadonlyMap<string, CrdtDocumentDescriptor> = new Map([
  ["cd_ref_a", { id: "notes", label: "Notes" }],
]);

/** Timers the test drives by hand. */
function manualTimers() {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (fn: () => void): unknown => {
      next += 1;
      queue.set(next, fn);
      return next;
    },
    clearTimer: (handle: unknown): void => {
      queue.delete(handle as number);
    },
    fire(): void {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    get scheduled() {
      return queue.size;
    },
  };
}

function hub(options: { maxPerWindow?: number; now?: () => number } = {}) {
  const delivered: { instanceKey: string; binding: string; ref: string }[] = [];
  const timers = manualTimers();
  const made = new CrdtWakeHub({
    deliver: (instanceKey, binding, ref) => delivered.push({ instanceKey, binding, ref }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    debounceMs: 1000,
    ...(options.maxPerWindow !== undefined ? { maxPerWindow: options.maxPerWindow } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { made, delivered, timers };
}

describe("fan-out", () => {
  it("coalesces a burst of merges into ONE wake on the trailing edge", () => {
    const { made, delivered, timers } = hub();
    made.scopeOpened(context(), REFS);
    for (let n = 0; n < 25; n += 1) made.changed("notes");
    expect(delivered).toHaveLength(0); // nothing before the debounce fires
    expect(timers.scheduled).toBe(1);
    timers.fire();
    expect(delivered).toEqual([{ instanceKey: "spi_1:resource:1", binding: "docs", ref: "cd_ref_a" }]);
  });

  it("does not wake the scope that made the change", () => {
    const { made, delivered, timers } = hub();
    made.scopeOpened(context({ scope: "scope-a" }), REFS);
    made.scopeOpened(context({ scope: "scope-b", instance: "spi_2:resource:1" }), REFS);
    made.changed("notes", "scope-a");
    timers.fire();
    // Only the OTHER holder learns; the author already has the ack.
    expect(delivered).toEqual([{ instanceKey: "spi_2:resource:1", binding: "docs", ref: "cd_ref_a" }]);
  });

  it("wakes only scopes that hold a ref for the changed document", () => {
    const { made, delivered, timers } = hub();
    made.scopeOpened(context(), REFS);
    made.changed("some-other-doc");
    timers.fire();
    expect(delivered).toEqual([]);
  });

  it("stops waking a scope the moment it closes, even mid-debounce", () => {
    const { made, delivered, timers } = hub();
    made.scopeOpened(context(), REFS);
    made.changed("notes");
    made.scopeClosed(context());
    timers.fire();
    expect(delivered).toEqual([]);
  });

  it("drops wakes past the per-instance window budget instead of queueing them", () => {
    let at = 0;
    const { made, delivered, timers } = hub({ maxPerWindow: 3, now: () => at });
    made.scopeOpened(context(), REFS);
    for (let n = 0; n < 10; n += 1) {
      made.changed("notes");
      timers.fire();
      at += 10; // inside one rolling window
    }
    // Dropped, deliberately: a wake carries nothing, so the next one after the
    // window means exactly what the dropped ones meant.
    expect(delivered).toHaveLength(3);
  });
});

describe("the store's change seam", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "crdt-wake-"));
    dirs.push(dir);
    return dir;
  }

  it("fires once per successful merge, with the writer's origin, and not for compaction", () => {
    const changes: { doc: string; origin: unknown }[] = [];
    const store = new CrdtDocumentStore({
      root: tempDir(),
      onChanged: (doc, origin) => changes.push({ doc, origin }),
    });
    const draft = new Y.Doc();
    draft.getText("body").insert(0, "hello");
    expect(store.applyUpdate("notes", Y.encodeStateAsUpdate(draft), "scope-a").ok).toBe(true);
    expect(changes).toEqual([{ doc: "notes", origin: "scope-a" }]);

    store.compact("notes");
    expect(changes).toHaveLength(1); // compaction changes no content

    // A refused merge notifies nobody: nothing changed.
    expect(store.applyUpdate("notes", new Uint8Array([1, 2, 3]), "scope-a").ok).toBe(false);
    expect(changes).toHaveLength(1);
    store.close();
    draft.destroy();
  });

  it("keeps the merge even when a listener throws", () => {
    const store = new CrdtDocumentStore({
      root: tempDir(),
      onChanged: () => {
        throw new Error("broken listener");
      },
    });
    const draft = new Y.Doc();
    draft.getText("body").insert(0, "survives");
    const merged = store.applyUpdate("notes", Y.encodeStateAsUpdate(draft));
    expect(merged.ok).toBe(true);
    const read = store.read("notes");
    expect(read.ok).toBe(true);
    store.close();
    draft.destroy();
  });
});
