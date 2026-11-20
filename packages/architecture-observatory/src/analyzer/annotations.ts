import ts from "typescript";

import type { ArchitectureAnnotation, SourceLocation } from "../shared/model.js";

export interface AnnotationParseResult {
  annotations: ArchitectureAnnotation[];
  errors: Array<{ line: number; message: string }>;
}

const ATTRIBUTE = /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+))/g;

function unescapeQuoted(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1");
}

export function parseAttributeText(text: string): { attributes: Record<string, string>; remainder: string } {
  const attributes: Record<string, string> = {};
  const consumed: Array<[number, number]> = [];
  for (const match of text.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes[match[1]] = unescapeQuoted(value);
    consumed.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  let remainder = "";
  let cursor = 0;
  for (const [start, end] of consumed) {
    remainder += text.slice(cursor, start);
    cursor = end;
  }
  remainder += text.slice(cursor);
  return { attributes, remainder: remainder.trim() };
}

export function parseArchitectureAnnotations(
  sourceText: string,
  filePath: string,
  excerpt?: (line: number) => string[],
): AnnotationParseResult {
  const annotations: ArchitectureAnnotation[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  // A free-running scanner can mistake regular-expression or template contents
  // for comments because those tokens need parser context. Comment trivia ranges
  // attached to the parsed AST provide that context and never inspect strings.
  const ranges = new Map<number, ts.CommentRange>();
  const collectRanges = (found: ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node): void => {
    collectRanges(ts.getLeadingCommentRanges(sourceText, node.getFullStart()));
    collectRanges(ts.getTrailingCommentRanges(sourceText, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  collectRanges(ts.getLeadingCommentRanges(sourceText, 0));

  for (const range of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    const tokenStart = range.pos;
    const comment = sourceText.slice(tokenStart, range.end);
    const firstLine = sourceFile.getLineAndCharacterOfPosition(tokenStart).line + 1;
    for (const [offset, commentLine] of comment.split(/\r?\n/).entries()) {
      const marker = commentLine.indexOf("@architecture");
      if (marker < 0) continue;
      const line = firstLine + offset;
      const raw = commentLine
        .slice(marker + "@architecture".length)
        .replace(/\*\/$/, "")
        .trim();
      const { attributes, remainder } = parseAttributeText(raw);
      if (Object.keys(attributes).length === 0) {
        errors.push({ line, message: "annotation has no key=value attributes" });
        continue;
      }
      if (remainder) {
        errors.push({ line, message: `cannot parse annotation fragment: ${remainder}` });
        continue;
      }
      if (!attributes.flow && !attributes.enforces && !attributes.verifies && !attributes.boundary && !attributes.data) {
        errors.push({ line, message: "annotation needs flow, enforces, verifies, boundary or data" });
        continue;
      }
      if (attributes.verifies && !/(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(filePath)) {
        errors.push({ line, message: "verifies is only allowed in test/spec source" });
        continue;
      }
      const source: SourceLocation = {
        path: filePath,
        line,
        excerpt: excerpt?.(line),
      };
      annotations.push({ id: `${filePath}:${line}:${annotations.length + 1}`, attributes, source });
    }
  }
  return { annotations, errors };
}
