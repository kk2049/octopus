/**
 * @endo/evasive-transform ships without resolvable TypeScript declarations
 * under Node16 resolution. The two entry points we use, typed by hand against
 * its documented API; if upstream adds types, delete this file.
 */
declare module "@endo/evasive-transform" {
  export interface EvadeCensorResult {
    code: string;
    map?: unknown;
  }
  export function evadeCensorSync(
    source: string,
    options?: { sourceMap?: string; sourceUrl?: string; elideComments?: boolean; sourceType?: "module" | "script" },
  ): EvadeCensorResult;
  export function evadeCensor(
    source: string,
    options?: { sourceMap?: string; sourceUrl?: string; elideComments?: boolean; sourceType?: "module" | "script" },
  ): Promise<EvadeCensorResult>;
}
