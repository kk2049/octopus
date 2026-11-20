import { describe, expect, it } from "vitest";
import type { AppManifest, PageDef } from "../manifest.js";
import { renderFeishuCard } from "./feishu.js";

const app: AppManifest = {
  app: "demo",
  title: "演示",
  scope: "per-user",
  dir: "/nowhere",
  actions: {
    add_note: {
      name: "add_note",
      title: "记一条",
      predicate: "owner",
      params: { text: { type: "string", required: true, description: "内容" } },
    },
    wipe: { name: "wipe", title: "清空", predicate: "admin" },
    ping: { name: "ping", predicate: "any" },
  },
  agents: { page: { name: "page", adapter: "openai-loop" } },
  pages: {},
  feishuCards: [],
  deadlines: [],
  flows: [],
};

const page: PageDef = {
  name: "digest",
  title: "摘要",
  layout: [["head"], ["body"], ["items"], ["buttons"], ["note"], ["chatpane"]],
  slots: {
    head: { widget: "heading", props: { title: "今日摘要" } },
    body: { widget: "markdown", bind: "view.summary" },
    items: { widget: "list", bind: "view.items" },
    buttons: {
      widget: "actions",
      props: { items: [{ action: "add_note" }, { action: "wipe", label: "清空全部" }, { action: "ping" }] },
    },
    note: { widget: "form", props: { action: "add_note" } },
    chatpane: { widget: "agent-chat", agent: "page" },
  },
};

const view = {
  summary: "一切正常",
  items: [
    { id: "1", title: "任务甲", subtitle: "进行中", tone: "warn" },
    { id: "2", title: "任务乙", badge: "done", tone: "ok" },
  ],
};

describe("renderFeishuCard golden conventions", () => {
  const card = renderFeishuCard(app, page, view, {
    link: "https://x/a/demo",
    allowed: (a) => a !== "wipe", // viewer is owner but not admin
  }) as any;

  it("header.title is a plain_text OBJECT, never a bare string", () => {
    expect(card.header.title).toEqual({ tag: "plain_text", content: "摘要" });
  });

  it("prose renders as div+lark_md, never tag:markdown", () => {
    const tags = card.elements.map((e: any) => e.tag);
    expect(tags).not.toContain("markdown");
    const body = card.elements.find((e: any) => e.text?.content?.includes("一切正常"));
    expect(body.tag).toBe("div");
    expect(body.text.tag).toBe("lark_md");
  });

  it("list items carry tone marks and subtitles", () => {
    const list = card.elements.find((e: any) => e.text?.content?.includes("任务甲"));
    expect(list.text.content).toContain("🟡 **任务甲** — 进行中");
    expect(list.text.content).toContain("🟢 **任务乙** `done`");
  });

  it("buttons are filtered by the SAME allowed() the web face and agent use", () => {
    const action = card.elements.find((e: any) => e.tag === "action");
    const labels = action.actions.map((b: any) => b.text.content);
    expect(labels).toContain("记一条");
    expect(labels).toContain("ping");
    expect(labels).not.toContain("清空全部"); // admin-only, viewer refused
    for (const b of action.actions) {
      expect(b.text.tag).toBe("plain_text");
      expect(b.value.app).toBe("demo");
    }
  });

  it("forms contain only inputs + submit button", () => {
    const form = card.elements.find((e: any) => e.tag === "form");
    expect(form.name).toBe("add_note");
    const tags = new Set(form.elements.map((e: any) => e.tag));
    expect([...tags].sort()).toEqual(["button", "input"]);
    const submit = form.elements.find((e: any) => e.tag === "button");
    expect(submit.action_type).toBe("form_submit");
  });

  it("rich widgets degrade to a web deep link, not silence", () => {
    const degrade = card.elements.find((e: any) => e.text?.content?.includes("富组件"));
    expect(degrade.text.content).toContain("https://x/a/demo");
  });

  it("form for a refused action disappears entirely", () => {
    const noForm = renderFeishuCard(app, page, view, { allowed: () => false }) as any;
    expect(noForm.elements.find((e: any) => e.tag === "form")).toBeUndefined();
    expect(noForm.elements.find((e: any) => e.tag === "action")).toBeUndefined();
  });
});
