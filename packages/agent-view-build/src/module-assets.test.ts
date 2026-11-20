import { expect, it } from "vitest";
import { isModuleAuxAsset, moduleAssetName, readAppModuleEntry } from "./module-assets.js";
const entry = { schema: "octopus-app-module/v1", runtime: "octopus-ui/v1", appId: "session-plus", scope: "session-plus--0123456789abcdef", entry: "agent-view.js", styles: ["agent-view.css"], assets: ["agent-view.js", "agent-view.css", "pdf.worker-123.js"] };
it("requires an explicit compatible module with declared local assets", () => {
  expect(readAppModuleEntry(JSON.stringify(entry))).toEqual(entry);
  for (const patch of [{ runtime: "future" }, { assets: [...entry.assets, "../private.js"] }, { styles: ["https://example.com/a.css"] }, { assets: ["agent-view.css"] }]) {
    expect(readAppModuleEntry(JSON.stringify({ ...entry, ...patch }))).toBeNull();
  }
  expect(moduleAssetName("pdf.worker-123.js")).toBe("view/assets/pdf.worker-123.js");
  expect(isModuleAuxAsset("view/assets/../actions.js")).toBe(false);
  expect(() => moduleAssetName("../../app/actions.ts")).toThrow();
});
