/**
 * The absence hint is debounced, never the facts: the chat keeps rendering the
 * retained row while `absent` is true, and the ⚠ line appears only when the
 * absence has persisted past ABSENT_NOTICE_DELAY_MS. A blip shorter than the
 * delay — one dropped fan-out frame, one refresh racing a device timeout —
 * must render nothing at all. This direct component suite also pins responsive
 * composer behavior that every module composition inherits.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import { QUIET_MS } from "../lib/transcript.js";
import { createComposerDraftStore } from "../composer-drafts.js";
import { ABSENT_NOTICE_DELAY_MS, AgentChat, STOP_PENDING_MAX_MS } from "./AgentChat.js";

// The transcript virtualizer debounces its scroll-end notice (150 ms) on a real
// timer that unmounting does not clear. Let it fire while this file's jsdom
// window still exists; otherwise it can land in the next file after teardown
// as "window is not defined".
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 250); }));

const SESSION: SessionSummary = {
  resourceId: "res-1",
  deviceId: "laptop",
  cliKind: "codex",
  cwdDisplay: "~/projects/x",
  status: "live",
  resumable: true,
  lastActivity: "2026-08-15T02:00:00Z",
};

function chat(absent: boolean, transcriptBusy = false, transcript: TranscriptWindow | null = null) {
  return (
    <AgentChat
      session={SESSION}
      absent={absent}
      transcript={transcript}
      transcriptStatus={undefined}
      transcriptBusy={transcriptBusy}
      onSend={() => {}}
      onPin={() => {}}
      onRefresh={() => {}}
      onLoadOlder={() => {}}
    />
  );
}

const note = (): Element | null => document.querySelector(".session-absent-note");

describe("AgentChat local behavior", () => {
  it("offers continuation settings only for an owned top-level Codex session", () => {
    const read = vi.fn(), save = vi.fn();
    const renderChat = (session: SessionSummary) => <AgentChat {...chat(false).props}
      session={session} onReadContinuation={read} onSaveContinuation={save} />;
    const view = render(renderChat(SESSION));
    expect(document.querySelector("[data-codex-continuation]")).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
    for (const session of [
      { ...SESSION, cliKind: "claude" as const },
      { ...SESSION, cliKind: "omp" as const },
      { ...SESSION, shared: true },
      { ...SESSION, inputMode: "parent_owned" as const },
    ]) {
      view.rerender(renderChat(session));
      expect(document.querySelector("[data-codex-continuation]")).toBeNull();
    }
  });

  it("shows observed Codex model/effort in the header and replaces or clears them on refresh", () => {
    const transcript = { messages: [], turnConfiguration: { model: "gpt-6-luna", effort: "high" } };
    const view = render(chat(false, false, transcript));
    const header = () => document.querySelector("[data-av-session-header]")!;
    expect(header()).toHaveTextContent("laptop · Codex · gpt-6-luna · Effort high");
    expect(document.querySelector("[data-av-session-turn-configuration]")).toHaveAttribute("title", expect.stringContaining("最近一次实际运行"));
    view.rerender(chat(false, false, { ...transcript, turnConfiguration: { model: "gpt-6-astra", effort: "xhigh" } }));
    expect(header()).toHaveTextContent("gpt-6-astra · Effort xhigh");
    expect(header()).not.toHaveTextContent("gpt-6-luna");
    view.rerender(chat(false, false, { ...transcript, turnConfiguration: { model: "custom" } }));
    expect(header()).toHaveTextContent("custom · Effort 未报告");
    view.rerender(chat(false, false, { messages: [], turnConfiguration: null }));
    expect(header()).toHaveTextContent("模型未报告 · Effort 未报告");
    view.rerender(chat(false));
    expect(header()).toHaveTextContent("模型未报告 · Effort 未报告");
  });

  it.each(["terminal_tmux", "none", "codex_app_server"])("offers async answers through the existing input callback for %s", (kind) => {
    const send = vi.fn();
    render(<AgentChat session={{ ...SESSION, runtime: { attachment: { kind }, capabilities: { protocol_append: true } } }}
      transcript={{ offset: 0, messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "request_user_input_async",
        call_id: "native-question", input: JSON.stringify({ questions: [{ title: "继续哪个方案？", options: ["方案甲"] }] }), output: "displayed" }] }] }}
      transcriptStatus={undefined} transcriptBusy={false} onSend={send} onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    fireEvent.click(screen.getByLabelText("方案甲"));
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain("回答：方案甲");
  });
  it("keeps async questions visible but disables answers for parent-owned sessions", () => {
    render(<AgentChat session={{ ...SESSION, inputMode: "parent_owned", parentResourceId: "parent" }}
      transcript={{ offset: 0, messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "request_user_input_async",
        call_id: "question", input: JSON.stringify({ questions: [{ title: "只读问题" }] }) }] }] }}
      transcriptStatus={undefined} transcriptBusy={false} onSend={vi.fn()} onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    expect(screen.getByText("只读问题")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
  });
  it("shows capacity backoff and a Stop action without client-side resubmission", () => {
    const stop = vi.fn(), send = vi.fn();
    render(<AgentChat session={{ ...SESSION, runtime: { process_state: "alive", turn_state: "working",
      recovery: { state: "waiting_capacity", attempts: 2, max_attempts: 6, retry_at: "2026-09-24T12:05:00Z" },
      capabilities: { interrupt: true, managed_resume: false, terminal_append: false, protocol_append: false, append_when_idle: false } } }}
      transcript={null} transcriptStatus={undefined} transcriptBusy={false} onSend={send} onInterrupt={stop}
      onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    expect(screen.getByText(/Codex 容量不足.*2\/6.*2026-09-24T12:05:00Z/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止自动恢复" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps recovery visible and stoppable without enabling a duplicate send", () => {
    const stop = vi.fn(), send = vi.fn();
    render(<AgentChat session={{ ...SESSION, runtime: { process_state: "unknown", turn_state: "unknown",
      recovery: { state: "waiting_resource" }, capabilities: { interrupt: true, managed_resume: false,
        terminal_append: false, protocol_append: false, append_when_idle: false } } }}
      transcript={null} transcriptStatus={undefined} transcriptBusy={false} onSend={send} onInterrupt={stop}
      onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    expect(screen.getByText(/等待运行环境恢复。恢复后会自动继续/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止自动恢复" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("recovers uncertain input only on an explicit gesture without sending or replacing another draft", () => {
    const send = vi.fn();
    render(<AgentChat
      session={SESSION}
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={send}
      onPin={() => {}}
      onRefresh={() => {}}
      onLoadOlder={() => {}}
      pendingSends={[{
        key: "res-1#1", resource: "res-1", prompt: "先核对是否送达", kind: "append",
        phase: "uncertain", message: "连接中断", projectionSequence: 1, absoluteMessageEnd: 0,
      }]}
    />);
    expect(screen.getByText("? 结果未知")).toBeInTheDocument();
    expect(screen.getByText("连接中断")).not.toBeVisible();
    fireEvent.click(screen.getByText("查看发送详情"));
    expect(screen.getByText("连接中断")).toBeVisible();
    expect(document.getElementById("composer")).toHaveValue("");
    fireEvent.change(document.getElementById("composer")!, { target: { value: "下一条草稿" } });
    expect(screen.queryByRole("button", { name: "放回输入框" })).toBeNull();
    fireEvent.change(document.getElementById("composer")!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "放回输入框" }));
    expect(document.getElementById("composer")).toHaveValue("先核对是否送达");
    expect(send).not.toHaveBeenCalled();
  });

  it("subscribes the composer to only its controller-owned draft", () => {
    const store = createComposerDraftStore(4);
    const source = {
      subscribe: (listener: () => void) => store.subscribe("res-1", listener),
      getSnapshot: () => store.get("res-1"),
      set: (text: string) => store.set("res-1", text),
    };
    render(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        draftSource={source}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );

    fireEvent.change(document.getElementById("composer")!, { target: { value: "resource-local" } });
    expect(store.get("res-1")).toBe("resource-local");
    expect(document.getElementById("composer")).toHaveValue("resource-local");

    act(() => store.set("res-1", "restored"));
    expect(document.getElementById("composer")).toHaveValue("restored");
  });

  it.each(["codex", "claude"] as const)("keeps a parent-owned %s child observable, draftable, and explicitly navigable but never writable", (cliKind) => {
    const openParent = vi.fn();
    const send = vi.fn();
    const takeover = vi.fn();
    const fallback = vi.fn();
    const interrupt = vi.fn();
    render(
      <AgentChat
        session={{
          ...SESSION,
          cliKind,
          inputMode: "parent_owned",
          parentResourceId: "res-parent",
          runtime: {
            process_state: "alive",
            turn_state: "working",
            capabilities: {
              takeover: true,
              interrupt: true,
              managed_resume: true,
              release_control: true,
            },
          },
          accountLabel: "a",
        }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={send}
        onTakeover={takeover}
        onFallback={fallback}
        onInterrupt={interrupt}
        onOpenParent={openParent}
        controlRelease={{ resource: "res-1", phase: "failed", message: "" }}
        onReleaseControl={vi.fn()}
        permissionProfile="full_access"
        onPermissionProfileChange={vi.fn()}
        model="gpt-5.6-sol"
        onModelChange={vi.fn()}
        effort="high"
        onEffortChange={vi.fn()}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );

    expect(screen.getByText(`这个 ${cliKind === "claude" ? "Claude" : "Codex"} 子 Agent 由父 Agent 管理`)).toBeInTheDocument();
    expect(screen.getByText(cliKind === "claude" ? /不接受独立续跑/ : /不会唤醒这里的子 Agent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开父 Agent" }));
    expect(openParent).toHaveBeenCalledTimes(1);

    const composer = document.getElementById("composer")!;
    expect(composer).not.toBeDisabled();
    fireEvent.change(composer, { target: { value: "保留这段草稿" } });
    expect(document.getElementById("sendPrompt")).toBeDisabled();
    fireEvent.click(document.getElementById("sendPrompt")!);
    expect(send).not.toHaveBeenCalled();
    expect(takeover).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(document.getElementById("interruptTurn")).toBeNull();
    expect(document.getElementById("fallbackPrompt")).toBeNull();
    expect(document.getElementById("releaseCodexControl")).toBeNull();
    expect(screen.queryByText("Codex 后台占用需要处理")).toBeNull();
    expect(document.getElementById("permissionProfile")).toBeNull();
    expect(document.getElementById("sessionModel")).toBeNull();
    expect(document.getElementById("sessionEffort")).toBeNull();
  });

  it("stays silent through a blip and renders only a persistent absence", () => {
    const view = render(chat(false));
    expect(note()).toBeNull();

    // A blip: absent flips on and back off before the delay elapses. Nothing
    // may flash, even after the timer horizon passes.
    view.rerender(chat(true));
    expect(note()).toBeNull();
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_DELAY_MS - 100));
    expect(note()).toBeNull();
    view.rerender(chat(false));
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_DELAY_MS * 2));
    expect(note()).toBeNull();

    // A persistent absence still says so once the delay has passed.
    view.rerender(chat(true));
    act(() => vi.advanceTimersByTime(ABSENT_NOTICE_DELAY_MS + 10));
    expect(note()).not.toBeNull();

    // Presence needs no debounce: the row's return clears the hint at once.
    view.rerender(chat(false));
    expect(note()).toBeNull();
  });

  it("keeps cached transcript visible while saying that newer messages are loading", () => {
    const cached = { messages: [{ role: "assistant", text: "缓存正文" }], offset: 0 } as TranscriptWindow;
    const view = render(chat(false, true, cached));
    expect(screen.getByText("缓存正文")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步最新消息" })).toHaveTextContent("正在同步最新消息");

    view.rerender(chat(false, false, cached));
    expect(screen.queryByText("正在同步最新消息")).toBeNull();
  });

  it("withdraws a stale hook spinner and labels the runtime as unconfirmed", () => {
    const now = new Date("2026-08-21T14:00:00Z");
    vi.setSystemTime(now);
    render(
      <AgentChat
        session={{
          ...SESSION,
          runtime: {
            process_state: "alive",
            turn_state: "working",
            observed_at: now.toISOString(),
            attachment: { kind: "hook_observer", state: "observed" },
            capabilities: {},
          },
        }}
        transcript={{ messages: [] }}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(document.querySelector(".agent-thinking-tail")).not.toBeNull();

    act(() => vi.advanceTimersByTime(QUIET_MS + 1));

    expect(document.querySelector(".agent-thinking-tail")).toBeNull();
    expect(document.querySelector(".detailhead .meta")).toHaveTextContent("状态未知");
  });

  it("keeps desktop upload beside the input and folds mobile upload into settings", () => {
    const onSend = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const compact = render(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        permissionProfile="full_access"
        onPermissionProfileChange={() => {}}
        onSend={onSend}
        onAttachFile={async () => ({ ok: false as const, message: "unused" })}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const compactOptions = document.querySelector("details.composer-options") as HTMLDetailsElement;
    expect(compactOptions).not.toBeNull();
    expect(compactOptions.open).toBe(false);
    expect(compactOptions.closest(".composer-input-shell")).not.toBeNull();
    expect(document.getElementById("permissionProfile")?.closest(".composer-options-card")).not.toBeNull();
    expect(document.getElementById("doPin")?.closest(".composer-options-card")).not.toBeNull();
    expect(document.getElementById("uploadFile")?.closest(".composer-options-card")).not.toBeNull();
    expect(compactOptions.querySelector('summary[aria-label="会话设置"]')).not.toBeNull();
    const compactComposer = document.getElementById("composer")!;
    fireEvent.change(compactComposer, { target: { value: "手机消息" } });
    fireEvent.keyDown(compactComposer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("手机消息");
    compact.unmount();

    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    render(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        permissionProfile="full_access"
        onPermissionProfileChange={() => {}}
        onSend={onSend}
        onAttachFile={async () => ({ ok: false as const, message: "unused" })}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const wideOptions = document.querySelector("details.composer-options") as HTMLDetailsElement;
    expect(wideOptions).not.toBeNull();
    expect(wideOptions.open).toBe(false);
    expect(wideOptions.closest(".composer-input-shell")).toBeNull();
    expect(wideOptions.parentElement).toHaveClass("composer-entry");
    expect(document.getElementById("permissionProfile")?.closest(".composer-options-card")).not.toBeNull();
    expect(document.getElementById("doRefresh")?.closest(".composer-options-card")).not.toBeNull();
    expect(document.getElementById("uploadFile")?.closest(".composer-options-card")).toBeNull();
    expect(document.getElementById("uploadFile")?.parentElement).toHaveClass("composer-entry");
    const wideComposer = document.getElementById("composer")!;
    fireEvent.change(wideComposer, { target: { value: "桌面多行" } });
    fireEvent.keyDown(wideComposer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(wideComposer, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith("桌面多行");
  });

  it("offers model and effort only for a new managed turn, never an external tmux send or in-flight steer", () => {
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();
    const view = render(
      <AgentChat
        session={{ ...SESSION, status: "idle" }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model=""
        models={[{value:"local-next",label:"Local Next"}]}
        onModelChange={onModelChange}
        effort=""
        onEffortChange={onEffortChange}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const modelPicker = document.getElementById("sessionModel") as HTMLSelectElement;
    expect(modelPicker).not.toBeNull();
    expect([...modelPicker.options].map((option) => option.value)).toEqual([
      "",
      "local-next",
    ]);
    fireEvent.change(modelPicker, { target: { value: "local-next" } });
    expect(onModelChange).toHaveBeenCalledWith("local-next");
    const effortPicker = document.getElementById("sessionEffort") as HTMLSelectElement;
    expect(effortPicker).not.toBeNull();
    expect([...effortPicker.options].map((option) => option.value)).toContain("max");
    fireEvent.change(effortPicker, { target: { value: "max" } });
    expect(onEffortChange).toHaveBeenCalledWith("max");

    view.rerender(
      <AgentChat
        session={{
          ...SESSION,
          runtime: {
            process_state: "alive",
            turn_state: "idle",
            control_mode: "external_cli",
            attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
            capabilities: { terminal_append: true },
          },
        }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model="gpt-5.6-terra"
        onModelChange={onModelChange}
        effort="max"
        onEffortChange={onEffortChange}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(document.getElementById("sessionModel")).toBeNull();
    expect(document.getElementById("sessionEffort")).toBeNull();

    view.rerender(
      <AgentChat
        session={{
          ...SESSION,
          runtime: {
            process_state: "alive",
            turn_state: "working",
            control_mode: "octopus_headless",
            attachment: { kind: "codex_app_server", state: "attached", transport: "app-server" },
            capabilities: { protocol_append: true },
          },
        }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model="gpt-5.6-terra"
        onModelChange={onModelChange}
        effort="max"
        onEffortChange={onEffortChange}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(document.getElementById("sessionModel")).toBeNull();
    expect(document.getElementById("sessionEffort")).toBeNull();
  });

  it("puts the shared run settings under the desktop input and inside the phone settings card", () => {
    // Ticket #767: the same compact items as the launch composer, in the same
    // order. Desktop uses the second composer row; a phone keeps its
    // two-column input + send grid and folds the bar into the settings card.
    const chatWith = () => (
      <AgentChat
        session={{ ...SESSION, status: "idle", accountLabel: "a" }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model=""
        onModelChange={() => {}}
        effort=""
        onEffortChange={() => {}}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />
    );
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const wide = render(chatWith());
    const bar = screen.getByRole("group", { name: "后续轮次设置" });
    expect(bar.parentElement).toHaveClass("composer-entry");
    expect(bar.parentElement).toHaveClass("composer-entry-configured");
    expect(bar.closest(".composer-options-card")).toBeNull();
    expect(within(bar).getByLabelText("后续新轮次模型")).toBe(document.getElementById("sessionModel"));
    expect(within(bar).getByLabelText("后续新轮次 effort")).toBe(document.getElementById("sessionEffort"));
    expect(bar).toHaveTextContent("Codex-a");
    expect([...(document.getElementById("sessionEffort") as HTMLSelectElement).options].map((option) => option.value))
      .toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    wide.unmount();

    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(chatWith());
    expect(screen.getByRole("group", { name: "后续轮次设置" }).closest(".composer-options-card")).not.toBeNull();
    // The phone composer keeps its two-column input + send grid.
    expect(document.querySelector(".composer-entry")).not.toHaveClass("composer-entry-configured");
  });

  it("offers model and effort for an Agent started in a terminal only through the explicit takeover", () => {
    const terminal: SessionSummary = {
      ...SESSION,
      runtime: {
        process_state: "alive",
        turn_state: "idle",
        control_mode: "external_cli",
        attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
        capabilities: { terminal_append: true, takeover: true },
      },
    };
    const view = render(
      <AgentChat
        session={terminal}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model=""
        onModelChange={() => {}}
        effort=""
        onEffortChange={() => {}}
        onSend={() => {}}
        onTakeover={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const bar = screen.getByRole("group", { name: "托管后设置" });
    expect(within(bar).getByLabelText("托管后模型")).toBeInTheDocument();
    expect(within(bar).getByLabelText("托管后 effort")).toBeInTheDocument();
    expect(bar).toHaveTextContent("托管时生效");

    // Without the takeover route there is nothing the choice could apply to.
    view.rerender(
      <AgentChat
        session={terminal}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        model=""
        onModelChange={() => {}}
        effort=""
        onEffortChange={() => {}}
        onSend={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(document.getElementById("sessionModel")).toBeNull();
    expect(document.getElementById("sessionEffort")).toBeNull();
  });

  it("switches the primary route to tmux when the transcript has the newer runtime fact", () => {
    const onSend = vi.fn();
    const onTakeover = vi.fn();
    render(
      <AgentChat
        session={{
          ...SESSION,
          status: "idle",
          resumable: false,
          runtime: {
            process_state: "alive",
            turn_state: "idle",
            control_mode: "external_cli",
            observed_at: "2026-08-27T12:00:00.000Z",
            attachment: { kind: "hook_observer", state: "observed" },
            capabilities: { takeover: true, terminal_append: false, managed_resume: false },
          },
        }}
        transcript={{
          messages: [],
          runtime: {
            process_state: "alive",
            turn_state: "idle",
            control_mode: "external_cli",
            observed_at: "2026-08-27T12:00:01.000Z",
            attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
            capabilities: { takeover: true, terminal_append: true, managed_resume: false },
          },
        }}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={onSend}
        onTakeover={onTakeover}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );

    fireEvent.change(document.getElementById("composer")!, { target: { value: "发送到新 tmux" } });
    const primary = document.getElementById("sendPrompt") as HTMLButtonElement;
    expect(primary).toHaveAccessibleName("发送到本机 CLI");
    fireEvent.click(primary);
    expect(onSend).toHaveBeenCalledWith("发送到新 tmux");
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it("requires a second confirmation before retrying an exceptional Codex release", () => {
    const onReleaseControl = vi.fn();
    render(
      <AgentChat
        session={{
          ...SESSION,
          status: "idle",
          runtime: {
            process_state: "alive",
            turn_state: "idle",
            control_mode: "octopus_headless",
            attachment: { kind: "codex_app_server", state: "attached", transport: "app-server" },
            capabilities: { release_control: true, protocol_append: false },
          },
        }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={() => {}}
        onReleaseControl={onReleaseControl}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );

    fireEvent.click(document.getElementById("releaseCodexControl")!);
    const confirm = screen.getByRole("button", { name: "确认释放这份占用" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/共享宿主和本机 tmux 不会/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onReleaseControl).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "确认释放这份占用" })).toBeNull();
  });

  it("offers an explicit interrupt retry after an ordinary Codex send fails", () => {
    const onTakeover = vi.fn();
    const onDismissSend = vi.fn();
    render(
      <AgentChat
        session={{
          ...SESSION,
          status: "idle",
          resumable: false,
          runtime: {
            process_state: "unknown",
            turn_state: "unknown",
            capabilities: { takeover: false, managed_resume: false },
          },
        }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        draft="重新发送这条请求"
        pendingSends={[{
          key: "res-1#4",
          resource: "res-1",
          prompt: "第一次请求",
          kind: "resume",
          phase: "failed",
          message: "本地 CLI 执行失败",
          projectionSequence: 7,
          absoluteMessageEnd: 10,
        }]}
        onDraftChange={() => {}}
        onSend={() => {}}
        onTakeover={onTakeover}
        onDismissSend={onDismissSend}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );

    expect(screen.getByText(/无法证明绑定时会拒绝/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "中断 CLI 并重试" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onDismissSend).toHaveBeenCalledWith("res-1#4");
    expect(onTakeover).toHaveBeenCalledWith("重新发送这条请求");
  });

  it("does not offer the interrupt retry for another provider or a failed takeover", () => {
    const pending = {
      key: "res-1#5",
      resource: "res-1",
      prompt: "失败请求",
      kind: "takeover" as const,
      phase: "failed" as const,
      message: "拒绝",
      projectionSequence: 7,
      absoluteMessageEnd: 10,
    };
    const view = render(
      <AgentChat
        session={{ ...SESSION, cliKind: "claude" }}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        pendingSends={[pending]}
        onSend={() => {}}
        onTakeover={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "中断 CLI 并重试" })).toBeNull();

    view.rerender(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        pendingSends={[pending]}
        onSend={() => {}}
        onTakeover={() => {}}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "中断 CLI 并重试" })).toBeNull();
  });

  it("uploads dropped files and sends only completed device paths", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onSend = vi.fn();
    const onAttachFile = vi.fn(async (file: File) => ({
      ok: true as const,
      attachment: { label: file.name, path: `/tmp/octopus-session-demo/${file.name}`, bytes: file.size },
    }));
    render(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={onSend}
        onAttachFile={onAttachFile}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.drop(document.querySelector(".composer-input-shell")!, {
        dataTransfer: { files: [file], types: ["Files"] },
      });
    });
    expect(onAttachFile).toHaveBeenCalledWith(file, expect.any(Function));
    expect(document.querySelector(".chat-attachment-name")).toHaveTextContent("notes.txt");
    fireEvent.change(document.getElementById("composer")!, { target: { value: "读取附件" } });
    fireEvent.click(document.getElementById("sendPrompt")!);
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining("读取附件"));
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining("/tmp/octopus-session-demo/notes.txt"));
  });

  it("sends attached files through the takeover route too", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onSend = vi.fn();
    const onTakeover = vi.fn();
    const terminal: SessionSummary = {
      ...SESSION,
      runtime: {
        process_state: "alive",
        turn_state: "idle",
        control_mode: "external_cli",
        attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
        capabilities: { terminal_append: true, takeover: true },
      },
    };
    render(<AgentChat session={terminal} transcript={null} transcriptStatus={undefined} transcriptBusy={false}
      onSend={onSend} onTakeover={onTakeover}
      onAttachFile={async (file: File) => ({ ok: true as const, attachment: { label: file.name, path: `/tmp/up/${file.name}`, bytes: file.size } })}
      onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    await act(async () => {
      fireEvent.drop(document.querySelector(".composer-input-shell")!, {
        dataTransfer: { files: [new File(["x"], "plan.md", { type: "text/markdown" })], types: ["Files"] },
      });
    });
    // A file with no words is still a message on every route.
    expect(document.getElementById("takeoverPrompt")).not.toBeDisabled();
    fireEvent.click(document.getElementById("takeoverPrompt")!);
    expect(onTakeover).toHaveBeenCalledWith(expect.stringContaining("/tmp/up/plan.md"));
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelector(".chat-attachment-name")).toBeNull();
  });

  it("keeps screenshot numbers through concurrent uploads, removal and sending", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const onSend = vi.fn();
    const uploads: Array<{ file: File; complete(): void }> = [];
    const onAttachFile = vi.fn((file: File) =>
      new Promise<{ ok: true; attachment: { label: string; path: string; bytes: number } }>((resolve) => {
        uploads.push({ file, complete: () => resolve({
          ok: true,
          attachment: { label: file.name, path: `/tmp/${file.name}`, bytes: file.size },
        }) });
      }));
    render(<AgentChat session={SESSION} transcript={null} transcriptStatus={undefined} transcriptBusy={false}
      onSend={onSend} onAttachFile={onAttachFile} onPin={() => {}} onRefresh={() => {}} onLoadOlder={() => {}} />);
    const screenshot = new File(["pixels"], "image.png", { type: "image/png" });
    const paste = (count = 1): void => {
      fireEvent.paste(document.getElementById("composer")!, {
        clipboardData: { items: Array.from({ length: count }, () => ({ kind: "file", getAsFile: () => screenshot })) },
      });
    };
    paste(2);
    paste();
    const names = uploads.map(({ file }) => file.name);
    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect(name).toMatch(/^image-\d+\.png$/);
      expect(screen.getByRole("progressbar", { name: `${name} 上传进度` })).toBeInTheDocument();
    }
    expect(document.getElementById("sendPrompt")).toBeDisabled();
    await act(async () => { [...uploads].reverse().forEach((upload) => upload.complete()); });
    for (const name of names) expect(screen.getByText(name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `移除 ${names[0]}` }));
    paste();
    const fourth = uploads[3]!.file.name;
    const thirdNumber = Number(names[2]!.match(/\d+/)![0]);
    expect(fourth).toBe(`image-${thirdNumber + 1}.png`);
    await act(async () => { uploads[3]!.complete(); });
    fireEvent.click(document.getElementById("sendPrompt")!);
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend.mock.calls[0]![0]).not.toContain(names[0]);
    for (const name of [names[1], names[2], fourth]) {
      expect(onSend.mock.calls[0]![0]).toContain(`- ${name} — /tmp/${name}`);
    }
    paste();
    expect(uploads[4]!.file.name).toBe(`image-${thirdNumber + 2}.png`);
    await act(async () => { uploads[4]!.complete(); });

    // A file chosen from disk keeps its original name, even if it is image.png.
    fireEvent.change(document.getElementById("uploadFileInput")!, { target: { files: [screenshot] } });
    expect(uploads[5]!.file).toBe(screenshot);
    await act(async () => { uploads[5]!.complete(); });
    expect(screen.getByText("image.png")).toBeInTheDocument();
  });

  it("uploads files in parallel, accepts another selection, and reports each progress", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    type Flight = {
      progress?: (uploadedBytes: number, totalBytes: number) => void;
      resolve(answer: { ok: true; attachment: { label: string; path: string; bytes: number } }): void;
    };
    const flights = new Map<string, Flight>();
    const onAttachFile = vi.fn((
      file: File,
      progress?: (uploadedBytes: number, totalBytes: number) => void,
    ) => new Promise<{ ok: true; attachment: { label: string; path: string; bytes: number } }>((resolve) => {
      flights.set(file.name, { ...(progress ? { progress } : {}), resolve });
    }));
    render(
      <AgentChat
        session={SESSION}
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={() => {}}
        onAttachFile={onAttachFile}
        onPin={() => {}}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const input = document.getElementById("uploadFileInput") as HTMLInputElement;
    const first = new File(["1234567890"], "first.txt", { type: "text/plain" });
    const second = new File(["abcdefghij"], "second.txt", { type: "text/plain" });
    const third = new File(["klmnopqrst"], "third.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [first, second] } });
    expect(onAttachFile).toHaveBeenCalledTimes(2);
    expect(document.getElementById("uploadFile")).toBeEnabled();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);

    await act(async () => {
      flights.get("first.txt")?.progress?.(5, 10);
    });
    expect(screen.getByRole("progressbar", { name: "first.txt 上传进度" })).toHaveValue(5);
    expect(screen.getByText("50%")).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [third] } });
    expect(onAttachFile).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);

    await act(async () => {
      for (const file of [first, second, third]) {
        flights.get(file.name)?.resolve({
          ok: true,
          attachment: { label: file.name, path: `/tmp/${file.name}`, bytes: file.size },
        });
      }
      await Promise.resolve();
    });
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(document.querySelectorAll(".chat-attachment")).toHaveLength(3);
  });

  it("keeps a rejected title draft and makes the action retryable", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    let settle!: (reply: { ok: false; result: null; message: string }) => void;
    const onSetTitle = vi.fn(() => new Promise<{ ok: false; result: null; message: string }>((resolve) => {
      settle = resolve;
    }));
    render(
      <AgentChat
        session={{ ...SESSION, title: "自动标题" }}
        customTitle=""
        transcript={null}
        transcriptStatus={undefined}
        transcriptBusy={false}
        onSend={() => {}}
        onPin={() => {}}
        onSetTitle={onSetTitle}
        onRefresh={() => {}}
        onLoadOlder={() => {}}
      />,
    );
    const input = document.getElementById("sessionTitle") as HTMLInputElement;
    const button = document.getElementById("saveSessionTitle") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "季度复盘" } });
    fireEvent.click(button);
    expect(onSetTitle).toHaveBeenCalledWith("季度复盘");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("保存中");

    await act(async () => {
      settle({ ok: false, result: null, message: "当前状态不允许改标题" });
      await Promise.resolve();
    });
    expect(input).toHaveValue("季度复盘");
    expect(button).not.toBeDisabled();
    expect(document.querySelector(".session-title-error")).toHaveTextContent("当前状态不允许改标题");
  });
});

/**
 * Ticket #184 stop semantics remain provider-specific, but the control now
 * shares the default-closed composer card with every other session action.
 */
