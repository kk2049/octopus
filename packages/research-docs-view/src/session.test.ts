import { afterEach, describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import type { Call } from "@claude-bot/research-docs-contract";
import { DocumentSession, decode, encode } from "./session.js";
const sessions: DocumentSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.destroy());
  localStorage.clear();
  vi.useRealTimers();
});
function harness() {
  const trusted = new Y.Doc();
  trusted.getText("text").insert(0, "hello");
  const calls: string[] = [];
  let denied = false;
  const call: Call = async (action, p = {}) => {
    calls.push(action);
    if (denied) throw new Error("权限已撤销");
    if (action === "update") Y.applyUpdate(trusted, decode(String(p.update)));
    return {
      page: {},
      update: encode(
        Y.encodeStateAsUpdate(
          trusted,
          p.vector ? decode(String(p.vector)) : undefined,
        ),
      ),
      vector: encode(Y.encodeStateVector(trusted)),
    } as never;
  };
  const client = (key: string) => {
    const s = new DocumentSession("doc", call, key);
    sessions.push(s);
    return s;
  };
  return {
    trusted,
    calls,
    client,
    deny: () => {
      denied = true;
    },
    allow: () => {
      denied = false;
    },
  };
}
describe("document synchronization", () => {
  it("merges concurrent edits from independent clients without replacing either intent", async () => {
    const h = harness(),
      a = h.client("a"),
      b = h.client("b");
    await a.open();
    await b.open();
    a.doc.getText("text").insert(0, "A");
    b.doc.getText("text").insert(0, "B");
    await Promise.all([a.sync(), b.sync()]);
    await a.sync();
    await b.sync();
    expect(a.doc.getText("text").toString()).toBe(
      b.doc.getText("text").toString(),
    );
    expect(a.doc.getText("text").toString()).toMatch(/ABhello|BAhello/);
  });
  it("retains refused edits through reload and does not turn wake events into retries", async () => {
    const h = harness(),
      a = h.client("private");
    await a.open();
    a.doc.getText("text").insert(5, " draft");
    h.deny();
    await a.sync();
    expect(a.snapshot().error).toContain("撤销");
    const count = h.calls.length;
    for (let i = 0; i < 10; i++) a.wake();
    expect(h.calls).toHaveLength(count);
    a.destroy();
    const restored = h.client("private");
    h.allow();
    await restored.open();
    expect(h.trusted.getText("text").toString()).toBe("hello draft");
    expect(restored.snapshot().pending).toBe(false);
  });
  it("keeps typing responsive while one update is awaiting acknowledgement", async () => {
    const h = harness(),
      a = h.client("a");
    await a.open();
    a.doc.getText("text").insert(0, "first");
    const send = a.sync();
    a.doc.getText("text").insert(0, "later");
    await send;
    await a.sync();
    expect(h.trusted.getText("text").toString()).toBe("laterfirsthello");
  });
  it("opens and saves a page larger than one answer in bounded windows", async () => {
    // A fake trusted side that answers and accepts windows the way the plane does.
    const trusted = new Y.Doc(), window = 196_608, sizes: number[] = [];
    trusted.getText("text").insert(0, "长".repeat(1_500_000));
    let snapshot: Uint8Array | undefined, staged: Uint8Array[] = [];
    const answer = (bytes: Uint8Array, offset: number) => ({ page: {}, vector: encode(Y.encodeStateVector(trusted)), update: encode(bytes.subarray(offset, offset + window)),
      offset, total: bytes.length, next: offset + window < bytes.length ? offset + window : null, snapshot: "s1" });
    const call: Call = async (action, p = {}) => {
      if (action === "read") {
        if (p.snapshot) return answer(snapshot!, Number(p.offset)) as never;
        snapshot = Y.encodeStateAsUpdate(trusted, p.vector ? decode(String(p.vector)) : undefined);
        return answer(snapshot, 0) as never;
      }
      const part = decode(String(p.update)); sizes.push(part.length);
      if (Number(p.offset) === 0) staged = [];
      staged.push(part);
      if (Number(p.offset) + part.length < Number(p.total)) return { staged: Number(p.offset) + part.length } as never;
      const whole = new Uint8Array(Number(p.total)); let at = 0;
      for (const item of staged) { whole.set(item, at); at += item.length; }
      Y.applyUpdate(trusted, whole);
      snapshot = Y.encodeStateAsUpdate(trusted, decode(String(p.vector)));
      return answer(snapshot, 0) as never;
    };
    const a = new DocumentSession("big", call, "big", undefined); sessions.push(a);
    await a.open();
    expect(a.snapshot().ready).toBe(true);
    expect(a.doc.getText("text").length).toBe(1_500_000);
    a.doc.getText("text").insert(0, "新".repeat(1_000_000));
    await a.sync();
    expect(a.snapshot()).toMatchObject({ pending: false, error: "" });
    expect(trusted.getText("text").length).toBe(2_500_000);
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(window);
  }, 60_000);
  it("never mounts a cached private draft after the open read is refused", async () => {
    const h = harness(),
      a = h.client("a");
    await a.open();
    a.doc.getText("text").insert(0, "private");
    a.checkpoint();
    a.destroy();
    h.deny();
    const b = h.client("a");
    await b.open();
    expect(b.snapshot().ready).toBe(false);
    expect(b.snapshot().error).toContain("撤销");
  });
});
