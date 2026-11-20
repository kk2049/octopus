import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleHandoff, looksLikeBundleToken } from "./bundle-handoff.js";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-handoff-"));
  dirs.push(dir);
  const file = join(dir, "sync.bundle");
  writeFileSync(file, "bytes");
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("BundleHandoff", () => {
  it("hands a file out exactly once and deletes it when the taker is done", async () => {
    const handoff = new BundleHandoff();
    const file = tmpFile();
    const token = handoff.offer(file);
    expect(looksLikeBundleToken(token)).toBe(true);
    const first = handoff.take(token);
    expect(first?.path).toBe(file);
    // Single use: the second caller gets nothing, whatever the first did.
    expect(handoff.take(token)).toBeNull();
    await first!.done();
    expect(existsSync(file)).toBe(false);
  });

  it("expires offers by its own clock and cleans the file up", async () => {
    let now = 1_000;
    const handoff = new BundleHandoff({ now: () => now });
    const file = tmpFile();
    const token = handoff.offer(file, { ttlMs: 100 });
    now += 101;
    expect(handoff.take(token)).toBeNull();
    expect(handoff.size).toBe(0);
    // Removal is fire-and-forget; under full-suite load it can take longer
    // than one tick, so poll rather than guess a latency.
    for (let i = 0; i < 200 && existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(file)).toBe(false);
  });

  it("refuses shapes that are not tokens before any lookup", () => {
    expect(looksLikeBundleToken("")).toBe(false);
    expect(looksLikeBundleToken("../../etc/passwd")).toBe(false);
    expect(looksLikeBundleToken("bt_short")).toBe(false);
  });

  it("revoke forgets an offer the sync gave up on", () => {
    const handoff = new BundleHandoff();
    const token = handoff.offer(tmpFile());
    handoff.revoke(token);
    expect(handoff.take(token)).toBeNull();
  });
});
