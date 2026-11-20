/**
 * Every source text the Dashboard can hand to `uiText` is a UI_COPY key.
 *
 * Literal calls are typed against the catalog, so the compiler sees most
 * misses. This test covers what the key type cannot: `uiText` handed to a
 * shared component as a plain `(text: string) => string` callback, and keys
 * that reach a call through a cast. That gap once blanked the ticket page in
 * every non-Chinese language: a Codex queued receipt rendered a sentence the
 * table did not have. `uiText` now falls back instead of throwing; this test
 * is what keeps the fallback from ever being the normal path.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { UI_COPY } from "./ui-copy.js";
import { uiText } from "./ui-text.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../../..");

/**
 * Components outside this package that receive `uiText` as their text
 * callback, by JSX tag. Each passes every authored literal through that
 * callback, so every Han literal in the file must be catalogued.
 */
const CALLBACK_HOSTS: Readonly<Record<string, string>> = {
  SendReceipt: "packages/chat-ui-commons/src/SendReceipt.tsx",
};

const HAN = /\p{Script=Han}/u;
const has = (key: string) => Object.prototype.hasOwnProperty.call(UI_COPY, key);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : /\.tsx?$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Literal keys a first argument can evaluate to, or null when it is not literal. */
function literalKeys(node: ts.Expression): string[] | null {
  if (ts.isParenthesizedExpression(node)) return literalKeys(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalKeys(node.whenTrue);
    const whenFalse = literalKeys(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

it("catalogues every literal key, refuses casts, and only passes uiText to registered hosts", () => {
  const problems: string[] = [];
  for (const file of sourceFiles(root)) {
    const name = relative(root, file);
    if (name === "i18n/ui-text.ts") continue;
    const source = parse(file);
    const at = (node: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ["uiText", "uiMessage"].includes(node.expression.getText(source))) {
        const first = node.arguments[0];
        if (first && (ts.isAsExpression(first) || ts.isTypeAssertionExpression(first))) {
          problems.push(`${at(first)} casts a key into ${node.expression.getText(source)}; pass a catalogued literal`);
        }
        for (const key of (first && literalKeys(first)) ?? []) {
          if (!has(key)) problems.push(`${at(first!)} ${JSON.stringify(key)} is not in UI_COPY`);
        }
      } else if (ts.isIdentifier(node) && node.text === "uiText") {
        const parent = node.parent;
        const called = ts.isCallExpression(parent) && parent.expression === node;
        const imported = ts.isImportSpecifier(parent);
        if (!called && !imported) {
          const attribute = ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) ? parent.parent : null;
          const element = attribute?.parent.parent;
          const tag = element && (ts.isJsxSelfClosingElement(element) || ts.isJsxOpeningElement(element))
            ? element.tagName.getText(source) : "";
          if (!CALLBACK_HOSTS[tag]) {
            problems.push(`${at(node)} passes uiText as a value; register the receiving component in CALLBACK_HOSTS`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [tag, path] of Object.entries(CALLBACK_HOSTS)) {
    const source = parse(resolve(repo, path));
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && HAN.test(node.text) && !has(node.text)) {
        problems.push(`${tag} (${path}) renders ${JSON.stringify(node.text)}, which is not in UI_COPY`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(problems).toEqual([]);
});

it("translates the Codex queued receipt that used to blank non-Chinese ticket pages", () => {
  expect(uiText("已排队，将作为下一轮处理", {}, "en")).toBe("Queued; it will run as the next turn");
  expect(uiText("已排队，将作为下一轮处理", {}, "ja-JP")).not.toMatch(/将作为/u);
  expect(uiText("已排队，将作为下一轮处理", {}, "nan-TW")).toBe("已排隊，將作為下一輪處理");
});
