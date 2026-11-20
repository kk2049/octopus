import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { FileWindow } from "./FileWindow.js";
import type { Call } from "../client.js";
import { WHOLE_FILE_PREVIEW_BYTES } from "../file-upload.js";

const stamp = { kind: "human" as const, owner: "tester", trigger: "fixture", agent: null, run: null, model: null, at: "2026-10-20T00:00:00Z" };
const node = { schema: 1, summary: "", phase: "present", x: 0, y: 0, version: 1, archived: false, created: stamp, updated: stamp,
  id: "file", type: "file", title: "录像", data: {} } as ResearchNode;
beforeEach(() => localStorage.clear());
it("loads a file past the preview budget only when asked, and then to its end", async () => {
  const bytes = WHOLE_FILE_PREVIEW_BYTES + 10, window = 4 * 1024 * 1024;
  const info = { id: "v1", name: "talk.mp4", mime: "video/mp4", bytes, sha256: "a".repeat(64), version: 1 };
  const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    if (action !== "resource_read") throw new Error("unexpected " + action);
    const offset = Number(params?.cursor ?? 0), length = Math.min(window, bytes - offset);
    return { file: info, data: btoa("\0".repeat(length)), next: offset + length < bytes ? offset + length : null };
  });
  render(<FileWindow node={node} call={invoke as Call} editable={false} storageKey="alice" openVersion={vi.fn()} />);
  const load = await screen.findByRole("button", { name: "载入预览 / 下载" });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/超过自动预览的 64\.0 MiB/)).toBeInTheDocument();
  fireEvent.click(load);
  await waitFor(() => expect(screen.getByRole("link", { name: "下载" })).toBeInTheDocument(), { timeout: 30_000 });
  // The budget probe, then every window from the start.
  expect(invoke).toHaveBeenCalledTimes(1 + Math.ceil(bytes / window));
}, 60_000);
