import { writeFileSync } from "node:fs";
import { CANVAS_CONTRACT } from "@claude-bot/research-canvas-contract";

export const manifest = {
  id: "research-v2",
  schema: 4,
  state: { scope: "shared" },
  roles: {
    owner: { max: 1 },
    editor: { max: 64 },
    researcher: { max: 64 },
    viewer: { max: 64, observer: true },
  },
  actions: Object.fromEntries(
    CANVAS_CONTRACT.actions.map((action) => {
      const name = action.action;
      return [
        name,
        {
          binding: "resource",
          title: action.summary,
          description: action.summary,
          roles:
            action.operation === "manage_resources"
              ? ["owner"]
              : action.operation === "edit_graph"
                ? ["owner", "editor", "researcher"]
                : ["run_agent", "send_message"].includes(action.operation ?? "")
                  ? ["owner", "editor", "researcher"]
                  : ["owner", "editor", "researcher", "viewer"],
          ...([
            "resource_bind",
            "proposal_resolve",
            "subscription_save",
            "session_respond",
          ].includes(name)
            ? { human_only: true }
            : {}),
          params: Object.fromEntries(
            Object.entries(action.params).map(([key, field]) => [
              key,
              {
                type: "string",
                max: field.maxLength ?? 32,
                required: !field.optional,
                description: field.description,
                ...(field.enum ? { enum: field.enum } : {}),
              },
            ]),
          ),
        },
      ];
    }),
  ),
  agents: {
    mcp: {
      adapter: "openai-loop",
      role: "researcher",
      prompt:
        "先用 graph_read 获取 YAML，保留 snapshot 并编辑后用 graph_apply 提交。ref_describe 发现资源工具；坐标用 layout_read、layout_patch（按字段异步合并）、layout_arrange（异步排版）；layout_move 保留严格版本检查。正文和插件内部文件独立编辑。重试沿用 request，读取冲突回执中的有效值。",
    },
  },
  view: { page: "pages/main.yaml" },
};
// JSON is a YAML subset. The generated file is deterministic and reviewable.
if (process.argv[1]?.endsWith("manifest.ts"))
  writeFileSync(
    new URL("../app/app.yaml", import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
