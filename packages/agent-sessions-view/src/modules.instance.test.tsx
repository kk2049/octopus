/**
 * One composition may mount the same module more than once, and a mount may be
 * bound to its own resource.
 *
 * Two things follow, and neither is visible from a single-panel test. The
 * coordinator gives each mount a stable panel id, so the sessions wiring has to
 * namespace its DOM hooks with it while preserving the historical ids on the
 * first instance (the browser acceptance suite still reads those). And a chat
 * opened FOR a session has to obtain that session's transcript itself: the
 * controller's own path follows the SELECTION, which a second chat beside the
 * first one is not — so nothing else in the workspace would ever ask.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { COMPOSITION_SCHEMA, type AgentComposition } from "@claude-bot/agent-module-contract";
import type {
  SessionOperation,
  SessionsPort,
  SessionsSnapshot,
} from "@claude-bot/agent-sessions-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
  type WorkspaceApi,
} from "@claude-bot/agent-view-react/workspace";
import { SessionsProvider } from "./context.js";
import { AgentChat } from "./components/AgentChat.js";
import { createMemorySessionsPort } from "./harness/memory-port.js";
import {
  AGENT_CHAT_MODULE_ID,
  NEW_SESSION_MODULE_ID,
  SESSION_ROSTER_MODULE_ID,
  SESSION_SEARCH_MODULE_ID,
} from "./manifests.js";
import { SESSIONS_MODULES } from "./modules.js";

const SESSION = {
  resourceId: "res-1",
  deviceId: "laptop",
  deviceLabel: "laptop",
  cliKind: "claude",
  projectLabel: "多实例",
  cwdDisplay: "~/project",
  lastActivity: new Date().toISOString(),
  status: "live",
  resumable: false,
  messageCount: 1,
};

const MULTI_CHAT_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "sessions-multi-chat-test",
  instances: [
    { instance: "search", module: SESSION_SEARCH_MODULE_ID, slot: "navigation" },
    { instance: "search-two", module: SESSION_SEARCH_MODULE_ID, slot: "navigation" },
    { instance: "roster", module: SESSION_ROSTER_MODULE_ID, slot: "navigation" },
    { instance: "roster-two", module: SESSION_ROSTER_MODULE_ID, slot: "navigation" },
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
    { instance: "chat-two", module: AGENT_CHAT_MODULE_ID, slot: "secondary" },
  ],
  open: [],
};

const MULTI_NEW_SESSION_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "sessions-multi-new-session-test",
  instances: [
    { instance: "new-session", module: NEW_SESSION_MODULE_ID, slot: "primary" },
    { instance: "new-session-two", module: NEW_SESSION_MODULE_ID, slot: "secondary" },
  ],
  open: [],
};

/** One standing chat, plus the rule that opens sibling session tabs. */
const OPEN_BESIDE_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "sessions-open-beside-test",
  instances: [
    { instance: "roster", module: SESSION_ROSTER_MODULE_ID, slot: "navigation" },
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
  ],
  open: [{ resource: "session", module: AGENT_CHAT_MODULE_ID, slot: "primary" }],
};

/** The production shape around a transient new-session form and a standing chat. */
const LAUNCH_TO_CHAT_COMPOSITION: AgentComposition = {
  schema: COMPOSITION_SCHEMA,
  app: "sessions-launch-to-chat-test",
  instances: [
    { instance: "new-session", module: NEW_SESSION_MODULE_ID, slot: "secondary" },
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary" },
  ],
  open: [{ resource: "session", module: AGENT_CHAT_MODULE_ID, slot: "primary" }],
};

function launchPort(): { port: SessionsPort; succeed(operation: SessionOperation): void; showNewSession(): Promise<unknown> } {
  const sessions = [SESSION];
  const base = createMemorySessionsPort({
    sessions,
    sources: [{ kind: "runner", device: "laptop", online: true }],
  });
  const listeners = new Set<() => void>();
  let operations: readonly SessionOperation[] = [];
  let snapshot: SessionsSnapshot = { ...base.snapshot(), operations };
  let unsubscribeBase: (() => void) | null = null;
  const publish = (): void => {
    snapshot = { ...base.snapshot(), operations };
    for (const listener of [...listeners]) listener();
  };
  const port: SessionsPort = {
    ...base,
    snapshot: (): SessionsSnapshot => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      unsubscribeBase ??= base.subscribe(publish);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribeBase?.();
          unsubscribeBase = null;
        }
      };
    },
    start: async () => ({ ok: true, result: { opId: "op-launch" }, message: "" }),
  };
  return {
    port,
    showNewSession() { sessions.push({ ...SESSION, resourceId: "res-new" }); return base.refreshSessions(); },
    succeed(operation) {
      operations = [operation];
      publish();
    },
  };
}

