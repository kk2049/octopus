/**
 * Test helper: narrow an owner's Session Hub grant so that appending to their
 * own sessions from a script or MCP token queues an approval card again.
 *
 * Since O1 the bootstrap grant makes the owner's own append/resume silent from
 * every credential. Suites that exercise the approval lifecycle (cards,
 * dedupe, approve-once, reject, revocation) narrow that one term first — which
 * is exactly the deployment state in which such a card can still arise.
 */
import type { RunnerCapabilities } from "../runner/capability.js";
import type { Store } from "../store/store.js";
import { SESSION_HUB_OPERATION_IDS, SESSION_HUB_SUBJECT } from "./catalog.js";
import { PermissionService } from "./service.js";

export function narrowOwnSessionAppend(store: Store, caps: RunnerCapabilities | undefined, owner: string): void {
  new PermissionService({ store, ...(caps ? { caps } : {}) }).grant({
    subjectType: "service",
    subjectId: SESSION_HUB_SUBJECT.id,
    owner,
    operations: SESSION_HUB_OPERATION_IDS,
    autoAllow: SESSION_HUB_OPERATION_IDS.filter((op) => op !== "append_session" && op !== "resume_session"),
    source: "user",
    createdBy: owner,
  });
}
