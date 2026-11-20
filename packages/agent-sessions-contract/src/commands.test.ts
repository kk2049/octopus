import { expect, it, vi } from "vitest";
import { createSessionCommands } from "./commands.js";
import type { StartSessionRequest } from "./port.js";

it("preserves automatic routing and serializes an explicit registration without provider credentials", async () => {
  const propose = vi.fn(async (_action: string, _params: Record<string, string>) => ({ ok: true, message: "" }));
  const port = createSessionCommands(propose);
  const request: StartSessionRequest = { device: "execution", runtimeDevice: "runtime", directory: "~/project",
    source: "codex", model: "gpt-6-astra", effort: "xhigh", prompt: "task" };
  await port.start!(request);
  expect(propose.mock.calls[0]?.[1]).not.toHaveProperty("codex_account");
  await port.start!({ ...request, codexAccount: "account_b" });
  expect(propose.mock.calls[1]?.[1]).toMatchObject({ runtime_device: "runtime", codex_account: "account_b" });
  await port.start!({ ...request, codexAccount: "" });
  expect(propose.mock.calls[2]?.[1]).not.toHaveProperty("codex_account");
});


it("serializes a launch upload target without inventing a session resource or file path", async () => {
  const propose = vi.fn(async (_action: string, _params: Record<string, string>) => ({ ok: true, message: "" }));
  const port = createSessionCommands(propose);
  await port.attachFile!({ device: "executor", workspaceId: "registered-workspace", name: "notes.txt", mediaType: "text/plain",
    chunkIndex: 0, chunkCount: 1, data: "aGk=" });
  expect(propose).toHaveBeenCalledWith("attach_file", { device: "executor", workspace_id: "registered-workspace",
    name: "notes.txt", media_type: "text/plain", chunk_index: "0", chunk_count: "1", data: "aGk=" });
});

it("encodes App-owned organisation as opaque resources and a View-minted folder id only", async () => {
  const propose = vi.fn(async (_action: string, _params: Record<string, string>) => ({ ok: true, message: "" }));
  const port = createSessionCommands(propose);
  await port.setPinned!("r1", true);
  await port.setPinned!("r1", false);
  await port.saveFolder!("f_a", "实验");
  await port.fileSessions!(["r1", "r2"], "f_a");
  await port.fileSessions!(["r2"], "");
  await port.deleteFolder!("f_a");
  expect(propose.mock.calls).toEqual([
    ["pin_session", { session: "r1", pinned: "true" }],
    ["pin_session", { session: "r1", pinned: "false" }],
    ["save_session_folder", { folder: "f_a", name: "实验" }],
    ["file_sessions", { sessions: "r1,r2", folder: "f_a" }],
    ["file_sessions", { sessions: "r2", folder: "" }],
    ["delete_session_folder", { folder: "f_a" }],
  ]);
});
