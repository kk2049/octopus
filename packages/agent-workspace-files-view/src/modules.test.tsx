/**
 * The two modules, driven through a real `workspace-files/v1` port.
 *
 * Every assertion here is about a behaviour that would be a real defect and
 * would look fine on screen: a tree that walks the whole workspace on mount
 * (one approval card per directory nobody opened), a viewer that shows the tail
 * of the previous file under the new file's header, a panel that unmounts with a
 * stream still open, a refusal that takes out the panel instead of being read.
 *
 * The port is the fixture-backed one from `./harness`, which is a SECOND real
 * implementation of the contract — so what is exercised is the modules against a
 * port, not the modules against the one transport they happen to ship with.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import type { ResourceLink } from "@claude-bot/agent-module-contract";
import type {
  FileAnnotationDraftRecord,
  FileAnnotationDraftStore,
  FileAnnotationsAdapter,
} from "@claude-bot/agent-file-preview";
import type { LayoutPanel, WorkspaceApi } from "@claude-bot/agent-view-react/workspace";
import { createResourceStream } from "@claude-bot/resource-stream-contract";
import {
  WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
  WORKSPACE_DOWNLOAD_LIMITS,
  WORKSPACE_DOWNLOAD_MEDIA_TYPE,
  WORKSPACE_FILES_LIMITS,
  type WorkspaceDownloadChunk,
} from "@claude-bot/workspace-files-contract";
import { WorkspaceFilesProvider } from "./context.js";
import { WORKSPACE_FILES_MODULES } from "./modules.js";
import { FILE_TREE_MODULE_ID, FILE_VIEWER_MODULE_ID, WORKSPACE_TEXT_RESOURCE_KIND } from "./manifests.js";
import {
  createMemoryWorkspaceFilesPort,
  type MemoryWorkspaceFilesPort,
  type MemoryWorkspaceFixture,
} from "./harness/memory-port.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

/**
 * One workspace, two levels deep, with every entry kind the contract allows.
 *
 * `notes/` is a directory the tree must NOT list until it is opened; `link` is
 * an `other` with no ref, which is how "we do not follow symlinks" is expressed
 * as an absence rather than a check.
 */
function fixture(overrides: Partial<MemoryWorkspaceFixture> = {}): MemoryWorkspaceFixture {
  return {
    roots: {
      roots: [{ ref: "r1", label: "octopus", sourceLabel: "laptop" }],
      truncated: false,
    },
    directories: {
      r1: {
        ref: "r1",
        label: "octopus",
        truncated: false,
        entries: [
          { ref: "d1", label: "notes", kind: "directory" },
          { ref: "f1", label: "readme.md", kind: "file", sizeBytes: 11 },
          { ref: "f2", label: "huge.log", kind: "file", sizeBytes: 99_000_000, exceedsTextLimit: true },
          { label: "link", kind: "other" },
        ],
      },
      d1: {
        ref: "d1",
        label: "notes",
        truncated: false,
        entries: [{ ref: "f3", label: "todo.md", kind: "file", sizeBytes: 5 }],
      },
    },
    files: {
      f1: {
        document: { ref: "f1", label: "readme.md", mediaType: "text/plain", sizeBytes: 11, digest: DIGEST },
        text: "hello world",
      },
      f3: {
        document: { ref: "f3", label: "todo.md", mediaType: "text/plain", sizeBytes: 5, digest: DIGEST },
        text: "later",
      },
    },
    ...overrides,
  };
}

function plainFixture(): MemoryWorkspaceFixture {
  const base = fixture();
  const file = base.files.f1!;
  return {
    ...base,
    files: {
      ...base.files,
      f1: {
        ...file,
        document: { ...file.document, label: "readme.txt" },
      },
    },
  };
}

/** A layout API that records intents instead of owning a real reducer. */
function fakeWorkspace(panels: LayoutPanel[] = [], openResult = true): WorkspaceApi & {
  opened: ResourceLink[];
  /** The same opens, with the options — which module a `view` hint named. */
  intents: Array<{ resource: ResourceLink; view: string | undefined; context?: Readonly<Record<string, string>> }>;
  closed: string[];
} {
  const opened: ResourceLink[] = [];
  const intents: Array<{ resource: ResourceLink; view: string | undefined; context?: Readonly<Record<string, string>> }> = [];
  const closed: string[] = [];
  return {
    state: { panels, active: {} as never, focused: null, narrow: false, drilledIn: false, seq: 0 },
    open: (resource, options) => {
      opened.push(resource);
      intents.push({ resource, view: options?.view, ...(options?.context ? { context: options.context } : {}) });
      return openResult;
    },
    openIntent: () => true,
    focus: () => undefined,
    close: (panelId) => {
      closed.push(panelId);
    },
    report: () => undefined,
    back: () => undefined,
    opened,
    intents,
    closed,
  };
}

function panel(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    panelId: "files",
    moduleId: FILE_TREE_MODULE_ID,
    slot: "navigation",
    resourceRef: null,
    resourceKind: null,
    label: "工作区文件",
    status: "ready",
    reason: "",
    detail: "",
    config: null,
    context: null,
    ...overrides,
  };
}

const moduleOf = (id: string) => WORKSPACE_FILES_MODULES.find((entry) => entry.manifest.id === id)!.component;

function mount(port: MemoryWorkspaceFilesPort, children: ReactNode, annotations?: FileAnnotationsAdapter) {
  return render(
    <WorkspaceFilesProvider port={port.port} {...(annotations ? { annotations } : {})}>
      {children}
    </WorkspaceFilesProvider>,
  );
}

