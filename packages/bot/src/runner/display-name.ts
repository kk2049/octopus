/** Presentation only. This key must never resolve a device selector or grant. */
export const runnerDisplayNameKey = (device: string): string => `runner_display_name:${device}`;
export const RUNNER_DISPLAY_NAME_MAX = 64;
export function normalizeRunnerDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/gu, " ").trim();
  return name && Array.from(name).length <= RUNNER_DISPLAY_NAME_MAX && !/[\u0000-\u001f\u007f]/u.test(name) ? name : undefined;
}
export function runnerDisplayName(store: { getSetting(owner: string, key: string): string | undefined }, owner: string, device: string): string | undefined {
  return normalizeRunnerDisplayName(store.getSetting(owner, runnerDisplayNameKey(device)));
}
