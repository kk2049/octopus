import { clipStatement, moduleId, nodeId, pathId, statementId, ticketId } from "../ids.js";
import { bullets, headingSlug, paragraphs, parseFrontmatter, repoPaths, sections, ticketRefs } from "../markdown.js";
import type { KnowledgeEdge, KnowledgeNode, NodeKind, Relation } from "../model.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";
import { anchorEdge, firstHeading } from "./rules.js";

const NON_GOAL_SECTION = /没改什么|没有改什么|未改|非目标|明确未做|不做|没做|non-goal|not changed|out of scope/i;
const RISK_SECTION = /风险|回滚|risk|rollback/i;
const RESULT_SECTION = /^结果|一句话|result|summary/i;
const FILES_SECTION = /关键文件|改了什么|key files|what changed|文件/i;

/**
 * Delivery documents stay one-time records (`doc/README.md` ruling). The
 * graph keeps a pointer node per document plus the two sections that carry
 * durable negative knowledge — what was deliberately not done, and what the
 * next change must watch — as `historical` statements anchored to the file.
 */
export async function deliveriesSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = (await ctx.list(["doc/deliveries/*.md"])).filter((file) => !/\/README\.md$/.test(file));
  const parsed = await mapLimit(files, 8, async (file) => ({ file, text: await ctx.read(file) }));
  for (const { file, text } of parsed) {
    const { data, body } = parseFrontmatter(text);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? null;
    const title = firstHeading(body) ?? file;
    const superseded = /已取代|superseded/i.test(title);
    const docId = nodeId("doc", file);
    const secs = sections(body);
    const result = secs.find((section) => RESULT_SECTION.test(section.title));
    const summary = result ? paragraphs(result.lines)[0]?.text ?? "" : "";
    const docNode: KnowledgeNode = {
      id: docId,
      kind: "doc",
      statement: clipStatement(title),
      status: superseded ? "superseded" : "historical",
      authority: "record",
      source_ref: file,
      source_sha: ctx.sha,
      valid_from: date ?? undefined,
      method: "parsed",
      certainty: "exact",
      metadata: { role: "delivery", date, summary: summary.slice(0, 400) },
    };
    out.nodes.push(docNode);

    const tickets = new Set<number>();
    for (const value of Array.isArray(data.tickets) ? data.tickets : []) {
      const number = Number(value);
      if (Number.isInteger(number) && number > 0) tickets.add(number);
    }
    const exactTickets = new Set(tickets);
    for (const ticket of ticketRefs([title, ...body.split(/\r?\n/).slice(0, 40)].join("\n"))) tickets.add(ticket);
    for (const ticket of tickets) {
      out.edges.push(edge(ctx, docId, "about", ticketId(ticket), file, exactTickets.has(ticket) ? "exact" : "inferred"));
    }

    const touched = new Set<string>();
    for (const section of secs) {
      if (FILES_SECTION.test(section.title)) for (const path of repoPaths(section.lines.join("\n"))) touched.add(path);
    }
    for (const section of secs) {
      const kind: NodeKind | null = NON_GOAL_SECTION.test(section.title) ? "non_goal" : RISK_SECTION.test(section.title) ? "risk" : null;
      if (!kind || section.level === 0) continue;
      const anchor = `${file}#${headingSlug(section.title)}`;
      for (const bullet of bullets(section.lines)) {
        if (bullet.text.length < 12) continue;
        const statement = clipStatement(bullet.text);
        const node: KnowledgeNode = {
          id: statementId(kind, anchor, statement),
          kind,
          statement,
          status: superseded ? "superseded" : "historical",
          authority: "record",
          source_ref: `${anchor}:${section.startLine + bullet.line + 2}`,
          source_sha: ctx.sha,
          valid_from: date ?? undefined,
          method: "parsed",
          certainty: "exact",
          metadata: { delivery: file, heading: section.headingPath.join(" / ") },
        };
        out.nodes.push(node);
        out.edges.push(anchorEdge(ctx, docId, node.id, file));
        for (const ticket of tickets) out.edges.push(edge(ctx, node.id, "about", ticketId(ticket), file, "inferred"));
      }
    }
    for (const path of touched) {
      out.nodes.push({
        id: pathId(path),
        kind: "path",
        statement: path,
        status: "active",
        authority: "derived",
        source_ref: file,
        source_sha: ctx.sha,
        method: "parsed",
        certainty: "inferred",
      });
      out.edges.push(edge(ctx, docId, "touches", pathId(path), file, "inferred"));
      const module = ctx.moduleForPath(path);
      if (module !== "unmapped") out.edges.push(edge(ctx, docId, "touches", moduleId(module), file, "inferred"));
    }
  }
  return out;
}

function edge(ctx: SourceContext, from: string, relation: Relation, to: string, file: string, certainty: "exact" | "inferred"): KnowledgeEdge {
  return { from_id: from, relation, to_id: to, method: "parsed", certainty, source_ref: file, source_sha: ctx.sha, observed_at: ctx.observedAt };
}
