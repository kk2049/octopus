import { describe, expect, it } from "vitest";
import { MERMAID_MAX_LENGTH, renderMermaidImage } from "./mermaid.js";

// Transcribed from ticket #536's attached screenshot, including its cycle.
export const TICKET_FLOWCHART = `flowchart LR
  A[当前变更与工作依赖] --> B[识别需要补充的判断]
  C[历史工单与参与证据] --> B
  B --> D[提供适用的历史材料]
  B --> E[推荐能补充判断的人]
  D --> F[记录结论与依据]
  E --> F
  F --> G[更新契约、测试和参与证据]
  G --> C`;

describe("Mermaid image rendering", () => {
  it("renders the reported seven-node, eight-edge Chinese flowchart as a self-contained SVG image", () => {
    const result = renderMermaidImage(TICKET_FLOWCHART);
    expect(result).toHaveProperty("src");
    if (!("src" in result)) throw new Error(result.error);
    expect(result.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(result.src.split(",")[1]!);
    expect(svg.match(/class="node"/g)).toHaveLength(7);
    expect(svg.match(/class="edge"/g)).toHaveLength(8);
    expect(svg).toContain("当前变更与工作依赖");
    expect(svg).toContain("更新契约、测试和参与证据");
    expect(svg).not.toMatch(/@import|fonts\.googleapis|<script|<foreignObject/);
  });

  it("renders direction, decisions, labelled edges and subgraphs", () => {
    const result = renderMermaidImage("graph TD\n subgraph work [工作]\n A{批准?} -->|是| B[完成]\n end");
    expect(result).toHaveProperty("src");
    if ("src" in result) expect(decodeURIComponent(result.src)).toContain("工作");
  });

  it.each(["", "flowchart SIDEWAYS\n A --> B", "flowchart LR", "pie\n 甲: 2"])(
    "returns a bounded refusal for invalid or unsupported source: %s",
    (source) => expect(renderMermaidImage(source)).toEqual({ error: "invalid" }),
  );

  it("refuses oversized source and graphs before layout", () => {
    expect(renderMermaidImage("x".repeat(MERMAID_MAX_LENGTH + 1))).toEqual({ error: "too_large" });
    const nodes = Array.from({ length: 201 }, (_, index) => `N${index}[node]`).join("\n");
    expect(renderMermaidImage(`flowchart LR\n${nodes}`)).toEqual({ error: "too_large" });
    expect(renderMermaidImage("\n".repeat(401))).toEqual({ error: "too_large" });
  });

  it("renders an oversized diagram whole once the reader explicitly forces it", () => {
    const nodes = Array.from({ length: 201 }, (_, index) => `N${index}[node ${index}]`);
    const edges = nodes.slice(1).map((_, index) => `N${index} --> N${index + 1}`);
    const source = `flowchart TD\n${[...nodes, ...edges].join("\n")}`;
    expect(source.split("\n").length).toBeGreaterThan(400);
    expect(renderMermaidImage(source)).toEqual({ error: "too_large" });
    const forced = renderMermaidImage(source, { force: true });
    if (!("src" in forced)) throw new Error(forced.error);
    const svg = decodeURIComponent(forced.src.split(",")[1]!);
    expect(svg.match(/class="node"/g)).toHaveLength(201);
    expect(svg).toContain("node 200");
    // Forcing lifts only the work bounds; invalid source still fails closed.
    expect(renderMermaidImage("x".repeat(MERMAID_MAX_LENGTH + 1), { force: true })).toEqual({ error: "invalid" });
  });
});
