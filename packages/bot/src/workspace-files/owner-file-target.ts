import { decodeResourceId } from "../sessionhub/core.js";
import type { OwnerFileSessionTarget } from "./types.js";

/** Routing comes from an owner-bound session and its durable execution placement. */
export function ownerFileSessionTarget(owner: string, ref: string,
  placement: (owner: string, device: string, source: string, id: string) => { device: string; workspaceId: string } | null,
): OwnerFileSessionTarget | null {
  const session = decodeResourceId(ref);
  if (!session || session.owner !== owner || !session.device || session.device === "bot-host") return null;
  const split = placement(owner, session.device, session.cliKind, session.sessionId);
  return { device: split?.device ?? session.device, source: session.cliKind, id: session.sessionId,
    ...(split ? { workspaceId: split.workspaceId } : {}) };
}
