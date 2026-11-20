/**
 * The three modules, driven through a real composition, a real shell and a real
 * `app-data/v1` port whose backend really applies the commands.
 *
 * ── Why the harness applies the commands instead of returning `{ok: true}` ──
 *
 * Because the claim being checked is a LOOP: the film strip raises an intent,
 * the canvas proposes commands, the backend validates them with the contract's
 * own reader, the projection changes, and both panels re-render from it. A stub
 * that answered "ok" would pass for a canvas that sent the wrong index, the
 * wrong slide id, or nothing at all.
 *
 * The backend is ~40 lines and none of them know what a bullet is; that is the
 * other thing this file demonstrates.
 *
 * ── The commit model under test ─────────────────────────────────────────────
 *
 * In-place editing: a click opens an inline input, Enter or blur commits, and
 * one gesture is one command (two for a reorder). There is no save button, so
 * the assertions here pin the GESTURE → COMMAND mapping against the wire.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { COMPOSITION_SCHEMA, type AgentComposition } from "@claude-bot/agent-module-contract";
import { AppDataProvider, type AppDataReply } from "@claude-bot/agent-data-view";
import { createMemoryAppDataPort } from "@claude-bot/agent-data-view/harness";
import { DECK_MODEL_SCHEMA, DECK_THEME_COLOURS } from "@claude-bot/deck-model-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
  type WorkspacePlan,
} from "@claude-bot/agent-view-react/workspace";
import { createMemoryDeckApp, type MemoryDeckApp } from "./harness/index.js";
import {
  DECK_OUTLINE_MODULE_ID,
  DECK_SLIDE_MODULE_ID,
  DECK_SLIDE_RESOURCE_KIND,
  DECK_TYPST_MODULE_ID,
  DECK_TYPST_RESOURCE_KIND,
} from "./manifests.js";
import { DECK_MODULES } from "./modules.js";

const DECK = {
  schema: DECK_MODEL_SCHEMA,
  title: "Q3 汇报",
  theme: "light",
  slides: [
    // Deliberately NOT "封面": that is also the layout's label, and a fixture
    // whose title collides with its badge makes every query here ambiguous.
    { id: "cover", layout: "title", title: "开场", subtitle: "工程" },
    { id: "agenda", layout: "bullets", title: "议程", bullets: ["进度", "风险"] },
    { id: "shot", layout: "image-ref", title: "截图", image: { ref: "blob:1", alt: "面板" }, caption: "上线" },
  ],
};

/**
 * A deck App: a film strip that navigates, a canvas that answers for a slide,
 * and a Typst panel that answers for the export. Three instances, one `source`,
 * one `command_action` — the whole App, as data.
 */
const COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "deck-demo",
  instances: [
    {
      instance: "outline",
      module: DECK_OUTLINE_MODULE_ID,
      slot: "navigation",
      config: { source: "deck", title: "幻灯片", command_action: "deck_command" },
    },
    {
      instance: "editor",
      module: DECK_SLIDE_MODULE_ID,
      slot: "primary",
      config: { source: "deck", title: "编辑", command_action: "deck_command" },
    },
    { instance: "typst", module: DECK_TYPST_MODULE_ID, slot: "secondary", config: { source: "deck" } },
  ],
  open: [
    { resource: DECK_SLIDE_RESOURCE_KIND, module: DECK_SLIDE_MODULE_ID, slot: "primary" },
    { resource: DECK_TYPST_RESOURCE_KIND, module: DECK_TYPST_MODULE_ID, slot: "secondary" },
  ],
};

function Workspace({ plan }: { plan: WorkspacePlan }) {
  const { state, api } = useWorkspaceLayout(plan);
  return <WorkspaceShell plan={plan} state={state} api={api} />;
}

function planOf(composition: AgentComposition = COMPOSITION): WorkspacePlan {
  return createWorkspacePlan({ composition, registry: createModuleRegistry([...DECK_MODULES]) });
}

