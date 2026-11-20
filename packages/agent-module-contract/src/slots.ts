/**
 * The five slots, and the fact that there are exactly five.
 *
 * A general layout tree is the thing this platform deliberately does not have
 * yet. React already mounts, reuses and unmounts components from layout state,
 * and CSS Grid/Flex already places them; what a workspace adds is the product
 * semantics — which surface a resource opens into, what "already open" means,
 * what a narrow screen does. Those are decisions, and a closed vocabulary is how
 * a decision stays reviewable.
 *
 * So this is an enumeration, not a schema for one. A sixth slot is a design
 * change that shows up as a diff here and in every conformance test, which is
 * exactly the cost it should have.
 */

export const WORKSPACE_SLOTS = ["navigation", "primary", "secondary", "bottom", "overlay"] as const;

export type WorkspaceSlot = (typeof WORKSPACE_SLOTS)[number];

/**
 * Where a resource opens when nothing says otherwise.
 *
 * `secondary` because that is the shape the whole feature exists for: a link in
 * the primary surface opens an inspector beside it without replacing what the
 * reader was doing.
 */
export const DEFAULT_OPEN_SLOT: WorkspaceSlot = "secondary";

export function isWorkspaceSlot(value: unknown): value is WorkspaceSlot {
  return typeof value === "string" && (WORKSPACE_SLOTS as readonly string[]).includes(value);
}

/**
 * The three slots that hold a DOCUMENT rather than a flow of widgets.
 *
 * `navigation` and `bottom` are strips: a tree beside a status bar, several
 * widgets stacked in one region, none of them "the thing being read". The other
 * three hold one document at a time, which is why they are the only slots where
 * "open a second one of these" is a question with an answer.
 *
 * It lives here, next to the enumeration it is a subset of, because the moment a
 * second file spells `["primary", "secondary", "overlay"]` the two copies can
 * disagree about a sixth slot — and the one that did not get updated would be
 * the one deciding whether a surface may be duplicated.
 */
export const DOCUMENT_SLOTS = ["primary", "secondary", "overlay"] as const;

export type DocumentSlot = (typeof DOCUMENT_SLOTS)[number];

export function isDocumentSlot(value: unknown): value is DocumentSlot {
  return typeof value === "string" && (DOCUMENT_SLOTS as readonly string[]).includes(value);
}

/** Canonical slot order, so two compositions with the same slots encode alike. */
export function sortSlots(slots: readonly WorkspaceSlot[]): WorkspaceSlot[] {
  return [...slots].sort((a, b) => WORKSPACE_SLOTS.indexOf(a) - WORKSPACE_SLOTS.indexOf(b));
}
