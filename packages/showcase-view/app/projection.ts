/**
 * 模块演示's projection: the App's event log folded into what the View reads.
 *
 * ── The rules this file lives under ─────────────────────────────────────────
 *
 * Same Compartment as `actions.ts`: no imports, no ambient anything, pure
 * function of the events. It is called fresh before every dispatch and after
 * every commit, so it must be cheap and it must never depend on when it ran.
 *
 * ── Why static declarations are projected too ───────────────────────────────
 *
 * `detailFields`, `addNoteParams` and the seed deck are not derived from any
 * event, and they are still emitted from here. That is the whole shape of a
 * declared App: a generic module is told which projection PATH to render, so
 * everything it needs — the rows, the labels, the field declaration the form is
 * generated from — has to be somewhere in the projection. `addNoteParams` is
 * the same statement `app.yaml` validates `add_note` against; keeping them in
 * step is this App's job, and the cost of getting it wrong is a form that
 * proposes a parameter the backend refuses (a bounded refusal, in the panel).
 *
 * ── Why the deck is seeded ──────────────────────────────────────────────────
 *
 * A first-open demo with an empty deck shows the outline's empty state, which
 * is a correct rendering of nothing at all and a poor demonstration. So a log
 * with no `deck_changed` in it projects two slides. It is not a write: nothing
 * is stored, and the first real edit replaces it wholesale — which is also why
 * `actions.ts` can assume `ctx.state.deck` is always a readable document.
 */

export function project(events: any[]) {
  return projectIncremental({}, events);
}

export function projectIncremental(snapshot: any, events: any[]) {
  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const source = prior.byId && typeof prior.byId === "object" && !Array.isArray(prior.byId) ? prior.byId : {};
  const byId: Record<string, any> = Object.fromEntries(
    Object.entries(source).map(([id, note]) => [id, note && typeof note === "object" ? { ...note } : note]),
  );
  const order = Object.keys(byId);
  let deck: any = prior.deck ?? null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "deck_changed") {
      if (event?.data?.deck) deck = event.data.deck;
      continue;
    }
    if (event?.type !== "note_added") continue;
    const id = String(event?.data?.id ?? "");
    if (!id) continue;
    if (!(id in byId)) order.push(id);
    byId[id] = {
      id,
      title: String(event?.data?.title ?? ""),
      body: String(event?.data?.body ?? ""),
      state: String(event?.data?.state ?? "草稿"),
      at: String(event?.at ?? ""),
      who: String(event?.by ?? ""),
    };
  }

  const inbox: any[] = [];
  const archive: any[] = [];
  // Newest first: a demo whose newest note is at the bottom of a scrolled list
  // demonstrates scrolling.
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const note = byId[order[index]];
    const row = { id: note.id, title: note.title, subtitle: note.at.slice(0, 10), badge: note.state, tone: toneOf(note.state) };
    (note.state === "已归档" ? archive : inbox).push(row);
  }

  return {
    inbox,
    archive,
    byId,
    /** Which fields the detail panel puts in its facts table, and their labels. */
    detailFields: { state: "状态", who: "作者", at: "记于" },
    /** The action's parameter declaration — the same one `app.yaml` validates. */
    addNoteParams: {
      title: { type: "string", required: true, description: "一句话标题" },
      body: { type: "text", description: "正文，支持 Markdown" },
      state: { type: "string", enum: ["草稿", "待办", "已归档"] },
    },
    stats: { 收件箱: inbox.length, 归档箱: archive.length, 幻灯页数: (deck ?? seedDeck()).slides.length },
    deck: deck ?? seedDeck(),
  };
}

function toneOf(state: string): string {
  if (state === "待办") return "warn";
  if (state === "已归档") return "ok";
  return "neutral";
}

/**
 * Five slides, one of each layout (and a closing cover), so the first open of
 * the demo shows the visual editor doing everything it can do: the film strip
 * has four different thumbnails, the canvas has every region type to click,
 * and the image slide has the property strip.
 */
function seedDeck() {
  return {
    schema: "deck-model/v1",
    title: "模块演示",
    theme: "light",
    slides: [
      { id: "s1", layout: "title", title: "模块演示", subtitle: "笔记 + 幻灯，全部由可复用模块组成" },
      {
        id: "s2",
        layout: "bullets",
        title: "这一版展示什么",
        bullets: [
          "一个 data.list/v1，两个实例：收件箱与归档箱",
          "open 规则就是路由策略，模块不改布局",
          "缩略图与画布是同一套渲染，只差尺寸",
          "点击画布上的文字就地编辑，一次手势一条命令",
        ],
      },
      {
        id: "s3",
        layout: "two-column",
        title: "表单编辑 → 可视化编辑",
        left: ["属性面板逐字段填写", "显式保存：一次 N 条命令", "保存到一半是常态"],
        right: ["在画布上点哪改哪", "回车或失焦即提交一条命令", "缩略图立即跟上"],
      },
      {
        id: "s4",
        layout: "image-ref",
        title: "图片是一个不透明引用",
        image: { ref: "workspace:screenshots/dashboard.png", alt: "仪表盘截图" },
        caption: "解析引用是可信侧 render provider 的事，画布只诚实地画一个占位框。",
      },
      { id: "s5", layout: "title", title: "谢谢", subtitle: "试试画布工具条上的深浅色主题切换" },
    ],
  };
}
