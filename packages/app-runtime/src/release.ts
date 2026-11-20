import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export const APP_ACTIONS_FILE = "actions.ts";
export const APP_PROJECTION_FILE = "projection.ts";

export interface BackendRelease {
  appDir: string;
  actionsFile: string;
  projectionFile: string;
  backendCodeDigest: string;
}

/** Digest exactly the two executable release assets with framed names/lengths. */
export function backendRelease(appDir: string): BackendRelease {
  const root = path.resolve(appDir);
  const assets = [APP_ACTIONS_FILE, APP_PROJECTION_FILE];
  const hash = createHash("sha256");
  for (const name of assets) {
    const file = path.join(root, name);
    if (!statSync(file).isFile()) throw new Error(`app runtime asset is not a file: ${name}`);
    const body = readFileSync(file);
    hash.update(`${name}\0${body.byteLength}\0`);
    hash.update(body);
  }
  return {
    appDir: root,
    actionsFile: path.join(root, APP_ACTIONS_FILE),
    projectionFile: path.join(root, APP_PROJECTION_FILE),
    backendCodeDigest: hash.digest("hex"),
  };
}
