import { it, expect } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { schema } from "./Editor.js";
import { seedDocument } from "../../bot/src/research-docs/seed.js";
it("opens the server seed with the real BlockNote schema and preserves plugin references", () => {
  const doc = new Y.Doc();
  Y.applyUpdate(
    doc,
    seedDocument("test", [
      { type: "heading", props: { level: 2 }, content: "研究问题" },
      { type: "paragraph", content: "中文正文与 emoji 🐙" },
      {
        type: "researchResource",
        props: { plugin: "agent", project: "p", node: "n", title: "论文助手" },
      },
      { type: "checkListItem", props: { checked: true }, content: "已审阅" },
    ]),
  );
  const editor = BlockNoteEditor.create({
    schema,
    collaboration: {
      fragment: doc.getXmlFragment("content"),
      user: { name: "alice", color: "#123456" },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  expect(editor.document).toHaveLength(4);
  expect(editor.document[0]).toMatchObject({
    type: "heading",
    props: { level: 2 },
    content: [{ text: "研究问题" }],
  });
  expect(editor.document[2]).toMatchObject({
    type: "researchResource",
    props: { project: "p", node: "n", title: "论文助手" },
  });
  expect(editor.document[3]).toMatchObject({
    type: "checkListItem",
    props: { checked: true },
  });
  editor.unmount();
  host.remove();
  doc.destroy();
});
