/** Stable locations use existing project/instance and graph IDs, never a second identity. */
export interface ResearchLocation { scope: string; node: string }
const validId = (value: string) => value.length <= 160 && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);
export function readResearchLocation(value: string | URL): ResearchLocation {
  const url = value instanceof URL ? value : new URL(value, "https://research.invalid");
  const scope = url.searchParams.get("researchScope") ?? "", node = url.searchParams.get("researchNode") ?? "";
  return { scope: validId(scope) ? scope : "", node: validId(node) ? node : "" };
}
export function researchLocationUrl(base: string | URL, project: string, location: ResearchLocation): string {
  const url = new URL(String(base));
  // Keep the host's instance binding and any preview/dev routing parameters.
  url.searchParams.set("project", project);
  url.searchParams.set("researchScope", location.scope);
  if (location.node) url.searchParams.set("researchNode", location.node); else url.searchParams.delete("researchNode");
  url.searchParams.delete("researchLayout");
  return url.toString();
}
/** Accept a whole copied URL only. Ordinary prose and foreign projects are never graph writes. */
export function parseResearchReference(text: string, base: string | URL, project: string): ResearchLocation | null {
  if (text.trim().length > 4096 || !/^https?:\/\//.test(text.trim())) return null;
  try {
    const current = new URL(String(base)), url = new URL(text.trim());
    if (url.origin !== current.origin || url.pathname !== "/apps/research-v2/open" && url.pathname !== current.pathname) return null;
    if (url.searchParams.get("project") !== project) return null;
    if (current.searchParams.get("instance") && url.searchParams.get("instance") !== current.searchParams.get("instance")) return null;
    const location = readResearchLocation(url);
    return location.node ? location : null;
  } catch { return null; }
}
