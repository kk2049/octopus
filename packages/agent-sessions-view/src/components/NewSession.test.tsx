/**
 * The launch surface's properties, at the component level.
 *
 * 1. (ticket #191) The model field is a LIST somebody can see, and it never
 *    silently rewrites a value it does not recognise.
 * 2. (ticket #191) The form answers its own button. Every phase of a launch is
 *    a sentence on screen, and a failed one says who refused it.
 * 3. (ticket #767) It is an empty chat: one input, one send, and the settings
 *    as compact items under the input — the rare ones folded behind ⚙.
 */

import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_PERMISSION_PROFILES } from "@claude-bot/agent-sessions-contract";
import { NewSession, type NewSessionProps } from "./NewSession.js";

function form(overrides: Partial<NewSessionProps> = {}) {
  const props: NewSessionProps = {
    devices: ["laptop"],
    placementDevices: [],
    workspaces: {},
    advanced: false,
    runtimeDevice: "",
    workspaceId: "",
    device: "laptop",
    directory: "~/projects/x",
    source: "claude",
    translatePrompt: false,
    model: "",
    effort: "high",
    permissionProfile: AGENT_PERMISSION_PROFILES.fullAccess,
    prompt: "开始干活",
    onAdvanced: vi.fn(),
    onRuntimeDevice: vi.fn(),
    onWorkspace: vi.fn(),
    onDevice: vi.fn(),
    onDirectory: vi.fn(),
    onSource: vi.fn(),
    onModel: vi.fn(),
    onEffort: vi.fn(),
    onPermissionProfile: vi.fn(),
    onPrompt: vi.fn(),
    onCancel: vi.fn(),
    onStart: vi.fn(),
    ...overrides,
  };
  const view = render(<NewSession {...props} />);
  return { ...props, rerender: (patch: Partial<NewSessionProps>) => view.rerender(<NewSession {...props} {...patch} />) };
}

const model = (): HTMLSelectElement => document.getElementById("newModel") as HTMLSelectElement;
const backend = (): HTMLSelectElement => document.getElementById("newSource") as HTMLSelectElement;
const effort = (): HTMLSelectElement => document.getElementById("newEffort") as HTMLSelectElement;

afterEach(() => vi.unstubAllGlobals());

