import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { resourceFromNode } from "./plugins.js";
export interface ImportedPage {
  key: string;
  title: string;
  parent?: string;
  seed: unknown[];
}
export function importProject(
  project: string,
  nodes: ResearchNode[],
): ImportedPage[] {
  const active = nodes.filter((n) => !n.archived),
    byId = new Map(active.map((n) => [n.id, n])),
    childIds = new Set(
      active.flatMap((n) =>
        Array.isArray(n.data.members) ? (n.data.members as string[]) : [],
      ),
    );
  const roots = active.filter((n) => !childIds.has(n.id)),
    root = roots.find((n) => n.type === "goal") ?? roots[0];
  const groups = (
    root && Array.isArray(root.data.members)
      ? root.data.members
          .map((id) => byId.get(String(id)))
          .filter((x): x is ResearchNode => Boolean(x))
      : roots
  ).filter((n) => n.id !== root?.id);
  const sections = groups.length
    ? groups.slice(0, 24)
    : active.filter((n) => n.type === "folder").slice(0, 24);
  const heading = (text: string) => ({
    type: "heading",
    props: { level: 2 },
    content: text,
  });
  const paragraph = (content: string) => ({ type: "paragraph", content });
  const home: ImportedPage = {
    key: "home",
    title: root?.title.replace(/\s*[·•|｜-]?\s*GOAL\s*$/i, "") || "研究项目",
    seed: [
      paragraph(root?.summary || "在这里整理研究目标、材料与下一步工作。"),
      heading("从这里开始"),
      paragraph(
        "这份工作空间把研究组织成可以阅读和协作编辑的文档。源文件、Agent 和录音通过元件连接，仍在原项目中工作。",
      ),
      ...sections.flatMap((n) => [
        heading(n.title),
        paragraph(n.summary || "打开对应子文档查看资料、讨论与任务。"),
      ]),
      heading("工作约定"),
      {
        type: "checkListItem",
        props: { checked: false },
        content: "先明确要回答的问题，再补齐论证与证据。",
      },
      {
        type: "checkListItem",
        props: { checked: false },
        content: "审阅实验结果和来源，再记录采纳结论。",
      },
      paragraph(
        "导入于 " +
          new Date().toISOString().slice(0, 10) +
          "。文字是可编辑副本；资料元件保持原始引用，不会自动启动任务。",
      ),
    ],
  };
  const visited = new Set<string>();
  const descendants = (node: ResearchNode): ResearchNode[] => {
    const result: ResearchNode[] = [];
    const queue = [node];
    const seen = new Set<string>();
    while (queue.length && result.length < 100) {
      const n = queue.shift()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      result.push(n);
      visited.add(n.id);
      for (const id of Array.isArray(n.data.members) ? n.data.members : []) {
        const child = byId.get(String(id));
        if (child) queue.push(child);
      }
    }
    return result;
  };
  const pages = sections.map((n) => ({
    key: n.id,
    title: n.title,
    parent: "home",
    seed: [
      paragraph(n.summary || "整理此方向的论点、证据和下一步。"),
      ...(["goal", "folder"].includes(n.type) ? [] : [resourceFromNode(project, n)]),
      ...descendants(n)
        .filter((c) => c.id !== n.id)
        .flatMap((c) =>
          ["agent", "audio", "file", "adapter"].includes(c.type)
            ? [resourceFromNode(project, c)]
            : [
                heading(c.title),
                ...(c.summary ? [paragraph(c.summary)] : []),
                resourceFromNode(project, c),
              ],
        ),
      { type: "paragraph", content: "" },
    ],
  }));
  const resources = active
    .filter(
      (n) => !visited.has(n.id) && ["agent", "file", "audio"].includes(n.type),
    )
    .slice(0, 100);
  if (resources.length)
    pages.push({
      key: "resources",
      title: "资料与 Agent",
      parent: "home",
      seed: resources.map((n) => resourceFromNode(project, n)),
    });
  return [home, ...pages];
}

/** Keep the complete submitted plan, not just its ID: the source may change before retry. */
export async function importIntoDocuments(
  call: import("@claude-bot/research-docs-contract").Call,
  project: string,
  nodes: ResearchNode[],
  key: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
): Promise<string> {
  const saved = storage.getItem(key);
  const journal: { id: string; plan: ImportedPage[] } = saved
    ? JSON.parse(saved)
    : { id: crypto.randomUUID(), plan: importProject(project, nodes) };
  if (!journal.id || !Array.isArray(journal.plan)) throw new Error("导入进度无效，请保留原草稿后重新建立导入。");
  // Refuse before creating pages if durable retry identity cannot be recorded.
  storage.setItem(key, JSON.stringify(journal));
  const parents = new Map<string, string>();
  let first = "";
  for (const [index, item] of journal.plan.entries()) {
    const page = await call<import("@claude-bot/research-docs-contract").PageInfo>("create", {
      request: "import:" + journal.id + ":" + index,
      title: item.title,
      parent: item.parent ? parents.get(item.parent) : undefined,
      seed: item.seed,
    });
    parents.set(item.key, page.id);
    first ||= page.id;
  }
  storage.removeItem(key);
  return first;
}
