/**
 * Resolve the account-level capability bits shared by trusted entry points.
 *
 * This is resolution, not route policy or a capability Gate. Keeping the
 * dependency-free projection in the permission domain lets Dashboard and the
 * deployment service agree without either transport depending on the other.
 *
 * `deploy` implies `dev`, and admin implies both, one-directionally: revoking
 * `dev` does not revoke `deploy`.
 *
 * `contribute` (2026-08-20) is the narrow tier below `dev`: it opens the
 * ticket workspace for the holder's OWN tickets and routes their landings
 * through the review lane instead of a fast-forward. `dev` implies it, again
 * one-directionally, so a full member never has to hold both rows.
 */
export interface CapabilityBits {
  admin: boolean;
  dev: boolean;
  deploy: boolean;
  contribute: boolean;
}

export function resolveCapabilityBits(o: {
  username: string;
  admins?: readonly string[];
  granted?: readonly string[];
  deployers?: readonly string[];
}): CapabilityBits {
  const admin = (o.admins ?? []).includes(o.username);
  const granted = new Set(o.granted ?? []);
  const deploy = admin || granted.has("deploy") || (o.deployers ?? []).includes(o.username);
  const dev = deploy || granted.has("dev");
  return { admin, dev, deploy, contribute: dev || granted.has("contribute") };
}