function mount(app: MemoryDeckApp, children: ReactNode) {
  return render(<AppDataProvider port={app.port}>{children}</AppDataProvider>);
}

function app(overrides: Parameters<typeof createMemoryDeckApp>[0] = {}): MemoryDeckApp {
  return createMemoryDeckApp({ deck: DECK, ...overrides });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The film-strip panel, so a query cannot accidentally match the canvas. */
function outline(): HTMLElement {
  return document.querySelector(".dkv-outline") as HTMLElement;
}

function editor(): HTMLElement {
  return document.querySelector(".dkv-editor") as HTMLElement;
}

describe("deck.outline/v1 — the film strip", () => {
  it("renders every slide as a real 16:9 thumbnail of its own layout, in order", () => {
    mount(app(), <Workspace plan={planOf()} />);
    // `.dkv-slide`, not `listitem`: a thumbnail of a bullets slide contains a
    // real <ul>, so the rendered strip has MORE list items than rows.
    const rows = [...outline().querySelectorAll<HTMLElement>(".dkv-slide")];
    expect(rows.map((row) => row.getAttribute("data-dkv-slide"))).toEqual(["cover", "agenda", "shot"]);
    // Each thumbnail is the SAME surface component the canvas renders — the
    // layout attribute and the slide's own words, not a title line and a badge.
    const surfaces = rows.map((row) => row.querySelector(".dkv-thumb .dkv-surface")!);
    expect(surfaces.map((surface) => surface.getAttribute("data-dkv-surface"))).toEqual([
      "title",
      "bullets",
      "image-ref",
    ]);
    expect(surfaces[0]).toHaveTextContent("开场");
    expect(surfaces[0]).toHaveTextContent("工程");
    expect(surfaces[1]).toHaveTextContent("进度");
    expect(surfaces[2]).toHaveTextContent("图片占位");
    expect(surfaces[2]).toHaveTextContent("上线");
  });

  it("paints thumbnails with the DOCUMENT's theme colours, from the contract", () => {
    const fixture = app({ deck: { ...DECK, theme: "dark" } });
    mount(fixture, <Workspace plan={planOf()} />);
    const surface = outline().querySelector(".dkv-thumb .dkv-surface") as HTMLElement;
    expect(surface.getAttribute("data-dkv-theme")).toBe("dark");
    // The same six values the Typst preamble prints — not a stylesheet's copy.
    expect(surface.style.getPropertyValue("--dkv-page")).toBe(DECK_THEME_COLOURS.dark.page);
    expect(surface.style.getPropertyValue("--dkv-ink")).toBe(DECK_THEME_COLOURS.dark.ink);
  });

  it("shows its existing disabled controls as syncing while the configured action is inflight", async () => {
    const user = userEvent.setup();
    const answer = deferred<AppDataReply>();
    const fixture = createMemoryAppDataPort({
      projection: { deck: DECK },
      actions: { deck_command: () => answer.promise },
    });
    render(
      <AppDataProvider port={fixture.port}>
        <Workspace plan={planOf()} />
      </AppDataProvider>,
    );

    await user.click(within(outline()).getByLabelText("下移第 1 页"));
    expect(await within(outline()).findByRole("status")).toHaveTextContent("同步中…");
    expect(outline()).toHaveAttribute("aria-busy", "true");
    expect(within(outline()).getByRole("button", { name: "＋图片页" })).toBeDisabled();

    answer.resolve({ ok: true, message: "" });
    await waitFor(() => expect(within(outline()).queryByRole("status")).not.toBeInTheDocument());
    expect(outline()).not.toHaveAttribute("aria-busy");
  });

  it("names an untitled slide 未命名 in the row's accessible name", () => {
    const fixture = app({
      deck: { ...DECK, slides: [...DECK.slides, { id: "blank", layout: "bullets", bullets: ["只有要点"] }] },
    });
    mount(fixture, <Workspace plan={planOf()} />);
    expect(within(outline()).getByLabelText("第 4 页：（未命名）")).toBeInTheDocument();
    // …while the thumbnail still shows the slide's own content.
    const row = outline().querySelector('[data-dkv-slide="blank"]') as HTMLElement;
    expect(row).toHaveTextContent("只有要点");
  });

  it("reorders a slide with one command and shows the new order", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByLabelText("下移第 1 页"));
    await waitFor(() => expect(fixture.deck().slides.map((slide) => slide.id)).toEqual(["agenda", "cover", "shot"]));
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]!.values).toEqual({ op: "move_slide", slide: "cover", index: "1" });
  });

  it("does not offer to move the first slide up or the last one down", () => {
    mount(app(), <Workspace plan={planOf()} />);
    expect(within(outline()).getByLabelText("上移第 1 页")).toBeDisabled();
    expect(within(outline()).getByLabelText("下移第 3 页")).toBeDisabled();
  });

  it("adds a slide of the layout asked for and opens it", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("＋双栏"));
    await waitFor(() => expect(fixture.deck().slides).toHaveLength(4));
    expect(fixture.deck().slides[3]).toMatchObject({ id: "s1", layout: "two-column", title: "" });
    // Selecting it is what the reader wanted; it happens after the command
    // landed, never optimistically.
    await waitFor(() => expect(editor().getAttribute("data-dkv-slide")).toBe("s1"));
  });

  it("takes two clicks to delete, and says the client cannot undo it", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByLabelText("删除第 2 页"));
    expect(fixture.deck().slides).toHaveLength(3);
    await user.click(within(outline()).getByText("确认删除"));
    await waitFor(() => expect(fixture.deck().slides.map((slide) => slide.id)).toEqual(["cover", "shot"]));
    expect(await within(outline()).findByText(/服务端的撤销记录/)).toBeInTheDocument();
  });

  it("lets an armed delete be cancelled", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByLabelText("删除第 2 页"));
    await user.click(within(outline()).getByText("取消"));
    expect(within(outline()).queryByText("确认删除")).not.toBeInTheDocument();
    expect(fixture.submissions).toHaveLength(0);
  });

  it("renders the same strip with no controls when the instance declares no action", () => {
    const readOnly: AgentComposition = {
      ...COMPOSITION,
      instances: COMPOSITION.instances.map((instance) =>
        instance.instance === "outline" ? { ...instance, config: { source: "deck", title: "幻灯片" } } : instance,
      ),
    };
    mount(app(), <Workspace plan={planOf(readOnly)} />);
    expect(within(outline()).getByText("议程")).toBeInTheDocument();
    expect(within(outline()).queryByLabelText("删除第 2 页")).not.toBeInTheDocument();
    expect(within(outline()).getByText("只读")).toBeInTheDocument();
  });

  it("shows the empty state when the deck has no slides", () => {
    const broken = createMemoryDeckApp({ deck: DECK });
    broken.setDeck({ schema: DECK_MODEL_SCHEMA, title: "", theme: "light", slides: [] });
    mount(broken, <Workspace plan={planOf()} />);
    expect(within(outline()).getByText(/还没有任何一页/)).toBeInTheDocument();
  });

  it("says which path is wrong rather than rendering an empty deck", () => {
    const wrongPath: AgentComposition = {
      ...COMPOSITION,
      instances: COMPOSITION.instances.map((instance) =>
        instance.instance === "outline" ? { ...instance, config: { ...instance.config, source: "nope" } } : instance,
      ),
    };
    mount(app(), <Workspace plan={planOf(wrongPath)} />);
    expect(within(outline()).getByRole("note")).toHaveTextContent("nope");
  });
});

