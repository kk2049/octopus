import * as Y from "yjs";
import { createHash } from "node:crypto";
export function seedDocument(key: string, blocks: unknown[]): Uint8Array {
  const doc = new Y.Doc(),
    root = doc.getXmlFragment("content"),
    group = new Y.XmlElement("blockGroup");
  let count = 0;
  const encode = (value: unknown): Y.XmlElement => {
    if (++count > 500) throw new Error("单次导入最多 500 个块");
    const b = (value && typeof value === "object" ? value : {}) as Record<
      string,
      unknown
    >;
    const type = String(b.type ?? "paragraph");
    if (
      ![
        "paragraph",
        "heading",
        "bulletListItem",
        "numberedListItem",
        "checkListItem",
        "researchResource",
        "quote",
      ].includes(type)
    )
      throw new Error("此导入块类型不受支持：" + type);
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute(
      "id",
      "b_" +
        createHash("sha256")
          .update(key + ":" + count)
          .digest("hex")
          .slice(0, 24),
    );
    const content = new Y.XmlElement(type),
      props = (b.props && typeof b.props === "object" ? b.props : {}) as Record<
        string,
        unknown
      >;
    const defaults: Record<string, unknown> =
      type === "researchResource"
        ? {
            plugin: "file",
            project: "",
            node: "",
            card: "",
            title: "",
            summary: "",
            file: "",
            media: "",
            size: 0,
          }
        : {
            backgroundColor: "default",
            textColor: "default",
            textAlignment: "left",
            ...(type === "heading" ? { level: 2 } : {}),
            ...(type === "checkListItem" ? { checked: false } : {}),
          };
    for (const [k, v] of Object.entries({ ...defaults, ...props }))
      if (["string", "number", "boolean"].includes(typeof v))
        content.setAttribute(k, v as string);
    if (type !== "researchResource") {
      const text = new Y.XmlText();
      if (typeof b.content === "string") text.insert(0, b.content);
      else if (Array.isArray(b.content))
        for (const piece of b.content) {
          if (piece && typeof piece.text === "string")
            text.insert(text.length, piece.text, piece.styles ?? {});
        }
      content.insert(0, [text]);
    }
    container.insert(0, [content]);
    if (Array.isArray(b.children) && b.children.length) {
      const children = new Y.XmlElement("blockGroup");
      children.insert(0, b.children.map(encode));
      container.insert(1, [children]);
    }
    return container;
  };
  group.insert(
    0,
    (blocks.length ? blocks : [{ type: "paragraph", content: "" }]).map(encode),
  );
  root.insert(0, [group]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
