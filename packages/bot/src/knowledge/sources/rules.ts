import { clipStatement, moduleId, nodeId, pathId, statementId } from "../ids.js";
import { bullets, cleanInline, headingSlug, parseFrontmatter, sections } from "../markdown.js";
import type { KnowledgeEdge, KnowledgeNode } from "../model.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";

const MIN_STATEMENT_CHARS = 12;

/**
 * `packages/dashboard-web/**\/*` → `packages/dashboard-web/`; a glob without
 * wildcards is an exact file; `**\/*.ts`-style globs have no directory and
 * return null (the rule is global — see `isGlobalGlob`).
 */
export function globPrefix(glob: string): string | null {
  const clean = glob.replace(/^\.\//, "");
  const cut = clean.search(/[*?[{]/);
  if (cut === -1) return clean || null;
  const prefix = clean.slice(0, cut);
  if (!prefix) return null;
  return prefix.endsWith("/") ? prefix : `${prefix.replace(/\/[^/]*$/, "")}/`;
}

export function isGlobalGlob(glob: string): boolean {
  return /^(\.\/)?\*\*/.test(glob) || !glob.replace(/^\.\//, "").replace(/[*?[{].*$/, "");
}

/**
 * The path anchors of one frontmatter glob. `packages/dashboard-web/**\/*` is
 * its directory and a wildcard-free glob is that file; a glob whose first
 * wildcard segment is a partial name (`packages/agent-*\/**\/*`,
 * `packages/*-contract/**\/*`) is expanded against the tree into the
 * directories (or files) it matches at this commit. The static prefix alone
 * would make `packages/` the anchor, i.e. every package: on 2026-08-21 the App
 * and resource-binding rules reached every dashboard diff that way and the
 * submit-time acknowledgement set grew to 130+ statements.
 */
export async function anchorPrefixes(glob: string, ctx: Pick<SourceContext, "list">): Promise<string[]> {
  const clean = glob.replace(/^\.\//, "");
  const prefix = globPrefix(clean);
  if (!prefix) return [];
  const segment = clean.slice(prefix.length).split("/")[0] ?? "";
  if (!segment || segment === "*" || segment === "**") return [prefix];
  const anchors = new Set<string>();
  for (const file of await ctx.list([clean])) {
    const remainder = file.slice(prefix.length);
    const slash = remainder.indexOf("/");
    anchors.add(slash === -1 ? file : `${prefix}${remainder.slice(0, slash)}/`);
  }
  return [...anchors].sort();
}

/**
 * Always-on rules (`AGENTS.md`) and path-scoped rules (`.claude/rules/*.md`)
 * become principle nodes: one bullet, one statement. Path-scoped rules govern
 * the modules their frontmatter paths resolve to.
 */
export async function rulesSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = await ctx.list(["AGENTS.md", ".claude/rules/*.md"]);
  const parsed = await mapLimit(files, 8, async (file) => ({ file, text: await ctx.read(file) }));
  for (const { file, text } of parsed) {
    const alwaysOn = file === "AGENTS.md";
    const { data, body, bodyLine } = parseFrontmatter(text);
    const docNode: KnowledgeNode = {
      id: nodeId("doc", file),
      kind: "doc",
      statement: clipStatement(firstHeading(body) ?? file),
      status: "active",
      authority: alwaysOn ? "always_on" : "path_rule",
      source_ref: file,
      source_sha: ctx.sha,
      method: "parsed",
      certainty: "exact",
      metadata: { role: alwaysOn ? "always-on rule" : "path-scoped rule", paths: data.paths ?? [] },
    };
    out.nodes.push(docNode);

    const governed: Array<{ prefix: string; module: string }> = [];
    let global = false;
    if (!alwaysOn && Array.isArray(data.paths)) {
      for (const glob of data.paths as string[]) {
        if (isGlobalGlob(glob)) {
          global = true;
          continue;
        }
        const prefixes = await anchorPrefixes(glob, ctx);
        if (!prefixes.length) {
          out.warnings.push(`${file}: glob ${glob} anchors no path at this commit`);
          continue;
        }
        for (const prefix of prefixes) governed.push({ prefix, module: ctx.moduleForPath(prefix.endsWith("/") ? `${prefix}x.ts` : prefix) });
      }
    }
    docNode.metadata = { ...(docNode.metadata ?? {}), global };

    for (const section of sections(body, bodyLine)) {
      if (/compatibility index|兼容索引/i.test(section.title)) continue;
      const anchor = section.title ? `${file}#${headingSlug(section.title)}` : file;
      for (const bullet of bullets(section.lines)) {
        if (bullet.text.length < MIN_STATEMENT_CHARS) continue;
        const statement = clipStatement(bullet.text);
        const node: KnowledgeNode = {
          id: statementId("principle", anchor, statement),
          kind: "principle",
          statement,
          status: "active",
          authority: alwaysOn ? "always_on" : "path_rule",
          source_ref: `${anchor}:${section.startLine + bullet.line + 2}`,
          source_sha: ctx.sha,
          method: "parsed",
          certainty: "exact",
          metadata: { heading: section.headingPath.join(" / "), global },
        };
        out.nodes.push(node);
        out.edges.push(anchorEdge(ctx, docNode.id, node.id, file));
        for (const { prefix, module } of governed) {
          out.edges.push({
            from_id: node.id,
            relation: "governs",
            to_id: pathId(prefix),
            method: "declared",
            certainty: "exact",
            source_ref: file,
            source_sha: ctx.sha,
            observed_at: ctx.observedAt,
          });
          if (module !== "unmapped") {
            out.edges.push({
              from_id: node.id,
              relation: "governs",
              to_id: moduleId(module),
              method: "declared",
              certainty: "exact",
              source_ref: file,
              source_sha: ctx.sha,
              observed_at: ctx.observedAt,
            });
          }
        }
      }
    }
    for (const { prefix } of governed) {
      out.nodes.push({
        id: pathId(prefix),
        kind: "path",
        statement: prefix,
        status: "active",
        authority: "declared",
        source_ref: file,
        source_sha: ctx.sha,
        method: "declared",
        certainty: "exact",
      });
    }
  }
  return out;
}

export function firstHeading(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? cleanInline(match[1]) : null;
}

export function anchorEdge(ctx: SourceContext, docId: string, nodeIdValue: string, file: string): KnowledgeEdge {
  return {
    from_id: docId,
    relation: "anchors",
    to_id: nodeIdValue,
    method: "parsed",
    certainty: "exact",
    source_ref: file,
    source_sha: ctx.sha,
    observed_at: ctx.observedAt,
  };
}
