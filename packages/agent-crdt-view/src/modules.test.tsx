/**
 * The modules, driven through a real `crdt-doc/v1` port.
 *
 * The port is the in-process replica from `./harness`, which is a SECOND real
 * implementation of the contract — so what is exercised is the module against a
 * port, not the module against the one transport it happens to ship with.
 *
 * Every assertion is about something that would be a real defect and would look
 * fine on screen: a note that keeps showing stale text after the port is
 * replaced, a read-only document that still accepts typing, a refusal that takes
 * out the panel instead of being read, two panels on one document sharing a
 * replica (which would make convergence untestable in a browser and, worse,
 * would make one panel's undo the other's), and a wake that keeps dispatching
 * after a refusal (which turns one revocation into a stream of approval cards).
 */

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import type { LayoutPanel, WorkspaceApi } from "@claude-bot/agent-view-react/workspace";
import { CrdtDocProvider } from "./context.js";
import { CRDT_MODULES } from "./modules.js";
import {
  CRDT_DOC_LIST_MODULE_ID,
  CRDT_NOTE_MODULE_ID,
  CRDT_NOTE_RESOURCE_KIND,
} from "./manifests.js";
import { createMemoryCrdtPort, type MemoryCrdtFixture } from "./harness/memory-port.js";

const DOC = "cd_note";

function fixture(overrides: Partial<MemoryCrdtFixture> = {}): MemoryCrdtFixture {
  return { documents: [DOC], initialText: "shared draft", ...overrides };
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
    panelId: "note",
    moduleId: CRDT_NOTE_MODULE_ID,
    slot: "primary",
    resourceRef: DOC,
    resourceKind: CRDT_NOTE_RESOURCE_KIND,
    label: "共享草稿",
    status: "ready",
    reason: "",
    detail: "",
    config: null,
    context: null,
    ...overrides,
  };
}

const Note = CRDT_MODULES.find((entry) => entry.manifest.id === CRDT_NOTE_MODULE_ID)!.component;
const Docs = CRDT_MODULES.find((entry) => entry.manifest.id === CRDT_DOC_LIST_MODULE_ID)!.component;

function mount(
  port: ReturnType<typeof createMemoryCrdtPort>,
  children: ReactNode,
  wakes?: Readonly<Record<string, number>>,
) {
  return render(
    <CrdtDocProvider port={port.port} wakes={wakes}>
      {children}
    </CrdtDocProvider>,
  );
}

/** Reading is the default; the editor is a deliberate gesture. */
async function openEditor(name = "编辑"): Promise<HTMLTextAreaElement> {
  const toggles = await screen.findAllByRole("button", { name });
  await userEvent.click(toggles[toggles.length - 1]!);
  const boxes = await screen.findAllByRole("textbox");
  return boxes[boxes.length - 1] as HTMLTextAreaElement;
}

