/**
 * The editor module, driven through a real `workspace-files/v1` port.
 *
 * Every assertion is about something that would be a real defect and would look
 * fine on screen: a panel that says "已保存" when a person still has to approve
 * it, a save control offered by a scope that cannot write, a second proposal for
 * one edit (one extra approval card), a buffer that survives into a different
 * document, an edit applied on top of a version nobody saw.
 *
 * The port is the fixture-backed writable one from `./harness` — a SECOND real
 * implementation of the contract — so what is exercised is the module against a
 * port, not the module against the one transport it happens to ship with.
 */

import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import type { LayoutPanel, WorkspaceApi } from "@claude-bot/agent-view-react/workspace";
import {
  WORKSPACE_FILES_LIMITS,
  createRemoteWorkspaceFilesPortV4,
  type ProposalTransport,
} from "@claude-bot/workspace-files-contract";
import { WorkspaceFilesProvider } from "@claude-bot/agent-workspace-files-view";
import { EDITOR_MODULE, EDITOR_MODULES } from "./modules.js";
import { EDITOR_CONTEXT_LINE, EDITOR_MODULE_ID, WORKSPACE_TEXT_RESOURCE_KIND } from "./manifests.js";
import {
  createWritableMemoryWorkspaceFilesPort,
  digestOf,
  type WritableMemoryFixture,
  type WritableMemoryWorkspaceFilesPort,
} from "./harness/writable-memory-port.js";

const TEXT = "line one\nline two\nline three\nline four\n";

function fixture(overrides: Partial<WritableMemoryFixture> = {}): WritableMemoryFixture {
  return {
    roots: { roots: [{ ref: "r1", label: "octopus", sourceLabel: "laptop" }], truncated: false },
    directories: {
      r1: {
        ref: "r1",
        label: "octopus",
        truncated: false,
        entries: [{ ref: "f1", label: "notes.md", kind: "file", sizeBytes: TEXT.length }],
      },
    },
    files: {
      f1: {
        document: {
          ref: "f1",
          label: "notes.md",
          mediaType: "text/plain; charset=utf-8",
          sizeBytes: TEXT.length,
          digest: digestOf(TEXT),
        },
        text: TEXT,
      },
    },
    ...overrides,
  };
}

function fakeWorkspace(panels: LayoutPanel[] = []): WorkspaceApi & {
  opened: ResourceLink[];
  intents: Array<{ resource: ResourceLink; view: string | undefined; context?: Readonly<Record<string, string>> }>;
  closed: string[];
  dirty: Array<{ panelId: string; value: boolean }>;
} {
  const opened: ResourceLink[] = [];
  const intents: Array<{ resource: ResourceLink; view: string | undefined; context?: Readonly<Record<string, string>> }> = [];
  const closed: string[] = [];
  const dirty: Array<{ panelId: string; value: boolean }> = [];
  return {
    state: { panels, active: {} as never, focused: null, narrow: false, drilledIn: false, seq: 0 },
    open: (resource, options) => {
      opened.push(resource);
      intents.push({ resource, view: options?.view, ...(options?.context ? { context: options.context } : {}) });
      return true;
    },
    openIntent: () => true,
    focus: () => undefined,
    close: (panelId) => {
      closed.push(panelId);
    },
    setDirty: (panelId, value) => {
      dirty.push({ panelId, value });
    },
    report: () => undefined,
    back: () => undefined,
    opened,
    intents,
    closed,
    dirty,
  };
}

function panel(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    panelId: "editor",
    moduleId: EDITOR_MODULE_ID,
    slot: "secondary",
    resourceRef: "f1",
    resourceKind: WORKSPACE_TEXT_RESOURCE_KIND,
    label: "notes.md",
    status: "ready",
    reason: "",
    detail: "",
    config: null,
    context: null,
    ...overrides,
  };
}

const Editor = EDITOR_MODULE.component;

function mount(port: WritableMemoryWorkspaceFilesPort, children: ReactNode) {
  return render(<WorkspaceFilesProvider port={port.port}>{children}</WorkspaceFilesProvider>);
}

