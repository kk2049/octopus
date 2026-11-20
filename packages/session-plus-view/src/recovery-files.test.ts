import { describe, expect, it, vi } from "vitest";
import type { AnyWorkspaceFilesPort, WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import { resolveRecoveryFiles } from "./recovery-files.js";
import type { RecoveryDocument } from "./recovery.js";

const roots: WorkspaceFilesRoots = { roots: [{ ref: "wf_new_root", label: "project", sourceLabel: "laptop" }], truncated: false };
const file: RecoveryDocument = { panelId: "file-viewer", moduleId: "workspace.file-viewer/v1", kind: "workspace-text",
  label: "note.md", file: { root: "display:laptop:project", labels: ["docs", "note.md"] } };
function port(resolvePath = vi.fn().mockResolvedValue({ ok: true, value: { ref: "wf_current", kind: "file", label: "note.md" } })) {
  return { resolvePath } as unknown as AnyWorkspaceFilesPort;
}
describe("file recovery", () => {
  it("resolves a current root through the existing port and preserves listing context", async () => {
    const p = port();
    const result = await resolveRecoveryFiles([file], roots, p);
    expect(p.resolvePath).toHaveBeenCalledExactlyOnceWith("wf_new_root", ["docs", "note.md"]);
    expect(result).toMatchObject([{ ref: "wf_current", context: { workspace_root_ref: "wf_new_root", workspace_file_labels: "docs/note.md" } }]);
  });
  it("does not guess ambiguous, truncated or missing roots and does not retry refusals", async () => {
    const p = port(vi.fn().mockResolvedValue({ ok: false, code: "approval_required" }));
    const session = { panelId: "chat", moduleId: "agent.chat/v1", kind: "session", ref: "res-1", label: "session" };
    expect(await resolveRecoveryFiles([file, session], roots, p)).toEqual([session]);
    expect(p.resolvePath).toHaveBeenCalledTimes(1);
    await resolveRecoveryFiles([file], { ...roots, truncated: true }, p);
    await resolveRecoveryFiles([file], { ...roots, roots: [...roots.roots, { ...roots.roots[0]!, ref: "other" }] }, p);
    await resolveRecoveryFiles([file], null, p);
    expect(p.resolvePath).toHaveBeenCalledTimes(1);
  });
  it("drops a late result and stops subsequent capability reads after teardown", async () => {
    let settle!: (value: unknown) => void;
    let live = true;
    const p = port(vi.fn(() => new Promise((resolve) => { settle = resolve; })));
    const task = resolveRecoveryFiles([file, { ...file, panelId: "panel-1" }], roots, p, () => live);
    live = false;
    settle({ ok: true, value: { ref: "late", kind: "file", label: "late.md" } });
    expect(await task).toEqual([]);
    expect(p.resolvePath).toHaveBeenCalledTimes(1);
  });
});

it("exposes already resolved files while a later resource is still unanswered", async () => {
  let settle!: (value: unknown) => void;
  let live = true;
  const resolved = vi.fn();
  const p = port(vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { ref: "first", kind: "file", label: "note.md" } })
    .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; })));
  const task = resolveRecoveryFiles([file, { ...file, panelId: "panel-2" }], roots, p, () => live, resolved);
  await Promise.resolve();
  expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ ref: "first" }));
  live = false;
  settle({ ok: false, code: "unavailable" });
  expect(await task).toMatchObject([{ ref: "first" }]);
});
