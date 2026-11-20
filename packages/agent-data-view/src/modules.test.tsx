/**
 * The four modules, driven through a real `app-data/v1` port.
 *
 * Two kinds of assertion live here, and both are about defects that would look
 * fine on screen:
 *
 *  · **Instance config really reaches the component.** The last suite mounts a
 *    real `WorkspaceShell` over a real composition with TWO instances of
 *    `data.list/v1` — 收件箱 and 归档箱 — and checks they render different rows.
 *    That is decision 7's acceptance scenario, and it is only meaningful end to
 *    end: a unit test that handed a `config` prop to a component would prove
 *    nothing about the composition → link → panel → module path.
 *  · **A malformed projection is a sentence, not a crash.** A path that is not
 *    there, a value that is not a collection, a declaration that is too wide —
 *    each renders its own explanation, because those are the three mistakes an
 *    App author actually makes and "empty list" hides all of them.
 *
 * The port is the fixture-backed one from `./harness`, a SECOND real
 * implementation of the contract, so what is exercised is the modules against a
 * port rather than the modules against the one transport they ship with.
 */

import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import type { AgentComposition, ResourceLink } from "@claude-bot/agent-module-contract";
import { COMPOSITION_SCHEMA } from "@claude-bot/agent-module-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
  type LayoutPanel,
  type WorkspaceApi,
  type WorkspacePlan,
} from "@claude-bot/agent-view-react/workspace";
import { AppDataProvider } from "./context.js";
import { createMemoryAppDataPort, type MemoryAppDataFixture } from "./harness/memory-port.js";
import {
  DATA_ACTIONS_MODULE_ID,
  DATA_DETAIL_MODULE_ID,
  DATA_FORM_MODULE_ID,
  DATA_LIST_MODULE_ID,
  DATA_RECORD_RESOURCE_KIND,
} from "./manifests.js";
import { DATA_MODULES } from "./modules.js";
import type { AppDataReply } from "./port.js";

const PROJECTION = {
  inbox: [
    {
      id: "m1",
      title: "周报草稿",
      subtitle: "lht",
      badge: "新",
      tone: "warn",
      body: "## 标题\n正文",
      evidence: "- 摘录甲",
      history: [
        { id: "h1", by: "lht", at: "09:00", text: "创建了草稿", badge: "创建", tone: "info" },
        { id: "h2", by: "ops", at: "10:00", text: "补了部署段落" },
      ],
    },
    { id: "m2", title: "部署确认", subtitle: "ops", evidence: "- 摘录乙" },
  ],
  archive: [{ id: "m0", title: "上周周报" }],
  forms: {
    add_note: {
      title: { type: "string", required: true, description: "一句话标题" },
      body: { type: "text" },
      pinned: { type: "boolean" },
      kind: { type: "string", enum: ["note", "todo"] },
    },
    mark: {
      note_id: { type: "string", label: "条目 ID", required: true },
      remark: { type: "string", label: "备注" },
    },
  },
  action_menu: [
    { action: "add_note", label: "新建便笺", fields: "forms.add_note", title: "写便笺", submit_label: "保存" },
    { action: "delete_everything", label: "危险动作", fields: "forms.add_note" },
  ],
  record_menu: [
    { action: "mark_note", label: "标记", fields: "forms.mark", title: "标记这条", submit_label: "标记", context_param: "note_id" },
    { action: "delete_everything", label: "危险动作", fields: "forms.mark" },
  ],
  section_titles: { evidence: "证据快照" },
  latest: "m1",
  inbox_notice: { tone: "warn", text: "有 1 封未读" },
  stats: { 总数: 3, 未读: 1, nested: { skip: true } },
};

