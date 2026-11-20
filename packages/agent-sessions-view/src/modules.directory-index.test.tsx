import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { COMPOSITION_SCHEMA, type AgentComposition } from "@claude-bot/agent-module-contract";
import type { SessionsPort } from "@claude-bot/agent-sessions-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
} from "@claude-bot/agent-view-react/workspace";
import type { WorkspaceFilesController } from "@claude-bot/agent-workspace-files-view";
import { createMemoryWorkspaceFilesPort } from "@claude-bot/agent-workspace-files-view/harness";
import type { WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import { SessionsProvider } from "./context.js";
import { createMemorySessionsPort } from "./harness/memory-port.js";
import {
  AGENT_CHAT_MODULE_ID,
  SESSION_DIRECTORY_INDEX_MODULE_ID,
} from "./manifests.js";
import { SESSIONS_MODULES } from "./modules.js";

const optionalFiles = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@claude-bot/agent-workspace-files-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claude-bot/agent-workspace-files-view")>();
  return {
    ...actual,
    useOptionalWorkspaceFiles: () => optionalFiles.current,
  };
});

const ROOT_KEY = "dk1_aaaaaaaaaaaaaaaa";
const ROOTS = {
  roots: [{
    ref: "ref_project",
    label: "project",
    sourceLabel: "laptop",
    directoryKey: ROOT_KEY,
  }],
  truncated: false,
} as unknown as WorkspaceFilesRoots;

const COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "directory-provider-stability-test",
  instances: [
    { instance: "directory", module: SESSION_DIRECTORY_INDEX_MODULE_ID, slot: "navigation" },
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
  ],
  open: [{ resource: "session", module: AGENT_CHAT_MODULE_ID, slot: "primary" }],
};

function filesController(): WorkspaceFilesController {
  const memory = createMemoryWorkspaceFilesPort({
    roots: ROOTS,
    directories: {
      ref_project: {
        ref: "ref_project",
        label: "project",
        entries: [],
        truncated: false,
      },
    },
    files: {},
  });
  return {
    port: memory.port,
    roots: { status: "ready", value: ROOTS, message: "", code: "" },
    refreshRoots: vi.fn(),
    refreshVersion: 0,
    annotations: null,
  };
}

function sessionsPort(): SessionsPort {
  return createMemorySessionsPort({
    sessions: [{
      resourceId: "res-1",
      deviceId: "laptop",
      deviceLabel: "laptop",
      cliKind: "codex",
      projectLabel: "provider stability",
      cwdDisplay: "~/project",
      directoryKey: ROOT_KEY,
      lastActivity: "2026-08-30T18:40:00.000Z",
      status: "live",
      resumable: false,
      messageCount: 1,
    }],
    sources: [{ kind: "runner", device: "laptop", online: true }],
    workspaces: {
      laptop: {
        device: "laptop",
        workspaces: [{ id: "ws-project", label: "project", display: "~/project", directoryKey: ROOT_KEY }],
      },
    },
  });
}

function DirectoryWorkspace({ files, port }: {
  files: WorkspaceFilesController | null;
  port: SessionsPort;
}) {
  optionalFiles.current = files;
  const plan = useMemo(
    () => createWorkspacePlan({ composition: COMPOSITION, registry: createModuleRegistry(SESSIONS_MODULES) }),
    [],
  );
  const { state, api } = useWorkspaceLayout(plan, { narrow: false });
  return (
    <SessionsProvider port={port}>
      <WorkspaceShell plan={plan} state={state} api={api} />
    </SessionsProvider>
  );
}

function indexScroller(): HTMLElement {
  const scroller = document.querySelector<HTMLElement>(".wsfiles");
  if (!scroller) throw new Error("directory index scroller did not render");
  return scroller;
}