/** The CodeMirror document, as the browser would show it. */
function editorText(): string {
  const content = document.querySelector(".wsedit-surface .cm-content");
  if (!content) throw new Error("the editor surface has not mounted");
  return [...content.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n");
}

async function mountLoaded(port: WritableMemoryWorkspaceFilesPort, panelProps: LayoutPanel = panel()) {
  mount(port, <Editor panel={panelProps} workspace={fakeWorkspace([panelProps])} />);
  await waitFor(() => expect(editorText()).toContain("line one"));
}

/** Type into CodeMirror the way a person does. */
async function type(text: string): Promise<void> {
  const content = document.querySelector(".wsedit-surface .cm-content") as HTMLElement;
  await userEvent.click(content);
  await userEvent.type(content, text);
}

describe("reading", () => {
  it("keeps browse and download in editor chrome, and replaces a clean editor with the configured viewer", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    const editorPanel = panel({ config: { browse_view: "workspace.file-viewer/v1" }, context: { workspace_root_ref: "root", workspace_file_labels: "notes.md" } });
    const workspace = fakeWorkspace([editorPanel]);
    mount(port, <Editor panel={editorPanel} workspace={workspace} />);
    await waitFor(() => expect(editorText()).toContain("line one"));

    expect(screen.getByRole("group", { name: "浏览或编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 notes.md" })).toBeEnabled();
    const browse = screen.getByRole("button", { name: "浏览" });
    expect(browse).toBeEnabled();

    await userEvent.click(browse);
    expect(workspace.intents).toEqual([{
      resource: { kind: WORKSPACE_TEXT_RESOURCE_KIND, ref: "f1", label: "notes.md" },
      view: "workspace.file-viewer/v1",
      context: editorPanel.context,
    }]);
    expect(workspace.closed).toEqual(["editor"]);
  });

  it("keeps the browse control visible but protects an unsaved editor from replacement", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    const editorPanel = panel({ config: { browse_view: "workspace.file-viewer/v1" } });
    const workspace = fakeWorkspace([editorPanel]);
    mount(port, <Editor panel={editorPanel} workspace={workspace} />);
    await waitFor(() => expect(editorText()).toContain("line one"));
    await type("draft");

    const browse = screen.getByRole("button", { name: "浏览" });
    await waitFor(() => expect(browse).toBeDisabled());
    expect(browse).toHaveAttribute("title", "请先保存或重新读取以放弃未保存的修改。");
    expect(workspace.intents).toEqual([]);
    expect(workspace.closed).toEqual([]);
  });

  it("keeps the surface read-only until the complete snapshot and digest arrive", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    const originalOpen = port.port.openText.bind(port.port);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    port.port.openText = async (ref) => {
      await gate;
      return originalOpen(ref);
    };

    mount(port, <Editor panel={panel()} workspace={fakeWorkspace([panel()])} />);
    await waitFor(() => expect(document.querySelector(".wsedit-surface")).toHaveAttribute("data-readonly", "1"));
    expect(document.querySelector(".wsedit-surface .cm-content")).toHaveAttribute("contenteditable", "false");

    release();
    await waitFor(() => expect(editorText()).toContain("line one"));
    await waitFor(() => expect(document.querySelector(".wsedit-surface")).not.toHaveAttribute("data-readonly"));
  });

  it("shows the file and offers a save control once there is a change", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);

    // Nothing to submit yet, so the control is present but refuses to act — as
    // opposed to absent, which is what "this port cannot write" looks like.
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    expect(port.calls.filter((call) => call.method === "replaceText")).toHaveLength(0);

    await type("x");
    await waitFor(() => expect(save).toBeEnabled());
    expect(screen.getByText("未保存")).toBeInTheDocument();
  });

  it("uses the shared writable text surface with search, replacement and wrap", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    const surface = document.querySelector(".wsedit-surface")!;
    const editor = surface.querySelector(".cm-editor");

    expect(surface.querySelector(".cm-lineNumbers")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(surface.querySelector('.cm-search input[name="replace"]')).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭自动换行" }));
    expect(surface).toHaveAttribute("data-wrap", "0");
    expect(surface.querySelector(".cm-editor")).toBe(editor);
  });

  it("reads the file exactly once, and never re-reads on its own", async () => {
    // Every read crosses a Gate. A panel that re-read on focus, on remount or on
    // a timer would be spending capability calls nobody asked for.
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(port.calls.filter((call) => call.method === "openText")).toHaveLength(1);
  });
});

