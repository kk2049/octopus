/**
 * The deployment's demonstration documents, seeded at composition.
 *
 * ── Why seeding lives here and not in a migration ──────────────────────────
 *
 * A CRDT document's "empty" is observable (the projected text has no
 * characters), and a merge is idempotent — so the honest seed is "if the
 * document has no content yet, merge the starter content in", run at every
 * boot. A crash between boots re-runs it and converges to the same document;
 * a document somebody has typed into is never touched, because the emptiness
 * check fails the moment it holds one character.
 *
 * The documents are SHARED across accounts on purpose: `documentsFor` hands
 * every owner the same descriptors, which is what makes two people editing
 * 《团队便签》 an actual collaboration rather than two private copies. The
 * text field is `"body"` — the same field `agent-crdt-view`'s NOTE_FIELD
 * names, fixed by convention so two builds agree without asking.
 */

import * as Y from "yjs";
import type { CrdtDocumentStore } from "./store.js";
import type { CrdtDocumentDescriptor } from "./types.js";

/** The one Y.Text a note lives in. Must match agent-crdt-view's NOTE_FIELD. */
const NOTE_FIELD = "body";

export interface SeedDocument extends CrdtDocumentDescriptor {
  /** Markdown source merged in only while the document is still empty. */
  readonly content: string;
}

const GUIDE = `# 协作文档使用说明

欢迎！这是一份**多人实时协作**的文档：它存放在服务器上，你和其他成员打开的是同一份内容，编辑会自动合并，不会互相覆盖。

## 怎么打开

- 在「会话+」左侧的 **文档** 列表里点击任意一篇，就在右侧打开。
- 同一篇文档可以被多个人、多个标签页同时打开。

## 怎么编辑

1. 点面板右上角的 **编辑**，正文变成可输入的 Markdown 源。
2. 用工具栏插入格式：**加粗**、*斜体*、~~删除线~~、标题、列表、引用、代码块、分割线。
3. 点 **预览** 随时查看渲染后的效果；再点 **编辑** 继续写。
4. 你的改动会自动推送；别人有改动时会自动拉取合并（也可以点「同步」手动拉一次）。

## 授权说明

- 文档内容在你同意应用的权限申请后即可阅读。
- **每次打开应用后的第一次编辑**需要你在待批准列表确认一次；批准只对本次打开有效。

## 试一试

约一位同事同时打开《团队便签》，两个人同时在同一段里输入——
两边的文字会自动合并，这就是 CRDT 在工作。

> 本文档本身也可以编辑：欢迎把你的使用心得补充在下面。

---

*这篇说明由部署方预置；清空正文不会删除文档。*
`;

const NOTES = `# 团队便签

一块共享的草稿区。会议要点、待办、链接，随手记在这里。

- [ ] 把想到的事情记下来
`;

/** Every document this deployment seeds, in a stable display order. */
export const SEED_DOCUMENTS: readonly SeedDocument[] = Object.freeze([
  Object.freeze({ id: "welcome", label: "协作文档使用说明", content: GUIDE }),
  Object.freeze({ id: "team-notes", label: "团队便签", content: NOTES }),
]);

/** The descriptors without their seed content, for `documentsFor`. */
export const SEED_DESCRIPTORS: readonly CrdtDocumentDescriptor[] = Object.freeze(
  SEED_DOCUMENTS.map(({ id, label }) => Object.freeze({ id, label })),
);

/**
 * Merge each document's starter content, if and only if it is still empty.
 *
 * Returns the ids that were actually seeded, for the boot log. A store that
 * refuses (disk trouble) is logged by the caller through that same return
 * shape — seeding failure must not stop the process, because the panel with
 * an unseeded document is strictly more useful than no panel.
 */
export function seedCrdtDocuments(
  store: CrdtDocumentStore,
  documents: readonly SeedDocument[] = SEED_DOCUMENTS,
): string[] {
  const seeded: string[] = [];
  for (const document of documents) {
    if (!document.content) continue;
    const read = store.read(document.id);
    if (!read.ok) continue;
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, read.value.update);
      if (probe.getText(NOTE_FIELD).length > 0) continue;
    } finally {
      probe.destroy();
    }
    const draft = new Y.Doc();
    try {
      draft.getText(NOTE_FIELD).insert(0, document.content);
      const applied = store.applyUpdate(document.id, Y.encodeStateAsUpdate(draft), "seed");
      if (applied.ok) seeded.push(document.id);
    } finally {
      draft.destroy();
    }
  }
  return seeded;
}