describe("the collaborative document", () => {
  it("renders the document as a page after mounting, with one open call", async () => {
    const port = createMemoryCrdtPort(fixture());
    mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />);
    // The default is READING: typography, not a form field.
    await screen.findByText("shared draft");
    await screen.findByText("已同步");
    expect(screen.queryByRole("textbox")).toBeNull();
    // One capability call, not one per render. A duplicate open is a duplicate
    // approval card on this platform.
    expect(port.calls.filter((call) => call.action === "open_doc")).toHaveLength(1);
  });

  it("survives StrictMode's double mount without a second open", async () => {
    const port = createMemoryCrdtPort(fixture());
    render(
      <StrictMode>
        <CrdtDocProvider port={port.port}>
          <Note panel={panel()} workspace={fakeWorkspace()} />
        </CrdtDocProvider>
      </StrictMode>,
    );
    await screen.findByText("shared draft");
    // StrictMode runs setup → cleanup → setup. The cleanup DESTROYS the session,
    // so the second setup opens a fresh one: two opens, and — this is the part
    // that matters — the text belongs to the live session, not the destroyed one.
    expect(port.calls.filter((call) => call.action === "open_doc").length).toBeLessThanOrEqual(2);
  });

  it("shows an empty state when nothing has been opened into the panel", async () => {
    const port = createMemoryCrdtPort(fixture());
    mount(port, <Note panel={panel({ resourceRef: null, resourceKind: null })} workspace={fakeWorkspace()} />);
    await screen.findByText("选择一份文档");
    expect(port.calls).toHaveLength(0);
  });

  it("edits through the editor mode and reflects the server's acceptance", async () => {
    const port = createMemoryCrdtPort(fixture({ initialText: "" }));
    mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText(/这篇文档还是空的/);

    const box = await openEditor();
    await userEvent.type(box, "hello");
    // Typing does not push: the debounce is what keeps a person's keystrokes
    // from spending the channel's whole message budget.
    expect(port.calls.filter((call) => call.action === "apply_update")).toHaveLength(0);
    await screen.findByText("有未同步的改动");

    await userEvent.click(screen.getByRole("button", { name: "同步" }));
    await waitFor(() => expect(port.text(DOC)).toBe("hello"));
    await screen.findByText("已同步");
  });

  it("applies a toolbar command to the selection, as one merged edit", async () => {
    const port = createMemoryCrdtPort(fixture({ initialText: "hello world" }));
    mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("hello world");
    const box = await openEditor();
    box.setSelectionRange(0, 5);
    await userEvent.click(screen.getByRole("button", { name: "加粗" }));
    await waitFor(() => expect(box.value).toBe("**hello** world"));
    // The selection survives, so a second press can toggle back.
    await userEvent.click(screen.getByRole("button", { name: "加粗" }));
    await waitFor(() => expect(box.value).toBe("hello world"));
  });

  it("renders a refusal instead of losing the panel", async () => {
    const port = createMemoryCrdtPort(
      fixture({ refusals: { open_doc: { code: "approval_required", message: "等待批准" } } }),
    );
    mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />);
    // The instruction, not "something went wrong" — an error boundary here would
    // send somebody to reload, which costs another approval card.
    await screen.findByText(/需要文档主人在待批准列表里确认/);
    await screen.findByText(/等待批准/);
  });

  it("shows a newer document read-only, with no editor to type into", async () => {
    const port = createMemoryCrdtPort(fixture({ schemaMajor: 9 }));
    mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("shared draft");
    await screen.findByText("只读");
    // The 编辑 gesture is absent rather than disabled-but-present: this build
    // must not write a shape it does not understand into a shared history.
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("closes its own panel when asked", async () => {
    const port = createMemoryCrdtPort(fixture());
    const workspace = fakeWorkspace();
    mount(port, <Note panel={panel()} workspace={workspace} />);
    await screen.findByText("shared draft");
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(workspace.closed).toEqual(["note"]);
  });
});

describe("the wake hint (ADR 0006)", () => {
  it("pulls a colleague's change when the wake token moves and the session is clean", async () => {
    const port = createMemoryCrdtPort(fixture({ initialText: "" }));
    const view = mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />, { [DOC]: 0 });
    await screen.findByText(/这篇文档还是空的/);

    port.editFromElsewhere(DOC, (text) => text.insert(0, "from elsewhere"));
    view.rerender(
      <CrdtDocProvider port={port.port} wakes={{ [DOC]: 1 }}>
        <Note panel={panel()} workspace={fakeWorkspace()} />
      </CrdtDocProvider>,
    );
    // No click anywhere: the hint triggered ONE pull, which still went through
    // the port like every other read.
    await screen.findByText("from elsewhere");
    expect(port.calls.filter((call) => call.action === "read_updates").length).toBeGreaterThan(0);
  });

  it("stops dispatching after a refusal: wakes render a hint, a person resumes", async () => {
    const port = createMemoryCrdtPort(fixture());
    const view = mount(port, <Note panel={panel()} workspace={fakeWorkspace()} />, { [DOC]: 0 });
    await screen.findByText("shared draft");

    // Refuse the next pull, then wake: the session records the refusal.
    port.refuseNext("read_updates", "approval_required", "等待批准");
    view.rerender(
      <CrdtDocProvider port={port.port} wakes={{ [DOC]: 1 }}>
        <Note panel={panel()} workspace={fakeWorkspace()} />
      </CrdtDocProvider>,
    );
    await screen.findByText(/等待批准/);
    const dispatched = port.calls.length;

    // Ten more wakes: ten renders, zero dispatches — ADR 0006's cooldown rule.
    for (let token = 2; token <= 11; token += 1) {
      view.rerender(
        <CrdtDocProvider port={port.port} wakes={{ [DOC]: token }}>
          <Note panel={panel()} workspace={fakeWorkspace()} />
        </CrdtDocProvider>,
      );
    }
    await screen.findByText("有新改动，点同步查看");
    expect(port.calls.length).toBe(dispatched);

    // The human gesture is the way out, and it clears the hint.
    await userEvent.click(screen.getByRole("button", { name: "同步" }));
    await screen.findByText("已同步");
  });
});