describe("deck.slide/v1 — the canvas", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(within(outline()).getByText(name));
    await waitFor(() => expect(editor()).toBeTruthy());
  };

  it("shows the first slide before any selection — a deck opens at page one", () => {
    mount(app(), <Workspace plan={planOf()} />);
    expect(editor().getAttribute("data-dkv-slide")).toBe("cover");
    expect(within(editor()).getByText("第 1 / 3 页")).toBeInTheDocument();
  });

  it("opens the slide the strip selected, through the composition's open rule", async () => {
    const user = userEvent.setup();
    mount(app(), <Workspace plan={planOf()} />);
    await open(user, "议程");
    expect(editor().getAttribute("data-dkv-slide")).toBe("agenda");
    expect(editor().getAttribute("data-dkv-layout")).toBe("bullets");
    expect(within(editor()).getByText("第 2 / 3 页")).toBeInTheDocument();
    // The canvas shows the slide as a slide: real text on a surface, not a form.
    const surface = editor().querySelector(".dkv-canvas .dkv-surface") as HTMLElement;
    expect(surface.getAttribute("data-dkv-surface")).toBe("bullets");
    expect(surface).toHaveTextContent("议程");
    expect(surface).toHaveTextContent("进度");
  });

  it("draws exactly the regions the layout has", async () => {
    const user = userEvent.setup();
    mount(app(), <Workspace plan={planOf()} />);
    await open(user, "开场");
    expect(within(editor()).getByLabelText("编辑副标题")).toBeInTheDocument();
    expect(within(editor()).queryByLabelText("编辑图注")).not.toBeInTheDocument();
    await open(user, "截图");
    expect(within(editor()).getByLabelText("编辑图注")).toBeInTheDocument();
    // The two fields with no place ON the slide keep a property strip below it.
    expect(within(editor()).getByLabelText("图片引用")).toHaveValue("blob:1");
    expect(within(editor()).getByLabelText("替代文字")).toHaveValue("面板");
    expect(within(editor()).queryByLabelText("编辑副标题")).not.toBeInTheDocument();
  });

  it("commits a title edit on Enter as exactly one set_text", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("编辑标题"));
    const input = within(editor()).getByLabelText("标题");
    await user.clear(input);
    await user.type(input, "新议程{Enter}");
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ title: "新议程" }));
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]!.values).toEqual({ op: "set_text", slide: "agenda", field: "title", value: "新议程" });
    // The canvas now shows the projection's answer, back in display mode.
    expect(within(editor()).getByText("新议程")).toBeInTheDocument();
  });

  it("commits a bullet edit on blur, addressed by index", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("编辑要点 第 2 条"));
    const input = within(editor()).getByLabelText("要点 第 2 条");
    await user.clear(input);
    await user.type(input, "新风险");
    await user.tab();
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["进度", "新风险"] }));
    expect(fixture.submissions[0]!.values).toEqual({
      op: "set_text",
      slide: "agenda",
      field: "bullets",
      index: "1",
      value: "新风险",
    });
  });

  it("abandons an edit on Escape and proposes nothing", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("编辑标题"));
    await user.type(within(editor()).getByLabelText("标题"), "改{Escape}");
    expect(within(editor()).getByText("议程")).toBeInTheDocument();
    expect(fixture.submissions).toHaveLength(0);
  });

  it("leaving a region unchanged proposes nothing", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("编辑标题"));
    await user.keyboard("{Enter}");
    expect(fixture.submissions).toHaveLength(0);
  });

  it("adds a bullet from the canvas as one insert_item at the end", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByText("＋ 添加要点"));
    await user.type(within(editor()).getByLabelText("添加要点"), "新增项");
    await user.tab();
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["进度", "风险", "新增项"] }));
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]!.values).toEqual({
      op: "insert_item",
      slide: "agenda",
      field: "bullets",
      index: "2",
      value: "新增项",
    });
  });

  it("keeps the add-item input open on Enter, because bullets are written in runs", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByText("＋ 添加要点"));
    await user.type(within(editor()).getByLabelText("添加要点"), "第三条{Enter}");
    await user.type(within(editor()).getByLabelText("添加要点"), "第四条{Enter}");
    await waitFor(() =>
      expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["进度", "风险", "第三条", "第四条"] }),
    );
  });

  it("removes a bullet as one remove_item", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("删除 要点 第 1 条"));
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["风险"] }));
    expect(fixture.submissions).toHaveLength(1);
    expect(fixture.submissions[0]!.values).toEqual({ op: "remove_item", slide: "agenda", field: "bullets", index: "0" });
  });

  it("reorders a bullet as an adjacent swap: two overwrites, never a hole", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("下移 要点 第 1 条"));
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["风险", "进度"] }));
    expect(fixture.submissions.map((submission) => submission.values)).toEqual([
      { op: "set_text", slide: "agenda", field: "bullets", index: "0", value: "风险" },
      { op: "set_text", slide: "agenda", field: "bullets", index: "1", value: "进度" },
    ]);
  });

  it("adds a slide from the toolbar and moves the canvas onto it", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByText("＋图片页"));
    await waitFor(() => expect(fixture.deck().slides).toHaveLength(4));
    expect(fixture.deck().slides[3]).toMatchObject({ id: "s1", layout: "image-ref" });
    await waitFor(() => expect(editor().getAttribute("data-dkv-slide")).toBe("s1"));
  });

  it("switches the deck theme from the toolbar with one set_theme", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(editor()).getByText("浅色主题"));
    await waitFor(() => expect(fixture.deck().theme).toBe("dark"));
    expect(fixture.submissions[0]!.values).toEqual({ op: "set_theme", value: "dark" });
    // The whole product follows: toolbar state, canvas colours, thumbnails.
    expect(await within(editor()).findByText("深色主题")).toBeInTheDocument();
    const canvasSurface = editor().querySelector(".dkv-canvas .dkv-surface") as HTMLElement;
    expect(canvasSurface.getAttribute("data-dkv-theme")).toBe("dark");
    await waitFor(() =>
      expect(outline().querySelector(".dkv-thumb .dkv-surface")!.getAttribute("data-dkv-theme")).toBe("dark"),
    );
  });

  it("refuses a malformed image ref before proposing anything", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "截图");
    await user.type(within(editor()).getByLabelText("图片引用"), " 有空格");
    await user.tab();
    expect(await within(editor()).findByText(/不含空格/)).toBeInTheDocument();
    expect(fixture.submissions).toHaveLength(0);
  });

  it("commits a valid image ref from the property strip", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "截图");
    const input = within(editor()).getByLabelText("图片引用");
    await user.clear(input);
    await user.type(input, "blob:2{Enter}");
    await waitFor(() => expect(fixture.deck().slides[2]).toMatchObject({ image: { ref: "blob:2", alt: "面板" } }));
    expect(fixture.submissions[0]!.values).toEqual({
      op: "set_text",
      slide: "shot",
      field: "image.ref",
      value: "blob:2",
    });
  });

  it("reports both facts when the second half of a swap is refused", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    // Refuse the SECOND command only. The first really lands in the deck, so
    // the two numbers the canvas reports are two independently checkable facts.
    const original = fixture.port.submit;
    let seen = 0;
    fixture.port.submit = async (action, values) => {
      seen += 1;
      if (seen === 2) return { ok: false, code: "denied", message: "这一步没有被授权。" };
      return original(action, values);
    };
    await user.click(within(editor()).getByLabelText("下移 要点 第 1 条"));
    await waitFor(() => expect(screen.getByText(/前 1 条已写入/)).toBeInTheDocument());
    expect(screen.getByText(/第 2 条被拒绝/)).toBeInTheDocument();
    // The half-applied swap is a duplicated line, not a hole.
    expect(fixture.deck().slides[1]).toMatchObject({ bullets: ["风险", "风险"] });
  });

  it("says when a commit landed on top of somebody else's edit", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    await user.click(within(editor()).getByLabelText("编辑标题"));
    const input = within(editor()).getByLabelText("标题");
    await user.clear(input);
    await user.type(input, "我的版本");
    // Another writer lands while the input is open. No expected-digest exists
    // on this channel, so the commit below overwrites — detected, not prevented.
    fixture.setDeck({
      ...fixture.deck(),
      slides: fixture.deck().slides.map((slide) => (slide.id === "agenda" ? { ...slide, title: "别人改的" } : slide)),
    });
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/在别处被改过/)).toBeInTheDocument();
    await waitFor(() => expect(fixture.deck().slides[1]).toMatchObject({ title: "我的版本" }));
  });

  it("says so rather than rendering an empty canvas when the slide is gone", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await open(user, "议程");
    fixture.setDeck({ ...fixture.deck(), slides: fixture.deck().slides.filter((slide) => slide.id !== "agenda") });
    // Queried from `screen`, not from a captured node: the guard branch returns
    // a different `<section>` shape, so React replaces the element rather than
    // updating it and any node held from before is detached.
    expect(await screen.findByText(/已经不在 deck 里/)).toBeInTheDocument();
  });

  it("renders an inert surface when the instance declares no action", () => {
    const readOnly: AgentComposition = {
      ...COMPOSITION,
      instances: COMPOSITION.instances.map((instance) =>
        instance.instance === "editor" ? { ...instance, config: { source: "deck", title: "编辑" } } : instance,
      ),
    };
    mount(app(), <Workspace plan={planOf(readOnly)} />);
    // The slide still renders — as plain text, with no click-to-edit control,
    // no toolbar inserts, no add-item row.
    const surface = editor().querySelector(".dkv-canvas .dkv-surface") as HTMLElement;
    expect(surface).toHaveTextContent("开场");
    expect(surface.querySelectorAll("button")).toHaveLength(0);
    expect(within(editor()).queryByText("＋封面")).not.toBeInTheDocument();
    expect(within(editor()).getByText(/这个视图是只读的/)).toBeInTheDocument();
  });

  it("shows the Host's refusal verbatim", async () => {
    const user = userEvent.setup();
    const fixture = app({ readOnly: true });
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("议程"));
    await waitFor(() => expect(editor().getAttribute("data-dkv-slide")).toBe("agenda"));
    await user.click(within(editor()).getByLabelText("编辑标题"));
    await user.type(within(editor()).getByLabelText("标题"), "改{Enter}");
    expect(await screen.findByText(/这份 deck 是只读的/)).toBeInTheDocument();
  });
});

