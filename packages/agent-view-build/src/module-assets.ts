import { APP_MODULE_SCHEMA, APP_RUNTIME_ABI, type AppModuleEntry } from "./runtime.js";
export const MODULE_ENTRY_ASSET = "view/entry.json";
export const MODULE_ENTRY_FILE = "agent-view.entry.json";
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:js|mjs|css|json|svg)$/;
export function moduleAssetName(name: string): string {
  if (name === MODULE_ENTRY_FILE) return MODULE_ENTRY_ASSET;
  if (name === "agent-view.js") return "view.js";
  if (name === "agent-view.css") return "view.css";
  if (!FILE.test(name)) throw new Error("invalid App module asset name");
  return `view/assets/${name}`;
}
export function isModuleAuxAsset(name: string): boolean {
  return name === MODULE_ENTRY_ASSET || name.startsWith("view/assets/") && FILE.test(name.slice(12));
}
export function readAppModuleEntry(text: string): AppModuleEntry | null {
  try {
    const value = JSON.parse(text) as AppModuleEntry;
    if (value.schema !== APP_MODULE_SCHEMA || value.runtime !== APP_RUNTIME_ABI
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.appId)
      || typeof value.scope !== "string" || !value.scope.startsWith(value.appId + "--") || !/^[a-z][a-z0-9-]{0,63}--[0-9a-f]{16}$/.test(value.scope)
      || value.entry !== "agent-view.js" || !Array.isArray(value.styles)
      || !Array.isArray(value.assets) || value.assets.length > 128
      || !value.assets.every((name) => typeof name === "string" && FILE.test(name))
      || new Set(value.assets).size !== value.assets.length
      || !value.assets.includes(value.entry)
      || !value.styles.every((name) => typeof name === "string" && name.endsWith(".css") && value.assets.includes(name))) return null;
    return value;
  } catch { return null; }
}
