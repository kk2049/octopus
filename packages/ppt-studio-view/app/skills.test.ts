import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_NAMES, skillByName } from "./skills.js";

describe("PPT Studio atomic skills", () => {
  it("keeps the default baseline small and loads every named module independently", () => {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "app.yaml");
    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).toContain("不要一次加载全部技能");
    expect(manifest).toContain("deck-model/v1 是唯一事实源");
    for (const name of SKILL_NAMES) {
      expect(skillByName(name), name).toBeTypeOf("string");
      expect(skillByName(name)!.length).toBeGreaterThan(80);
    }
    expect(skillByName("everything")).toBeNull();
  });
});