describe("saving", () => {
  it("submits once, and reports that somebody has to approve it", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    await type("!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    const state = await screen.findByRole("status");
    expect(state).toHaveAttribute("data-status", "submitted");
    expect(state).toHaveAttribute("data-code", "approval_required");
    expect(state).toHaveTextContent("关闭不会撤销");
    expect(state).toHaveTextContent("可信审批栏拒绝");
    // The file is untouched, and the panel does not claim otherwise.
    expect(port.textOf("f1")).toBe(TEXT);
    expect(screen.queryByText("已保存。")).toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    // And nothing re-issues it. A second proposal is a second approval card.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(port.calls.filter((call) => call.method === "replaceText")).toHaveLength(1);
  });

  it("keeps an unknown trusted approval visible and blocks a second proposal after reload", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    await type("!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/关闭不会撤销/);

    await userEvent.click(screen.getByRole("button", { name: /重新读取/ }));
    await waitFor(() => expect(port.calls.filter((call) => call.method === "openText")).toHaveLength(2));
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "submitted");
    expect(screen.getByRole("status")).toHaveTextContent("可信审批栏拒绝");

    await type("new draft");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(port.calls.filter((call) => call.method === "replaceText")).toHaveLength(1);
  });

  it("sends the whole buffer with the digest it was read at", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    await mountLoaded(port);
    await type("!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(port.textOf("f1")).not.toBe(TEXT));
    // The typed character landed at the caret, which starts at the top of a
    // freshly loaded document.
    expect(port.textOf("f1")).toBe(`!${TEXT}`);
  });

  it("projects a successful receipt into the visible document metadata", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    await mountLoaded(port);
    await type("!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved"));
    const committed = port.textOf("f1")!;
    expect(screen.getByText(digestOf(committed))).toBeInTheDocument();
    expect(screen.getByText(/2026-08-07T00:00:00.000Z/)).toBeInTheDocument();
  });

  it("keeps coordinator close protection while a write is in flight", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    const originalWrite = port.port.replaceText!.bind(port.port);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    port.port.replaceText = async (ref, input) => {
      await gate;
      return originalWrite(ref, input);
    };
    const editorPanel = panel();
    const workspace = fakeWorkspace([editorPanel]);
    mount(port, <Editor panel={editorPanel} workspace={workspace} />);
    await waitFor(() => expect(editorText()).toContain("line one"));
    await type("x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    const content = document.querySelector<HTMLElement>(".wsedit-surface .cm-content")!;
    fireEvent.keyDown(content, { key: "z", code: "KeyZ", ctrlKey: true });

    await waitFor(() => expect(screen.queryByText("未保存")).toBeNull());
    expect(workspace.dirty.at(-1)).toEqual({ panelId: "editor", value: true });
    release();
    await act(async () => { await gate; });
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved"));
    expect(screen.getByText("未保存")).toBeInTheDocument();
    expect(workspace.dirty.at(-1)).toEqual({ panelId: "editor", value: true });
  });

  it("continues from the receipt, so a second save does not need a re-read", async () => {
    // The receipt's `afterDigest` is the next edit's precondition. Without it
    // the second save would be a guaranteed conflict against a version the
    // panel itself produced.
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    await mountLoaded(port);
    await type("a");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved"));

    await type("b");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(port.textOf("f1")).toBe(`ba${TEXT}`));
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved");
  });

  it("keeps the committed receipt as the base after a later attempt fails, so a retry does not conflict with itself", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    await mountLoaded(port);
    await type("a");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved"));

    await type("b");
    port.setWrite({ kind: "refused", code: "unavailable", message: "设备暂时不可用" });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("data-status", "refused"));

    port.setWrite({ kind: "applied" });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(port.textOf("f1")).toBe(`ba${TEXT}`));
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "saved");
  });

  it("says a stale edit is stale, and writes nothing", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "applied" } }));
    await mountLoaded(port);
    await type("mine");
    // Somebody else saved while this buffer was open.
    port.overwrite("f1", "theirs\n");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    const state = await screen.findByRole("status");
    await waitFor(() => expect(state).toHaveAttribute("data-status", "conflict"));
    expect(port.textOf("f1")).toBe("theirs\n");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    // A conflict is not retried; the reader re-reads when they choose to.
    expect(port.calls.filter((call) => call.method === "replaceText")).toHaveLength(1);
  });

  it("stops offering to save once the scope answers read_only", async () => {
    // Structural, not momentary: this scope's authority covers the reads. The
    // control goes away rather than staying and failing — the same "nothing to
    // submit" rule an `other` entry's missing ref relies on.
    const port = createWritableMemoryWorkspaceFilesPort(fixture({ write: { kind: "read_only" } }));
    await mountLoaded(port);
    await type("x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "保存" })).toBeNull());
    expect(screen.getByText(/只读/)).toBeInTheDocument();
    expect(port.textOf("f1")).toBe(TEXT);
    expect(editorText()).toContain("x");
  });

  it("keeps the buffer and the control after a transport refusal", async () => {
    // `unavailable` is about this attempt. Losing the buffer would lose the
    // person's work for a reason that may not be true a second later.
    const port = createWritableMemoryWorkspaceFilesPort(
      fixture({ write: { kind: "refused", code: "unavailable", message: "笔记本离线" } }),
    );
    await mountLoaded(port);
    await type("keep me");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    const state = await screen.findByRole("status");
    await waitFor(() => expect(state).toHaveAttribute("data-status", "refused"));
    expect(state).toHaveTextContent("笔记本离线");
    expect(editorText()).toContain("keep me");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("does not offer a save at all on a port that cannot write", async () => {
    // The other half of the port's own distinction: absent is not the same as
    // present-and-refusing, and a UI conflating them either hides a working
    // button or offers a broken one.
    const writable = createWritableMemoryWorkspaceFilesPort(fixture());
    const readOnly = {
      ...writable,
      port: {
        contract: writable.port.contract,
        refreshRoots: writable.port.refreshRoots.bind(writable.port),
        listDirectory: writable.port.listDirectory.bind(writable.port),
        openText: writable.port.openText.bind(writable.port),
      },
    } as WritableMemoryWorkspaceFilesPort;
    await mountLoaded(readOnly);

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByText(/没有提供写入/)).toBeInTheDocument();
  });

  it("saves a file past one call's write window as one staged upload through the remote port", async () => {
    // 2026-10-20: the 256 KiB per-call window no longer caps a save. The real
    // remote client stages it: begin → append windows → commit, and the file
    // changes once, at commit, under the same compare-and-swap.
    const base = "abcdefghij\n".repeat(30_000);
    const device = stagingDevice(base);
    const remote = createRemoteWorkspaceFilesPortV4(device.transport, "workspace");
    render(
      <WorkspaceFilesProvider port={remote.port}>
        <Editor panel={panel()} workspace={fakeWorkspace([panel()])} />
      </WorkspaceFilesProvider>,
    );
    await waitFor(() => expect(editorText()).toContain("abcdefghij"));
    expect(document.querySelector(".wsedit-surface")).not.toHaveAttribute("data-readonly", "1");
    await type("x");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已保存。");
    expect(device.text).toBe(`x${base}`);
    expect(device.stages[0]).toBe("begin");
    expect(device.stages.filter((stage) => stage === "commit")).toHaveLength(1);
    expect(device.stages.filter((stage) => stage === "append").length).toBeGreaterThan(1);
    expect(utf8Length(device.text)).toBeGreaterThan(WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
    remote.destroy();
  });

  it("refuses a stale staged save as a conflict and leaves the newer file whole", async () => {
    const base = "abcdefghij\n".repeat(30_000);
    const device = stagingDevice(base);
    const remote = createRemoteWorkspaceFilesPortV4(device.transport, "workspace");
    render(
      <WorkspaceFilesProvider port={remote.port}>
        <Editor panel={panel()} workspace={fakeWorkspace([panel()])} />
      </WorkspaceFilesProvider>,
    );
    await waitFor(() => expect(editorText()).toContain("abcdefghij"));
    await type("x");
    device.text = "somebody else saved first\n";
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/文件已被别处修改|不是你编辑时的那个版本/);
    expect(device.text).toBe("somebody else saved first\n");
    expect(device.staged).toBe(null);
    remote.destroy();
  });
});

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The provider side of a staged save, over the proposal wire: it serves one
 * text file as a stream and stages replace_text by upload and offset, with a
 * compare-and-swap at commit. Nothing changes the file before commit.
 */
