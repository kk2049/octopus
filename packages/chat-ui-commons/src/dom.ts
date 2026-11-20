/** Keep legacy ids on the first mounted instance and namespace every sibling. */
export function scopedDomId(base: string, scope?: string): string {
  if (!scope) return base;
  const safe = scope.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "instance";
  return `${base}--${safe}`;
}
