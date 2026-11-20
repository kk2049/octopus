import { describe, expect, it } from "vitest";
import { retrySqliteBusy } from "./sqlite-busy.js";

function sqliteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("retrySqliteBusy", () => {
  it("retries transient SQLite busy errors within the caller's budget", () => {
    let attempts = 0;
    expect(retrySqliteBusy(() => {
      attempts += 1;
      if (attempts < 3) throw sqliteError("SQLITE_BUSY");
      return "ready";
    }, 100)).toBe("ready");
    expect(attempts).toBe(3);
  });

  it("does not hide non-busy SQLite failures", () => {
    let attempts = 0;
    expect(() => retrySqliteBusy(() => {
      attempts += 1;
      throw sqliteError("SQLITE_CORRUPT");
    }, 100)).toThrow(/SQLITE_CORRUPT/);
    expect(attempts).toBe(1);
  });
});