function Workspace({ composition, apiRef, narrow }: {
  composition: AgentComposition;
  apiRef?: { current: WorkspaceApi | null };
  narrow?: boolean;
}) {
  const plan = useMemo(
    () => createWorkspacePlan({ composition, registry: createModuleRegistry(SESSIONS_MODULES) }),
    [composition],
  );
  const { state, api } = useWorkspaceLayout(plan, { narrow: narrow ?? false });
  if (apiRef) apiRef.current = api;
  return <WorkspaceShell plan={plan} state={state} api={api} />;
}

describe("sessions module instances", () => {
  it("keeps first-instance hooks and namespaces every sibling id", async () => {
    const port = createMemorySessionsPort({
      sessions: [SESSION],
      sources: [{ kind: "runner", device: "laptop", online: true }],
      transcripts: {
        "res-1": [{ role: "assistant", blocks: [{ type: "text", text: "正文" }] }],
      },
    });
    const chatWorkspace = render(
      <SessionsProvider port={port}>
        <Workspace composition={MULTI_CHAT_COMPOSITION} />
      </SessionsProvider>,
    );

    await waitFor(() => expect(document.getElementById("composer--chat-two")).toBeTruthy());
    for (const id of [
      "search",
      "search--search-two",
      "railRefresh",
      "railRefresh--roster-two",
      "composer",
      "composer--chat-two",
    ]) {
      expect(document.getElementById(id), `missing #${id}`).toBeTruthy();
    }

    const chatIds = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(chatIds).size).toBe(chatIds.length);
    chatWorkspace.unmount();

    render(
      <SessionsProvider port={port}>
        <Workspace composition={MULTI_NEW_SESSION_COMPOSITION} />
      </SessionsProvider>,
    );
    await waitFor(() => expect(document.getElementById("newDevice--new-session-two")).toBeTruthy());
    expect(document.getElementById("newDevice")).toBeTruthy();
    const formIds = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(formIds).size).toBe(formIds.length);

    // The scope belongs to the mounted instance, not to its current ordinal, so
    // whatever happens to the first instance cannot rename its sibling.
    //
    // Closing a DECLARED instance clears it back to its standing state rather
    // than deleting it — a composition that lists eight surfaces and renders
    // seven after a click is the failure `initialLayout` already refuses to
    // produce. (In the production composition the new-agent form has no
    // standing instance at all, so its cancel button really does close it; that
    // panel is minted at runtime, and minted panels are still removed.)
    await userEvent.click(document.getElementById("cancelNew")!);
    expect(document.getElementById("newDevice")).toBeTruthy();
    expect(document.getElementById("newDevice--new-session-two")).toBeTruthy();
  });

  it("binds the first chat and opens every clicked session as a reusable Dock tab", async () => {
    const port = createMemorySessionsPort({
      sessions: [SESSION, { ...SESSION, resourceId: "res-2", projectLabel: "第二个会话" }],
      sources: [{ kind: "runner", device: "laptop", online: true }],
      transcripts: {
        "res-1": [{ role: "assistant", blocks: [{ type: "text", text: "被选中的那个会话" }] }],
        "res-2": [{ role: "assistant", blocks: [{ type: "text", text: "另一个会话的正文" }] }],
      },
    });
    const apiRef = { current: null as WorkspaceApi | null };
    render(
      <SessionsProvider port={port}>
        <Workspace composition={OPEN_BESIDE_COMPOSITION} apiRef={apiRef} />
      </SessionsProvider>,
    );
    await waitFor(() => expect(screen.getByText("被选中的那个会话")).toBeInTheDocument());
    await waitFor(() => expect(
      apiRef.current!.state.panels.find((panel) => panel.panelId === "chat")?.resourceRef,
    ).toBe("res-1"));

    await userEvent.click(document.querySelector('.sess[data-id="res-2"]')!);
    await waitFor(() => expect(screen.getByText("另一个会话的正文")).toBeInTheDocument());
    const chats = apiRef.current!.state.panels.filter((panel) => panel.moduleId === AGENT_CHAT_MODULE_ID);
    expect(chats.map((panel) => panel.resourceRef)).toEqual(expect.arrayContaining(["res-1", "res-2"]));
    expect(chats).toHaveLength(2);
    expect(chats.every((panel) => panel.slot === "primary")).toBe(true);

    // Reopening an already-open resource focuses its tab; it does not mint a
    // third panel or throw away either cached transcript.
    await userEvent.click(document.querySelector('.sess[data-id="res-1"]')!);
    expect(apiRef.current!.state.panels.filter((panel) => panel.moduleId === AGENT_CHAT_MODULE_ID)).toHaveLength(2);
    // Once. The panel re-renders on every projection, including the one its own
    // read produced.
    expect(port.calls.filter((call) => call.startsWith("readWindow:res-2"))).toHaveLength(1);
  });

  it("does not bind the standing chat to the boot selection on a phone", async () => {
    // On a narrow viewport the shell reads an accepted open intent as a jump
    // into that panel's layer (ticket #189). That rule is for taps. Applying it
    // to the boot bind opened Sessions+ inside the first-sorted session — the
    // topmost favourite — instead of the navigation layer.
    const port = createMemorySessionsPort({
      sessions: [SESSION, { ...SESSION, resourceId: "res-2", projectLabel: "第二个会话" }],
      sources: [{ kind: "runner", device: "laptop", online: true }],
      transcripts: {
        "res-1": [{ role: "assistant", blocks: [{ type: "text", text: "被选中的那个会话" }] }],
        "res-2": [{ role: "assistant", blocks: [{ type: "text", text: "另一个会话的正文" }] }],
      },
    });
    const apiRef = { current: null as WorkspaceApi | null };
    render(
      <SessionsProvider port={port}>
        <Workspace composition={OPEN_BESIDE_COMPOSITION} apiRef={apiRef} narrow />
      </SessionsProvider>,
    );
    // The rail settles, the selection settles — and the chat panel stays
    // unbound, so nothing was ever "opened" for the reader to be thrown into.
    await waitFor(() => expect(document.querySelector('.sess[data-id="res-2"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText("被选中的那个会话")).toBeInTheDocument());
    expect(apiRef.current!.state.panels.find((panel) => panel.panelId === "chat")?.resourceRef).toBeNull();
    expect(apiRef.current!.state.panels.filter((panel) => panel.moduleId === AGENT_CHAT_MODULE_ID)).toHaveLength(1);

    // A real tap still opens and focuses the session it named (ticket #292).
    await userEvent.click(document.querySelector('.sess[data-id="res-2"]')!);
    await waitFor(() => expect(
      apiRef.current!.state.panels.find((panel) => panel.panelId === apiRef.current!.state.focused)?.resourceRef,
    ).toBe("res-2"));
  });

  it("opens and focuses the newly started session from the launch form", async () => {
    const h = launchPort();
    const start = vi.spyOn(h.port, "start");
    const read = vi.spyOn(h.port, "readWindow");
    const apiRef = { current: null as WorkspaceApi | null };
    render(
      <SessionsProvider port={h.port}>
        <Workspace composition={LAUNCH_TO_CHAT_COMPOSITION} apiRef={apiRef} />
      </SessionsProvider>,
    );
    expect(document.getElementById("newModel")).toHaveValue("gpt-6-astra");
    await userEvent.selectOptions(document.getElementById("newSource")!, "claude");
    expect(document.getElementById("newModel")).toHaveValue("");
    await userEvent.selectOptions(document.getElementById("newSource")!, "codex");
    expect(document.getElementById("newModel")).toHaveValue("gpt-6-astra");
    await userEvent.type(document.getElementById("newDevice")!, "laptop");
    await userEvent.type(document.getElementById("newDirectory")!, "~/project");
    await userEvent.type(document.getElementById("newPrompt")!, "开始新任务");
    await userEvent.click(document.getElementById("startSession")!);
    await waitFor(() => expect(document.querySelector('[data-launch-phase="submitted"]')).toBeTruthy());
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-astra" }));

    h.succeed({
      id: "op-launch",
      status: "succeeded",
      operation: "start_session",
      newResourceId: "res-new",
      message: "已启动",
    });

    await waitFor(() => expect(document.querySelector('[data-launch-phase="succeeded"]')).toBeTruthy());
    expect(read.mock.calls.some(([request]) => request.resource === "res-new")).toBe(false);
    await act(async () => { await h.showNewSession(); });
    await waitFor(() => expect(
      apiRef.current!.state.panels.find((panel) => panel.panelId === apiRef.current!.state.focused)?.resourceRef,
    ).toBe("res-new"));
    expect(apiRef.current!.state.panels.filter((panel) => panel.resourceRef === "res-new")).toHaveLength(1);
    // Ticket #767: the empty launch chat hands over to the new session's chat;
    // the stale receipt does not stay behind for the next launch.
    await waitFor(() => expect(document.querySelector("[data-launch-phase]")).toBeNull());
    expect(document.querySelector(".new-session-empty")).not.toBeNull();
  });

  it("allows a live runner even when it is not resumable, but requires resumability when idle", () => {
    const props = {
      transcript: null,
      transcriptStatus: undefined,
      transcriptBusy: false,
      onSend: vi.fn(),
      onPin: vi.fn(),
      onRefresh: vi.fn(),
      onLoadOlder: vi.fn(),
    };
    const { rerender } = render(<AgentChat {...props} session={SESSION} />);
    expect(document.getElementById("composer")).toBeEnabled();

    rerender(<AgentChat {...props} session={{ ...SESSION, status: "idle", resumable: true }} />);
    expect(document.getElementById("composer")).toBeEnabled();

    rerender(<AgentChat {...props} session={{ ...SESSION, status: "idle", resumable: false }} />);
    expect(document.getElementById("composer")).toBeDisabled();

    rerender(<AgentChat {...props} session={{ ...SESSION, status: "idle", resumable: undefined }} />);
    expect(document.getElementById("composer")).toBeDisabled();
  });

  it.each(["claude", "codex", "omp"] as const)(
    "makes explicit takeover the primary action when an observed %s CLI has no write route",
    async (cliKind) => {
      const onTakeover = vi.fn();
      render(<AgentChat
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={vi.fn()}
        onTakeover={onTakeover}
        onPin={vi.fn()}
        onRefresh={vi.fn()}
        onLoadOlder={vi.fn()}
        session={{
          ...SESSION,
          cliKind,
          status: "idle",
          resumable: false,
          runtime: {
            process_state: "alive",
            turn_state: "idle",
            control_mode: "external_cli",
            capabilities: { takeover: true, terminal_append: false, managed_resume: false },
          },
        }}
      />);

      expect(document.getElementById("composer")).toBeEnabled();
      expect(document.getElementById("sendPrompt")).toBeDisabled();
      await userEvent.type(document.getElementById("composer")!, "接管后继续");
      expect(document.getElementById("takeoverPrompt")).toBeNull();
      const takeover = screen.getByRole("button", { name: "交给 Octopus 托管并发送" });
      expect(takeover).toBeEnabled();
      await userEvent.click(takeover);
      expect(onTakeover).toHaveBeenCalledWith("接管后继续");
    },
  );

  it("offers an explicit context-preserving account fallback only for idle pooled Codex", async () => {
    const onFallback = vi.fn();
    const { rerender } = render(<AgentChat
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={vi.fn()}
      onFallback={onFallback}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      session={{
        ...SESSION,
        cliKind: "codex",
        accountLabel: "a",
        status: "idle",
        resumable: true,
      }}
    />);

    expect(screen.getByText(/provider 缓存不跨账号复用/)).toBeInTheDocument();
    await userEvent.type(document.getElementById("composer")!, "用备用账号继续");
    await userEvent.click(document.getElementById("fallbackPrompt")!);
    expect(onFallback).toHaveBeenCalledWith("用备用账号继续");

    rerender(<AgentChat
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={vi.fn()}
      onFallback={onFallback}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      session={{
        ...SESSION,
        cliKind: "codex",
        accountLabel: "a",
        status: "live",
        resumable: true,
      }}
    />);
    expect(document.getElementById("fallbackPrompt")).not.toBeInTheDocument();
  });

  it("keeps best-effort tmux send only for an idle discovered omp CLI", async () => {
    const onSend = vi.fn();
    const onTakeover = vi.fn();
    render(<AgentChat
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={onSend}
      onTakeover={onTakeover}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      session={{
        ...SESSION,
        cliKind: "omp",
        status: "idle",
        resumable: false,
        runtime: {
          process_state: "alive",
          turn_state: "idle",
          control_mode: "external_cli",
          attachment: { kind: "omp_terminal", state: "observed" },
          capabilities: { takeover: true, terminal_append: true, managed_resume: false },
        },
      }}
    />);

    expect(document.getElementById("composer")).toBeEnabled();
    expect(screen.getByText(/先尝试注入独占 tmux/)).toBeInTheDocument();
    await userEvent.type(document.getElementById("composer")!, "先试原来的终端");
    expect(screen.getByRole("button", { name: "尝试发送到本机 CLI" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "尝试发送到本机 CLI" }));
    expect(onSend).toHaveBeenCalledWith("先试原来的终端");
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it("shows a bottom thinking spinner only while a hook-proven turn has no tool or request", () => {
    const props = {
      transcriptStatus: undefined,
      transcriptBusy: false,
      onSend: vi.fn(),
      onPin: vi.fn(),
      onRefresh: vi.fn(),
      onLoadOlder: vi.fn(),
    };
    const session = {
      ...SESSION,
      runtime: { process_state: "alive", turn_state: "working", capabilities: {} },
    };
    const { rerender } = render(<AgentChat {...props} transcript={{ messages: [] }} session={session} />);
    expect(document.querySelector(".agent-thinking-tail")).toHaveTextContent("Agent 正在思考");
    expect(document.querySelector(".agent-thinking-tail .av-spin")).toBeTruthy();

    rerender(<AgentChat
      {...props}
      transcript={{ messages: [], activity: { state: "tool", tool: "Bash" } }}
      session={session}
    />);
    expect(document.querySelector(".agent-thinking-tail")).toBeNull();
  });

  it("shows a roster-projected interaction before the transcript resource opens", () => {
    const onRespondInteraction = vi.fn(async () => {});
    render(<AgentChat
      transcript={null}
      transcriptStatus={{ resource: "res-1", state: "live", message: "" }}
      transcriptBusy
      onSend={vi.fn()}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      onRespondInteraction={onRespondInteraction}
      session={{
        ...SESSION,
        runtime: {
          process_state: "unknown",
          turn_state: "needs_input",
          control_mode: "octopus_headless",
          observed_at: "2026-08-12T04:09:24Z",
          event: "SessionEnd",
          tool: "",
          degraded: true,
          capabilities: { respond: true },
          interaction: {
            id: "ai_roster_pending",
            provider: "claude",
            kind: "question",
            title: "Claude Code 需要你的回答",
            tool: "AskUserQuestion",
            questions: [{
              id: "acceptance",
              header: "验收结果",
              prompt: "新版 Agent adaptor 的网页提问闭环是否验收通过？",
              options: [
                { label: "通过", description: "网页卡片正常出现" },
                { label: "不通过", description: "没有出现或交互异常" },
              ],
              multiple: false,
              allow_other: false,
              secret: false,
            }],
            created_at: "2026-08-12T04:09:30Z",
            expires_at: "2026-08-12T04:20:00Z",
            capabilities: { respond: true, allow: true, deny: true },
          },
        },
      }}
    />);

    expect(document.querySelector('[data-agent-interaction="ai_roster_pending"]')).toBeTruthy();
    expect(screen.getByText("新版 Agent adaptor 的网页提问闭环是否验收通过？")).toBeInTheDocument();
  });

  it("does not resurrect an answered interaction from a stale transcript runtime", () => {
    render(<AgentChat
      transcript={{
        messages: [],
        runtime: {
          turn_state: "needs_input",
          interaction: {
            id: "ai_already_answered",
            provider: "claude",
            kind: "question",
            title: "旧问题",
            questions: [],
            created_at: "2026-08-12T04:09:30Z",
            expires_at: "2026-08-12T04:20:00Z",
            capabilities: { respond: true, allow: true, deny: true },
          },
        },
      }}
      transcriptStatus={{ resource: "res-1", state: "live", message: "" }}
      transcriptBusy={false}
      onSend={vi.fn()}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      onRespondInteraction={vi.fn(async () => {})}
      session={{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities: { respond: true },
        },
      }}
    />);

    expect(document.querySelector('[data-agent-interaction="ai_already_answered"]')).toBeNull();
    expect(screen.queryByText("旧问题")).not.toBeInTheDocument();
  });

  it("renders a newer transcript interaction before the roster refresh arrives", () => {
    render(<AgentChat
      transcript={{
        messages: [],
        runtime: {
          turn_state: "needs_input",
          observed_at: "2026-08-12T04:09:31Z",
          interaction: {
            id: "ai_newer_transcript",
            provider: "codex",
            kind: "permission",
            title: "Codex 请求权限",
            questions: [],
            created_at: "2026-08-12T04:09:31Z",
            expires_at: "2026-08-12T04:20:00Z",
            capabilities: { respond: true, allow: true, deny: true },
          },
        },
      }}
      transcriptStatus={{ resource: "res-1", state: "live", message: "" }}
      transcriptBusy={false}
      onSend={vi.fn()}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      onRespondInteraction={vi.fn(async () => {})}
      session={{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          observed_at: "2026-08-12T04:09:30Z",
          capabilities: { respond: true },
        },
      }}
    />);

    expect(document.querySelector('[data-agent-interaction="ai_newer_transcript"]')).toBeTruthy();
    expect(screen.getByText("Codex 请求权限")).toBeInTheDocument();
  });

  it("treats a historical AskUserQuestion tool block as transcript, never as a pending interaction", () => {
    render(<AgentChat
      transcript={{
        messages: [{
          role: "assistant",
          blocks: [{
            type: "tool",
            tool: "AskUserQuestion",
            input: JSON.stringify({ questions: [{ question: "历史问题" }] }),
            output: "answered in the historical CLI transcript",
          }],
        }],
      }}
      transcriptStatus={{ resource: "res-1", state: "live", message: "" }}
      transcriptBusy={false}
      onSend={vi.fn()}
      onPin={vi.fn()}
      onRefresh={vi.fn()}
      onLoadOlder={vi.fn()}
      onRespondInteraction={vi.fn(async () => {})}
      session={{
        ...SESSION,
        // The roster is current and explicitly has no interaction. Tool
        // history remains visible below, but it cannot manufacture a card.
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities: { respond: true },
        },
      }}
    />);

    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    expect(document.querySelector("[data-agent-interaction]")).toBeNull();
    expect(screen.queryByRole("button", { name: "提交回答并继续" })).not.toBeInTheDocument();
  });

  it("keeps a successful answer as a compact receipt after the roster clears it", async () => {
    const interaction = {
      id: "ai_answer_then_clear",
      provider: "claude" as const,
      kind: "question" as const,
      title: "Claude Code 需要你的回答",
      tool: "AskUserQuestion",
      questions: [{
        id: "acceptance",
        header: "验收结果",
        prompt: "新版 Agent adaptor 的网页提问闭环是否验收通过？",
        options: [{ label: "通过", description: "网页卡片正常出现" }],
        multiple: false,
        allow_other: false,
        secret: false,
      }],
      created_at: "2026-08-12T04:09:30Z",
      expires_at: "2026-08-12T04:20:00Z",
      capabilities: { respond: true as const, allow: true as const, deny: true as const },
    };
    const props = {
      transcript: null,
      transcriptStatus: { resource: "res-1", state: "live" as const, message: "" },
      transcriptBusy: false,
      onSend: vi.fn(),
      onPin: vi.fn(),
      onRefresh: vi.fn(),
      onLoadOlder: vi.fn(),
      onRespondInteraction: vi.fn(async () => {}),
    };
    const { rerender } = render(<AgentChat
      {...props}
      session={{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "needs_input",
          capabilities: { respond: true },
          interaction,
        },
      }}
    />);

    await userEvent.click(screen.getByLabelText(/通过网页卡片正常出现/));
    await userEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await waitFor(() => expect(screen.getByText("已提交：通过")).toBeInTheDocument());

    rerender(<AgentChat
      {...props}
      transcript={{ messages: [], runtime: { turn_state: "needs_input", interaction } }}
      resolvedInteraction={{
        interaction,
        response: { decision: "allow", answers: { acceptance: ["通过"] } },
      }}
      session={{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities: { respond: true },
        },
      }}
    />);

    expect(screen.getByText("已提交：通过")).toBeInTheDocument();
    expect(document.querySelector('[data-agent-interaction-state="resolved"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交回答并继续" })).not.toBeInTheDocument();
    expect(screen.queryByText("新版 Agent adaptor 的网页提问闭环是否验收通过？")).not.toBeInTheDocument();
  });
});
