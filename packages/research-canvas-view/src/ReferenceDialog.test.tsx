import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GraphSpec, ResearchNode } from "@claude-bot/research-canvas-contract";
import { ReferenceDialog } from "./ReferenceDialog.js";
import type { Call } from "./client.js";
const graph: GraphSpec = { nodes: Object.fromEntries(["P", "A", "B", "X"].map(id => [id, { ref: "note:" + id, label: id }])), edges: { pa: { from: "P", to: "A", relation: "contains" }, pb: { from: "P", to: "B", relation: "contains" }, ax: { from: "A", to: "X", relation: "contains" } } };
it("pastes the original entity under the common parent in one graph action and retries its exact request", async () => {
  let fail = true;
  const call = vi.fn(async (action: string) => {
    if (action === "graph_read") return { snapshot: "snapshot", graph };
    if (fail) throw new Error("暂时断开");
    return { status: "merged", conflicts: [], issues: [] };
  });
  const close = vi.fn(), changed = vi.fn();
  render(<ReferenceDialog node={{ id: "X", title: "共用证据" } as ResearchNode} scope={{ id: "B", title: "方向 B" } as ResearchNode} call={call as Call} close={close} changed={changed}/>);
  expect(screen.getByRole("radio", { name: "放到共同上层（默认）" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "引入引用" }));
  await screen.findByRole("alert");
  const sent = call.mock.calls.find(([action]) => action === "graph_apply") as unknown as [string, { request: string; yaml: string }];
  const planned = JSON.parse(sent[1].yaml);
  expect(planned.nodes).toEqual(graph.nodes);
  expect(Object.values(planned.edges)).toContainEqual({ from: "P", to: "X", relation: "contains" });
  expect(Object.values(planned.edges)).toContainEqual({ from: "B", to: "X", relation: "references" });
  fail = false; fireEvent.click(screen.getByRole("button", { name: "重试引入" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(call.mock.calls.at(-1)).toEqual(sent);
  expect(call.mock.calls.map(([action]) => action)).toEqual(["graph_read", "graph_apply", "graph_apply"]);
});
