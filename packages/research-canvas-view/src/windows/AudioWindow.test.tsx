import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DiscussionSourceStatus, MeetingOptions, ResearchNode } from "@claude-bot/research-canvas-contract";
import { AudioWindow } from "./AudioWindow.js";
import { AudioUploadController } from "../audio-upload.js";
import type { Call } from "../client.js";
vi.mock("../CandidateReview.js", () => ({ CandidateReview: () => <div>任务建议待确认</div> }));
const stamp = { kind: "human" as const, owner: "tester", trigger: "fixture", agent: null, run: null, model: null, at: "2026-09-26T00:00:00Z" };
const node = { schema: 1, summary: "", phase: "present", x: 0, y: 0, version: 1, archived: false, created: stamp, updated: stamp, id: "audio", type: "audio", title: "例会", data: { meta: { meeting: { fileVersion: 1, fileName: "meeting.wav", bytes: 4, stage: "uploaded" } } } } as ResearchNode;
const file = { id: "file-1", name: "meeting.wav", mime: "audio/wav", bytes: 4, version: 1, sha256: "sha" };
const options: MeetingOptions = { transcription: { available: true, status: "ready", backend: "runner" }, mayBind: true, agents: [{ id: "agent", title: "会议助手" }], sources: [{ id: "codex-resource", title: "研究 Codex", accounts: [{ id: "account-d", label: "D 账号" }], models: ["gpt-6"], efforts: ["high"] }] };
const completed = { id: "source", node: "audio", kind: "audio", title: "例会", stage: "transcribed", sourceVersion: "file-1", progress: 100, message: "完整转写已保存", createdAt: "now", updatedAt: "now", transcript: { id: "transcript", ref: "file:transcript" }, integrity: { complete: true, rawClosed: true, durationSeconds: 1, lastEndSeconds: 1, trailingSeconds: 0, segments: 1, tokenLimited: false, recovered: false, warnings: [] } } satisfies DiscussionSourceStatus;
function setup(custom?: (action: string, params?: Record<string, unknown>) => unknown) {
  const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    const result = custom?.(action, params); if (result !== undefined) return result;
    if (action === "meeting_options") return options;
    if (action === "file_versions") return { files: [file], next: null };
    if (action === "source_read") return { source: null };
    throw new Error("Unexpected action " + action);
  });
  const call = invoke as Call;
  const props = { node, call, controller: new AudioUploadController(call, "alice", node.id), editable: true, runnable: true, storageKey: "alice", open: vi.fn(), openVersion: vi.fn() };
  return { invoke, props };
}
beforeEach(() => localStorage.clear());
it("opens only metadata and submits explicit none for manual transcription", async () => {
  const { invoke, props } = setup(action => action === "audio_transcribe" ? { run: { id: "run" } } : undefined);
  render(<AudioWindow {...props} />);
  const start = await screen.findByRole("button", { name: "开始语音转文字" }); await waitFor(() => expect(start).toBeEnabled());
  expect(invoke.mock.calls.some(([action]) => action === "resource_read")).toBe(false);
  fireEvent.click(start);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("audio_transcribe", expect.objectContaining({ node: "audio", version: 1, summary: { kind: "none" } })));
});
it("preserves the exact selected Codex request after an uncertain response and remount", async () => {
  let lost = true;
  const { invoke, props } = setup(action => {
    if (action !== "audio_transcribe") return;
    if (lost) { lost = false; return Promise.reject(new Error("response lost")); }
    return { run: { id: "same-run" } };
  });
  const view = render(<AudioWindow {...props} />); await waitFor(() => expect(screen.getByLabelText("纪要整理方式")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("纪要整理方式"), { target: { value: "codex:codex-resource" } });
  fireEvent.change(screen.getByLabelText("Codex 账号"), { target: { value: "account-d" } });
  fireEvent.click(screen.getByRole("button", { name: "开始转写并整理纪要" })); await screen.findByText("Error: response lost"); view.unmount();
  render(<AudioWindow {...props} />);
  expect(screen.getByLabelText("纪要整理方式")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试确认上次处理请求" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([action]) => action === "audio_transcribe")).toHaveLength(2));
  const calls = invoke.mock.calls.filter(([action]) => action === "audio_transcribe"); expect(calls[0][1]).toEqual(calls[1][1]);
  expect(calls[1][1]?.summary).toEqual({ kind: "codex", resource: "codex-resource", account: "account-d" });
  expect(invoke.mock.calls.some(([action]) => action === "candidates_publish")).toBe(false);
});
it("summarizes an existing complete transcript without running ASR again", async () => {
  const { invoke, props } = setup(action => action === "source_read" ? { source: completed } : action === "source_summarize" ? { source: completed } : undefined);
  render(<AudioWindow {...props} />); await screen.findByRole("button", { name: "打开完整转写" });
  expect(screen.queryByRole("button", { name: /开始语音转文字|开始转写并整理纪要|重新转写当前录音/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重新连接并核对原转写" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("纪要整理方式"), { target: { value: "agent:agent" } });
  fireEvent.click(screen.getByRole("button", { name: "从完整转写生成纪要与任务建议" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("source_summarize", expect.objectContaining({ version: "file-1", selection: { kind: "agent", agent: "agent" } })));
  expect(invoke.mock.calls.some(([action]) => action === "audio_transcribe" || action === "resource_read")).toBe(false);
});


it("keeps old-source minutes separate after the uploaded recording changes", async () => {
  const { props, invoke } = setup(action => action === "source_read" ? { source: { ...completed, minutes: { id: "old-minutes", ref: "note:old" } } } : action === "file_versions" ? { files: [{ ...file, id: "file-2", version: 2 }], next: null } : undefined);
  render(<AudioWindow {...props} node={{ ...node, data: { meta: { meeting: { fileVersion: 2, fileName: "new.wav", bytes: 4, stage: "uploaded" } } } }} />);
  await screen.findByRole("button", { name: "打开可编辑纪要" });
  expect(screen.getByRole("note")).toHaveTextContent("此前录音");
  fireEvent.change(screen.getByLabelText("纪要整理方式"), { target: { value: "agent:agent" } });
  expect(screen.queryByRole("button", { name: "重新整理纪要与任务建议" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([action]) => action === "source_summarize")).toBe(false);
});


it("refreshes unavailable meeting options after upload is confirmed in an already open detail", async () => {
  let uploaded = false;
  const { props, invoke } = setup(action => {
    if (action === "meeting_options") return { ...options, transcription: { ...options.transcription, available: uploaded, status: uploaded ? "ready" : "请先上传录音" } };
    if (action === "file_versions") return { files: [], next: null };
    if (action === "file_begin") return { upload: { id: "new-upload", received: 0 } };
    if (action === "file_chunk") return {};
    if (action === "file_commit") { uploaded = true; return { file }; }
  });
  vi.stubGlobal("crypto", { randomUUID: () => "upload-request", subtle: { digest: async () => new Uint8Array(32).buffer } });
  render(<AudioWindow {...props} node={{ ...node, data: {} }} />);
  await screen.findByText(/暂时不能开始语音转文字/);
  expect(screen.getByRole("button", { name: "开始语音转文字" })).toBeDisabled();
  const recording = new File(["wav!"], "meeting.wav", { type: "audio/wav" }); Object.defineProperty(recording, "slice", { value: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, 4) - start).buffer }) });
  fireEvent.change(screen.getByLabelText("选择会议录音"), { target: { files: [recording] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始语音转文字" })).toBeEnabled());
  expect(invoke.mock.calls.filter(([action]) => action === "meeting_options").length).toBeGreaterThan(1);
  expect(invoke.mock.calls.some(([action]) => action === "audio_transcribe")).toBe(false);
});


it("releases the request and restores choices only when the server confirms this run was not started", async () => {
  const { props, invoke } = setup(action => action === "audio_transcribe" ? { status: "not_started", message: "此来源已不可用，请选择其他 Agent" } : undefined);
  render(<AudioWindow {...props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "开始语音转文字" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始语音转文字" }));
  await screen.findByText("此来源已不可用，请选择其他 Agent");
  expect(screen.getByLabelText("纪要整理方式")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "重试确认上次处理请求" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("纪要整理方式"), { target: { value: "agent:agent" } });
  fireEvent.click(screen.getByRole("button", { name: "开始转写并整理纪要" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([action]) => action === "audio_transcribe")).toHaveLength(2));
  const calls = invoke.mock.calls.filter(([action]) => action === "audio_transcribe");
  expect(calls[0][1]?.request).not.toBe(calls[1][1]?.request);
  expect(calls[1][1]?.summary).toEqual({ kind: "agent", agent: "agent" });
});


it.each(["failed", "needs_review", "unknown"] as const)("reconnects the original %s transcription without offering a new ASR run", async stage => {
  const partial = { ...completed, stage, integrity: { ...completed.integrity, complete: false } };
  const { props, invoke } = setup(action => action === "source_read" || action === "source_retry" ? { source: partial } : undefined);
  render(<AudioWindow {...props} />);
  const reconnect = await screen.findByRole("button", { name: "重新连接并核对原转写" });
  expect(screen.queryByRole("button", { name: /开始语音转文字|开始转写并整理纪要|重新转写当前录音/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "从完整转写生成纪要与任务建议" })).not.toBeInTheDocument();
  expect(screen.getByText(/若原作业已经失败，请更换或重新上传录音/)).toBeInTheDocument();
  expect(screen.getByLabelText("纪要整理方式")).toBeDisabled();
  fireEvent.click(reconnect);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("source_retry", expect.objectContaining({ node: "audio", version: "file-1", request: expect.any(String) })));
  expect(invoke.mock.calls.some(([action]) => action === "audio_transcribe" || action === "source_summarize")).toBe(false);
});

it("preserves the original recovery request when reconnecting has an uncertain result", async () => {
  const partial = { ...completed, stage: "unknown" as const, integrity: { ...completed.integrity, complete: false } };
  const { props, invoke } = setup(action => action === "source_read" ? { source: partial } : action === "source_retry" ? Promise.reject(new Error("recovery reply lost")) : undefined);
  render(<AudioWindow {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "重新连接并核对原转写" }));
  await screen.findByText("Error: recovery reply lost");
  fireEvent.click(screen.getByRole("button", { name: "重新连接并核对原转写" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([action]) => action === "source_retry")).toHaveLength(2));
  const calls = invoke.mock.calls.filter(([action]) => action === "source_retry");
  expect(calls[1][1]).toEqual(calls[0][1]);
});

it("starts a new file version instead of offering recovery for a failed older recording", async () => {
  const previous = { ...completed, stage: "failed" as const, integrity: { ...completed.integrity, complete: false } };
  const { props } = setup(action => action === "source_read" ? { source: previous } : action === "file_versions" ? { files: [{ ...file, id: "file-2", version: 2 }], next: null } : undefined);
  render(<AudioWindow {...props} node={{ ...node, data: { meta: { meeting: { fileVersion: 2, fileName: "new.wav", bytes: 4, stage: "uploaded" } } } }} />);
  await screen.findByRole("button", { name: "打开部分转写（待审）" });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始语音转文字" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "重新连接并核对原转写" })).not.toBeInTheDocument();
});