describe("NewSession", () => {
  it("is an empty chat whose settings sit under the input, with the rare ones folded", () => {
    form();
    const heading = screen.getByRole("heading", { name: /启动新的本地 Agent/ });
    expect(heading.closest("[data-av-new-session]")).toHaveClass("new-session-chat");
    // The first instruction is the chat input, not a labelled form field.
    const prompt = screen.getByLabelText("第一条需求");
    expect(prompt.tagName).toBe("TEXTAREA");
    expect(prompt.closest(".composer-input-shell")).not.toBeNull();
    // Device, directory, backend, model and effort are one compact bar in the
    // composer grid, beside the send button.
    const bar = screen.getByRole("group", { name: "新 Agent 设置" });
    expect(bar.parentElement).toHaveClass("composer-entry");
    for (const control of ["device", "directory", "source", "model", "effort"]) {
      expect(bar.querySelector(`[data-av-new-session-control="${control}"]`), control).not.toBeNull();
    }
    const start = screen.getByRole("button", { name: "发送并启动 Agent" });
    expect(start.parentElement).toBe(bar.parentElement);
    expect(start).toHaveAttribute("data-av-new-session-action", "start");
    // Account, permission and placement are folded behind the composer's ⚙.
    const options = document.querySelector("details[data-av-new-session-options]") as HTMLDetailsElement;
    expect(options.open).toBe(false);
    expect(within(options).getByLabelText("Claude Code 权限")).toBeInTheDocument();
    expect(within(options).getByRole("button", { name: "进阶放置" })).toBeInTheDocument();
    expect(within(options).getByText(/不是访问边界/)).toBeInTheDocument();
    // The empty transcript says what sending will start, including folded choices.
    expect(document.querySelector(".new-session-empty")).toHaveTextContent("发送即启动：Claude Code");
  });

  it("sends only on Ctrl/⌘+Enter, even on a phone, and never while the target is incomplete", () => {
    // A launch is a brief, not a chat line (ticket #180): a phone Enter must
    // insert a newline rather than start an Agent with half the instruction.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const props = form();
    const prompt = screen.getByLabelText("第一条需求");
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    expect(props.onStart).toHaveBeenCalledTimes(1);

    const blocked = form({ directory: "src/app" });
    const prompts = screen.getAllByLabelText("第一条需求");
    fireEvent.keyDown(prompts[prompts.length - 1]!, { key: "Enter", ctrlKey: true });
    expect(blocked.onStart).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请写 POSIX 绝对路径");
  });

  it("moves a launched instruction into the transcript and keeps the input locked meanwhile", () => {
    form({ launch: { phase: "submitted", prompt: "开始干活", message: "" } });
    expect(document.querySelector("[data-av-new-session-echo]")).toHaveTextContent("开始干活");
    const prompt = screen.getByLabelText("第一条需求") as HTMLTextAreaElement;
    expect(prompt).toBeDisabled();
    expect(prompt.value).toBe("");
    expect(screen.getByRole("button", { name: "启动中…" })).toBeDisabled();
  });

  it("summarises folded choices so a value behind ⚙ is never silent", () => {
    form({
      source: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      permissionProfile: AGENT_PERMISSION_PROFILES.manual,
      codexAccount: "account_b",
      placementDevices: [{ device: "laptop", online: true, codexAccounts: [{ id: "account_b", label: "codexb" }] }],
    });
    expect(document.querySelector(".new-session-empty")).toHaveTextContent(
      "发送即启动：Codex · GPT-5.6 Sol · effort max · 账号 codexb · 权限手动确认",
    );
  });

  it("offers both Claude lanes as separate entries and reports which one was picked", async () => {
    const props = form();
    expect([...backend().options].map((option) => option.value))
      .toEqual(["claude", "claude-bilingual", "codex", "omp"]);
    // A form on the plain lane must not look like it is on the other one.
    expect(backend().value).toBe("claude");

    await userEvent.selectOptions(backend(), "claude-bilingual");
    expect(props.onSource).toHaveBeenCalledWith("claude-bilingual");
  });

  it("shows the bilingual lane's cost where the choice is made", () => {
    form({ source: "claude", translatePrompt: true });
    expect(backend().value).toBe("claude-bilingual");
    expect(screen.getByText(/翻译不可用时这一项会启动失败，普通 Claude 不受影响/))
      .toBeInTheDocument();
  });

  it("lists the models of the selected CLI, defaulting to the Runner's own", async () => {
    const props = form();
    expect(model().tagName).toBe("SELECT");
    expect([...model().options].map((option) => option.value))
      .toEqual(["", "opus", "sonnet", "fable"]);
    expect(model().value).toBe("");
    await userEvent.selectOptions(model(), "sonnet");
    expect(props.onModel).toHaveBeenCalledWith("sonnet");
  });

  it("lists Codex's models when the CLI is Codex", () => {
    form({ source: "codex", model: "gpt-5.6-sol" });
    expect([...model().options].map((option) => option.value))
      .toEqual(["", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "codex-auto-review"]);
    expect(screen.getByRole("option", { name: "GPT-6 Astra" })).toBeInTheDocument();
    expect(model().value).toBe("gpt-5.6-sol");
  });

  it("offers max effort for Codex launches", () => {
    form({ source: "codex" });
    expect([...effort().options].map((option) => option.value))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps a model it does not know rather than silently choosing another", () => {
    // A picker that dropped an unlisted value would propose something the
    // person never chose — the one thing worse than not offering it.
    form({ model: "some-new-model" });
    expect(model().value).toBe("some-new-model");
    expect(screen.getByRole("option", { name: /some-new-model（自定义）/ })).toBeInTheDocument();
  });

  it("shows the launch it asked for, and refuses to start a second one meanwhile", () => {
    form({ launch: { phase: "sending", message: "" } });
    expect(screen.getByText("正在提交启动请求…")).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "启动中…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says who refused a launch, and lets the person clear the note", async () => {
    const onDismissLaunch = vi.fn();
    form({
      launch: { phase: "refused", message: "当前实例没有可用的 Runner 权限" },
      onDismissLaunch,
    });
    expect(screen.getByText(/启动被拒绝：当前实例没有可用的 Runner 权限/)).toBeInTheDocument();
    // Refused is terminal, so the button is usable again immediately.
    expect((screen.getByRole("button", { name: "发送并启动 Agent" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onDismissLaunch).toHaveBeenCalled();
  });

  it("says what the DEVICE said when a start was accepted and then failed", () => {
    form({ launch: { phase: "failed", message: "目录不存在" } });
    const note = document.querySelector('[data-launch-phase="failed"]')!;
    expect(note).toHaveTextContent("启动失败：目录不存在");
    expect(note.className).toContain("err");
  });

  it("confirms a start that actually happened", () => {
    form({ launch: { phase: "succeeded", message: "" } });
    expect(screen.getByText(/已启动/)).toBeInTheDocument();
    expect(document.querySelector('[data-launch-phase="succeeded"]')!.className).not.toContain("err");
  });

  it("shows bounded assets and refuses an unfilterable split backend", () => {
    form({
      advanced: true,
      runtimeDevice: "runner1",
      device: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      source: "codex",
      placementDevices: [
        {
          device: "runner1",
          online: true,
          agentBackends: [
            { kind: "claude", available: true, version: "2.1", splitExecution: true },
            {
              kind: "codex",
              available: true,
              splitExecution: false,
              splitExecutionReason: "local_tools_unfilterable",
            },
          ],
          execution: { shell: true, workspaceFiles: true },
        },
        {
          device: "val15",
          online: true,
          agentBackends: [],
          execution: { platform: "linux", shell: true, workspaceFiles: true },
        },
      ],
      workspaces: {
        val15: {
          device: "val15",
          workspaces: [{
            id: "ws_0123456789abcdef01234567",
            label: "执行沙箱",
            display: "~/sandbox",
          }],
        },
      },
    });
    expect(screen.getByLabelText("Agent 运行机")).toHaveValue("runner1");
    expect(screen.getByLabelText("执行机")).toHaveValue("val15");
    expect(screen.getByText(/Codex 目前不能关闭运行机上的本地工具/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Codex · 此放置不可用/ })).toBeDisabled();
  });

  it("distinguishes a Runner PATH miss from an absent OMP installation claim", () => {
    form({
      advanced: true,
      runtimeDevice: "laptop",
      device: "laptop",
      source: "omp",
      placementDevices: [{
        device: "laptop",
        online: true,
        agentBackends: [{
          kind: "omp",
          available: false,
          splitExecution: true,
          reason: "command_unavailable",
        }],
        execution: { shell: true, workspaceFiles: true },
      }],
    });
    expect(screen.getByText("laptop 的 Runner 进程找不到 Oh My Pi 命令")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
  });

  it.each([
    ["unsafe_permissions", "已找到程序，但被本机安装信任策略拒绝"],
    ["interpreter_unavailable", "已找到程序，但缺少可用解释器"],
    ["binding_unavailable", "本机指定的 Agent 安装已失效"],
  ])("shows %s from the trusted projection while preserving the disabled launch", (diagnosticCode, message) => {
    form({ advanced: true, runtimeDevice: "mac", device: "mac", source: "codex", placementDevices: [{
      device: "mac", online: true, agentBackends: [{ kind: "codex", available: false, reason: "probe_failed", diagnosticCode }],
      execution: { shell: true, workspaceFiles: true },
    }] });
    expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
  });

  it("enables Codex split placement only when the execution machine reports exec-server", () => {
    form({
      advanced: true,
      runtimeDevice: "runner1",
      device: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
      source: "codex",
      placementDevices: [
        {
          device: "runner1",
          online: true,
          agentBackends: [{ kind: "codex", available: true, splitExecution: true }],
          execution: { shell: true, workspaceFiles: true },
        },
        {
          device: "val15",
          online: true,
          agentBackends: [],
          execution: {
            platform: "linux",
            shell: true,
            workspaceFiles: true,
            codexExecServer: true,
          },
        },
      ],
      workspaces: {
        val15: {
          device: "val15",
          workspaces: [{
            id: "ws_0123456789abcdef01234567",
            label: "执行沙箱",
            display: "~/sandbox",
          }],
        },
      },
    });
    expect(document.querySelector(".new-session-head .meta")).toHaveTextContent("Codex @ runner1 → 执行沙箱 @ val15");
    expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeEnabled();
  });
});

it("uses device display names in placement choices while passing only stable device keys", async () => {
  const props = form({ advanced: true, runtimeDevice: "model-key", device: "worker-key",
    placementDevices: [
      { device: "model-key", deviceLabel: "aliyun", online: true, execution: { shell: true, workspaceFiles: true } },
      { device: "worker-key", online: true, execution: { shell: true, workspaceFiles: true } },
    ],
  });
  const runtime = screen.getByLabelText("Agent 运行机") as HTMLSelectElement;
  const execution = screen.getByLabelText("执行机") as HTMLSelectElement;
  expect([...runtime.options].find((option) => option.value === "model-key")?.textContent).toContain("aliyun");
  expect([...execution.options].find((option) => option.value === "worker-key")?.textContent).toContain("worker-key");
  await userEvent.selectOptions(execution, "model-key");
  expect(props.onDevice).toHaveBeenCalledWith("model-key");
  await userEvent.selectOptions(runtime, "worker-key");
  expect(props.onRuntimeDevice).toHaveBeenCalledWith("worker-key");
});

it("selects an exact runtime registration and shows its quota beside the model", async () => {
  const onCodexAccount = vi.fn();
  form({ source: "codex", onCodexAccount, placementDevices: [{ device: "laptop", online: true, codexAccounts: [
    { id: "@default", label: "codex", quota: { status: "available", fetchedAt: "2026-09-15T12:00:00Z", windows: [
      { remainingPercent: 42, windowMinutes: 300, resetsAt: "2026-09-15T16:00:00Z" },
    ] } }, { id: "account_b", label: "codexb" },
  ] }] });
  const select = screen.getByRole("radiogroup", { name: "Codex 账号 · laptop" });
  expect(screen.getByRole("radio", { name: "自动选择" })).toBeChecked();
  expect(select).toHaveTextContent("自动选择");
  expect(screen.getByRole("img", { name: /剩余 42%/ }).querySelector("svg")).not.toBeNull();
  expect(select).toHaveTextContent("↻");
  expect(select).toHaveTextContent("额度未知");
  await userEvent.click(screen.getByRole("radio", { name: /codexb/ }));
  expect(onCodexAccount).toHaveBeenCalledWith("account_b");
});

it("keeps a vanished explicit account visible and blocks the launch", () => {
  form({ source: "codex", codexAccount: "account_b", placementDevices: [{ device: "laptop", online: true, codexAccounts: [{ id: "@default", label: "codex" }] }] });
  expect(screen.getByRole("radio", { name: "所选账号已不在当前注册中" })).toBeChecked();
  expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
});


it("shows the selected runtime account's discovered models and reports the exact choice", () => {
  const props = form({source:"codex", advanced:true, runtimeDevice:"runtime", codexAccount:"b",
    placementDevices:[{device:"runtime",codexAccounts:[{id:"b",label:"codexb",models:[{value:"local-new",label:"Local New"}]}]}]});
  expect([...model().options].map(row => row.value)).toEqual(["", "local-new"]);
  fireEvent.change(model(), {target:{value:"local-new"}});
  expect(props.onModel).toHaveBeenCalledWith("local-new");
});


it("pastes a file before launch and sends only the completed attachment reference", async () => {
  let finish!: (value: { ok: true; attachment: { label: string; path: string; bytes: number } }) => void;
  const onAttachFile = vi.fn(() => new Promise<{ ok: true; attachment: { label: string; path: string; bytes: number } }>(r => { finish = r; }));
  const props = form({ prompt: "", onAttachFile });
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  fireEvent.paste(screen.getByLabelText("第一条需求"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
  expect(onAttachFile).toHaveBeenCalledWith(file);
  expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
  finish({ ok: true, attachment: { label: file.name, path: "/tmp/attachment/notes.txt", bytes: 5 } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送并启动 Agent" }));
  expect(props.onStart).toHaveBeenCalledWith(expect.stringContaining("notes.txt — /tmp/attachment/notes.txt"));
  fireEvent.click(screen.getByRole("button", { name: "移除附件 notes.txt" }));
  expect(screen.getByRole("button", { name: "发送并启动 Agent" })).toBeDisabled();
});

it("preserves the prompt and displays an upload refusal without retrying or starting", async () => {
  const props = form({ onAttachFile: vi.fn(async () => ({ ok: false as const, message: "设备拒绝上传" })) });
  const file = new File(["image"], "capture.png", { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("第一条需求"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
  expect(await screen.findByText("设备拒绝上传")).toBeInTheDocument();
  expect(screen.getByLabelText("第一条需求")).toHaveValue("开始干活");
  expect(props.onAttachFile).toHaveBeenCalledTimes(1);
  expect(props.onStart).not.toHaveBeenCalled();
});


it("discards an upload completion after switching away from and back to its device", async () => {
  let finish!: (value: { ok: true; attachment: { label: string; path: string; bytes: number } }) => void;
  const props = form({ onAttachFile: () => new Promise(r => { finish = r; }) });
  const file = new File(["late"], "late.txt");
  fireEvent.paste(screen.getByLabelText("第一条需求"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
  props.rerender({ device: "other" });
  props.rerender({ device: "laptop" });
  finish({ ok: true, attachment: { label: "late.txt", path: "/tmp/old/late.txt", bytes: 4 } });
  await waitFor(() => expect(screen.queryByText("正在上传 1 个文件…")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "移除附件 late.txt" })).not.toBeInTheDocument();
});