function stagingDevice(initial: string) {
  const handle = "rs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const token = "0123456789abcdef0123456789abcdef";
  const state = {
    text: initial,
    staged: null as string | null,
    stages: [] as string[],
  };
  let windows: string[] = [];
  let next = 0;
  const document = () => ({
    ref: "f1",
    label: "notes.md",
    mediaType: "text/plain; charset=utf-8",
    sizeBytes: utf8Length(state.text),
    digest: digestOf(state.text),
  });
  const receipt = (before: string) => ({
    ref: "f1",
    mutationId: "0123456789abcdef",
    operation: "replace_text",
    beforeDigest: before,
    afterDigest: digestOf(state.text),
    sizeBytes: utf8Length(state.text),
    committedAt: "2026-10-20T00:00:00.000Z",
    undo: "unsupported",
  });
  const refuse = (code: string, message: string) => ({ ok: false, code, result: null, message });
  const transport: ProposalTransport = {
    async propose(action, params = {}) {
      if (action === "resource.open_text") {
        const doc = document();
        windows = [];
        for (let at = 0; at < state.text.length; at += 100_000) windows.push(state.text.slice(at, at + 100_000));
        next = 0;
        return {
          ok: true,
          message: "",
          result: {
            document: doc,
            stream: {
              contract: "resource-stream/v1",
              kind: "open",
              handle,
              metadata: {
                payload: "workspace-files/v1#text-chunk",
                mediaType: doc.mediaType,
                totalBytes: doc.sizeBytes,
                digest: doc.digest,
              },
            },
          },
        };
      }
      if (action === "resource.stream_pull") {
        if (next >= windows.length) {
          return {
            ok: true,
            message: "",
            result: { contract: "resource-stream/v1", kind: "end", handle, chunks: windows.length, bytes: utf8Length(windows.join("")) },
          };
        }
        const text = windows[next]!;
        const seq = next;
        next += 1;
        return {
          ok: true,
          message: "",
          result: { contract: "resource-stream/v1", kind: "chunk", handle, seq, bytes: utf8Length(text), value: { text } },
        };
      }
      if (action === "resource.stream_close") return { ok: true, message: "", result: { closed: true } };
      if (action === "resource.replace_text") {
        state.stages.push(params.stage ?? "whole");
        if (params.stage === "begin") {
          if (params.expected_digest !== digestOf(state.text)) return refuse("digest_mismatch", "文件已被别处修改。");
          state.staged = "";
          return { ok: true, message: "", result: { upload: token, sizeBytes: 0 } };
        }
        if (params.stage === "append") {
          if (state.staged === null || Number(params.offset) !== utf8Length(state.staged)) {
            state.staged = null;
            return refuse("unavailable", "分段保存没有完成。");
          }
          state.staged += params.text ?? "";
          return { ok: true, message: "", result: { upload: token, sizeBytes: utf8Length(state.staged) } };
        }
        if (params.stage === "commit") {
          const staged = state.staged;
          state.staged = null;
          if (staged === null || Number(params.size) !== utf8Length(staged)) return refuse("unavailable", "分段保存没有完成。");
          // The compare-and-swap, at commit, against the file as it is NOW.
          if (params.expected_digest !== digestOf(state.text)) return refuse("digest_mismatch", "文件已被别处修改。");
          const before = digestOf(state.text);
          state.text = staged;
          return { ok: true, message: "", result: receipt(before) };
        }
        return refuse("invalid_request", "unexpected one-call replace");
      }
      return refuse("invalid_request", "unknown action");
    },
  };
  return Object.assign(state, { transport });
}

