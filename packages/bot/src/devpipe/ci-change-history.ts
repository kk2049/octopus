/**
 * Everything that changed between the last green batch and the red one, with
 * the tickets that changed it (ticket #219, fourth turn).
 *
 * ── Why a repair ticket needs this ────────────────────────────────────────
 *
 * A red batch names a FILE. The cause is almost never in that file — it is in
 * whatever landed since the last green, which is exactly the range nobody was
 * handing the repair agent. Without it the agent starts from the assertion and
 * works outwards, which is how a fixture edit becomes the obvious move; with
 * it, the first question becomes "which of these ten commits could produce
 * this", which is the question that actually has an answer.
 *
 * The measured case: `bootstrap-v3.test.ts` went red with
 * `expected […(14)] to deeply equal […(15)]`. The missing service was
 * `session-plus-runtime`, and the commits in range were about Session Plus
 * release fixtures. Three tickets edited the fixture; none of them was shown
 * the range as a range.
 *
 * ── Why the ticket's own words, not just its title ────────────────────────
 *
 * A landed ticket carries two things no commit message has: what the requester
 * ASKED for (the opening message) and what the agent SAYS it did (its last
 * reply). A commit says "reset release fixture modules"; the ticket says "this
 * batch was red on X, I believe the cause is Y, I could not reproduce Z". For a
 * repair agent deciding whether a neighbouring change is suspicious, that is
 * the difference between a name and a lead.
 *
 * Everything here is bounded: a range that explodes is summarised rather than
 * pasted, because this text goes into a prompt window that also has to hold the
 * failure roster.
 */

import type { Store } from "../store/store.js";

/** One landed commit in the range, with its ticket if we can find one. */
export interface CiRangeCommit {
  sha: string;
  subject: string;
  ticketId?: number;
}

export interface CiTicketContext {
  id: number;
  title: string;
  requester: string;
  source: "conversation" | "cli-report";
  /** Human opening request, or the CLI delivery's modification-result report. */
  opening: string;
  /** The conversational agent's own last word. CLI reports have no agent turn. */
  summary: string | null;
}

const OPENING_CHARS = 700;
const SUMMARY_CHARS = 900;
const SUBJECT_CHARS = 120;

/**
 * Git log is newest-first. Each landing records its tip SHA; all following
 * commits down to the next recorded tip belong to that same ticket. Carrying
 * the active ticket backwards associates every commit in a multi-commit
 * landing, not only the final one persisted in `dev_tickets.commit_sha`.
 */
export function associateCiRangeCommits(
  store: Store,
  commits: readonly Omit<CiRangeCommit, "ticketId">[],
): CiRangeCommit[] {
  let activeTicketId: number | undefined;
  return commits.map((commit) => {
    const landed = store.devTickets.findDevTicketByCommitSha(commit.sha);
    if (landed) activeTicketId = landed.id;
    return activeTicketId == null ? { ...commit } : { ...commit, ticketId: activeTicketId };
  });
}

function clip(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Pull the human opening ask and the agent's final summary. CLI landings have
 * no conversational agent; their opening body is already the required
 * modification-result report, so it is labelled and carried as such.
 */
export function ticketContext(store: Store, ticketId: number): CiTicketContext | null {
  const t = store.devTickets.getDevTicket(ticketId);
  if (!t) return null;
  const msgs = store.devTickets.listTicketMessages(ticketId);
  const opening = msgs[0]?.body ?? t.body ?? "";
  const lastAgent = [...msgs].reverse().find((m) => m.author === "agent");
  return {
    id: t.id,
    title: t.title,
    requester: t.requester,
    source: t.kind === "cli" ? "cli-report" : "conversation",
    opening: clip(opening, OPENING_CHARS),
    summary: t.kind === "cli" ? null : clip(lastAgent?.body ?? "(这张票没有 agent 总结)", SUMMARY_CHARS),
  };
}

/**
 * Render the block that goes into the repair ticket body.
 *
 * `commits` comes from the caller because reading Git is the pipeline's job,
 * not this module's — keeping the shaping pure is what lets it be tested
 * without a repository.
 */
export function renderCiChangeHistory(
  store: Store,
  fromSha: string | null,
  toSha: string,
  commits: readonly CiRangeCommit[],
): string {
  const head = fromSha
    ? `## 上一次全绿以来的全部改动(${fromSha.slice(0, 10)} → ${toSha.slice(0, 10)})`
    : `## 本批次的改动(没有已知的上一次全绿,范围未知)`;
  if (!commits.length) {
    return `${head}\n\n(这个范围里没有 commit——如果确实如此,这批红灯与新代码无关,`
      + `优先怀疑是不稳定用例或基础设施,不要为它改断言。)`;
  }

  const lines = commits.map((c) =>
    `- \`${c.sha.slice(0, 10)}\` ${clip(c.subject, SUBJECT_CHARS)}${c.ticketId ? ` (工单 #${c.ticketId})` : ""}`);

  // Most-recent first, deduplicated: a branch with six commits is one ticket.
  const ids: number[] = [];
  for (const c of commits) if (c.ticketId != null && !ids.includes(c.ticketId)) ids.push(c.ticketId);
  const contexts = ids
    .map((id) => ticketContext(store, id))
    .filter((c): c is CiTicketContext => c != null);

  const ticketBlocks = contexts.map((c) => {
    const evidence = c.source === "cli-report"
      ? `**修改结果报告**:\n${c.opening}`
      : `**原始输入**:\n${c.opening}\n\n**该票 agent 的修改总结**:\n${c.summary}`;
    return `### 工单 #${c.id}「${c.title}」(提单人 ${c.requester})\n${evidence}`;
  }).join("\n\n");

  return `${head}\n\n${lines.join("\n")}\n\n`
    + (ticketBlocks
      ? `以下是全部增量对应工单的原始输入或修改结果报告——先在这里找嫌疑人,`
        + `再回到失败文件:\n\n${ticketBlocks}`
      : `这些 commit 没有匹配到工单。`);
}