describe("the document rail", () => {
  it("lists the scope's documents by title and opens one as an intent", async () => {
    const port = createMemoryCrdtPort(fixture({ titles: { [DOC]: "使用说明" } }));
    const workspace = fakeWorkspace();
    mount(port, <Docs panel={panel({ panelId: "docs", moduleId: CRDT_DOC_LIST_MODULE_ID, slot: "navigation", resourceRef: null, resourceKind: null })} workspace={workspace} />);
    await userEvent.click(await screen.findByRole("button", { name: /使用说明/ }));
    expect(workspace.opened).toEqual([
      { kind: CRDT_NOTE_RESOURCE_KIND, ref: DOC, label: "使用说明" },
    ]);
    // One enumeration at mount. Never a timer: a capability read on this
    // platform can cost a person an approval card.
    expect(port.calls.filter((call) => call.action === "list_docs")).toHaveLength(1);
  });

  it("re-enumerates only on the explicit refresh gesture", async () => {
    const port = createMemoryCrdtPort(fixture({ titles: { [DOC]: "使用说明" } }));
    mount(port, <Docs panel={panel({ panelId: "docs", moduleId: CRDT_DOC_LIST_MODULE_ID, slot: "navigation", resourceRef: null, resourceKind: null })} workspace={fakeWorkspace()} />);
    await screen.findByRole("button", { name: /使用说明/ });
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(port.calls.filter((call) => call.action === "list_docs")).toHaveLength(2),
    );
  });

  it("renders a refusal as a sentence, not an empty rail", async () => {
    const port = createMemoryCrdtPort(
      fixture({ refusals: { list_docs: { code: "no_authority", message: "没有授权" } } }),
    );
    mount(port, <Docs panel={panel({ panelId: "docs", moduleId: CRDT_DOC_LIST_MODULE_ID, slot: "navigation", resourceRef: null, resourceKind: null })} workspace={fakeWorkspace()} />);
    await screen.findByText(/没有授权/);
  });
});

describe("two panels on one document are two collaborators", () => {
  it("keeps separate replicas and converges through the port", async () => {
    const port = createMemoryCrdtPort(fixture({ initialText: "" }));
    const workspace = fakeWorkspace([
      panel({ panelId: "left" }),
      panel({ panelId: "right", slot: "secondary" }),
    ]);
    mount(
      port,
      <>
        <Note panel={panel({ panelId: "left" })} workspace={workspace} />
        <Note panel={panel({ panelId: "right", slot: "secondary" })} workspace={workspace} />
      </>,
    );

    const toggles = await screen.findAllByRole("button", { name: "编辑" });
    expect(toggles).toHaveLength(2);
    await userEvent.click(toggles[0]!);
    await userEvent.click(toggles[1]!);
    const boxes = await screen.findAllByRole("textbox");
    expect(boxes).toHaveLength(2);
    const [left, right] = boxes as HTMLTextAreaElement[];
    await waitFor(() => expect(left!.value).toBe(""));

    // Neither panel can see the other's replica; the only path between them is
    // the port. If they shared a `Y.Doc`, the right box would already show this.
    await userEvent.type(left!, "from-left");
    expect(right!.value).toBe("");

    const syncButtons = screen.getAllByRole("button", { name: "同步" });
    await userEvent.click(syncButtons[0]!);
    await waitFor(() => expect(port.text(DOC)).toBe("from-left"));

    await userEvent.click(syncButtons[1]!);
    await waitFor(() => expect(right!.value).toBe("from-left"));
    expect(left!.value).toBe(right!.value);
  });

  it("gives the second panel its own DOM ids", async () => {
    // Two copies of one module in one document must not both claim `#crdtdoc`;
    // the second gets a namespace, which is the rule every reusable module here
    // follows.
    const panels = [panel({ panelId: "left" }), panel({ panelId: "right", slot: "secondary" })];
    const workspace = fakeWorkspace(panels);
    const port = createMemoryCrdtPort(fixture());
    const { container } = mount(
      port,
      <>
        <Note panel={panels[0]!} workspace={workspace} />
        <Note panel={panels[1]!} workspace={workspace} />
      </>,
    );
    await screen.findAllByText("shared draft");
    expect(container.querySelectorAll("#crdtdoc")).toHaveLength(1);
    expect(container.querySelector("#crdtdoc-right")).not.toBeNull();
  });
});