describe("deck.typst/v1", () => {
  it("opens as a panel from the strip, and renders the generated source", async () => {
    const user = userEvent.setup();
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    const source = await screen.findByText(/#set page\(paper: "presentation-16-9"/);
    expect(source).toBeInTheDocument();
    expect(source.textContent).toContain('#deck-heading("议程")');
    expect(source.textContent).toContain("// slide cover · title");
  });

  it("says the deck is the source of truth, and offers no way to edit the Typst", async () => {
    const user = userEvent.setup();
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    const panel = document.querySelector(".dkv-typst") as HTMLElement;
    expect(within(panel).getByText(/deck 才是可编辑的事实源/)).toBeInTheDocument();
    // §15.5's forbidden shape, asserted structurally: there is nowhere to type.
    expect(panel.querySelectorAll("textarea")).toHaveLength(0);
    expect(panel.querySelectorAll("input")).toHaveLength(0);
    expect(panel.querySelector("[contenteditable]")).toBeNull();
  });

  it("follows an edit: the export is derived, not cached", async () => {
    const user = userEvent.setup();
    const fixture = app();
    mount(fixture, <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    await screen.findByText(/#deck-heading\("议程"\)/);
    await user.click(within(outline()).getByText("议程"));
    await user.click(within(editor()).getByLabelText("编辑标题"));
    const input = within(editor()).getByLabelText("标题");
    await user.clear(input);
    await user.type(input, "新议程{Enter}");
    await waitFor(() =>
      expect((document.querySelector("[data-dkv-typst]") as HTMLElement).textContent).toContain('#deck-heading("新议程")'),
    );
  });

  it("selects the whole source without touching a clipboard", async () => {
    const user = userEvent.setup();
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    await user.click(await screen.findByText("全选"));
    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(selection.toString().length).toBeGreaterThan(0);
  });

  /**
   * The measured order: `document.execCommand("copy")` is what works in an
   * opaque-origin `allow-scripts` frame, and `navigator.clipboard.writeText`
   * is present and blocked by permissions policy. jsdom has neither for real,
   * so both branches are arranged here.
   *
   * `userEvent.setup()` INSTALLS a clipboard stub on `navigator`, so every stub
   * below has to come after it — otherwise the tool, not the code, decides which
   * branch runs.
   */
  it("prefers the synchronous command, because that is the one this frame can use", async () => {
    const user = userEvent.setup();
    const execCommand = vi.fn().mockReturnValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    await user.click(await screen.findByText("复制"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByText("已复制到剪贴板。")).toBeInTheDocument();
    Reflect.deleteProperty(document, "execCommand");
  });

  it("falls back to the async clipboard and reports its refusal as a refusal", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    await user.click(await screen.findByText("复制"));
    expect(writeText).toHaveBeenCalledOnce();
    // Two things in one sentence: what happened, and what to do instead.
    expect(await screen.findByText(/浏览器拒绝了/)).toBeInTheDocument();
    expect(screen.getByText(/源码已经全选/)).toBeInTheDocument();
  });

  it("says so when neither route exists, having selected the source anyway", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: undefined });
    mount(app(), <Workspace plan={planOf()} />);
    await user.click(within(outline()).getByText("导出 Typst"));
    await user.click(await screen.findByText("复制"));
    expect(await screen.findByText(/这个画面不能写剪贴板/)).toBeInTheDocument();
    expect(window.getSelection()!.toString().length).toBeGreaterThan(0);
  });

  it("offers no download, because a sandboxed frame cannot start one", () => {
    mount(app(), <Workspace plan={planOf()} />);
    const panel = document.querySelector(".dkv-typst") as HTMLElement;
    expect(panel.querySelector("a[download]")).toBeNull();
    expect(panel.textContent).not.toContain("下载");
  });
});

