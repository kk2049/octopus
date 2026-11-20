import type { ListedFileLocation } from "@claude-bot/agent-file-preview";

interface AnnotationRootSource {
  readonly label: string;
  readonly sourceLabel: string;
}

interface AddressableAnnotationRoot extends AnnotationRootSource {
  readonly ref: string;
}

/**
 * Stable identity for App-owned annotations at one listed root.
 *
 * The already-visible device/root labels survive both a fresh browser resource
 * scope and a bot restart. `visibleRows` only uses this value when the complete
 * projected root list proves it unique. If an unusually long or malformed pair
 * cannot fit in intent context, omit annotations instead of coercing two roots
 * into one identity.
 */
export function annotationRootKey(root: AnnotationRootSource): string {
  const source = encodePart(root.sourceLabel);
  const label = encodePart(root.label);
  if (source === null || label === null) return "";
  const display = `display:${source}:${label}`;
  return display.length <= 512 ? display : "";
}

/**
 * Stable annotation identities for roots whose visible coordinate is unique
 * in this complete bounded root list. Chat links and file-tree rows must use
 * the same evidence: a duplicate display coordinate disables both instead of
 * attaching one file's note to another root that merely looks the same.
 */
export function annotationRootsByRef(roots: readonly AddressableAnnotationRoot[]): ReadonlyMap<string, string> {
  const keyed = roots.map((root) => ({ root, key: annotationRootKey(root) }));
  const counts = new Map<string, number>();
  for (const { key } of keyed) {
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = new Map<string, string>();
  for (const { root, key } of keyed) {
    if (key && counts.get(key) === 1) unique.set(root.ref, key);
  }
  return unique;
}

/** A durable file key must never contain the per-instance `rootRef`. */
export function annotationFileKey(location: ListedFileLocation): string {
  if (!location.annotationRoot) return "";
  const labels = location.labels.map(encodePart);
  if (labels.some((label) => label === null)) return "";
  return `${location.annotationRoot}::${labels.join("/")}`;
}

function encodePart(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}