describe("re-reading", () => {
  it("replaces the buffer with what the file says now", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    await type("draft");
    port.overwrite("f1", "somebody else's version\n");

    await userEvent.click(screen.getByRole("button", { name: /重新读取/ }));

    await waitFor(() => expect(editorText()).toContain("somebody else's version"));
    expect(editorText()).not.toContain("draft");
    expect(port.calls.filter((call) => call.method === "openText")).toHaveLength(2);
    // The previous save state does not survive a new document.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns in the button label while there are unsaved changes", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port);
    expect(screen.getByRole("button", { name: "重新读取" })).toBeInTheDocument();
    await type("x");
    await waitFor(() => expect(screen.getByRole("button", { name: "重新读取（放弃修改）" })).toBeInTheDocument());
  });

  it("serializes explicit reload and ignores a save receipt after resource rebinding", async () => {
    const second = "newer snapshot\n";
    const firstFixture = fixture();
    const port = createWritableMemoryWorkspaceFilesPort(fixture({
      write: { kind: "applied" },
      files: {
        f1: firstFixture.files.f1!,
        f2: {
          document: {
            ref: "f2",
            label: "second.md",
            mediaType: "text/plain; charset=utf-8",
            sizeBytes: second.length,
            digest: digestOf(second),
          },
          text: second,
        },
      },
    }));
    const originalWrite = port.port.replaceText!.bind(port.port);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    port.port.replaceText = async (ref, input) => {
      const answer = await originalWrite(ref, input);
      await gate;
      return answer;
    };
    const firstPanel = panel();
    const view = mount(port, <Editor panel={firstPanel} workspace={fakeWorkspace([firstPanel])} />);
    await waitFor(() => expect(editorText()).toContain("line one"));
    await type("!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(port.calls.filter((call) => call.method === "replaceText")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "重新读取（放弃修改）" })).toBeDisabled();

    const rebound = panel({ resourceRef: "f2", label: "second.md" });
    view.rerender(
      <WorkspaceFilesProvider port={port.port}>
        <Editor panel={rebound} workspace={fakeWorkspace([rebound])} />
      </WorkspaceFilesProvider>,
    );
    await waitFor(() => expect(editorText()).toContain("newer snapshot"));
    release();

    await act(async () => { await gate; });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(editorText()).toContain("newer snapshot");
  });

  it("resets the parent dirty lifecycle before a declared editor is rebound", async () => {
    const second = "second file\n";
    const port = createWritableMemoryWorkspaceFilesPort(fixture({
      directories: {
        r1: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          entries: [
            { ref: "f1", label: "notes.md", kind: "file", sizeBytes: TEXT.length },
            { ref: "f2", label: "second.md", kind: "file", sizeBytes: second.length },
          ],
        },
      },
      files: {
        f1: fixture().files.f1!,
        f2: {
          document: {
            ref: "f2",
            label: "second.md",
            mediaType: "text/plain; charset=utf-8",
            sizeBytes: second.length,
            digest: digestOf(second),
          },
          text: second,
        },
      },
    }));
    const firstPanel = panel();
    const firstWorkspace = fakeWorkspace([firstPanel]);
    const view = mount(port, <Editor panel={firstPanel} workspace={firstWorkspace} />);
    await waitFor(() => expect(editorText()).toContain("line one"));
    await type("draft");
    await waitFor(() => expect(firstWorkspace.dirty.at(-1)).toEqual({ panelId: "editor", value: true }));

    const cleared = panel({ resourceRef: null, resourceKind: null, label: "Editor" });
    const clearedWorkspace = fakeWorkspace([cleared]);
    view.rerender(
      <WorkspaceFilesProvider port={port.port}>
        <Editor panel={cleared} workspace={clearedWorkspace} />
      </WorkspaceFilesProvider>,
    );
    await waitFor(() => expect(clearedWorkspace.dirty.at(-1)).toEqual({ panelId: "editor", value: false }));

    const rebound = panel({ resourceRef: "f2", label: "second.md" });
    const reboundWorkspace = fakeWorkspace([rebound]);
    view.rerender(
      <WorkspaceFilesProvider port={port.port}>
        <Editor panel={rebound} workspace={reboundWorkspace} />
      </WorkspaceFilesProvider>,
    );
    await waitFor(() => expect(editorText()).toContain("second file"));
    expect(screen.queryByText("未保存")).toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(reboundWorkspace.dirty.at(-1)).toEqual({ panelId: "editor", value: false });
  });
});