function port(overrides: Partial<MemoryAppDataFixture> = {}) {
  return createMemoryAppDataPort({ projection: PROJECTION, ...overrides });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A layout API that records intents instead of owning a real reducer. */
function fakeWorkspace(panels: LayoutPanel[] = []): WorkspaceApi & { opened: ResourceLink[]; closed: string[] } {
  const opened: ResourceLink[] = [];
  const closed: string[] = [];
  return {
    state: { panels, active: {} as never, focused: null, narrow: false, drilledIn: false, seq: 0 },
    open: (resource) => {
      opened.push(resource);
      return true;
    },
    openIntent: () => true,
    focus: () => undefined,
    close: (panelId) => {
      closed.push(panelId);
    },
    report: () => undefined,
    back: () => undefined,
    opened,
    closed,
  };
}

function panel(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    panelId: "list",
    moduleId: DATA_LIST_MODULE_ID,
    slot: "navigation",
    resourceRef: null,
    resourceKind: null,
    label: "列表",
    status: "ready",
    reason: "",
    detail: "",
    config: null,
    context: null,
    ...overrides,
  };
}

const moduleOf = (id: string) => DATA_MODULES.find((entry) => entry.manifest.id === id)!.component;

function mount(fixture: ReturnType<typeof port>, children: ReactNode) {
  return render(<AppDataProvider port={fixture.port}>{children}</AppDataProvider>);
}

