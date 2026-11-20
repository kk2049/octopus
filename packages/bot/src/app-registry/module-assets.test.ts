import { expect, it } from "vitest";
import { moduleAssetProblem, releaseShapeOf, LEGACY_ASSETS } from "./release-assets.js";
const entry = { schema: "octopus-app-module/v1", runtime: "octopus-ui/v1", appId: "chess", scope: "chess--0123456789abcdef", entry: "agent-view.js", styles: ["agent-view.css"], assets: ["agent-view.js", "agent-view.css", "worker-pdf-123.js"] };
const bytes = () => new Map<string, Uint8Array>([["view/entry.json", Buffer.from(JSON.stringify(entry))], ["view.js", Buffer.from("export default function App(){}")], ["view.css", Buffer.from(".app {}")], ["view/assets/worker-pdf-123.js", Buffer.from("self.onmessage=()=>{}")]]);
it("accepts explicit module assets without changing legacy backend shapes", () => {
  expect(releaseShapeOf([...LEGACY_ASSETS, "view/entry.json", "view/assets/worker-pdf-123.js"])).toEqual({ ok: true, shape: "legacy" });
  expect(moduleAssetProblem(bytes(), "chess")).toBeNull();
  expect(moduleAssetProblem(bytes(), "session-plus")).toContain("incompatible");
});
it("refuses missing and undeclared lazy assets before activation", () => {
  const missing = bytes(); missing.delete("view/assets/worker-pdf-123.js");
  expect(moduleAssetProblem(missing, "chess")).toContain("missing");
  const excess = bytes(); excess.set("view/assets/extra.js", Buffer.from(""));
  expect(moduleAssetProblem(excess, "chess")).toContain("not declared");
  expect(releaseShapeOf([...LEGACY_ASSETS, "view/assets/extra.js"]).ok).toBe(false);
});
