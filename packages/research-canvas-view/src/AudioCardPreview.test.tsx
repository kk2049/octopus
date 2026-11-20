import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { AudioCardPreview } from "./AudioCardPreview.js";
import { AudioUploadController } from "./audio-upload.js";
import type { Call } from "./client.js";
const node = { id: "audio", type: "audio", title: "例会录音", data: {} } as ResearchNode;
beforeEach(() => { localStorage.clear(); vi.stubGlobal("crypto", { randomUUID: () => "request", subtle: { digest: async () => new Uint8Array(32).buffer } }); });
afterEach(() => vi.unstubAllGlobals());
it("makes upload visible on an empty card, stops card editing, and exposes manual transcription after upload", async () => {
  const invoke = vi.fn(async (action: string) => action === "file_begin" ? { upload: { id: "upload", received: 0 } } : action === "file_commit" ? { file: { id: "file-1", name: "example.wav", bytes: 4, mime: "audio/wav", version: 1, sha256: "sha" } } : {});
  const controller = new AudioUploadController(invoke as Call, "alice", node.id), open = vi.fn(), edit = vi.fn();
  render(<div onClick={edit}><AudioCardPreview node={node} controller={controller} editable open={open} /></div>);
  fireEvent.click(screen.getByRole("button", { name: "上传录音" })); expect(edit).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  const file = new File(["wav!"], "example.wav", { type: "audio/wav" }); Object.defineProperty(file, "slice", { value: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, 4) - start).buffer }) });
  fireEvent.change(screen.getByLabelText("选择会议录音"), { target: { files: [file] } });
  const transcribe = await screen.findByRole("button", { name: "语音转文字" });
  await waitFor(() => expect(screen.getByText("example.wav")).toBeInTheDocument());
  expect(invoke.mock.calls.map(([action]) => action)).toEqual(["file_begin", "file_chunk", "file_commit"]);
  fireEvent.click(transcribe); expect(open).toHaveBeenCalledWith("audio"); expect(edit).not.toHaveBeenCalled();
});
it("does not submit dropped files for a viewer", () => {
  const call = vi.fn() as Call;
  render(<AudioCardPreview node={node} controller={new AudioUploadController(call, "viewer", node.id)} editable={false} open={vi.fn()} />);
  expect(screen.getByRole("button", { name: "上传录音" })).toBeDisabled();
  fireEvent.drop(screen.getByLabelText("选择会议录音").parentElement!, { dataTransfer: { types: ["Files"], files: [new File(["a"], "a.wav")] } });
  expect(call).not.toHaveBeenCalled();
});
it("leads a small card with the whole paused status, ahead of its controls", async () => {
  let release!: (value: unknown) => void;
  const invoke = vi.fn((action: string) => action === "file_begin" ? new Promise(resolve => { release = resolve; }) : Promise.resolve({}));
  const controller = new AudioUploadController(invoke as unknown as Call, "alice", node.id);
  const { container } = render(<AudioCardPreview node={node} controller={controller} editable open={vi.fn()} />);
  const file = new File(["wav!"], "example.wav", { type: "audio/wav" }); Object.defineProperty(file, "slice", { value: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, 4) - start).buffer }) });
  fireEvent.change(screen.getByLabelText("选择会议录音"), { target: { files: [file] } });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("file_begin", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "暂停上传" }));
  release({ upload: { id: "upload", received: 0 } });
  // The full sentence, as the line itself rather than a clamped excerpt.
  const status = await screen.findByText("上传已暂停，继续时复用已传部分。");
  expect(status).toHaveAttribute("role", "status");
  expect(status).toHaveClass("rv-audio-status");
  // It is the card's first line, so a card clipped from the bottom keeps it, and it is said once.
  expect(container.querySelector(".rv-audio-card")!.firstElementChild).toBe(status);
  expect(screen.getAllByText("上传已暂停，继续时复用已传部分。")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "继续上传并确认" })).toBeInTheDocument();
  // The stage hint lines give way to the status on a card.
  expect(screen.queryByText("先添加会议录音")).not.toBeInTheDocument();
  expect(screen.queryByText("上传 → 转写 → 纪要 → 确认下发")).not.toBeInTheDocument();
});
