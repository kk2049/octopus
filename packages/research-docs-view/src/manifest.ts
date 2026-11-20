import { writeFileSync } from "node:fs";
import { DOCS_CONTRACT } from "@claude-bot/research-docs-contract";
export const manifest = {
  id: "research-docs",
  schema: 4,
  state: { scope: "shared" },
  roles: {
    owner: { max: 1 },
    editor: { max: 64 },
    viewer: { max: 64, observer: true },
  },
  actions: Object.fromEntries(
    DOCS_CONTRACT.actions.map((a) => [
      a.action,
      {
        binding: "resource",
        title: a.summary,
        description: a.summary,
        roles: ["edit_documents"].includes(a.operation ?? "")
          ? ["owner", "editor"]
          : ["owner", "editor", "viewer"],
        params: Object.fromEntries(
          Object.entries(a.params).map(([k, f]) => [
            k,
            {
              type: "string",
              max: f.maxLength ?? 160,
              required: !f.optional,
              description: f.description,
            },
          ]),
        ),
      },
    ]),
  ),
  agents: {},
  view: { page: "pages/main.yaml" },
};
if (process.argv[1]?.endsWith("manifest.ts"))
  writeFileSync(
    new URL("../app/app.yaml", import.meta.url),
    JSON.stringify(manifest, null, 2) + "\n",
  );
