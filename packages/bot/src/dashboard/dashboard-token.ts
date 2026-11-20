/**
 * The personal web-login key (`dt_…`).
 *
 * Plaintext is returned exactly once to whoever minted it; the store keeps only
 * the sha256, and `saveDashboardToken` replaces the previous row so an account
 * has one key at a time — minting IS rotation. Rotation also ends every browser
 * session of that account (except, optionally, the one doing the rotating):
 * a session row names only the account, so a key rotation that left them alive
 * would not stop a leaked key's logins. Lives in its own module so the `/admin`
 * route can mint without importing a value from `server.ts`, the file that
 * composes it.
 */

import { randomUUID } from "node:crypto";
import { hashRunnerToken } from "../runner/gateway.js";
import type { DashboardStorePort } from "./ports.js";

export interface RotatedDashboardToken {
  /** The new plaintext key. Shown once, never stored. */
  token: string;
  /** Token hashes of the browser sessions the rotation ended. */
  endedSessions: string[];
}

export function rotateDashboardToken(
  store: Pick<DashboardStorePort, "saveDashboardToken">,
  username: string,
  keepSessionHash?: string,
): RotatedDashboardToken {
  const token = "dt_" + randomUUID().replace(/-/g, "");
  const endedSessions = store.saveDashboardToken(hashRunnerToken(token), username, new Date().toISOString(), keepSessionHash);
  return { token, endedSessions };
}

export function mintDashboardToken(store: Pick<DashboardStorePort, "saveDashboardToken">, username: string): string {
  return rotateDashboardToken(store, username).token;
}