describe("the whole loop", () => {
  it("edits a deck end to end without a single deck-shaped line in the App", async () => {
    const user = userEvent.setup();
    const fixture = app({ deck: { schema: DECK_MODEL_SCHEMA, title: "空", theme: "light", slides: [] } });
    mount(fixture, <Workspace plan={planOf()} />);

    expect(within(editor()).getByText(/还没有任何一页/)).toBeInTheDocument();
    await user.click(within(outline()).getByText("＋要点页"));
    await waitFor(() => expect(editor().getAttribute("data-dkv-slide")).toBe("s1"));

    await user.click(within(editor()).getByLabelText("编辑标题"));
    await user.type(within(editor()).getByLabelText("标题"), "第一页{Enter}");
    await user.click(within(editor()).getByText("＋ 添加要点"));
    await user.type(within(editor()).getByLabelText("添加要点"), "一件事{Enter}");

    await waitFor(() =>
      expect(fixture.deck().slides[0]).toMatchObject({ id: "s1", layout: "bullets", title: "第一页", bullets: ["一件事"] }),
    );

    // Every accepted command left an inverse on the App's undo log, which is
    // where undo has to live: the inverse of a removal cannot cross the wire.
    expect(fixture.undoDepth()).toBe(3);
    expect(fixture.undo()).toBe(true);
    expect(fixture.deck().slides[0]).toMatchObject({ bullets: [] });
  });
});