describe("data.list/v1", () => {
  const List = moduleOf(DATA_LIST_MODULE_ID);

  it("renders the rows its instance config points at", () => {
    const api = fakeWorkspace();
    mount(port(), <List panel={panel({ config: { source: "inbox", title: "收件箱" } })} workspace={api} />);
    expect(screen.getByText("收件箱")).toBeInTheDocument();
    expect(screen.getByText("周报草稿")).toBeInTheDocument();
    expect(screen.getByText("部署确认")).toBeInTheDocument();
    expect(screen.queryByText("上周周报")).not.toBeInTheDocument();
  });

  it("raises open-resource/v1 with the row id as the opaque ref", async () => {
    const user = userEvent.setup();
    const api = fakeWorkspace();
    mount(
      port(),
      <List panel={panel({ config: { source: "inbox", open_kind: DATA_RECORD_RESOURCE_KIND } })} workspace={api} />,
    );
    await user.click(screen.getByText("周报草稿"));
    expect(api.opened).toEqual([{ kind: DATA_RECORD_RESOURCE_KIND, ref: "m1", label: "周报草稿" }]);
  });

  it("selects locally and opens nothing when the instance declares no open_kind", async () => {
    const user = userEvent.setup();
    const api = fakeWorkspace();
    mount(port(), <List panel={panel({ config: { source: "inbox" } })} workspace={api} />);
    await user.click(screen.getByText("周报草稿"));
    expect(api.opened).toEqual([]);
    expect(screen.getByRole("button", { name: /周报草稿/ })).toHaveAttribute("aria-current", "true");
  });

  it("says which path is missing instead of rendering an empty list", () => {
    mount(port(), <List panel={panel({ config: { source: "outbox" } })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("投影路径不存在");
    expect(screen.getByRole("note")).toHaveTextContent("outbox");
  });

  it("separates an empty collection from a missing one", () => {
    const fixture = createMemoryAppDataPort({ projection: { inbox: [] } });
    mount(fixture, <List panel={panel({ config: { source: "inbox", empty_text: "收件箱是空的" } })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("收件箱是空的");
  });

  it("says it is waiting when no projection has arrived, not that the path is missing", async () => {
    const fixture = createMemoryAppDataPort({ projection: null });
    mount(fixture, <List panel={panel({ config: { source: "inbox" } })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("等待第一份投影");
    fixture.setProjection(PROJECTION);
    await waitFor(() => expect(screen.getByText("周报草稿")).toBeInTheDocument());
  });

  it("re-renders when the Host replaces the projection", async () => {
    const fixture = port();
    mount(fixture, <List panel={panel({ config: { source: "inbox" } })} workspace={fakeWorkspace()} />);
    expect(screen.getByText("周报草稿")).toBeInTheDocument();
    fixture.setProjection({ inbox: [{ id: "m9", title: "新的一条" }] });
    await waitFor(() => expect(screen.getByText("新的一条")).toBeInTheDocument());
    expect(screen.queryByText("周报草稿")).not.toBeInTheDocument();
  });

  it("highlights the projection's default_ref until the reader chooses, then keeps the choice", async () => {
    const user = userEvent.setup();
    const fixture = port();
    mount(
      fixture,
      <List panel={panel({ config: { source: "inbox", default_ref: "latest" } })} workspace={fakeWorkspace()} />,
    );
    expect(screen.getByRole("button", { name: /周报草稿/ })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByText("部署确认"));
    expect(screen.getByRole("button", { name: /部署确认/ })).toHaveAttribute("aria-current", "true");
    // A later frame that moves the default does not move an explicit choice.
    fixture.setProjection({ ...PROJECTION, latest: "m1" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /部署确认/ })).toHaveAttribute("aria-current", "true"),
    );
  });

  it("pages through a collection larger than one page instead of cutting it off", async () => {
    const user = userEvent.setup();
    const inbox = Array.from({ length: 1_234 }, (_, index) => ({ id: `r${index}`, title: `第 ${index} 条` }));
    mount(
      createMemoryAppDataPort({ projection: { inbox } }),
      <List panel={panel({ config: { source: "inbox", limit: 500 } })} workspace={fakeWorkspace()} />,
    );
    const rows = () => document.querySelectorAll("[data-dv-row]").length;
    expect(rows()).toBe(500);
    expect(document.querySelector(".dv-count")).toHaveTextContent("1234");
    expect(screen.getByRole("note")).toHaveTextContent("已显示 500 / 1234 条");
    // Query the paging note, not the accessible name/style of every data row.
    const more = () => within(screen.getByRole("note")).getByRole("button", { name: "显示更多" });
    await user.click(more());
    expect(rows()).toBe(1_000);
    await user.click(more());
    expect(rows()).toBe(1_234);
    expect(screen.getByText("第 1233 条")).toBeInTheDocument();
    expect(document.querySelector("[data-dv-more]")).toBeNull();
  });

  it("renders the projection's notice banner above the rows", () => {
    mount(
      port(),
      <List panel={panel({ config: { source: "inbox", notice: "inbox_notice" } })} workspace={fakeWorkspace()} />,
    );
    expect(screen.getByText("有 1 封未读")).toBeInTheDocument();
  });
});

describe("data.detail/v1", () => {
  const Detail = moduleOf(DATA_DETAIL_MODULE_ID);

  it("shows the record its panel was opened for, with a Markdown body", () => {
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "secondary",
          resourceRef: "m1",
          resourceKind: DATA_RECORD_RESOURCE_KIND,
          config: { source: "inbox", id_key: "id" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("lht")).toBeInTheDocument();
  });

  it("renders `source` itself as the record when no id_key is configured", () => {
    mount(
      port(),
      <Detail
        panel={panel({ moduleId: DATA_DETAIL_MODULE_ID, slot: "primary", config: { source: "stats", title: "概览" } })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.getByText("总数")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // A nested object is omitted rather than rendered as [object Object].
    expect(screen.queryByText("nested")).not.toBeInTheDocument();
  });

  it("says the record is not in the projection instead of showing another one", () => {
    mount(
      port(),
      <Detail
        panel={panel({
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "secondary",
          resourceRef: "gone",
          config: { source: "inbox", id_key: "id" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("不在当前投影里");
  });

  it("offers a close control only when it is showing something", async () => {
    const user = userEvent.setup();
    const api = fakeWorkspace();
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "secondary",
          resourceRef: "m1",
          config: { source: "inbox", id_key: "id" },
        })}
        workspace={api}
      />,
    );
    await user.click(screen.getByText("关闭"));
    expect(api.closed).toEqual(["detail"]);
  });

  it("shows the projection's default_ref record before anything was opened, and the opened ref after", () => {
    const config = { source: "inbox", id_key: "id", default_ref: "latest" };
    const first = mount(
      port(),
      <Detail
        panel={panel({ panelId: "detail", moduleId: DATA_DETAIL_MODULE_ID, slot: "primary", config })}
        workspace={fakeWorkspace()}
      />,
    );
    // No resourceRef, but the projection said `latest: "m1"` — so m1 renders.
    expect(screen.getByRole("heading", { level: 2, name: "标题" })).toBeInTheDocument();
    first.unmount();
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "m2",
          config,
        })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.getByText("部署确认")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "标题" })).not.toBeInTheDocument();
  });

  it("renders the OPENED record's sections and thread — not the newest record's", () => {
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "m2",
          config: { source: "inbox", id_key: "id", sections: "section_titles", thread_key: "history" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    // m2's own evidence, under the projection-supplied section title.
    expect(screen.getByText("证据快照")).toBeInTheDocument();
    expect(screen.getByText("摘录乙")).toBeInTheDocument();
    expect(screen.queryByText("摘录甲")).not.toBeInTheDocument();
    // m2 has no history, so no thread is drawn.
    expect(document.querySelector("[data-dv-thread]")).toBeNull();
  });

  it("draws the record's thread with authors, stamps and tones", () => {
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "m1",
          config: { source: "inbox", id_key: "id", thread_key: "history", thread_title: "历史" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.getByText("历史")).toBeInTheDocument();
    expect(screen.getByText("创建了草稿")).toBeInTheDocument();
    expect(screen.getByText("补了部署段落")).toBeInTheDocument();
    expect(screen.getByText("ops")).toBeInTheDocument();
  });

  it("pages through a thread longer than one page", async () => {
    const user = userEvent.setup();
    const history = Array.from({ length: 450 }, (_, index) => ({ id: `h${index}`, by: "x", at: String(index), text: `第 ${index} 步` }));
    mount(
      createMemoryAppDataPort({ projection: { inbox: [{ id: "m1", title: "长记录", history }] } }),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "m1",
          config: { source: "inbox", id_key: "id", thread_key: "history" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    const entries = () => document.querySelectorAll(".dv-thread-entry").length;
    expect(entries()).toBe(200);
    expect(screen.getByText(/已显示 200 \/ 450 条/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示更多" }));
    await user.click(screen.getByRole("button", { name: "显示更多" }));
    expect(entries()).toBe(450);
    expect(screen.getByText("第 449 步")).toBeInTheDocument();
    expect(document.querySelector("[data-dv-more]")).toBeNull();
  });

  it("starts another record's thread at its first page", async () => {
    const user = userEvent.setup();
    const history = (tag: string) =>
      Array.from({ length: 450 }, (_, index) => ({ id: `${tag}${index}`, by: "x", at: String(index), text: `${tag} ${index}` }));
    const fixture = createMemoryAppDataPort({
      projection: { inbox: [{ id: "m1", title: "一", history: history("a") }, { id: "m2", title: "二", history: history("b") }] },
    });
    const detail = (resourceRef: string) => (
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef,
          config: { source: "inbox", id_key: "id", thread_key: "history" },
        })}
        workspace={fakeWorkspace()}
      />
    );
    const view = render(<AppDataProvider port={fixture.port}>{detail("m1")}</AppDataProvider>);
    const entries = () => document.querySelectorAll(".dv-thread-entry").length;
    await user.click(screen.getByRole("button", { name: "显示更多" }));
    expect(entries()).toBe(400);
    view.rerender(<AppDataProvider port={fixture.port}>{detail("m2")}</AppDataProvider>);
    expect(screen.getByText("b 0")).toBeInTheDocument();
    expect(entries()).toBe(200);
    expect(screen.getByText(/已显示 200 \/ 450 条/)).toBeInTheDocument();
  });

  it("acts on the shown record: the menu form locks the record id in and proposes with it", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { mark_note: { ok: true, message: "已标记" } } });
    mount(
      fixture,
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "m2",
          config: { source: "inbox", id_key: "id", menu: "record_menu", allowed_actions: "mark_note" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    // The allowlist intersects here exactly as it does on the bottom launcher.
    expect(screen.queryByRole("button", { name: "危险动作" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "标记" }));
    const dialog = screen.getByRole("dialog", { name: "标记这条" });
    // The context parameter is a locked value, not an input to retype.
    expect(within(dialog).queryByLabelText(/条目 ID/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("m2")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "标记" }));
    await waitFor(() =>
      expect(fixture.submissions).toEqual([{ action: "mark_note", values: { note_id: "m2" } }]),
    );
  });

  it("shows no menu while the record is not there to act on", () => {
    mount(
      port(),
      <Detail
        panel={panel({
          panelId: "detail",
          moduleId: DATA_DETAIL_MODULE_ID,
          slot: "primary",
          resourceRef: "gone",
          config: { source: "inbox", id_key: "id", menu: "record_menu", allowed_actions: "mark_note" },
        })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.queryByRole("button", { name: "标记" })).not.toBeInTheDocument();
  });
});

describe("data.form/v1", () => {
  const Form = moduleOf(DATA_FORM_MODULE_ID);
  const formPanel = (config: Record<string, string | number | boolean>) =>
    panel({ panelId: "form", moduleId: DATA_FORM_MODULE_ID, slot: "secondary", config });

  it("generates its inputs from the action's parameter declaration", () => {
    mount(
      port(),
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    expect(screen.getByLabelText(/^title/)).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("body")).toBeInstanceOf(HTMLTextAreaElement);
    expect(screen.getByLabelText("pinned")).toHaveAttribute("type", "checkbox");
    expect(screen.getByLabelText("kind")).toBeInstanceOf(HTMLSelectElement);
  });

  it("proposes the configured action with what the reader typed", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: true, message: "已记下" } } });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("提交"));
    await waitFor(() => expect(fixture.submissions).toHaveLength(1));
    // An optional field left blank is left OUT, not sent as "".
    expect(fixture.submissions[0]).toEqual({ action: "add_note", values: { title: "买牛奶", pinned: "false" } });
    expect(await screen.findByText("已记下")).toBeInTheDocument();
  });

  it("shows a disabled submitting button while its action remains inflight", async () => {
    const user = userEvent.setup();
    const answer = deferred<AppDataReply>();
    const fixture = port({ actions: { add_note: () => answer.promise } });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("提交"));

    const submitting = await screen.findByRole("button", { name: "提交中…" });
    expect(submitting).toBeDisabled();
    expect(submitting.closest(".dv-form")).toHaveAttribute("aria-busy", "true");

    answer.resolve({ ok: true, message: "已记下" });
    await waitFor(() => expect(screen.getByRole("button", { name: "提交" })).toBeEnabled());
  });

  it("filters inflight state by each form instance's configured action", async () => {
    const user = userEvent.setup();
    const firstAnswer = deferred<AppDataReply>();
    const fixture = port({
      actions: {
        add_note: () => firstAnswer.promise,
        add_other: { ok: true, message: "" },
      },
    });
    const firstPanel = formPanel({ action: "add_note", fields: "forms.add_note", title: "第一份", submit_label: "提交甲" });
    const secondPanel = {
      ...formPanel({ action: "add_other", fields: "forms.add_note", title: "第二份", submit_label: "提交乙" }),
      panelId: "form-other",
    };
    mount(
      fixture,
      <>
        <Form panel={firstPanel} workspace={fakeWorkspace()} />
        <Form panel={secondPanel} workspace={fakeWorkspace()} />
      </>,
    );
    const first = screen.getByText("第一份").closest(".dv-form") as HTMLElement;
    const second = screen.getByText("第二份").closest(".dv-form") as HTMLElement;
    await user.type(within(first).getByLabelText(/^title/), "甲");
    await user.click(within(first).getByRole("button", { name: "提交甲" }));

    expect(await within(first).findByRole("button", { name: "提交中…" })).toBeDisabled();
    expect(within(second).getByRole("button", { name: "提交乙" })).toBeEnabled();
    expect(second).not.toHaveAttribute("aria-busy");

    firstAnswer.resolve({ ok: true, message: "" });
    await waitFor(() => expect(within(first).getByRole("button", { name: "提交甲" })).toBeEnabled());
  });

  it("refuses to submit while a required field is blank, and says which", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: true, message: "" } } });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.click(screen.getByText("提交"));
    expect(fixture.submissions).toHaveLength(0);
    expect(await screen.findByText("还有必填项没有填。")).toBeInTheDocument();
  });

  it("shows the Host's refusal and keeps the draft", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: false, code: "denied", message: "这次提交没有被授权。" } } });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("提交"));
    expect(await screen.findByText("这次提交没有被授权。")).toBeInTheDocument();
    expect(screen.getByLabelText(/^title/)).toHaveValue("买牛奶");
    await user.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() => expect(screen.queryByText("这次提交没有被授权。")).not.toBeInTheDocument());
    expect(fixture.port.snapshot().proposals).toHaveLength(0);
  });

  it("clears the draft after a success when the instance asked it to", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: true, message: "ok" } } });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("提交"));
    await waitFor(() => expect(screen.getByLabelText(/^title/)).toHaveValue(""));
  });

  it("keeps the draft after a success when the instance said not to reset", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: true, message: "ok" } } });
    mount(
      fixture,
      <Form
        panel={formPanel({ action: "add_note", fields: "forms.add_note", reset_on_success: false })}
        workspace={fakeWorkspace()}
      />,
    );
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("提交"));
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    expect(screen.getByLabelText(/^title/)).toHaveValue("买牛奶");
  });

  it("says the declaration is missing rather than drawing an empty form", () => {
    mount(port(), <Form panel={formPanel({ action: "add_note", fields: "forms.nope" })} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("note")).toHaveTextContent("参数声明不存在");
    expect(screen.queryByText("提交")).not.toBeInTheDocument();
  });

  it("locks a declared context parameter and merges it into the proposal", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { mark_note: { ok: true, message: "" } } });
    mount(
      fixture,
      <Form
        panel={formPanel({ action: "mark_note", fields: "forms.mark", context_param: "note_id", context_value: "m1" })}
        workspace={fakeWorkspace()}
      />,
    );
    expect(screen.queryByLabelText(/条目 ID/)).not.toBeInTheDocument();
    expect(screen.getByText("m1")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/备注/), "看过了");
    await user.click(screen.getByText("提交"));
    await waitFor(() =>
      expect(fixture.submissions).toEqual([{ action: "mark_note", values: { remark: "看过了", note_id: "m1" } }]),
    );
  });

  it("ignores a context name the declaration does not carry, and keeps the field typed", () => {
    mount(
      port(),
      <Form
        panel={formPanel({ action: "mark_note", fields: "forms.mark", context_param: "owner", context_value: "m1" })}
        workspace={fakeWorkspace()}
      />,
    );
    // No declared parameter called `owner`: nothing is injected, nothing locked.
    expect(screen.getByLabelText(/条目 ID/)).toBeInTheDocument();
    expect(document.querySelector("[data-dv-context]")).toBeNull();
  });

  it("reports a read-only port's refusal like any other", async () => {
    const user = userEvent.setup();
    const fixture = createMemoryAppDataPort({ projection: PROJECTION, readOnly: true });
    mount(
      fixture,
      <Form panel={formPanel({ action: "add_note", fields: "forms.add_note" })} workspace={fakeWorkspace()} />,
    );
    await user.type(screen.getByLabelText(/^title/), "x");
    await user.click(screen.getByText("提交"));
    expect(await screen.findByText(/只读/)).toBeInTheDocument();
  });
});

