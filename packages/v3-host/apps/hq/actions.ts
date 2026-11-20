/**
 * hq actions — the app's ONLY write path, shared verbatim by page buttons,
 * HTTP callers and the page agent's tools (law #1). Handlers are pure: read
 * ctx.state (the projection), return events; the engine stamps authorship
 * and appends atomically. Throwing here is the validation UX — the message
 * reaches the human as a toast and the agent as a tool error, same words.
 */

interface Ctx {
  state: {
    projects: Array<{ id: string; title: string }>;
    buckets: Record<string, Array<{ id: string }>>;
    openIds: string[];
    correctables: string[];
    counts: { items: number; plans: number };
  };
  now: string;
}
type P = Record<string, unknown>;
type Out = { events: Array<{ type: string; data: unknown }>; reply?: string };

function slugify(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "p"
  );
}

function needProject(ctx: Ctx, slug: string): void {
  if (!ctx.state.projects.some((p) => p.id === slug)) {
    const have = ctx.state.projects.map((p) => p.id).join("、") || "（还没有项目）";
    throw new Error(`没有项目「${slug}」。现有：${have}`);
  }
}

function findOpen(ctx: Ctx, id: string): string {
  for (const [bucket, items] of Object.entries(ctx.state.buckets)) {
    if (items.some((i) => i.id === id)) return bucket;
  }
  throw new Error(`没有未闭环的条目「${id}」`);
}

export function add_project(ctx: Ctx, p: P): Out {
  const title = String(p.title);
  const slug = slugify(title);
  if (ctx.state.projects.some((x) => x.id === slug)) throw new Error(`项目「${slug}」已存在`);
  return {
    events: [
      {
        type: "project_created",
        data: { slug, title, one_liner: p.one_liner ?? "", ddl: p.ddl ?? "" },
      },
    ],
    reply: `项目「${title}」已建（${slug}）`,
  };
}

export function add_item(ctx: Ctx, p: P): Out {
  needProject(ctx, String(p.project));
  const id = `it-${ctx.state.counts.items + 1}`;
  return {
    events: [{ type: "item_added", data: { id, project: p.project, bucket: p.bucket, text: p.text } }],
    reply: `已记入 ${p.bucket}（${id}）`,
  };
}

export function close_item(ctx: Ctx, p: P): Out {
  const id = String(p.id);
  findOpen(ctx, id);
  return {
    events: [{ type: "item_status", data: { id, closed: true } }],
    reply: `已闭环 ${id}`,
  };
}

export function move_item(ctx: Ctx, p: P): Out {
  const id = String(p.id);
  const from = findOpen(ctx, id);
  if (from === p.bucket) throw new Error(`「${id}」已经在 ${from} 格里`);
  return {
    events: [{ type: "item_status", data: { id, bucket: p.bucket } }],
    reply: `${id}：${from} → ${p.bucket}`,
  };
}

export function add_plan(ctx: Ctx, p: P): Out {
  needProject(ctx, String(p.project));
  const id = `pl-${ctx.state.counts.plans + 1}`;
  return {
    events: [{ type: "plan_added", data: { id, project: p.project, at: p.at ?? "", text: p.text } }],
    reply: `计划已记（${id}）`,
  };
}

export function add_note(ctx: Ctx, p: P): Out {
  if (p.project) needProject(ctx, String(p.project));
  return {
    events: [{ type: "note_added", data: { project: p.project ?? "", text: p.text } }],
    reply: "已记一笔",
  };
}

export function correct(ctx: Ctx, p: P): Out {
  const id = String(p.id);
  if (!ctx.state.correctables.includes(id)) {
    throw new Error(`「${id}」不在可更正列表里。可更正：${ctx.state.correctables.join("、") || "（无）"}`);
  }
  return {
    events: [{ type: "correction", data: { id, text: p.text } }],
    reply: `已更正 ${id}（原文保留在日志里）`,
  };
}

export function close_segment(ctx: Ctx): Out {
  return {
    events: [{ type: "segment_close", data: { carried: ctx.state.openIds } }],
    reply: `本段收束，${ctx.state.openIds.length} 个未闭环项结转新段`,
  };
}

export function edit_doc(_ctx: Ctx, p: P): Out {
  return {
    events: [{ type: "doc_edited", data: { text: p.text } }],
    reply: "文档已保存（历史版本都在日志里）",
  };
}

export function refresh(): Out {
  return {
    events: [
      {
        type: "agent_inbox",
        data: { to: "page", text: "用户请求巡检：读一遍当前工作台状态，总结四格与逾期计划，给出下一步建议。" },
      },
    ],
    reply: "已通知页面秘书巡检",
  };
}
