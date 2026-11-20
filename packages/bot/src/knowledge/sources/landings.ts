import { clipStatement, moduleId, nodeId, pathId, statementId, ticketId } from "../ids.js";
import type { KnowledgeEdge, KnowledgeNode, LandingInput, NodeKind, Relation, TicketInput } from "../model.js";
import { cliLandingId } from "./cli-reports.js";
import { emptyOutput, type SourceContext, type SourceOutput } from "./context.js";
import { projectSpecification, specificationFor } from "../specifications.js";

export interface RuntimeInputs {
  landings: LandingInput[];
  tickets: TicketInput[];
}

const KIND_FIELDS: Array<[NodeKind, keyof LandingInput["knowledge"]]> = [
  ["requirement", "requirements"],
  ["decision", "decisions"],
  ["non_goal", "non_goals"],
  ["risk", "risks"],
];

/**
 * Runtime facts from `bot.db`: ticket pointers and the immutable
 * `ticket_landings` ledger with its structured knowledge payload. Statement
 * ids reproduce the 2026-08-19 `knowledge_records` keys
 * (`landing:<id>:<kind>:<index>`) so `supersedes` references written under
 * that contract keep resolving.
 */
export function landingsSource(ctx: SourceContext, inputs: RuntimeInputs): SourceOutput {
  const out = emptyOutput();
  const requesterByTicket = new Map(inputs.tickets.map((ticket) => [ticket.id, ticket.requester] as const));
  const link = (from: string, relation: Relation, to: string, certainty: "exact" | "inferred", sourceRef: string): KnowledgeEdge => ({
    from_id: from,
    relation,
    to_id: to,
    method: "landing",
    certainty,
    source_ref: sourceRef,
    source_sha: ctx.sha,
    observed_at: ctx.observedAt,
  });

  for (const ticket of inputs.tickets) {
    const ref = `ticket:${ticket.id}`;
    out.nodes.push({
      id: ticketId(ticket.id),
      kind: "ticket",
      statement: clipStatement(`#${ticket.id} ${ticket.title}`),
      status: ticket.dev_status === "cancelled" ? "rejected" : "active",
      authority: "record",
      source_ref: ref,
      source_sha: ctx.sha,
      valid_from: ticket.created_at,
      method: "landing",
      certainty: "exact",
      metadata: {
        kind: ticket.kind,
        requester: ticket.requester,
        origin_ticket_id: ticket.id,
        dev_status: ticket.dev_status,
        created_at: ticket.created_at,
        landed_at: ticket.landed_at,
        commit_sha: ticket.commit_sha,
        parent_ticket_id: ticket.parent_ticket_id,
        // Only recorded kinds: pre-v86 ticket nodes stay byte-identical.
        ...(ticket.actor_kind ? { actor_kind: ticket.actor_kind } : {}),
      },
    });
    if (ticket.parent_ticket_id) out.edges.push(link(ticketId(ticket.id), "about", ticketId(ticket.parent_ticket_id), "exact", ref));
    if (ticket.kind === "cli" && ticket.commit_sha) {
      out.edges.push(link(cliLandingId(ticket.commit_sha), "about", ticketId(ticket.id), "exact", ref));
    }
  }

  for (const landing of inputs.landings) {
    const ref = `landing:${landing.id}`;
    const cliLane = landing.source === "cli" || landing.source === "reconcile";
    const landingId = cliLane ? cliLandingId(landing.to_sha) : nodeId("landing", String(landing.id));
    const scope = cliLane ? `cli:${landing.to_sha.slice(0, 12)}` : ref;
    out.nodes.push({
      id: landingId,
      kind: "landing",
      statement: clipStatement(landing.summary || `landing ${landing.id}`),
      status: "active",
      authority: "derived",
      source_ref: ref,
      source_sha: ctx.sha,
      valid_from: landing.landed_at ?? undefined,
      method: "landing",
      certainty: "exact",
      metadata: {
        lane: cliLane ? "cli" : "ticket",
        requester: requesterByTicket.get(landing.ticket_id),
        origin_ticket_id: landing.ticket_id,
        landing_id: landing.id,
        ticket_id: landing.ticket_id,
        from_sha: landing.from_sha,
        to_sha: landing.to_sha,
        landed_at: landing.landed_at,
        report_path: landing.report_path,
        alias_ids: [nodeId("landing", String(landing.id))],
        changes: landing.knowledge.changes ?? [],
      },
    });
    out.edges.push(link(landingId, "about", ticketId(landing.ticket_id), "exact", ref));
    const modules = new Set<string>();
    for (const file of landing.changed_files) {
      out.nodes.push({
        id: pathId(file),
        kind: "path",
        statement: file,
        status: "active",
        authority: "derived",
        source_ref: ref,
        source_sha: ctx.sha,
        method: "landing",
        certainty: "exact",
      });
      out.edges.push(link(landingId, "touches", pathId(file), "exact", ref));
      const module = ctx.moduleForPath(file);
      if (module !== "unmapped") modules.add(module);
    }
    for (const module of modules) out.edges.push(link(landingId, "touches", moduleId(module), "exact", ref));

    // Index scheme of KnowledgeRepository.completeLanding: 0 = outcome, then
    // requirements, decisions, non_goals, risks, verification in order.
    let index = 1;
    for (const [kind, field] of KIND_FIELDS) {
      for (const raw of landing.knowledge[field] as string[]) {
        const legacyKey = `landing:${landing.id}:${kind}:${index}`;
        index += 1;
        if (!raw.trim()) continue;
        const statement = clipStatement(raw);
        const node: KnowledgeNode = {
          id: cliLane ? statementId(kind, scope, statement) : legacyKey,
          kind,
          statement,
          status: "active",
          authority: "derived",
          source_ref: `ticket:${landing.ticket_id}/${ref}#${String(field)}`,
          source_sha: ctx.sha,
          valid_from: landing.landed_at ?? undefined,
          method: "landing",
          certainty: "exact",
          metadata: {
            landing: landingId,
            ticket_id: landing.ticket_id,
            requester: requesterByTicket.get(landing.ticket_id),
            origin_ticket_id: landing.ticket_id,
            alias_ids: cliLane ? [legacyKey] : [],
            provenance: { author: { kind: "agent", name: "landing-agent", model: landing.knowledge.producer?.model ?? null, ref }, basis: landing.knowledge.context_keys, events: [] },
          },
        };
        out.nodes.push(node);
        const spec = specificationFor(landing.knowledge.specifications, node);
        if (spec) projectSpecification(spec, node, ctx, out, landing.knowledge.producer);
        out.edges.push(link(landingId, "implements", node.id, "exact", ref));
        out.edges.push(link(node.id, "about", ticketId(landing.ticket_id), "exact", ref));
      }
    }
    landing.knowledge.verification.forEach((text, offset) => {
      const legacyKey = `landing:${landing.id}:verification:${index + offset}`;
      if (!text.trim()) return;
      const evidenceId = cliLane ? nodeId("evidence", `${scope}:${offset}`) : nodeId("evidence", `${ref}:${offset}`);
      out.nodes.push({
        id: evidenceId,
        kind: "evidence",
        statement: clipStatement(text),
        status: "active",
        authority: "derived",
        source_ref: `${ref}#verification`,
        source_sha: ctx.sha,
        method: "landing",
        certainty: "exact",
        metadata: { alias_ids: [legacyKey] },
      });
      out.edges.push(link(evidenceId, "evidences", landingId, "exact", ref));
    });
    for (const change of landing.knowledge.changes ?? []) {
      out.edges.push(link(landingId, "conflicts_with", change.record_id, "exact", ref));
    }
    for (const target of landing.knowledge.supersedes) {
      if (target.trim()) out.edges.push(link(landingId, "supersedes", target.trim(), "exact", ref));
    }
  }
  return out;
}