describe("data.actions/v1", () => {
  const Actions = moduleOf(DATA_ACTIONS_MODULE_ID);
  const actionsPanel = panel({
    panelId: "actions",
    moduleId: DATA_ACTIONS_MODULE_ID,
    slot: "bottom",
    label: "快捷动作",
    config: { source: "action_menu", allowed_actions: "add_note" },
  });

  it("intersects projected actions with the composition-reviewed allowlist", () => {
    mount(port(), <Actions panel={actionsPanel} workspace={fakeWorkspace()} />);
    expect(screen.getByRole("button", { name: "新建便笺" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "危险动作" })).not.toBeInTheDocument();
  });

  it("opens one generated form and proposes the selected action", async () => {
    const user = userEvent.setup();
    const fixture = port({ actions: { add_note: { ok: true, message: "已保存" } } });
    mount(fixture, <Actions panel={actionsPanel} workspace={fakeWorkspace()} />);
    await user.click(screen.getByRole("button", { name: "新建便笺" }));
    expect(screen.getByRole("dialog", { name: "写便笺" })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^title/), "动作条便笺");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fixture.submissions).toEqual([
      { action: "add_note", values: { title: "动作条便笺", pinned: "false" } },
    ]));
  });
});

// ── the acceptance scenario ─────────────────────────────────────────────────

