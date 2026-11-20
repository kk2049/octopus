import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Content and protocol vocabulary are deliberately excluded from UI translation.
// Keep exceptions at the exact literal and path, so a new label cannot hide in a file exemption.
const content: Record<string, ReadonlySet<string>> = {
  "app/Quota.tsx": new Set(["一周", "一天"]), // Recognized wire values, not display labels.
  "pages/architecture/FrontendModuleDemo.tsx": new Set([
    "把圈圈图改成自动发现。", // Editable sample message, owned by the reader after initialization.
    "#slide[\n  = 架构会自己生长\n  * 自动发现新模块\n]", // Editable sample source.
  ]),
  "pages/knowledge/ConflictResolutionWorkspace.tsx": new Set([
    "处理意图：修改现有知识，使它符合当前有效的用户要求。",
    "处理意图：保留现有知识，并把相冲突的新要求记录为已拒绝或已取代。",
    "处理意图：关闭不再有效的现有知识，并保留来源与取代依据。",
  ]), // Prefilled annotations become record content, not UI copy.
  "pages/knowledge/ReviewView.tsx": new Set([
    "知识库歧义记录需要裁决：", "\n\n陈述：", "\n来源：", "\n歧义说明：",
    "\n\n请裁定正确读法并修改 architecture/knowledge/curated 中的该记录（certainty 改为 exact 或删除）。",
  ]), // Generated ticket body stays in its original language.
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : file.endsWith(".tsx") && !file.includes(".test.") ? [file] : [];
  });
}

it("routes authored Chinese UI literals through the language catalog across every Dashboard page", () => {
  const missing: string[] = [];
  for (const file of sourceFiles(root)) {
    const name = relative(root, file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ["uiText", "uiMessage", "t"].includes(node.expression.getText(source))) {
        // The first argument is a typed catalog key; interpolated values still get checked.
        node.arguments.slice(1).forEach(visit);
        return;
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)
        || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        && /\p{Script=Han}/u.test(node.text) && !content[name]?.has(node.text)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        missing.push(`${name}:${line} ${node.text.trim()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(missing).toEqual([]);
});