describe("AgentChat stop control", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const withRuntime = (
    capabilities: Record<string, boolean>,
    onInterrupt = () => {},
  ) => (
    <AgentChat
      session={{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          capabilities,
        },
      }}
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={() => {}}
      onInterrupt={onInterrupt}
      onPin={() => {}}
      onRefresh={() => {}}
      onLoadOlder={() => {}}
    />
  );
  const stopButton = () => document.getElementById("interruptTurn") as HTMLButtonElement | null;

  it("shows nothing when the Host says this turn cannot be stopped", () => {
    render(withRuntime({ interrupt: false, terminal_append: true }));
    expect(document.querySelector(".turn-stop")).toBeNull();
  });

  it("keeps stop inside the default-closed composer settings card", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(withRuntime({ interrupt: true }));
    const button = stopButton()!;
    const options = document.querySelector("details.composer-options") as HTMLDetailsElement;
    expect(button).not.toBeNull();
    expect(options.open).toBe(false);
    expect(button.closest(".composer-options-card")).not.toBeNull();
    expect(button.closest(".composer-input-shell")).not.toBeNull();
    expect(document.querySelector(".command-pane > .turn-stop")).toBeNull();
  });

  it("says a terminal stop leaves the CLI alive, and a managed stop does not claim to", () => {
    const terminal = render(withRuntime({ interrupt: true, terminal_interrupt: true }));
    expect(document.querySelector(".turn-stop-label")?.textContent).toContain("本机 CLI");
    expect(stopButton()?.textContent).toContain("不结束 CLI");
    expect(stopButton()?.getAttribute("title")).toContain("进程、终端与会话都保留");
    terminal.unmount();

    render(withRuntime({ interrupt: true }));
    expect(document.querySelector(".turn-stop-label")?.textContent).toContain("Octopus");
    expect(stopButton()?.textContent).not.toContain("CLI");
  });

  it("presses once, then recovers instead of stranding a refused stop", () => {
    const onInterrupt = vi.fn();
    const view = render(withRuntime({ interrupt: true }, onInterrupt));
    fireEvent.click(stopButton()!);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(stopButton()?.disabled).toBe(true);

    // A refusal leaves the turn running: the button must become pressable
    // again rather than sitting in "停止中…" forever.
    act(() => vi.advanceTimersByTime(STOP_PENDING_MAX_MS + 10));
    expect(stopButton()?.disabled).toBe(false);

    // The ordinary path: the Host withdraws the capability and the whole line
    // goes away with the turn it belonged to.
    view.rerender(withRuntime({ interrupt: false }, onInterrupt));
    expect(document.querySelector(".turn-stop")).toBeNull();
  });
});