function withDownload(
  inner: MemoryWorkspaceFilesPort,
  ref: string,
  label: string,
  bytes: Uint8Array,
) {
  const digest = `sha256:${"b".repeat(64)}`;
  const encoded = btoa(String.fromCharCode(...bytes));
  let downloadCalls = 0;
  return {
    ...inner,
    get downloadCalls() {
      return downloadCalls;
    },
    port: {
      ...inner.port,
      async downloadFile(asked: string) {
        downloadCalls += 1;
        if (asked !== ref) {
          return { ok: false as const, code: "unknown_ref" as const, message: "unknown" };
        }
        let sent = false;
        const stream = createResourceStream<WorkspaceDownloadChunk>({
          metadata: {
            payload: WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD,
            mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
            totalBytes: bytes.length,
            digest,
          },
          async pull() {
            if (sent) return { kind: "end" as const };
            sent = true;
            return {
              kind: "chunk" as const,
              value: { offset: 0, bytes: bytes.length, data: encoded },
              bytes: bytes.length,
            };
          },
          close() {},
        }, {
          maxChunkBytes: WORKSPACE_DOWNLOAD_LIMITS.chunkBytes,
          maxStreamBytes: WORKSPACE_DOWNLOAD_LIMITS.maxBytes,
        });
        return {
          ok: true as const,
          value: {
            document: {
              ref,
              label,
              mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
              sizeBytes: bytes.length,
              digest,
            },
            stream,
          },
        };
      },
    },
  };
}

/** CodeMirror may split a selected word into decoration spans. */
function viewerText(): string {
  return document.querySelector(".wstext .cm-content")?.textContent ?? "";
}

describe("file reveal affordance", () => {
  it("does not guess a location for a file opened without listing context", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const current = panel({ moduleId: FILE_VIEWER_MODULE_ID, resourceRef: "f1", resourceKind: WORKSPACE_TEXT_RESOURCE_KIND, label: "readme.md" });
    const reveal = vi.fn();
    render(<WorkspaceFilesProvider port={port.port} navigation={{ scope: Symbol(), reveal, current: null }}>
      <Viewer panel={current} workspace={fakeWorkspace([current])} />
    </WorkspaceFilesProvider>);
    const button = await screen.findByRole("button", { name: "在文件索引中定位此文件" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("缺少文件的目录定位信息"));
    await userEvent.click(button);
    expect(reveal).not.toHaveBeenCalled();
    expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(0);
  });
});