/**
 * 收件箱 and 归档箱 out of ONE module.
 *
 * This is the property decision 7 exists for, and it is asserted end to end:
 * a composition with two `data.list/v1` instances, linked against the real
 * registry (which enforces the config declaration), mounted through the real
 * shell, rendering two different collections. Nothing in this file branches on
 * which instance is which — the composition is the only thing that differs.
 */
const TWO_LISTS: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "demo",
  instances: [
    { instance: "inbox", module: DATA_LIST_MODULE_ID, slot: "navigation", config: { source: "inbox", title: "收件箱", open_kind: DATA_RECORD_RESOURCE_KIND } },
    { instance: "archive", module: DATA_LIST_MODULE_ID, slot: "navigation", config: { source: "archive", title: "归档箱" } },
    { instance: "detail", module: DATA_DETAIL_MODULE_ID, slot: "primary", config: { source: "inbox", id_key: "id", empty_text: "选一条看看" } },
  ],
  open: [{ resource: DATA_RECORD_RESOURCE_KIND, module: DATA_DETAIL_MODULE_ID, slot: "primary", mode: "rebind" }],
};

function Workspace({ plan }: { plan: WorkspacePlan }) {
  const { state, api } = useWorkspaceLayout(plan);
  return <WorkspaceShell plan={plan} state={state} api={api} />;
}

