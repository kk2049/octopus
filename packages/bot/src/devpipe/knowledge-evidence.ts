import { verifyEvidenceEvent, type OriginalKnowledgeSource } from "../knowledge/evidence-verification.js";
import type { CuratedRecord } from "../knowledge/model.js";
import type { KnowledgeEvidenceEvent } from "../knowledge/provenance.js";
import type { Store } from "../store/store.js";
import { isNonPersonActor } from "../store/repositories/dev-tickets.js";
import { gitOrThrow } from "./worktree.js";
import { ticketSourcePage } from "./knowledge-sources.js";

/** Give the current ticket agent exact source identities, without exposing other tickets or copying transcripts. */
export function ticketEvidenceIdentities(store: Store, ticketId: number): string {
  const ticket = store.devTickets.getDevTicket(ticketId);
  if (!ticket) return "";
  const { sources } = ticketSourcePage(store,ticketId);
  return `本票原始来源身份（仅用于 specifications 证据核对，不代表任何设计已获背书；quote/design 从本人原文逐字摘取，勿从摘要推定）：\n${sources.map((source) => JSON.stringify(source)).join("\n")}`;
}

export function originalEvidenceSource(store: Store, event: KnowledgeEvidenceEvent, owner?: string): OriginalKnowledgeSource | null {
  if (event.ref.startsWith("knowledge-source:")) {
    const confirmed = owner ? store.knowledgeSources.evidence(owner,event.ref) : null;
    if (!confirmed || confirmed.kind !== event.kind || confirmed.design !== event.design) return null;
    return {actor:confirmed.actor,at:confirmed.at,text:confirmed.quote,kind:"human_message"};
  }
  const match = /^ticket:(\d+)(?:#message:(\d+))?$/u.exec(event.ref);
  if (!match) return null;
  const ticket = store.devTickets.getDevTicket(Number(match[1]));
  if (!ticket) return null;
  // Review 6.10: text written through a token, MCP or the Head carries the
  // requester's name but not their typing, so it is agent evidence. Pre-v86
  // rows (NULL) keep the channel rule they were written under.
  if (!match[2] && ticket.kind !== "cli") return { actor: ticket.requester, at: ticket.created_at, text: ticket.body, kind: isNonPersonActor(ticket.actor_kind) ? "agent_message" : "original_prompt" };
  if (!match[2]) return null;
  const message = store.devTickets.listTicketMessages(ticket.id).find((row) => row.id === Number(match[2]));
  return message ? { actor: message.author, at: message.created_at, text: message.body, kind: ["web", "feishu"].includes(message.via) && !isNonPersonActor(message.actor_kind) ? "human_message" : "agent_message" } : null;
}

/** Both landing lanes validate new human assertions locally; private source text never reaches CI. */
export async function verifyNewHumanEvidence(input: { repoDir: string; from: string; to: string; files: readonly string[]; store: Store; owner?: string }): Promise<void> {
  for (const file of input.files.filter((name) => /^architecture\/knowledge\/curated\/[^/]+\.jsonl$/u.test(name))) {
    let before = "";
    let after = "";
    try { before = await gitOrThrow(input.repoDir, ["show", `${input.from}:${file}`]); } catch { /* new source */ }
    try { after = await gitOrThrow(input.repoDir, ["show", `${input.to}:${file}`]); } catch { /* A deleted source still has to retain its review history. */ }
    const prior = before.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CuratedRecord);
    const next = after.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CuratedRecord);
    for (const original of prior) {
      if (!original.provenance?.events.length) continue;
      const current = next.find((record) => record.id === original.id);
      if (!current || original.provenance.events.some((event) => !current.provenance?.events.some((value) => JSON.stringify(value) === JSON.stringify(event)))) {
        throw new Error(`${original.id}: 审阅证据只可追加，不能删除或改写；退役设计请保留原条目和历史并记录变更。`);
      }
    }
    const old = new Set(before.split("\n").filter(Boolean).flatMap((line) => (() => { const record = JSON.parse(line) as CuratedRecord; return (record.provenance?.events ?? []).map((event) => JSON.stringify([record.id, record.statement, event])); })()));
    for (const line of after.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as CuratedRecord;
      for (const event of record.provenance?.events ?? []) {
        if (!["requirement", "endorsement"].includes(event.kind) || old.has(JSON.stringify([record.id, record.statement, event]))) continue;
        const error = verifyEvidenceEvent(event, originalEvidenceSource(input.store, event, input.owner));
        if (error) throw new Error(`${record.id}: ${error} (${event.ref})。保留原始证据指针并使用 Agent 判断档，等待可核实的人类证据。`);
      }
    }
  }
}