describe("the file tree", () => {
  it("enumerates roots on mount and lists a directory only when it is opened", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={workspace} />);

    await screen.findByText("octopus");
    // One enumeration, and NOT a single listing: walking the tree on mount would
    // be one capability call — and potentially one approval card — per directory
    // nobody asked to see.
    expect(port.calls).toEqual([{ method: "refreshRoots" }]);

    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");
    expect(port.calls).toEqual([{ method: "refreshRoots" }, { method: "listDirectory", ref: "r1" }]);
    // Still lazy one level down.
    expect(screen.queryByText("todo.md")).toBeNull();

    await userEvent.click(screen.getByText("notes"));
    await screen.findByText("todo.md");
    expect(port.calls).toHaveLength(3);
  });

  it("does not re-list a directory that is collapsed and opened again", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("octopus");

    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");
    await userEvent.click(screen.getByText("octopus"));
    await waitFor(() => expect(screen.queryByText("readme.md")).toBeNull());
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");

    // Two calls total: the enumeration and ONE listing. A cache miss on every
    // re-open would turn idle fiddling into a stream of Gate calls.
    expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(1);
  });

  it("keeps an `other` entry unopenable but opens an over-preview-limit file", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={workspace} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");

    // The symlink is reported and has no control at all — not a disabled one.
    const link = screen.getByText("link").closest("li")!;
    expect(link.querySelector("button")).toBeNull();

    const huge = screen.getByText("huge.log").closest("button")!;
    expect(huge).toBeEnabled();
    await userEvent.click(huge);
    expect(workspace.opened).toEqual([
      { kind: WORKSPACE_TEXT_RESOURCE_KIND, ref: "f2", label: "huge.log" },
    ]);
  });

  it("opens by opaque ref and carries only listing evidence for relative resources", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={workspace} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await userEvent.click(await screen.findByText("readme.md"));

    expect(workspace.opened).toHaveLength(1);
    const link = workspace.opened[0]!;
    expect(link.kind).toBe(WORKSPACE_TEXT_RESOURCE_KIND);
    expect(link.ref).toBe("f1");
    expect(link.label).toBe("readme.md");
    expect(link.suggestedView).toBeUndefined();
    // A producer names the resource, not the consumer. The composition may
    // route this to FileViewer, CodeEditor or another compatible module.
    expect(Object.keys(link).sort()).toEqual(["kind", "label", "ref"]);
    expect(workspace.intents[0]!.context).toEqual({
      workspace_annotation_root: "display:laptop:octopus",
      workspace_file_labels: "readme.md",
      workspace_root_ref: "r1",
    });
    // Clicking it again raises the SAME intent; deciding it is the panel already
    // on screen is the coordinator's job, not this module's.
    await userEvent.click(screen.getByText("readme.md"));
    expect(workspace.opened).toHaveLength(2);
    expect(workspace.opened[1]).toEqual(link);
  });

  it("offers an edit control only when the composition named a module for it", async () => {
    // The tree names no editor: which module edits a file is a composition
    // decision, supplied per instance (decision 7). Unset means the control does
    // not exist, rather than existing and refusing — the same rule an `other`
    // entry's missing ref relies on.
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={workspace} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("routes the edit control to the module the composition named, and a click to the default", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel({ config: { edit_view: "workspace.editor/v1" } })} workspace={workspace} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));

    // A plain click still goes wherever `workspace-text` normally goes: opening
    // a file stays a read, and reaching a writable pane takes a second gesture.
    await userEvent.click(await screen.findByText("readme.md"));
    expect(workspace.intents[0]).toMatchObject({ view: undefined });
    expect(workspace.intents[0]!.resource.ref).toBe("f1");

    const row = screen.getByText("readme.md").closest("li")!;
    await userEvent.click(row.querySelector<HTMLButtonElement>(".wsedit-open")!);
    expect(workspace.intents[1]).toMatchObject({ view: "workspace.editor/v1" });
    expect(workspace.intents[1]!.resource.ref).toBe("f1");
    // Still an opaque ref and a label, and still no suggested view on the link
    // itself: the hint is the intent's, so the producer has not started naming
    // implementations inside the resource.
    expect(Object.keys(workspace.intents[1]!.resource).sort()).toEqual(["kind", "label", "ref"]);
  });

  it("renders a compact accessible tree row with trusted metadata", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture({
      directories: {
        r1: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          entries: [{
            ref: "f1",
            label: "readme.md",
            kind: "file",
            sizeBytes: 11,
            modifiedAt: "2026-08-13T12:34:56.000Z",
          }],
        },
      },
    }));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, (
      <Tree
        panel={panel({ config: { edit_view: "workspace.editor/v1" } })}
        workspace={fakeWorkspace()}
      />
    ));
    await userEvent.click(await screen.findByText("octopus"));

    const row = (await screen.findByText("readme.md")).closest("li")!;
    expect(row).toHaveAttribute("role", "treeitem");
    expect(row).toHaveAttribute("aria-level", "2");
    expect(row.querySelector(".wsfile")).toHaveAttribute(
      "title",
      "readme.md · 11 B · 修改于 2026-08-13T12:34:56.000Z",
    );
    expect(row.querySelector(".wsglyph")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "编辑 readme.md" })).toBeInTheDocument();
  });

  it("selects a file only after the coordinator accepts its open or edit intent", async () => {
    // A v2 template can refuse when its dynamic-panel limit is full. The tree
    // must not claim a resource is open merely because it asked.
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace([], false);
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel({ config: { edit_view: "workspace.editor/v1" } })} workspace={workspace} />);
    await userEvent.click(await screen.findByText("octopus"));

    const row = (await screen.findByText("readme.md")).closest("li")!;
    await userEvent.click(row.querySelector<HTMLButtonElement>(".wsfile")!);
    expect(workspace.intents.at(-1)).toMatchObject({ view: undefined });
    expect(row).not.toHaveAttribute("aria-selected", "true");

    await userEvent.click(row.querySelector<HTMLButtonElement>(".wsedit-open")!);
    expect(workspace.intents.at(-1)).toMatchObject({ view: "workspace.editor/v1" });
    expect(row).not.toHaveAttribute("aria-selected", "true");
  });

  it("does not offer to edit what it cannot open", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel({ config: { edit_view: "workspace.editor/v1" } })} workspace={workspace} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");

    // The over-limit file's edit button is disabled for the same reason its open
    // button is; the symlink has neither, because it has no ref to submit.
    const huge = screen.getByText("huge.log").closest("li")!;
    expect(huge.querySelector<HTMLButtonElement>(".wsedit-open")).toBeDisabled();
    const link = screen.getByText("link").closest("li")!;
    expect(link.querySelector(".wsedit-open")).toBeNull();
  });

  it("offers to edit a file past one call's write window: saving is staged, not capped", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture({
      directories: {
        r1: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          entries: [{
            ref: "f1",
            label: "large-readable.txt",
            kind: "file",
            sizeBytes: WORKSPACE_FILES_LIMITS.maxWriteTextBytes + 1,
          }],
        },
      },
    }));
    const workspace = fakeWorkspace();
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel({ config: { edit_view: "workspace.editor/v1" } })} workspace={workspace} />);
    await userEvent.click(await screen.findByText("octopus"));
    const row = (await screen.findByText("large-readable.txt")).closest("li")!;

    expect(row.querySelector<HTMLButtonElement>(".wsfile")).toBeEnabled();
    expect(row.querySelector<HTMLButtonElement>(".wsedit-open")).toBeEnabled();
    expect(row.querySelector<HTMLButtonElement>(".wsedit-open")).toHaveAttribute("title", "在编辑器里打开");
  });

  it("lists a directory of 1,200 entries completely, one 加载更多 page at a time", async () => {
    const entries = [
      ...Array.from({ length: 200 }, (_, i) => ({ ref: `d${i}`, label: `dir${String(i).padStart(3, "0")}`, kind: "directory" as const })),
      ...Array.from({ length: 1_000 }, (_, i) => ({ ref: `f${i}`, label: `file${String(i).padStart(4, "0")}.ts`, kind: "file" as const, sizeBytes: 1 })),
    ];
    const port = createMemoryWorkspaceFilesPort(fixture({
      directories: { r1: { ref: "r1", label: "octopus", truncated: false, entries } },
    }));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    fireEvent.click(await screen.findByText("octopus"));
    // 1,200 DOM rows are slow to query by text in jsdom; count rows instead.
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-av-file-row]")];
    const children = () => rows().filter((row) => row.dataset.depth === "1" && row.dataset.avFileRow !== "more");
    await waitFor(() => expect(children()).toHaveLength(500));
    // The control sits after the last loaded row, and says nothing was lost.
    expect(rows().at(-1)!.dataset.avFileRow).toBe("more");

    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-av-file-more]")!);
    await waitFor(() => expect(children()).toHaveLength(1_000));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-av-file-more]")!);
    await waitFor(() => expect(children()).toHaveLength(1_200));
    expect(document.querySelector("[data-av-file-more]")).toBeNull();

    const labels = children().map((row) => row.querySelector(".wslabel")?.textContent);
    expect(new Set(labels).size).toBe(1_200);
    expect(labels.at(-1)).toBe("file0999.ts");
    expect(port.calls.filter((call) => call.method === "listDirectory").map((call) => call.after)).toEqual([
      undefined,
      "file/file0299.ts",
      "file/file0799.ts",
    ]);
  }, 60_000);

  it("loads the next roots page instead of saying the rest were dropped", async () => {
    const roots = Array.from({ length: 70 }, (_, i) => ({ ref: `root${i}`, label: `ws${String(i).padStart(2, "0")}`, sourceLabel: "laptop" }));
    const port = createMemoryWorkspaceFilesPort(fixture({ roots: { roots, truncated: false } }));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("ws63");
    expect(screen.queryByText("ws64")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "加载更多工作区" }));
    await screen.findByText("ws69");
    expect(screen.queryByRole("button", { name: "加载更多工作区" })).toBeNull();
    expect(port.calls.filter((call) => call.method === "refreshRoots")).toEqual([
      { method: "refreshRoots" },
      { method: "refreshRoots", after: "root63" },
    ]);
  });

  it("keeps the loaded rows and says why when the next page is refused", async () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({ ref: `f${i}`, label: `f${String(i).padStart(3, "0")}`, kind: "file" as const }));
    const inner = createMemoryWorkspaceFilesPort(fixture({
      directories: { r1: { ref: "r1", label: "octopus", truncated: false, entries } },
    }));
    const port = {
      ...inner,
      port: {
        ...inner.port,
        async listDirectory(ref: string, after?: string) {
          if (after) return { ok: false as const, code: "too_large" as const, message: "设备上的 Runner 版本较旧，升级 Runner 后即可完整访问。" };
          return inner.port.listDirectory(ref);
        },
      },
    };
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await userEvent.click(await screen.findByText("octopus"));
    await waitFor(() => expect(document.querySelector("[data-av-file-more]")).toBeEnabled());
    // Keep the accessible-button assertion local to the paging row; querying
    // every file button's accessible name makes jsdom scan hundreds of styles.
    const more = () => within(document.querySelector<HTMLElement>('[data-av-file-row="more"]')!)
      .getByRole("button", { name: "加载更多" });
    await userEvent.click(more());
    await screen.findByText(/升级 Runner/);
    expect(screen.getByText("f499")).toBeTruthy();
    expect(more()).toBeEnabled();
  });

  it("shows a refused listing as that row's own state, without losing the tree", async () => {
    const port = createMemoryWorkspaceFilesPort(
      fixture({ refusals: { r1: { code: "approval_required", message: "需要设备主人确认" } } }),
    );
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));

    expect(await screen.findByText(/需要设备主人确认/)).toBeInTheDocument();
    // The root is still there and still expandable: a refusal is one row's
    //状态, not a broken panel.
    expect(screen.getByText("octopus")).toBeInTheDocument();
  });

  it("reports a refused enumeration instead of rendering an empty workspace", async () => {
    const port = createMemoryWorkspaceFilesPort(
      fixture({ roots: { roots: [], truncated: false }, refusals: {} }),
    );
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    // "Nothing to show" and "we were refused" must not look the same.
    expect(await screen.findByText(/还没有可浏览的工作区/)).toBeInTheDocument();
  });
});