describe("one module, two instances", () => {
  const plan = (composition = TWO_LISTS) =>
    createWorkspacePlan({ composition, registry: createModuleRegistry([...DATA_MODULES]) });

  it("renders two differently-purposed lists from one implementation", () => {
    mount(port(), <Workspace plan={plan()} />);
    expect(screen.getByText("收件箱")).toBeInTheDocument();
    expect(screen.getByText("归档箱")).toBeInTheDocument();
    expect(screen.getByText("周报草稿")).toBeInTheDocument();
    expect(screen.getByText("上周周报")).toBeInTheDocument();
  });

  it("routes a selection in one list to the detail panel through the composition", async () => {
    const user = userEvent.setup();
    mount(port(), <Workspace plan={plan()} />);
    expect(screen.getByText("选一条看看")).toBeInTheDocument();
    await user.click(screen.getByText("周报草稿"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "标题" })).toBeInTheDocument());
  });

  it("refuses a composition whose config key the module never declared", () => {
    expect(() =>
      plan({
        ...TWO_LISTS,
        instances: [
          { instance: "inbox", module: DATA_LIST_MODULE_ID, slot: "navigation", config: { sauce: "inbox" } },
        ],
        open: [],
      }),
    ).toThrow(/sauce/);
  });

  it("refuses a composition that omits a required config key", () => {
    expect(() =>
      plan({
        ...TWO_LISTS,
        instances: [{ instance: "inbox", module: DATA_LIST_MODULE_ID, slot: "navigation", config: { title: "收件箱" } }],
        open: [],
      }),
    ).toThrow(/source/);
  });

  it("refuses a composition that puts a config value of the wrong type", () => {
    expect(() =>
      plan({
        ...TWO_LISTS,
        instances: [
          { instance: "inbox", module: DATA_LIST_MODULE_ID, slot: "navigation", config: { source: "inbox", limit: "many" } },
        ],
        open: [],
      }),
    ).toThrow(/limit/);
  });
});