/**
 * The favourite control is a STATE, not a menu of two verbs. It was neither
 * before: one button reading "收藏 / 取消收藏" whatever the answer happened to
 * be, so the only way to learn whether a session was a favourite was to look
 * somewhere else (the roster's ★) or tap and see what moved.
 */
describe("AgentChat favourite control", () => {
  const withPin = (pinned?: boolean) => (
    <AgentChat
      session={SESSION}
      transcript={null}
      transcriptStatus={undefined}
      transcriptBusy={false}
      onSend={() => {}}
      onPin={() => {}}
      onRefresh={() => {}}
      onLoadOlder={() => {}}
      {...(pinned === undefined ? {} : { pinned })}
    />
  );
  const pinButton = () => document.getElementById("doPin") as HTMLButtonElement;

  it("shows a hollow star while the session is not a favourite", () => {
    render(withPin(false));
    expect(pinButton().textContent).toBe("☆ 收藏");
    expect(pinButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("fills the star once it is, without renaming the action", () => {
    const view = render(withPin(false));
    view.rerender(withPin(true));
    expect(pinButton().textContent).toBe("★ 收藏");
    expect(pinButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("reads as not-a-favourite for a composition that does not say", () => {
    render(withPin(undefined));
    expect(pinButton().textContent).toBe("☆ 收藏");
    expect(pinButton().getAttribute("aria-pressed")).toBe("false");
  });
});
