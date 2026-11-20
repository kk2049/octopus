import { expect, it } from "vitest";
import { explicitQueryPaths, uncoveredCodePaths } from "./retrieval-coverage.js";
import { validateRetrievalPlan, type RetrievalPlanAudit } from "./retrieval-trace.js";

const plan = (paths: string[]): RetrievalPlanAudit => ({
  classifications: paths.map((value) => ({ dimension: "path", value, certainty: "exact", score: 1, reason_codes: ["explicit_path"] })),
  indexes: [], candidates: [], slots: [], context_keys: [], unknown: [], budget: { limit_chars: 4000, used_chars: 0, dropped_records: 0 }, performance: { total_ms: 1 },
});

it("retains more than four explicit paths while keeping the forty-path receipt bound", () => {
  const paths = Array.from({ length: 40 }, (_, index) => `packages/example/file${index}.ts`);
  expect(explicitQueryPaths(validateRetrievalPlan(plan(paths)))).toEqual(paths);
  expect(() => validateRetrievalPlan(plan([...paths, "packages/example/overflow.ts"]))).toThrow();
});

it("covers exact files or directory descendants, never a sibling prefix or guessed path", () => {
  const queried = explicitQueryPaths(plan(["packages/bot/src/knowledge/", "../packages", ".", "/private/file"]));
  expect(queried).toEqual(["packages/bot/src/knowledge"]);
  expect(uncoveredCodePaths(["packages/bot/src/knowledge/build.ts", "packages/bot/src/knowledge-other/build.ts", "doc/notes.md", "packages/bot/src/knowledge/build.test.ts"], queried)).toEqual(["packages/bot/src/knowledge-other/build.ts"]);
  const guessed = plan(["packages/bot"]);
  guessed.classifications[0]!.reason_codes = ["lexical"];
  expect(explicitQueryPaths(guessed)).toEqual([]);
});

it("covers tracked dot-directory files without accepting traversal or private absolute paths", () => {
  const paths = [".agents/skills/agentic-app-integration/agents/openai.yaml", ".claude/rules/frontend-stability.md"];
  const queried = explicitQueryPaths(validateRetrievalPlan(plan(paths)));
  expect(queried).toEqual(paths);
  expect(uncoveredCodePaths(paths, queried)).toEqual([]);
  for (const value of ["../.agents", "packages/../.agents", "/home/user/.agents", ".", ".."]) {
    expect(() => validateRetrievalPlan(plan([value]))).toThrow();
  }
});
