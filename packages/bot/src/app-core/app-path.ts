import { fileURLToPath } from "node:url";

/** Resolve an immutable first-party App release without depending on its composition root. */
export function bundledAppDir(sourceRoot: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(sourceRoot)) {
    throw new Error(`Invalid bundled App source root: ${sourceRoot.slice(0, 64)}`);
  }
  return fileURLToPath(new URL(`../${sourceRoot}/app/`, import.meta.url));
}
