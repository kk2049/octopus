import type { RetrievalPlanAudit } from "./retrieval-trace.js";
import { isDocumentationOrTest } from "./specifications.js";

export function explicitQueryPaths(plan: RetrievalPlanAudit): string[] {
  return plan.classifications.filter((item) => item.dimension === "path" && item.certainty === "exact" && item.reason_codes.includes("explicit_path"))
    .map((item) => item.value.replace(/\/$/u, ""))
    .filter((file) => file.length > 0 && !file.startsWith("/") && !file.split("/").some((part) => !part || part === "." || part === ".."));
}

export function uncoveredCodePaths(changed: readonly string[], queried: readonly string[]): string[] {
  return changed.filter((file) => !isDocumentationOrTest(file) && !queried.some((query) => file === query || file.startsWith(`${query}/`)));
}
