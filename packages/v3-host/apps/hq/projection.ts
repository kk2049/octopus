/**
 * hq projection — fold(events) → view. Pure by contract: no fs, no net, no
 * engine imports. Edits to this file take effect on the next dispatch/SSE
 * push without a restart (warm tier).
 *
 * The view's shape IS the page contract: every field here is something a
 * widget binds to (list/kv/timeline/markdown/banner). Ported semantics from
 * the live HQ: four closure buckets, tri-tense timeline with overdue plans
 * pulled into "today". Not ported in v0 (recorded honestly): segments,
 * corrections overlay, evidence citations.
 */

interface Ev {
  seq: number;
  at: string;
  by: string;
  type: string;
  data: Record<string, unknown>;
}

interface Item {
  id: string;
  project: string;
  bucket: string;
  text: string;
  closed?: boolean;
}

const BUCKETS = ["block", "run", "verify", "todo"] as const;
const isoDate = (s: string): string => s.slice(0, 10);

export function project(events: readonly Ev[]): Record<string, unknown> {
  const projects = new Map<string, { slug: string; title: string; one: string; ddl?: string }>();
  const items = new Map<string, Item>();
  const plans: Array<{ id: string; project: string; at?: string; text: string }> = [];
  const notes: Array<{ id: string; project?: string; text: string; at: string; by: string }> = [];
  const past: Array<{ text: string; at: string }> = [];
  /** correction overlay: id → replacement text. Originals stay in the log verbatim. */
  const corrections = new Map<string, string>();
  let itemCount = 0;
  let planCount = 0;
  let noteCount = 0;
  let segments = 0;
  let doc = "";

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "project_created":
        projects.set(String(d.slug), {
          slug: String(d.slug),
          title: String(d.title ?? d.slug),
          one: String(d.one_liner ?? ""),
          ddl: typeof d.ddl === "string" && d.ddl ? d.ddl : undefined,
        });
        past.push({ text: `建项目「${String(d.title ?? d.slug)}」`, at: e.at });
        break;
      case "item_added": {
        itemCount++;
        items.set(String(d.id), {
          id: String(d.id),
          project: String(d.project),
          bucket: String(d.bucket),
          text: String(d.text),
        });
        break;
      }
      case "item_status": {
        const it = items.get(String(d.id));
        if (!it) break;
        if (d.closed === true) {
          it.closed = true;
          past.push({ text: `闭环：${it.text}`, at: e.at });
        } else if (typeof d.bucket === "string") {
          it.bucket = d.bucket;
        }
        break;
      }
      case "plan_added":
        planCount++;
        plans.push({
          id: String(d.id),
          project: String(d.project),
          at: typeof d.at === "string" && d.at ? d.at : undefined,
          text: String(d.text),
        });
        break;
      case "note_added":
        noteCount++;
        notes.push({
          id: `nt-${noteCount}`,
          project: typeof d.project === "string" && d.project ? d.project : undefined,
          text: String(d.text),
          at: e.at,
          by: e.by,
        });
        break;
      case "doc_edited":
        doc = String(d.text ?? "");
        break;
      case "correction":
        corrections.set(String(d.id), String(d.text));
        break;
      case "segment_close": {
        segments++;
        const carried = Array.isArray(d.carried) ? d.carried.length : 0;
        past.push({ text: `—— 段落收束（未闭环 ${carried} 项结转新段）`, at: e.at });
        break;
      }
      default:
        break; // agent_inbox etc. are plumbing, not workbench truth
    }
  }

  const fixed = (id: string, text: string): string => (corrections.has(id) ? `✎ ${corrections.get(id)}` : text);

  const open = [...items.values()].filter((i) => !i.closed);
  const buckets: Record<string, Array<Record<string, unknown>>> = {};
  for (const b of BUCKETS) {
    buckets[b] = open
      .filter((i) => i.bucket === b)
      .map((i) => ({
        id: i.id,
        title: fixed(i.id, i.text),
        subtitle: projects.get(i.project)?.title ?? i.project,
        badge: i.id,
        tone: b === "block" ? "err" : b === "verify" ? "warn" : b === "run" ? "ok" : undefined,
      }));
  }

  const today = isoDate(new Date().toISOString());
  const dated = (p: { at?: string }): boolean => !!p.at && /^\d{4}-\d{2}-\d{2}$/.test(p.at);
  const projTitle = (slug: string): string => projects.get(slug)?.title ?? slug;

  const timeline = {
    past: past
      .slice(-8)
      .reverse()
      .map((d, i) => ({ id: `past-${i}`, at: isoDate(d.at).slice(5), text: d.text, tone: "ok" })),
    today: plans
      .filter((p) => dated(p) && p.at! <= today)
      .map((p) => ({
        id: p.id,
        at: p.at === today ? "今天" : `逾期 ${p.at!.slice(5)}`,
        text: `${fixed(p.id, p.text)}（${projTitle(p.project)}）`,
        tone: p.at! < today ? "err" : "warn",
      })),
    future: plans
      .filter((p) => !dated(p) || p.at! > today)
      .map((p) => ({
        id: p.id,
        at: dated(p) ? p.at!.slice(5) : (p.at ?? "待定"),
        text: `${fixed(p.id, p.text)}（${projTitle(p.project)}）`,
      })),
  };

  const overdue = timeline.today.filter((t) => t.tone === "err").length;
  const soonDdl = (ddl?: string): "warn" | "err" | undefined => {
    if (!ddl) return undefined;
    const days = Math.floor((Date.parse(ddl) - Date.now()) / 86_400_000);
    return days < 0 ? "err" : days <= 7 ? "warn" : undefined;
  };

  const projectList = [...projects.values()].map((p) => {
    const n = open.filter((i) => i.project === p.slug).length;
    return {
      id: p.slug,
      title: p.title,
      subtitle: p.one + (p.ddl ? ` · ddl ${p.ddl}` : ""),
      badge: `${n} 开`,
      tone: soonDdl(p.ddl),
    };
  });

  const stats = {
    项目: projects.size,
    未闭环: open.length,
    卡住: buckets.block.length,
    待验收: buckets.verify.length,
    逾期计划: overdue,
    段: segments + 1,
  };

  const prose = notes
    .slice(-10)
    .reverse()
    .map((n) => {
      const head = `**${isoDate(n.at).slice(5)}** \`${n.id}\`${n.project ? `（${projTitle(n.project)}）` : ""} `;
      return corrections.has(n.id) ? `${head}~~${n.text}~~ ✎ ${corrections.get(n.id)}` : head + n.text;
    })
    .join("\n\n");

  const digest =
    [...projects.values()]
      .map((p) => {
        const mine = open.filter((i) => i.project === p.slug);
        const parts = BUCKETS.map((b) => {
          const n = mine.filter((i) => i.bucket === b).length;
          return n ? `${b} ${n}` : null;
        }).filter(Boolean);
        return `- **${p.title}**：${parts.join(" · ") || "全部闭环 ✅"}`;
      })
      .join("\n") + (overdue ? `\n\n🔴 有 ${overdue} 条逾期计划，见时间线「今天」段。` : "");

  const banner = overdue
    ? { tone: overdue > 1 ? "err" : "warn", text: `有 ${overdue} 条逾期计划挤在「今天」——先清逾期再开新坑。` }
    : null;

  return {
    projects: projectList,
    projectIds: [...projects.keys()],
    openIds: open.map((i) => i.id),
    correctables: [...open.map((i) => i.id), ...plans.map((p) => p.id), ...notes.map((n) => n.id)],
    doc: doc || "# 研究备忘\n\n（点击开始记录——你和页面秘书写的是同一份文档，改动历史全部留在事件日志里。）",
    buckets,
    timeline,
    stats,
    prose,
    digest,
    banner,
    counts: { items: itemCount, plans: planCount },
  };
}
