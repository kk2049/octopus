import { describe, expect, it } from "vitest";
import EXPENSE_PACK from "./pack.js";

describe("expense intake pack profile", () => {
  it("ships a bespoke root without fictitious module metadata", () => {
    expect("manifests" in EXPENSE_PACK).toBe(false);
    expect("moduleAssets" in EXPENSE_PACK).toBe(false);
  });
});