describe("the file viewer", () => {
  const viewerPanel = (ref: string | null) =>
    panel({
      panelId: "file-viewer",
      moduleId: FILE_VIEWER_MODULE_ID,
      slot: "secondary",
      resourceRef: ref,
      resourceKind: ref ? WORKSPACE_TEXT_RESOURCE_KIND : null,
      label: ref ? "readme.md" : "文件内容",
    });

  it("says to choose a file while it is standing and unbound", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(port, <Viewer panel={viewerPanel(null)} workspace={fakeWorkspace()} />);
    expect(await screen.findByText("选择一个文件")).toBeInTheDocument();
    expect(port.calls.some((call) => call.method === "openText")).toBe(false);
    expect(port.calls.some((call) => call.method === "refreshRoots")).toBe(false);
  });

  it("renders Markdown by default and hands the same opaque ref to the configured editor", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace();
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(
      port,
      <Viewer
        panel={{ ...viewerPanel("f1"), config: { edit_view: "workspace.editor/v1" }, context: { workspace_root_ref: "root", workspace_file_labels: "notes.md" } }}
        workspace={workspace}
      />,
    );

    const preview = await screen.findByLabelText("Markdown 预览：readme.md");
    expect(preview).toHaveTextContent("hello world");
    expect(document.querySelector(".wstext .cm-content")).toBeNull();
    expect(screen.getByRole("group", { name: "浏览或编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 readme.md" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(workspace.intents).toEqual([{
      resource: { kind: WORKSPACE_TEXT_RESOURCE_KIND, ref: "f1", label: "readme.md" },
      view: "workspace.editor/v1",
      context: { workspace_root_ref: "root", workspace_file_labels: "notes.md" },
    }]);
    expect(workspace.closed).toEqual(["file-viewer"]);
  });

  it("keeps a Markdown annotation selection that spans several rendered blocks", async () => {
    const text = "# First heading\n\nFirst paragraph.\n\n## Second heading\n\nSecond paragraph.";
    const base = fixture();
    const port = createMemoryWorkspaceFilesPort({
      ...base,
      files: {
        ...base.files,
        f1: { ...base.files.f1!, text },
      },
    });
    const annotations: FileAnnotationsAdapter = {
      read: () => [],
      save: vi.fn(async () => ({ ok: true as const })),
    };
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(
      port,
      <Viewer
        panel={{
          ...viewerPanel("f1"),
          context: {
            workspace_annotation_root: "display:laptop:octopus",
            workspace_file_labels: "readme.md",
            workspace_root_ref: "r1",
          },
        }}
        workspace={fakeWorkspace()}
      />,
      annotations,
    );

    const preview = await screen.findByLabelText("Markdown 预览：readme.md");
    const heading = within(preview).getByRole("heading", { name: "First heading" });
    const finalParagraph = within(preview).getByText("Second paragraph.");
    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.setEnd(finalParagraph.firstChild!, finalParagraph.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const displayedSelection = vi.spyOn(selection, "toString").mockReturnValue(
      "First heading\n\nFirst paragraph.\n\nSecond heading\n\nSecond paragraph.",
    );
    await act(async () => document.dispatchEvent(new Event("selectionchange")));

    await userEvent.click(screen.getByRole("button", { name: "新增批注" }));

    const composer = screen.getByRole("dialog", { name: "新增批注" });
    const quote = composer.querySelector("blockquote")?.textContent;
    displayedSelection.mockRestore();
    expect(quote).toBe("First heading\nFirst paragraph.\nSecond heading\nSecond paragraph.");
  });

  it("restores annotation text only for the exact selection and clears it on cancel", async () => {
    const text = "# First heading\n\nFirst paragraph.\n\n## Second heading\n\nSecond paragraph.";
    let at = 1_000;
    const values = new Map<string, FileAnnotationDraftRecord>();
    const listeners = new Map<string, Set<(record: FileAnnotationDraftRecord) => void>>();
    const drafts: FileAnnotationDraftStore = {
      get: (key) => values.get(key) ?? { text: "", updatedAt: 0 },
      set: (key, note) => {
        const record = { text: note, updatedAt: ++at };
        values.set(key, record);
        for (const listener of listeners.get(key) ?? []) listener(record);
      },
      subscribe: (key, listener) => {
        const set = listeners.get(key) ?? new Set();
        set.add(listener);
        listeners.set(key, set);
        return () => { set.delete(listener); };
      },
    };
    const annotations: FileAnnotationsAdapter = {
      read: () => [],
      save: vi.fn(async () => ({ ok: true as const })),
      drafts,
    };
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const panel = {
      ...viewerPanel("f1"),
      context: {
        workspace_annotation_root: "display:laptop:octopus",
        workspace_file_labels: "readme.md",
        workspace_root_ref: "r1",
      },
    };
    const open = () => mount(
      createMemoryWorkspaceFilesPort({
        ...fixture(),
        files: { ...fixture().files, f1: { ...fixture().files.f1!, text } },
      }),
      <Viewer panel={panel} workspace={fakeWorkspace()} />,
      annotations,
    );
    const select = async (label: string) => {
      const preview = await screen.findByLabelText("Markdown 预览：readme.md");
      const node = within(preview).getByRole("heading", { name: label }).firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      await act(async () => document.dispatchEvent(new Event("selectionchange")));
      await userEvent.click(screen.getByRole("button", { name: "新增批注" }));
      return screen.getByRole("textbox", { name: "批注内容" }) as HTMLTextAreaElement;
    };

    const first = open();
    const firstNote = await select("First heading");
    await userEvent.type(firstNote, "刷新前写到一半");
    first.unmount();

    const other = open();
    expect(await select("Second heading")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    other.unmount();

    const restored = open();
    expect(await select("First heading")).toHaveValue("刷新前写到一半");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    restored.unmount();

    open();
    expect(await select("First heading")).toHaveValue("");
  });

  it("keeps the viewer when the coordinator refuses the edit handoff", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const workspace = fakeWorkspace([], false);
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(
      port,
      <Viewer
        panel={{ ...viewerPanel("f1"), config: { edit_view: "workspace.editor/v1" } }}
        workspace={workspace}
      />,
    );

    await screen.findByLabelText("Markdown 预览：readme.md");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(workspace.closed).toEqual([]);
  });

  it("pulls a bound file to the end and shows the fields the contract carries", async () => {
    // A tiny chunk so the read genuinely takes several pulls.
    const port = createMemoryWorkspaceFilesPort({ ...plainFixture(), chunkBytes: 3 });
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(port, <Viewer panel={viewerPanel("f1")} workspace={fakeWorkspace()} />);

    await waitFor(() => expect(viewerText()).toBe("hello world"));
    expect(screen.getByText(/text\/plain/)).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(document.querySelector(".wstext .cm-lineNumbers")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(document.querySelector('.wstext .cm-search input[name="search"]')).toBeInTheDocument();
    expect(document.querySelector('.wstext .cm-search input[name="replace"]')).toBeNull();
    // The stream reached a definite end and was released.
    await waitFor(() => expect(port.openStreams).toBe(0));
  });

  it("discards a late answer when the panel's resource changed", async () => {
    const port = createMemoryWorkspaceFilesPort({ ...plainFixture(), chunkBytes: 1 });
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const view = mount(port, <Viewer panel={viewerPanel("f1")} workspace={fakeWorkspace()} />);

    // Swap the resource mid-read. The previous file's chunks must not land under
    // the new file's header — the header would be right, which is what makes
    // that failure invisible.
    view.rerender(
      <WorkspaceFilesProvider port={port.port}>
        <Viewer panel={{ ...viewerPanel("f3"), label: "todo.md" }} workspace={fakeWorkspace()} />
      </WorkspaceFilesProvider>,
    );

    await waitFor(() => expect(screen.getByText("later")).toBeInTheDocument());
    expect(screen.queryByText(/hello/)).toBeNull();
    await waitFor(() => expect(port.openStreams).toBe(0));
  });

  it("hides the previous scope's text while a replacement port is still loading", async () => {
    const first = createMemoryWorkspaceFilesPort(plainFixture());
    const next = createMemoryWorkspaceFilesPort(plainFixture());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedPort = {
      ...next.port,
      openText: async (ref: string) => {
        await gate;
        return next.port.openText(ref);
      },
    } as typeof next.port;
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const committedText: string[] = [];
    function CommitProbe({ children }: { children: ReactNode }) {
      // Layout effects observe the committed DOM before passive effects run.
      // A plain assertion after Testing Library's rerender would miss the bug,
      // because `act()` also flushes the effect that eventually clears it.
      useLayoutEffect(() => {
        committedText.push(document.querySelector(".wstext .cm-content")?.textContent ?? "");
      });
      return children;
    }
    const tree = (port: typeof first.port, ref: "f1" | "f3") => (
      <CommitProbe>
        <WorkspaceFilesProvider port={port}>
          <Viewer
            panel={ref === "f1" ? viewerPanel(ref) : { ...viewerPanel(ref), label: "todo.md" }}
            workspace={fakeWorkspace()}
          />
        </WorkspaceFilesProvider>
      </CommitProbe>
    );
    const view = render(tree(first.port, "f1"));
    await waitFor(() => expect(viewerText()).toBe("hello world"));
    committedText.length = 0;

    view.rerender(tree(delayedPort, "f3"));

    // The new scope has not answered yet. Old bytes and metadata must already
    // be gone; waiting for a passive effect to clear them permits one committed
    // cross-scope paint in a real browser.
    expect(viewerText()).not.toContain("hello world");
    expect(screen.queryByText("readme.txt")).toBeNull();
    expect(screen.getByText("todo.md")).toBeInTheDocument();
    expect(committedText[0]).toBe("");

    await act(async () => release());
    await screen.findByText("later");
  });

  it("closes its stream when the panel unmounts", async () => {
    const port = createMemoryWorkspaceFilesPort({ ...plainFixture(), chunkBytes: 1 });
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const view = mount(port, <Viewer panel={viewerPanel("f1")} workspace={fakeWorkspace()} />);
    await waitFor(() => expect(port.calls.some((call) => call.method === "openText")).toBe(true));

    await act(async () => {
      view.unmount();
    });
    await waitFor(() => expect(port.openStreams).toBe(0));
  });

  it("renders every refusal as readable panel-local state, not an exception", async () => {
    for (const [code, sentence] of [
      ["approval_required", /可信审批栏/],
      ["too_large", /backend text/],
      ["not_text", /不是 UTF-8 文本/],
      ["outside_workspace", /工作区之外/],
      ["no_authority", /没有读取工作区文件的授权/],
    ] as const) {
      const port = createMemoryWorkspaceFilesPort(
        fixture({ refusals: { f1: { code, message: "backend text" } } }),
      );
      const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
      const view = mount(port, <Viewer panel={viewerPanel("f1")} workspace={fakeWorkspace()} />);
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("keeps download available when text preview refuses the format", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const port = withDownload(
      createMemoryWorkspaceFilesPort(
        fixture({ refusals: { f2: { code: "not_text", message: "binary" } } }),
      ),
      "f2",
      "archive.bin",
      bytes,
    );
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:workspace-download");
    const revokeObjectURL = vi.fn();
    const OriginalURL = globalThis.URL;
    class DownloadURL extends OriginalURL {}
    Object.assign(DownloadURL, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("URL", DownloadURL);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      mount(
        port,
        <Viewer
          panel={{ ...viewerPanel("f2"), label: "archive.bin" }}
          workspace={fakeWorkspace()}
        />,
      );

      expect(await screen.findByRole("region", { name: "无法在线浏览 archive.bin" }))
        .toBeInTheDocument();
      const controls = screen.getAllByRole("button", { name: "下载 archive.bin" });
      expect(controls).toHaveLength(1);
      await userEvent.click(controls[0]!);
      expect(await screen.findByText("文件已完整接收，浏览器保存已开始。")).toBeInTheDocument();

      expect(port.downloadCalls).toBe(1);
      expect(anchorClick).toHaveBeenCalledTimes(1);
      const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
      expect(anchor.target).toMatch(/^av-download-/);
      expect(document.querySelector(`iframe[name="${anchor.target}"][sandbox][hidden]`)).toBeTruthy();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]![0];
      const contents = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
      });
      expect([...new Uint8Array(contents)]).toEqual([...bytes]);
    } finally {
      anchorClick.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("offers to close only a panel that was opened for a file", async () => {
    const port = createMemoryWorkspaceFilesPort(plainFixture());
    const workspace = fakeWorkspace();
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    mount(port, <Viewer panel={viewerPanel("f1")} workspace={workspace} />);
    await waitFor(() => expect(viewerText()).toBe("hello world"));

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(workspace.closed).toEqual(["file-viewer"]);
  });
});

describe("request lifecycle", () => {
  /** A port whose answers are held until the test releases them. */
  function deferredPort(inner: MemoryWorkspaceFilesPort) {
    const gates: Array<() => void> = [];
    return {
      calls: inner.calls,
      release() {
        for (const open of gates.splice(0)) open();
      },
      port: {
        contract: inner.port.contract,
        refreshRoots: async () => {
          const answer = inner.port.refreshRoots();
          await new Promise<void>((resolve) => gates.push(resolve));
          return await answer;
        },
        listDirectory: (ref: string) => inner.port.listDirectory(ref),
        openText: (ref: string) => inner.port.openText(ref),
      } as typeof inner.port,
    };
  }

  /** Directory answers are released individually, in issue order. */
  function deferredDirectories(inner: MemoryWorkspaceFilesPort) {
    const gates: Array<() => void> = [];
    return {
      calls: inner.calls,
      release(index: number) {
        gates[index]?.();
      },
      port: {
        contract: inner.port.contract,
        refreshRoots: () => inner.port.refreshRoots(),
        listDirectory: async (ref: string) => {
          const answer = inner.port.listDirectory(ref);
          await new Promise<void>((resolve) => gates.push(resolve));
          return await answer;
        },
        openText: (ref: string) => inner.port.openText(ref),
      } as typeof inner.port,
    };
  }

  it("enumerates roots ONCE under StrictMode's setup/cleanup/setup probe", async () => {
    // The probe re-runs the effect with the SAME port object. Treating that as a
    // new scope would spend a second capability call — and one call is one
    // approval card, so a duplicate is not merely wasteful.
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    render(
      <StrictMode>
        <WorkspaceFilesProvider port={port.port}>
          <Tree panel={panel()} workspace={fakeWorkspace()} />
        </WorkspaceFilesProvider>
      </StrictMode>,
    );
    await screen.findByText("octopus");
    expect(port.calls.filter((call) => call.method === "refreshRoots")).toHaveLength(1);
  });

  it("lists a directory ONCE under StrictMode, even though updaters run twice", async () => {
    // The specific defect: the load used to be issued from inside a `setCache`
    // updater, and React calls an updater twice in StrictMode to surface impure
    // ones. That sent two `listDirectory` calls for one click.
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    render(
      <StrictMode>
        <WorkspaceFilesProvider port={port.port}>
          <Tree panel={panel()} workspace={fakeWorkspace()} />
        </WorkspaceFilesProvider>
      </StrictMode>,
    );
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");
    expect(port.calls.filter((call) => call.method === "listDirectory")).toEqual([
      { method: "listDirectory", ref: "r1" },
    ]);
  });

  it("opens text ONCE under StrictMode's effect probe", async () => {
    const port = createMemoryWorkspaceFilesPort({ ...plainFixture(), chunkBytes: 2 });
    const Viewer = moduleOf(FILE_VIEWER_MODULE_ID);
    render(
      <StrictMode>
        <WorkspaceFilesProvider port={port.port}>
          <Viewer
            panel={panel({
              panelId: "viewer",
              moduleId: FILE_VIEWER_MODULE_ID,
              slot: "secondary",
              resourceRef: "f1",
              resourceKind: WORKSPACE_TEXT_RESOURCE_KIND,
              label: "readme.md",
            })}
            workspace={fakeWorkspace()}
          />
        </WorkspaceFilesProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(viewerText()).toBe("hello world"));
    expect(port.calls.filter((call) => call.method === "openText")).toEqual([
      { method: "openText", ref: "f1" },
    ]);
    await waitFor(() => expect(port.openStreams).toBe(0));
  });

  it("does not let a replaced port's late root answer win", async () => {
    // The provider used to share one `busy` boolean and one `live` boolean
    // across ports, so an old port's slow reply both overwrote the new port's
    // roots and cleared its in-flight flag — leaving the wrong workspaces on
    // screen with no way to refresh out of it.
    const old = deferredPort(createMemoryWorkspaceFilesPort(fixture()));
    const next = createMemoryWorkspaceFilesPort(
      fixture({ roots: { roots: [{ ref: "r9", label: "second-scope", sourceLabel: "desktop" }], truncated: false } }),
    );
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    const view = render(
      <WorkspaceFilesProvider port={old.port}>
        <Tree panel={panel()} workspace={fakeWorkspace()} />
      </WorkspaceFilesProvider>,
    );
    // Swap the port before the first enumeration has answered.
    view.rerender(
      <WorkspaceFilesProvider port={next.port}>
        <Tree panel={panel()} workspace={fakeWorkspace()} />
      </WorkspaceFilesProvider>,
    );
    await screen.findByText("second-scope");

    await act(async () => {
      old.release();
      await Promise.resolve();
    });
    // The old scope's workspaces never appear, and the new scope is intact.
    expect(screen.queryByText("octopus")).toBeNull();
    expect(screen.getByText("second-scope")).toBeInTheDocument();

    // And the provider is not wedged: an explicit refresh still reaches the
    // CURRENT port.
    const before = next.calls.filter((call) => call.method === "refreshRoots").length;
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(next.calls.filter((call) => call.method === "refreshRoots").length).toBe(before + 1));
  });

  it("hides ready roots and cached rows immediately when the port changes", async () => {
    const old = createMemoryWorkspaceFilesPort(fixture());
    const next = deferredPort(createMemoryWorkspaceFilesPort(
      fixture({ roots: { roots: [{ ref: "r9", label: "second-scope", sourceLabel: "desktop" }], truncated: false } }),
    ));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    const view = mount(old, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");

    view.rerender(
      <WorkspaceFilesProvider port={next.port}>
        <Tree panel={panel()} workspace={fakeWorkspace()} />
      </WorkspaceFilesProvider>,
    );
    expect(screen.queryByText("octopus")).toBeNull();
    expect(screen.queryByText("readme.md")).toBeNull();

    await act(async () => {
      next.release();
      await Promise.resolve();
    });
    expect(await screen.findByText("second-scope")).toBeInTheDocument();
  });

  it("does not let an old listing settle into or delete a refreshed request", async () => {
    const port = deferredDirectories(createMemoryWorkspaceFilesPort(fixture()));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    render(
      <WorkspaceFilesProvider port={port.port}>
        <Tree panel={panel()} workspace={fakeWorkspace()} />
      </WorkspaceFilesProvider>,
    );
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await waitFor(() => expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(1));

    // Refreshing re-issues the OPEN directory's listing itself; it no longer
    // needs the reader to close and re-open the row to get a second request.
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(2));
    await screen.findByText("octopus");
    expect(document.querySelector('.wsrow[data-kind="directory"]')).toHaveAttribute("aria-expanded", "true");

    await act(async () => {
      port.release(0);
      await Promise.resolve();
    });
    expect(screen.queryByText("readme.md")).toBeNull();

    await act(async () => {
      port.release(1);
      await Promise.resolve();
    });
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });

  it("treats hostile-but-valid opaque refs as data, not object properties", async () => {
    const directories = Object.fromEntries([
      ["__proto__", {
        ref: "__proto__",
        label: "hostile-root",
        truncated: false,
        entries: [{ ref: "constructor", label: "safe.txt", kind: "file" }],
      }],
    ]) as MemoryWorkspaceFixture["directories"];
    const port = createMemoryWorkspaceFilesPort(fixture({
      roots: { roots: [{ ref: "__proto__", label: "hostile-root", sourceLabel: "fixture" }], truncated: false },
      directories,
    }));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await userEvent.click(await screen.findByText("hostile-root"));
    expect(await screen.findByText("safe.txt")).toBeInTheDocument();
    expect(port.calls).toContainEqual({ method: "listDirectory", ref: "__proto__" });
  });

  it("re-lists what is open on an explicit refresh instead of collapsing the tree", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture());
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await screen.findByText("octopus");
    await userEvent.click(screen.getByText("octopus"));
    await screen.findByText("readme.md");
    const before = port.calls.filter((call) => call.method === "listDirectory").length;

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    // The open directory really is re-read — a cached listing is exactly how a
    // folder created outside the browser stayed invisible (ticket #350) …
    await waitFor(() =>
      expect(port.calls.filter((call) => call.method === "listDirectory").length).toBe(before + 1));
    // … and the reader's tree is still open when the answer lands. Collapsing it
    // made "show me what changed" cost the whole navigation they opened to get
    // there.
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
    expect(document.querySelector('.wsrow[data-kind="directory"]')).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a newly created directory while root enumeration is still pending", async () => {
    const source = fixture();
    const port = deferredPort(createMemoryWorkspaceFilesPort(source));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    render(<WorkspaceFilesProvider port={port.port}>
      <Tree panel={panel()} workspace={fakeWorkspace()} />
    </WorkspaceFilesProvider>);
    await act(async () => { port.release(); });
    await userEvent.click(await screen.findByText("octopus"));
    await screen.findByText("readme.md");
    source.directories = { ...source.directories, r1: {
      ...source.directories.r1!, entries: [
        ...source.directories.r1!.entries,
        { ref: "d_new", label: "r06-20260907", kind: "directory" },
      ],
    } };

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("r06-20260907")).toBeVisible();
    expect(screen.getByText("正在列出工作区")).toBeInTheDocument();
    expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(port.calls.filter((call) => call.method === "refreshRoots")).toHaveLength(2);
    await act(async () => { port.release(); });
    expect(screen.getByText("r06-20260907")).toBeVisible();
    expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(2);
  });

  it("hides dot-prefixed entries by default and reveals them from the tree's own knob", async () => {
    const port = createMemoryWorkspaceFilesPort(fixture({
      directories: {
        r1: {
          ref: "r1",
          label: "octopus",
          truncated: false,
          entries: [
            { ref: "d2", label: ".git", kind: "directory" },
            { ref: "f1", label: "readme.md", kind: "file", sizeBytes: 11 },
          ],
        },
      } as MemoryWorkspaceFixture["directories"],
    }));
    const Tree = moduleOf(FILE_TREE_MODULE_ID);
    mount(port, <Tree panel={panel()} workspace={fakeWorkspace()} />);
    await userEvent.click(await screen.findByText("octopus"));
    await screen.findByText("readme.md");
    expect(screen.queryByText(".git")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "显示隐藏项" }));
    expect(await screen.findByText(".git")).toBeInTheDocument();
    // A display filter only: revealing them does not re-ask the device.
    expect(port.calls.filter((call) => call.method === "listDirectory")).toHaveLength(1);
  });
});