describe("intent context", () => {
  it("puts the caret on the line an open intent asked for", async () => {
    // The first real consumer of `open-resource/v1`'s context. The platform
    // transports it and never reads it; the meaning is this resource kind's.
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port, panel({ context: { [EDITOR_CONTEXT_LINE]: "3" } }));

    await waitFor(() => {
      // What the surface DID. Whether the viewport scrolled is a browser
      // question, and jsdom has no layout to answer it with.
      expect(document.querySelector(".wsedit-surface")).toHaveAttribute("data-caret-line", "3");
    });
  });

  it("clamps a line past the end of the file instead of scrolling nowhere", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port, panel({ context: { [EDITOR_CONTEXT_LINE]: "9000" } }));
    await waitFor(() => {
      expect(document.querySelector(".wsedit-surface")).toHaveAttribute("data-caret-line", "5");
    });
  });

  it("ignores a context that is not a line number", async () => {
    const port = createWritableMemoryWorkspaceFilesPort(fixture());
    await mountLoaded(port, panel({ context: { [EDITOR_CONTEXT_LINE]: "not-a-line", column: "4" } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector(".wsedit-surface")).not.toHaveAttribute("data-caret-line");
  });
});

describe("the module list", () => {
  it("is one module, paired with the manifest a release ships", () => {
    // A composition that could pair a manifest with a different implementation
    // would make the module lock a claim rather than a fact.
    expect(EDITOR_MODULES).toHaveLength(1);
    expect(EDITOR_MODULES[0]!.manifest.id).toBe(EDITOR_MODULE_ID);
    expect(EDITOR_MODULES[0]!.manifest.opens).toEqual([WORKSPACE_TEXT_RESOURCE_KIND]);
    expect(typeof EDITOR_MODULES[0]!.component).toBe("function");
  });
});