function collapseCurrentTree(files: WorkspaceFilesController | null): void {
  if (files) {
    const row = document.querySelector<HTMLElement>(".home-device");
    const toggle = row?.querySelector<HTMLElement>(".wsdevice");
    if (!row || !toggle) throw new Error("file directory device row did not render");
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(row).toHaveAttribute("aria-expanded", "false");
    return;
  }
  const toggle = document.querySelector<HTMLElement>(".devhead .treehead");
  if (!toggle) throw new Error("session directory device row did not render");
  expect(document.querySelector(".dhead")).not.toBeNull();
  fireEvent.click(toggle);
  expect(document.querySelector(".dhead")).toBeNull();
}

function expectCurrentTreeCollapsed(files: WorkspaceFilesController | null): void {
  if (files) {
    expect(document.querySelector(".home-device")).toHaveAttribute("aria-expanded", "false");
  } else {
    expect(document.querySelector(".dhead")).toBeNull();
  }
}

describe("session directory files-provider stability", () => {
  it.each([
    { direction: "无到有", startsWithFiles: false },
    { direction: "有到无", startsWithFiles: true },
  ])("keeps expansion, hidden-entry choice and scroll when the provider switches $direction", async ({ startsWithFiles }) => {
    const user = userEvent.setup();
    const port = sessionsPort();
    const controller = filesController();
    const first = startsWithFiles ? controller : null;
    const second = startsWithFiles ? null : controller;
    const view = render(<DirectoryWorkspace files={first} port={port} />);
    // The tree lives behind the navigator's 文件 view.
    await user.click(await screen.findByRole("tab", { name: "文件树" }));

    await waitFor(() => {
      expect(document.querySelector(startsWithFiles ? ".home-device" : ".devhead .treehead")).not.toBeNull();
    });
    collapseCurrentTree(first);
    await user.click(screen.getByRole("button", { name: "显示隐藏项" }));
    expect(screen.getByRole("button", { name: "隐藏 . 开头的项" })).toBeInTheDocument();
    indexScroller().scrollTop = 137;

    view.rerender(<DirectoryWorkspace files={second} port={port} />);
    await waitFor(() => {
      expect(document.querySelector(startsWithFiles ? ".devhead .treehead" : ".home-device")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "隐藏 . 开头的项" })).toBeInTheDocument();
    expect(indexScroller().scrollTop).toBe(137);

    // Each mode uses its own semantic expansion keys. Returning proves the
    // original key set crossed the opposite provider state without reset.
    view.rerender(<DirectoryWorkspace files={first} port={port} />);
    await waitFor(() => expectCurrentTreeCollapsed(first));
  });
});

describe("session directory paging", () => {
  it("ends a long directory with 加载更多 and appends the next page in place", async () => {
    const entries = Array.from({ length: 70 }, (_, i) => ({
      ref: `ref_f${i}`,
      label: `f${String(i).padStart(3, "0")}.md`,
      kind: "file" as const,
      sizeBytes: 1,
    }));
    const memory = createMemoryWorkspaceFilesPort({
      roots: ROOTS,
      directories: { ref_project: { ref: "ref_project", label: "project", entries, truncated: false } },
      files: {},
      // A narrowed page keeps this DOM small; the contract window is the same
      // mechanism at 500.
      pageEntries: 50,
    });
    const controller: WorkspaceFilesController = {
      port: memory.port,
      roots: { status: "ready", value: ROOTS, message: "", code: "" },
      refreshRoots: vi.fn(),
      refreshVersion: 0,
      annotations: null,
    };
    render(<DirectoryWorkspace files={controller} port={sessionsPort()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "文件树" }));
    const directory = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-ref="ref_project"]');
      if (!row) throw new Error("project row not rendered");
      return row;
    });
    fireEvent.click(directory);
    await screen.findByText("f049.md");
    expect(screen.queryByText("f050.md")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await screen.findByText("f069.md");
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
    expect(memory.calls.filter((call) => call.method === "listDirectory").map((call) => call.after))
      .toEqual([undefined, "file/f049.md"]);
  });
});
