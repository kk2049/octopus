import { clipStatement, moduleId, nodeId, pathId, statementId, ticketId } from "../ids.js";
import { bullets, headingSlug, paragraphs, repoPaths, sections, ticketRefs } from "../markdown.js";
import type { KnowledgeNode, NodeKind } from "../model.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";
import { anchorEdge, firstHeading } from "./rules.js";

const MIN_STATEMENT_CHARS = 16;
const MAX_PARAGRAPH_CHARS = 400;
const SKIP_SECTION = /交付|delivery|changelog|变更记录|历史记录|测试命令|focused verification|how to run|安装|install/i;
const DECISION_CUE = /\b20\d\d-\d\d-\d\d\b|工单\s?#?\d+|#\d{2,}/;
const PRINCIPLE_HEADING = /纪律|规则|约束|不变量|边界|禁止|必须|invariant|rule|discipline|boundar|never|must|contract|原则/i;

// Inline code is already stripped by cleanInline, so match bare tokens: a
// known source dir, at least one slash, a source extension.
const RELATIVE_PATH = /(?:^|[\s(（"'，,：:])((?:src|lib|components|hooks|modules|routes|pages|analyzer|shared)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.{},-]+)*\.(?:tsx?|mts|cts|jsx?|css|json|md|sh|mjs))(?=$|[\s)）"'，,。；;：:])/g;

/** `lib/file-link.ts` mentioned in a package doc resolves to a file under that package (`<dir>/src/lib/file-link.ts` or `<dir>/lib/...`). */
export function relativePaths(text: string, dir: string, existing: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(RELATIVE_PATH)) {
    const rel = match[1];
    if (rel.includes("{") || rel.startsWith("packages/") || rel.startsWith("doc/")) continue;
    for (const candidate of [`${dir}${rel}`, `${dir}src/${rel}`]) {
      if (existing.has(candidate)) {
        found.add(candidate);
        break;
      }
    }
  }
  return [...found];
}

/**
 * Package-level `CLAUDE.md` / `README.md` / `DEVELOPMENT.md` carry module
 * invariants and dated decisions. Bullets become principle statements; dated
 * paragraphs (they cite a date or ticket) become decisions. Everything governs
 * the module that owns the document's directory.
 */
export async function packageDocsSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = await ctx.list([
    "packages/*/CLAUDE.md",
    "packages/*/README.md",
    "packages/*/DEVELOPMENT.md",
    "packages/bot/src/*/CLAUDE.md",
    "plugins/*/CLAUDE.md",
    "plugins/*/README.md",
    "ops/*/README.md",
    "tools/*/README.md",
  ]);
  const parsed = await mapLimit(files, 8, async (file) => ({ file, text: await ctx.read(file) }));
  const existing = new Set(await ctx.list([]));
  for (const { file, text } of parsed) {
    const dir = file.replace(/\/[^/]+$/, "/");
    const module = ctx.moduleForPath(`${dir}x.ts`);
    const docNode: KnowledgeNode = {
      id: nodeId("doc", file),
      kind: "doc",
      statement: clipStatement(firstHeading(text) ?? file),
      status: "active",
      authority: "package",
      source_ref: file,
      source_sha: ctx.sha,
      method: "parsed",
      certainty: "exact",
      metadata: { role: "package document", module },
    };
    out.nodes.push(docNode);
    if (module !== "unmapped") {
      out.edges.push({
        from_id: moduleId(module),
        relation: "documented_by",
        to_id: docNode.id,
        method: "parsed",
        certainty: "exact",
        source_ref: file,
        source_sha: ctx.sha,
        observed_at: ctx.observedAt,
      });
    }

    const governsTargets = [pathId(dir), ...(module !== "unmapped" ? [moduleId(module)] : [])];
    let statements = 0;
    for (const section of sections(text)) {
      if (SKIP_SECTION.test(section.title)) continue;
      const anchor = section.title ? `${file}#${headingSlug(section.title)}` : file;
      const sectionTickets = ticketRefs(section.title);
      const sectionIsDecision = DECISION_CUE.test(section.title);
      const emit = (kind: NodeKind, rawText: string, line: number, certainty: "exact" | "inferred") => {
        if (rawText.length < MIN_STATEMENT_CHARS) return;
        if (/^(见|参见|see)\s/i.test(rawText) || /^[`A-Za-z0-9_./-]+$/.test(rawText)) return;
        const statement = clipStatement(rawText);
        const node: KnowledgeNode = {
          id: statementId(kind, anchor, statement),
          kind,
          statement,
          status: "active",
          authority: "package",
          source_ref: `${anchor}:${section.startLine + line + 2}`,
          source_sha: ctx.sha,
          method: "parsed",
          certainty,
          metadata: { heading: section.headingPath.join(" / "), module },
        };
        out.nodes.push(node);
        statements += 1;
        out.edges.push(anchorEdge(ctx, docNode.id, node.id, file));
        for (const target of governsTargets) {
          out.edges.push({
            from_id: node.id,
            relation: kind === "decision" ? "realizes" : "governs",
            to_id: target,
            method: "parsed",
            certainty,
            source_ref: file,
            source_sha: ctx.sha,
            observed_at: ctx.observedAt,
          });
        }
        for (const ticket of new Set([...sectionTickets, ...ticketRefs(rawText)])) {
          out.edges.push({
            from_id: node.id,
            relation: "about",
            to_id: ticketId(ticket),
            method: "parsed",
            certainty: "inferred",
            source_ref: file,
            source_sha: ctx.sha,
            observed_at: ctx.observedAt,
          });
        }
        for (const path of [...repoPaths(rawText), ...relativePaths(rawText, dir, existing)]) {
          out.nodes.push({ id: pathId(path), kind: "path", statement: path, status: "active", authority: "derived", source_ref: file, source_sha: ctx.sha, method: "parsed", certainty: "inferred" });
          out.edges.push({
            from_id: node.id,
            relation: kind === "decision" ? "realizes" : "governs",
            to_id: pathId(path),
            method: "parsed",
            certainty: "inferred",
            source_ref: file,
            source_sha: ctx.sha,
            observed_at: ctx.observedAt,
          });
        }
      };
      for (const bullet of bullets(section.lines)) {
        emit(sectionIsDecision || DECISION_CUE.test(bullet.text) ? "decision" : "principle", bullet.text, bullet.line, "exact");
      }
      for (const paragraph of paragraphs(section.lines)) {
        if (paragraph.text.length > MAX_PARAGRAPH_CHARS) continue;
        const decision = sectionIsDecision || DECISION_CUE.test(paragraph.text);
        if (!decision && !PRINCIPLE_HEADING.test(section.title) && !/不得|必须|禁止|never|must not|only/i.test(paragraph.text)) continue;
        emit(decision ? "decision" : "principle", paragraph.text, paragraph.line, "inferred");
      }
    }
    out.nodes.push({
      id: pathId(dir),
      kind: "path",
      statement: dir,
      status: "active",
      authority: "derived",
      source_ref: file,
      source_sha: ctx.sha,
      method: "parsed",
      certainty: "exact",
    });
    out.coverage.push({ scope_kind: "doc", scope_id: file, measure: "statements", value: statements });
  }
  return out;
}
