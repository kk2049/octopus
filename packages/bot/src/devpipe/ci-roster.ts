/**
 * The failure roster a CI repair ticket is accountable for (ticket #219).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Measured on `v4`, `1c9928c..716ad3f` is seven consecutive landings against
 * ONE red batch: six edits to the same `bootstrap-v3.test.ts` fixture and then
 * the real bug in `session-plus/identity.ts`. Every one of those six cost a
 * full lht-val15 batch (20-45 min) to be told "still red". The repair agent was
 * not being careless — it was following its own prompt, which is the ordinary
 * ticket contract and says in as many words: do not run tests on this node,
 * commit and submit, CI will tell you. For a ticket whose entire subject IS a
 * test result, that instruction turns the batch queue into the agent's REPL.
 *
 * So a CI repair ticket carries the roster of files CI named, and landing is
 * conditional on them being green in the candidate tree. The roster is the
 * whole mechanism: the prompt (`ciRepairRule`) tells the agent what it must
 * prove, and the land gate (`land-gate.ts`) proves it whether or not the agent
 * bothered. An unverified guess no longer reaches the watermark, so it can no
 * longer consume a batch.
 *
 * ── Why a column and not a ticket kind ─────────────────────────────────────
 *
 * `kind` is the USER's choice of interaction contract (ask me / don't ask me /
 * App allowlist / just chat) and it is editable from the board. This lane is
 * opened by the machine and is not a shape a person picks, so it rides on data
 * the machine owns instead of adding a fourth radio button nobody can honestly
 * choose. A non-null `ci_roster` — including `[]` — IS the marker: the ticket
 * came from a red batch. `[]` happens when the trace had no parseable roster
 * (infrastructure failure, a suite that never started), and that ticket still
 * needs the repair contract even though the gate has nothing extra to run.
 */

/**
 * How many roster files the land gate will actually run.
 *
 * A red with more failing files than this is nearly always one common cause
 * (a changed default, a moved fixture), so running the first slice proves the
 * fix as well as running all of it would. The overflow is NOT dropped
 * silently: `rosterGateFiles` reports what it left out and the gate log names
 * it, because "the gate passed" must not quietly mean "the gate ran a quarter
 * of the roster".
 */
export const CI_ROSTER_GATE_MAX_FILES = 24;

/** `null` = an ordinary ticket. Any array, empty included, = the CI lane. */
export function isCiRepairTicket(t: { ci_roster?: string | null } | null | undefined): boolean {
  return t?.ci_roster != null;
}

/** Tolerant on purpose: a corrupt column must not make a ticket unlandable. */
export function decodeCiRoster(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === "string" && f.length > 0);
  } catch {
    return [];
  }
}

export function encodeCiRoster(files: readonly string[]): string {
  return JSON.stringify([...files]);
}

/**
 * Union, in first-seen order.
 *
 * Union rather than replace is the anti-ping-pong rule. When a second red is
 * routed into the same repair conversation, the ticket becomes accountable for
 * BOTH rosters — so "fix A, break B, fix B, break A" cannot land at any point
 * in the cycle. Order is stable so the gate log reads the same way twice.
 */
export function mergeCiRoster(current: string | null | undefined, incoming: readonly string[]): string[] {
  const out = decodeCiRoster(current);
  const seen = new Set(out);
  for (const file of incoming) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export interface RosterGateSelection {
  /** What the gate will run, in roster order. */
  files: string[];
  /** Named by CI but not present in the candidate tree — deleted or renamed. */
  missing: string[];
  /** Beyond `CI_ROSTER_GATE_MAX_FILES`; reported, never silently swallowed. */
  overflow: string[];
}

/**
 * Decide what the gate runs against the candidate tree.
 *
 * `exists` is asked per file because a legitimate fix may DELETE or rename the
 * test CI complained about. Handing `vitest run` a path that is no longer there
 * is an error that looks like a failure, so a vanished file is dropped from the
 * run and reported instead — the agent's commit message is where that gets
 * explained, not a gate refusal it cannot act on.
 */
export function rosterGateFiles(
  roster: readonly string[],
  exists: (file: string) => boolean,
  max = CI_ROSTER_GATE_MAX_FILES,
): RosterGateSelection {
  const present: string[] = [];
  const missing: string[] = [];
  for (const file of roster) (exists(file) ? present : missing).push(file);
  return { files: present.slice(0, max), missing, overflow: present.slice(max) };
}
